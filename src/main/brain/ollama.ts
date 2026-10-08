import type { BrainStatus } from '../../shared/types';
import type { OllamaSettings } from '../save';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Esquema JSON que debe cumplir la respuesta (structured outputs). */
  format?: object;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

const REQUEST_TIMEOUT_MS = 120_000;
/** Cuánto tiempo deja Ollama el modelo cargado en memoria tras usarlo. */
const KEEP_ALIVE = '30m';

/** Cliente mínimo de la API HTTP de Ollama. */
export class OllamaClient {
  /** Algunos modelos no aceptan el parámetro "think"; se recuerda para no volver a enviarlo. */
  private noThinkParam = new Set<string>();

  constructor(private settings: () => OllamaSettings) {}

  private url(path: string): string {
    return this.settings().host.replace(/\/+$/, '') + path;
  }

  async models(): Promise<string[]> {
    const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { models?: { name: string }[] };
    // Ollama a veces lista entradas internas ("llamacpp:<hash>") o duplicadas: se filtran.
    return [...new Set((json.models ?? []).map((m) => m.name).filter((n) => !n.startsWith('llamacpp:')))].sort();
  }

  async status(): Promise<BrainStatus> {
    const s = this.settings();
    if (!s.enabled) return 'disabled';
    try {
      const models = await this.models();
      const wanted = s.model.includes(':') ? s.model : `${s.model}:latest`;
      return models.includes(wanted) ? 'online' : 'nomodel';
    } catch {
      return 'offline';
    }
  }

  /** Una respuesta completa (sin streaming). Devuelve el texto del asistente. */
  async chat(messages: OllamaMessage[], opts: ChatOptions = {}): Promise<string> {
    const s = this.settings();
    const body: Record<string, unknown> = {
      model: s.model,
      messages,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: {
        temperature: opts.temperature ?? 0.8,
        num_predict: opts.maxTokens ?? 200,
        num_ctx: 4096,
        // Sin GPU: todo en la CPU (para no ocupar la gráfica en el PC de desarrollo).
        ...(s.useGpu ? {} : { num_gpu: 0 }),
      },
    };
    if (opts.format) body.format = opts.format;
    // Los modelos "que piensan" (qwen3...) responden más rápido sin la fase de razonamiento.
    if (!this.noThinkParam.has(s.model)) body.think = false;

    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as { message?: { content?: string }; error?: string };
    if (!res.ok || json.error) {
      if (body.think !== undefined && /think/i.test(json.error ?? '')) {
        this.noThinkParam.add(s.model);
        return this.chat(messages, opts);
      }
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return json.message?.content ?? '';
  }
}
