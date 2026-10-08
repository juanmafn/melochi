// Vigila los modos seguros durante N segundos (necesita el juego con --inspect=9334).
//   node tools/safe.mjs <segundos>
async function main(expr) {
  const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json())[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const v = await new Promise((r) => {
    ws.addEventListener('message', (e) => r(JSON.parse(e.data).result?.result?.value));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return v;
}
const secs = Number(process.argv[2] ?? 30);
const start = Date.now();
let last = '';
while (Date.now() - start < secs * 1000) {
  const s = await main(`(() => {
    const m = __melochi;
    const wins = m.overlays.displays.map((d) => d.id + ':' + (m.overlays.windowFor(d.id)?.isVisible() ? 'visible' : 'oculta'));
    return JSON.stringify({ silencio: m.game.quietReason, estado: m.safeMode.state, ventanas: wins, mascotaEn: m.overlays.ownerId });
  })()`);
  if (s !== last) {
    console.log(`${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s ${s}`);
    last = s;
  }
  await new Promise((r) => setTimeout(r, 500));
}
process.exit(0);
