// Vigila el juego durante N segundos y muestra cambios de mood, bocadillos y canción.
//   node tools/watch.mjs <segundos> ["expresión JS a ejecutar en main antes de empezar"]
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
const [secs = '60', setup] = process.argv.slice(2);
if (setup) console.log('setup:', await evalAt(9334, null, setup));
const start = Date.now();
let last = '';
while (Date.now() - start < +secs * 1000) {
  const s = await evalAt(
    9334,
    null,
    `(() => { const m = __melochi; const v = m.game.view({displayId:0,x:0}); return JSON.stringify({ mood: v.mood.id, mosqueo: Math.round(v.stats.mosqueo), track: v.music.track?.name ?? null, playing: v.music.isPlaying, hers: v.music.hers }); })()`,
  );
  const b = await evalAt(9333, 'overlay', `(() => { const b = document.querySelector('.bubble.visible'); return b ? b.innerText.replace(/\\n/g, ' / ') : ''; })()`);
  const line = `${s} ${b ? `💬 ${b}` : ''}`;
  if (line !== last) {
    console.log(`${String(Math.round((Date.now() - start) / 1000)).padStart(4)}s ${line}`);
    last = line;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
