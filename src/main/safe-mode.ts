import { screen } from 'electron';
import { displayContaining } from '../shared/displays';
import type { DisplayInfo } from '../shared/types';
import { micInUse } from './mic';
import { foregroundInfo } from './win32';

export interface SafeState {
  /** Monitor en el que hay algo a pantalla completa (juego, vídeo, presentación). */
  fullscreenDisplayId: number | null;
  /** Programa que está usando el micrófono (llamada), o null. */
  callApp: string | null;
}

interface Deps {
  displays(): DisplayInfo[];
  /** HWND de nuestras ventanas (no cuentan como "pantalla completa"). */
  ownWindows(): bigint[];
  enabled(): { pantallaCompleta: boolean; llamadas: boolean; ignorarMicrofono: string[] };
  onChange(state: SafeState): void;
}

const FULLSCREEN_EVERY_MS = 1500;
const MIC_EVERY_MS = 8000;
/** Comprobaciones seguidas que tiene que durar la pantalla completa antes de activarse (evita parpadeos). */
const FULLSCREEN_CONFIRM = 2;
/** Ventanas del escritorio y la barra de tareas: ocupan el monitor pero no son "pantalla completa". */
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

/**
 * Modos seguros: detecta si hay algo a pantalla completa (y en qué monitor) o si estás en una llamada
 * (algún programa usando el micrófono), para que la mascota no moleste.
 */
export class SafeMode {
  state: SafeState = { fullscreenDisplayId: null, callApp: null };
  private fullscreenCandidate: number | null = null;
  private fullscreenHits = 0;
  private timers: NodeJS.Timeout[] = [];

  constructor(private d: Deps) {}

  start(): void {
    this.timers.push(setInterval(() => this.checkFullscreen(), FULLSCREEN_EVERY_MS));
    this.timers.push(setInterval(() => void this.checkMic(), MIC_EVERY_MS));
    void this.checkMic();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private set(patch: Partial<SafeState>): void {
    const next = { ...this.state, ...patch };
    if (next.fullscreenDisplayId === this.state.fullscreenDisplayId && next.callApp === this.state.callApp) return;
    this.state = next;
    this.d.onChange(next);
  }

  /** Monitor (de Electron) con algo a pantalla completa, o null. */
  detectFullscreen(): number | null {
    const fg = foregroundInfo();
    if (!fg || SHELL_CLASSES.has(fg.className) || this.d.ownWindows().includes(fg.hwnd)) return null;
    const { rect: r, monitor: m } = fg;
    const coversMonitor = r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
    if (!coversMonitor && !fg.shellFullscreen) return null;
    // El rectángulo del monitor viene en píxeles físicos; Electron trabaja en DIP.
    const dip = screen.screenToDipRect(null, { x: m.left, y: m.top, width: m.right - m.left, height: m.bottom - m.top });
    const d = displayContaining(dip.x + dip.width / 2, dip.y + dip.height / 2, this.d.displays());
    return d?.id ?? null;
  }

  private checkFullscreen(): void {
    const id = this.d.enabled().pantallaCompleta ? this.detectFullscreen() : null;
    if (id === null) {
      this.fullscreenCandidate = null;
      this.fullscreenHits = 0;
      this.set({ fullscreenDisplayId: null });
      return;
    }
    if (id !== this.fullscreenCandidate) {
      this.fullscreenCandidate = id;
      this.fullscreenHits = 0;
    }
    if (++this.fullscreenHits >= FULLSCREEN_CONFIRM) this.set({ fullscreenDisplayId: id });
  }

  /**
   * Windows anota en el registro qué programas usan el micrófono: si alguno tiene LastUsedTimeStop = 0,
   * lo está usando ahora mismo.
   */
  private async checkMic(): Promise<void> {
    const cfg = this.d.enabled();
    if (!cfg.llamadas) {
      this.set({ callApp: null });
      return;
    }
    this.set({ callApp: await micInUse(cfg.ignorarMicrofono) });
  }
}

