// Pruebas del chat con IA (necesita el juego con --inspect=9334).
//   node tools/chat.mjs say "<mensaje>" [modelo]   → envía un mensaje y muestra la respuesta, la acción y el tiempo
//   node tools/chat.mjs bubble <tema> [modelo]     → genera un comentario espontáneo (idle, song, hambre...)
//   node tools/chat.mjs memory                     → fuerza el resumen y muestra los recuerdos
//   node tools/chat.mjs status                     → estado de Ollama y modelos instalados
//   node tools/chat.mjs file <ruta.json> [modelo]  → envía en orden los mensajes de un JSON (array de textos)
//   node tools/chat.mjs bench <ruta.json> <modelo> [modelo...] → compara modelos: conversación, bocadillos y recuerdos
//     (¡borra la memoria de la mascota de prueba!)
async function main(expr) {
  const t = (await (await fetch('http://127.0.0.1:9334/json/list')).json())[0];
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

const [action, arg, model, ...moreModels] = process.argv.slice(2);
const useModel = (m) => main(`(__melochi.settings.ollama.model = ${JSON.stringify(m)}, __melochi.brain.refreshStatus())`);
if (model && action !== 'bench') await useModel(model);

async function runFile(path) {
  const { readFileSync } = await import('node:fs');
  const msgs = JSON.parse(readFileSync(path, 'utf8'));
  for (const text of msgs) {
    const out = JSON.parse(
      await main(`(async () => {
        const b = __melochi.brain;
        const before = b.messages.length;
        const t0 = Date.now();
        await b.send(${JSON.stringify(text)});
        return JSON.stringify({ ms: Date.now() - t0, new: b.messages.slice(before + 1).map((m) => m.role + ': ' + m.text) });
      })()`),
    );
    console.log(`\n> ${text}   [${(out.ms / 1000).toFixed(1)} s]`);
    for (const line of out.new) console.log(`  ${line}`);
  }
}

switch (action) {
  case 'status':
    console.log(await main(`(async () => JSON.stringify({ status: await __melochi.brain.refreshStatus(), model: __melochi.settings.ollama.model, gpu: __melochi.settings.ollama.useGpu, models: await __melochi.ollama.models().catch(() => []) }))()`));
    break;
  case 'say': {
    const out = await main(`(async () => {
      const b = __melochi.brain;
      const before = b.messages.length;
      const t0 = Date.now();
      await b.send(${JSON.stringify(arg ?? 'hola')});
      const ms = Date.now() - t0;
      return JSON.stringify({ ms, model: __melochi.settings.ollama.model, new: b.messages.slice(before).map((m) => m.role + ': ' + m.text) });
    })()`);
    console.log(out);
    break;
  }
  case 'file':
    await runFile(arg);
    break;
  case 'bench':
    for (const m of [model, ...moreModels]) {
      console.log(`\n==================== ${m} ====================`);
      console.log('estado:', await useModel(m));
      await main(`(__melochi.brain.memory.clear(), 'ok')`);
      const warm = await main(`(async () => { const t0 = Date.now(); await __melochi.brain.warmUp(); return Date.now() - t0; })()`);
      console.log(`carga + caché del prompt: ${(warm / 1000).toFixed(1)} s`);
      await runFile(arg);
      for (const topic of ['idle', 'hambre']) {
        const b = JSON.parse(await main(`(async () => { const t0 = Date.now(); const r = await __melochi.brain.generateBubble(${JSON.stringify(topic)}); return JSON.stringify({ ms: Date.now() - t0, text: r?.bubble ?? null }); })()`));
        console.log(`\nbocadillo ${topic} [${(b.ms / 1000).toFixed(1)} s]: ${b.text}`);
      }
      const mem = JSON.parse(await main(`(async () => { const t0 = Date.now(); await __melochi.brain.summarize(); return JSON.stringify({ ms: Date.now() - t0, facts: __melochi.brain.memory.data.facts }); })()`));
      console.log(`\nrecuerdos [${(mem.ms / 1000).toFixed(1)} s]:`, mem.facts);
    }
    break;
  case 'bubble': {
    const out = await main(`(async () => {
      const t0 = Date.now();
      const r = await __melochi.brain.generateBubble(${JSON.stringify(arg ?? 'idle')});
      return JSON.stringify({ ms: Date.now() - t0, model: __melochi.settings.ollama.model, reaction: r });
    })()`);
    console.log(out);
    break;
  }
  case 'memory':
    console.log(await main(`(async () => { const t0 = Date.now(); await __melochi.brain.summarize(); return JSON.stringify({ ms: Date.now() - t0, facts: __melochi.brain.memory.data.facts }); })()`));
    break;
  default:
    console.log('Acciones: status | say "<mensaje>" [modelo] | bubble <tema> [modelo] | memory');
}
process.exit(0);
