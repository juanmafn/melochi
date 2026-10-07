import { BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { musicChannels } from '../shared/ipc';
import type { MusicWindowState, PlaylistRef } from '../shared/types';
import type { Game } from './game';
import type { I18n } from './i18n';
import type { Paths } from './paths';
import type { Settings } from './save';
import type { SpotifyApi } from './spotify/api';
import { REDIRECT_URI, type SpotifyAuth } from './spotify/auth';
import type { MusicDirector } from './spotify/director';

interface Deps {
  paths: Paths;
  i18n: I18n;
  settings: Settings;
  game: Game;
  auth: SpotifyAuth;
  api: SpotifyApi;
  director: MusicDirector;
  saveSettings(): void;
}

const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;

/** Ventana de ajustes de música: conexión con Spotify y playlists de cada mood. */
export class MusicWindow {
  private win: BrowserWindow | null = null;
  private library: PlaylistRef[] = [];
  private user: string | null = null;
  private error: string | null = null;

  constructor(private d: Deps) {
    this.registerIpc();
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 600,
      height: 760,
      minWidth: 480,
      minHeight: 500,
      autoHideMenuBar: true,
      title: 'Melochi — Música',
      show: false,
      backgroundColor: '#fff7ef',
      webPreferences: {
        preload: join(this.d.paths.preload, 'music.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.win.once('ready-to-show', () => this.win?.show());
    this.win.on('closed', () => (this.win = null));
    void this.win.loadFile(join(this.d.paths.renderer, 'music.html'));
  }

  private async state(refresh = false): Promise<MusicWindowState> {
    const { auth, api, game, settings, i18n } = this.d;
    if (auth.connected && (refresh || !this.user)) {
      try {
        this.user = (await api.me()).name;
        this.library = await api.playlists();
        this.error = null;
      } catch (err) {
        this.error = String(err);
      }
    }
    if (!auth.connected) {
      this.user = null;
      this.library = [];
    }
    const cfg = game.config;
    return {
      connected: auth.connected,
      user: this.user,
      clientId: settings.spotify.clientId ?? '',
      redirectUri: REDIRECT_URI,
      moods: cfg.moods.moods
        .filter((m) => m.musica?.modo === 'sugerir')
        .map((m) => ({
          id: m.id,
          nombre: i18n.loc(m.nombre, m.id),
          playlists: settings.spotify.playlists[m.id] ?? [],
          busqueda: m.musica?.busqueda ?? [],
        })),
      library: this.library,
      favoritos: cfg.music.artistasFavoritos,
      odiados: cfg.music.artistasOdiados,
      strings: i18n.section('music'),
      error: this.error,
    };
  }

  private registerIpc(): void {
    const { auth, director, settings } = this.d;

    ipcMain.handle(musicChannels.getState, (_e, refresh?: boolean) => this.state(!!refresh));

    ipcMain.handle(musicChannels.setClientId, (_e, id: string) => {
      const clean = String(id ?? '').trim();
      if (clean && !CLIENT_ID_RE.test(clean)) return { ok: false };
      settings.spotify.clientId = clean || undefined;
      this.d.saveSettings();
      return { ok: true };
    });

    ipcMain.handle(musicChannels.connect, async () => {
      try {
        await auth.login();
        this.error = null;
        void director.poll(true);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        this.error = msg.includes('EADDRINUSE') ? 'PORT_IN_USE' : msg;
      }
      return this.state(true);
    });

    ipcMain.handle(musicChannels.disconnect, () => {
      auth.logout();
      return this.state();
    });

    ipcMain.handle(musicChannels.setPlaylists, (_e, moodId: string, list: PlaylistRef[]) => {
      if (typeof moodId !== 'string' || !Array.isArray(list)) return false;
      settings.spotify.playlists[moodId] = list
        .filter((p) => typeof p?.uri === 'string' && p.uri.startsWith('spotify:'))
        .map((p) => ({ uri: p.uri, name: String(p.name ?? '') }));
      this.d.saveSettings();
      return true;
    });

    ipcMain.handle(musicChannels.test, (_e, moodId: string) => director.playMood(String(moodId)));
    ipcMain.handle(musicChannels.openDashboard, () => shell.openExternal('https://developer.spotify.com/dashboard'));
    ipcMain.handle(musicChannels.openConfig, () => shell.openPath(this.d.paths.config));
  }
}
