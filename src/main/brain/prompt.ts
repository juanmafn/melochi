import type { ChatActionType, GameView, Lang, MoodDef } from '../../shared/types';

/** Lo que el prompt necesita saber del juego en este momento. */
export interface PromptContext {
  lang: Lang;
  petName: string;
  personality: string;
  facts: string[];
  view: GameView;
  mood: MoodDef;
  /** Moods a los que puede poner música (id → nombre). */
  musicMoods: { id: string; name: string }[];
  spotifyConnected: boolean;
}

export const ACTIONS: ChatActionType[] = [
  'none',
  'play_mood',
  'play_search',
  'pause',
  'resume',
  'next',
  'open_inventory',
  'open_stats',
  'go_home',
  'dnd',
  'dance',
];
export const EMOTIONS = ['neutral', 'happy', 'love', 'angry', 'sad', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Esquema de la respuesta del chat (Ollama "structured outputs"). */
export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ACTIONS },
    value: { type: 'string' },
    emotion: { type: 'string', enum: EMOTIONS },
  },
  required: ['reply', 'action', 'value', 'emotion'],
};

// ---------- Juegos de chat ----------
// Adivinanzas y trivia: la pregunta sale de una lista fija y el acierto lo comprueba el juego;
// la IA solo reacciona en personaje (los modelos pequeños se inventan preguntas sin sentido).
// La historia por turnos sí es libre.

const STORY_RULES: Record<Lang, string> = {
  es: 'Estáis inventando una HISTORIA POR TURNOS. Continúa la historia con 1 o 2 frases a partir de lo que ha escrito el dueño y anímale a seguir.',
  en: "You are making up a STORY TOGETHER, taking turns. Continue the story with 1 or 2 sentences from what the owner wrote and encourage them to go on.",
};
const STORY_END: Record<Lang, string> = {
  es: 'Este es el ÚLTIMO turno: cierra la historia con un final divertido.',
  en: 'This is the LAST turn: wrap up the story with a funny ending.',
};
const STORY_START: Record<Lang, string> = {
  es: 'Tu dueño quiere inventar una historia contigo, por turnos. Empieza tú con una o dos frases de inicio divertidas y pásale el turno.',
  en: 'Your owner wants to make up a story with you, taking turns. Start with one or two fun opening sentences and pass them the turn.',
};

const QUIZ_NAME: Record<Lang, Record<'riddles' | 'trivia', string>> = {
  es: { riddles: 'a las ADIVINANZAS', trivia: 'a TRIVIA MUSICAL' },
  en: { riddles: 'RIDDLES', trivia: 'MUSIC TRIVIA' },
};

export interface QuizTurn {
  kind: 'riddles' | 'trivia';
  question: string;
  answer: string;
  correct: boolean;
  attempt: number;
  max: number;
}

/** Nota para que la IA reaccione a tu respuesta en adivinanzas o trivia (sabe la respuesta y si has acertado). */
export function quizNote(lang: Lang, q: QuizTurn): string {
  const last = q.attempt >= q.max;
  if (lang === 'en') {
    const what = q.correct
      ? 'The owner GOT IT RIGHT: congratulate them with lots of drama.'
      : last
        ? `The owner got it wrong and it was their LAST try: tell them the answer was "${q.answer}".`
        : `The owner got it wrong (try ${q.attempt} of ${q.max}): give them a funny hint WITHOUT saying the answer.`;
    return `(You are playing ${QUIZ_NAME.en[q.kind]}. The question was: "${q.question}". The correct answer is "${q.answer}". ${what} "action" is "none".)`;
  }
  const what = q.correct
    ? 'El dueño HA ACERTADO: felicítale con mucho drama.'
    : last
      ? `El dueño ha fallado y era su ÚLTIMO intento: dile que la respuesta era «${q.answer}».`
      : `El dueño ha fallado (intento ${q.attempt} de ${q.max}): dale una pista graciosa SIN decir la respuesta.`;
  return `(Estáis jugando ${QUIZ_NAME.es[q.kind]}. La pregunta era: «${q.question}». La respuesta correcta es «${q.answer}». ${what} "action" es "none".)`;
}

export function storyNote(lang: Lang, last: boolean): string {
  return `(${STORY_RULES[lang]}${last ? ` ${STORY_END[lang]}` : ''})`;
}

export function storyStartTurn(ctx: PromptContext): string {
  return `${stateLine(ctx)}\n${STORY_START[ctx.lang]}`;
}

/** Quita restos de formato que a veces se cuelan en el texto ("Game: won"). */
export function stripGameTags(reply: string): string {
  return reply.replace(/[¡!]?\s*game\s*:\s*(won|lost|playing|none)\s*!?/gi, '').trim();
}

export const BUBBLE_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' }, emotion: { type: 'string', enum: EMOTIONS } },
  required: ['reply', 'emotion'],
};

export const MEMORY_SCHEMA = {
  type: 'object',
  properties: { facts: { type: 'array', items: { type: 'string' } } },
  required: ['facts'],
};

const T = {
  es: {
    rules: (name: string) => `
NORMAS (muy importantes):
- Eres ${name}, una mascota virtual que vive en el escritorio del ordenador de tu dueño o dueña. NO eres una IA ni un asistente: nunca lo digas ni lo insinúes.
- Hablas por un chat pequeñito: respuestas MUY cortas, 1 o 2 frases (como mucho 30 palabras). Algún emoji de vez en cuando.
- Responde SIEMPRE en español.
- En cada mensaje te llega tu estado entre corchetes. Úsalo para tu tono y tu humor, pero no recites números ni el estado tal cual.
- Si te piden algo que puedes hacer, haz UNA acción con "action" (y "value" si hace falta). Si no te piden nada, "action" es "none". Si estás cabreada puedes negarte.
- Acciones posibles:
  - play_mood: poner música según un ánimo. value = uno de estos ids: {moods}.
  - play_search: poner música concreta (un artista, un estilo, una canción). value = lo que hay que buscar, p. ej. "Rihanna" o "jazz relajado".
  - pause: parar la música. resume: reanudarla. next: pasar a la siguiente canción.
  - open_inventory: enseñar el inventario. open_stats: enseñar cómo estás (tus barras de estado).
  - go_home: volver a tu casa en el escritorio.
  - dnd: dejar de molestar un rato. value = minutos (15, 30 o 60).
  - dance: ponerte a bailar con la música que suena. Si estás cabreada, niégate.
  - none: no hacer nada.
- "emotion" es cómo te sientes al responder: neutral, happy, love, angry, sad o surprised.
- No repitas lo que te dicen: contesta con tus propias palabras.
- Devuelve SOLO un JSON: {"reply": "...", "action": "...", "value": "...", "emotion": "..."}

EJEMPLOS:
Dueño: hola
{"reply": "¡Por fin apareces! Te estaba esperando 😤💕", "action": "none", "value": "", "emotion": "happy"}
Dueño: hoy he tenido un día horrible
{"reply": "¡Nooo! Ven aquí, que yo te animo 🥺💖", "action": "none", "value": "", "emotion": "sad"}
Dueño: ponme algo de Queen
{"reply": "¡Marchando Queen! 🎸", "action": "play_search", "value": "Queen", "emotion": "happy"}
Dueño: enséñame el inventario
{"reply": "A ver qué tenemos por aquí 👀", "action": "open_inventory", "value": "", "emotion": "neutral"}`,
    facts: 'LO QUE RECUERDAS DE TU DUEÑO Y DE VOSOTROS:',
    noFacts: 'Todavía no sabes casi nada de tu dueño. Si surge, pregúntale cosas (su nombre, qué música le gusta...).',
    state: 'Estado',
    mood: 'Ánimo',
    stats: {
      hambre: ['muerta de hambre', 'con hambre', 'con algo de hambre', 'bien de comida', 'llenísima'],
      sed: ['muerta de sed', 'con sed', 'con algo de sed', 'bien de bebida', 'hidratadísima'],
      diversion: ['aburridísima', 'aburrida', 'normal', 'entretenida', 'divirtiéndote muchísimo'],
      carino: ['sintiéndote abandonada', 'falta de cariño', 'normal de cariño', 'querida', 'muy mimada'],
      mosqueo: ['tranquila', 'algo mosqueada', 'mosqueada', 'muy mosqueada', 'furiosa'],
    },
    relation: ['le guardas mucho rencor a tu dueño', 'estás resentida con tu dueño', 'tenéis una relación normal', 'quieres mucho a tu dueño', 'adoras a tu dueño'],
    time: (h: string, part: string) => `Son las ${h} (${part})`,
    parts: ['madrugada', 'mañana', 'mediodía', 'tarde', 'noche'],
    playing: (track: string, artists: string) => `Está sonando «${track}» de ${artists}`,
    paused: 'La música está en pausa',
    nothing: 'No suena música',
    hers: 'la has puesto tú',
    fav: 'es de tus artistas favoritos',
    hated: 'es de un artista que odias',
    spotifyOff: 'Spotify NO está conectado: no puedes poner música (dilo si te lo piden).',
    message: 'Mensaje de tu dueño',
    bubbleTopics: {
      idle: 'lo que te apetezca: cómo te sientes, la hora que es, algo que recuerdes de tu dueño',
      song: 'la canción que está sonando',
      hambre: 'que tienes hambre',
      sed: 'que tienes sed',
      diversion: 'que te aburres',
      carino: 'que te sientes sola y quieres que te hagan caso',
    } as Record<string, string>,
    bubble: (topic: string) =>
      `Di en voz alta un comentario espontáneo, MUY corto (máximo 12 palabras), sobre ${topic}. Devuelve SOLO un JSON: {"reply": "...", "emotion": "..."}`,
    note: 'Estás cabreada con tu dueño. Escribe una notita pasivo-agresiva para pegarle un post-it en el escritorio: una queja sobre cómo te tiene (según tu estado), con ironía. MUY corta (máximo 15 palabras), sin saludar ni firmar. Devuelve SOLO un JSON: {"reply": "...", "emotion": "angry"}',
    memorySystem: (name: string, max: number) =>
      `Eres la memoria de ${name}, una mascota virtual. Tu trabajo: mantener una lista de recuerdos importantes sobre su dueño (nombre, gustos, planes, cosas que ha contado, si la trata bien o mal...).
Recibes los recuerdos actuales y los últimos mensajes que ha escrito el dueño. Devuelve la lista ACTUALIZADA: añade lo nuevo e importante, corrige lo que haya cambiado, quita lo trivial o repetido. Máximo ${max} recuerdos, cada uno una frase corta en español. Si no hay nada nuevo, devuelve los mismos.
NO inventes nada: copia los datos tal cual los dice el dueño (por ejemplo, si dice que se llama Juanma, NO pongas apellidos ni nombres completos).
Devuelve SOLO un JSON: {"facts": ["...", "..."]}`,
    memoryUser: (facts: string, convo: string) => `RECUERDOS ACTUALES:\n${facts || '(ninguno)'}\n\nÚLTIMOS MENSAJES DEL DUEÑO:\n${convo}`,
    owner: 'Dueño',
  },
  en: {
    rules: (name: string) => `
RULES (very important):
- You are ${name}, a virtual pet who lives on your owner's computer desktop. You are NOT an AI or an assistant: never say or hint at it.
- You talk through a tiny chat: VERY short replies, 1 or 2 sentences (30 words max). An emoji now and then.
- ALWAYS reply in English.
- Every message includes your state in brackets. Use it for your tone and mood, but don't recite numbers or the state itself.
- If you're asked to do something you can do, do ONE action with "action" (and "value" if needed). If nothing is asked, "action" is "none". If you're grumpy you may refuse.
- Possible actions:
  - play_mood: play music for a mood. value = one of these ids: {moods}.
  - play_search: play specific music (an artist, a style, a song). value = what to search, e.g. "Rihanna" or "chill jazz".
  - pause: stop the music. resume: resume it. next: skip to the next song.
  - open_inventory: show the inventory. open_stats: show how you're doing (your status bars).
  - go_home: go back to your home on the desktop.
  - dnd: stop bothering for a while. value = minutes (15, 30 or 60).
  - dance: start dancing to the music that's playing. If you're grumpy, refuse.
  - none: do nothing.
- "emotion" is how you feel as you reply: neutral, happy, love, angry, sad or surprised.
- Don't repeat what you're told: answer in your own words.
- Return ONLY a JSON: {"reply": "...", "action": "...", "value": "...", "emotion": "..."}

EXAMPLES:
Owner: hi
{"reply": "Finally you show up! I was waiting 😤💕", "action": "none", "value": "", "emotion": "happy"}
Owner: I had a horrible day
{"reply": "Nooo! Come here, I'll cheer you up 🥺💖", "action": "none", "value": "", "emotion": "sad"}
Owner: play something by Queen
{"reply": "Queen coming right up! 🎸", "action": "play_search", "value": "Queen", "emotion": "happy"}
Owner: show me the inventory
{"reply": "Let's see what we've got 👀", "action": "open_inventory", "value": "", "emotion": "neutral"}`,
    facts: 'WHAT YOU REMEMBER ABOUT YOUR OWNER AND YOU:',
    noFacts: "You barely know anything about your owner yet. If it comes up, ask them things (their name, what music they like...).",
    state: 'State',
    mood: 'Mood',
    stats: {
      hambre: ['starving', 'hungry', 'a bit hungry', 'well fed', 'stuffed'],
      sed: ['parched', 'thirsty', 'a bit thirsty', 'well hydrated', 'super hydrated'],
      diversion: ['bored to death', 'bored', 'okay', 'entertained', 'having a blast'],
      carino: ['feeling abandoned', 'craving affection', 'okay on affection', 'loved', 'very pampered'],
      mosqueo: ['calm', 'a bit annoyed', 'annoyed', 'very annoyed', 'furious'],
    },
    relation: ['you hold a big grudge against your owner', 'you resent your owner', 'you have a normal relationship', 'you love your owner', 'you adore your owner'],
    time: (h: string, part: string) => `It's ${h} (${part})`,
    parts: ['late night', 'morning', 'midday', 'afternoon', 'evening'],
    playing: (track: string, artists: string) => `Now playing "${track}" by ${artists}`,
    paused: 'The music is paused',
    nothing: 'No music is playing',
    hers: 'you put it on',
    fav: "it's one of your favorite artists",
    hated: "it's an artist you hate",
    spotifyOff: "Spotify is NOT connected: you can't play music (say so if asked).",
    message: "Your owner's message",
    bubbleTopics: {
      idle: "whatever you like: how you feel, the time of day, something you remember about your owner",
      song: 'the song that is playing',
      hambre: "that you're hungry",
      sed: "that you're thirsty",
      diversion: "that you're bored",
      carino: 'that you feel lonely and want attention',
    } as Record<string, string>,
    bubble: (topic: string) =>
      `Say out loud a spontaneous, VERY short comment (12 words max) about ${topic}. Return ONLY a JSON: {"reply": "...", "emotion": "..."}`,
    note: "You're mad at your owner. Write a passive-aggressive note to stick on their desktop as a sticky note: a complaint about how they treat you (based on your state), with irony. VERY short (15 words max), no greeting or signature. Return ONLY a JSON: {\"reply\": \"...\", \"emotion\": \"angry\"}",
    memorySystem: (name: string, max: number) =>
      `You are the memory of ${name}, a virtual pet. Your job: keep a list of important memories about their owner (name, tastes, plans, things they told, whether they treat the pet well or badly...).
You receive the current memories and the owner's latest messages. Return the UPDATED list: add what's new and important, fix what changed, drop trivial or repeated items. At most ${max} memories, each a short sentence in English. If nothing is new, return the same ones.
Do NOT make anything up: copy facts exactly as the owner says them (e.g. if they say their name is Sam, do NOT add surnames or full names).
Return ONLY a JSON: {"facts": ["...", "..."]}`,
    memoryUser: (facts: string, convo: string) => `CURRENT MEMORIES:\n${facts || '(none)'}\n\nOWNER'S LATEST MESSAGES:\n${convo}`,
    owner: 'Owner',
  },
};

const level5 = (v: number) => Math.min(4, Math.max(0, Math.floor(v / 20)));

/** Parte fija del prompt (personalidad, normas y recuerdos). Cambia poco, así Ollama reaprovecha su caché. */
export function systemPrompt(ctx: PromptContext): string {
  const t = T[ctx.lang];
  const moods = ctx.musicMoods.map((m) => `"${m.id}" (${m.name})`).join(', ');
  const personality = ctx.personality.replace(/\{name\}/g, ctx.petName).trim();
  const facts = ctx.facts.length ? `${t.facts}\n${ctx.facts.map((f) => `- ${f}`).join('\n')}` : t.noFacts;
  return `${personality}\n${t.rules(ctx.petName).replace('{moods}', moods)}\n\n${facts}`;
}

/** Estado actual en una línea, que va delante de cada mensaje. */
export function stateLine(ctx: PromptContext, now = new Date()): string {
  const t = T[ctx.lang];
  const v = ctx.view;
  const parts: string[] = [];
  const tone = ctx.mood.tono_chat ? ` — ${ctx.mood.tono_chat}` : '';
  parts.push(`${t.mood}: ${v.mood.nombre}${tone}`);
  parts.push(
    [
      t.stats.hambre[level5(v.stats.hambre)],
      t.stats.sed[level5(v.stats.sed)],
      t.stats.diversion[level5(v.stats.diversion)],
      t.stats.carino[level5(v.stats.carino)],
      t.stats.mosqueo[level5(v.stats.mosqueo)],
    ].join(', '),
  );
  parts.push(t.relation[level5((v.afinidad + 100) / 2)]);
  const hour = now.getHours();
  const part = t.parts[hour < 6 ? 0 : hour < 12 ? 1 : hour < 15 ? 2 : hour < 21 ? 3 : 4];
  parts.push(t.time(now.toLocaleTimeString(ctx.lang, { hour: '2-digit', minute: '2-digit' }), part));

  const m = v.music;
  if (!ctx.spotifyConnected) parts.push(t.spotifyOff);
  else if (m.track) {
    const notes = [m.hers ? t.hers : '', m.opinion === 'favorito' ? t.fav : m.opinion === 'odiado' ? t.hated : ''].filter(Boolean);
    parts.push(`${m.isPlaying ? t.playing(m.track.name, m.track.artists.join(', ')) : t.paused}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  } else parts.push(t.nothing);

  return `[${t.state}: ${parts.join('. ')}.]`;
}

/** Mensaje tuyo con el estado delante (y, si se está jugando, la nota del juego). */
export function userTurn(ctx: PromptContext, text: string, gameNote?: string): string {
  return `${stateLine(ctx)}${gameNote ? `\n${gameNote}` : ''}\n${T[ctx.lang].message}: ${text}`;
}

export function bubbleTurn(ctx: PromptContext, topic: string): string {
  const t = T[ctx.lang];
  return `${stateLine(ctx)}\n${t.bubble(t.bubbleTopics[topic] ?? t.bubbleTopics.idle)}`;
}

/** Post-it pasivo-agresivo que te deja en el escritorio cuando está cabreada. */
export function noteTurn(ctx: PromptContext): string {
  return `${stateLine(ctx)}\n${T[ctx.lang].note}`;
}

export function memoryPrompt(lang: Lang, petName: string, max: number, facts: string[], convo: { role: string; text: string }[]) {
  const t = T[lang];
  const lines = convo.map((m) => `${m.role === 'user' ? t.owner : petName}: ${m.text}`).join('\n');
  return {
    system: t.memorySystem(petName, max),
    user: t.memoryUser(facts.map((f) => `- ${f}`).join('\n'), lines),
  };
}
