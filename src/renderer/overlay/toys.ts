import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { clamp, groundY } from '../../shared/displays';
import type { DisplayInfo, ToyKind } from '../../shared/types';
import type { OverlayApi } from '../../preload/overlay';
import type { Pet } from './pet';
import { skinUrl } from './skin';

const BALL_R = 14;
const GRAVITY = 2200;
const BOUNCE = 0.55;
const WAIT_MS = 30_000;
const LASER_MS = 30_000;
const PICKUP_DIST = 22;
const MAX_THROW = 2600;

type BallState = 'waiting' | 'held' | 'flying' | 'carried' | 'done';

/**
 * Juguetes físicos en la ventana de la mascota:
 * - Pelota: la coges y la lanzas; ella corre, la recoge y te la trae al sitio desde donde la tiraste.
 * - Láser: un punto rojo sigue tu cursor durante 30 s y ella lo persigue.
 * La recompensa (diversión y objetos) se pide a main al terminar.
 */
export class Toys {
  kind: ToyKind | null = null;
  private layer = new Container();
  private ball = new Sprite();
  private ballFallback = new Graphics().circle(0, 0, BALL_R).fill(0xc5e063).stroke({ width: 2, color: 0x6b8a1a });
  private dot = new Graphics().circle(0, 0, 9).fill({ color: 0xff2222, alpha: 0.25 }).circle(0, 0, 4.5).fill(0xff2222);
  private state: BallState = 'done';
  private bx = 0;
  private by = 0;
  private bvx = 0;
  private bvy = 0;
  private origin = 0;
  private samples: { x: number; y: number; t: number }[] = [];
  private deadline = 0;
  private cursor: { x: number; y: number } | null = null;
  private endTimer: number | null = null;

  constructor(
    stage: Container,
    private pet: Pet,
    private api: OverlayApi,
    private display: DisplayInfo,
    private say: (text: string) => void,
  ) {
    this.ball.anchor.set(0.5);
    this.layer.addChild(this.ballFallback, this.ball, this.dot);
    this.layer.visible = false;
    stage.addChild(this.layer);
  }

  get active(): boolean {
    return this.kind !== null;
  }

  private get ground(): number {
    return groundY(this.display) - this.display.bounds.y;
  }

  /** Carga el icono de la pelota de la skin (si no hay, se queda el círculo dibujado). */
  async setSkinVersion(version: number): Promise<void> {
    try {
      const res = await fetch(skinUrl('items/pelota.png', version));
      if (!res.ok) throw new Error();
      this.ball.texture = Texture.from(await createImageBitmap(await res.blob()));
      this.ball.width = this.ball.height = BALL_R * 2.2;
      this.ballFallback.visible = false;
    } catch {
      this.ball.texture = Texture.EMPTY;
      this.ballFallback.visible = true;
    }
  }

  start(kind: ToyKind, ui: Record<string, string>): void {
    this.cancel();
    if (!this.pet.owned) return;
    this.kind = kind;
    this.pet.playing = true;
    this.layer.visible = true;
    if (kind === 'pelota') {
      this.state = 'waiting';
      this.bx = clamp(this.pet.x + this.pet.facingDir * 55, 30, this.display.bounds.width - 30);
      this.by = this.ground - BALL_R;
      this.bvx = this.bvy = 0;
      this.deadline = performance.now() + WAIT_MS;
      this.dot.visible = false;
      this.setBallVisible(true);
      this.say(ui.toyThrowMe);
    } else {
      this.deadline = performance.now() + LASER_MS;
      this.setBallVisible(false);
      this.dot.visible = !!this.cursor;
      this.say(ui.toyLaser);
    }
  }

  private setBallVisible(v: boolean): void {
    this.ball.visible = v && this.ball.texture !== Texture.EMPTY;
    this.ballFallback.visible = v && !this.ball.visible;
  }

  /** Termina el juego. `reward`: pedir la recompensa a main. */
  private finish(reward: boolean): void {
    const kind = this.kind;
    this.kind = null;
    this.state = 'done';
    this.pet.playing = false;
    this.dot.visible = false;
    if (reward && kind) this.api.toyDone(kind);
    // La pelota se queda un momento en el suelo y luego desaparece.
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => (this.layer.visible = false), reward ? 1500 : 0);
  }

  cancel(): void {
    if (this.kind) this.finish(false);
  }

  // ---------- Ratón ----------

  /** ¿El punto (local) está sobre la pelota y se puede coger? */
  hitTest(x: number, y: number): boolean {
    if (this.kind !== 'pelota' || (this.state !== 'waiting' && this.state !== 'flying')) return false;
    return Math.hypot(x - this.bx, y - this.by) <= BALL_R + 8;
  }

  pointerDown(x: number, y: number): void {
    this.state = 'held';
    this.samples = [{ x, y, t: performance.now() }];
    this.bx = x;
    this.by = y;
  }

  pointerMove(x: number, y: number): void {
    if (this.state !== 'held') return;
    this.bx = x;
    this.by = y;
    this.samples.push({ x, y, t: performance.now() });
    if (this.samples.length > 8) this.samples.shift();
  }

  pointerUp(): void {
    if (this.state !== 'held') return;
    const last = this.samples[this.samples.length - 1];
    const first = this.samples.find((s) => last.t - s.t <= 100) ?? last;
    const dt = Math.max(0.016, (last.t - first.t) / 1000);
    this.bvx = clamp((last.x - first.x) / dt, -MAX_THROW, MAX_THROW);
    this.bvy = clamp((last.y - first.y) / dt, -MAX_THROW, MAX_THROW);
    this.origin = this.bx;
    this.state = 'flying';
  }

  get holding(): boolean {
    return this.state === 'held';
  }

  /** Movimiento del cursor (también llega cuando la ventana deja pasar el ratón). */
  mouseMove(x: number, y: number): void {
    this.cursor = { x, y };
  }

  mouseLeave(): void {
    this.cursor = null;
  }

  // ---------- Bucle ----------

  update(dtMs: number): void {
    if (!this.kind) return;
    if (!this.pet.owned) {
      this.cancel();
      return;
    }
    const now = performance.now();
    const dt = Math.min(dtMs, 50) / 1000;
    if (this.kind === 'laser') this.updateLaser(now);
    else this.updateBall(now, dt);
  }

  private updateLaser(now: number): void {
    if (now > this.deadline) {
      this.finish(true);
      return;
    }
    this.dot.visible = !!this.cursor;
    if (!this.cursor) return;
    this.dot.position.set(this.cursor.x, this.cursor.y);
    if (Math.abs(this.pet.x - this.cursor.x) > 25) this.pet.runTo(this.cursor.x, 2.6);
  }

  private updateBall(now: number, dt: number): void {
    switch (this.state) {
      case 'waiting':
        if (now > this.deadline) this.finish(false);
        break;
      case 'held':
        break;
      case 'flying': {
        this.physics(dt);
        // Corre detrás de la pelota; si la alcanza (en el suelo o casi), la recoge.
        this.pet.runTo(this.bx, 2.4);
        const nearGround = this.by > this.ground - BALL_R * 3;
        if (nearGround && Math.abs(this.pet.x - this.bx) < PICKUP_DIST) {
          this.state = 'carried';
          this.pet.runTo(this.origin, 1.8);
        }
        break;
      }
      case 'carried': {
        // La lleva encima de la cabeza mientras vuelve.
        this.bx = this.pet.x;
        this.by = this.pet.y - this.pet.height - BALL_R + 4 + Math.sin(now / 90) * 2;
        if (Math.abs(this.pet.x - clamp(this.origin, 12, this.display.bounds.width - 12)) < 3 || this.pet.settled) {
          this.bx = clamp(this.pet.x + this.pet.facingDir * 30, 20, this.display.bounds.width - 20);
          this.by = this.ground - BALL_R;
          this.finish(true);
        } else {
          this.pet.runTo(this.origin, 1.8);
        }
        break;
      }
    }
    this.ball.position.set(this.bx, this.by);
    this.ballFallback.position.set(this.bx, this.by);
    this.ball.rotation += (this.bvx / 400) * dt * (this.state === 'flying' ? 1 : 0);
  }

  private physics(dt: number): void {
    const w = this.display.bounds.width;
    this.bvy += GRAVITY * dt;
    this.bx += this.bvx * dt;
    this.by += this.bvy * dt;
    if (this.bx < BALL_R) {
      this.bx = BALL_R;
      this.bvx = Math.abs(this.bvx) * BOUNCE;
    } else if (this.bx > w - BALL_R) {
      this.bx = w - BALL_R;
      this.bvx = -Math.abs(this.bvx) * BOUNCE;
    }
    if (this.by < BALL_R) {
      this.by = BALL_R;
      this.bvy = Math.abs(this.bvy) * BOUNCE;
    }
    const floor = this.ground - BALL_R;
    if (this.by >= floor) {
      this.by = floor;
      if (Math.abs(this.bvy) > 120) this.bvy = -this.bvy * BOUNCE;
      else this.bvy = 0;
      this.bvx *= 0.985; // rozamiento al rodar
      if (Math.abs(this.bvx) < 8) this.bvx = 0;
    }
  }
}
