// Prueba de las travesuras de escritorio. Requiere el juego con --inspect=9334 y --remote-debugging-port=9333.
//   node tools/mischief.mjs note            post-it (con IA si está disponible) y quitarlo con un clic
//   node tools/mischief.mjs hide [encontrar] esconderse en un borde de la pantalla
//   node tools/mischief.mjs hidewin         esconderse detrás de tu ventana activa (usa tools/window-test)
//   node tools/mischief.mjs perch           sentarse encima de tu ventana activa (usa tools/window-test)
//   node tools/mischief.mjs run             travesura al azar (sin las de música), como lo haría el juego
//   node tools/mischief.mjs angry|calm      la pone cabreada (y con huida del cursor segura) o la calma
//   node tools/mischief.mjs climb [s]       trepar a una ventana cercana y seguirla (usa tools/window-test)
//   node tools/mischief.mjs dance [s]       pedirle que baile y contar los saltitos al ritmo (tiene que sonar algo)
//   node tools/mischief.mjs knock idle|ignored|angry [responder] [captura.png]   acercarse a la pantalla y tocar el cristal
async function session(port, match) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = match ? targets.find((x) => x.type === 'page' && x.url.includes(match)) : targets[0];
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
  };
  return { send, ev, close: () => ws.close() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const main = await session(9334);
const ov = await session(9333, 'overlay');
const [kind, mode] = process.argv.slice(2);

const bubble = () => ov.ev(`document.querySelector('.bubble.visible')?.innerText ?? null`);
const petState = () =>
  ov.ev(`JSON.stringify({ modo: __melochi.pet.mode, x: Math.round(__melochi.pet.x), y: Math.round(__melochi.pet.y), visible: __melochi.pet.sprite.visible, borde: __melochi.pet.hideEdge, recorte: __melochi.pet.hideClip, encima: __melochi.pet.perch })`);
let lastBubble = '';
async function watch(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const b = await bubble();
    if (b && b !== lastBubble) console.log(`  💬 ${b}`);
    lastBubble = b ?? lastBubble;
    await sleep(250);
  }
}
const M = '__melochi.mischief';

if (kind === 'angry' || kind === 'calm') {
  const angry = kind === 'angry';
  console.log(
    await main.ev(`(() => {
      const g = __melochi.game;
      g.save.stats.mosqueo = ${angry ? 85 : 0};
      g.save.mood = '${angry ? 'cabreada' : 'neutral'}';
      g.config.stats.travesuras.huirDelCursor = ${angry ? 1 : 0.6};
      // Que no haga travesuras por su cuenta mientras se prueba.
      g.lastMischiefAt = Date.now();
      g.adjust({});
      return 'mood ' + g.mood.id + ' · huida ' + g.config.stats.travesuras.huirDelCursor;
    })()`),
  );
} else if (kind === 'note') {
  console.log('IA:', await main.ev(`__melochi.brain.status`));
  const t0 = Date.now();
  console.log('hecha:', await main.ev(`${M}.note()`), `(${Date.now() - t0} ms)`);
  console.log('notas:', await main.ev(`JSON.stringify(__melochi.game.notes)`));
  await watch(1500);
  console.log('en pantalla:', await ov.ev(`JSON.stringify([...document.querySelectorAll('.sticky-note')].map(n => ({ texto: n.innerText.replace(/\\n/g, ' / '), x: n.style.left, y: n.style.top })))`));
  if (mode !== 'dejar') {
    await ov.ev(`(document.querySelector('.sticky-note:not(.crumpled)')?.click(), 'ok')`);
    await watch(1200);
    console.log('tras el clic, notas:', await main.ev(`__melochi.game.notes.length`), '· en pantalla:', await ov.ev(`document.querySelectorAll('.sticky-note').length`));
  }
} else if (kind === 'hide' || kind === 'hidewin') {
  if (kind === 'hide') {
    // Solo en los bordes de la pantalla (sin ventana).
    await main.ev(`(() => { const m = ${M}; const w = m.windowHideSpot; m.windowHideSpot = () => null; const p = m.hide(); m.windowHideSpot = w; return p; })()`);
  } else {
    console.log(
      'escondite en ventana:',
      await main.ev(`(() => {
        const m = ${M}; const s = m.windowHideSpot();
        if (!s) return 'no hay ventana válida';
        m.d.overlays.hidePet(s.displayId, s.x, s.y, s.edge, s.clip);
        m.hidden = { until: Date.now() + 60000, window: s.window };
        return JSON.stringify({ borde: s.edge, x: Math.round(s.x), y: Math.round(s.y), ventana: s.window.rect });
      })()`),
    );
  }
  await watch(2600);
  console.log('  escondida:', await petState(), '· main hiding:', await main.ev(`__melochi.overlays.hiding`));
  if (mode === 'encontrar') {
    console.log('  👆 encontrada:', await main.ev(`${M}.onTouch()`), '· mosqueo', await main.ev(`Math.round(__melochi.game.save.stats.mosqueo)`));
  } else if (kind === 'hide') {
    await main.ev(`(${M}.hidden.until = Date.now(), 'tiempo agotado')`);
  } else {
    console.log('  (esperando a que se mueva o cierre la ventana de prueba)');
  }
  await watch(kind === 'hidewin' && mode !== 'encontrar' ? 12000 : 3000);
  console.log('  después:', await petState(), '· main hiding:', await main.ev(`__melochi.overlays.hiding`));
} else if (kind === 'perch') {
  console.log('sentada:', await main.ev(`${M}.perch()`), '·', await main.ev(`JSON.stringify(__melochi.overlays.perch)`));
  await watch(3000);
  console.log('  arriba:', await petState());
  console.log('  (esperando a que se mueva la ventana de prueba)');
  for (let i = 0; i < 40 && (await main.ev(`!!${M}.perched`)); i++) await sleep(250);
  await watch(2500);
  console.log('  después:', await petState(), '· main perch:', await main.ev(`JSON.stringify(__melochi.overlays.perch)`));
} else if (kind === 'climb') {
  // Trepar a una ventana cercana (mejor con tools/window-test abierta) y seguirla hasta que baje.
  console.log(
    'trepa:',
    await main.ev(`(() => { const c = __melochi.climber; c.d.userActive = () => true; const ok = c.tryClimb(); return ok ? JSON.stringify({ ventana: c.climb.target.rect, subida: __melochi.overlays.perch }) : false; })()`),
  );
  let last = '';
  const end = Date.now() + (Number(mode) || 40) * 1000;
  while (Date.now() < end) {
    const s = await ov.ev(`JSON.stringify({ modo: __melochi.pet.mode, fase: __melochi.pet.climb?.phase ?? null, encima: !!__melochi.pet.perch })`);
    if (s !== last) console.log(`  ${((Date.now() - end) / 1000 + (Number(mode) || 40)).toFixed(1)} s`, s, await petState().then((p) => JSON.parse(p)).then((p) => `x ${p.x} y ${p.y}`));
    last = s;
    const b = await bubble();
    if (b && b !== lastBubble) console.log(`  💬 ${b}`);
    lastBubble = b ?? lastBubble;
    if (!(await main.ev(`__melochi.climber.active`)) && s.includes('"encima":false') && s.includes('idle')) break;
    await sleep(200);
  }
} else if (kind === 'dance') {
  // Pedirle que baile (como desde el menú) y contar los saltitos al ritmo.
  console.log('oye:', await main.ev(`JSON.stringify(__melochi.audio.status)`));
  console.log('pedido:', await main.ev(`__melochi.dancer.request()`));
  // Se apunta cuándo da cada saltito (envolviendo beat() una sola vez aunque se repita la prueba).
  await ov.ev(`(() => { const p = __melochi.pet; window.__hops = []; if (!p.__beat) { p.__beat = p.beat.bind(p); p.beat = (ms) => { p.__beat(ms); if (p.hop && p.hop.t === 0) window.__hops.push(performance.now()); }; } return true; })()`);
  await watch(Number(mode) * 1000 || 10000);
  const hops = await ov.ev(`JSON.stringify(window.__hops)`).then(JSON.parse);
  const gaps = hops.slice(1).map((t, i) => t - hops[i]);
  const avg = gaps.length ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0;
  console.log(`  separación entre saltitos (ms): ${gaps.map(Math.round).join(' ')}`);
  console.log(`saltitos: ${hops.length} · cada ${Math.round(avg)} ms (${avg ? Math.round(60000 / avg) : 0} BPM)`, '· animación:', await ov.ev(`__melochi.pet.animName`), '· oye:', await main.ev(`JSON.stringify(__melochi.audio.status)`));
} else if (kind === 'knock') {
  // Acercarse a la pantalla: node tools/mischief.mjs knock idle|ignored|angry [responder] [captura.png]
  const [reason = 'idle', answer, shot] = process.argv.slice(3);
  console.log('empieza:', await main.ev(`__melochi.knock.start('${reason}')`));
  let last = '';
  let shotDone = false;
  const t0 = Date.now();
  let answered = false;
  while (Date.now() - t0 < 20000) {
    const s = JSON.parse(await ov.ev(`JSON.stringify({ modo: __melochi.pet.mode, fase: __melochi.pet.closeup?.phase ?? null, zoom: Math.round(__melochi.pet.zoom * 10) / 10, x: Math.round(__melochi.pet.x), y: Math.round(__melochi.pet.y), anim: __melochi.pet.animName, huellas: document.querySelectorAll('.glass-mark').length, velo: document.querySelector('.closeup-veil.visible') !== null })`));
    const key = `${s.modo} ${s.fase} ${s.anim}`;
    if (key !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)} s`, JSON.stringify(s));
    last = key;
    const b = await bubble();
    if (b && b !== lastBubble) console.log(`  💬 ${b}`);
    lastBubble = b ?? lastBubble;
    if (s.fase === 'knock' && shot && !shotDone && s.huellas >= 2) {
      shotDone = true;
      await ov.send('Page.captureScreenshot', { format: 'png' }).then((r) => import('node:fs').then((fs) => fs.writeFileSync(shot, Buffer.from(r.result.data, 'base64'))));
      console.log('  📷', shot, `(huellas: ${s.huellas})`);
    }
    if (answer === 'responder' && s.fase === 'knock' && !answered && Date.now() - t0 > 4000) {
      answered = true;
      console.log('  👆 clic en ella:', await main.ev(`__melochi.knock.onTouch()`));
    }
    if (s.modo !== 'closeup' && Date.now() - t0 > 3000 && !(await main.ev(`__melochi.knock.active`))) break;
    await sleep(250);
  }
  await watch(2500);
  console.log('  stats:', await main.ev(`JSON.stringify({ carino: Math.round(__melochi.game.save.stats.carino), mosqueo: Math.round(__melochi.game.save.stats.mosqueo) })`));
} else if (kind === 'run') {
  console.log(
    await main.ev(`(() => {
      const g = __melochi.game; const m = ${M};
      g.config.stats.travesuras.pesos.musica = 0;
      m.d.userActive = () => true;
      g.lastMischiefAt = 0;
      return 'puede: ' + g.canMischief() + ' · mood ' + g.mood.id;
    })()`),
  );
  console.log('hecha:', await main.ev(`${M}.run(false)`));
  await watch(4000);
  console.log('  estado:', await petState(), '· notas', await main.ev(`__melochi.game.notes.length`));
  console.log('  segunda seguida (debe ser false por el tiempo de espera):', await main.ev(`${M}.run(false)`));
}
main.close();
ov.close();
process.exit(0);
