import { toOverlay } from '../shared/ipc';
import type { AudioStatus } from '../shared/types';
import type { AudioListener } from './audio-listener';
import type { Game } from './game';
import type { I18n } from './i18n';
import type { OverlayManager } from './overlays';

interface Deps {
  game: Game;
  i18n: I18n;
  overlays: OverlayManager;
  audio: AudioListener;
  userActive(): boolean;
  /** Algo que no se debe interrumpir (un minijuego...). */
  busy(): boolean;
}

export type DanceResult = 'ok' | 'grumpy' | 'nomusic' | 'busy';

const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);

/**
 * Baile al ritmo: escucha el audio del PC y, si suena música y no está cabreada, de vez en cuando
 * se pone a bailar siguiendo los golpes. También baila si se lo pides (solo si está contenta).
 */
export class Dancer {
  private musicSince = 0;
  private nextAutoAt: number;
  private dancingUntil = 0;

  constructor(private d: Deps) {
    this.nextAutoAt = Date.now() + between(this.cfg.cadaMinutos) * 30_000;
  }

  private get cfg() {
    return this.d.game.config.music.baile;
  }

  get dancing(): boolean {
    return Date.now() < this.dancingUntil;
  }

  /** ¿Hay música con ritmo ahora mismo? */
  get hearingMusic(): boolean {
    return this.d.audio.status.music;
  }

  onStatus(s: AudioStatus): void {
    if (s.music) this.musicSince ||= Date.now();
    else this.musicSince = 0;
  }

  /** Golpe de ritmo: se lo pasa a la ventana que muestra a la mascota (si está bailando, salta con él). */
  onBeat(periodMs: number): void {
    this.d.overlays.sendToOwner(toOverlay.beat, { periodMs });
  }

  /** Se llama cada segundo. */
  tick(): void {
    const g = this.d.game;
    // Solo escucha cuando puede servir: activado, fuera de los modos seguros y contigo delante.
    this.d.audio.setActive(this.cfg.activado && !g.quiet && this.d.userActive());

    const now = Date.now();
    if (this.dancing || now < this.nextAutoAt || !this.musicSince) return;
    if (now - this.musicSince < this.cfg.musicaMinimaSegundos * 1000) return;
    if (g.grumpy || g.quiet || this.d.busy() || this.d.overlays.hiding) return;
    this.nextAutoAt = now + between(this.cfg.cadaMinutos) * 60_000;
    this.start(false);
  }

  /** Se lo pides tú (chat o menú). */
  request(): DanceResult {
    if (this.d.game.grumpy) return 'grumpy';
    if (!this.hearingMusic) return 'nomusic';
    if (this.d.busy() || this.d.overlays.hiding) return 'busy';
    this.start(true);
    return 'ok';
  }

  private start(asked: boolean): void {
    const ms = between(this.cfg.duracionSegundos) * 1000;
    this.dancingUntil = Date.now() + ms;
    this.d.game.adjust(this.cfg.efectos);
    const bubble = asked || Math.random() < 0.6 ? this.d.i18n.bubble(asked ? 'danceAsked' : 'danceStart') : undefined;
    this.d.game.say({ anim: 'dance', animMs: ms, bubble }, asked);
    console.log(`[baile] ${Math.round(ms / 1000)} s a ${this.d.audio.status.bpm} BPM${asked ? ' (pedido)' : ''}`);
  }
}
