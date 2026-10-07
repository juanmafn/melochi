// Muestra el estilo extendido de las ventanas top-level de electron.exe al poner el cursor lejos / encima de la mascota.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const koffi = require('koffi');
const user32 = koffi.load('user32.dll');
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
const WindowFromPoint = user32.func('void* __stdcall WindowFromPoint(POINT p)');
const GetAncestor = user32.func('void* __stdcall GetAncestor(void* hwnd, uint flags)');
const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(void* hwnd, int idx)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void* hwnd, _Out_ uint16_t *buf, int max)');
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void* hwnd, intptr lparam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr lparam)');
const GetWindowThreadProcessId = user32.func('uint __stdcall GetWindowThreadProcessId(void* hwnd, _Out_ uint *pid)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* hwnd)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pids = new Set(require('node:child_process').execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'electron.exe\'\\" | ForEach-Object { $_.ProcessId }"').toString().split(/\s+/).filter(Boolean).map(Number));

function melochiWindows() {
  const out = [];
  const cb = koffi.register((hwnd) => {
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (pids.has(pid[0]) && IsWindowVisible(hwnd)) out.push(hwnd);
    return true;
  }, koffi.pointer(EnumWindowsProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return out;
}
const cls = (h) => { const b = new Uint16Array(64); const n = GetClassNameW(h, b, 64); return String.fromCharCode(...b.slice(0, n)); };
const ex = (h) => '0x' + Number(GetWindowLongPtrW(h, -20)).toString(16);
const report = (label) => console.log(label, melochiWindows().map((h) => `${cls(h)} ex=${ex(h)}`).join(' | '));

const res = await fetch('http://127.0.0.1:9334/json/list');
const t = (await res.json())[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
const pose = await new Promise((r) => {
  ws.addEventListener('message', (e) => r(JSON.parse(JSON.parse(e.data).result.result.value)));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(__melochi.overlays.pose)', returnByValue: true } }));
});
ws.close();

const orig = {};
GetCursorPos(orig);
SetCursorPos(pose.x > 700 ? 200 : 1300, 300);
await sleep(300);
report('lejos:  ');
for (let i = 0; i < 6; i++) { SetCursorPos(Math.round(pose.x) + (i % 2 ? 3 : -3), Math.round(pose.y - 50)); await sleep(60); }
await sleep(200);
report('encima: ');
SetCursorPos(orig.x, orig.y);
await sleep(300);
report('vuelta: ');
