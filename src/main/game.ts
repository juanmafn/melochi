import {
  ALL_STATS,
  VISIBLE_STATS,
  type GameView,
  type GroundItem,
  type InteractionType,
  type InventoryView,
  type ItemDef,
  type MoodDef,
  type MusicView,
  type QuietReason,
  type Reaction,
  type StatDelta,
  type StatId,
  type StatOrAffinity,
} from '../shared/types';
import { clamp } from '../shared/displays';
import type { GameConfig } from './config';
import type { I18n } from './i18n';
import { pickMood } from './mood';
import type { SaveData, Settings } from './save';

export interface PetSpot {
  displayId: number;
  /** x global de la mascota. */
  x: number;
  /** y global del suelo bajo la mascota. */
  groundY: number;
  /** Límites horizontales del monitor (globales). */
  minX: number;
  maxX: number;
}

export interface GameHooks {
  /** El estado ha cambiado: hay que reenviar la vista a los renderers. */
  changed(): void;
  /** Reacción de la mascota (animación, bocadillo, sonido) para la ventana que la muestra. */
  react(r: Reaction): void;
  /** Dónde está ahora la mascota (para soltar objetos a su lado). */
  petSpot(): PetSpot | null;
  /** Ha cambiado de mood (después de mostrar la reacción). */
  moodChanged?(mood: MoodDef): void;
  /** Travesura de bienvenida (volviste y la dejaste cabreada). Devuelve true si se ha hecho alguna. */
  welcomeMischief?(): Promise<boolean>;
  /** Efecto especial de un objeto. Devuelve true si se encarga él del bocadillo. */
  special?(name: string): boolean;
  /** Comentario espontáneo con IA. Devuelve true si se encarga él (y de usar `fallback` si falla). */
  chatter?(topic: string, fallback: Reaction): boolean;
}

const MINUTE = 60_000;
const NEED_BUBBLE_COOLDOWN = 15 * MINUTE;
const REACTION_BUBBLE_GAP = 2500;
const WELCOME_MISCHIEF_DELAY = 3500;
const LOOT_FOR: Partial<Record<InteractionType, string>> = {
  pet: 'pet',
  tickle: 'tickle',
  throw: 'throw',
  throwHard: 'throw',
};
/** Tablas de actividades directas, que se sustituyen por la de reconciliación cuando está cabreada. */
const LOOT_TABLES_INTERACTIVE: Record<string, true> = { pet: true, tickle: true, throw: true };

let groundSeq = 0;

export class Game {
  private pendingMood: { id: string; since: number } | null = null;
  private activity: { type: string; at: number }[] = [];
  private lastReactionBubble = 0;
  private lastNeedBubble: Record<string, number> = {};
  private nextChatterAt = Date.now() + 90_000;
  private welcome: 'first' | 'back' | 'angry' | null;
  private welcomeAt = Date.now() + 4000;
  private lastMischiefAt = 0;
  private music: MusicView = { connected: false, track: null, isPlaying: false, hers: false, opinion: null };

  constructor(
    private cfg: GameConfig,
    private i18n: I18n,
    readonly save: SaveData,
    readonly settings: Settings,
    private hooks: GameHooks,
    firstRun: boolean,
  ) {
    const lastMood = this.findMood(save.mood);
    this.welcome = firstRun ? 'first' : lastMood?.comportamiento?.travesuras ? 'angry' : 'back';
    if (!lastMood) this.save.mood = 'neutral';
  }

  // ---------- Configuración ----------

  setConfig(cfg: GameConfig): void {
    this.cfg = cfg;
    if (!this.findMood(this.save.mood)) this.save.mood = 'neutral';
    this.save.inventory = this.save.inventory.filter((s) => cfg.itemMap.has(s.item));
    this.save.groundItems = this.save.groundItems.filter((g) => cfg.itemMap.has(g.item));
    this.hooks.changed();
  }

  get mood(): MoodDef {
    return this.findMood(this.save.mood) ?? this.findMood('neutral')!;
  }

  private findMood(id: string): MoodDef | undefined {
    return this.cfg.moods.moods.find((m) => m.id === id);
  }

  private get isGrumpy(): boolean {
    return !!this.mood.comportamiento?.travesuras;
  }

  get dndActive(): boolean {
    return this.settings.dndUntil > Date.now();
  }

  /** Modo seguro detectado desde fuera (pantalla completa, llamada). */
  private externalQuiet: Exclude<QuietReason, 'dnd'> | null = null;

  setExternalQuiet(reason: Exclude<QuietReason, 'dnd'> | null): void {
    if (reason === this.externalQuiet) return;
    this.externalQuiet = reason;
    this.hooks.changed();
  }

  /** Por qué está en silencio (sin bocadillos espontáneos, sonidos, travesuras ni tocar la música). */
  get quietReason(): QuietReason | null {
    return this.dndActive ? 'dnd' : this.externalQuiet;
  }

  get quiet(): boolean {
    return this.quietReason !== null;
  }

  get config(): GameConfig {
    return this.cfg;
  }

  /** ¿Puede hacer una travesura ahora? (mood con travesuras, sin "No molestar" y pasado el tiempo de espera). */
  canMischief(): boolean {
    return (
      this.isGrumpy &&
      !this.quiet &&
      !this.welcome &&
      Date.now() - this.lastMischiefAt >= this.cfg.stats.travesuraCooldownMinutos * MINUTE
    );
  }

  markMischief(): void {
    this.lastMischiefAt = Date.now();
  }

  setMusic(music: MusicView): void {
    if (JSON.stringify(music) === JSON.stringify(this.music)) return;
    this.music = music;
    this.hooks.changed();
  }

  /** Aplica cambios a las stats desde fuera (música, minijuegos...). */
  adjust(delta: StatDelta | undefined): void {
    this.applyStats(delta);
    this.hooks.changed();
  }

  /** Reacción de la mascota desde fuera del motor. */
  say(r: Reaction, important = true): void {
    this.react(r, important);
  }

  private read = (stat: StatOrAffinity): number => (stat === 'afinidad' ? this.save.afinidad : this.save.stats[stat]);

  // ---------- Bucle principal ----------

  tick(dtMs: number): void {
    const now = Date.now();
    const dtMin = dtMs / MINUTE;
    const { stats } = this.save;
    const sc = this.cfg.stats;
    const aff = this.save.afinidad / 100;

    // Con afinidad alta las necesidades bajan más lento, con afinidad baja más rápido.
    const decayMult = 1 - sc.afinidad.modificadorBajada * aff;
    for (const s of VISIBLE_STATS) {
      if ((this.save.congelados[s] ?? 0) > now) continue;
      stats[s] -= sc.bajadaPorMinuto[s] * decayMult * dtMin;
    }

    const deficit = VISIBLE_STATS.reduce(
      (sum, s) => sum + Math.max(0, (sc.mosqueo.umbralBajo - stats[s]) / sc.mosqueo.umbralBajo),
      0,
    );
    const allCalm = VISIBLE_STATS.every((s) => stats[s] >= sc.mosqueo.umbralCalma);
    if (deficit > 0 && (this.save.congelados.mosqueo ?? 0) <= now) {
      stats.mosqueo += sc.mosqueo.subidaPorMinuto * deficit * decayMult * dtMin;
    } else if (allCalm) {
      stats.mosqueo -= sc.mosqueo.bajadaPorMinuto * dtMin;
    }

    if (this.isGrumpy) {
      this.addAffinity(-sc.afinidad.bajadaPorMinuto * dtMin);
    } else if (allCalm && stats.mosqueo < 30) {
      this.addAffinity(sc.afinidad.subidaPorMinuto * dtMin);
    }

    this.clampStats();
    this.updateMood(now);
    this.updateWelcome(now);
    this.updateChatter(now);
    this.hooks.changed();
  }

  private clampStats(): void {
    for (const s of ALL_STATS) this.save.stats[s] = clamp(this.save.stats[s], 0, 100);
    this.save.afinidad = clamp(this.save.afinidad, -100, 100);
  }

  private addAffinity(delta: number): void {
    this.save.afinidad = clamp(this.save.afinidad + delta, -100, 100);
  }

  private updateMood(now: number): void {
    const candidate = pickMood(this.cfg.moods.moods, this.read);
    if (candidate.id === this.save.mood) {
      this.pendingMood = null;
      return;
    }
    if (this.pendingMood?.id !== candidate.id) {
      this.pendingMood = { id: candidate.id, since: now };
      return;
    }
    if (now - this.pendingMood.since < this.cfg.stats.segundosParaCambiarMood * 1000) return;

    this.save.mood = candidate.id;
    this.pendingMood = null;
    const key = `mood${candidate.id.charAt(0).toUpperCase()}${candidate.id.slice(1)}`;
    const grumpy = !!candidate.comportamiento?.travesuras;
    this.react(
      {
        anim: grumpy ? 'angry' : 'happy',
        sound: grumpy ? 'grunido' : 'risa',
        bubble: !this.quiet && this.i18n.hasBubble(key) ? this.i18n.bubble(key) : undefined,
      },
      true,
    );
    this.hooks.moodChanged?.(candidate);
  }

  private updateWelcome(now: number): void {
    // Si está en "No molestar", la bienvenida espera a que termine.
    if (!this.welcome || now < this.welcomeAt || this.quiet) return;
    // Si se le ha pasado el enfado antes de saludar (la has cuidado), ya no hay travesura.
    if (this.welcome === 'angry' && !this.isGrumpy) this.welcome = 'back';
    const name = this.save.pet.name;
    if (this.welcome === 'first') {
      this.react({ anim: 'happy', sound: 'saludo', bubble: this.i18n.bubble('welcomeFirst', { name }) }, true);
    } else if (this.welcome === 'angry') {
      // Travesura de bienvenida: no espera al tiempo entre travesuras. Llega un poco después del
      // "¿Ahora vuelves?" para que dé tiempo a leerlo; mientras, no se permiten otras travesuras.
      this.react({ anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('welcomeAngry', { name }) }, true);
      this.lastMischiefAt = Date.now();
      setTimeout(() => void this.hooks.welcomeMischief?.(), WELCOME_MISCHIEF_DELAY);
    } else {
      this.react({ anim: 'happy', sound: 'saludo', bubble: this.i18n.bubble('welcomeBack', { name }) }, true);
    }
    this.welcome = null;
    this.nextChatterAt = now + 2 * MINUTE;
  }

  /** Bocadillos espontáneos: primero las necesidades, si no, comentarios según el mood. */
  private updateChatter(now: number): void {
    if (now < this.nextChatterAt || this.quiet || this.welcome) return;
    const talk = this.mood.comportamiento?.habla_sola ?? 0.3;
    this.nextChatterAt = now + (90 + Math.random() * 150) * 1000 * (1.5 - talk);

    const needs: [StatId, string][] = [
      ['sed', 'thirsty'],
      ['hambre', 'hungry'],
      ['carino', 'lonely'],
      ['diversion', 'bored'],
    ];
    for (const [stat, key] of needs) {
      if (this.save.stats[stat] < 30 && now - (this.lastNeedBubble[key] ?? 0) > NEED_BUBBLE_COOLDOWN) {
        this.lastNeedBubble[key] = now;
        this.chatterOr(stat, { anim: 'talk', bubble: this.i18n.bubble(key) });
        return;
      }
    }

    const idleKey = `idle_${this.mood.id}`;
    if (Math.random() < talk && this.i18n.hasBubble(idleKey)) {
      this.chatterOr('idle', { anim: 'talk', bubble: this.i18n.bubble(idleKey) });
    }
  }

  /** Comentario espontáneo: lo escribe la IA si puede; si no, la frase fija. */
  private chatterOr(topic: string, fallback: Reaction): void {
    if (!this.hooks.chatter?.(topic, fallback)) this.react(fallback, true);
  }

  /** Envía una reacción. Los bocadillos de interacciones repetidas se espacian para no saturar. */
  private react(r: Reaction, important = false): void {
    if (r.bubble) {
      const now = Date.now();
      if (!important && now - this.lastReactionBubble < REACTION_BUBBLE_GAP) delete r.bubble;
      else this.lastReactionBubble = now;
    }
    this.hooks.react(r);
  }

  private applyStats(delta: Partial<Record<StatOrAffinity, number>> | undefined, mult = 1): void {
    if (!delta) return;
    for (const [stat, value] of Object.entries(delta) as [StatOrAffinity, number][]) {
      // El multiplicador (favorito/odiado) solo afecta a lo que la beneficia.
      const isGood = stat === 'mosqueo' ? value < 0 : value > 0;
      const v = isGood ? value * mult : value;
      if (stat === 'afinidad') this.addAffinity(v);
      else this.save.stats[stat] += v;
    }
    this.clampStats();
  }

  // ---------- Interacciones ----------

  interact(type: InteractionType): void {
    const now = Date.now();
    this.activity.push({ type, at: now });
    const sc = this.cfg.stats;

    if (type === 'pet' && this.isGrumpy && Math.random() < sc.rechazoCariciasCabreada) {
      // Rechaza la caricia, pero aun así se le pasa un poquito el enfado.
      this.applyStats({ mosqueo: -0.5 });
      this.react({ anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('petRefused') });
      this.hooks.changed();
      return;
    }

    this.applyStats(sc.interacciones[type]);
    this.addAffinity(sc.afinidad.porInteraccion);

    const grumpy = this.isGrumpy;
    switch (type) {
      case 'pet':
        this.react({ anim: 'petted', sound: 'petted', bubble: Math.random() < 0.3 ? this.i18n.bubble('petted') : undefined });
        break;
      case 'tickle':
        this.react({ anim: 'happy', sound: 'risa', bubble: this.i18n.bubble('tickle') });
        break;
      case 'poke':
        this.react({ anim: 'talk', sound: 'saludo', bubble: this.i18n.bubble(grumpy ? 'pokeAngry' : 'poke') });
        break;
      case 'throw':
        this.react({ anim: 'happy', sound: 'risa', bubble: Math.random() < 0.4 ? this.i18n.bubble('thrown') : undefined });
        break;
      case 'throwHard':
        this.react({ anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('thrownHard') });
        break;
    }

    const table = LOOT_FOR[type];
    if (table) this.rollDrop(table, type);
    this.hooks.changed();
  }

  /** Tira los dados de una tabla de botín y, si toca, suelta el objeto junto a la mascota. */
  rollDrop(tableName: string, activity?: string): void {
    const lc = this.cfg.loot;
    const useReconciliation = lc.moodsReconciliacion.includes(this.mood.id) && tableName in LOOT_TABLES_INTERACTIVE;
    const table = lc.tablas[useReconciliation ? 'reconciliacion' : tableName];
    if (!table || this.save.groundItems.length >= lc.maxEnSuelo) return;

    let chance =
      table.probabilidad + (lc.bonusPorMood[this.mood.id] ?? 0) + (lc.bonusAfinidadMax * Math.max(0, this.save.afinidad)) / 100;

    if (activity) {
      const since = Date.now() - lc.rendimientoDecreciente.ventanaMinutos * MINUTE;
      this.activity = this.activity.filter((a) => a.at >= since);
      const repeats = this.activity.filter((a) => a.type === activity).length;
      const free = lc.rendimientoDecreciente.repeticionesLibres;
      if (repeats > free) chance *= free / repeats;
    }
    if (Math.random() >= chance) return;

    const total = table.entradas.reduce((s, e) => s + e.peso, 0);
    let r = Math.random() * total;
    const entry = table.entradas.find((e) => (r -= e.peso) < 0) ?? table.entradas[0];

    const spot = this.hooks.petSpot();
    if (!spot) return;
    const ground: GroundItem = {
      id: `g${Date.now().toString(36)}${(groundSeq++).toString(36)}`,
      item: entry.item,
      displayId: spot.displayId,
      x: clamp(spot.x + (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 50), spot.minX + 20, spot.maxX - 20),
      y: spot.groundY,
    };
    this.save.groundItems.push(ground);
    this.react({ sound: 'pop', bubble: Math.random() < 0.3 ? this.i18n.bubble('dropped') : undefined });
  }

  collect(groundId: string): void {
    const idx = this.save.groundItems.findIndex((g) => g.id === groundId);
    if (idx < 0) return;
    if (!this.addToInventory(this.save.groundItems[idx].item)) {
      this.react({ bubble: this.i18n.bubble('inventoryFull') }, true);
      return;
    }
    this.save.groundItems.splice(idx, 1);
    this.react({ sound: 'recoger' });
    this.hooks.changed();
  }

  addToInventory(itemId: string, amount = 1): boolean {
    const def = this.cfg.itemMap.get(itemId);
    if (!def) return false;
    const max = this.cfg.items.maxPorHueco;
    const stack = this.save.inventory.find((s) => s.item === itemId && s.cantidad < max);
    if (stack) {
      stack.cantidad += amount;
      return true;
    }
    if (this.save.inventory.length >= this.cfg.items.maxHuecos) return false;
    this.save.inventory.push({ item: itemId, cantidad: amount, ...(def.usos ? { usosRestantes: def.usos } : {}) });
    return true;
  }

  useItem(slotIndex: number): void {
    const slot = this.save.inventory[slotIndex];
    const def = slot && this.cfg.itemMap.get(slot.item);
    if (!slot || !def) return;
    const now = Date.now();

    if (def.permanente && (this.save.cooldowns[def.id] ?? 0) > now) {
      this.react({ anim: 'talk', bubble: this.i18n.bubble('cooldown') }, true);
      return;
    }

    const fav = this.save.pet.favoritos.includes(def.id);
    const hated = this.save.pet.odiados.includes(def.id);
    const e = def.efectos;
    this.applyStats(e.stats, fav ? 1.5 : hated ? 0.5 : 1);
    if (e.fijar) {
      for (const [stat, v] of Object.entries(e.fijar) as [StatId, number][]) this.save.stats[stat] = v;
    }
    if (e.congelar) {
      const until = now + e.congelar.minutos * MINUTE;
      const stats = e.congelar.stats === 'todas' ? ALL_STATS : e.congelar.stats;
      for (const s of stats) this.save.congelados[s] = until;
    }
    if (hated) this.applyStats({ mosqueo: 5 });
    this.addAffinity(this.cfg.stats.afinidad.porInteraccion);

    this.consume(slotIndex, def, now);
    this.react(this.itemReaction(def, fav, hated), true);
    this.hooks.changed();
  }

  private consume(slotIndex: number, def: ItemDef, now: number): void {
    const slot = this.save.inventory[slotIndex];
    if (def.permanente) {
      if (def.cooldownMinutos) this.save.cooldowns[def.id] = now + def.cooldownMinutos * MINUTE;
      return;
    }
    if (def.usos) {
      slot.usosRestantes = (slot.usosRestantes ?? def.usos) - 1;
      if (slot.usosRestantes > 0) return;
      slot.usosRestantes = def.usos;
    }
    slot.cantidad--;
    if (slot.cantidad <= 0) this.save.inventory.splice(slotIndex, 1);
  }

  private itemReaction(def: ItemDef, fav: boolean, hated: boolean): Reaction {
    const name = this.save.pet.name;
    const defaultAnim = def.categoria === 'comida' ? 'eat' : def.categoria === 'bebida' ? 'drink' : 'happy';
    const sound = def.categoria === 'comida' ? 'comer' : def.categoria === 'bebida' ? 'beber' : 'risa';
    if (hated) return { anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('hated') };
    if (def.efectos.especial && this.hooks.special?.(def.efectos.especial)) {
      return { anim: def.animacion ?? defaultAnim, sound };
    }
    if (def.efectos.especial && this.i18n.hasBubble(def.efectos.especial)) {
      return { anim: def.animacion ?? defaultAnim, sound, bubble: this.i18n.bubble(def.efectos.especial, { name }) };
    }
    return { anim: def.animacion ?? defaultAnim, sound, bubble: this.i18n.bubble(fav ? 'favorite' : 'thanks') };
  }

  // ---------- Ajustes ----------

  setDnd(minutes: number): void {
    const now = Date.now();
    if (minutes <= 0) {
      this.settings.dndUntil = 0;
    } else {
      this.settings.dndUntil = now + minutes * MINUTE;
      this.save.dndLog = this.save.dndLog.filter((t) => now - t < 24 * 60 * MINUTE);
      this.save.dndLog.push(now);
      if (this.save.dndLog.length > this.cfg.stats.noMolestarUsosLibres) {
        this.applyStats({ mosqueo: this.cfg.stats.noMolestarMosqueo });
      }
    }
    this.hooks.changed();
  }

  // ---------- Vista para el renderer ----------

  view(home: { displayId: number; x: number }): GameView {
    const now = Date.now();
    const mood = this.mood;
    const inventory: InventoryView[] = this.save.inventory.map((slot) => {
      const def = this.cfg.itemMap.get(slot.item)!;
      return {
        ...slot,
        nombre: this.i18n.loc(def.nombre, def.id),
        descripcion: this.i18n.loc(def.descripcion),
        categoria: def.categoria,
        rareza: def.rareza,
        favorito: this.save.pet.favoritos.includes(def.id),
        odiado: this.save.pet.odiados.includes(def.id),
        cooldownRestante: Math.max(0, (this.save.cooldowns[def.id] ?? 0) - now),
        usosPorUnidad: def.usos,
        permanente: !!def.permanente,
      };
    });

    return {
      petName: this.save.pet.name,
      lang: this.i18n.lang,
      stats: { ...this.save.stats },
      afinidad: this.save.afinidad,
      mood: {
        id: mood.id,
        nombre: this.i18n.loc(mood.nombre, mood.id),
        animaciones: mood.animaciones ?? {},
        comportamiento: { exploracion: 0.4, velocidad: 1, ...mood.comportamiento },
      },
      inventory,
      maxSlots: this.cfg.items.maxHuecos,
      groundItems: this.save.groundItems,
      itemNames: Object.fromEntries(this.cfg.items.items.map((i) => [i.id, this.i18n.loc(i.nombre, i.id)])),
      home,
      dndUntil: this.settings.dndUntil,
      quiet: this.quietReason,
      muted: this.settings.muted,
      volume: this.settings.volume,
      music: this.music,
      ui: this.i18n.section('ui'),
    };
  }
}
