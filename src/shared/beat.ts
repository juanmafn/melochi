// Detector de ritmo (beat tracking) a partir de la "novedad" del espectro (spectral flux) del audio del PC.
// Calcula el tempo por autocorrelación de los últimos segundos, la fase alineando los golpes más fuertes,
// y avisa de cada golpe predicho (así sigue el ritmo aunque algún golpe no se oiga claro).

import type { AudioStatus } from './types';

const HISTORY_S = 8;
const MIN_BPM = 70;
const MAX_BPM = 180;
/** Tempo preferido (la mayoría de canciones están cerca): desempata entre el doble y la mitad. */
const PREFERRED_BPM = 115;
const ESTIMATE_EVERY_MS = 500;
/** Por debajo de este volumen (RMS) es silencio (el silencio real da ~1e-11; música baja, ~0.005). */
const MIN_LEVEL = 0.001;
const MIN_CONFIDENCE = 0.22;
/** Tiempo seguido con ritmo claro para decir que hay música, y sin él para decir que ya no. */
const MUSIC_ON_MS = 2000;
const MUSIC_OFF_MS = 3000;

export class BeatTracker {
  private flux: number[] = [];
  private times: number[] = [];
  private levels: number[] = [];
  private lastEstimateAt = 0;
  private periodMs = 0;
  private confidence = 0;
  private nextBeatAt = 0;
  private lastBeatAt = 0;
  private candidate: { periodMs: number; hits: number } | null = null;
  private music = false;
  private goodSince = 0;
  private badSince = 0;

  /** Añade un fotograma de audio. Devuelve true si toca un golpe de ritmo ahora. */
  push(t: number, flux: number, level: number): boolean {
    this.flux.push(flux);
    this.times.push(t);
    this.levels.push(level);
    while (this.times.length && t - this.times[0] > HISTORY_S * 1000) {
      this.flux.shift();
      this.times.shift();
      this.levels.shift();
    }
    if (t - this.lastEstimateAt >= ESTIMATE_EVERY_MS) {
      this.lastEstimateAt = t;
      this.estimate(t);
    }
    if (!this.music || !this.periodMs || t < this.nextBeatAt) return false;
    this.lastBeatAt = this.nextBeatAt;
    this.nextBeatAt += this.periodMs;
    // Si se había quedado atrás (pausa larga del temporizador), salta al siguiente golpe futuro.
    while (this.nextBeatAt <= t) this.nextBeatAt += this.periodMs;
    return true;
  }

  status(): AudioStatus {
    const n = this.levels.length;
    const recent = this.levels.slice(Math.max(0, n - 50));
    const level = recent.length ? recent.reduce((s, v) => s + v, 0) / recent.length : 0;
    return {
      music: this.music,
      bpm: this.periodMs ? Math.round(60000 / this.periodMs) : 0,
      confidence: Math.round(this.confidence * 100) / 100,
      level: Math.round(level * 1000) / 1000,
    };
  }

  get period(): number {
    return this.periodMs;
  }

  reset(): void {
    this.flux = [];
    this.times = [];
    this.levels = [];
    this.periodMs = 0;
    this.confidence = 0;
    this.music = false;
    this.candidate = null;
    this.goodSince = 0;
    this.badSince = 0;
  }

  private estimate(t: number): void {
    const n = this.flux.length;
    const span = n > 1 ? this.times[n - 1] - this.times[0] : 0;
    const level = this.status().level;
    let ok = false;
    if (span > 3000 && level >= MIN_LEVEL) {
      const dt = span / (n - 1);
      const o = onsetEnvelope(this.flux);
      const tempo = bestTempo(o, dt);
      this.confidence = tempo?.confidence ?? 0;
      if (tempo && tempo.confidence >= MIN_CONFIDENCE) {
        ok = true;
        this.updatePeriod(tempo.periodMs);
        this.updatePhase(o, dt, t);
      }
    } else {
      this.confidence = 0;
    }
    // Histéresis para no encender y apagar el baile por un compás raro.
    if (ok) {
      this.badSince = 0;
      this.goodSince ||= t;
      if (!this.music && t - this.goodSince >= MUSIC_ON_MS) {
        this.music = true;
        this.nextBeatAt = Math.max(this.nextBeatAt, t);
      }
    } else {
      this.goodSince = 0;
      this.badSince ||= t;
      if (this.music && t - this.badSince >= MUSIC_OFF_MS) this.music = false;
    }
  }

  /** Cambia de tempo solo si la nueva estimación se repite (evita saltos al doble o a la mitad). */
  private updatePeriod(p: number): void {
    if (!this.periodMs) {
      this.periodMs = p;
      return;
    }
    if (Math.abs(p - this.periodMs) / this.periodMs < 0.04) {
      this.periodMs = this.periodMs * 0.8 + p * 0.2;
      this.candidate = null;
      return;
    }
    if (this.candidate && Math.abs(p - this.candidate.periodMs) / this.candidate.periodMs < 0.04) {
      if (++this.candidate.hits >= 3) {
        this.periodMs = p;
        this.candidate = null;
      }
    } else {
      this.candidate = { periodMs: p, hits: 1 };
    }
  }

  /** Alinea los golpes predichos con los golpes que se han oído. */
  private updatePhase(o: number[], dt: number, t: number): void {
    const P = this.periodMs / dt;
    const n = o.length;
    let bestPhase = 0;
    let best = -1;
    const steps = Math.max(1, Math.floor(P));
    for (let ph = 0; ph < steps; ph++) {
      let s = 0;
      for (let k = 0; ; k++) {
        const i = Math.round(n - 1 - ph - k * P);
        if (i < 0) break;
        // Los golpes recientes cuentan más.
        s += o[i] * Math.pow(0.9, k);
      }
      if (s > best) {
        best = s;
        bestPhase = ph;
      }
    }
    const lastOnsetAt = this.times[this.times.length - 1] - bestPhase * dt;
    let next = lastOnsetAt;
    while (next <= t) next += this.periodMs;
    // Sin dar dos golpes casi seguidos al corregir la fase.
    if (this.lastBeatAt && next - this.lastBeatAt < this.periodMs * 0.5) next += this.periodMs;
    this.nextBeatAt = next;
  }
}

/** Resta la media local (para quedarse con los golpes) y quita lo negativo. */
export function onsetEnvelope(flux: number[]): number[] {
  const w = 12;
  const out = new Array<number>(flux.length);
  let sum = 0;
  for (let i = 0; i < flux.length; i++) {
    sum += flux[i];
    if (i >= w) sum -= flux[i - w];
    const mean = sum / Math.min(i + 1, w);
    out[i] = Math.max(0, flux[i] - mean);
  }
  return out;
}

/** Tempo con más autocorrelación entre MIN_BPM y MAX_BPM, ponderado hacia el tempo habitual. */
export function bestTempo(env: number[], dt: number): { periodMs: number; confidence: number } | null {
  const n = env.length;
  // Centrada en cero: si no, el ruido (siempre positivo) también se parece a sí mismo con cualquier retardo.
  const mean = env.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const o = env.map((v) => v - mean);
  const minLag = Math.floor(60000 / MAX_BPM / dt);
  const maxLag = Math.ceil(60000 / MIN_BPM / dt);
  if (n < maxLag * 2) return null;
  const r = (lag: number) => {
    let s = 0;
    let a = 0;
    let b = 0;
    for (let i = lag; i < n; i++) {
      s += o[i] * o[i - lag];
      a += o[i] * o[i];
      b += o[i - lag] * o[i - lag];
    }
    return a > 0 && b > 0 ? s / Math.sqrt(a * b) : 0;
  };
  const scores: number[] = [];
  let bestLag = 0;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const raw = r(lag);
    scores[lag] = raw;
    const bpm = 60000 / (lag * dt);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / PREFERRED_BPM) / 0.9, 2));
    if (raw * w > bestScore) {
      bestScore = raw * w;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  // Interpolación parabólica para afinar el periodo entre dos fotogramas.
  const a = scores[bestLag - 1] ?? scores[bestLag];
  const b = scores[bestLag];
  const c = scores[bestLag + 1] ?? scores[bestLag];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return { periodMs: (bestLag + shift) * dt, confidence: Math.max(0, b) };
}
