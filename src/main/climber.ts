import { screen } from 'electron';
import { displayContaining, groundY } from '../shared/displays';
import type { ClimbMessage, DisplayInfo, Rect } from '../shared/types';
import type { Game } from './game';
import type { I18n } from './i18n';
import type { OverlayManager } from './overlays';
import { listWindows, windowState, type Win32Rect, type WindowInfo } from './win32';

interface Deps {
  game: Game;
  i18n: I18n;
  overlays: OverlayManager;
  userActive(): boolean;
  /** Algo que no se debe interrumpir (minijuego, baile...). */
  busy(): boolean;
  ownWindows(): bigint[];
}

/** Escritorio, barra de tareas y similares. */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow']);
const MIN_WIDTH = 200;
/** Espacio por encima de la ventana para que se la vea entera. */
const HEADROOM = 130;
/** Altura mínima que trepar (si la ventana está casi en el suelo no tiene gracia). */
const MIN_CLIMB = 100;
/** Distancia del centro de la mascota al lateral mientras trepa. */
const WALL_GAP = 55;
const EDGE_MARGIN = 30;
const CHECK_EVERY_MS = 1000;

const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);
const sameRect = (a: Win32Rect, b: Win32Rect) =>
  Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 && Math.abs(a.right - b.right) <= 2 && Math.abs(a.bottom - b.bottom) <= 2;

interface Target {
  hwnd: bigint;
  raw: Win32Rect;
  rect: Rect;
}

/**
 * Trepar a las ventanas: paseando (sin estar cabreada), a veces va a una ventana cercana, trepa por el lateral
 * y pasea por encima un rato. Si mueves la ventana o la tapas con otra, se cae.
 */
export class Climber {
  private climb: { target: Target; until: number; announced: boolean } | null = null;
  private nextTryAt = Date.now() + 30_000;
  private lastCheckAt = 0;

  constructor(private d: Deps) {}

  private get cfg() {
    return this.d.game.config.stats.trepar;
  }

  get active(): boolean {
    return !!this.climb;
  }

  /** Se llama varias veces por segundo. */
  tick(): void {
    if (this.climb) {
      this.watch();
      return;
    }
    const now = Date.now();
    if (now < this.nextTryAt) return;
    const explore = this.d.game.mood.comportamiento?.exploracion ?? 0.4;
    // Con más ganas de explorar, se lo plantea más a menudo.
    this.nextTryAt = now + (between(this.cfg.cadaSegundos) * 1000) / (0.5 + explore);
    if (Math.random() < this.cfg.probabilidad * explore) this.tryClimb();
  }

  /** Intenta trepar ya a una ventana cercana. Devuelve true si ha empezado. */
  tryClimb(): boolean {
    const { game, overlays: o } = this.d;
    if (game.grumpy || game.quiet || !this.d.userActive() || this.d.busy()) return false;
    if (o.ownerId === null || o.hiding || o.perch) return false;
    const spot = o.petSpot();
    const d = spot && o.display(spot.displayId);
    // Solo desde el suelo y quieta o andando.
    if (!spot || !d || o.pose.state === 'fall' || o.pose.y < spot.groundY - 2) return false;

    const plan = this.pick(d, spot.x);
    if (!plan) return false;
    o.climbPet(plan.msg);
    this.climb = { target: plan.target, until: Date.now() + between(this.cfg.arribaSegundos) * 1000 + 15_000, announced: false };
    console.log(`[trepar] ventana ${Math.round(plan.target.rect.width)}x${Math.round(plan.target.rect.height)} por la ${plan.msg.side > 0 ? 'izquierda' : 'derecha'}`);
    return true;
  }

  // ---------- Elegir ventana ----------

  private windows(): { info: WindowInfo; rect: Rect }[] {
    const own = this.d.ownWindows();
    return listWindows()
      .filter((w) => !own.includes(w.hwnd) && !SHELL_CLASSES.has(w.className))
      .map((info) => {
        const r = info.rect;
        return { info, rect: screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }) };
      });
  }

  /** Tramos del borde de arriba de la ventana `i` que no tapa ninguna ventana que esté delante. */
  private uncovered(list: { rect: Rect }[], i: number): [number, number][] {
    const r = list[i].rect;
    const top = r.y;
    let free: [number, number][] = [[r.x, r.x + r.width]];
    for (const { rect: w } of list.slice(0, i)) {
      if (w.y > top + 2 || w.y + w.height < top) continue;
      const a = w.x;
      const b = w.x + w.width;
      free = free.flatMap(([l, rr]) => {
        if (b <= l || a >= rr) return [[l, rr] as [number, number]];
        const parts: [number, number][] = [];
        if (a > l) parts.push([l, a]);
        if (b < rr) parts.push([b, rr]);
        return parts;
      });
    }
    return free;
  }

  private pick(d: DisplayInfo, petX: number): { target: Target; msg: ClimbMessage } | null {
    const b = d.bounds;
    const ground = groundY(d);
    const list = this.windows();
    const options: { target: Target; msg: ClimbMessage; dist: number }[] = [];
    list.forEach((w, i) => {
      const r = w.rect;
      if (w.info.maximized || r.width < MIN_WIDTH) return;
      if (displayContaining(r.x + r.width / 2, r.y + 1, [d]) === undefined) return;
      if (r.y - b.y < HEADROOM || ground - r.y < MIN_CLIMB) return;
      const free = this.uncovered(list, i);
      for (const side of [1, -1] as const) {
        // side 1: trepa por el lado izquierdo (la ventana queda a su derecha).
        const edge = side > 0 ? r.x : r.x + r.width;
        const x = edge - side * WALL_GAP;
        if (x < b.x + 10 || x > b.x + b.width - 10) continue;
        // El tramo libre tiene que empezar justo en ese lateral.
        const seg = free.find(([l, rr]) => (side > 0 ? Math.abs(l - r.x) < 2 : Math.abs(rr - (r.x + r.width)) < 2));
        if (!seg) continue;
        const minX = Math.max(seg[0], b.x) + EDGE_MARGIN;
        const maxX = Math.min(seg[1], b.x + b.width) - EDGE_MARGIN;
        if (maxX - minX < 80) continue;
        const dist = Math.abs(x - petX);
        if (dist > this.cfg.distanciaMax) continue;
        options.push({
          target: { hwnd: w.info.hwnd, raw: w.info.rect, rect: r },
          msg: { x, side, perch: { y: r.y + 1, minX, maxX } },
          dist,
        });
      }
    });
    if (!options.length) return null;
    // Mejor las cercanas.
    const total = options.reduce((s, o) => s + 1 / (100 + o.dist), 0);
    let roll = Math.random() * total;
    return options.find((o) => (roll -= 1 / (100 + o.dist)) < 0) ?? options[0];
  }

  // ---------- Vigilar ----------

  private watch(): void {
    const c = this.climb!;
    const o = this.d.overlays;
    // Ya no está (la has cogido, la has mandado a casa, se ha escondido...).
    if (!o.perch) {
      this.climb = null;
      return;
    }
    const now = Date.now();
    const spot = o.petSpot();
    const up = !!spot && o.pose.y < spot.groundY - 20;
    if (up && !c.announced && Math.abs(o.pose.y - c.target.rect.y) < 4) {
      c.announced = true;
      if (Math.random() < 0.5) this.d.game.say({ anim: 'happy', bubble: this.d.i18n.bubble('climbTop') }, false);
    }
    if (now > c.until || this.d.game.quiet) {
      this.climb = null;
      o.unperch();
      return;
    }
    if (now - this.lastCheckAt < CHECK_EVERY_MS) return;
    this.lastCheckAt = now;
    if (this.stillThere(c.target, up ? o.pose.x : null)) return;
    // Has movido la ventana o la has tapado: se cae.
    this.climb = null;
    o.unperch();
    if (up) setTimeout(() => this.d.game.say({ anim: 'angry', sound: 'grunido', bubble: this.d.i18n.bubble('climbFell') }), 700);
  }

  /** ¿Sigue la ventana igual y el sitio donde está la mascota (x) sin tapar? */
  private stillThere(t: Target, petX: number | null): boolean {
    const ws = windowState(t.hwnd);
    if (!ws || !ws.visible || ws.minimized || !sameRect(ws.rect, t.raw)) return false;
    // Mientras trepa está al lado de la ventana, no encima: ahí no hay borde que tapar.
    if (petX === null || petX < t.rect.x || petX > t.rect.x + t.rect.width) return true;
    const list = this.windows();
    const i = list.findIndex((w) => w.info.hwnd === t.hwnd);
    if (i < 0) return false;
    return this.uncovered(list, i).some(([l, r]) => petX >= l && petX <= r);
  }
}
