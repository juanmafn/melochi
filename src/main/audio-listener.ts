import { BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { audioChannels } from '../shared/ipc';
import type { AudioStatus } from '../shared/types';
import type { Paths } from './paths';

interface Hooks {
  /** Golpe de ritmo (solo mientras hay música). */
  beat(periodMs: number): void;
  status(s: AudioStatus): void;
}

const PARTITION = 'melochi-audio';
const SILENT: AudioStatus = { music: false, bpm: 0, confidence: 0, level: 0 };

/**
 * Escucha el audio del PC (lo que suena por los altavoces, de cualquier programa) en una ventana oculta,
 * para sacar el ritmo. Solo se analiza en memoria: no se graba nada.
 */
export class AudioListener {
  status: AudioStatus = SILENT;
  private win: BrowserWindow | null = null;
  private active = false;
  private starting = false;
  private lastError = '';

  constructor(
    private paths: Paths,
    private hooks: Hooks,
  ) {
    // Solo esta ventana (su propia sesión) puede capturar, y solo se queda con el audio del sistema.
    session.fromPartition(PARTITION).setDisplayMediaRequestHandler((_req, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    });
    ipcMain.on(audioChannels.beat, (e, periodMs: number) => {
      if (this.isOurs(e.sender) && this.active && this.status.music) this.hooks.beat(Number(periodMs));
    });
    ipcMain.on(audioChannels.status, (e, s: AudioStatus) => {
      if (!this.isOurs(e.sender)) return;
      this.status = this.active ? s : SILENT;
      this.hooks.status(this.status);
    });
    ipcMain.on(audioChannels.error, (e, msg: string) => {
      if (!this.isOurs(e.sender) || msg === this.lastError) return;
      this.lastError = msg;
      console.warn('[audio]', msg);
    });
  }

  private isOurs(sender: Electron.WebContents): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.webContents === sender;
  }

  /** Empieza o deja de escuchar (en los modos seguros, si no estás delante o si está desactivado). */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) void this.start();
    else {
      if (this.win && !this.win.isDestroyed()) this.win.webContents.send(audioChannels.stop);
      this.status = SILENT;
      this.hooks.status(SILENT);
    }
  }

  private async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      if (!this.win || this.win.isDestroyed()) {
        this.win = new BrowserWindow({
          show: false,
          width: 200,
          height: 100,
          skipTaskbar: true,
          webPreferences: {
            preload: join(this.paths.preload, 'audio.js'),
            partition: PARTITION,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // Oculta y sin "gesto" del usuario tiene que poder analizar audio sin que Chromium la frene.
            backgroundThrottling: false,
            autoplayPolicy: 'no-user-gesture-required',
          },
        });
        this.win.on('closed', () => (this.win = null));
        await this.win.loadFile(join(this.paths.renderer, 'audio.html'));
      }
      // Puede haberse desactivado mientras cargaba.
      if (!this.active) return;
      // getDisplayMedia necesita un "gesto de usuario": se le da al ejecutarlo desde main.
      const r = await this.win.webContents.executeJavaScript('window.__startCapture()', true);
      if (r !== 'ok') console.warn('[audio] No se ha podido empezar a escuchar:', r);
      else if (!this.active) this.win.webContents.send(audioChannels.stop);
      else console.log('[audio] Escuchando el ritmo.');
    } catch (err) {
      console.warn('[audio] Error al empezar:', String(err));
    } finally {
      this.starting = false;
    }
  }

  destroy(): void {
    this.win?.destroy();
  }
}
