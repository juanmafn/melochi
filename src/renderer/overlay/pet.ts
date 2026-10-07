import { Sprite, type Container } from 'pixi.js';
import { clamp, groundY, neighborDisplay } from '../../shared/displays';
import type { DisplayInfo, GameView, OwnMessage, PetGoal, PetPose } from '../../shared/types';
import type { OverlayApi } from '../../preload/overlay';
import type { LoadedAnim, LoadedSkin } from './skin';

type Mode = 'idle' | 'walk' | 'fall' | 'action' | 'dragged';

const GRAVITY = 2200;
const WALK_SPEED = 70;
const EDGE_MARGIN = 40;
const REPORT_EVERY_MS = 1000;
const MIN_ACTION_MS = 1200;
const LOOPING_ACTION_MS = 1800;
const FX_MS = 280;

/** Si falta una animación, se prueba con la siguiente de esta cadena hasta llegar a "idle". */
const FALLBACK: Record<string, string> = {
  petted: 'happy',
  drink: 'eat',
  eat: 'happy',
  dance: 'happy',
  mischief: 'angry',
  drag: 'fall',
  fall: 'idle',
  walk: 'idle',
  talk: 'idle',
  happy: 'idle',
  angry: 'idle',
};

/**
 * La mascota tal como la ve una ventana overlay. Trabaja en coordenadas locales del monitor;
 * al hablar con main (traspasos, informes) convierte a coordenadas globales.
 */
export class Pet {
  readonly sprite = new Sprite();
  owned = false;
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  private facing: 1 | -1 = 1;
  private mode: Mode = 'idle';
  private modeUntil = 0;
  private targetX: number | null = null;
  private goal: PetGoal | null = null;
  private skin: LoadedSkin | null = null;
  private view: GameView | null = null;
  private animName = '';
  private anim: LoadedAnim | null = null;
  private frameIdx = 0;
  private frameTime = 0;
  private animDone = false;
  private lastReport = 0;
  private fx: { kind: 'in' | 'out'; t: number } | null = null;
  /** Mientras el cursor está encima, no echa a andar (para poder acariciarla). */
  private heldUntil = 0;

  constructor(
    stage: Container,
    private display: DisplayInfo,
    private displays: DisplayInfo[],
    private api: OverlayApi,
  ) {
    this.sprite.visible = false;
    stage.addChild(this.sprite);
  }

  // ---------- Geometría ----------

  private get ground(): number {
    return groundY(this.display) - this.display.bounds.y;
  }

  private get width(): number {
    return this.display.bounds.width;
  }

  private get scale(): number {
    return this.skin?.manifest.escala ?? 1;
  }

  private get frame() {
    return this.anim?.frames[this.frameIdx];
  }

  /** Altura visible de la mascota (para colocar bocadillos y paneles encima). */
  get height(): number {
    const f = this.frame;
    const anchorY = this.skin?.manifest.ancla[1] ?? 1;
    return f ? f.height * this.scale * anchorY : 64;
  }

  get isDragged(): boolean {
    return this.mode === 'dragged';
  }

  private toGlobal(): PetPose {
    return {
      x: this.x + this.display.bounds.x,
      y: this.y + this.display.bounds.y,
      vx: this.vx,
      vy: this.vy,
      state: this.mode === 'walk' ? 'walk' : this.mode === 'fall' ? 'fall' : 'idle',
      facing: this.facing,
      goal: this.goal,
    };
  }

  /** ¿El punto (local) cae sobre un píxel visible de la mascota? */
  hitTest(px: number, py: number): boolean {
    const f = this.frame;
    if (!this.owned || !this.sprite.visible || !f || !this.skin) return false;
    const [ax, ay] = this.skin.manifest.ancla;
    const tx = Math.floor((px - this.x) / (this.facing * this.scale) + ax * f.width);
    const ty = Math.floor((py - this.y) / this.scale + ay * f.height);
    if (tx < 0 || ty < 0 || tx >= f.width || ty >= f.height) return false;
    return f.mask[ty * f.width + tx] === 1;
  }

  // ---------- Datos externos ----------

  setSkin(skin: LoadedSkin): void {
    this.skin = skin;
    const [ax, ay] = skin.manifest.ancla;
    this.sprite.anchor.set(ax, ay);
    this.animName = '';
    this.play(this.baseAnim(), true);
  }

  setView(view: GameView): void {
    const moodChanged = this.view?.mood.id !== view.mood.id;
    this.view = view;
    if (moodChanged && this.mode !== 'action') this.play(this.baseAnim());
  }

  // ---------- Propiedad (qué ventana la muestra) ----------

  own(msg: OwnMessage): void {
    const p = msg.pose;
    this.owned = true;
    this.x = p.x - this.display.bounds.x;
    this.y = p.y - this.display.bounds.y;
    this.vx = p.vx;
    this.vy = p.vy;
    this.facing = p.facing;
    this.goal = p.goal ?? null;
    this.targetX = null;
    this.sprite.visible = true;
    this.sprite.alpha = 1;
    this.fx = msg.appear === 'poof' ? { kind: 'in', t: 0 } : null;

    if (msg.dragging) {
      this.setMode('dragged');
    } else if (p.state === 'fall' || this.y < this.ground - 1) {
      this.setMode('fall');
    } else {
      this.y = Math.min(this.y, this.ground);
      if (this.goal?.kind === 'home') this.goHome();
      else if (this.goal?.kind === 'wander') this.walkTo(this.goal.x - this.display.bounds.x);
      else this.idleFor(500 + Math.random() * 1500);
    }
    this.render();
  }

  release(poof: boolean): void {
    if (!this.owned) return;
    this.owned = false;
    if (poof) this.fx = { kind: 'out', t: 0 };
    else this.sprite.visible = false;
  }

  /** ¿Sigue habiendo algo que dibujar (mascota o efecto de desaparición)? */
  get needsRender(): boolean {
    return this.owned || this.fx?.kind === 'out';
  }

  // ---------- Órdenes ----------

  react(anim: string, durationMs?: number): void {
    if (!this.owned || this.mode === 'dragged' || this.mode === 'fall') return;
    this.play(anim, true);
    const a = this.anim;
    const total = a ? a.frames.reduce((s, f) => s + f.duration, 0) : 0;
    this.setMode('action', durationMs ?? Math.max(MIN_ACTION_MS, a?.loop ? LOOPING_ACTION_MS : total));
  }

  /** El cursor está encima: se para un momento. */
  hold(): void {
    this.heldUntil = performance.now() + 1500;
    if (this.mode === 'walk' && this.goal?.kind !== 'home') {
      this.targetX = null;
      this.idleFor(1500);
    }
  }

  startDrag(): void {
    this.setMode('dragged');
  }

  dragTo(globalX: number, globalY: number): void {
    if (!this.owned) return;
    if (this.mode !== 'dragged') this.setMode('dragged');
    const nx = globalX - this.display.bounds.x;
    if (Math.abs(nx - this.x) > 1) this.facing = nx > this.x ? 1 : -1;
    this.x = nx;
    this.y = globalY - this.display.bounds.y;
  }

  throwFrom(globalX: number, globalY: number, vx: number, vy: number): void {
    if (!this.owned) return;
    this.x = globalX - this.display.bounds.x;
    this.y = globalY - this.display.bounds.y;
    this.vx = vx;
    this.vy = vy;
    this.goal = null;
    this.setMode('fall');
  }

  goHome(): void {
    const home = this.view?.home;
    if (!home || !this.owned || this.mode === 'dragged' || this.mode === 'fall') return;
    this.goal = { kind: 'home' };
    if (home.displayId === this.display.id) {
      this.targetX = clamp(home.x - this.display.bounds.x, EDGE_MARGIN, this.width - EDGE_MARGIN);
      this.setMode('walk');
      return;
    }
    // La casa está en otro monitor: si es contiguo, anda hasta el borde; si no, se teletransporta.
    const target = this.displays.find((d) => d.id === home.displayId);
    const dir: -1 | 1 = target && target.bounds.x < this.display.bounds.x ? -1 : 1;
    if (target && neighborDisplay(this.display, dir, this.displays)) {
      this.targetX = dir < 0 ? -EDGE_MARGIN : this.width + EDGE_MARGIN;
      this.setMode('walk');
    } else {
      this.goal = null;
      this.api.teleportHome();
    }
  }

  // ---------- Bucle ----------

  update(dtMs: number): void {
    this.updateFx(dtMs);
    if (!this.owned) {
      this.render();
      return;
    }
    const dt = Math.min(dtMs, 50) / 1000;
    const now = performance.now();

    switch (this.mode) {
      case 'idle':
        if (now >= this.modeUntil && now >= this.heldUntil) this.decide();
        break;
      case 'walk':
        this.stepWalk(dt);
        break;
      case 'fall':
        this.stepFall(dt);
        break;
      case 'action':
        if (now >= this.modeUntil && (this.animDone || this.anim?.loop !== false)) this.idleFor(800 + Math.random() * 1500);
        break;
      case 'dragged':
        break;
    }

    this.advanceAnim(dtMs);
    this.render();

    if (this.owned && this.mode !== 'dragged' && now - this.lastReport > REPORT_EVERY_MS) {
      this.lastReport = now;
      this.api.reportPose(this.toGlobal());
    }
  }

  private setMode(mode: Mode, durationMs = 0): void {
    this.mode = mode;
    this.modeUntil = performance.now() + durationMs;
    if (mode !== 'action') this.play(this.baseAnim());
  }

  private idleFor(ms: number): void {
    this.vx = 0;
    this.setMode('idle', ms);
  }

  private walkTo(x: number): void {
    this.targetX = clamp(x, EDGE_MARGIN, this.width - EDGE_MARGIN);
    this.setMode('walk');
  }

  private baseAnim(): string {
    switch (this.mode) {
      case 'walk':
        return 'walk';
      case 'fall':
        return 'fall';
      case 'dragged':
        return 'drag';
      default:
        return 'idle';
    }
  }

  /** Decide qué hacer al terminar de estar quieta, según cuánto le apetece explorar en su mood. */
  private decide(): void {
    if (this.goal?.kind === 'home') {
      this.goHome();
      return;
    }
    const e = this.view?.mood.comportamiento.exploracion ?? 0.4;
    if (Math.random() > 0.25 + 0.55 * e) {
      this.idleFor((2000 + Math.random() * 4000) * (1.5 - e));
      return;
    }

    const dir: -1 | 1 = Math.random() < 0.5 ? -1 : 1;
    if (neighborDisplay(this.display, dir, this.displays) && Math.random() < e * 0.2) {
      this.goal = { kind: 'cross', direction: dir };
      this.targetX = dir < 0 ? -EDGE_MARGIN : this.width + EDGE_MARGIN;
      this.setMode('walk');
      return;
    }

    // Con poca exploración tiende a quedarse cerca de casa.
    const home = this.view?.home;
    const homeX = home?.displayId === this.display.id ? home.x - this.display.bounds.x : null;
    const base = homeX !== null && Math.random() > e ? homeX : this.x;
    const range = 120 + e * this.width * 0.6;
    this.walkTo(base + (Math.random() * 2 - 1) * range);
  }

  private stepWalk(dt: number): void {
    if (this.targetX === null) {
      this.idleFor(1000);
      return;
    }
    const speed = WALK_SPEED * (this.view?.mood.comportamiento.velocidad ?? 1);
    const dx = this.targetX - this.x;
    this.facing = dx >= 0 ? 1 : -1;
    this.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * dt);
    this.y = this.ground;

    if (this.x < 0 || this.x > this.width) {
      if (this.cross(this.x < 0 ? -1 : 1)) return;
      this.x = clamp(this.x, 0, this.width);
      this.goal = null;
      this.idleFor(1000);
      return;
    }
    if (Math.abs(this.targetX - this.x) < 1) {
      this.targetX = null;
      if (this.goal?.kind === 'home') this.goal = null;
      this.idleFor((1500 + Math.random() * 4000) * (1.5 - (this.view?.mood.comportamiento.exploracion ?? 0.4)));
    }
  }

  private stepFall(dt: number): void {
    this.vy += GRAVITY * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    if (Math.abs(this.vx) > 40) this.facing = this.vx > 0 ? 1 : -1;

    if (this.x < 0 || this.x > this.width) {
      if (this.cross(this.x < 0 ? -1 : 1)) return;
      this.x = clamp(this.x, 0, this.width);
      this.vx = -this.vx * 0.5;
    }
    const top = this.height;
    if (this.y < top) {
      this.y = top;
      this.vy = Math.abs(this.vy) * 0.3;
    }
    if (this.y >= this.ground) {
      this.y = this.ground;
      if (this.vy > 350) {
        this.vy = -this.vy * 0.35;
        this.vx *= 0.7;
      } else {
        this.vy = 0;
        this.vx = 0;
        this.idleFor(600 + Math.random() * 800);
      }
    }
  }

  /** Pasa al monitor contiguo. Devuelve false si no hay monitor en esa dirección. */
  private cross(dir: -1 | 1): boolean {
    const nb = neighborDisplay(this.display, dir, this.displays);
    if (!nb) return false;
    const pose = this.toGlobal();
    pose.x = dir > 0 ? nb.bounds.x + 2 : nb.bounds.x + nb.bounds.width - 2;
    if (this.goal?.kind === 'cross') {
      // Al llegar, se adentra un poco en el nuevo monitor.
      this.goal = { kind: 'wander', x: pose.x + dir * (100 + Math.random() * 250) };
      pose.goal = this.goal;
    }
    this.owned = false;
    this.sprite.visible = false;
    this.api.handoff(pose, nb.id);
    return true;
  }

  // ---------- Animación ----------

  private resolveAnim(action: string): string {
    const anims = this.skin?.anims;
    if (!anims) return action;
    const mood = this.view?.mood;
    let name: string | undefined = action;
    while (name) {
      const candidates = [mood?.animaciones[name], mood ? `${mood.id}_${name}` : undefined, name];
      const found = candidates.find((c): c is string => !!c && anims.has(c));
      if (found) return found;
      name = FALLBACK[name] ?? (name === 'idle' ? undefined : 'idle');
    }
    return anims.keys().next().value ?? 'idle';
  }

  private play(action: string, restart = false): void {
    const name = this.resolveAnim(action);
    if (name === this.animName && !restart) return;
    this.animName = name;
    this.anim = this.skin?.anims.get(name) ?? null;
    this.frameIdx = 0;
    this.frameTime = 0;
    this.animDone = false;
  }

  private advanceAnim(dtMs: number): void {
    const a = this.anim;
    if (!a || a.frames.length === 0) return;
    this.frameTime += dtMs;
    let guard = 0;
    while (this.frameTime >= a.frames[this.frameIdx].duration && guard++ < 100) {
      this.frameTime -= a.frames[this.frameIdx].duration;
      if (this.frameIdx + 1 < a.frames.length) {
        this.frameIdx++;
      } else if (a.loop) {
        this.frameIdx = 0;
      } else {
        this.animDone = true;
        this.frameTime = 0;
        break;
      }
    }
  }

  private updateFx(dtMs: number): void {
    if (!this.fx) return;
    this.fx.t += dtMs;
    if (this.fx.t >= FX_MS) {
      if (this.fx.kind === 'out') this.sprite.visible = false;
      this.fx = null;
    }
  }

  private render(): void {
    const f = this.frame;
    if (f) this.sprite.texture = f.texture;
    let s = this.scale;
    let alpha = 1;
    if (this.fx) {
      const k = this.fx.t / FX_MS;
      alpha = this.fx.kind === 'in' ? k : 1 - k;
      s *= this.fx.kind === 'in' ? 0.6 + 0.4 * k : 1 + 0.3 * k;
    }
    this.sprite.alpha = alpha;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y));
    this.sprite.scale.set(this.facing * s, s);
  }
}
