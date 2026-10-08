import { app, dialog, ipcMain, nativeImage, powerMonitor, protocol, shell, Tray, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { toMain, toOverlay } from '../shared/ipc';
import { readFileSync } from 'node:fs';
import type { ChatActionType, InteractionType, Lang, PanelId, ToyKind } from '../shared/types';
import { Brain } from './brain/brain';
import { Memory } from './brain/memory';
import { OllamaClient } from './brain/ollama';
import { ChatWindow } from './chat-window';
import { Minigames } from './minigames';
import { Mischief } from './mischief';
import { loadConfig, type GameConfig } from './config';
import { Game } from './game';
import { I18n } from './i18n';
import { watchDir } from './jsonfile';
import { buildPetMenu, type MenuActions } from './menu';
import { OverlayManager } from './overlays';
import { resolvePaths } from './paths';
import { loadSave, loadSettings, newSave, writeSave, writeSettings } from './save';
import { MusicWindow } from './music-window';
import { SafeMode } from './safe-mode';
import { runSetup } from './setup-window';
import { SKIN_SCHEME, SkinManager } from './skins';
import { SpotifyApi } from './spotify/api';
import { SpotifyAuth } from './spotify/auth';
import { MusicDirector, type PlayResult } from './spotify/director';

app.setName('Melochi');
app.setAppUserModelId('Melochi');
// Para pruebas: MELOCHI_USER_DATA=carpeta usa otra partida y otros ajustes.
if (process.env.MELOCHI_USER_DATA) app.setPath('userData', process.env.MELOCHI_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const INTERACTIONS: InteractionType[] = ['pet', 'tickle', 'poke', 'throw', 'throwHard'];
const TOYS: ToyKind[] = ['pelota', 'laser'];
/** Tocarla así cuenta como "encontrarla" si está escondida. */
const TOUCHES: InteractionType[] = ['poke', 'pet', 'tickle'];
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
      chatWindow.refresh();
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
      welcomeMischief: () => mischief.run(true),
      special: (name) => {
        // Juguetes físicos: se juega en la ventana de la mascota y la recompensa llega al terminar.
        if (TOYS.includes(name as ToyKind)) {
          overlays.sendToOwner(toOverlay.toy, { kind: name });
          return true;
        }
        return director.special(name);
      },
      chatter: (topic, fallback) => brain.chatter(topic, fallback),
    },
    firstRun,
  );

  // ---------- Spotify ----------

  const auth = new SpotifyAuth(join(paths.userData, 'spotify-token.bin'), () => settings.spotify.clientId);
  const api = new SpotifyApi(auth);
  const idleSeconds = () => powerMonitor.getSystemIdleTime();
  const userActive = () => idleSeconds() < game.config.music.soloSiActivoMinutos * 60;
  const director: MusicDirector = new MusicDirector(game, api, auth, i18n, settings, idleSeconds);
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

  const minigames = new Minigames({ game, i18n, overlays, director, api, auth });

  // ---------- Cerebro (IA local) y chat ----------

  const ollama = new OllamaClient(() => settings.ollama);
  const musicMoods = () =>
    game.config.moods.moods.filter((m) => m.musica?.modo === 'sugerir').map((m) => ({ id: m.id, name: i18n.loc(m.nombre, m.id) }));
  const personality = () => {
    try {
      return readFileSync(join(skins.dir, 'personality.md'), 'utf8');
    } catch {
      return 'Eres {name}, una mascota virtual cariñosa y juguetona.';
    }
  };

  /** Acciones que puede hacer cuando se lo pides en el chat. Devuelve un aviso si no ha podido. */
  const runChatAction = async (action: ChatActionType, value: string): Promise<string | null> => {
    const t = (k: string) => i18n.t('chat', k);
    const note = (r: PlayResult) => (r === 'ok' ? null : r === 'nodevice' ? t('noDevice') : r === 'nomusic' ? t('noMusic') : t('musicError'));
    const isMusic = ['play_mood', 'play_search', 'pause', 'resume', 'next'].includes(action);
    if (isMusic && !auth.connected) return t('noSpotify');
    switch (action) {
      case 'play_mood': {
        const v = value.toLowerCase();
        const mood = musicMoods().find((m) => m.id === v || m.name.toLowerCase() === v);
        if (mood) return note(await director.playMood(mood.id));
        return value ? note(await director.playSearch(value)) : t('unknownMood');
      }
      case 'play_search':
        return note(await director.playSearch(value));
      case 'pause':
      case 'next':
        // Lo que sabe de Spotify puede tener unos segundos: se pregunta antes de decir que no suena nada.
        await director.refreshNow();
        if (!director.state?.track) return t('nothingPlaying');
        return note(await director.control(action));
      case 'resume':
        return note(await director.control(action));
      case 'open_inventory':
        actions.openPanel('inventory');
        return null;
      case 'open_stats':
        actions.openPanel('stats');
        return null;
      case 'go_home':
        overlays.goHome();
        return null;
      case 'dnd': {
        const n = parseInt(value, 10);
        game.setDnd([15, 30, 60].includes(n) ? n : 30);
        return null;
      }
      default:
        return null;
    }
  };

  const brain: Brain = new Brain(ollama, new Memory(join(paths.userData, 'memory.json')), {
    lang: () => i18n.lang,
    petName: () => game.save.pet.name,
    personality,
    view: () => game.view(home()),
    mood: () => game.mood,
    musicMoods,
    spotifyConnected: () => auth.connected,
    config: () => game.config.brain,
    dndActive: () => game.quiet,
    userActive,
    act: runChatAction,
    react: (r) => overlays.sendToOwner(toOverlay.reaction, r),
    adjust: (d) => game.adjust(d),
    changed: () => chatWindow.refresh(),
    text: (k) => i18n.t('chat', k, { model: settings.ollama.model }),
    quiz: (kind) => i18n.quiz(kind),
    gameOver: (won) => {
      const fx = game.config.stats.minijuegos;
      game.adjust(won ? fx.ganar : fx.perder);
      if (won) game.rollDrop('juegoChat');
    },
  });
  director.onNewTrack = (hasOpinion) => {
    if (!hasOpinion) brain.commentSong();
  };

  const chatWindow: ChatWindow = new ChatWindow({
    paths,
    brain,
    state: () => ({
      petName: game.save.pet.name,
      moodName: i18n.loc(game.mood.nombre, game.mood.id),
      model: settings.ollama.model,
      strings: i18n.section('chat'),
    }),
    petSpot: () => overlays.petSpot(),
    display: (id) => overlays.display(id),
  });

  let aiModels: string[] = [];
  const refreshAi = async () => {
    await brain.refreshStatus();
    aiModels = await ollama.models().catch(() => []);
  };
  void refreshAi();
  setInterval(() => void refreshAi(), 30_000);

  overlays.start(save.pose);

  // ---------- Travesuras (música y escritorio) ----------

  const ownWindows = () => [
    ...overlays.nativeHandles(),
    ...BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed())
      .map((w) => w.getNativeWindowHandle().readBigUInt64LE(0)),
  ];
  const mischief: Mischief = new Mischief({
    game,
    i18n,
    overlays,
    music: { available: () => director.canMischief, run: (welcome) => director.mischief(welcome) },
    writeNote: () => brain.writeNote(),
    userActive,
    // Ni en mitad de un juego ni mientras te está contestando en el chat.
    busy: () => minigames.active !== null || !!brain.game || brain.busy,
    ownWindows,
  });

  // ---------- Modos seguros (pantalla completa y llamadas) ----------

  const safeMode = new SafeMode({
    displays: () => overlays.displays,
    ownWindows,
    enabled: () => game.config.stats.modosSeguros,
    onChange: (s) => {
      overlays.setFullscreenDisplay(s.fullscreenDisplayId);
      game.setExternalQuiet(s.callApp ? 'call' : s.fullscreenDisplayId !== null ? 'fullscreen' : null);
      console.log(`[seguro] pantalla completa: ${s.fullscreenDisplayId ?? 'no'} · llamada: ${s.callApp ?? 'no'}`);
    },
  });
  safeMode.start();

  // Acceso para depurar con --inspect (no lo usa el juego).
  if (!app.isPackaged) {
    Object.assign(globalThis, {
      __melochi: { game, overlays, skins, settings, director, api, musicWindow, brain, chatWindow, ollama, safeMode, minigames, mischief },
    });
  }

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
    openChat: () => chatWindow.open(),
    play: {
      can: (kind) => minigames.canStart(kind),
      start: (kind) => minigames.start(kind),
      canChat: () => !brain.busy && !brain.game,
      chat: (kind) => {
        chatWindow.open();
        void brain.startGame(kind);
      },
    },
    ai: {
      enabled: () => settings.ollama.enabled,
      setEnabled: (on) => {
        settings.ollama.enabled = on;
        writeSettings(paths.settings, settings);
        void refreshAi();
      },
      models: () => aiModels,
      model: () => settings.ollama.model,
      setModel: (m) => {
        settings.ollama.model = m;
        writeSettings(paths.settings, settings);
        void refreshAi();
        chatWindow.refresh();
      },
      gpu: () => settings.ollama.useGpu,
      setGpu: (on) => {
        settings.ollama.useGpu = on;
        writeSettings(paths.settings, settings);
      },
      forget: async () => {
        const { response } = await dialog.showMessageBox({
          type: 'question',
          buttons: [i18n.t('menu', 'aiForgetYes'), i18n.t('menu', 'cancel')],
          defaultId: 1,
          cancelId: 1,
          message: i18n.t('menu', 'aiForgetConfirm', { name: game.save.pet.name }),
        });
        if (response === 0) {
          brain.memory.clear();
          chatWindow.refresh();
        }
      },
    },
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
  // Un clic en la mascota durante un minijuego (pillarla haciendo trampas, encontrarla) no abre el chat.
  let suppressChatUntil = 0;
  ipcMain.on(toMain.interact, (_e, type: InteractionType) => {
    if (!INTERACTIONS.includes(type)) return;
    if ((type === 'poke' && minigames.onPoke()) || (TOUCHES.includes(type) && mischief.onTouch())) {
      suppressChatUntil = Date.now() + 1500;
      return;
    }
    game.interact(type);
  });
  ipcMain.on(toMain.dismissNote, (_e, id: string) => game.dismissNote(String(id)));
  ipcMain.on(toMain.fled, () => game.fled());
  ipcMain.on(toMain.useItem, (_e, index: number) => {
    if (Number.isInteger(index)) game.useItem(index);
  });
  ipcMain.on(toMain.collect, (_e, id: string) => game.collect(String(id)));
  ipcMain.on(toMain.choose, (_e, promptId: string, choice: string) => {
    if (!minigames.answer(String(promptId), String(choice))) void director.answer(String(promptId), String(choice));
  });
  ipcMain.on(toMain.openChat, () => {
    if (minigames.active === 'hide' || overlays.hiding || Date.now() < suppressChatUntil) return;
    chatWindow.open();
  });
  ipcMain.on(toMain.toyDone, (_e, kind: ToyKind) => {
    if (kind === 'pelota') game.interact('fetch');
    else if (kind === 'laser') game.interact('laser');
  });
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
    brain.tick();
    last = now;
  }, 1000);
  setInterval(persist, AUTOSAVE_MS);
  // Los minijuegos (sobre todo las pistas del escondite) necesitan ir algo más rápido que el bucle principal.
  setInterval(() => minigames.tick(), 400);
  // Travesuras: también algo más rápido, para notar enseguida si mueves la ventana en la que está sentada.
  setInterval(() => mischief.tick(), 400);

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
