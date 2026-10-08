import { existsSync } from 'node:fs';
import type { ChatMessage } from '../../shared/types';
import { readJson, writeJson } from '../jsonfile';

const MAX_RECENT = 30;

export interface MemoryData {
  /** Recuerdos a largo plazo: frases cortas sobre ti y vuestra relación. */
  facts: string[];
  /** Últimos mensajes del chat (para mostrarlos al reabrirlo y para resumir). */
  recent: ChatMessage[];
  /** Cuántos mensajes de `recent` (desde el final) aún no se han resumido en `facts`. */
  unsummarized: number;
}

/** Memoria de la mascota, guardada en %APPDATA%/Melochi/memory.json. */
export class Memory {
  data: MemoryData = { facts: [], recent: [], unsummarized: 0 };

  constructor(private path: string) {
    if (existsSync(path)) {
      try {
        this.data = { ...this.data, ...readJson<Partial<MemoryData>>(path) };
      } catch (err) {
        console.warn('[memoria] No se puede leer, empiezo de cero:', err);
      }
    }
  }

  add(msg: ChatMessage): void {
    this.data.recent.push(msg);
    if (msg.role !== 'system') this.data.unsummarized++;
    if (this.data.recent.length > MAX_RECENT) this.data.recent.splice(0, this.data.recent.length - MAX_RECENT);
    this.data.unsummarized = Math.min(this.data.unsummarized, this.data.recent.length);
    this.save();
  }

  /** Mensajes pendientes de resumir. */
  pending(): ChatMessage[] {
    return this.data.unsummarized ? this.data.recent.slice(-this.data.unsummarized) : [];
  }

  setFacts(facts: string[]): void {
    this.data.facts = facts;
    this.data.unsummarized = 0;
    this.save();
  }

  clear(): void {
    this.data = { facts: [], recent: [], unsummarized: 0 };
    this.save();
  }

  save(): void {
    writeJson(this.path, this.data);
  }
}
