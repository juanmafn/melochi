// Llamadas a la API de Windows mediante koffi. Si koffi no está disponible, todo devuelve null
// y el juego sigue funcionando con lo que da Electron.

type GetAsyncKeyState = (vKey: number) => number;
type GetSystemMetrics = (index: number) => number;

let api: { getAsyncKeyState: GetAsyncKeyState; getSystemMetrics: GetSystemMetrics } | null | undefined;

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      getAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    };
  } catch (err) {
    console.warn('[win32] koffi no disponible:', err);
  }
  return api;
}

const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;
const SM_SWAPBUTTON = 23;

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
