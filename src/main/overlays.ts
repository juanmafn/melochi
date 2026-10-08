import { BrowserWindow, ipcMain, screen, type Display, type WebContents } from 'electron';
import { join } from 'node:path';
import { clamp, displayContaining, groundY } from '../shared/displays';
import { toMain, toOverlay } from '../shared/ipc';
import type { DisplayInfo, HideEdge, InteractionType, OverlayInit, OwnMessage, PerchInfo, PetPose, Rect } from '../shared/types';
import type { PetSpot } from './game';
import type { Paths } from './paths';
import { isPrimaryMouseDown } from './win32';

interface OverlayHooks {
  home(): { displayId: number; x: number };
  skinVersion(): number;
  /** La mascota ha sido lanzada (al soltarla tras arrastrar). */
  thrown(type: InteractionType): void;
}

interface DragState {
  offX: number;
  offY: number;
  samples: { x: number; y: number; t: number }[];
  timer: NodeJS.Timeout;
  startedAt: number;
  sawButtonDown: boolean;
}

const DRAG_INTERVAL_MS = 16;
const THROW_SPEED = 500;
const THROW_HARD_SPEED = 1800;
const MAX_THROW_SPEED = 3500;

function toInfo(d: Display, primaryId: number): DisplayInfo {
  return { id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === primaryId };
}

/**
 * Una ventana transparente por monitor. La mascota "pertenece" a una sola ventana a la vez, que la anima.
 * Al cruzar a otro monitor (andando, cayendo o arrastrada) se traspasa a la ventana de ese monitor.
 */
export class OverlayManager {
  displays: DisplayInfo[] = [];
  ownerId: number | null = null;
  pose!: PetPose;
  private windows = new Map<number, BrowserWindow>();
  private ready = new Set<number>();
  private drag: DragState | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  /** Monitor con algo a pantalla completa: su ventana se oculta y la mascota no entra. */
  private hiddenDisplay: number | null = null;
  /** Está escondida (asomando por un borde o por detrás de una ventana). */
  hiding = false;
  /** Está encima de una ventana (ese es su suelo). */
  perch: PerchInfo | null = null;

  constructor(
    private paths: Paths,
    private hooks: OverlayHooks,
  ) {}

  start(initial?: { displayId: number; x: number; y: number }): void {
    this.refreshDisplays();
    this.placeInitialPet(initial);
    for (const d of this.displays) this.createWindow(d);
    this.registerIpc();
    const schedule = () => {
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => this.rebuild(), 500);
    };
    screen.on('display-added', schedule);
    screen.on('display-removed', schedule);
    screen.on('display-metrics-changed', schedule);
  }

  // ---------- Monitores y ventanas ----------

  private refreshDisplays(): void {
    const primaryId = screen.getPrimaryDisplay().id;
    this.displays = screen.getAllDisplays().map((d) => toInfo(d, primaryId));
  }

  display(id: number): DisplayInfo | undefined {
    return this.displays.find((d) => d.id === id);
  }

  primary(): DisplayInfo {
    return this.displays.find((d) => d.primary) ?? this.displays[0];
  }

  private placeInitialPet(initial?: { displayId: number; x: number; y: number }): void {
    const d = initial && this.display(initial.displayId);
    if (d && initial) {
      this.ownerId = d.id;
      this.pose = this.restingPose(d, initial.x, Math.min(initial.y, groundY(d)));
      return;
    }
    const home = this.hooks.home();
    const hd = this.display(home.displayId) ?? this.primary();
    this.ownerId = hd.id;
    this.pose = this.restingPose(hd, home.x, groundY(hd));
  }

  private restingPose(d: DisplayInfo, x: number, y: number): PetPose {
    const b = d.bounds;
    return {
      x: clamp(x, b.x + 40, b.x + b.width - 40),
      y: clamp(y, b.y + 40, groundY(d)),
      vx: 0,
      vy: 0,
      state: y < groundY(d) - 1 ? 'fall' : 'idle',
      facing: 1,
      goal: null,
    };
  }

  private createWindow(d: DisplayInfo): void {
    const win = new BrowserWindow({
      ...d.bounds,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // No roba el foco a tus aplicaciones al hacer clic en la mascota.
      focusable: false,
      hasShadow: false,
      thickFrame: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(this.paths.preload, 'overlay.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    // Con monitores de distinto escalado, fijar los límites tras crearla evita que salga mal dimensionada.
    win.setBounds(d.bounds);
    win.loadFile(join(this.paths.renderer, 'overlay.html'));
    win.once('ready-to-show', () => {
      if (d.id === this.hiddenDisplay) return;
      win.showInactive();
      // En Windows, si se llama antes de mostrar la ventana, se pierde: hay que hacerlo después.
      win.setIgnoreMouseEvents(true, { forward: true });
    });
    win.webContents.on('did-start-loading', () => this.ready.delete(d.id));
    win.on('closed', () => {
      this.windows.delete(d.id);
      this.ready.delete(d.id);
    });
    this.windows.set(d.id, win);
  }

  private rebuild(): void {
    this.cancelDrag();
    this.refreshDisplays();
    for (const win of this.windows.values()) win.destroy();
    this.windows.clear();
    this.ready.clear();

    const owner = this.ownerId !== null ? this.display(this.ownerId) : undefined;
    if (owner) this.pose = this.restingPose(owner, this.pose.x, this.pose.y);
    else this.placeInitialPet();
    for (const d of this.displays) this.createWindow(d);
  }

  destroy(): void {
    this.cancelDrag();
    for (const win of this.windows.values()) win.destroy();
  }

  private idFor(sender: WebContents): number | undefined {
    for (const [id, win] of this.windows) if (!win.isDestroyed() && win.webContents === sender) return id;
    return undefined;
  }

  windowFor(id: number): BrowserWindow | undefined {
    return this.windows.get(id);
  }

  send(id: number, channel: string, payload?: unknown): void {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed() && this.ready.has(id)) win.webContents.send(channel, payload);
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const id of this.windows.keys()) this.send(id, channel, payload);
  }

  sendToOwner(channel: string, payload?: unknown): void {
    if (this.ownerId !== null) this.send(this.ownerId, channel, payload);
  }

  // ---------- Propiedad de la mascota ----------

  private setOwner(displayId: number, pose: PetPose, extra: Omit<OwnMessage, 'pose'> = {}): void {
    const prev = this.ownerId;
    this.ownerId = displayId;
    this.pose = pose;
    this.hiding = !!extra.hide;
    this.perch = extra.perch ?? null;
    if (prev !== null && prev !== displayId) this.send(prev, toOverlay.release, { poof: extra.appear === 'poof' });
    this.send(displayId, toOverlay.own, { pose, ...extra } satisfies OwnMessage);
  }

  petSpot(): PetSpot | null {
    const d = this.ownerId !== null ? this.display(this.ownerId) : undefined;
    if (!d) return null;
    return { displayId: d.id, x: this.pose.x, groundY: groundY(d), minX: d.bounds.x, maxX: d.bounds.x + d.bounds.width };
  }

  goHome(): void {
    // Si está encima de una ventana, primero se baja de un salto.
    if (this.perch) this.unperch(true);
    else this.sendToOwner(toOverlay.goHome);
  }

  /** Se baja de la ventana en la que está subida (cae al suelo) y, si `home`, luego se va a casa. */
  unperch(home = false): void {
    if (!this.perch) return;
    this.perch = null;
    this.sendToOwner(toOverlay.unperch, { home });
  }

  /** Se sube encima de una ventana: aparece en x (global) sobre `perch.y`. */
  perchPet(displayId: number, x: number, perch: PerchInfo): void {
    this.cancelDrag();
    const pose: PetPose = { x, y: perch.y, vx: 0, vy: 0, state: 'idle', facing: Math.random() < 0.5 ? -1 : 1, goal: null };
    this.setOwner(displayId, pose, { appear: 'poof', perch });
  }

  teleportHome(): void {
    const home = this.hooks.home();
    let d = this.display(home.displayId) ?? this.primary();
    let x = home.x;
    // Si su casa está en el monitor a pantalla completa, espera en otro.
    if (d.id === this.hiddenDisplay) {
      const other = this.displays.find((o) => o.id !== this.hiddenDisplay);
      if (!other) return;
      d = other;
      x = d.workArea.x + d.workArea.width - 150;
    }
    this.setOwner(d.id, this.restingPose(d, x, groundY(d)), { appear: 'poof' });
  }

  /** Monitores donde puede estar la mascota ahora (todos menos el que está a pantalla completa). */
  availableDisplays(): DisplayInfo[] {
    return this.displays.filter((d) => d.id !== this.hiddenDisplay);
  }

  /**
   * Esconde a la mascota asomando por un borde (escondite). (x, y) globales del punto de apoyo.
   * `clip`: zona (global) en la que se la ve, para que parezca que está detrás de una ventana.
   */
  hidePet(displayId: number, x: number, y: number, edge: HideEdge, clip?: Rect): void {
    this.cancelDrag();
    const pose: PetPose = { x, y, vx: 0, vy: 0, state: 'idle', facing: edge === 'right' ? -1 : 1, goal: null };
    this.setOwner(displayId, pose, { appear: 'poof', hide: edge, ...(clip ? { hideClip: clip } : {}) });
  }

  /** Pone a la mascota en el suelo de un monitor, en x (global), con efecto de aparición. */
  placeOnGround(displayId: number, x: number): void {
    const d = this.display(displayId) ?? this.primary();
    this.setOwner(d.id, this.restingPose(d, x, groundY(d)), { appear: 'poof' });
  }

  /** HWND de las ventanas overlay (para no confundirlas con una aplicación a pantalla completa). */
  nativeHandles(): bigint[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed()).map((w) => w.getNativeWindowHandle().readBigUInt64LE(0));
  }

  /**
   * Hay algo a pantalla completa en un monitor (o ya no, si es null): se oculta su ventana para no taparlo
   * y, si la mascota estaba ahí, se va a otro monitor. Si no hay otro, espera escondida.
   */
  setFullscreenDisplay(id: number | null): void {
    if (id === this.hiddenDisplay) return;
    const prev = this.hiddenDisplay;
    this.hiddenDisplay = id;

    if (prev !== null) {
      const w = this.windows.get(prev);
      if (w && !w.isDestroyed()) {
        w.showInactive();
        w.setAlwaysOnTop(true, 'screen-saver');
        w.setIgnoreMouseEvents(true, { forward: true });
      }
    }
    if (id === null) return;

    this.windows.get(id)?.hide();
    if (this.ownerId === id) {
      this.cancelDrag();
      const other = this.displays.find((d) => d.id !== id);
      if (other) {
        const home = this.hooks.home();
        const x = home.displayId === other.id ? home.x : other.workArea.x + other.workArea.width - 150;
        this.setOwner(other.id, this.restingPose(other, x, groundY(other)), { appear: 'poof' });
      }
    }
  }

  // ---------- Arrastrar y lanzar ----------

  private startDrag(displayId: number, offX: number, offY: number): void {
    if (this.ownerId !== displayId) return;
    this.cancelDrag();
    // Al cogerla, deja de estar escondida o subida a una ventana.
    this.hiding = false;
    this.perch = null;
    this.drag = {
      offX,
      offY,
      samples: [],
      timer: setInterval(() => this.dragStep(), DRAG_INTERVAL_MS),
      startedAt: Date.now(),
      sawButtonDown: false,
    };
  }

  private dragStep(): void {
    const drag = this.drag;
    if (!drag) return;
    const cursor = screen.getCursorScreenPoint();
    const x = cursor.x - drag.offX;
    const y = cursor.y - drag.offY;
    const now = Date.now();
    drag.samples.push({ x, y, t: now });
    if (drag.samples.length > 12) drag.samples.shift();

    const over = displayContaining(cursor.x, cursor.y, this.displays);
    if (over && over.id !== this.ownerId && over.id !== this.hiddenDisplay) {
      this.setOwner(over.id, { ...this.pose, x, y, vx: 0, vy: 0, state: 'idle', goal: null }, { dragging: true });
    }
    this.pose = { ...this.pose, x, y };
    this.sendToOwner(toOverlay.drag, { x, y });

    // Respaldo por si el renderer no recibe el "soltar" (p. ej. al soltar sobre otro monitor).
    const down = isPrimaryMouseDown();
    if (down) drag.sawButtonDown = true;
    if (down === false && (drag.sawButtonDown || now - drag.startedAt > 150)) this.endDrag();
  }

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    clearInterval(drag.timer);
    this.drag = null;

    const last = drag.samples[drag.samples.length - 1];
    const first = drag.samples.find((s) => last && last.t - s.t <= 100) ?? last;
    let vx = 0;
    let vy = 0;
    if (last && first && last.t > first.t) {
      const dt = (last.t - first.t) / 1000;
      vx = (last.x - first.x) / dt;
      vy = (last.y - first.y) / dt;
      const speed = Math.hypot(vx, vy);
      if (speed > MAX_THROW_SPEED) {
        vx *= MAX_THROW_SPEED / speed;
        vy *= MAX_THROW_SPEED / speed;
      }
    }
    const pos = last ?? this.pose;
    this.pose = { ...this.pose, x: pos.x, y: pos.y, vx, vy, state: 'fall' };
    this.sendToOwner(toOverlay.throw, { x: pos.x, y: pos.y, vx, vy });

    const speed = Math.hypot(vx, vy);
    if (speed > THROW_HARD_SPEED) this.hooks.thrown('throwHard');
    else if (speed > THROW_SPEED) this.hooks.thrown('throw');
  }

  private cancelDrag(): void {
    if (this.drag) clearInterval(this.drag.timer);
    this.drag = null;
  }

  // ---------- IPC ----------

  private registerIpc(): void {
    ipcMain.handle(toMain.getInit, (e): OverlayInit | null => {
      const id = this.idFor(e.sender);
      const display = id !== undefined ? this.display(id) : undefined;
      if (id === undefined || !display) return null;
      this.ready.add(id);
      return {
        display,
        displays: this.displays,
        skinVersion: this.hooks.skinVersion(),
        own: this.ownerId === id ? this.pose : null,
      };
    });

    ipcMain.on(toMain.setIgnoreMouse, (e, ignore: boolean) => {
      BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(ignore, { forward: true });
    });

    ipcMain.on(toMain.handoff, (e, pose: PetPose, targetId: number) => {
      const from = this.idFor(e.sender);
      if (from === undefined || from !== this.ownerId || this.drag || !this.windows.has(targetId)) return;
      if (targetId === this.hiddenDisplay) {
        // Ese monitor está a pantalla completa: se da la vuelta y se queda donde estaba.
        const d = this.display(from)!;
        const toRight = this.display(targetId)!.bounds.x > d.bounds.x;
        const x = toRight ? d.bounds.x + d.bounds.width : d.bounds.x;
        this.setOwner(from, { ...this.restingPose(d, x, groundY(d)), facing: toRight ? -1 : 1 });
        return;
      }
      this.setOwner(targetId, pose);
    });

    ipcMain.on(toMain.reportPose, (e, pose: PetPose) => {
      if (this.idFor(e.sender) === this.ownerId && !this.drag) this.pose = pose;
    });

    ipcMain.on(toMain.dragStart, (e, offX: number, offY: number) => {
      const id = this.idFor(e.sender);
      if (id !== undefined) this.startDrag(id, offX, offY);
    });

    ipcMain.on(toMain.dragEnd, () => this.endDrag());

    ipcMain.on(toMain.teleportHome, (e) => {
      if (this.idFor(e.sender) === this.ownerId) this.teleportHome();
    });
  }
}
