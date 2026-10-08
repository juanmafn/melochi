// Escucha el micrófono unos segundos (no graba ni guarda nada) para probar la detección de llamadas.
//   node_modules/electron/dist/electron.exe tools/mic-test [segundos]
const { app, BrowserWindow, session } = require('electron');
const { join } = require('node:path');

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 15);
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  const win = new BrowserWindow({ width: 380, height: 140, title: 'Prueba de micrófono (Melochi)' });
  // Desde un archivo local (una página data: no puede usar el micrófono).
  win.loadFile(join(__dirname, 'mic.html'));
  setTimeout(() => app.quit(), seconds * 1000);
});
