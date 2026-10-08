import { screen } from 'electron';
import { clamp, displayContaining, groundY } from '../shared/displays';
import type { DesktopMischief, DisplayInfo, HideEdge, Rect, StickyNote } from '../shared/types';
import type { Game } from './game';
import type { I18n } from './i18n';
import { screenHideSpot } from './minigames';
import type { OverlayManager } from './overlays';
import { foregroundInfo, windowState, type Win32Rect } from './win32';

interface Deps {
  game: Game;
  i18n: I18n;
  overlays: OverlayManager;
  /** Travesura con tu música (Spotify). `available` = se puede intentar ahora. */
  music: { available(): boolean; run(welcome: boolean): Promise<boolean> };
  /** Texto de un post-it escrito por la IA (null si no puede). */
  writeNote(): Promise<string | null>;
  /** ¿Estás delante del ordenador? */
  userActive(): boolean;
  /** Algo que no se debe interrumpir (un minijuego, el chat abierto). */
  busy(): boolean;
  /** HWND de nuestras ventanas (no cuentan como "tu ventana"). */
  ownWindows(): bigint[];
}

/** Escritorio, barra de tareas, menú Inicio y similares: no son ventanas en las que sentarse. */
const SHELL_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland',
  'XamlExplorerHostIslandWindow',
]);
const MIN_WINDOW_WIDTH = 260;
/** Espacio libre que necesita por encima de una ventana para que se la vea entera. */
const HEADROOM = 130;
/** Margen a los lados al andar por encima de una ventana. */
const PERCH_MARGIN = 30;
const NOTE_W = 200;
const NOTE_H = 160;
const NOTE_MAX_CHARS = 140;
/** Tiempo entre el aviso ("¡A que no me encuentras!") y esconderse. */
const HIDE_DELAY_MS = 1800;
const SAY_DELAY_MS = 450;

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];
const sameRect = (a: Win32Rect, b: Win32Rect) =>
  Math.abs(a.left - b.left) <= 2 && Math.abs(a.top - b.top) <= 2 && Math.abs(a.right - b.right) <= 2 && Math.abs(a.bottom - b.bottom) <= 2;

/** Tu ventana activa, si es una en la que se puede hacer algo (no el escritorio ni una maximizada). */
interface TargetWindow {
  hwnd: bigint;
  /** Píxeles físicos (para ver si la mueves). */
  raw: Win32Rect;
  /** DIP (coordenadas de Electron). */
  rect: Rect;
  display: DisplayInfo;
}

/**
 * Travesuras cuando está cabreada: con tu música, esconderse, sentarse encima de tu ventana o dejarte
 * post-its pasivo-agresivos. Como mucho una cada X minutos, solo si estás delante y fuera de los modos seguros.
 */
export class Mischief {
  private running = false;
  private hidden: { until: number; window: TargetWindow | null } | null = null;
  private perched: { until: number; window: TargetWindow } | null = null;
  private pendingHide: NodeJS.Timeout | null = null;
  private seq = 0;

  constructor(private d: Deps) {}

  private get cfg() {
    return this.d.game.config.stats.travesuras;
  }

  private say(key: string, anim = 'mischief', sound?: string): void {
    this.d.game.say({ anim, sound, bubble: this.d.i18n.bubble(key) });
  }

  /** Se llama varias veces por segundo. */
  tick(): void {
    this.tickHidden();
    this.tickPerch();
    const g = this.d.game;
    if (this.running || this.hidden || this.perched || this.pendingHide) return;
    if (!g.canMischief() || !this.d.userActive() || this.d.busy()) return;
    void this.run(false);
  }

  /** Hace una travesura. `welcome` = la de bienvenida (no espera al tiempo entre travesuras). */
  async run(welcome: boolean): Promise<boolean> {
    const g = this.d.game;
    if (this.running || g.quiet || !this.d.userActive() || this.d.busy()) return false;
    if (!welcome && !g.canMischief()) return false;
    this.running = true;
    try {
      // Por orden aleatorio según los pesos: si una no se puede (no hay música, no hay ventana...), la siguiente.
      for (const kind of this.order()) {
        if (await this.attempt(kind, welcome)) {
          g.markMischief();
          console.log(`[travesura] ${kind}`);
          return true;
        }
      }
      return false;
    } catch (err) {
      console.error('[travesura] Fallida:', String(err));
      return false;
    } finally {
      this.running = false;
    }
  }

  private order(): DesktopMischief[] {
    const w = this.cfg.pesos;
    const o = this.d.overlays;
    const petFree = o.ownerId !== null && !o.hiding && !o.perch;
    const options: [DesktopMischief, number][] = [
      ['musica', this.d.music.available() ? w.musica : 0],
      ['esconderse', petFree ? w.esconderse : 0],
      ['sentarse', petFree ? w.sentarse : 0],
      ['notita', this.d.game.notes.length < this.cfg.maxNotitas ? w.notita : 0],
    ];
    const out: DesktopMischief[] = [];
    let left = options.filter(([, p]) => p > 0);
    while (left.length) {
      let r = Math.random() * left.reduce((s, [, p]) => s + p, 0);
      const chosen = left.find(([, p]) => (r -= p) < 0) ?? left[0];
      out.push(chosen[0]);
      left = left.filter((x) => x !== chosen);
    }
    return out;
  }

  private attempt(kind: DesktopMischief, welcome: boolean): Promise<boolean> | boolean {
    switch (kind) {
      case 'musica':
        return this.d.music.run(welcome);
      case 'esconderse':
        return this.hide();
      case 'sentarse':
        return this.perch();
      case 'notita':
        return this.note();
    }
  }

  /** Has tocado a la mascota (clic, caricia). Devuelve true si estaba escondida (la has encontrado). */
  onTouch(): boolean {
    if (!this.hidden || !this.d.overlays.hiding) return false;
    this.endHide('found');
    return true;
  }

  // ---------- Tu ventana ----------

  private targetWindow(): TargetWindow | null {
    const fg = foregroundInfo();
    if (!fg || SHELL_CLASSES.has(fg.className) || this.d.ownWindows().includes(fg.hwnd)) return null;
    const ws = windowState(fg.hwnd);
    if (!ws || !ws.visible || ws.minimized || ws.maximized) return null;
    const r = ws.rect;
    // Píxeles físicos → DIP.
    const rect = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
    if (rect.width < MIN_WINDOW_WIDTH) return null;
    const display = displayContaining(rect.x + rect.width / 2, rect.y + 2, this.d.overlays.availableDisplays());
    if (!display) return null;
    return { hwnd: fg.hwnd, raw: r, rect, display };
  }

  /** ¿Sigue la ventana donde estaba? (ni movida, ni minimizada, ni cerrada) */
  private windowUnchanged(w: TargetWindow): boolean {
    const ws = windowState(w.hwnd);
    return !!ws && ws.visible && !ws.minimized && sameRect(ws.rect, w.raw);
  }

  // ---------- Esconderse ----------

  private async hide(): Promise<boolean> {
    const spot = (Math.random() < 0.6 && this.windowHideSpot()) || this.screenSpot();
    if (!spot) return false;
    this.say('mischief_esconderse', 'mischief', 'risa');
    // Primero avisa y luego desaparece (si mientras tanto no ha pasado nada).
    this.pendingHide = setTimeout(() => {
      this.pendingHide = null;
      const o = this.d.overlays;
      if (o.ownerId === null || o.hiding || o.perch || this.d.game.quiet || this.d.busy()) return;
      if (spot.window && !this.windowUnchanged(spot.window)) return;
      o.hidePet(spot.displayId, spot.x, spot.y, spot.edge, spot.clip);
      this.hidden = { until: Date.now() + this.cfg.escondidaSegundos * 1000, window: spot.window };
    }, HIDE_DELAY_MS);
    return true;
  }

  private screenSpot() {
    const displays = this.d.overlays.availableDisplays();
    if (!displays.length) return null;
    const d = pick(displays);
    return { ...screenHideSpot(d), displayId: d.id, clip: undefined, window: null };
  }

  /** Detrás de tu ventana: asomando por un lado o por encima. */
  private windowHideSpot() {
    const w = this.targetWindow();
    if (!w) return null;
    const { rect: r, display: d } = w;
    const b = d.bounds;
    const bottom = Math.min(r.y + r.height, groundY(d));
    const sides: { edge: HideEdge; x: number; y: number; clip: Rect }[] = [];
    const yInside = () => r.y + 120 + Math.random() * Math.max(0, bottom - r.y - 130);
    if (bottom - r.y > 140) {
      // Por el lado izquierdo de la ventana, mirando hacia fuera (a la izquierda).
      if (r.x - b.x > 80) sides.push({ edge: 'right', x: r.x + 5, y: yInside(), clip: { x: b.x, y: b.y, width: r.x - b.x, height: b.height } });
      const right = r.x + r.width;
      if (b.x + b.width - right > 80) {
        sides.push({ edge: 'left', x: right - 5, y: yInside(), clip: { x: right, y: b.y, width: b.x + b.width - right, height: b.height } });
      }
    }
    if (r.y - b.y > HEADROOM) {
      // Por encima: se le ve media cabeza sobre la barra de título.
      const x = r.x + r.width * (0.15 + Math.random() * 0.7);
      sides.push({ edge: 'bottom', x, y: r.y + 45, clip: { x: b.x, y: b.y, width: b.width, height: r.y - b.y } });
    }
    if (!sides.length) return null;
    return { ...pick(sides), displayId: d.id, window: w };
  }

  private tickHidden(): void {
    const h = this.hidden;
    if (!h) return;
    // Ya no está escondida (la has cogido, se ha ido por una pantalla completa...).
    if (!this.d.overlays.hiding) {
      this.hidden = null;
      return;
    }
    if (h.window && !this.windowUnchanged(h.window)) this.endHide('moved');
    else if (Date.now() > h.until) this.endHide('timeout');
  }

  private endHide(how: 'found' | 'timeout' | 'moved'): void {
    this.hidden = null;
    const spot = this.d.overlays.petSpot();
    if (spot) this.d.overlays.placeOnGround(spot.displayId, clamp(spot.x, spot.minX + 60, spot.maxX - 60));
    setTimeout(() => {
      if (how === 'found') {
        this.d.game.adjust({ mosqueo: this.cfg.encontrarlaMosqueo });
        this.say('hideMischiefFound', 'angry');
      } else {
        this.say(how === 'moved' ? 'hideMischiefMoved' : 'hideMischiefTimeout', how === 'moved' ? 'angry' : 'mischief', 'risa');
      }
    }, SAY_DELAY_MS);
  }

  // ---------- Sentarse encima de tu ventana ----------

  private perch(): boolean {
    const w = this.targetWindow();
    if (!w) return false;
    const { rect: r, display: d } = w;
    const b = d.bounds;
    // Tiene que caber entera por encima y la ventana no puede estar por debajo de la barra de tareas.
    if (r.y - b.y < HEADROOM || r.y > groundY(d) - 60) return false;
    const minX = Math.max(r.x, b.x) + PERCH_MARGIN;
    const maxX = Math.min(r.x + r.width, b.x + b.width) - PERCH_MARGIN;
    if (maxX - minX < 80) return false;
    const x = minX + Math.random() * (maxX - minX);
    this.d.overlays.perchPet(d.id, x, { y: r.y + 1, minX, maxX });
    this.perched = { until: Date.now() + this.cfg.sentadaSegundos * 1000, window: w };
    setTimeout(() => this.say('mischief_sentarse', 'mischief', 'risa'), SAY_DELAY_MS);
    return true;
  }

  private tickPerch(): void {
    const p = this.perched;
    if (!p) return;
    // Ya no está arriba (la has cogido, la has mandado a casa...).
    if (!this.d.overlays.perch) {
      this.perched = null;
      return;
    }
    const fg = foregroundInfo();
    const switched = !!fg && fg.hwnd !== p.window.hwnd && !this.d.ownWindows().includes(fg.hwnd);
    if (switched || !this.windowUnchanged(p.window)) {
      // Has movido la ventana o te has ido a otra: se cae.
      this.perched = null;
      this.d.overlays.unperch();
      setTimeout(() => this.say('perchFell', 'angry', 'grunido'), 700);
    } else if (Date.now() > p.until) {
      this.perched = null;
      this.d.overlays.unperch();
    }
  }

  // ---------- Post-its ----------

  private async note(): Promise<boolean> {
    const displays = this.d.overlays.availableDisplays();
    if (!displays.length || this.d.game.notes.length >= this.cfg.maxNotitas) return false;
    // En el monitor que estás mirando (donde está el ratón).
    const c = screen.getCursorScreenPoint();
    const d = displayContaining(c.x, c.y, displays) ?? pick(displays);
    const text = ((await this.d.writeNote()) ?? this.d.i18n.bubble('noteText')).slice(0, NOTE_MAX_CHARS);
    // Mientras la IA escribía puede haber cambiado algo.
    if (this.d.game.quiet || this.d.game.notes.length >= this.cfg.maxNotitas) return false;

    const wa = d.workArea;
    let x = 0;
    let y = 0;
    for (let i = 0; i < 12; i++) {
      x = wa.x + 40 + Math.random() * Math.max(0, wa.width - NOTE_W - 80);
      y = wa.y + 40 + Math.random() * Math.max(0, wa.height - NOTE_H - 120);
      if (this.d.game.notes.every((n) => n.displayId !== d.id || Math.hypot(n.x - x, n.y - y) > NOTE_W)) break;
    }
    const note: StickyNote = {
      id: `n${Date.now().toString(36)}${(this.seq++).toString(36)}`,
      displayId: d.id,
      x: Math.round(x),
      y: Math.round(y),
      text,
      rot: Math.round((Math.random() * 2 - 1) * 6),
    };
    this.d.game.addNote(note);
    this.say('mischief_notita', 'mischief', 'risa');
    return true;
  }
}
