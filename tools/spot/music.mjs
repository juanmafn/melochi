// Música original para el spot (sintetizada aquí, sin derechos de terceros): pop alegre a 116 BPM,
// acordes C - G - Am - F, con bombo a negras para que la mascota pueda bailar siguiendo el ritmo.
//   node tools/spot/music.mjs <salida.wav> [segundos]
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'spot-music.wav';
const SECONDS = Number(process.argv[3] ?? 96);
const RATE = 44100;
const BPM = 116;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const N = Math.floor(SECONDS * RATE);
const L = new Float32Array(N);
const R = new Float32Array(N);

const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) * 2 - 1;

/** Suma una muestra con panorama (-1 izquierda, 1 derecha). */
function add(i, v, pan = 0) {
  if (i < 0 || i >= N) return;
  L[i] += v * (1 - pan) * 0.5 * 1.4;
  R[i] += v * (1 + pan) * 0.5 * 1.4;
}

function kick(t, vol = 0.9) {
  const s = Math.floor(t * RATE);
  for (let i = 0; i < RATE * 0.35; i++) {
    const x = i / RATE;
    const f = 45 + 110 * Math.exp(-x * 30);
    const ph = 2 * Math.PI * (45 * x + (110 / 30) * (1 - Math.exp(-x * 30)));
    add(s + i, Math.sin(ph) * Math.exp(-x * 9) * vol + (f > 0 ? 0 : 0));
  }
}
function clap(t, vol = 0.26) {
  const s = Math.floor(t * RATE);
  let lp = 0;
  for (let i = 0; i < RATE * 0.22; i++) {
    const x = i / RATE;
    const n = rnd();
    lp += (n - lp) * 0.45;
    const burst = x < 0.03 ? 0.6 + 0.4 * Math.sin(x * 900) : 1;
    add(s + i, (n - lp) * Math.exp(-x * 22) * burst * vol, 0.1);
  }
}
function hat(t, vol = 0.12, open = false) {
  const s = Math.floor(t * RATE);
  let prev = 0;
  for (let i = 0; i < RATE * (open ? 0.18 : 0.05); i++) {
    const x = i / RATE;
    const n = rnd();
    const hp = n - prev;
    prev = n;
    add(s + i, hp * Math.exp(-x * (open ? 18 : 70)) * vol, -0.3);
  }
}
/** Nota con envolvente. wave: 'saw' | 'square' | 'tri' | 'sine'. */
function note(t, dur, m, { vol = 0.2, wave = 'tri', attack = 0.01, release = 0.12, pan = 0, detune = 0 } = {}) {
  const s = Math.floor(t * RATE);
  const n = Math.floor((dur + release) * RATE);
  const f = midi(m);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = i / RATE;
    let v = 0;
    for (const d of detune ? [-detune, detune] : [0]) {
      const ph = (x * f * (1 + d)) % 1;
      if (wave === 'saw') v += 2 * ph - 1;
      else if (wave === 'square') v += ph < 0.5 ? 0.7 : -0.7;
      else if (wave === 'tri') v += 4 * Math.abs(ph - 0.5) - 1;
      else v += Math.sin(2 * Math.PI * ph);
    }
    if (detune) v /= 2;
    lp += (v - lp) * 0.18; // filtro suave
    const env = Math.min(1, x / attack) * (x > dur ? Math.exp(-(x - dur) / (release / 4)) : 1);
    add(s + i, lp * env * vol, pan);
  }
}

// Acordes (raíz MIDI y tríada) por compás: C - G - Am - F
const CHORDS = [
  { root: 48, notes: [60, 64, 67] },
  { root: 43, notes: [59, 62, 67] },
  { root: 45, notes: [60, 64, 69] },
  { root: 41, notes: [60, 65, 69] },
];
// Melodía de 2 compases (posición en corcheas, nota MIDI, duración en corcheas), dos variaciones.
const MELODY = [
  [[0, 76, 1], [1, 79, 1], [2, 81, 2], [4, 79, 1], [5, 76, 1], [6, 74, 2], [8, 74, 1], [9, 76, 1], [10, 79, 2], [12, 76, 4]],
  [[0, 72, 1], [1, 74, 1], [2, 76, 2], [4, 79, 2], [6, 81, 1], [7, 79, 1], [8, 77, 2], [10, 76, 2], [12, 72, 4]],
];

const bars = Math.ceil(SECONDS / BAR);
for (let b = 0; b < bars; b++) {
  const t0 = b * BAR;
  const chord = CHORDS[b % 4];
  const last = b >= bars - 2;
  const intro = b < 2;
  // Pads (acordes), siempre.
  for (const m of chord.notes) note(t0, BAR * 0.98, m, { vol: 0.07, wave: 'saw', attack: 0.15, release: 0.4, detune: 0.004, pan: m % 2 ? -0.4 : 0.4 });
  if (last) {
    if (b === bars - 2) for (const m of [60, 64, 67, 72]) note(t0, BAR * 2, m, { vol: 0.08, wave: 'saw', attack: 0.05, release: 1.5, detune: 0.004 });
    if (b === bars - 2) kick(t0, 0.8);
    continue;
  }
  // Bajo en corcheas (desde el compás 2).
  if (!intro) for (let e = 0; e < 8; e++) note(t0 + e * (BEAT / 2), BEAT / 2 * 0.8, chord.root + (e % 4 === 3 ? 12 : 0), { vol: 0.22, wave: 'square', release: 0.04 });
  // Batería (desde el compás 2): bombo a negras, palmas en 2 y 4, charles en corcheas.
  if (!intro) {
    for (let q = 0; q < 4; q++) {
      kick(t0 + q * BEAT);
      if (q % 2) clap(t0 + q * BEAT);
    }
    for (let e = 0; e < 8; e++) hat(t0 + e * (BEAT / 2) + BEAT / 4, e % 2 ? 0.06 : 0.035, e === 7);
  }
  // Melodía cada 2 compases (desde el compás 4), alternando variaciones.
  if (b >= 4 && b % 2 === 0) {
    const mel = MELODY[(b / 2) % 2];
    for (const [pos, m, dur] of mel) note(t0 + pos * (BEAT / 2), dur * (BEAT / 2) * 0.9, m, { vol: 0.13, wave: 'tri', release: 0.15, pan: 0.15 });
  }
  // Campanitas arpegiadas en la intro.
  if (intro || b % 8 === 7) for (let e = 0; e < 8; e++) note(t0 + e * (BEAT / 2), BEAT / 2, chord.notes[e % 3] + 12, { vol: 0.06, wave: 'sine', release: 0.3, pan: e % 2 ? 0.5 : -0.5 });
}

// Limitador suave y normalización.
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.2);
  R[i] = Math.tanh(R[i] * 1.2);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = 0.89 / peak;
// Fundido final de 1,5 s.
const fade = 1.5 * RATE;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 4, 4);
buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 4, 28);
buf.writeUInt16LE(4, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const f = i > N - fade ? (N - i) / fade : 1;
  buf.writeInt16LE(Math.round(L[i] * gain * f * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(R[i] * gain * f * 32767), 46 + i * 4);
}
writeFileSync(out, buf);
console.log(`Música: ${out} (${SECONDS} s, ${BPM} BPM)`);
