// Prueba con el ratón real de Windows (koffi). Antes de pulsar, comprueba que bajo el cursor está una ventana de Melochi.
// Requiere el juego arrancado con --inspect=9334 (proceso principal) y --remote-debugging-port=9333.
//   node tools/realmouse.mjs hover|drag|menu|throw
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const WindowFromPoint = user32.func('void* __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('void* __stdcall GetAncestor(void* hwnd, uint flags)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint *pid)');
const mouse_event = user32.func('void __stdcall mouse_event(uint flags, uint dx, uint dy, uint data, uintptr extra)');
const keybd_event = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint flags, uintptr extra)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int i)');
const LEFTDOWN = 0x2, LEFTUP = 0x4, RIGHTDOWN = 0x8, RIGHTUP = 0x10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const action = process.argv[2];

async function mainEval(expr) {
  const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json())[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const res = await new Promise((r) => {
    ws.addEventListener('message', (e) => r(JSON.parse(e.data)));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
  ws.close();
  return res.result.result.value;
}

const electronPids = new Set(
  require('node:child_process')
    .execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'electron.exe\'\\" | ForEach-Object { $_.ProcessId }"')
    .toString()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number),
);

function ownerOfPoint(x, y) {
  const hwnd = GetAncestor(WindowFromPoint({ x, y }), 2);
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return electronPids.has(pid[0]) ? 'melochi' : `otra (pid ${pid[0]})`;
}

const pose = async () => JSON.parse(await mainEval('JSON.stringify(__melochi.overlays.pose)'));
const orig = {};
GetCursorPos(orig);
console.log('pantalla (lógica):', GetSystemMetrics(0), 'x', GetSystemMetrics(1), '| cursor original', orig.x, orig.y);

// Lejos de la mascota: la ventana bajo el cursor NO debe ser Melochi.
let p = await pose();
const far = { x: Math.round(p.x > 700 ? 200 : 1300), y: 300 };
SetCursorPos(far.x, far.y);
await sleep(300);
console.log('lejos de la mascota →', ownerOfPoint(far.x, far.y));

/** Posición en vivo de la mascota (desde la ventana que la dibuja), en coordenadas globales. */
async function livePet() {
  const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
  for (const t of targets.filter((x) => x.type === 'page' && x.url.includes('overlay'))) {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    const v = await new Promise((r) => {
      ws.addEventListener('message', (e) => r(JSON.parse(e.data).result?.result?.value));
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.__melochi?.pet.owned ? JSON.stringify({ x: __melochi.pet.x + screenX, y: __melochi.pet.y + screenY }) : null', returnByValue: true } }));
    });
    ws.close();
    if (v) return JSON.parse(v);
  }
  return pose();
}

// Encima de la mascota: tras moverse el ratón, debe capturarlo Melochi. Si anda, la persigue unos intentos.
async function hoverPet() {
  let cx = 0, cy = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    p = await livePet();
    cx = Math.round(p.x);
    cy = Math.round(p.y - 50);
    for (let i = 0; i < 6; i++) {
      SetCursorPos(cx + (i % 2 ? 3 : -3), cy);
      await sleep(40);
    }
    await sleep(150);
    if (ownerOfPoint(cx, cy) === 'melochi') break;
  }
  return { cx, cy, who: ownerOfPoint(cx, cy) };
}

let h = await hoverPet();
console.log('encima de la mascota →', h.who);

if (h.who === 'melochi' && action === 'drag') {
  mouse_event(LEFTDOWN, 0, 0, 0, 0);
  await sleep(80);
  for (let i = 1; i <= 30; i++) {
    SetCursorPos(h.cx - i * 10, h.cy - i * 8);
    await sleep(16);
  }
  await sleep(400);
  console.log('arrastrando, pose:', JSON.stringify(await pose()));
  for (let i = 1; i <= 8; i++) {
    SetCursorPos(h.cx - 300 + i * 2, h.cy - 240);
    await sleep(30);
  }
  mouse_event(LEFTUP, 0, 0, 0, 0);
  await sleep(100);
  console.log('soltada (suave), pose:', JSON.stringify(await pose()));
  await sleep(1500);
  console.log('tras caer, pose:', JSON.stringify(await pose()));
}

if (h.who === 'melochi' && action === 'throw') {
  mouse_event(LEFTDOWN, 0, 0, 0, 0);
  await sleep(80);
  for (let i = 1; i <= 12; i++) {
    SetCursorPos(h.cx - i * 40, h.cy - i * 30);
    await sleep(10);
  }
  mouse_event(LEFTUP, 0, 0, 0, 0);
  await sleep(50);
  console.log('lanzada, pose:', JSON.stringify(await pose()));
  await sleep(2500);
  console.log('tras caer, pose:', JSON.stringify(await pose()), 'mosqueo:', await mainEval('__melochi.game.save.stats.mosqueo'));
}

// ¿Hay un menú emergente de Windows (clase #32768) visible?
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void* hwnd, _Out_ uint16_t *buf, int max)');
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void* hwnd, intptr lparam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)');
koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ RECT *r)');
/** Ventanas visibles de la app (Electron) que no son las overlays ni la de prueba: ahí está el menú. */
let baseline = null;
const appWindows = () => {
  const out = [];
  const cb = koffi.register((hwnd) => {
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (electronPids.has(pid[0]) && IsWindowVisible(hwnd)) {
      const b = new Uint16Array(64);
      const n = GetClassNameW(hwnd, b, 64);
      const r = {};
      GetWindowRect(hwnd, r);
      out.push(`${String.fromCharCode(...b.slice(0, n))} ${r.right - r.left}x${r.bottom - r.top}@${r.left},${r.top}`);
    }
    return true;
  }, koffi.pointer(EnumWindowsProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return out;
};
const menuOpen = () => {
  const now = appWindows();
  const extra = now.filter((w) => !baseline.includes(w) || w.startsWith('#32768'));
  return extra.length ? extra.join(' | ') : false;
};

if (h.who === 'melochi' && action === 'menu') {
  // Ventana vacía de prueba (de la propia app) donde hacer el clic "fuera", para no tocar ventanas del usuario.
  await mainEval(`(() => {
    const BW = __melochi.overlays.windowFor(__melochi.overlays.ownerId).constructor;
    globalThis.__target = new BW({ x: ${far.x - 150}, y: ${far.y - 100}, width: 300, height: 200, title: 'Melochi test', alwaysOnTop: false });
    globalThis.__target.loadURL('data:text/html,<body style="background:%23ddd">objetivo de prueba</body>');
    return true;
  })()`);
  await sleep(800);
  // El cursor tiene que volver a la mascota (al crear la ventana pudo moverse el foco).
  h = await hoverPet();
  baseline = appWindows();
  console.log('ventanas de la app:', baseline.join(' | '));
  console.log('antes del menú: menú visible =', menuOpen(), '| bajo el cursor →', h.who);
  if (h.who === 'melochi') {
    mouse_event(RIGHTDOWN, 0, 0, 0, 0);
    await sleep(50);
    mouse_event(RIGHTUP, 0, 0, 0, 0);
    await sleep(800);
    console.log('tras clic derecho: menú visible =', menuOpen());
    // Clic fuera del menú, sobre la ventana de prueba.
    SetCursorPos(far.x, far.y);
    await sleep(150);
    const who = ownerOfPoint(far.x, far.y);
    console.log('objetivo del clic fuera →', who);
    if (who === 'melochi') {
      mouse_event(LEFTDOWN, 0, 0, 0, 0);
      await sleep(50);
      mouse_event(LEFTUP, 0, 0, 0, 0);
      await sleep(500);
    }
    console.log('tras clic fuera: menú visible =', menuOpen());
    if (menuOpen()) {
      // Si sigue abierto, se cierra con Escape para no dejarlo colgado.
      keybd_event(0x1b, 0, 0, 0);
      keybd_event(0x1b, 0, 2, 0);
      await sleep(300);
      console.log('cerrado con Escape: menú visible =', menuOpen());
    }
  }
  await mainEval('globalThis.__target?.destroy(); true');
  await sleep(300);
}

// Al irse de la mascota, vuelve a dejar pasar el ratón.
SetCursorPos(far.x, far.y);
await sleep(300);
console.log('de nuevo lejos →', ownerOfPoint(far.x, far.y));
SetCursorPos(orig.x, orig.y);
