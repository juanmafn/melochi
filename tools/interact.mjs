// Prueba interacciones en el overlay con eventos de ratón sintéticos (CDP Input.dispatchMouseEvent).
//   node interact.mjs <acción>   acciones: state | poke | tickle | pet | inventory | stats | give <slot> | collect
const PORT = 9333;
const action = process.argv[2];
const arg = process.argv[3];
const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const t = targets.find((x) => x.type === 'page' && x.url.includes('overlay'));
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, pointerType: 'mouse', ...extra });

const state = () => ev(`(() => { const m = window.__melochi; const v = m.view(); return { pet: { x: Math.round(m.pet.x), y: Math.round(m.pet.y), h: Math.round(m.pet.height), mode: m.pet.mode, anim: m.pet.animName }, mood: v.mood.id, stats: Object.fromEntries(Object.entries(v.stats).map(([k, x]) => [k, +x.toFixed(1)])), afinidad: +v.afinidad.toFixed(2), inv: v.inventory.map(s => s.item + 'x' + s.cantidad + (s.usosRestantes ? '(' + s.usosRestantes + ')' : '')), ground: v.groundItems.map(g => g.item), bubble: document.querySelector('.bubble.visible')?.textContent ?? null }; })()`);
const center = async () => { const s = await state(); return [s.pet.x, s.pet.y - s.pet.h / 2]; };

async function click(x, y) {
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
}

switch (action) {
  case 'state':
    break;
  case 'poke': {
    const [x, y] = await center();
    await mouse('mouseMoved', x, y, { button: 'none' });
    await click(x, y);
    await sleep(700);
    break;
  }
  case 'tickle': {
    const [x, y] = await center();
    for (let i = 0; i < 3; i++) { await click(x, y); await sleep(120); }
    await sleep(300);
    break;
  }
  case 'pet': {
    const [x, y] = await center();
    for (let n = 0; n < 3; n++) {
      for (let i = 0; i < 6; i++) {
        for (let dx = -25; dx <= 25; dx += 5) await mouse('mouseMoved', x + (i % 2 ? -dx : dx), y, { button: 'none' });
      }
      await sleep(1400);
    }
    break;
  }
  case 'inventory':
  case 'stats':
    await ev(`window.__melochi.openPanel('${action}')`);
    await sleep(200);
    break;
  case 'give': {
    const r = await ev(`(() => { const b = document.querySelectorAll('#panel-inventory .inv-slot')[${+arg || 0}].getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })()`);
    await click(r[0], r[1]);
    await sleep(400);
    break;
  }
  case 'collect': {
    const items = await ev(`[...document.querySelectorAll('.ground-item')].map(e => { const b = e.getBoundingClientRect(); return [b.x + b.width/2, b.y + b.height/2]; })`);
    for (const [x, y] of items) { await click(x, y); await sleep(250); }
    console.log('recogidos', items.length);
    break;
  }
}
console.log(JSON.stringify(await state(), null, 1));
ws.close();
process.exit(0);
