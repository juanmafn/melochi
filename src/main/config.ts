import { join } from 'node:path';
import type { ItemDef, ItemsConfig, LootConfig, MoodsConfig, MusicConfig, StatsConfig } from '../shared/types';
import { readJson } from './jsonfile';

export interface GameConfig {
  stats: StatsConfig;
  moods: MoodsConfig;
  items: ItemsConfig;
  loot: LootConfig;
  music: MusicConfig;
  itemMap: Map<string, ItemDef>;
}

/** Carga y valida config/*.json. Lanza un error con un mensaje legible si algo no cuadra. */
export function loadConfig(dir: string): GameConfig {
  const stats = readJson<StatsConfig>(join(dir, 'stats.json'));
  const moods = readJson<MoodsConfig>(join(dir, 'moods.json'));
  const items = readJson<ItemsConfig>(join(dir, 'items.json'));
  const loot = readJson<LootConfig>(join(dir, 'loot.json'));
  const music = readJson<MusicConfig>(join(dir, 'music.json'));

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

  return { stats, moods, items, loot, music, itemMap };
}
