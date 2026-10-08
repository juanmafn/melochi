import { toOverlay } from '../shared/ipc';
import type { CloseUpMessage } from '../shared/types';
import type { Game } from './game';
import type { I18n } from './i18n';
import type { OverlayManager } from './overlays';

interface Deps {
  game: Game;
  i18n: I18n;
  overlays: OverlayManager;
  /** Segundos desde la última vez que usaste el ratón o el teclado. */
  idleSeconds(): number;
  /** Algo que no se debe interrumpir (minijuego, baile, trepando...). */
  busy(): boolean;
}

/** Por qué se acerca: no tocas el ratón ("¿estás ahí?"), no le haces caso, o está cabreada (travesura). */
export type KnockReason = 'idle' | 'ignored' | 'angry';

const MINUTE = 60_000;
/** Lo que tarda en acercarse antes de tocar el cristal (como CLOSEUP_GROW_MS en el renderer). */
const GROW_MS = 1600;
/** Tras volver a su sitio, un momento antes de comentar. */
const AFTER_MS = 1500;

/**
 * Se acerca a la pantalla, se hace grande y toca el cristal: "¿estás ahí?". Si le haces clic (o, si no
 * tocabas el ratón, si lo mueves), se alegra; si no, vuelve a su sitio.
 */
export class Knock {
  private current: { reason: KnockReason; startedAt: number; endAt: number; ended: boolean } | null = null;
  private lastAt = 0;
  /** Ya ha mirado si estabas en este rato sin tocar el ratón (una vez por rato). */
  private idleChecked = false;

  constructor(private d: Deps) {}

  private get cfg() {
    return this.d.game.config.stats.tocarPantalla;
  }

  /** Está acercándose, tocando el cristal o volviendo. */
  get active(): boolean {
    return !!this.current;
  }

  /** Se llama varias veces por segundo. */
  tick(): void {
    const now = Date.now();
    const idle = this.d.idleSeconds();
    if (idle < 5) this.idleChecked = false;

    const c = this.current;
    if (c) {
      if (c.ended) return;
      // Si no tocabas el ratón y ahora sí: estabas ahí.
      const tapping = now - c.startedAt > GROW_MS;
      if (c.reason === 'idle' && tapping && idle * 1000 < now - c.startedAt - 300) this.finish(true);
      else if (now > c.endAt) this.finish(false);
      return;
    }

    const g = this.d.game;
    if (now - this.lastAt < this.cfg.cadaMinutos * MINUTE || g.grumpy || g.quiet || this.d.busy()) return;
    const [from, to] = this.cfg.inactivoMinutos;
    if (!this.idleChecked && idle >= from * 60 && idle <= to * 60) {
      this.idleChecked = true;
      this.start('idle');
    } else if (idle < 20 && g.save.stats.carino < this.cfg.carinoBajo && now - g.lastAttentionAt >= this.cfg.ignoradaMinutos * MINUTE) {
      this.start('ignored');
    }
  }

  /** Empieza (también la usa la travesura de golpear el cristal). Devuelve false si ahora no puede. */
  start(reason: KnockReason): boolean {
    const o = this.d.overlays;
    if (this.current || o.ownerId === null || o.hiding || this.d.game.quiet) return false;
    const waitMs = this.cfg.esperaSegundos * 1000;
    const now = Date.now();
    this.current = { reason, startedAt: now, endAt: now + GROW_MS + waitMs, ended: false };
    this.lastAt = now;
    const msg: CloseUpMessage = { kind: reason === 'angry' ? 'angry' : 'knock', waitMs };
    o.sendToOwner(toOverlay.closeup, msg);
    // Cuando ya está pegada al cristal, pregunta.
    const started = this.current;
    setTimeout(() => {
      if (this.current !== started || started.ended) return;
      this.d.game.say({ bubble: this.d.i18n.bubble(`knock_${reason}`), durationMs: waitMs }, true);
    }, GROW_MS);
    console.log(`[cristal] ${reason}`);
    return true;
  }

  /** Has hecho clic en ella (o la has acariciado). Devuelve true si estaba esperando tu respuesta. */
  onTouch(): boolean {
    const c = this.current;
    if (!c || c.ended) return false;
    this.finish(true);
    return true;
  }

  /** La ventana no ha podido hacerlo (la estaban arrastrando, estaba jugando...). */
  abort(): void {
    this.current = null;
  }

  private finish(answered: boolean): void {
    const c = this.current!;
    c.ended = true;
    this.d.overlays.sendToOwner(toOverlay.closeupEnd);
    const fx = this.cfg;
    const g = this.d.game;
    if (answered) {
      g.noteAttention();
      if (c.reason === 'angry') g.adjust({ mosqueo: -3 });
      else g.adjust(fx.responder);
    } else if (c.reason === 'ignored') {
      g.adjust(fx.ignorar);
    }
    // Comentario al volver: contenta si le has hecho caso; triste si te estaba llamando y no; nada si no había nadie.
    const key = answered ? `knockAnswered_${c.reason}` : c.reason === 'ignored' ? 'knockIgnored' : null;
    setTimeout(() => {
      this.current = null;
      if (key) g.say({ anim: answered ? (c.reason === 'angry' ? 'angry' : 'happy') : 'talk', bubble: this.d.i18n.bubble(key) }, true);
    }, 1200 + AFTER_MS);
  }
}
