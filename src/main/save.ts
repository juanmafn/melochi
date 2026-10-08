import { existsSync } from 'node:fs';
import type { GroundItem, InventorySlot, Lang, StatId, Stats } from '../shared/types';
import type { GameConfig } from './config';
import { readJson, writeJson } from './jsonfile';

export interface SaveData {
  version: 1;
  pet: {
    name: string;
    createdAt: number;
    favoritos: string[];
    odiados: string[];
    /** Su jugada favorita en piedra-papel-tijera (la repite más). */
    rpsFav?: 'rock' | 'paper' | 'scissors';
  };
  stats: Stats;
  afinidad: number;
  mood: string;
  inventory: InventorySlot[];
  groundItems: GroundItem[];
  /** id del objeto → momento (ms) en que se puede volver a usar. */
  cooldowns: Record<string, number>;
  /** stat → momento (ms) hasta el que no baja. */
  congelados: Partial<Record<StatId, number>>;
  /** Última posición conocida de la mascota. */
  pose?: { displayId: number; x: number; y: number };
  /** Momentos en los que se activó "No molestar" (para detectar abusos). */
  dndLog: number[];
  lastSavedAt: number;
}

export interface Settings {
  lang: Lang;
  skin: string;
  home?: { displayId: number; x: number };
  volume: number;
  muted: boolean;
  dndUntil: number;
  spotify: SpotifySettings;
  ollama: OllamaSettings;
}

export interface OllamaSettings {
  enabled: boolean;
  host: string;
  /** Modelo de Ollama (p. ej. "qwen3:4b"). */
  model: string;
  /** false = solo CPU (num_gpu: 0), para no ocupar la tarjeta gráfica. Por defecto, GPU (si Ollama la detecta). */
  useGpu: boolean;
}

export interface SpotifySettings {
  /** Client ID de la app creada en el panel de desarrolladores de Spotify. */
  clientId?: string;
  /** Playlists asignadas a cada mood desde la ventana de Música. */
  playlists: Record<string, { uri: string; name: string }[]>;
}

export function loadSave(path: string): SaveData | null {
  if (!existsSync(path)) return null;
  try {
    return readJson<SaveData>(path);
  } catch (err) {
    console.error('[save] Partida corrupta, se ignora:', err);
    return null;
  }
}

export function loadSettings(path: string, defaultLang: Lang): Settings {
  const defaults: Settings = {
    lang: defaultLang,
    skin: 'placeholder',
    volume: 0.6,
    muted: false,
    dndUntil: 0,
    spotify: { playlists: {} },
    ollama: { enabled: true, host: 'http://127.0.0.1:11434', model: 'qwen3:8b', useGpu: true },
  };
  if (!existsSync(path)) return defaults;
  try {
    const loaded = readJson<Partial<Settings>>(path);
    return {
      ...defaults,
      ...loaded,
      spotify: { ...defaults.spotify, ...loaded.spotify },
      ollama: { ...defaults.ollama, ...loaded.ollama },
    };
  } catch {
    return defaults;
  }
}

export function writeSave(path: string, save: SaveData): void {
  save.lastSavedAt = Date.now();
  writeJson(path, save);
}

export function writeSettings(path: string, settings: Settings): void {
  writeJson(path, settings);
}

function pickRandom<T>(list: T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

export function newSave(name: string, cfg: GameConfig): SaveData {
  // Favoritos y odiados: solo comida y bebida no épicas, para que sean objetos que se ven a menudo.
  const candidates = cfg.items.items
    .filter((i) => (i.categoria === 'comida' || i.categoria === 'bebida') && i.rareza !== 'epica')
    .map((i) => i.id);
  const favoritos = pickRandom(candidates, 2);
  const odiados = pickRandom(
    candidates.filter((id) => !favoritos.includes(id)),
    1,
  );

  return {
    version: 1,
    pet: { name, createdAt: Date.now(), favoritos, odiados },
    stats: { hambre: 80, sed: 80, diversion: 70, carino: 70, mosqueo: 0 },
    afinidad: 0,
    mood: 'neutral',
    inventory: cfg.items.inventarioInicial.map((s) => {
      const def = cfg.itemMap.get(s.item)!;
      return { item: s.item, cantidad: s.cantidad, ...(def.usos ? { usosRestantes: def.usos } : {}) };
    }),
    groundItems: [],
    cooldowns: {},
    congelados: {},
    dndLog: [],
    lastSavedAt: Date.now(),
  };
}
