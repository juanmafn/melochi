import { screen } from 'electron';
import { displayContaining, groundY } from '../shared/displays';
import { toOverlay } from '../shared/ipc';
import type { Choice, DisplayInfo, HideEdge, HintMessage, MinigameKind, Reaction } from '../shared/types';
import type { Game } from './game';
import type { I18n } from './i18n';
import type { OverlayManager } from './overlays';
import type { SpotifyApi, SpotifyTrack } from './spotify/api';
import type { SpotifyAuth } from './spotify/auth';
import type { MusicDirector } from './spotify/director';

interface Deps {
  game: Game;
  i18n: I18n;
  overlays: OverlayManager;
  director: MusicDirector;
  api: SpotifyApi;
  auth: SpotifyAuth;
}

type Move = 'rock' | 'paper' | 'scissors';
const MOVES: Move[] = ['rock', 'paper', 'scissors'];
/** Qué jugada le gana a cada una. */
const BEATS: Record<Move, Move> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const WINS_AGAINST: Record<Move, Move> = { rock: 'paper', paper: 'scissors', scissors: 'rock' };

const RPS_ANSWER_MS = 20_000;
const RPS_WINS = 2;
const RPS_MAX_ROUNDS = 5;
const CHEAT_CATCH_MS = 2200;
const HIDE_MS = 60_000;
const HINT_EVERY_MS = 1200;
const SONG_ROUNDS = 3;
const SONG_LISTEN_MS = 10_000;
const SONG_ANSWER_MS = 15_000;

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Escondite al azar en los bordes de un monitor: por un lado (media cara) o detrás de la barra de tareas. */
export function screenHideSpot(d: DisplayInfo): { x: number; y: number; edge: HideEdge } {
  const edge: HideEdge = pick(['left', 'right', 'bottom'] as HideEdge[]);
  const b = d.bounds;
  const g = groundY(d);
  if (edge === 'bottom') {
    // Asoma por detrás de la barra de tareas: los pies quedan por debajo del suelo.
    return { x: b.x + b.width * (0.1 + Math.random() * 0.8), y: g + 45, edge };
  }
  // Asoma la mitad de la cara (con un ojo) por el borde.
  const x = edge === 'left' ? b.x + 5 : b.x + b.width - 5;
  return { x, y: b.y + 140 + Math.random() * Math.max(0, g - b.y - 160), edge };
}

interface SavedPlayback {
  trackUri: string;
  contextUri: string | null;
  progressMs: number;
  isPlaying: boolean;
}

/**
 * Minijuegos en el escritorio: piedra-papel-tijera (con trampas si está mosqueada), adivina la canción
 * (con tu Spotify) y el escondite por todos tus monitores.
 */
export class Minigames {
  active: MinigameKind | null = null;
  private seq = 0;
  private promptId = '';
  private promptExpires = 0;
  private timers = new Set<NodeJS.Timeout>();

  private rps = { user: 0, pet: 0, round: 0, cheatUntil: 0, pending: null as NodeJS.Timeout | null };
  private hide = { until: 0, displayId: 0, x: 0, y: 0, lastHint: '', lastHintAt: 0 };
  private song = {
    pool: [] as SpotifyTrack[],
    used: new Set<string>(),
    round: 0,
    score: 0,
    target: null as SpotifyTrack | null,
    device: null as string | null,
    saved: null as SavedPlayback | null,
  };

  constructor(private d: Deps) {}

  // ---------- Utilidades ----------

  private b(key: string, vars?: Record<string, string | number>): string {
    return this.d.i18n.bubble(key, vars);
  }

  private ui(key: string): string {
    return this.d.i18n.t('ui', key);
  }

  private say(r: Reaction): void {
    this.d.game.say(r, true);
  }

  private later(ms: number, fn: () => void): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.active) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  /** Pregunta con botones en el bocadillo. */
  private ask(text: string, choices: Choice[], ms: number): void {
    this.promptId = `mg:${++this.seq}`;
    this.promptExpires = Date.now() + ms;
    this.say({ anim: 'talk', bubble: text, choices, promptId: this.promptId, durationMs: ms });
  }

  canStart(kind: MinigameKind): boolean {
    // Escondida (travesura) no juega: primero hay que encontrarla.
    if (this.active || this.d.game.quiet || this.d.overlays.hiding) return false;
    return kind !== 'song' || this.d.auth.connected;
  }

  start(kind: MinigameKind): void {
    if (!this.canStart(kind)) return;
    this.active = kind;
    if (kind === 'rps') this.startRps();
    else if (kind === 'hide') this.startHide();
    else void this.startSong();
  }

  private stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.active = null;
    this.promptId = '';
    this.d.director.suspended = false;
  }

  /** Te has ganado el premio. */
  private win(text: string): void {
    this.d.game.adjust(this.d.game.config.stats.minijuegos.ganar);
    this.d.game.rollDrop('minijuegoGanado');
    this.say({ anim: 'happy', sound: 'risa', bubble: text });
  }

  /** Gana ella: se regodea, pero se lo ha pasado bien. */
  private lose(text: string): void {
    this.d.game.adjust(this.d.game.config.stats.minijuegos.perder);
    this.d.game.rollDrop('minijuegoPerdido');
    this.say({ anim: 'mischief', sound: 'risa', bubble: text });
  }

  /** Respuesta a un bocadillo con botones. Devuelve true si era de un minijuego. */
  answer(promptId: string, choice: string): boolean {
    if (!promptId.startsWith('mg:')) return false;
    if (promptId !== this.promptId || !this.active) return true;
    this.promptId = '';
    if (this.active === 'rps' && MOVES.includes(choice as Move)) this.answerRps(choice as Move);
    else if (this.active === 'song') void this.answerSong(choice);
    return true;
  }

  /** Has hecho clic en la mascota. Devuelve true si lo usa un minijuego (pillarla haciendo trampas, encontrarla). */
  onPoke(): boolean {
    if (this.active === 'rps' && Date.now() < this.rps.cheatUntil) {
      this.caughtCheating();
      return true;
    }
    if (this.active === 'hide') {
      this.endHide(true);
      return true;
    }
    return false;
  }

  /** Se llama cada segundo (y más a menudo durante el escondite, para las pistas). */
  tick(): void {
    if (!this.active) return;
    if (this.promptId && Date.now() > this.promptExpires) {
      this.promptId = '';
      this.say({ anim: 'talk', bubble: this.b('mgAbandoned') });
      if (this.active === 'song') void this.restorePlayback();
      this.stop();
      return;
    }
    if (this.active === 'hide') this.tickHide();
  }

  // ---------- Piedra, papel o tijera ----------

  private startRps(): void {
    this.rps = { user: 0, pet: 0, round: 0, cheatUntil: 0, pending: null };
    this.say({ anim: 'happy', bubble: this.b('rpsStart') });
    this.later(1500, () => this.askRps());
  }

  private askRps(): void {
    this.rps.round++;
    const choices = MOVES.map((m) => ({ id: m, label: this.ui(`rps_${m}`) }));
    this.ask(this.b('rpsAsk', { round: this.rps.round, user: this.rps.user, pet: this.rps.pet }), choices, RPS_ANSWER_MS);
  }

  private answerRps(user: Move): void {
    const save = this.d.game.save;
    save.pet.rpsFav ??= pick(MOVES);
    // Tiene una jugada favorita que repite más.
    const honest: Move = Math.random() < 0.45 ? save.pet.rpsFav : pick(MOVES);
    const cfg = this.d.game.config.stats.minijuegos;
    const cheats = save.stats.mosqueo >= cfg.trampaDesdeMosqueo && Math.random() < cfg.trampaRps && BEATS[honest] !== user;

    this.say({ anim: 'talk', bubble: this.b('rpsReveal', { move: this.ui(`rps_${honest}`) }) });
    if (!cheats) {
      this.later(1300, () => this.resolveRound(user, honest));
      return;
    }
    // Trampa: cambia su jugada en el último momento. Si le haces clic a tiempo, la pillas.
    this.later(1300, () => {
      const winner = WINS_AGAINST[user];
      this.rps.cheatUntil = Date.now() + CHEAT_CATCH_MS;
      this.say({ anim: 'mischief', sound: 'risa', bubble: this.b('rpsCheat', { move: this.ui(`rps_${winner}`) }) });
      this.rps.pending = this.later(CHEAT_CATCH_MS + 100, () => {
        this.rps.cheatUntil = 0;
        this.resolveRound(user, winner);
      });
    });
  }

  private caughtCheating(): void {
    this.rps.cheatUntil = 0;
    if (this.rps.pending) {
      clearTimeout(this.rps.pending);
      this.timers.delete(this.rps.pending);
    }
    this.rps.user++;
    this.say({ anim: 'angry', sound: 'grunido', bubble: this.b('rpsCaught') });
    this.nextRpsStep();
  }

  private resolveRound(user: Move, pet: Move): void {
    if (BEATS[user] === pet) {
      this.rps.user++;
      this.say({ anim: 'angry', bubble: this.b('rpsWinRound') });
    } else if (BEATS[pet] === user) {
      this.rps.pet++;
      this.say({ anim: 'happy', sound: 'risa', bubble: this.b('rpsLoseRound') });
    } else {
      this.say({ anim: 'talk', bubble: this.b('rpsDraw') });
    }
    this.nextRpsStep();
  }

  private nextRpsStep(): void {
    const { user, pet, round } = this.rps;
    if (user >= RPS_WINS || pet >= RPS_WINS || round >= RPS_MAX_ROUNDS) {
      this.later(1800, () => {
        if (this.rps.user > this.rps.pet) this.win(this.b('mgWin'));
        else if (this.rps.pet > this.rps.user) this.lose(this.b('mgLose'));
        else {
          // Empate al final: tablas, sin premio pero se lo ha pasado bien.
          this.d.game.adjust({ diversion: 5 });
          this.say({ anim: 'happy', bubble: this.b('rpsTie') });
        }
        this.stop();
      });
    } else {
      this.later(1800, () => this.askRps());
    }
  }

  // ---------- Escondite ----------

  private startHide(): void {
    this.say({ anim: 'happy', bubble: this.b('hideStart') });
    this.later(2600, () => this.doHide());
  }

  private doHide(): void {
    const displays = this.d.overlays.availableDisplays();
    if (!displays.length) {
      this.stop();
      return;
    }
    const d = pick(displays);
    const { x, y, edge } = screenHideSpot(d);
    this.hide = { until: Date.now() + HIDE_MS, displayId: d.id, x, y, lastHint: '', lastHintAt: 0 };
    this.d.overlays.hidePet(d.id, x, y, edge);
  }

  /** Pistas "frío/caliente" junto al cursor, y fin del tiempo. */
  private tickHide(): void {
    const now = Date.now();
    if (!this.hide.until) return;
    if (now > this.hide.until) {
      this.endHide(false);
      return;
    }
    if (now - this.hide.lastHintAt < HINT_EVERY_MS) return;
    const c = screen.getCursorScreenPoint();
    const under = displayContaining(c.x, c.y, this.d.overlays.displays);
    if (!under) return;
    let key: string;
    if (under.id !== this.hide.displayId) key = 'hint_otherScreen';
    else {
      const dist = Math.hypot(c.x - this.hide.x, c.y - (this.hide.y - 50));
      key = dist > 650 ? 'hint_cold' : dist > 350 ? 'hint_warm' : dist > 150 ? 'hint_hot' : 'hint_burning';
    }
    this.hide.lastHintAt = now;
    this.hide.lastHint = key;
    const msg: HintMessage = { x: c.x - under.bounds.x, y: c.y - under.bounds.y, text: this.ui(key) };
    this.d.overlays.send(under.id, toOverlay.hint, msg);
  }

  private endHide(found: boolean): void {
    const { displayId, x } = this.hide;
    const d = this.d.overlays.display(displayId);
    this.hide.until = 0;
    if (d) this.d.overlays.placeOnGround(displayId, Math.min(Math.max(x, d.bounds.x + 60), d.bounds.x + d.bounds.width - 60));
    // Un momento para que aparezca antes de hablar.
    setTimeout(() => {
      if (found) this.win(this.b('hideFound'));
      else {
        this.d.game.adjust({ diversion: 6 });
        this.say({ anim: 'mischief', sound: 'risa', bubble: this.b('hideTimeout') });
      }
    }, 400);
    this.stop();
  }

  // ---------- Adivina la canción ----------

  /** Canciones para el juego: de tus playlists propias y de sus artistas favoritos. */
  private async buildPool(): Promise<SpotifyTrack[]> {
    const { api } = this.d;
    const tracks: SpotifyTrack[] = [];
    try {
      const me = await api.me();
      const own = shuffle((await api.playlists()).filter((p) => p.ownerId === me.id));
      for (const p of own) {
        if (tracks.length >= 60) break;
        tracks.push(...(await api.playlistTracks(p.id, 100).catch(() => [])));
      }
    } catch (err) {
      console.warn('[minijuegos] No se pueden leer tus playlists:', String(err));
    }
    for (const artist of this.d.game.config.music.artistasFavoritos) {
      tracks.push(...(await api.searchTracks(`artist:"${artist}"`).catch(() => [])));
    }
    const seen = new Set<string>();
    return tracks.filter((t) => t.durationMs > 60_000 && !seen.has(t.uri) && seen.add(t.uri));
  }

  private async startSong(): Promise<void> {
    const { director } = this.d;
    this.say({ anim: 'talk', bubble: this.b('songPreparing') });
    const device = await director.device();
    if (!device) {
      this.say({ anim: 'talk', bubble: this.b('musicNoDevice') });
      this.stop();
      return;
    }
    const pool = await this.buildPool();
    if (pool.length < 4) {
      this.say({ anim: 'talk', bubble: this.b('songNoPool') });
      this.stop();
      return;
    }
    await director.refreshNow();
    const st = director.state;
    director.suspended = true;
    this.song = {
      pool,
      used: new Set(),
      round: 0,
      score: 0,
      target: null,
      device,
      saved: st?.track ? { trackUri: st.track.uri, contextUri: st.contextUri, progressMs: st.progressMs, isPlaying: st.isPlaying } : null,
    };
    this.say({ anim: 'happy', bubble: this.b('songStart') });
    this.later(2500, () => void this.songRound());
  }

  private async songRound(): Promise<void> {
    const s = this.song;
    s.round++;
    const candidates = s.pool.filter((t) => !s.used.has(t.uri));
    const target = pick(candidates);
    s.used.add(target.uri);
    s.target = target;
    const start = 30_000 + Math.random() * Math.max(0, Math.min(30_000, target.durationMs - 60_000));
    try {
      await this.d.api.play({ uris: [target.uri], deviceId: s.device, positionMs: start });
    } catch (err) {
      console.error('[minijuegos] No se puede reproducir:', String(err));
      this.say({ anim: 'talk', bubble: this.b('musicError') });
      void this.restorePlayback();
      this.stop();
      return;
    }
    this.say({ anim: 'dance', animMs: SONG_LISTEN_MS, bubble: this.b('songListen', { round: s.round }) });
    this.later(SONG_LISTEN_MS, () => void this.songQuestion());
  }

  private async songQuestion(): Promise<void> {
    const s = this.song;
    await this.d.api.pause().catch(() => {});
    const target = s.target!;
    // 3 opciones falsas con títulos distintos.
    const decoys = shuffle(s.pool.filter((t) => t.uri !== target.uri && t.name !== target.name)).slice(0, 3);
    const options = shuffle([target, ...decoys]).map((t) => ({ id: t.uri, label: `${t.name} — ${t.artists[0] ?? ''}` }));
    this.ask(this.b('songAsk'), options, SONG_ANSWER_MS);
  }

  private async answerSong(choice: string): Promise<void> {
    const s = this.song;
    const target = s.target!;
    const right = choice === target.uri;
    if (right) s.score++;
    const name = `${target.name} — ${target.artists[0] ?? ''}`;
    this.say({ anim: right ? 'happy' : 'angry', bubble: this.b(right ? 'songRight' : 'songWrong', { track: name }) });
    if (s.round < SONG_ROUNDS) {
      this.later(2800, () => void this.songRound());
      return;
    }
    this.later(2800, () => void this.endSong());
  }

  private async endSong(): Promise<void> {
    const { score } = this.song;
    await this.restorePlayback();
    this.d.game.adjust({ diversion: 5 * score });
    if (score === SONG_ROUNDS) this.win(this.b('songPerfect'));
    else if (score > 0) this.say({ anim: 'happy', bubble: this.b('songEnd', { score, total: SONG_ROUNDS }) });
    else this.lose(this.b('songZero'));
    this.stop();
  }

  /** Vuelve a poner lo que estabas escuchando antes del juego (y en pausa si estaba en pausa). */
  private async restorePlayback(): Promise<void> {
    const { saved, device } = this.song;
    const { api } = this.d;
    try {
      if (!saved) {
        await api.pause();
        return;
      }
      if (saved.contextUri) await api.play({ contextUri: saved.contextUri, offsetUri: saved.trackUri, positionMs: saved.progressMs, deviceId: device });
      else await api.play({ uris: [saved.trackUri], positionMs: saved.progressMs, deviceId: device });
      if (!saved.isPlaying) setTimeout(() => void api.pause().catch(() => {}), 1200);
    } catch (err) {
      console.warn('[minijuegos] No se pudo restaurar lo que sonaba:', String(err));
    } finally {
      this.d.director.suspended = false;
      setTimeout(() => void this.d.director.poll(true), 2000);
    }
  }
}
