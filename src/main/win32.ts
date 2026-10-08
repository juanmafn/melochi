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
  // Las mismas, pero con el HWND como número (para ventanas que se guardan y se consultan después).
  isWindow: (hwnd: bigint) => boolean;
  isWindowVisible: (hwnd: bigint) => boolean;
  isIconic: (hwnd: bigint) => boolean;
  isZoomed: (hwnd: bigint) => boolean;
  getWindowRectN: (hwnd: bigint, out: Win32Rect) => boolean;
  dwmFrameBounds: ((hwnd: bigint, attr: number, out: Win32Rect, size: number) => number) | null;
  dwmCloaked: ((hwnd: bigint, attr: number, out: number[], size: number) => number) | null;
  enumWindows: (cb: unknown, lparam: number) => boolean;
  enumProc: unknown;
  getWindowLong: (hwnd: bigint, index: number) => number | bigint;
  getClassNameN: (hwnd: bigint, buf: Uint16Array, max: number) => number;
  getTitleLength: (hwnd: bigint) => number;
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
    let dwmFrameBounds: Api['dwmFrameBounds'] = null;
    let dwmCloaked: Api['dwmCloaked'] = null;
    try {
      const dwm = koffi.load('dwmapi.dll');
      dwmFrameBounds = dwm.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ MELOCHI_RECT *out, uint32 size)');
      dwmCloaked = dwm.func('DwmGetWindowAttribute', 'long', ['intptr_t', 'uint32', koffi.out(koffi.pointer('uint32')), 'uint32']);
    } catch {
      // Sin DWM se usa GetWindowRect (incluye los bordes invisibles).
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
      isWindow: user32.func('bool __stdcall IsWindow(intptr_t hwnd)'),
      isWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)'),
      isIconic: user32.func('bool __stdcall IsIconic(intptr_t hwnd)'),
      isZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hwnd)'),
      getWindowRectN: user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MELOCHI_RECT *rect)'),
      dwmFrameBounds,
      dwmCloaked,
      enumProc: koffi.proto('bool __stdcall MELOCHI_ENUMPROC(intptr_t hwnd, intptr_t lparam)'),
      enumWindows: user32.func('bool __stdcall EnumWindows(MELOCHI_ENUMPROC *cb, intptr_t lparam)'),
      getWindowLong: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)'),
      getClassNameN: user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)'),
      getTitleLength: user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)'),
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

export interface WindowState {
  /** Rectángulo visible en píxeles físicos (sin los bordes invisibles de Windows 10/11). */
  rect: Win32Rect;
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
}

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

export interface WindowInfo extends WindowState {
  hwnd: bigint;
  className: string;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const DWMWA_CLOAKED = 14;

/**
 * Ventanas de programas visibles en pantalla, de la de delante a la de atrás (orden Z).
 * Sin minimizadas, ocultas (otros escritorios virtuales, apps "suspendidas"), ventanas de herramientas ni sin título.
 */
export function listWindows(): WindowInfo[] {
  const a = load();
  if (!a) return [];
  const out: WindowInfo[] = [];
  const buf = new Uint16Array(128);
  const cb = a.koffi.register((raw: number | bigint) => {
    const hwnd = BigInt(raw);
    if (!a.isWindowVisible(hwnd) || a.isIconic(hwnd) || a.getTitleLength(hwnd) === 0) return true;
    if (Number(a.getWindowLong(hwnd, GWL_EXSTYLE)) & WS_EX_TOOLWINDOW) return true;
    if (a.dwmCloaked) {
      const cloaked = [0];
      if (a.dwmCloaked(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) return true;
    }
    const st = windowState(hwnd);
    if (!st || st.rect.right - st.rect.left < 2 || st.rect.bottom - st.rect.top < 2) return true;
    const n = a.getClassNameN(hwnd, buf, 128);
    out.push({ ...st, hwnd, className: String.fromCharCode(...buf.slice(0, n)) });
    return true;
  }, a.koffi.pointer(a.enumProc));
  try {
    a.enumWindows(cb, 0);
  } finally {
    a.koffi.unregister(cb);
  }
  return out;
}

/** Estado de una ventana por su HWND. null si ya no existe (o no se puede saber). */
export function windowState(hwnd: bigint): WindowState | null {
  const a = load();
  if (!a || !a.isWindow(hwnd)) return null;
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  const ok = (a.dwmFrameBounds && a.dwmFrameBounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0) || a.getWindowRectN(hwnd, rect);
  if (!ok) return null;
  return { rect, visible: a.isWindowVisible(hwnd), minimized: a.isIconic(hwnd), maximized: a.isZoomed(hwnd) };
}
