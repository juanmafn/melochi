import { Graphics, Sprite, type Container } from 'pixi.js';
import { clamp, groundY, neighborDisplay } from '../../shared/displays';
import type { ClimbMessage, CloseUpMessage, DisplayInfo, GameView, HideEdge, OwnMessage, PerchInfo, PetGoal, PetPose, Rect } from '../../shared/types';
import type { OverlayApi } from '../../preload/overlay';
import type { LoadedAnim, LoadedSkin } from './skin';

type Mode = 'idle' | 'walk' | 'fall' | 'action' | 'dragged' | 'hiding' | 'climb' | 'closeup';

const GRAVITY = 2200;
const CLIMB_SPEED = 95;
/** Cuánto tarda el saltito final para ponerse encima de la ventana. */
const MOUNT_MS = 380;
/** Altura del saltito al ritmo (px, a escala 1). */
const BEAT_HOP = 9;
/** Acercarse a la pantalla: duraciones (ms) y tamaño final (alto del frame respecto al del monitor). */
const CLOSEUP_GROW_MS = 1600;
const CLOSEUP_SHRINK_MS = 1200;
const CLOSEUP_HEIGHT = 0.85;
/** Ritmo de los golpecitos: dos seguidos ("toc, toc") y una pausa. Enfadada, más y más rápido. */
const TAP_PATTERN = [320, 1300];
const ANGRY_TAP_PATTERN = [180, 180, 900];
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
  climb: 'walk',
  knock_angry: 'knock',
  knock: 'front',
  front: 'walk',
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
  /** Jugando (juguete o minijuego): no decide sola, la mueve el juego con runTo(). */
  playing = false;
  private speedMult = 1;
  /** Escondite: por dónde asoma. Con 'bottom' se recorta por debajo del suelo (detrás de la barra de tareas). */
  private hideEdge: HideEdge | null = null;
  /** Escondida detrás de una ventana: solo se la ve en esta zona (local). */
  private hideClip: Rect | null = null;
  private clip = new Graphics();
  /** Encima de una ventana (coordenadas locales): ese es su suelo y no sale de ahí. */
  private perch: PerchInfo | null = null;
  /** Huyendo del cursor: no se para aunque se lo pongas encima. */
  private fleeingUntil = 0;
  /**
   * Trepando a una ventana (local): primero anda hasta el lateral (x), luego sube pegada a él
   * y al final da un saltito para quedarse encima (perch).
   */
  private climb: { x: number; side: 1 | -1; perch: PerchInfo; phase: 'approach' | 'up' | 'mount'; t: number; fromX: number } | null = null;
  /** Acercamiento a la pantalla (1 = tamaño normal). */
  private zoom = 1;
  /**
   * Acercándose a la pantalla: crece hacia el centro (grow), toca el cristal (knock) y vuelve (shrink).
   * `from` = dónde estaba; `to` = dónde quedan los pies en primer plano.
   */
  private closeup: {
    kind: CloseUpMessage['kind'];
    phase: 'grow' | 'knock' | 'shrink';
    t: number;
    endAt: number;
    from: { x: number; y: number; facing: 1 | -1 };
    to: { x: number; y: number };
    maxZoom: number;
    tap: number;
    nextTapAt: number;
  } | null = null;
  /** Avisos para el resto de la ventana (sonido "toc", huella en el cristal, oscurecer el fondo). */
  onCloseUp: ((e: { type: 'start' | 'end' } | { type: 'tap'; x: number; y: number; angry: boolean }) => void) | null = null;
  /** Saltito al ritmo de la música mientras baila (tiempo y duración en ms). */
  private hop: { t: number; ms: number } | null = null;
  private beats = 0;

  constructor(
    stage: Container,
    private display: DisplayInfo,
    private displays: DisplayInfo[],
    private api: OverlayApi,
  ) {
    this.sprite.visible = false;
    // La máscara tiene que estar en la escena y "visible" (Pixi la oculta solo al usarla como máscara);
    // cuando no se usa, se queda vacía.
    stage.addChild(this.sprite, this.clip);
  }

  // ---------- Geometría ----------

  private get ground(): number {
    return this.perch ? this.perch.y : groundY(this.display) - this.display.bounds.y;
  }

  private get width(): number {
    return this.display.bounds.width;
  }

  /** Por dónde puede andar: todo el monitor (menos un margen) o, si está encima de una ventana, solo por ella. */
  private range(margin: number): [number, number] {
    return this.perch ? [this.perch.minX, this.perch.maxX] : [margin, this.width - margin];
  }

  /** Escala con la que se dibuja ahora: la de la skin, la propia de la animación y el acercamiento a la pantalla. */
  private get scale(): number {
    return (this.skin?.manifest.escala ?? 1) * (this.anim?.scale ?? 1) * this.zoom;
  }

  /** Tamaño "normal" de la mascota (escala de la skin y de su animación de reposo), sin acercamiento. */
  private get baseHeight(): number {
    const idle = this.skin?.anims.get(this.resolveAnim('idle'));
    const f = idle?.frames[0];
    return f ? f.height * (this.skin?.manifest.escala ?? 1) * idle.scale : 128;
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

  /** Hacia dónde mira: 1 derecha, -1 izquierda. */
  get facingDir(): 1 | -1 {
    return this.facing;
  }

  private toGlobal(): PetPose {
    // Acercándose a la pantalla, para main sigue donde estaba (luego vuelve ahí).
    const at = this.closeup?.from ?? this;
    return {
      x: at.x + this.display.bounds.x,
      y: at.y + this.display.bounds.y,
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
    // Escondida detrás de la barra de tareas: lo que queda por debajo del suelo no se ve ni se puede pulsar.
    if (this.hideEdge === 'bottom' && !this.hideClip && py > this.ground) return false;
    // Detrás de una ventana: lo que queda tapado tampoco.
    const c = this.hideClip;
    if (c && (px < c.x || px >= c.x + c.width || py < c.y || py >= c.y + c.height)) return false;
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
    this.perch = msg.perch ? this.localPerch(msg.perch) : null;
    this.climb = null;
    this.hop = null;
    this.resetCloseUp();
    this.setHide(msg.hide ?? null, msg.hideClip);

    if (msg.hide) {
      this.setMode('hiding');
    } else if (msg.dragging) {
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

  /** `clip` (global): zona en la que se la ve, para asomar por detrás de una ventana. */
  private setHide(edge: HideEdge | null, clip?: Rect): void {
    this.hideEdge = edge;
    const b = this.display.bounds;
    this.hideClip = edge && clip ? { x: clip.x - b.x, y: clip.y - b.y, width: clip.width, height: clip.height } : null;
    const c = this.hideClip;
    if (c) {
      this.clip.clear().rect(c.x, c.y, c.width, c.height).fill(0xffffff);
      this.sprite.mask = this.clip;
    } else if (edge === 'bottom') {
      this.clip.clear().rect(0, 0, this.width, this.ground).fill(0xffffff);
      this.sprite.mask = this.clip;
    } else {
      this.sprite.mask = null;
      this.clip.clear();
    }
  }

  /** Quita el acercamiento de golpe (cambio de monitor, de dueña de la mascota...). */
  private resetCloseUp(): void {
    if (!this.closeup && this.zoom === 1) return;
    this.closeup = null;
    this.zoom = 1;
    this.onCloseUp?.({ type: 'end' });
  }

  private localPerch(p: PerchInfo): PerchInfo {
    const b = this.display.bounds;
    return { y: p.y - b.y, minX: p.minX - b.x, maxX: p.maxX - b.x };
  }

  release(poof: boolean): void {
    if (!this.owned) return;
    this.owned = false;
    this.perch = null;
    this.climb = null;
    this.resetCloseUp();
    this.setHide(null);
    if (poof) this.fx = { kind: 'out', t: 0 };
    else this.sprite.visible = false;
  }

  /** ¿Sigue habiendo algo que dibujar (mascota o efecto de desaparición)? */
  get needsRender(): boolean {
    return this.owned || this.fx?.kind === 'out';
  }

  // ---------- Órdenes ----------

  /** Está escondida (escondite): no debe delatarse con bocadillos ni animaciones. */
  get isHiding(): boolean {
    return this.mode === 'hiding';
  }

  react(anim: string, durationMs?: number): void {
    const busy: Mode[] = ['dragged', 'fall', 'hiding', 'climb', 'closeup'];
    if (!this.owned || busy.includes(this.mode)) return;
    this.play(anim, true);
    const a = this.anim;
    const total = a ? a.frames.reduce((s, f) => s + f.duration, 0) : 0;
    this.setMode('action', durationMs ?? Math.max(MIN_ACTION_MS, a?.loop ? LOOPING_ACTION_MS : total));
  }

  /** Corre hasta x (local) mientras juega. No interrumpe si la están arrastrando o está cayendo. */
  runTo(x: number, speedMult = 2.2): void {
    if (!this.owned || this.mode === 'dragged' || this.mode === 'fall' || this.mode === 'climb' || this.mode === 'closeup') return;
    // Un juguete o huir del cursor es más importante que trepar.
    this.cancelClimb(true);
    this.goal = null;
    this.speedMult = speedMult;
    const [lo, hi] = this.range(12);
    this.targetX = clamp(x, lo, hi);
    if (this.mode !== 'walk') this.setMode('walk');
  }

  /** Sale corriendo lejos del cursor (cabreada, cuando ibas a acariciarla). Devuelve false si no puede. */
  flee(cursorX: number): boolean {
    if (!this.owned || this.playing || !['idle', 'walk', 'action'].includes(this.mode)) return false;
    const [lo, hi] = this.range(12);
    let dir: -1 | 1 = cursorX < this.x ? 1 : -1;
    // Si está contra la pared, mejor por el otro lado (pasando junto al cursor).
    if ((dir > 0 ? hi - this.x : this.x - lo) < 100) dir = dir > 0 ? -1 : 1;
    const target = this.x + dir * (180 + Math.random() * 160);
    if (Math.abs(clamp(target, lo, hi) - this.x) < 40) return false;
    this.runTo(target, 2.8);
    this.heldUntil = 0;
    this.fleeingUntil = performance.now() + 1500;
    return true;
  }

  /** Main la baja de la ventana: cae al suelo y, si `home`, después se va a casa. */
  unperch(home: boolean): void {
    if (!this.owned) return;
    if (this.climb) {
      // Aún trepando (o yendo hacia la ventana): lo deja.
      const wasUp = this.mode === 'climb';
      this.climb = null;
      if (!wasUp) {
        if (home) this.goHome();
        return;
      }
    } else if (!this.perch) {
      return;
    }
    this.perch = null;
    if (this.mode === 'dragged') return;
    this.vx = 0;
    this.vy = 0;
    this.goal = home ? { kind: 'home' } : null;
    this.targetX = null;
    this.setMode('fall');
  }

  /** ¿Está quieta y en el suelo? (para saber si ha llegado adonde la mandó el juego) */
  get settled(): boolean {
    return this.mode === 'idle' || this.mode === 'action';
  }

  /** El cursor está encima: se para un momento. */
  hold(): void {
    if (this.playing || performance.now() < this.fleeingUntil) return;
    this.heldUntil = performance.now() + 1500;
    if (this.mode === 'walk' && this.goal?.kind !== 'home') {
      this.targetX = null;
      this.idleFor(1500);
    }
  }

  /** Main la manda trepar a una ventana. Si no puede (está jugando, cayendo...), se lo dice. */
  climbTo(msg: ClimbMessage): void {
    if (!this.owned || this.playing || this.perch || !['idle', 'walk', 'action'].includes(this.mode)) {
      this.api.climbAbort();
      return;
    }
    const x = clamp(msg.x - this.display.bounds.x, 5, this.width - 5);
    this.climb = { x, side: msg.side, perch: this.localPerch(msg.perch), phase: 'approach', t: 0, fromX: x };
    this.goal = null;
    this.speedMult = 1.3;
    this.targetX = x;
    this.setMode('walk');
  }

  private cancelClimb(notify: boolean): void {
    if (!this.climb) return;
    this.climb = null;
    if (notify) this.api.climbAbort();
  }

  private stepClimb(dt: number): void {
    const c = this.climb;
    if (!c) {
      this.setMode('fall');
      return;
    }
    if (c.phase === 'up') {
      this.facing = c.side;
      this.y -= CLIMB_SPEED * dt;
      if (this.y <= c.perch.y) {
        this.y = c.perch.y;
        c.phase = 'mount';
        c.t = 0;
        c.fromX = this.x;
        this.play('happy');
      }
      return;
    }
    // Saltito para ponerse encima, ya dentro de la ventana.
    c.t += dt * 1000;
    const k = Math.min(1, c.t / MOUNT_MS);
    const toX = clamp(c.fromX + c.side * 55, c.perch.minX, c.perch.maxX);
    this.x = c.fromX + (toX - c.fromX) * k;
    this.y = c.perch.y - Math.sin(Math.PI * k) * 28;
    if (k >= 1) {
      this.perch = c.perch;
      this.climb = null;
      this.y = this.perch.y;
      this.idleFor(1200);
    }
  }

  /** Está acercándose a la pantalla (o volviendo): no se la puede arrastrar. */
  get inCloseUp(): boolean {
    return this.mode === 'closeup';
  }

  /** Main le pide que se acerque a la pantalla y toque el cristal. Si no puede ahora, se lo dice. */
  startCloseUp(msg: CloseUpMessage): void {
    if (!this.owned || this.playing || !['idle', 'walk', 'action'].includes(this.mode)) {
      this.api.closeupAbort();
      return;
    }
    const H = this.display.bounds.height;
    const maxZoom = (CLOSEUP_HEIGHT * H) / this.baseHeight;
    const center = this.width / 2;
    this.closeup = {
      kind: msg.kind,
      phase: 'grow',
      t: 0,
      endAt: performance.now() + CLOSEUP_GROW_MS + msg.waitMs,
      from: { x: this.x, y: this.y, facing: this.facing },
      // Hacia el centro, con los pies algo por debajo del borde de la pantalla (está pegada al cristal).
      to: { x: this.x * 0.35 + center * 0.65, y: H + CLOSEUP_HEIGHT * H * 0.08 },
      maxZoom,
      tap: 0,
      nextTapAt: 0,
    };
    this.targetX = null;
    this.hop = null;
    this.setMode('closeup');
    this.onCloseUp?.({ type: 'start' });
  }

  /** Main dice que ya está (le has hecho caso o se cansa de esperar): vuelve a su sitio. */
  endCloseUp(): void {
    const c = this.closeup;
    if (!c || c.phase === 'shrink') return;
    c.phase = 'shrink';
    c.t = 0;
    c.to = { x: this.x, y: this.y };
    c.maxZoom = this.zoom;
    this.play('walk');
  }

  private stepCloseUp(dtMs: number): void {
    const c = this.closeup;
    if (!c) {
      this.idleFor(500);
      return;
    }
    c.t += dtMs;
    const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    if (c.phase === 'grow') {
      const k = Math.min(1, c.t / CLOSEUP_GROW_MS);
      const e = ease(k);
      this.zoom = 1 + (c.maxZoom - 1) * e;
      this.x = c.from.x + (c.to.x - c.from.x) * e;
      this.y = c.from.y + (c.to.y - c.from.y) * e;
      this.facing = 1;
      this.play('front');
      if (k >= 1) {
        c.phase = 'knock';
        c.t = 0;
        c.nextTapAt = 250;
        this.play(c.kind === 'angry' ? 'knock_angry' : 'knock', true);
      }
      return;
    }
    if (c.phase === 'knock') {
      if (c.t >= c.nextTapAt) {
        const pattern = c.kind === 'angry' ? ANGRY_TAP_PATTERN : TAP_PATTERN;
        c.nextTapAt += pattern[c.tap % pattern.length];
        // Alterna las manos: izquierda, derecha...
        const side = c.tap % 2 ? 1 : -1;
        c.tap++;
        const f = this.frame;
        const w = (f?.width ?? 128) * this.scale;
        const h = (f?.height ?? 128) * this.scale;
        // Donde están las manitas en la animación (más o menos; con otras skins, cerca de las manos).
        this.onCloseUp?.({ type: 'tap', x: this.x + side * w * 0.25, y: this.y - h * 0.22, angry: c.kind === 'angry' });
      }
      if (performance.now() >= c.endAt) this.endCloseUp();
      return;
    }
    // Vuelve a donde estaba, haciéndose pequeña.
    const k = Math.min(1, c.t / CLOSEUP_SHRINK_MS);
    const e = ease(k);
    this.zoom = c.maxZoom + (1 - c.maxZoom) * e;
    this.x = c.to.x + (c.from.x - c.to.x) * e;
    this.y = c.to.y + (c.from.y - c.to.y) * e;
    this.facing = c.from.x >= c.to.x ? 1 : -1;
    if (k < 1) return;
    this.zoom = 1;
    this.facing = c.from.facing;
    this.closeup = null;
    this.onCloseUp?.({ type: 'end' });
    // Si mientras tanto ha perdido el sitio en el que estaba (estaba encima de una ventana), cae.
    if (this.y < this.ground - 1) this.setMode('fall');
    else this.idleFor(800);
  }

  /** Golpe de ritmo de la música: si está bailando, da un saltito con él. */
  beat(periodMs: number): void {
    if (!this.owned || this.mode !== 'action' || this.animName !== this.resolveAnim('dance')) return;
    this.hop = { t: 0, ms: clamp(periodMs * 0.85, 180, 450) };
    // Cada 4 golpes se da la vuelta (como un paso de baile).
    if (++this.beats % 4 === 0) this.facing = this.facing === 1 ? -1 : 1;
  }

  startDrag(): void {
    this.perch = null;
    this.climb = null;
    this.setMode('dragged');
  }

  dragTo(globalX: number, globalY: number): void {
    if (!this.owned) return;
    this.perch = null;
    this.climb = null;
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
    if (this.perch) {
      this.unperch(true);
      return;
    }
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
      case 'climb':
        this.stepClimb(dt);
        break;
      case 'closeup':
        this.stepCloseUp(Math.min(dtMs, 50));
        break;
      case 'action':
        if (now >= this.modeUntil && (this.animDone || this.anim?.loop !== false)) this.idleFor(800 + Math.random() * 1500);
        break;
      case 'dragged':
      case 'hiding':
        break;
    }

    if (this.hop) {
      this.hop.t += dtMs;
      if (this.hop.t >= this.hop.ms || this.mode !== 'action') this.hop = null;
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
    const [lo, hi] = this.range(EDGE_MARGIN);
    this.targetX = clamp(x, lo, hi);
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
      case 'hiding':
        return 'hide_peek';
      case 'climb':
        return 'climb';
      case 'closeup':
        return 'front';
      default:
        return 'idle';
    }
  }

  /** Decide qué hacer al terminar de estar quieta, según cuánto le apetece explorar en su mood. */
  private decide(): void {
    if (this.playing) {
      this.idleFor(300);
      return;
    }
    if (this.goal?.kind === 'home') {
      this.goHome();
      return;
    }
    // Iba hacia una ventana para trepar (y algo la ha parado un momento): sigue.
    if (this.climb) {
      this.speedMult = 1.3;
      this.targetX = this.climb.x;
      this.setMode('walk');
      return;
    }
    const e = this.view?.mood.comportamiento.exploracion ?? 0.4;
    if (Math.random() > 0.25 + 0.55 * e) {
      this.idleFor((2000 + Math.random() * 4000) * (1.5 - e));
      return;
    }

    const dir: -1 | 1 = Math.random() < 0.5 ? -1 : 1;
    if (!this.perch && neighborDisplay(this.display, dir, this.displays) && Math.random() < e * 0.2) {
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
    const speed = WALK_SPEED * (this.view?.mood.comportamiento.velocidad ?? 1) * this.speedMult;
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
      this.speedMult = 1;
      if (this.climb?.phase === 'approach') {
        // Junto al lateral: a trepar, mirando a la ventana.
        this.climb.phase = 'up';
        this.facing = this.climb.side;
        this.setMode('climb');
        return;
      }
      if (this.goal?.kind === 'home') this.goal = null;
      if (this.playing) this.idleFor(200);
      else this.idleFor((1500 + Math.random() * 4000) * (1.5 - (this.view?.mood.comportamiento.exploracion ?? 0.4)));
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
    // Saltito al ritmo: sube y baja, y se aplasta un poco al despegar y al aterrizar.
    let hopY = 0;
    let sx = 1;
    let sy = 1;
    if (this.hop) {
      const k = this.hop.t / this.hop.ms;
      hopY = Math.sin(Math.PI * k) * BEAT_HOP * s;
      const squash = k < 0.12 || k > 0.88 ? 0.06 : 0;
      sx = 1 + squash;
      sy = 1 - squash;
    }
    this.sprite.alpha = alpha;
    this.sprite.position.set(Math.round(this.x), Math.round(this.y - hopY));
    this.sprite.scale.set(this.facing * s * sx, s * sy);
  }
}
