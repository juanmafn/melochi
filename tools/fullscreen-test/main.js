// Ventana de prueba a pantalla completa (otro proceso, como un juego o un vídeo) para probar los modos seguros.
//   node_modules/electron/dist/electron.exe tools/fullscreen-test [segundos]
const { app, BrowserWindow } = require('electron');

const seconds = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 12);
app.whenReady().then(() => {
  const win = new BrowserWindow({ fullscreen: true, backgroundColor: '#111111', title: 'Prueba de pantalla completa' });
  win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#eee;font:24px Segoe UI,sans-serif">` +
          `<div>Prueba de pantalla completa de Melochi — se cierra sola en ${seconds} s</div></body>`,
      ),
  );
  setTimeout(() => app.quit(), seconds * 1000);
});
