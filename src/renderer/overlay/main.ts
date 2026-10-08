import 'pixi.js/unsafe-eval';
import { Application } from 'pixi.js';
import type { OverlayApi } from '../../preload/overlay';
import type { GameView, OwnMessage, PanelId, Reaction } from '../../shared/types';
import { Input } from './input';
import { Pet } from './pet';
import { loadSkin, type LoadedSkin } from './skin';
import { SoundPlayer } from './sound';
import { Bubble, GroundItems, InventoryPanel, StatsPanel } from './ui';

declare global {
  interface Window {
    melochi: OverlayApi;
  }
}

const api = window.melochi;

async function boot(): Promise<void> {
  const init = await api.getInit();
  if (!init) return;
  const { display, displays } = init;

  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio,
    preference: 'webgl',
  });
  document.getElementById('stage')!.appendChild(app.canvas);

  const uiRoot = document.getElementById('ui')!;
  const pet = new Pet(app.stage, display, displays, api);
  const input = new Input(pet, api);
  const sound = new SoundPlayer();
  const bubble = new Bubble(uiRoot, (promptId, choiceId) => api.choose(promptId, choiceId));
  const ground = new GroundItems(uiRoot, display, (id) => api.collect(id));
  const inventory = new InventoryPanel(uiRoot, (slot) => api.useItem(slot), (x, y) => pet.hitTest(x, y));
  const stats = new StatsPanel(uiRoot);
  const panels: Record<PanelId, InventoryPanel | StatsPanel> = { inventory, stats };

  let skin: LoadedSkin | null = null;
  let view: GameView | null = null;

  async function reloadSkin(): Promise<void> {
    const manifest = await api.getSkin();
    const next = await loadSkin(manifest);
    skin?.destroy();
    skin = next;
    pet.setSkin(next);
    sound.setSkin(manifest);
    if (view) {
      ground.render(view, manifest.version, true);
      for (const p of Object.values(panels)) if (p.isOpen) p.render(view, manifest.version);
    }
  }

  // Solo se dibuja mientras la mascota está en este monitor; si no, el ticker se para para no gastar GPU.
  function updateTicker(): void {
    if (pet.needsRender && !app.ticker.started) app.ticker.start();
  }

  app.ticker.add((t) => {
    // Mientras espera tu respuesta en un bocadillo, se queda quieta para que puedas pulsar.
    if (bubble.waiting) pet.hold();
    pet.update(t.deltaMS);
    bubble.update(pet.x, pet.y - pet.height, pet.owned, window.innerWidth);
    if (!pet.needsRender) {
      app.render();
      app.ticker.stop();
    }
  });

  await reloadSkin();

  // ---------- Mensajes de main ----------

  api.on('game:state', (v: GameView) => {
    view = v;
    pet.setView(v);
    sound.volume = v.volume;
    sound.muted = v.muted || v.quiet !== null;
    const version = skin?.manifest.version ?? 0;
    ground.render(v, version);
    for (const p of Object.values(panels)) if (p.isOpen) p.render(v, version);
  });

  api.on('pet:own', (msg: OwnMessage) => {
    pet.own(msg);
    updateTicker();
  });

  api.on('pet:release', (msg: { poof: boolean }) => {
    pet.release(msg.poof);
    bubble.hide();
    for (const p of Object.values(panels)) p.close();
  });

  api.on('pet:drag', (p: { x: number; y: number }) => pet.dragTo(p.x, p.y));

  api.on('pet:throw', (p: { x: number; y: number; vx: number; vy: number }) => {
    input.dragFinished();
    pet.throwFrom(p.x, p.y, p.vx, p.vy);
  });

  api.on('pet:go-home', () => pet.goHome());

  api.on('game:reaction', (r: Reaction) => {
    if (r.anim) pet.react(r.anim, r.animMs);
    if (r.bubble) bubble.show(r.bubble, r.choices, r.promptId, r.durationMs);
    if (r.sound) sound.play(r.sound);
  });

  api.on('skin:reload', () => void reloadSkin());

  api.on('ui:panel', (msg: { panel: PanelId; open: boolean }) => openPanel(msg.panel));

  function openPanel(id: PanelId): void {
    const panel = panels[id];
    if (!panel || !view || !pet.owned) return;
    panel.render(view, skin?.manifest.version ?? 0);
    // Encima de la mascota; si ya hay otro panel abierto, a su lado.
    const other = Object.values(panels).find((p) => p !== panel && p.isOpen);
    panel.open(pet.x, pet.y - pet.height, window.innerWidth, window.innerHeight, other?.rect);
  }

  // Acceso para depurar desde las DevTools (no lo usa el juego).
  Object.assign(window, { __melochi: { pet, input, openPanel, view: () => view, skin: () => skin } });

  input.install();
  if (init.own) {
    pet.own({ pose: init.own });
    updateTicker();
  } else {
    app.ticker.stop();
  }
}

boot().catch((err) => console.error('[overlay]', err));
