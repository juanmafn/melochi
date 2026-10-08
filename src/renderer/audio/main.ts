// Ventana oculta: escucha el audio del PC (loopback) y saca el ritmo. Solo analiza el volumen por
// frecuencias en memoria; no graba ni guarda nada.
import type { AudioApi } from '../../preload/audio';
import { BeatTracker } from '../../shared/beat';

declare global {
  interface Window {
    melochiAudio: AudioApi;
    /** Lo llama main con "gesto de usuario" (getDisplayMedia lo necesita). */
    __startCapture?: () => Promise<string>;
  }
}

const api = window.melochiAudio;
const FRAME_MS = 20;
/** Frecuencia máxima que se mira para los golpes (bombo, caja, palmas). */
const MAX_HZ = 4000;
/** Por debajo de esta frecuencia (bombo y bajo) los cambios cuentan el doble. */
const BASS_HZ = 200;

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let timer: number | null = null;
let statusTimer: number | null = null;
const tracker = new BeatTracker();

async function start(): Promise<string> {
  if (stream) return 'ok';
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  } catch (err) {
    api.error(`No se puede capturar el audio: ${String(err)}`);
    return 'error';
  }
  // Solo hace falta el audio: el vídeo de la pantalla se descarta enseguida.
  for (const t of stream.getVideoTracks()) t.stop();
  if (!stream.getAudioTracks().length) {
    api.error('La captura no trae audio');
    stop();
    return 'noaudio';
  }
  ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  // No se conecta a la salida: no se reproduce nada.
  source.connect(analyser);

  const binHz = ctx.sampleRate / analyser.fftSize;
  const maxBin = Math.min(analyser.frequencyBinCount, Math.ceil(MAX_HZ / binHz));
  const bassBin = Math.ceil(BASS_HZ / binHz);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const prev = new Float32Array(maxBin);
  const wave = new Float32Array(analyser.fftSize);
  tracker.reset();

  timer = window.setInterval(() => {
    analyser.getFloatFrequencyData(freq);
    analyser.getFloatTimeDomainData(wave);
    // "Novedad" del espectro: cuánto ha subido cada frecuencia respecto al fotograma anterior.
    let flux = 0;
    for (let k = 1; k < maxBin; k++) {
      const mag = freq[k] > -140 ? Math.pow(10, freq[k] / 20) : 0;
      const d = mag - prev[k];
      if (d > 0) flux += k < bassBin ? 2 * d : d;
      prev[k] = mag;
    }
    let sum = 0;
    for (const v of wave) sum += v * v;
    const level = Math.sqrt(sum / wave.length);
    if (tracker.push(performance.now(), flux, level)) api.beat(tracker.period);
  }, FRAME_MS);
  statusTimer = window.setInterval(() => api.status(tracker.status()), 1000);
  return 'ok';
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  if (statusTimer !== null) clearInterval(statusTimer);
  timer = statusTimer = null;
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  void ctx?.close();
  ctx = null;
  tracker.reset();
  api.status(tracker.status());
}

window.__startCapture = start;
api.onStop(stop);
// Acceso para depurar (no lo usa el juego).
Object.assign(window, { __tracker: tracker });
