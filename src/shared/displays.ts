import type { DisplayInfo } from './types';

const EDGE_TOLERANCE = 2;

/**
 * Monitor contiguo por la izquierda (-1) o la derecha (1), si lo hay.
 * Solo cuentan los monitores que comparten borde vertical y se solapan en altura.
 */
export function neighborDisplay(
  from: DisplayInfo,
  direction: -1 | 1,
  displays: DisplayInfo[],
): DisplayInfo | undefined {
  const a = from.bounds;
  return displays.find((d) => {
    if (d.id === from.id) return false;
    const b = d.bounds;
    const touches =
      direction === 1
        ? Math.abs(b.x - (a.x + a.width)) <= EDGE_TOLERANCE
        : Math.abs(b.x + b.width - a.x) <= EDGE_TOLERANCE;
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return touches && overlapY > 0;
  });
}

/** Altura del "suelo" (borde superior de la barra de tareas) en coordenadas globales. */
export function groundY(d: DisplayInfo): number {
  return d.workArea.y + d.workArea.height;
}

export function displayContaining(x: number, y: number, displays: DisplayInfo[]): DisplayInfo | undefined {
  return displays.find((d) => {
    const b = d.bounds;
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
  });
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
