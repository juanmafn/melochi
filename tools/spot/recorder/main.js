// Grabador del spot: pone un escritorio "de atrezzo" (fondo y una ventana de notas) encima de tus ventanas,
// pone la música, graba la pantalla y el sonido del PC, compone los títulos y guarda un MP4.
//   electron tools/spot/recorder <config.json>
// Escribe "READY" por la salida cuando empieza a grabar y "SAVED <ruta>" al terminar.
// La ventana de notas se llama "Tareas de hoy" (el guion la busca por el título para moverla).
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const cfg = JSON.parse(readFileSync(process.argv.find((a) => a.endsWith('.json')), 'utf8'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const sf = d.scaleFactor;

  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((s) => cb({ video: s.find((x) => x.display_id === String(d.id)) ?? s[0], audio: 'loopback' }))
      .catch(() => cb({}));
  });

  // Fondo de escritorio de atrezzo (tapa tus ventanas; la barra de tareas queda fuera del vídeo).
  const backdrop = new BrowserWindow({
    ...wa,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    show: false,
    backgroundColor: '#f7d9c4',
  });
  await backdrop.loadFile(join(__dirname, 'backdrop.html'));
  backdrop.showInactive();

  // Ventana "de verdad" a la que puede trepar la mascota.
  const notes = new BrowserWindow({
    x: wa.x + cfg.window.x,
    y: wa.y + cfg.window.y,
    width: cfg.window.width,
    height: cfg.window.height,
    title: 'Tareas de hoy',
    autoHideMenuBar: true,
    backgroundColor: '#fffaf5',
    show: false,
  });
  await notes.loadFile(join(__dirname, 'notes.html'));
  notes.show();
  notes.focus();

  const rec = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: { preload: join(__dirname, 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  await rec.loadFile(join(__dirname, 'recorder.html'));

  ipcMain.handle('spot:save', (_e, data) => {
    writeFileSync(cfg.out, Buffer.from(data));
    console.log(`SAVED ${cfg.out}`);
    setTimeout(() => app.quit(), 300);
  });
  ipcMain.on('spot:log', (_e, msg) => console.log(msg));

  // Recorte 16:9 dentro del área de trabajo (sin la barra de tareas), en píxeles físicos.
  const h = Math.round(wa.height * sf);
  const w = Math.min(Math.round(wa.width * sf), Math.round((h * 16) / 9));
  const crop = { x: Math.round(wa.x * sf + (wa.width * sf - w) / 2), y: Math.round(wa.y * sf), w, h };

  await new Promise((r) => setTimeout(r, 1500));
  const recCfg = {
    seconds: cfg.seconds,
    crop,
    music: pathToFileURL(cfg.music).href,
    icon: pathToFileURL(cfg.icon).href,
    captions: cfg.captions,
    volume: cfg.volume ?? 0.8,
  };
  const r = await rec.webContents.executeJavaScript(`startRecording(${JSON.stringify(recCfg)})`, true);
  if (r !== 'ok') {
    console.log(`ERROR ${r}`);
    app.quit();
    return;
  }
  console.log('READY');
});
