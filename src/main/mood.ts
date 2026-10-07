import type { Condition, MoodDef, StatOrAffinity } from '../shared/types';

export type StatReader = (stat: StatOrAffinity) => number;

export function evaluate(cond: Condition | undefined, read: StatReader): boolean {
  if (!cond) return true;
  if ('todas' in cond) return cond.todas.every((c) => evaluate(c, read));
  if ('alguna' in cond) return cond.alguna.some((c) => evaluate(c, read));
  const v = read(cond.stat);
  if (cond['>='] !== undefined && !(v >= cond['>='])) return false;
  if (cond['<='] !== undefined && !(v <= cond['<='])) return false;
  if (cond['>'] !== undefined && !(v > cond['>'])) return false;
  if (cond['<'] !== undefined && !(v < cond['<'])) return false;
  return true;
}

/** Mood de mayor prioridad cuyas condiciones se cumplen; si ninguno, "neutral". */
export function pickMood(moods: MoodDef[], read: StatReader): MoodDef {
  const sorted = [...moods].sort((a, b) => b.prioridad - a.prioridad);
  return sorted.find((m) => m.id !== 'neutral' && evaluate(m.condiciones, read)) ?? moods.find((m) => m.id === 'neutral')!;
}
