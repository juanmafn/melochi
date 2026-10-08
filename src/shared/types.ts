// Tipos compartidos entre el proceso principal (main) y los renderers.

export type Lang = 'es' | 'en';
export const LANGS: Lang[] = ['es', 'en'];

/** Texto traducible en los archivos de configuración: "Feliz" o { "es": "Feliz", "en": "Happy" }. */
export type Localized = string | Partial<Record<Lang, string>>;

export type StatId = 'hambre' | 'sed' | 'diversion' | 'carino' | 'mosqueo';
export const VISIBLE_STATS = ['hambre', 'sed', 'diversion', 'carino'] as const;
export type VisibleStatId = (typeof VISIBLE_STATS)[number];
export const ALL_STATS: StatId[] = ['hambre', 'sed', 'diversion', 'carino', 'mosqueo'];
export type Stats = Record<StatId, number>;
/** Valores que se pueden usar en condiciones y efectos: las stats más la afinidad. */
export type StatOrAffinity = StatId | 'afinidad';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
  workArea: Rect;
  scaleFactor: number;
  primary: boolean;
}

// ---------- Configuración (config/*.json) ----------

export type Comparison = { '>='?: number; '<='?: number; '>'?: number; '<'?: number };
export type Condition =
  | { todas: Condition[] }
  | { alguna: Condition[] }
  | ({ stat: StatOrAffinity } & Comparison);

export interface MoodBehavior {
  /** 0..1: cuánto se aleja de casa y cuánto pasea. */
  exploracion?: number;
  /** 0..1: probabilidad de hablar sola. */
  habla_sola?: number;
  travesuras?: boolean;
  /** Multiplicador de la velocidad al andar. */
  velocidad?: number;
}

export interface MoodDef {
  id: string;
  nombre: Localized;
  prioridad: number;
  condiciones?: Condition;
  /** Sobrescribe animaciones: { "idle": "feliz_idle" }. */
  animaciones?: Record<string, string>;
  musica?: {
    /** URIs de playlists (además de las que se asignan en la ventana de Música). */
    playlists?: string[];
    modo?: 'sugerir' | 'travesura' | 'ninguno';
    /** Búsquedas de canciones si no hay playlist asignada. */
    busqueda?: string[];
  };
  sonidos?: Record<string, string[]>;
  tono_chat?: string;
  comportamiento?: MoodBehavior;
}

export interface MoodsConfig {
  moods: MoodDef[];
}

export type ItemCategory = 'comida' | 'bebida' | 'juguete' | 'especial';
export type Rarity = 'comun' | 'rara' | 'epica';

export interface ItemEffects {
  stats?: Partial<Record<StatOrAffinity, number>>;
  /** Fija una stat a un valor (p. ej. Banquete → hambre 100). */
  fijar?: Partial<Record<StatId, number>>;
  /** Congela la bajada de algunas stats durante X minutos. */
  congelar?: { stats: StatId[] | 'todas'; minutos: number };
  /** Efectos especiales que dependen de otras fases (p. ej. 'regalarCancion'). */
  especial?: string;
}

export interface ItemDef {
  id: string;
  categoria: ItemCategory;
  rareza: Rarity;
  nombre: Localized;
  descripcion: Localized;
  efectos: ItemEffects;
  /** Usos por unidad (juguetes). */
  usos?: number;
  /** No se gasta al usarlo. */
  permanente?: boolean;
  /** Minutos de espera entre usos (objetos permanentes). */
  cooldownMinutos?: number;
  /** Animación al dárselo. Por defecto: eat / drink / happy según la categoría. */
  animacion?: string;
}

export interface ItemsConfig {
  maxHuecos: number;
  maxPorHueco: number;
  inventarioInicial: { item: string; cantidad: number }[];
  items: ItemDef[];
}

export interface LootTable {
  /** Probabilidad base de soltar algo (0..1). */
  probabilidad: number;
  entradas: { item: string; peso: number }[];
}

export interface LootConfig {
  /** Bonus de probabilidad por mood (id del mood → suma). */
  bonusPorMood: Record<string, number>;
  /** Bonus máximo por afinidad (a afinidad 100). */
  bonusAfinidadMax: number;
  /** Repeticiones de la misma actividad (en la ventana de tiempo) a partir de las que bajan los drops. */
  rendimientoDecreciente: { ventanaMinutos: number; repeticionesLibres: number };
  /** Moods en los que se usa la tabla 'reconciliacion' en vez de la normal. */
  moodsReconciliacion: string[];
  maxEnSuelo: number;
  tablas: Record<string, LootTable>;
}

export type InteractionType = 'pet' | 'tickle' | 'poke' | 'throw' | 'throwHard' | 'fetch' | 'laser';

export type ToyKind = 'pelota' | 'laser';

export interface StatsConfig {
  /** Puntos que baja cada stat por minuto. */
  bajadaPorMinuto: Record<'hambre' | 'sed' | 'diversion' | 'carino', number>;
  mosqueo: {
    /** Por debajo de este valor, una stat visible empieza a mosquearla. */
    umbralBajo: number;
    /** Subida por minuto por cada stat totalmente vacía (proporcional a lo baja que esté). */
    subidaPorMinuto: number;
    /** Si todas las stats visibles están por encima de esto, el mosqueo baja. */
    umbralCalma: number;
    bajadaPorMinuto: number;
  };
  afinidad: {
    subidaPorMinuto: number;
    bajadaPorMinuto: number;
    /** Con afinidad 100, las stats bajan este porcentaje más lento (0.3 = 30 %). */
    modificadorBajada: number;
    /** Afinidad que da cada interacción directa. */
    porInteraccion: number;
  };
  /** Segundos que tiene que mantenerse un mood antes de cambiar. */
  segundosParaCambiarMood: number;
  interacciones: Record<InteractionType, Partial<Record<StatOrAffinity, number>>>;
  /** Probabilidad de que rechace caricias cuando está en un mood con travesuras. */
  rechazoCariciasCabreada: number;
  /** Minutos mínimos entre travesuras (musicales o de escritorio). */
  travesuraCooldownMinutos: number;
  /** Recompensas de los minijuegos. */
  minijuegos: {
    /** Si ganas tú. */
    ganar: StatDelta;
    /** Si gana ella (se lo pasa bien igualmente). */
    perder: StatDelta;
    /** Probabilidad de que haga trampas en piedra-papel-tijera si está mosqueada. */
    trampaRps: number;
    /** Mosqueo a partir del cual puede hacer trampas. */
    trampaDesdeMosqueo: number;
  };
  /** Trepar por el lateral de una ventana y pasear por encima (cuando no está cabreada). */
  trepar: {
    /** Cada cuánto se lo plantea (segundos, entre mínimo y máximo). Con más ganas de explorar, más a menudo. */
    cadaSegundos: [number, number];
    /** Probabilidad de hacerlo cuando se lo plantea, con exploración 1 (se multiplica por la del mood). */
    probabilidad: number;
    /** Cuánto se queda arriba (segundos, entre mínimo y máximo). */
    arribaSegundos: [number, number];
    /** Distancia máxima (px) a la que busca una ventana. */
    distanciaMax: number;
  };
  /** Acercarse a la pantalla y tocar el cristal ("¿estás ahí?"). */
  tocarPantalla: {
    /** Tiempo mínimo entre dos veces (la de travesura va aparte, con las travesuras). */
    cadaMinutos: number;
    /** Si llevas entre estos minutos sin tocar el ratón ni el teclado, mira si sigues ahí. */
    inactivoMinutos: [number, number];
    /** Si estás usando el PC pero no le haces caso en estos minutos y tiene el cariño bajo, te llama. */
    ignoradaMinutos: number;
    carinoBajo: number;
    /** Segundos que espera tocando el cristal a que le hagas caso. */
    esperaSegundos: number;
    /** Si le haces caso (y si no, cuando te estaba llamando). */
    responder: StatDelta;
    ignorar: StatDelta;
  };
  /** Travesuras (cuando está cabreada). Las musicales necesitan Spotify. */
  travesuras: {
    /** Probabilidad relativa de cada tipo. */
    pesos: Record<DesktopMischief, number>;
    /** Probabilidad de que huya cuando acercas el cursor (cabreada). */
    huirDelCursor: number;
    /** Segundos que se queda escondida si no la encuentras. */
    escondidaSegundos: number;
    /** Segundos que se queda sentada encima de tu ventana. */
    sentadaSegundos: number;
    maxNotitas: number;
    /** Mosqueo que se le pasa si la encuentras escondida. */
    encontrarlaMosqueo: number;
  };
  /** Modos seguros: no molestar con algo a pantalla completa o en llamadas. */
  modosSeguros: {
    pantallaCompleta: boolean;
    llamadas: boolean;
    /** Programas que usan el micrófono pero no son una llamada (p. ej. obs64.exe). */
    ignorarMicrofono: string[];
  };
  /** Usos de "No molestar" en 24 h a partir de los cuales se mosquea. */
  noMolestarUsosLibres: number;
  noMolestarMosqueo: number;
}

export type StatDelta = Partial<Record<StatOrAffinity, number>>;
export type MischiefKind = 'pausar' | 'saltar' | 'secuestrar' | 'cola';

export interface MusicConfig {
  /** Nombres de artistas (sin distinguir mayúsculas). */
  artistasFavoritos: string[];
  artistasOdiados: string[];
  /** Segundos entre consultas a Spotify de lo que está sonando. */
  consultaSegundos: number;
  /**
   * Solo sugiere música y hace travesuras musicales si has usado el ratón o el teclado en estos minutos
   * (si no estás delante, no tiene gracia y solo molesta).
   */
  soloSiActivoMinutos: number;
  sugerencias: {
    cooldownMinutos: number;
    /** Si no suena nada durante estos minutos, sugiere música. */
    silencioMinutos: number;
    esperaRespuestaSegundos: number;
    cancionesPorBusqueda: number;
  };
  travesura: {
    busquedas: string[];
    cancionesPorTravesura: number;
    pesos: Record<MischiefKind, number>;
  };
  efectos: {
    aceptar: StatDelta;
    rechazar: StatDelta;
    rechazosParaMosqueo: number;
    mosqueoPorRechazos: number;
    saltarSuCancion: StatDelta;
    abandonarSuMusica: StatDelta;
    artistaFavorito: StatDelta;
    artistaOdiado: StatDelta;
  };
  /** Baile al ritmo del audio del PC (sin estar cabreada). */
  baile: {
    /** Escuchar el audio del PC para sacar el ritmo. */
    activado: boolean;
    duracionSegundos: [number, number];
    /** Tiempo entre bailes espontáneos (minutos, entre mínimo y máximo). */
    cadaMinutos: [number, number];
    /** Segundos seguidos de música antes de animarse a bailar sola. */
    musicaMinimaSegundos: number;
    efectos: StatDelta;
  };
}

/** Lo que oye por el audio del PC (lo manda la ventana oculta de audio). */
export interface AudioStatus {
  /** Hay música con un ritmo claro. */
  music: boolean;
  bpm: number;
  /** Confianza en el ritmo (0..1). */
  confidence: number;
  /** Volumen (RMS 0..1). */
  level: number;
}

/** Trepar a una ventana: coordenadas globales. */
export interface ClimbMessage {
  /** x donde trepa (junto al lateral de la ventana) y lado: 1 = la ventana está a su derecha. */
  x: number;
  side: 1 | -1;
  /** Arriba del todo: ahí se sube (y su "suelo" pasa a ser el borde de la ventana). */
  perch: PerchInfo;
}

// ---------- Estado de juego ----------

export interface InventorySlot {
  item: string;
  cantidad: number;
  /** Usos que le quedan a la unidad de arriba de la pila (juguetes). */
  usosRestantes?: number;
}

export interface GroundItem {
  id: string;
  item: string;
  displayId: number;
  /** Coordenadas globales (DIP) del punto de apoyo del objeto. */
  x: number;
  y: number;
}

export type PetGoal = { kind: 'home' } | { kind: 'wander'; x: number } | { kind: 'cross'; direction: -1 | 1 };

/** Posición y movimiento de la mascota en coordenadas globales (DIP). (x, y) es el punto de apoyo (pies). */
export interface PetPose {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: 'idle' | 'walk' | 'fall';
  facing: 1 | -1;
  goal?: PetGoal | null;
}

export interface InventoryView extends InventorySlot {
  nombre: string;
  descripcion: string;
  categoria: ItemCategory;
  rareza: Rarity;
  favorito: boolean;
  odiado: boolean;
  /** Milisegundos que faltan para poder volver a usarlo. */
  cooldownRestante: number;
  usosPorUnidad?: number;
  permanente: boolean;
}

/** Lo que el renderer necesita saber del juego. Se envía cada vez que cambia algo. */
export interface GameView {
  petName: string;
  lang: Lang;
  stats: Stats;
  afinidad: number;
  mood: {
    id: string;
    nombre: string;
    animaciones: Record<string, string>;
    comportamiento: Required<Pick<MoodBehavior, 'exploracion' | 'velocidad'>> & MoodBehavior;
  };
  inventory: InventoryView[];
  maxSlots: number;
  groundItems: GroundItem[];
  /** Post-its que ha dejado (travesura). */
  notes: StickyNote[];
  /** Probabilidad de que huya del cursor ahora (0 si no está cabreada). */
  fleeChance: number;
  /** Nombres traducidos de todos los objetos (id → nombre). */
  itemNames: Record<string, string>;
  /** Casa: monitor y x global. */
  home: { displayId: number; x: number };
  dndUntil: number;
  /** Si está en silencio y por qué (No molestar, pantalla completa, llamada). */
  quiet: QuietReason | null;
  muted: boolean;
  volume: number;
  music: MusicView;
  /** Textos de la interfaz en el idioma actual. */
  ui: Record<string, string>;
}

export type QuietReason = 'dnd' | 'fullscreen' | 'call';

export interface MusicView {
  connected: boolean;
  track: { name: string; artists: string[] } | null;
  isPlaying: boolean;
  /** La está poniendo ella. */
  hers: boolean;
  /** Opinión de la mascota sobre lo que suena. */
  opinion: 'favorito' | 'odiado' | null;
}

export interface Choice {
  id: string;
  label: string;
}

export interface Reaction {
  anim?: string;
  /** Cuánto dura la animación (ms). Por defecto, lo que dure la animación (mín. 1,2 s). */
  animMs?: number;
  bubble?: string;
  sound?: string;
  /** Botones en el bocadillo (p. ej. aceptar o rechazar una sugerencia de música). */
  choices?: Choice[];
  promptId?: string;
  /** Cuánto se queda el bocadillo (ms). */
  durationMs?: number;
}

export interface OverlayInit {
  display: DisplayInfo;
  displays: DisplayInfo[];
  /** Número de versión de la skin (cambia al recargarla). */
  skinVersion: number;
  /** Si la mascota está en este monitor, su posición actual. */
  own: PetPose | null;
}

export interface OwnMessage {
  pose: PetPose;
  /** Aparece con efecto (teletransporte a casa). */
  appear?: 'poof';
  /** Llega mientras la están arrastrando. */
  dragging?: boolean;
  /** Escondite: se queda asomando por un borde de la pantalla o por detrás de la barra de tareas. */
  hide?: HideEdge;
  /**
   * Parte de la pantalla (global) en la que se la ve mientras está escondida. Así parece que asoma por detrás
   * de una ventana. Sin ella, se ve todo (salvo con 'bottom', que se recorta por debajo del suelo).
   */
  hideClip?: Rect;
  /** Encima de una ventana: ese es su suelo (y global) y solo anda entre minX y maxX (globales). */
  perch?: PerchInfo;
}

export interface PerchInfo {
  y: number;
  minX: number;
  maxX: number;
}

/** Post-it de la mascota en el escritorio (travesura). Coordenadas globales de su esquina superior izquierda. */
export interface StickyNote {
  id: string;
  displayId: number;
  x: number;
  y: number;
  text: string;
  /** Inclinación en grados. */
  rot: number;
}

export type DesktopMischief = 'musica' | 'esconderse' | 'sentarse' | 'notita' | 'golpear';

/**
 * Se acerca a la pantalla (se hace grande) y toca el cristal. `knock` = "¿estás ahí?" (suave),
 * `angry` = golpea el cristal (travesura).
 */
export interface CloseUpMessage {
  kind: 'knock' | 'angry';
  /** Tiempo máximo tocando el cristal antes de volver (si main no la avisa antes). */
  waitMs: number;
}

export type HideEdge = 'left' | 'right' | 'bottom';

export type MinigameKind = 'rps' | 'song' | 'hide';
/** Juegos en el chat (los conduce la IA). */
export type ChatGameKind = 'riddles' | 'trivia' | 'story';

/** Pista "frío/caliente" del escondite, junto al cursor (coordenadas locales). */
export interface HintMessage {
  x: number;
  y: number;
  text: string;
}

export type PanelId = 'inventory' | 'stats';

// ---------- Cerebro (IA local con Ollama) ----------

export interface BrainConfig {
  /** Mensajes de la conversación actual que se envían al modelo. */
  historialMensajes: number;
  /** Máximo de recuerdos que guarda sobre ti. */
  maxRecuerdos: number;
  /** Cada cuántos mensajes tuyos actualiza sus recuerdos. */
  resumirCadaMensajes: number;
  /** Minutos sin hablar tras los que actualiza sus recuerdos. */
  resumirTrasInactividadMinutos: number;
  temperatura: number;
  /** Tokens máximos de una respuesta del chat. */
  maxTokensChat: number;
  /** Probabilidad de que un comentario espontáneo lo escriba la IA (si no, frase fija). */
  probabilidadBocadilloIA: number;
  /** Probabilidad de que comente una canción nueva. */
  probabilidadComentarCancion: number;
  /** Cariño que da cada mensaje (con rendimiento decreciente). */
  efectosPorMensaje: StatDelta;
}

export type BrainStatus = 'online' | 'offline' | 'nomodel' | 'disabled';

export type ChatActionType =
  | 'none'
  | 'play_mood'
  | 'play_search'
  | 'pause'
  | 'resume'
  | 'next'
  | 'open_inventory'
  | 'open_stats'
  | 'go_home'
  | 'dnd'
  | 'dance';

export interface ChatMessage {
  role: 'user' | 'pet' | 'system';
  text: string;
  at: number;
}

export interface ChatWindowState {
  petName: string;
  moodName: string;
  status: BrainStatus;
  model: string;
  busy: boolean;
  messages: ChatMessage[];
  strings: Record<string, string>;
}

// ---------- Ventana de Música ----------

export interface PlaylistRef {
  uri: string;
  name: string;
  owner?: string;
}

export interface MusicWindowState {
  connected: boolean;
  user: string | null;
  clientId: string;
  redirectUri: string;
  /** Moods que sugieren música, con sus playlists asignadas. */
  moods: { id: string; nombre: string; playlists: PlaylistRef[]; busqueda: string[] }[];
  /** Playlists de tu biblioteca (solo si hay conexión). */
  library: PlaylistRef[];
  favoritos: string[];
  odiados: string[];
  strings: Record<string, string>;
  error: string | null;
}

// ---------- Skins ----------

/** Un frame ya resuelto. Si w/h son 0, se usa la imagen entera (frames sueltos). */
export interface SkinFrame {
  /** Ruta de la imagen relativa a la carpeta de la skin. */
  image: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tamaño original antes del recorte (sprite sheets "trimmed"). 0 = igual que w/h. */
  sourceW: number;
  sourceH: number;
  /** Desplazamiento del recorte dentro del tamaño original. */
  offX: number;
  offY: number;
  /** Duración en ms (Aseprite). Si no hay, se usa fps. */
  duration?: number;
}

export interface SkinAnimation {
  fps: number;
  loop: boolean;
  frames: SkinFrame[];
  /**
   * Escala propia de la animación (se multiplica por la de la skin). Sirve para dibujar a más resolución
   * las que se ven en grande (acercarse a la pantalla): p. ej. frames 4 veces más grandes con 0.25.
   */
  escala: number;
}

export interface SkinManifest {
  id: string;
  nombre: string;
  escala: number;
  /** Punto de apoyo normalizado (0.5, 1 = centro de los pies). */
  ancla: [number, number];
  animaciones: Record<string, SkinAnimation>;
  sonidos: Record<string, string[]>;
  version: number;
  /** Problemas encontrados al cargar (se muestran en consola). */
  errores: string[];
}
