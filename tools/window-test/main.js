// Ventana normal de prueba (otro proceso, como cualquier programa tuyo) para las travesuras de escritorio:
// sentarse encima o esconderse detrás. Se queda activa y, si se indica, se mueve sola pasados unos segundos.
//   node_modules/electron/dist/electron.exe tools/window-test [segundos] [moverTras]
const { app, BrowserWindow } = require('electron');

const nums = process.argv.filter((a) => /^\d+$/.test(a)).map(Number);
const seconds = nums[0] ?? 30;
const moveAfter = nums[1] ?? 0;
app.whenReady().then(() => {
  const win = new BrowserWindow({ x: 420, y: 260, width: 700, height: 420, backgroundColor: '#eeeeee', title: 'Ventana de prueba de Melochi' });
  win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<body style="margin:0;display:grid;place-items:center;height:100vh;background:#eee;color:#333;font:20px Segoe UI,sans-serif">` +
          `<div>Ventana de prueba de Melochi — se cierra sola en ${seconds} s</div></body>`,
      ),
  );
  win.once('ready-to-show', () => win.focus());
  if (moveAfter) setTimeout(() => win.setPosition(460, 300), moveAfter * 1000);
  setTimeout(() => app.quit(), seconds * 1000);
});
