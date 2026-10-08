import type { ChatActionType } from '../../shared/types';

// Los modelos pequeños a veces se inventan acciones que nadie ha pedido (p. ej. poner música al decir "hola").
// Por eso una acción solo se ejecuta si el mensaje del usuario la pide con palabras reconocibles (es/en).

const MUSIC = /\b(pon(me|nos|er|es|ga|gas)?|ponle|toca|reproduc\w*|play|put on|m[uú]sica|music|canci[oó]n|canciones|songs?|tema|temazo|playlist|escuch\w*|listen\w*|artista|artist|disco|album|álbum)\b/i;
const STOP = /\b(para(la| la m[uú]sica| eso| ya)|pararla|pausa\w*|pause|det[eé]n\w*|stop|calla\w*|silencio|quita (la|esa|esto)|ap[aá]ga\w*|shut up|quiet)\b/i;
const RESUME = /\b(reanuda\w*|contin[uú]a\w*|sigue|vuelve a poner|resume|continue|unpause|play again|dale al play)\b/i;
const NEXT = /\b(siguiente|otra canci[oó]n|cambia(la)?|salta(la)?|pasa(la)?|next|skip|another song|change (the )?song)\b/i;
const INVENTORY = /\b(inventario|inventory|objetos|cosas|items?|mochila|bag|stuff)\b/i;
const STATS = /\b(c[oó]mo est[aá]s|qu[eé] tal est[aá]s|estado|stats|barras|status|how are you|how do you feel|necesidades)\b/i;
const HOME = /\b(casa|home|rinc[oó]n|vuelve|vete|go back)\b/i;
const DND = /\b(no (me |nos )?molest\w*|d[eé]jame (en paz|tranquilo|trabajar)|silencio un rato|do not disturb|don'?t disturb|leave me alone|be quiet|stop bothering)\b/i;

const DANCE = /\b(baila\w*|bailar|bailes|bailoteo|menea\w*|mu[eé]vete|dance|dancing|boogie|groove)\b/i;

const RULES: Partial<Record<ChatActionType, RegExp>> = {
  dance: DANCE,
  play_mood: MUSIC,
  play_search: MUSIC,
  pause: STOP,
  resume: RESUME,
  next: NEXT,
  open_inventory: INVENTORY,
  open_stats: STATS,
  go_home: HOME,
  dnd: DND,
};

/**
 * Saca qué música buscar de una petición ("ponme algo de rock de los 80" → "rock de los 80"),
 * por si el modelo elige la acción pero no rellena qué buscar.
 */
export function extractMusicQuery(userText: string): string {
  let q = ` ${userText.toLowerCase()} `;
  q = q.replace(/[¿?¡!.,;:"«»]/g, ' ');
  const fillers = [
    /\b(por favor|porfa|please|pls)\b/g,
    /\b(me|nos|te)\b(?= (pones|pondrías|puedes|apetece))/g,
    /\b(ponme|ponnos|pon|poner|pones|pondrías|ponle|toca|reproduce|play|put on|quiero|me apetece|i want|i'd like|can you|could you|puedes)\b/g,
    /\b(escuchar|oír|listen to)\b/g,
    /\b(algo|alguna|alguna canción|una canción|un poco|some|something|a song|a bit)\b/g,
    /\b(de|del|by|of)\b(?=\s)/,
    /\b(música|music|canciones|songs)\b/g,
  ];
  for (const f of fillers) q = q.replace(f, ' ');
  return q.replace(/\s+/g, ' ').trim();
}

/** ¿El mensaje del usuario pide de verdad esta acción? */
export function userAsked(action: ChatActionType, userText: string): boolean {
  if (action === 'none') return false;
  return RULES[action]?.test(userText) ?? false;
}
