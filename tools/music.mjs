// Pruebas de la integración con Spotify (necesita el juego con --inspect=9334 y --remote-debugging-port=9333).
//   node tools/music.mjs state            → lo que suena y la vista de música
//   node tools/music.mjs suggest [yes|no] → fuerza una sugerencia y pulsa el botón del bocadillo
//   node tools/music.mjs skip             → salta la canción como si fuera el usuario
//   node tools/music.mjs mischief         → fuerza una travesura musical
//   node tools/music.mjs love | hate      → marca el artista actual como favorito/odiado (solo en memoria) y pasa de canción
//   node tools/music.mjs gift             → efecto del Vinilo misterioso
async function evalAt(port, match, expr) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = match ? targets.find((x) => x.url.includes(match)) : targets[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const v = await new Promise((r) => {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      r(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return v;
}
const main = (expr) => evalAt(9334, null, expr);
const overlay = (expr) => evalAt(9333, 'overlay', expr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function state(label) {
  const s = JSON.parse(
    await main(`(async () => { const m = __melochi; await m.director.poll(true); const v = m.game.view({displayId:0,x:0}); return JSON.stringify({
      music: v.music, mood: v.mood.id, mosqueo: +v.stats.mosqueo.toFixed(1), carino: +v.stats.carino.toFixed(1), diversion: +v.stats.diversion.toFixed(1),
      device: m.director.state?.deviceName, context: m.director.state?.contextUri }) })()`),
  );
  const bubble = await overlay(`document.querySelector('.bubble.visible')?.textContent ?? null`);
  console.log(`[${label}]`, JSON.stringify({ ...s, bubble }));
}

const [action, arg] = process.argv.slice(2);
switch (action) {
  case 'state':
    await state('estado');
    break;
  case 'suggest':
    await main(`(() => { const d = __melochi.director; d.lastSuggestAt = 0; d.prompt = null; return d.suggest().then(() => 'ok'); })()`);
    await sleep(1200);
    console.log('bocadillo:', await overlay(`document.querySelector('.bubble.visible')?.innerText ?? null`));
    await overlay(`document.querySelector('.choice-${arg ?? 'yes'}')?.click(); 'ok'`);
    await sleep(5000);
    await state('tras responder');
    break;
  case 'skip':
    await main(`__melochi.api.next().then(() => 'ok')`);
    await sleep(2500);
    await state('tras saltar');
    break;
  case 'mischief':
    console.log('travesura hecha:', await main(`__melochi.director.mischief(true)`));
    await sleep(3000);
    await state('tras travesura');
    break;
  case 'love':
  case 'hate': {
    const artist = await main(`__melochi.director.state?.track?.artists[0] ?? null`);
    console.log('artista:', artist);
    await main(`(() => { const c = __melochi.game.config.music; c.${action === 'love' ? 'artistasFavoritos' : 'artistasOdiados'}.push(${JSON.stringify(artist)}); __melochi.director.lastTasteUri = ''; __melochi.director.lastTasteBubbleAt = 0; return 'ok'; })()`);
    // Fuerza que vuelva a "ver" la canción actual como nueva.
    await main(`(() => { const d = __melochi.director; if (d.state) d.state = { ...d.state, track: { ...d.state.track, uri: 'x' } }; return 'ok'; })()`);
    await sleep(500);
    await state('tras marcar');
    break;
  }
  case 'gift':
    await main(`(() => { __melochi.director.special('regalarCancion'); return 'ok'; })()`);
    await sleep(4000);
    await state('tras regalo');
    break;
  default:
    console.log('Acciones: state | suggest [yes|no] | skip | mischief | love | hate | gift');
}
process.exit(0);
