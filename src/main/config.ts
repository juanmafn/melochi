import { join } from 'node:path';
import type { BrainConfig, ItemDef, ItemsConfig, LootConfig, MoodsConfig, MusicConfig, StatsConfig } from '../shared/types';
import { readJson } from './jsonfile';

export interface GameConfig {
  stats: StatsConfig;
  moods: MoodsConfig;
  items: ItemsConfig;
  loot: LootConfig;
  music: MusicConfig;
  brain: BrainConfig;
  itemMap: Map<string, ItemDef>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Mezcla tu configuración sobre la original: lo tuyo manda y lo que falte (ajustes nuevos) sale de la original. */
function withDefaults<T>(user: T, defaults: unknown): T {
  if (!isObject(user) || !isObject(defaults)) return user ?? (defaults as T);
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, v] of Object.entries(user)) out[k] = k in defaults ? withDefaults(v, defaults[k]) : v;
  return out as T;
}

/**
 * Carga y valida config/*.json. Lanza un error con un mensaje legible si algo no cuadra.
 * `defaultsDir`: configuración original del programa, para rellenar lo que falte (al actualizar de versión).
 */
export function loadConfig(dir: string, defaultsDir?: string | null): GameConfig {
  const read = <T>(file: string): T => {
    const user = readJson<T>(join(dir, file));
    if (!defaultsDir) return user;
    try {
      return withDefaults(user, readJson<T>(join(defaultsDir, file)));
    } catch {
      return user;
    }
  };
  const stats = read<StatsConfig>('stats.json');
  const moods = read<MoodsConfig>('moods.json');
  const items = read<ItemsConfig>('items.json');
  const loot = read<LootConfig>('loot.json');
  const music = read<MusicConfig>('music.json');
  const brain = read<BrainConfig>('brain.json');

  if (!moods.moods?.some((m) => m.id === 'neutral')) {
    throw new Error('moods.json: falta el mood "neutral" (es el que se usa por defecto).');
  }

  const itemMap = new Map<string, ItemDef>();
  for (const item of items.items) {
    if (itemMap.has(item.id)) throw new Error(`items.json: el id "${item.id}" está repetido.`);
    itemMap.set(item.id, item);
  }

  for (const [name, table] of Object.entries(loot.tablas)) {
    for (const e of table.entradas) {
      if (!itemMap.has(e.item)) throw new Error(`loot.json: la tabla "${name}" usa el objeto "${e.item}", que no existe.`);
    }
  }
  for (const start of items.inventarioInicial) {
    if (!itemMap.has(start.item)) throw new Error(`items.json: inventarioInicial usa "${start.item}", que no existe.`);
  }

  return { stats, moods, items, loot, music, brain, itemMap };
}
