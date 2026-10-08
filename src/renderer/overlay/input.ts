import type { OverlayApi } from '../../preload/overlay';
import type { Pet } from './pet';
import type { Toys } from './toys';

const DRAG_THRESHOLD = 6;
const TICKLE_CLICKS = 3;
const TICKLE_WINDOW_MS = 1500;
const POKE_DELAY_MS = 450;
const STROKE_MIN_TRAVEL = 12;
const STROKES_FOR_PET = 4;
const STROKE_WINDOW_MS = 2000;
const PET_COOLDOWN_MS = 1200;
/** Distancia (desde su contorno, aprox.) a la que nota que se acerca el cursor. */
const FLEE_RADIUS = 60;
const FLEE_COOLDOWN_MS = 2500;

/**
 * La ventana deja pasar el ratón a lo que haya debajo, salvo cuando el cursor está sobre la mascota
 * o sobre un elemento con la clase "interactive". Aquí también se detectan caricias, cosquillas y arrastres.
 */
export class Input {
  private ignoring = true;
  private press: { x: number; y: number } | null = null;
  dragging = false;
  private clicks: number[] = [];
  private pokeTimer: number | null = null;
  private stroke = { lastX: 0, dir: 0, travel: 0, times: [] as number[], cooldownUntil: 0 };

  private toyDrag = false;
  /** El cursor está cerca de la mascota (para huir solo al acercarse, no a cada movimiento). */
  private near = false;
  private lastFleeAt = 0;

  constructor(
    private pet: Pet,
    private api: OverlayApi,
    private toys: Toys,
    /** Probabilidad de que huya al acercarle el cursor (0 si no está cabreada o no puede). */
    private fleeChance: () => number,
  ) {}

  install(): void {
    // Sincroniza el estado con la ventana desde el principio.
    this.api.setIgnoreMouse(true);
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.pet.hitTest(e.clientX, e.clientY)) this.api.contextMenu();
    });
    // Si el ratón sale de la ventana (otro monitor), vuelve a dejar pasar los clics.
    document.addEventListener('mouseleave', () => {
      this.toys.mouseLeave();
      this.setIgnore(true);
    });
  }

  private isInteractive(x: number, y: number): boolean {
    const target = document.elementFromPoint(x, y);
    if (target?.closest('.interactive')) return true;
    return this.pet.hitTest(x, y) || this.toys.hitTest(x, y);
  }

  private setIgnore(ignore: boolean): void {
    if (this.press || this.dragging || this.toyDrag) return;
    if (ignore === this.ignoring) return;
    this.ignoring = ignore;
    this.api.setIgnoreMouse(ignore);
  }

  /** Llega también cuando la ventana ignora el ratón (eventos reenviados). */
  private onMouseMove(e: MouseEvent): void {
    this.toys.mouseMove(e.clientX, e.clientY);
    if (!this.press && !this.dragging) this.checkFlee(e.clientX, e.clientY);
    this.setIgnore(!this.isInteractive(e.clientX, e.clientY));
    if (!this.press && !this.dragging && this.pet.hitTest(e.clientX, e.clientY)) {
      this.pet.hold();
      this.trackStroke(e.clientX);
    }
  }

  /** Cabreada, a veces sale corriendo cuando le acercas el cursor. */
  private checkFlee(x: number, y: number): void {
    if (!this.pet.owned) return;
    const dist = Math.hypot(x - this.pet.x, y - (this.pet.y - this.pet.height / 2));
    const isNear = dist < this.pet.height / 2 + FLEE_RADIUS;
    const now = performance.now();
    if (isNear && !this.near && now - this.lastFleeAt > FLEE_COOLDOWN_MS) {
      const chance = this.fleeChance();
      if (chance > 0 && Math.random() < chance && this.pet.flee(x)) {
        this.lastFleeAt = now;
        this.api.fled();
      }
    }
    this.near = isNear;
  }

  /** Caricia: pasar el cursor de un lado a otro por encima de la mascota varias veces. */
  private trackStroke(x: number): void {
    const s = this.stroke;
    const dx = x - s.lastX;
    s.lastX = x;
    if (dx === 0) return;
    const dir = Math.sign(dx);
    if (dir === s.dir) {
      s.travel += Math.abs(dx);
      return;
    }
    const now = performance.now();
    if (s.travel >= STROKE_MIN_TRAVEL) s.times.push(now);
    s.dir = dir;
    s.travel = Math.abs(dx);
    s.times = s.times.filter((t) => now - t < STROKE_WINDOW_MS);
    if (s.times.length >= STROKES_FOR_PET && now >= s.cooldownUntil) {
      s.times = [];
      s.cooldownUntil = now + PET_COOLDOWN_MS;
      this.api.interact('pet');
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // La pelota tiene prioridad (suele estar a los pies de la mascota).
    if (this.toys.hitTest(e.clientX, e.clientY)) {
      this.toyDrag = true;
      this.toys.pointerDown(e.clientX, e.clientY);
      document.documentElement.setPointerCapture(e.pointerId);
      return;
    }
    if (!this.pet.hitTest(e.clientX, e.clientY)) return;
    this.press = { x: e.clientX, y: e.clientY };
    document.documentElement.setPointerCapture(e.pointerId);
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.toyDrag) {
      this.toys.pointerMove(e.clientX, e.clientY);
      return;
    }
    // Escondida no se puede arrastrar: un clic es "¡te encontré!".
    if (!this.press || this.dragging || this.pet.isHiding) return;
    if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < DRAG_THRESHOLD) return;
    this.dragging = true;
    this.pet.startDrag();
    // Distancia del cursor al punto de apoyo: main la mantiene mientras arrastras.
    this.api.dragStart(this.press.x - this.pet.x, this.press.y - this.pet.y);
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (this.toyDrag) {
      this.toyDrag = false;
      this.toys.pointerUp();
      this.setIgnore(!this.isInteractive(e.clientX, e.clientY));
      return;
    }
    const wasDragging = this.dragging;
    const pressed = this.press;
    this.press = null;
    this.dragging = false;
    if (wasDragging) this.api.dragEnd();
    else if (pressed) this.onClick();
    this.setIgnore(!this.isInteractive(e.clientX, e.clientY));
  }

  /** main terminó el arrastre por su cuenta (p. ej. soltaste sobre otro monitor). */
  dragFinished(): void {
    this.press = null;
    this.dragging = false;
  }

  /** Un clic suelto = "toque" (y abre el chat); varios clics rápidos = cosquillas. */
  private onClick(): void {
    const now = performance.now();
    this.clicks = this.clicks.filter((t) => now - t < TICKLE_WINDOW_MS);
    this.clicks.push(now);
    if (this.pokeTimer !== null) clearTimeout(this.pokeTimer);
    this.pokeTimer = null;

    if (this.clicks.length >= TICKLE_CLICKS) {
      this.clicks = [];
      this.api.interact('tickle');
      return;
    }
    this.pokeTimer = window.setTimeout(() => {
      this.pokeTimer = null;
      // Un clic: te saluda y abre el chat.
      if (this.clicks.length === 1) {
        this.api.interact('poke');
        this.api.openChat();
      }
      this.clicks = [];
    }, POKE_DELAY_MS);
  }
}
