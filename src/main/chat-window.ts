import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { chatChannels } from '../shared/ipc';
import type { ChatWindowState, DisplayInfo } from '../shared/types';
import type { Brain } from './brain/brain';
import type { PetSpot } from './game';
import type { Paths } from './paths';

interface Deps {
  paths: Paths;
  brain: Brain;
  /** Estado para la ventana (nombre, mood, textos...). */
  state(): Omit<ChatWindowState, 'messages' | 'busy' | 'status'>;
  petSpot(): PetSpot | null;
  display(id: number): DisplayInfo | undefined;
}

const WIDTH = 340;
const HEIGHT = 470;
const GAP = 90;

/** Ventanita de chat junto a la mascota. Es una ventana normal (la overlay no puede recibir teclado). */
export class ChatWindow {
  private win: BrowserWindow | null = null;

  constructor(private d: Deps) {
    ipcMain.handle(chatChannels.getState, () => this.state());
    ipcMain.handle(chatChannels.send, (_e, text: string) => this.d.brain.send(String(text ?? '')));
    ipcMain.on(chatChannels.close, () => this.win?.close());
  }

  get isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  private state(): ChatWindowState {
    return {
      ...this.d.state(),
      status: this.d.brain.status,
      busy: this.d.brain.busy,
      messages: this.d.brain.messages,
    };
  }

  /** Reenvía el estado a la ventana si está abierta. */
  refresh(): void {
    if (this.isOpen) this.win!.webContents.send(chatChannels.state, this.state());
  }

  /** Posición al lado de la mascota (a la izquierda si está en la mitad derecha del monitor). */
  private position(): { x: number; y: number } | null {
    const spot = this.d.petSpot();
    const d = spot && this.d.display(spot.displayId);
    if (!spot || !d) return null;
    const wa = d.workArea;
    const left = spot.x > wa.x + wa.width / 2;
    const x = left ? spot.x - GAP - WIDTH : spot.x + GAP;
    const y = spot.groundY - HEIGHT;
    return {
      x: Math.round(Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - WIDTH - 8)),
      y: Math.round(Math.max(y, wa.y + 8)),
    };
  }

  open(): void {
    void this.d.brain.refreshStatus().then(() => this.d.brain.warmUp());
    if (this.isOpen) {
      this.win!.show();
      this.win!.focus();
      return;
    }
    const pos = this.position();
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      ...(pos ?? {}),
      minWidth: 280,
      minHeight: 320,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      maximizable: false,
      show: false,
      title: 'Melochi',
      backgroundColor: '#fff7ef',
      webPreferences: {
        preload: join(this.d.paths.preload, 'chat.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.win.once('ready-to-show', () => {
      this.win?.show();
      this.win?.focus();
    });
    this.win.on('closed', () => (this.win = null));
    void this.win.loadFile(join(this.d.paths.renderer, 'chat.html'));
  }

  close(): void {
    this.win?.close();
  }
}
