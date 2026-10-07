import { app, dialog, ipcMain, nativeImage, protocol, shell, Tray, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toMain, toOverlay } from '../shared/ipc';
import type { InteractionType, Lang, PanelId } from '../shared/types';
import { loadConfig, type GameConfig } from './config';
import { Game } from './game';
import { I18n } from './i18n';
import { watchDir } from './jsonfile';
import { buildPetMenu, type MenuActions } from './menu';
import { OverlayManager } from './overlays';
import { resolvePaths } from './paths';
import { loadSave, loadSettings, newSave, writeSave, writeSettings } from './save';
import { MusicWindow } from './music-window';
import { runSetup } from './setup-window';
import { SKIN_SCHEME, SkinManager } from './skins';
import { SpotifyApi } from './spotify/api';
import { SpotifyAuth } from './spotify/auth';
import { MusicDirector } from './spotify/director';

app.setName('Melochi');
app.setAppUserModelId('Melochi');
// Para pruebas: MELOCHI_USER_DATA=carpeta usa otra partida y otros ajustes.
if (process.env.MELOCHI_USER_DATA) app.setPath('userData', process.env.MELOCHI_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const INTERACTIONS: InteractionType[] = ['pet', 'tickle', 'poke', 'throw', 'throwHard'];
const AUTOSAVE_MS = 30_000;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Mientras está la ventana de bienvenida no hay overlays: no hay que cerrar la app al cerrar ventanas.
  app.on('window-all-closed', () => {});
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Melochi', String(err?.stack ?? err));
    app.quit();
  });
}

async function start(): Promise<void> {
  const paths = resolvePaths();
  const settings = loadSettings(paths.settings, I18n.systemLang(app.getLocale()));
  const i18n = new I18n(paths.locales);
  i18n.lang = settings.lang;

  let cfg: GameConfig;
  try {
    cfg = loadConfig(paths.config);
  } catch (err) {
    dialog.showErrorBox('Melochi — config', String((err as Error).message));
    app.quit();
    return;
  }

  let save = loadSave(paths.save);
  const firstRun = !save;
  if (!save) {
    const result = await runSetup(paths, i18n);
    if (!result) {
      app.quit();
      return;
    }
    settings.lang = result.lang;
    i18n.lang = result.lang;
    save = newSave(result.name, cfg);
    writeSave(paths.save, save);
    writeSettings(paths.settings, settings);
  }

  // ---------- Piezas principales ----------

  const skins = new SkinManager(paths.skins, settings.skin, () => overlays.broadcast(toOverlay.skinReload, skins.version));
  skins.registerProtocol();
  skins.watch();

  const defaultHome = () => {
    const d = overlays.primary();
    return { displayId: d.id, x: d.workArea.x + d.workArea.width - 150 };
  };
  const home = () => (settings.home && overlays.display(settings.home.displayId) ? settings.home : defaultHome());

  const overlays: OverlayManager = new OverlayManager(paths, {
    home,
    skinVersion: () => skins.version,
    thrown: (type) => game.interact(type),
  });

  let statePending = false;
  const pushState = () => {
    if (statePending) return;
    statePending = true;
    setImmediate(() => {
      statePending = false;
      overlays.broadcast(toOverlay.state, game.view(home()));
    });
  };

  const game: Game = new Game(
    cfg,
    i18n,
    save,
    settings,
    {
      changed: pushState,
      react: (r) => overlays.sendToOwner(toOverlay.reaction, r),
      petSpot: () => overlays.petSpot(),
      moodChanged: (mood) => director.onMoodChanged(mood),
      welcomeMischief: () => director.mischief(true),
      special: (name) => director.special(name),
    },
    firstRun,
  );

  // ---------- Spotify ----------

  const auth = new SpotifyAuth(join(paths.userData, 'spotify-token.bin'), () => settings.spotify.clientId);
  const api = new SpotifyApi(auth);
  const director: MusicDirector = new MusicDirector(game, api, auth, i18n, settings);
  const musicWindow = new MusicWindow({
    paths,
    i18n,
    settings,
    game,
    auth,
    api,
    director,
    saveSettings: () => writeSettings(paths.settings, settings),
  });

  overlays.start(save.pose);
  // Acceso para depurar con --inspect (no lo usa el juego).
  if (!app.isPackaged) Object.assign(globalThis, { __melochi: { game, overlays, skins, settings, director, api, musicWindow } });

  const persist = () => {
    const spot = overlays.petSpot();
    if (spot) game.save.pose = { displayId: spot.displayId, x: overlays.pose.x, y: overlays.pose.y };
    writeSave(paths.save, game.save);
    writeSettings(paths.settings, settings);
  };

  // ---------- Menú y bandeja ----------

  const actions: MenuActions = {
    openPanel: (panel: PanelId) => overlays.sendToOwner(toOverlay.panel, { panel, open: true }),
    openMusic: () => musicWindow.open(),
    setDnd: (min) => game.setDnd(min),
    goHome: () => overlays.goHome(),
    setHomeHere: () => {
      const spot = overlays.petSpot();
      if (spot) settings.home = { displayId: spot.displayId, x: spot.x };
      writeSettings(paths.settings, settings);
      pushState();
    },
    setLang: (lang: Lang) => {
      settings.lang = lang;
      i18n.lang = lang;
      writeSettings(paths.settings, settings);
      pushState();
    },
    setMuted: (muted) => {
      settings.muted = muted;
      writeSettings(paths.settings, settings);
      pushState();
    },
    selectSkin: (id) => {
      settings.skin = id;
      skins.select(id);
      writeSettings(paths.settings, settings);
    },
    listSkins: () => skins.list(),
    currentSkin: () => skins.id,
    openSkinsFolder: () => void shell.openPath(paths.skins),
    openConfigFolder: () => void shell.openPath(paths.config),
    reloadSkin: () => skins.bump(),
    quit: () => app.quit(),
  };

  const trayIcon = nativeImage.createFromPath(join(skins.dir, 'icon.png'));
  const tray = new Tray(trayIcon.isEmpty() ? nativeImage.createEmpty() : trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip(`Melochi — ${save.pet.name}`);
  tray.on('click', () => tray.popUpContextMenu(buildPetMenu(i18n, settings, actions)));
  tray.on('right-click', () => tray.popUpContextMenu(buildPetMenu(i18n, settings, actions)));

  // ---------- IPC del juego ----------

  ipcMain.handle(toMain.getSkin, () => skins.manifest());
  ipcMain.on(toMain.interact, (_e, type: InteractionType) => {
    if (INTERACTIONS.includes(type)) game.interact(type);
  });
  ipcMain.on(toMain.useItem, (_e, index: number) => {
    if (Number.isInteger(index)) game.useItem(index);
  });
  ipcMain.on(toMain.collect, (_e, id: string) => game.collect(String(id)));
  ipcMain.on(toMain.choose, (_e, promptId: string, choice: string) => void director.answer(String(promptId), String(choice)));
  ipcMain.on(toMain.contextMenu, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    // Windows solo cierra un menú al hacer clic fuera si su ventana tiene el foco.
    // La overlay no es "focusable" para no robarte el foco, así que se le da solo mientras el menú está abierto.
    win.setFocusable(true);
    win.focus();
    buildPetMenu(i18n, settings, actions).popup({
      window: win,
      callback: () => {
        if (win.isDestroyed()) return;
        win.setFocusable(false);
        win.blur();
      },
    });
  });

  // ---------- Bucle, guardado y recarga en caliente ----------

  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    game.tick(now - last);
    director.tick();
    last = now;
  }, 1000);
  setInterval(persist, AUTOSAVE_MS);

  watchDir(paths.config, () => {
    try {
      cfg = loadConfig(paths.config);
      game.setConfig(cfg);
      console.log('[config] Recargada.');
    } catch (err) {
      console.error('[config] Error, se mantiene la anterior:', (err as Error).message);
    }
  });
  if (!app.isPackaged) {
    watchDir(paths.locales, () => {
      try {
        i18n.reload();
        pushState();
      } catch (err) {
        console.error('[i18n] Error al recargar:', (err as Error).message);
      }
    });
  }

  app.on('before-quit', () => {
    persist();
    overlays.destroy();
    tray.destroy();
  });

  pushState();
}
