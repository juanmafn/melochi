// Llamadas a la API de Windows mediante koffi. Si koffi no está disponible, todo devuelve null
// y el juego sigue funcionando con lo que da Electron.

export interface Win32Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ForegroundInfo {
  /** HWND como número (para compararlo con el de nuestras ventanas). */
  hwnd: bigint;
  className: string;
  /** Rectángulo de la ventana en píxeles físicos. */
  rect: Win32Rect;
  /** Rectángulo del monitor en el que está, en píxeles físicos. */
  monitor: Win32Rect;
  /** Windows dice que hay una aplicación D3D a pantalla completa o una presentación. */
  shellFullscreen: boolean;
}

interface Api {
  koffi: any;
  getAsyncKeyState: (vKey: number) => number;
  getSystemMetrics: (index: number) => number;
  getForegroundWindow: () => unknown;
  getWindowRect: (hwnd: unknown, out: Win32Rect) => boolean;
  monitorFromWindow: (hwnd: unknown, flags: number) => unknown;
  getMonitorInfo: (hmon: unknown, info: { cbSize: number; rcMonitor?: Win32Rect; rcWork?: Win32Rect; dwFlags?: number }) => boolean;
  getClassName: (hwnd: unknown, buf: Uint16Array, max: number) => number;
  queryNotificationState: ((out: number[]) => number) | null;
}

let api: Api | null | undefined;

function load(): Api | null {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    koffi.struct('MELOCHI_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('MELOCHI_MONITORINFO', { cbSize: 'uint32', rcMonitor: 'MELOCHI_RECT', rcWork: 'MELOCHI_RECT', dwFlags: 'uint32' });
    let queryNotificationState: Api['queryNotificationState'] = null;
    try {
      const shell32 = koffi.load('shell32.dll');
      queryNotificationState = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)');
    } catch {
      // No es imprescindible.
    }
    api = {
      koffi,
      getAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
      getForegroundWindow: user32.func('void* __stdcall GetForegroundWindow()'),
      getWindowRect: user32.func('bool __stdcall GetWindowRect(void* hwnd, _Out_ MELOCHI_RECT *rect)'),
      monitorFromWindow: user32.func('void* __stdcall MonitorFromWindow(void* hwnd, uint32 flags)'),
      getMonitorInfo: user32.func('bool __stdcall GetMonitorInfoW(void* hmon, _Inout_ MELOCHI_MONITORINFO *info)'),
      getClassName: user32.func('int __stdcall GetClassNameW(void* hwnd, _Out_ uint16_t *buf, int max)'),
      queryNotificationState,
    };
  } catch (err) {
    console.warn('[win32] koffi no disponible:', err);
  }
  return api;
}

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const SM_SWAPBUTTON = 23;
const MONITOR_DEFAULTTONEAREST = 2;
// SHQueryUserNotificationState: 3 = juego D3D a pantalla completa, 4 = modo presentación.
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
const QUNS_PRESENTATION_MODE = 4;

/**
 * ¿Está pulsado el botón principal del ratón? null si no se puede saber.
 * GetAsyncKeyState mira los botones físicos, así que se tiene en cuenta si el usuario es zurdo.
 */
export function isPrimaryMouseDown(): boolean | null {
  const a = load();
  if (!a) return null;
  const swapped = a.getSystemMetrics(SM_SWAPBUTTON) !== 0;
  return (a.getAsyncKeyState(swapped ? VK_RBUTTON : VK_LBUTTON) & 0x8000) !== 0;
}

/** Ventana activa, su rectángulo y el del monitor en el que está. null si no se puede saber. */
export function foregroundInfo(): ForegroundInfo | null {
  const a = load();
  if (!a) return null;
  const hwnd = a.getForegroundWindow();
  if (!hwnd) return null;
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!a.getWindowRect(hwnd, rect)) return null;
  const info = { cbSize: 40, rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, rcWork: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
  if (!a.getMonitorInfo(a.monitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), info)) return null;
  const buf = new Uint16Array(128);
  const n = a.getClassName(hwnd, buf, 128);
  let shellFullscreen = false;
  if (a.queryNotificationState) {
    const state = [0];
    if (a.queryNotificationState(state) === 0) shellFullscreen = state[0] === QUNS_RUNNING_D3D_FULL_SCREEN || state[0] === QUNS_PRESENTATION_MODE;
  }
  return {
    hwnd: BigInt(a.koffi.address(hwnd)),
    className: String.fromCharCode(...buf.slice(0, n)),
    rect,
    monitor: info.rcMonitor,
    shellFullscreen,
  };
}
