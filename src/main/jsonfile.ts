import { readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';

/** Quita comentarios // y /* *\/ (fuera de cadenas) y comas finales, para aceptar JSON "con comentarios". */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJson<T>(path: string): T {
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return JSON.parse(stripJsonComments(raw)) as T;
}

/** Escritura atómica: escribe en un temporal y renombra, para no dejar el archivo a medias. */
export function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** Vigila una carpeta (recursivamente) y llama a `onChange` agrupando ráfagas de cambios. */
export function watchDir(dir: string, onChange: () => void, debounceMs = 400): FSWatcher | null {
  let timer: NodeJS.Timeout | null = null;
  try {
    return watch(dir, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, debounceMs);
    });
  } catch (err) {
    console.warn(`[watch] No se puede vigilar ${dir}:`, err);
    return null;
  }
}
