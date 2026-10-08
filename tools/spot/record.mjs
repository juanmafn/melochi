// Graba el spot publicitario de Melochi (release/spot/Melochi-spot.mp4).
//   node tools/spot/record.mjs
// Arranca el juego con una partida de prueba (MELOCHI_USER_DATA) y el grabador, y dirige las escenas en
// directo: mueve el ratón (no hace clic) y da órdenes al juego por los depuradores. Mientras graba
// (~1:40) no hay que tocar el ratón ni el teclado. Necesita ffmpeg y Ollama (para el chat y la notita).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'release', 'spot');
mkdirSync(outDir, { recursive: true });
const userData = process.env.MELOCHI_USER_DATA;
if (!userData) throw new Error('Pon MELOCHI_USER_DATA con una partida de prueba (no la tuya).');
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Ratón (solo moverlo) ----------
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
koffi.struct('SPOT_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const FindWindowW = user32.func('void* __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ SPOT_RECT *r)');
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void* hwnd, void* after, int x, int y, int cx, int cy, uint flags)');
const SWP_NOSIZE = 0x1;
const SWP_NOZORDER = 0x4;
const SWP_NOACTIVATE = 0x10;

/** Mueve la ventana de notas del atrezzo (como si la arrastraras), en unos pasos. */
async function moveNotes(dx, dy) {
  const hwnd = FindWindowW(null, 'Tareas de hoy');
  if (!hwnd) return false;
  const r = {};
  GetWindowRect(hwnd, r);
  for (let i = 1; i <= 10; i++) {
    const x = r.left + Math.round((dx * i) / 10);
    const y = r.top + Math.round((dy * i) / 10);
    SetWindowPos(hwnd, null, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    await sleep(30);
  }
  return true;
}
const PARK = { x: 1500, y: 850 }; // sobre la barra de tareas: fuera del vídeo
const park = () => SetCursorPos(PARK.x, PARK.y);

// ---------- Depuradores ----------
async function session(port, match) {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const t = match ? targets.find((x) => x.type === 'page' && x.url.includes(match)) : targets[0];
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r));
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
        });
        const ev = (expr) =>
          new Promise((r) => {
            const i = ++id;
            pending.set(i, (m) => r(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description));
            ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
          });
        return { ev, close: () => ws.close() };
      }
    } catch {
      // Aún arrancando.
    }
    await sleep(500);
  }
  throw new Error(`No se puede conectar al puerto ${port}`);
}

// ---------- Guion ----------
const SECONDS = 92;
const WINDOW = { x: 330, y: 420, width: 620, height: 370 };
const CAPTIONS = [
  { kind: 'card', start: 0, end: 4, noFadeIn: true, title: 'Melochi', subtitle: 'Tu mascota de escritorio para Windows' },
  { start: 4.5, end: 10, title: 'Vive en tu escritorio', subtitle: 'Pasea por la barra de tareas (y por todos tus monitores)' },
  { start: 10.5, end: 17, title: 'Acaríciala', subtitle: 'Pasa el ratón por encima… ¡le encanta!' },
  { start: 17.5, end: 23.5, title: 'Cuídala', subtitle: 'Comida, bebida y objetos que suelta al jugar' },
  { start: 24, end: 31, title: 'Juega con ella', subtitle: 'Pelota, puntero láser y minijuegos' },
  { start: 31.5, end: 40, title: 'Baila con tu música', subtitle: 'Sigue el ritmo de lo que suena en tu PC' },
  { start: 40.5, end: 52, title: 'Trepa por tus ventanas', subtitle: '…y pasea por encima, hasta que las mueves' },
  { start: 52.5, end: 64, title: 'Habla con ella', subtitle: 'Chat con IA local: la conversación no sale de tu PC' },
  { start: 64.5, end: 76, title: 'Si la descuidas… ¡se cabrea!', subtitle: 'Te deja notitas, te toca la música… o golpea el cristal' },
  { start: 76.5, end: 84, title: '…pero siempre te echa de menos', subtitle: 'Si te vas un rato, viene a ver si sigues ahí' },
  {
    kind: 'card',
    start: 84,
    end: SECONDS + 1,
    noFadeOut: true,
    title: 'Melochi',
    subtitle: 'Cuídala, juega con ella… y no la hagas enfadar',
    extra: 'IA local · Spotify · Minijuegos · Skins editables',
  },
];

async function main() {
  // Música original (se genera la primera vez).
  const music = join(outDir, 'music.wav');
  if (!existsSync(music)) execFileSync(process.execPath, [join(root, 'tools', 'spot', 'music.mjs'), music, '96'], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'ignore' });

  // ---------- Juego ----------
  console.log('Arrancando Melochi (partida de prueba)…');
  const game = spawn(electron, ['.', '--remote-debugging-port=9333', '--inspect=9334'], { cwd: root, env: { ...process.env }, stdio: 'ignore' });
  const m = await session(9334);
  await sleep(6000);
  const ov = await session(9333, 'overlay');
  const M = (expr) => m.ev(expr);
  const O = (expr) => ov.ev(expr);

  // Que no haga nada por su cuenta: lo decide el guion.
  console.log(
    await M(`(async () => {
      const g = __melochi.game, s = __melochi;
      const now = Date.now(), far = now + 3600_000;
      g.nextChatterAt = far;
      g.welcome = null;
      g.markMischief();
      s.director.lastSuggestAt = now;
      s.dancer.nextAutoAt = far;
      s.climber.nextTryAt = far;
      s.knock.lastAt = now;
      for (const d of [s.dancer.d, s.climber.d, s.mischief.d]) d.userActive = () => true;
      s.knock.d.idleSeconds = () => 9999;
      g.config.stats.modosSeguros.pantallaCompleta = false;
      g.config.music.baile.duracionSegundos = [8, 8];
      g.config.stats.tocarPantalla.esperaSegundos = 3;
      g.config.stats.trepar.arribaSegundos = [60, 60];
      Object.assign(g.save.stats, { hambre: 75, sed: 80, diversion: 70, carino: 85, mosqueo: 0 });
      g.save.mood = 'feliz';
      g.save.notes = [];
      s.brain.memory.clear();
      g.save.groundItems = [];
      if (!g.save.inventory.some((x) => x.item === 'galleta')) g.addToInventory('galleta', 3);
      s.settings.muted = false;
      s.settings.volume = 0.8;
      s.settings.dndUntil = 0;
      g.adjust({});
      await s.brain.refreshStatus();
      void s.brain.warmUp();
      return 'IA: ' + s.brain.status;
    })()`),
  );
  await M(`(__melochi.overlays.placeOnGround(__melochi.overlays.primary().id, 1180), 'ok')`);
  park();

  // ---------- Grabador ----------
  const cfgPath = join(outDir, 'recorder.json');
  const raw = join(outDir, 'raw.mp4');
  writeFileSync(
    cfgPath,
    JSON.stringify({ out: raw, seconds: SECONDS, music, icon: join(root, 'build', 'icon.png'), captions: CAPTIONS, window: WINDOW, volume: 0.75 }),
  );
  console.log('Preparando el escritorio de atrezzo…');
  const rec = spawn(electron, [join(root, 'tools', 'spot', 'recorder'), cfgPath], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
  let saved = false;
  const ready = new Promise((resolve, reject) => {
    rec.stdout.setEncoding('utf8');
    rec.stdout.on('data', (s) => {
      for (const line of s.split(/\r?\n/).filter(Boolean)) {
        console.log(`[grabador] ${line}`);
        if (line === 'READY') resolve();
        if (line.startsWith('ERROR')) reject(new Error(line));
        if (line.startsWith('SAVED')) saved = true;
      }
    });
  });
  await ready;
  const t0 = Date.now();
  const at = async (s) => {
    const wait = t0 + s * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  };
  const petPos = async () => JSON.parse(await O(`JSON.stringify({ x: __melochi.pet.x, y: __melochi.pet.y, h: __melochi.pet.height })`));
  const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${s}`);

  // 1. Pasea por la barra de tareas.
  await at(4);
  log('pasea');
  await O(`(__melochi.pet.runTo(720, 1), 'ok')`);

  // 2. Caricias: el cursor pasa de lado a lado por encima de ella.
  await at(10.8);
  log('caricias');
  {
    const p = await petPos();
    const y = Math.round(p.y - p.h * 0.35);
    for (let i = 0; i < 70; i++) {
      SetCursorPos(Math.round(p.x + Math.sin(i / 4) * 34), y);
      await sleep(40);
    }
  }
  await at(14.6);
  log('cosquillas');
  await M(`(__melochi.game.interact('tickle'), 'ok')`);
  await at(16.2);
  park();

  // 3. Darle de comer desde el inventario.
  await at(17.6);
  log('inventario');
  await O(`(__melochi.openPanel('inventory'), 'ok')`);
  await at(19.6);
  log('galleta');
  await M(`(() => { const g = __melochi.game; g.useItem(g.save.inventory.findIndex((x) => x.item === 'galleta')); return 'ok'; })()`);
  await at(22.6);
  await O(`(__melochi.panels.inventory.close(), 'ok')`);

  // 4. Puntero láser: lo persigue.
  await at(24.2);
  log('láser');
  await O(`(__melochi.toys.start('laser', __melochi.view().ui), 'ok')`);
  {
    const p = await petPos();
    for (let i = 0; i < 150; i++) {
      const x = Math.round(760 + Math.sin(i / 22) * 330 + Math.sin(i / 7) * 40);
      const y = Math.round(p.y - 25 - Math.abs(Math.sin(i / 9)) * 60);
      SetCursorPos(x, y);
      await sleep(40);
    }
  }
  await at(30.6);
  await O(`(__melochi.toys.cancel(), 'ok')`);
  park();

  // 5. Baila al ritmo de la música.
  await at(31.6);
  log(`baile (oye: ${await M(`JSON.stringify(__melochi.audio.status)`)})`);
  log(`  → ${await M(`__melochi.dancer.request()`)}`);

  // 6. Trepa a la ventana de notas, pasea por encima y se cae al moverla.
  await at(40.6);
  log(`trepa → ${await M(`__melochi.climber.tryClimb()`)}`);
  await at(50.2);
  log(`mueve la ventana → ${await moveNotes(90, 35)}`);

  // 7. Chat con la IA.
  await at(52.6);
  log('chat');
  await M(`(__melochi.chatWindow.open(), 'ok')`);
  await at(54.5);
  void M(`__melochi.brain.send('¡Hola, Blobi! ¿Qué tal tu día?').then(() => 'ok')`);
  await at(63.2);
  await M(`(__melochi.chatWindow.close(), 'ok')`);
  log(`  conversación: ${await M(`JSON.stringify(__melochi.brain.messages.slice(-2).map((x) => x.text))`)}`);

  // 8. Se cabrea: notita y golpes en el cristal.
  await at(64.6);
  log('se cabrea');
  await M(`(() => { const g = __melochi.game; Object.assign(g.save.stats, { mosqueo: 85, carino: 20 }); g.save.mood = 'cabreada'; g.adjust({}); return 'ok'; })()`);
  await at(65.4);
  log(`notita → ${await M(`__melochi.mischief.note()`)}`);
  await at(69.2);
  log(`golpea el cristal → ${await M(`__melochi.knock.start('angry')`)}`);

  // 9. "¿Estás ahí?" y le haces caso.
  await at(76.2);
  log('se calma');
  await M(`(() => { const g = __melochi.game; Object.assign(g.save.stats, { mosqueo: 0, carino: 70 }); g.save.mood = 'feliz'; g.adjust({}); return 'ok'; })()`);
  await at(76.8);
  log(`¿estás ahí? → ${await M(`(__melochi.knock.lastAt = 0, __melochi.knock.start('idle'))`)}`);
  await at(80.0);
  log(`le haces caso → ${await M(`__melochi.knock.onTouch()`)}`);

  // 10. Tarjeta final (la pone el grabador). Esperar a que guarde.
  await at(SECONDS + 1);
  for (let i = 0; i < 60 && !saved; i++) await sleep(500);
  m.close();
  ov.close();
  game.kill();
  rec.kill();
  if (!saved) throw new Error('El grabador no ha guardado el vídeo.');

  // ---------- Vídeo final ----------
  const final = join(outDir, 'Melochi-spot.mp4');
  console.log('Codificando el vídeo final…');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', raw,
      '-vf', `fps=30,fade=t=out:st=${SECONDS - 1.2}:d=1.2`,
      // Volumen normalizado como en redes sociales (-14 LUFS), sin picos que saturen.
      '-af', `loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=${SECONDS - 2}:d=2`,
      '-ar', '48000',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', String(SECONDS),
      '-movflags', '+faststart',
      final,
    ],
    { stdio: 'inherit' },
  );
  console.log(`\nSpot listo: ${final}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
