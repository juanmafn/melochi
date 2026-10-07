// Mini cliente CDP para inspeccionar las ventanas de Electron.
//   node cdp.mjs list
//   node cdp.mjs eval <urlSubstring> "<expr>"
//   node cdp.mjs shot <urlSubstring> <out.png> [x y w h]
//   node cdp.mjs logs <urlSubstring> <ms>     (escucha consola y errores)
import { writeFileSync } from 'node:fs';
const PORT = process.env.CDP_PORT ?? 9333;
const [cmd, match, ...rest] = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
if (cmd === 'list') {
  for (const t of targets) console.log(t.type, t.id, t.url);
  process.exit(0);
}
const matching = match === 'main' ? targets.slice(0, 1) : targets.filter((t) => t.type === 'page' && t.url.includes(match));
if (!matching.length) {
  console.error('No hay target con', match);
  process.exit(1);
}

async function session(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else listeners.forEach((l) => l(msg));
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, on: (l) => listeners.push(l), close: () => ws.close() };
}

for (const [n, t] of matching.entries()) {
  const s = await session(t);
  if (cmd === 'eval') {
    const r = await s.send('Runtime.evaluate', { expression: rest[0], awaitPromise: true, returnByValue: true });
    console.log(`[${n}]`, JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
  } else if (cmd === 'shot') {
    const [file, x, y, w, h] = rest;
    const params = { format: 'png' };
    if (w) params.clip = { x: +x, y: +y, width: +w, height: +h, scale: 1 };
    const r = await s.send('Page.captureScreenshot', params);
    writeFileSync(file.replace('.png', `-${n}.png`), Buffer.from(r.result.data, 'base64'));
    console.log('ok', file);
  } else if (cmd === 'logs') {
    s.on((m) => {
      if (m.method === 'Runtime.consoleAPICalled') console.log(`[${n}] console.${m.params.type}:`, m.params.args.map((a) => a.value ?? a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') console.log(`[${n}] EXCEPTION:`, m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Log.entryAdded') console.log(`[${n}] log.${m.params.entry.level}:`, m.params.entry.text, m.params.entry.url ?? '');
    });
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    await new Promise((r) => setTimeout(r, +rest[0] || 3000));
  }
  s.close();
}
process.exit(0);
