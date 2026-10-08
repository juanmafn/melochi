// Ritmo de prueba por los altavoces (bombo + charles sintetizados) para probar el baile al ritmo.
//   node_modules/electron/dist/electron.exe tools/beat-test [bpm1] [bpm2] [segundosCadaUno]
// Por defecto: 120 BPM y luego 95 BPM, 20 s cada uno, a volumen bajo.
const { app, BrowserWindow } = require('electron');

const nums = process.argv.filter((a) => /^\d+$/.test(a)).map(Number);
const [bpm1 = 120, bpm2 = 95, secs = 20] = nums;

const page = `<body style="font:16px Segoe UI;padding:12px">Ritmo de prueba: ${bpm1} BPM y luego ${bpm2} BPM<script>
const ctx = new AudioContext();
const out = ctx.createGain();
out.gain.value = 0.25;
out.connect(ctx.destination);
function kick(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  g.gain.setValueAtTime(1, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.3);
}
function hat(t) {
  const len = 0.04 * ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = 'highpass'; f.frequency.value = 7000; g.gain.value = 0.25;
  s.buffer = buf; s.connect(f).connect(g).connect(out); s.start(t);
}
let t = ctx.currentTime + 0.2;
for (const bpm of [${bpm1}, ${bpm2}]) {
  const p = 60 / bpm, end = t + ${secs};
  for (; t < end; t += p) { kick(t); hat(t + p / 2); }
}
<\/script></body>`;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 360, height: 90, x: 20, y: 20, title: 'Ritmo de prueba de Melochi', focusable: false });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  setTimeout(() => app.quit(), (secs * 2 + 2) * 1000);
});
