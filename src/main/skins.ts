import { net, protocol } from 'electron';
import { existsSync, readdirSync, statSync, type FSWatcher } from 'node:fs';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SkinAnimation, SkinFrame, SkinManifest } from '../shared/types';
import { readJson, watchDir } from './jsonfile';

/** Esquema propio para servir los archivos de la skin activa: melochi://skin/anims/idle/000.png */
export const SKIN_SCHEME = 'melochi';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

interface SkinAnimDef {
  /** Carpeta con PNG numerados. */
  frames?: string;
  /** JSON de sprite sheet (Aseprite o TexturePacker, formato hash o array). */
  sheet?: string;
  /** Etiqueta de Aseprite (frameTags) si la sheet tiene varias animaciones. */
  tag?: string;
  fps?: number;
  loop?: boolean;
}

interface SkinJson {
  nombre?: string;
  escala?: number;
  ancla?: [number, number];
  animaciones: Record<string, SkinAnimDef>;
  sonidos?: Record<string, string[]>;
}

interface SheetFrameData {
  filename?: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated?: boolean;
  trimmed?: boolean;
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  duration?: number;
}

interface SheetJson {
  frames: Record<string, SheetFrameData> | SheetFrameData[];
  meta: { image: string; frameTags?: { name: string; from: number; to: number; direction?: string }[] };
}

const naturalCompare = new Intl.Collator(undefined, { numeric: true }).compare;
const toPosix = (p: string) => p.split(sep).join(posix.sep);

function loadFramesDir(skinDir: string, dir: string): SkinFrame[] {
  const full = join(skinDir, dir);
  return readdirSync(full)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort(naturalCompare)
    .map((f) => ({ image: toPosix(join(dir, f)), x: 0, y: 0, w: 0, h: 0, sourceW: 0, sourceH: 0, offX: 0, offY: 0 }));
}

function loadSheet(skinDir: string, sheetPath: string, tag: string | undefined, errors: string[]): SkinFrame[] {
  const json = readJson<SheetJson>(join(skinDir, sheetPath));
  const image = toPosix(join(dirname(sheetPath), json.meta.image));
  let list = Array.isArray(json.frames) ? json.frames : Object.values(json.frames);

  if (tag) {
    const t = json.meta.frameTags?.find((ft) => ft.name === tag);
    if (!t) errors.push(`${sheetPath}: no existe la etiqueta "${tag}".`);
    else list = list.slice(t.from, t.to + 1);
  }

  return list.map((f) => {
    if (f.rotated) errors.push(`${sheetPath}: los frames rotados no están soportados (desactiva "rotation" al exportar).`);
    const sss = f.spriteSourceSize ?? { x: 0, y: 0, w: f.frame.w, h: f.frame.h };
    const src = f.sourceSize ?? { w: f.frame.w, h: f.frame.h };
    return {
      image,
      x: f.frame.x,
      y: f.frame.y,
      w: f.frame.w,
      h: f.frame.h,
      sourceW: src.w,
      sourceH: src.h,
      offX: sss.x,
      offY: sss.y,
      duration: f.duration,
    };
  });
}

/** Lee skin.json y resuelve todas las animaciones a una lista de frames que el renderer puede cargar. */
export function loadSkinManifest(skinDir: string, id: string, version: number): SkinManifest {
  const errors: string[] = [];
  const json = readJson<SkinJson>(join(skinDir, 'skin.json'));
  const animaciones: Record<string, SkinAnimation> = {};

  for (const [name, def] of Object.entries(json.animaciones ?? {})) {
    try {
      let frames: SkinFrame[] = [];
      if (def.frames) frames = loadFramesDir(skinDir, def.frames);
      else if (def.sheet) frames = loadSheet(skinDir, def.sheet, def.tag, errors);
      else errors.push(`Animación "${name}": falta "frames" o "sheet".`);
      if (frames.length === 0) {
        errors.push(`Animación "${name}": no tiene frames.`);
        continue;
      }
      animaciones[name] = { fps: def.fps ?? 8, loop: def.loop ?? true, frames };
    } catch (err) {
      errors.push(`Animación "${name}": ${(err as Error).message}`);
    }
  }
  if (!animaciones.idle) errors.push('Falta la animación obligatoria "idle".');

  return {
    id,
    nombre: json.nombre ?? id,
    escala: json.escala ?? 1,
    ancla: json.ancla ?? [0.5, 1],
    animaciones,
    sonidos: json.sonidos ?? {},
    version,
    errores: errors,
  };
}

/** Gestiona la skin activa: resolver su carpeta, servir sus archivos y recargarla al editarla. */
export class SkinManager {
  version = 1;
  dir: string;
  private watcher: FSWatcher | null = null;

  constructor(
    private skinsRoot: string,
    public id: string,
    private onReload: () => void,
  ) {
    this.dir = this.resolveDir(id);
  }

  private resolveDir(id: string): string {
    const dir = join(this.skinsRoot, id);
    if (existsSync(join(dir, 'skin.json'))) return dir;
    console.warn(`[skin] No se encuentra la skin "${id}", uso "placeholder".`);
    this.id = 'placeholder';
    return join(this.skinsRoot, 'placeholder');
  }

  list(): string[] {
    if (!existsSync(this.skinsRoot)) return [];
    return readdirSync(this.skinsRoot).filter(
      (d) => statSync(join(this.skinsRoot, d)).isDirectory() && existsSync(join(this.skinsRoot, d, 'skin.json')),
    );
  }

  manifest(): SkinManifest {
    try {
      const m = loadSkinManifest(this.dir, this.id, this.version);
      for (const e of m.errores) console.warn(`[skin ${this.id}] ${e}`);
      return m;
    } catch (err) {
      console.error(`[skin ${this.id}] No se puede leer skin.json:`, err);
      return { id: this.id, nombre: this.id, escala: 1, ancla: [0.5, 1], animaciones: {}, sonidos: {}, version: this.version, errores: [String(err)] };
    }
  }

  select(id: string): void {
    this.id = id;
    this.dir = this.resolveDir(id);
    this.watch();
    this.bump();
  }

  bump(): void {
    this.version++;
    this.onReload();
  }

  watch(): void {
    this.watcher?.close();
    this.watcher = watchDir(this.dir, () => this.bump());
  }

  registerProtocol(): void {
    protocol.handle(SKIN_SCHEME, async (req) => {
      const url = new URL(req.url);
      if (url.host !== 'skin') return new Response('Not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const full = resolve(this.dir, rel);
      // Evita salir de la carpeta de la skin con rutas tipo ../../
      const relToSkin = relative(this.dir, full);
      if (relToSkin.startsWith('..') || isAbsolute(relToSkin) || !existsSync(full)) {
        return new Response('Not found', { status: 404 });
      }
      const file = await net.fetch(pathToFileURL(full).toString());
      const ext = extname(full).toLowerCase();
      return new Response(file.body, {
        status: file.status,
        headers: {
          'content-type': MIME[ext] ?? file.headers.get('content-type') ?? 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'no-cache',
        },
      });
    });
  }
}
