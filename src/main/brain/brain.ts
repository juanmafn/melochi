import type { BrainConfig, BrainStatus, ChatActionType, ChatMessage, GameView, Lang, MoodDef, Reaction } from '../../shared/types';
import { extractMusicQuery, userAsked } from './intent';
import type { Memory } from './memory';
import type { OllamaClient, OllamaMessage } from './ollama';
import {
  ACTIONS,
  BUBBLE_SCHEMA,
  CHAT_SCHEMA,
  EMOTIONS,
  MEMORY_SCHEMA,
  bubbleTurn,
  memoryPrompt,
  systemPrompt,
  userTurn,
  type Emotion,
  type PromptContext,
} from './prompt';

export interface BrainHooks {
  lang(): Lang;
  petName(): string;
  personality(): string;
  view(): GameView;
  mood(): MoodDef;
  musicMoods(): { id: string; name: string }[];
  spotifyConnected(): boolean;
  config(): BrainConfig;
  dndActive(): boolean;
  /** ¿Estás delante del ordenador? Si no, no gasta la IA en comentarios que nadie va a leer. */
  userActive(): boolean;
  /** Ejecuta una acción pedida en el chat. Devuelve un aviso si no se ha podido hacer. */
  act(action: ChatActionType, value: string): Promise<string | null>;
  react(r: Reaction): void;
  /** Aplica efectos a las stats (hablar con ella le sube el cariño). */
  adjust(delta: BrainConfig['efectosPorMensaje']): void;
  /** Ha cambiado el chat (mensajes, estado): hay que refrescar la ventana. */
  changed(): void;
  /** Textos de la sección "chat" de los idiomas. */
  text(key: string): string;
}

const MAX_USER_TEXT = 500;
const MAX_REPLY = 400;
const BUBBLE_TIMEOUT_MS = 60_000;
const CHAT_DIMINISH_WINDOW_MS = 10 * 60_000;

const EMOTION_ANIM: Record<Emotion, string> = {
  neutral: 'talk',
  happy: 'happy',
  love: 'petted',
  angry: 'angry',
  sad: 'talk',
  surprised: 'talk',
};

/** Extrae el JSON de la respuesta del modelo (a veces viene con texto alrededor). */
function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

const cleanReply = (s: unknown) =>
  String(s ?? '')
    .trim()
    .replace(/^["«]|["»]$/g, '')
    .slice(0, MAX_REPLY);

/** El "cerebro" de la mascota: chat con IA local, comentarios espontáneos y memoria a largo plazo. */
export class Brain {
  status: BrainStatus = 'offline';
  /** Hay una respuesta del chat en camino (la ventana muestra "escribiendo…"). */
  busy = false;
  /** Se está generando un bocadillo espontáneo. */
  private generating = false;
  private summarizing = false;
  private lastUserAt = 0;
  private recentUserTimes: number[] = [];

  constructor(
    private ollama: OllamaClient,
    readonly memory: Memory,
    private hooks: BrainHooks,
  ) {}

  get messages(): ChatMessage[] {
    return this.memory.data.recent;
  }

  async refreshStatus(): Promise<BrainStatus> {
    const prev = this.status;
    this.status = await this.ollama.status();
    if (prev !== this.status) this.hooks.changed();
    return this.status;
  }

  private ctx(): PromptContext {
    return {
      lang: this.hooks.lang(),
      petName: this.hooks.petName(),
      personality: this.hooks.personality(),
      facts: this.memory.data.facts,
      view: this.hooks.view(),
      mood: this.hooks.mood(),
      musicMoods: this.hooks.musicMoods(),
      spotifyConnected: this.hooks.spotifyConnected(),
    };
  }

  private push(role: ChatMessage['role'], text: string): void {
    this.memory.add({ role, text, at: Date.now() });
    this.hooks.changed();
  }

  /**
   * Carga el modelo y procesa la parte fija del prompt (Ollama la deja en caché), para que la primera
   * respuesta del chat no tenga que esperar a eso. Se llama al abrir el chat.
   */
  async warmUp(): Promise<void> {
    if (this.status !== 'online' || this.busy || this.generating || this.summarizing) return;
    this.generating = true;
    try {
      await this.ollama.chat(
        [
          { role: 'system', content: systemPrompt(this.ctx()) },
          { role: 'user', content: '…' },
        ],
        { maxTokens: 1 },
      );
    } catch (err) {
      console.warn('[cerebro] Calentamiento fallido:', String(err));
    } finally {
      this.generating = false;
    }
  }

  // ---------- Chat ----------

  async send(raw: string): Promise<void> {
    const text = raw.trim().slice(0, MAX_USER_TEXT);
    // La ventana no deja enviar mientras responde; esto es por si acaso.
    if (!text || this.busy) return;
    const now = Date.now();
    this.lastUserAt = now;
    this.push('user', text);

    // Hablar con ella le sube el cariño, cada vez menos si no paras.
    this.recentUserTimes = this.recentUserTimes.filter((t) => now - t < CHAT_DIMINISH_WINDOW_MS);
    this.recentUserTimes.push(now);
    const factor = 1 / (1 + (this.recentUserTimes.length - 1) / 5);
    const fx = this.hooks.config().efectosPorMensaje;
    this.hooks.adjust(Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, (v ?? 0) * factor])));

    if (this.status !== 'online') {
      const key = this.status === 'disabled' ? 'offlineDisabled' : this.status === 'nomodel' ? 'offlineNoModel' : 'offline';
      this.push('pet', this.hooks.text(key));
      this.hooks.react({ anim: 'talk' });
      return;
    }

    this.busy = true;
    this.hooks.changed();
    try {
      // Si estaba escribiendo un bocadillo, espera a que termine (Ollama atiende de uno en uno).
      for (let i = 0; this.generating && i < 300; i++) await new Promise((r) => setTimeout(r, 200));
      const cfg = this.hooks.config();
      const ctx = this.ctx();
      // Historial: los mensajes anteriores al actual, sin los avisos del sistema.
      const history = this.messages
        .slice(0, -1)
        .filter((m) => m.role !== 'system')
        .slice(-cfg.historialMensajes)
        .map<OllamaMessage>((m) =>
          m.role === 'user'
            ? { role: 'user', content: m.text }
            : { role: 'assistant', content: JSON.stringify({ reply: m.text, action: 'none', emotion: 'neutral' }) },
        );
      const raw = await this.ollama.chat(
        [{ role: 'system', content: systemPrompt(ctx) }, ...history, { role: 'user', content: userTurn(ctx, text) }],
        { format: CHAT_SCHEMA, maxTokens: cfg.maxTokensChat, temperature: cfg.temperatura },
      );
      const json = parseJson(raw);
      const reply = cleanReply(json?.reply ?? raw);
      const action = ACTIONS.includes(json?.action as ChatActionType) ? (json!.action as ChatActionType) : 'none';
      const emotion = EMOTIONS.includes(json?.emotion as Emotion) ? (json!.emotion as Emotion) : 'neutral';

      this.push('pet', reply || '…');
      this.hooks.react({ anim: EMOTION_ANIM[emotion], sound: emotion === 'angry' ? 'grunido' : 'saludo' });
      if (action !== 'none' && userAsked(action, text)) {
        let value = String(json?.value ?? '').trim();
        // A veces elige la acción pero no dice qué buscar: se saca de tu mensaje.
        if (!value && (action === 'play_search' || action === 'play_mood')) value = extractMusicQuery(text);
        console.log(`[cerebro] Acción: ${action} "${value}"`);
        const note = await this.hooks.act(action, value);
        if (note) this.push('system', note);
      } else if (action !== 'none') {
        console.log(`[cerebro] Acción ignorada (no se ha pedido): ${action} "${json?.value ?? ''}"`);
      }
    } catch (err) {
      console.error('[cerebro] Chat fallido:', err);
      this.push('system', this.hooks.text('error'));
      void this.refreshStatus();
    } finally {
      this.busy = false;
      this.hooks.changed();
    }

    if (this.memory.pending().filter((m) => m.role === 'user').length >= this.hooks.config().resumirCadaMensajes) {
      void this.summarize();
    }
  }

  // ---------- Bocadillos espontáneos ----------

  /**
   * Intenta que la IA escriba un comentario espontáneo. Devuelve true si se encarga (la reacción llega
   * cuando el modelo responda, o la frase fija si falla); false si hay que usar la frase fija ya.
   */
  chatter(topic: string, fallback: Reaction): boolean {
    if (this.status !== 'online' || this.busy || this.generating || this.summarizing || !this.hooks.userActive()) return false;
    if (Math.random() >= this.hooks.config().probabilidadBocadilloIA) return false;
    void this.generateBubble(topic).then((r) => this.hooks.react(r ?? fallback));
    return true;
  }

  /** Comentario sobre una canción que empieza a sonar (a veces). */
  commentSong(): void {
    if (this.status !== 'online' || this.busy || this.generating || this.summarizing || this.hooks.dndActive() || !this.hooks.userActive()) return;
    if (Math.random() >= this.hooks.config().probabilidadComentarCancion) return;
    void this.generateBubble('song').then((r) => r && this.hooks.react(r));
  }

  private async generateBubble(topic: string): Promise<Reaction | null> {
    this.generating = true;
    try {
      const ctx = this.ctx();
      const raw = await this.ollama.chat(
        [
          { role: 'system', content: systemPrompt(ctx) },
          { role: 'user', content: bubbleTurn(ctx, topic) },
        ],
        { format: BUBBLE_SCHEMA, maxTokens: 60, temperature: 0.9, timeoutMs: BUBBLE_TIMEOUT_MS },
      );
      const json = parseJson(raw);
      const reply = cleanReply(json?.reply);
      if (!reply) return null;
      const emotion = EMOTIONS.includes(json?.emotion as Emotion) ? (json!.emotion as Emotion) : 'neutral';
      return { anim: EMOTION_ANIM[emotion], bubble: reply };
    } catch (err) {
      console.warn('[cerebro] Bocadillo fallido:', String(err));
      return null;
    } finally {
      this.generating = false;
    }
  }

  // ---------- Memoria ----------

  /** Se llama cada segundo: resume la conversación tras un rato sin hablar. */
  tick(): void {
    const mins = this.hooks.config().resumirTrasInactividadMinutos;
    if (this.memory.pending().some((m) => m.role === 'user') && Date.now() - this.lastUserAt > mins * 60_000) void this.summarize();
  }

  /** Actualiza los recuerdos a largo plazo con lo hablado desde la última vez. */
  async summarize(): Promise<void> {
    // Solo tus mensajes: los datos sobre ti salen de ahí, y así no se cuelan las fantasías de la mascota.
    const convo = this.memory.pending().filter((m) => m.role === 'user');
    if (this.status !== 'online' || this.summarizing || this.busy || this.generating || !convo.length) return;
    this.summarizing = true;
    try {
      const cfg = this.hooks.config();
      const p = memoryPrompt(this.hooks.lang(), this.hooks.petName(), cfg.maxRecuerdos, this.memory.data.facts, convo);
      const raw = await this.ollama.chat(
        [
          { role: 'system', content: p.system },
          { role: 'user', content: p.user },
        ],
        { format: MEMORY_SCHEMA, maxTokens: 500, temperature: 0.1 },
      );
      const facts = parseJson(raw)?.facts;
      if (!Array.isArray(facts)) throw new Error(`Respuesta sin "facts": ${raw.slice(0, 200)}`);
      const clean = facts
        .map((f) => String(f).trim())
        .filter(Boolean)
        .slice(0, cfg.maxRecuerdos);
      this.memory.setFacts(clean);
      console.log(`[cerebro] Recuerdos actualizados (${clean.length}).`);
    } catch (err) {
      console.warn('[cerebro] No se pudo resumir:', String(err));
    } finally {
      this.summarizing = false;
    }
  }
}
