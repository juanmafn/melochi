import type { MischiefKind, MoodDef, MusicConfig } from '../../shared/types';
import type { Game } from '../game';
import type { I18n } from '../i18n';
import type { Settings } from '../save';
import { SpotifyError, type PlaybackState, type SpotifyApi, type SpotifyTrack } from './api';
import type { SpotifyAuth } from './auth';

/** Música que ha puesto ella (para saber si la saltas o la quitas). */
interface HerSession {
  kind: 'sugerencia' | 'travesura' | 'regalo';
  moodId: string;
  uris: Set<string>;
  contextUri: string | null;
}

export type PlayResult = 'ok' | 'nodevice' | 'nomusic' | 'error';

const MINUTE = 60_000;
/** Durante este tiempo tras una acción suya, los cambios de canción son cosa de ella. */
const OWN_ACTION_MS = 10_000;
/** Si quedaban más de estos ms de canción al cambiar, es que la has saltado. */
const SKIP_MARGIN_MS = 20_000;
const TASTE_BUBBLE_GAP = 3 * MINUTE;
/** Cuánto baila cuando suena un artista que le encanta. */
const DANCE_MS = 8000;

function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pick = <T>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)];
const norm = (s: string) => s.trim().toLowerCase();

/**
 * Decide qué hace la mascota con tu música: sugerir según su mood, reaccionar a lo que suena
 * según sus gustos, mosquearse si saltas su canción y hacer travesuras cuando está cabreada.
 */
export class MusicDirector {
  state: PlaybackState | null = null;
  private her: HerSession | null = null;
  private prompt: { id: string; moodId: string; expiresAt: number } | null = null;
  private lastSuggestAt = 0;
  private declines = 0;
  private silenceSince = Date.now();
  private ownActionUntil = 0;
  private lastTasteUri = '';
  private lastTasteBubbleAt = 0;
  private nextPollAt = 0;
  private polling = false;
  private busy = false;
  private lastError = '';

  constructor(
    private game: Game,
    private api: SpotifyApi,
    private auth: SpotifyAuth,
    private i18n: I18n,
    private settings: Settings,
    /** Segundos desde la última vez que usaste el ratón o el teclado. */
    private idleSeconds: () => number,
  ) {}

  /** ¿Estás delante del ordenador? (has usado el ratón o el teclado hace poco) */
  private get userActive(): boolean {
    return this.idleSeconds() < this.cfg.soloSiActivoMinutos * 60;
  }

  get connected(): boolean {
    return this.auth.connected;
  }

  private get cfg(): MusicConfig {
    return this.game.config.music;
  }

  // ---------- Consulta periódica de lo que suena ----------

  /** Se llama cada segundo desde el bucle principal. */
  tick(): void {
    if (!this.connected) {
      this.state = null;
      this.her = null;
      this.publish();
      return;
    }
    const now = Date.now();
    if (now >= this.nextPollAt) void this.poll();
    if (this.prompt && now > this.prompt.expiresAt) this.prompt = null;

    // Si no estás delante, ni sugiere ni hace travesuras.
    if (!this.userActive) return;
    const mood = this.game.mood;
    const silence = this.cfg.sugerencias.silencioMinutos * MINUTE;
    if (mood.musica?.modo === 'sugerir' && !this.state?.isPlaying && now - this.silenceSince > silence) void this.suggest();
    if (mood.musica?.modo === 'travesura' && this.game.canMischief()) void this.mischief();
  }

  async poll(force = false): Promise<void> {
    if (!this.connected || this.polling || (!force && Date.now() < this.nextPollAt)) return;
    this.polling = true;
    this.nextPollAt = Date.now() + this.cfg.consultaSegundos * 1000;
    try {
      const prev = this.state;
      this.state = await this.api.playback();
      this.lastError = '';
      this.onPlayback(prev, this.state);
    } catch (err) {
      const msg = String(err);
      if (msg !== this.lastError && !(err instanceof SpotifyError && err.status === 429)) console.warn('[música]', msg);
      this.lastError = msg;
    } finally {
      this.polling = false;
      this.publish();
    }
  }

  /** Consulta ya lo que suena (esperando a que termine una consulta en curso si la hay). */
  async refreshNow(): Promise<void> {
    for (let i = 0; this.polling && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
    await this.poll(true);
  }

  private isHers(track: SpotifyTrack | null | undefined, contextUri: string | null | undefined): boolean {
    if (!this.her || !track) return false;
    return this.her.uris.has(track.uri) || (!!this.her.contextUri && this.her.contextUri === contextUri);
  }

  private opinion(track: SpotifyTrack | null | undefined): { kind: 'favorito' | 'odiado'; artist: string } | null {
    if (!track) return null;
    const favs = this.cfg.artistasFavoritos.map(norm);
    const hated = this.cfg.artistasOdiados.map(norm);
    const fav = track.artists.find((a) => favs.includes(norm(a)));
    if (fav) return { kind: 'favorito', artist: fav };
    const bad = track.artists.find((a) => hated.includes(norm(a)));
    return bad ? { kind: 'odiado', artist: bad } : null;
  }

  private onPlayback(prev: PlaybackState | null, cur: PlaybackState | null): void {
    const now = Date.now();
    if (cur?.isPlaying) this.silenceSince = now;
    const prevTrack = prev?.track;
    const curTrack = cur?.track;
    if (!curTrack || curTrack.uri === prevTrack?.uri) return;

    // Ha cambiado la canción: ¿era suya y no la ha cambiado ella?
    if (prev && prevTrack && this.isHers(prevTrack, prev.contextUri) && now > this.ownActionUntil) {
      const progress = prev.progressMs + (prev.isPlaying ? now - prev.at : 0);
      const skipped = prevTrack.durationMs - progress > SKIP_MARGIN_MS;
      const stillHers = this.isHers(curTrack, cur.contextUri);
      if (skipped && stillHers) {
        this.game.adjust(this.cfg.efectos.saltarSuCancion);
        this.game.say({ anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('musicSkipped') });
      } else if (skipped) {
        this.game.adjust(this.cfg.efectos.abandonarSuMusica);
        this.game.say({ anim: 'talk', bubble: this.i18n.bubble('musicAbandoned') });
      }
    }
    if (this.her && !this.isHers(curTrack, cur.contextUri) && now > this.ownActionUntil) this.her = null;
    if (cur.isPlaying) {
      this.reactToTaste(curTrack);
      this.onNewTrack?.(!!this.opinion(curTrack));
    }
  }

  /** Aviso de canción nueva (para que la IA la comente). `hasOpinion`: ya ha reaccionado por sus gustos. */
  onNewTrack: ((hasOpinion: boolean) => void) | null = null;

  /** Reacciona una vez a cada canción de un artista que le gusta o que odia. */
  private reactToTaste(track: SpotifyTrack): void {
    if (track.uri === this.lastTasteUri) return;
    this.lastTasteUri = track.uri;
    const op = this.opinion(track);
    if (!op) return;
    const now = Date.now();
    const showBubble = now - this.lastTasteBubbleAt > TASTE_BUBBLE_GAP && !this.game.quiet;
    if (showBubble) this.lastTasteBubbleAt = now;
    if (op.kind === 'favorito') {
      this.game.adjust(this.cfg.efectos.artistaFavorito);
      this.game.say(
        { anim: 'dance', animMs: DANCE_MS, sound: 'risa', bubble: showBubble ? this.i18n.bubble('tasteLove', { artist: op.artist }) : undefined },
        false,
      );
    } else {
      this.game.adjust(this.cfg.efectos.artistaOdiado);
      this.game.say({ anim: 'angry', sound: 'grunido', bubble: showBubble ? this.i18n.bubble('tasteHate', { artist: op.artist }) : undefined }, false);
    }
  }

  private publish(): void {
    const st = this.state;
    const op = this.opinion(st?.track);
    this.game.setMusic({
      connected: this.connected,
      track: st?.track ? { name: st.track.name, artists: st.track.artists } : null,
      isPlaying: !!st?.isPlaying,
      hers: this.isHers(st?.track, st?.contextUri),
      opinion: op?.kind ?? null,
    });
  }

  // ---------- Sugerencias ----------

  onMoodChanged(mood: MoodDef): void {
    if (mood.musica?.modo === 'sugerir') void this.suggest();
  }

  private hasMusicFor(mood: MoodDef): boolean {
    return (
      (this.settings.spotify.playlists[mood.id]?.length ?? 0) > 0 ||
      (mood.musica?.playlists?.length ?? 0) > 0 ||
      (mood.musica?.busqueda?.length ?? 0) > 0
    );
  }

  /** Muestra el bocadillo "¿Pongo algo...?" con [Sí] [No]. */
  async suggest(): Promise<void> {
    const now = Date.now();
    const mood = this.game.mood;
    if (!this.connected || this.prompt || this.busy || this.game.quiet || !this.userActive) return;
    if (now - this.lastSuggestAt < this.cfg.sugerencias.cooldownMinutos * MINUTE) return;
    if (mood.musica?.modo !== 'sugerir' || !this.hasMusicFor(mood)) return;
    // Ya está sonando lo que ella puso para este mood.
    if (this.her?.moodId === mood.id && this.state?.isPlaying && this.isHers(this.state.track, this.state.contextUri)) return;

    this.lastSuggestAt = now;
    const wait = this.cfg.sugerencias.esperaRespuestaSegundos * 1000;
    const id = Math.random().toString(36).slice(2);
    this.prompt = { id, moodId: mood.id, expiresAt: now + wait };
    const key = this.i18n.hasBubble(`musicSuggest_${mood.id}`) ? `musicSuggest_${mood.id}` : 'musicSuggest';
    const ui = this.i18n.section('ui');
    this.game.say({
      anim: 'talk',
      sound: 'saludo',
      bubble: this.i18n.bubble(key),
      choices: [
        { id: 'yes', label: ui.musicYes },
        { id: 'no', label: ui.musicNo },
      ],
      promptId: id,
      durationMs: wait,
    });
  }

  async answer(promptId: string, choice: string): Promise<void> {
    if (!this.prompt || this.prompt.id !== promptId) return;
    const { moodId } = this.prompt;
    this.prompt = null;
    const e = this.cfg.efectos;

    if (choice !== 'yes') {
      this.declines++;
      this.game.adjust(e.rechazar);
      if (this.declines >= e.rechazosParaMosqueo) {
        this.declines = 0;
        this.game.adjust({ mosqueo: e.mosqueoPorRechazos });
        this.game.say({ anim: 'angry', sound: 'grunido', bubble: this.i18n.bubble('musicDeclinedMany') });
      } else {
        this.game.say({ anim: 'talk', bubble: this.i18n.bubble('musicDeclined') });
      }
      return;
    }

    this.declines = 0;
    this.game.adjust(e.aceptar);
    this.game.rollDrop('sugerenciaAceptada');
    const result = await this.playMood(moodId);
    this.sayResult(result, { anim: 'happy', sound: 'risa', bubble: this.i18n.bubble('musicPlaying') });
  }

  private sayResult(result: PlayResult, ok: Parameters<Game['say']>[0]): void {
    if (result === 'ok') this.game.say(ok);
    else if (result === 'nodevice') this.game.say({ anim: 'talk', bubble: this.i18n.bubble('musicNoDevice') });
    else this.game.say({ anim: 'talk', bubble: this.i18n.bubble('musicError') });
  }

  /** Pone la música de un mood: una de sus playlists o, si no tiene, canciones buscadas. */
  async playMood(moodId: string): Promise<PlayResult> {
    const mood = this.game.config.moods.moods.find((m) => m.id === moodId);
    const lists = [...(this.settings.spotify.playlists[moodId] ?? []).map((p) => p.uri), ...(mood?.musica?.playlists ?? [])];
    const uri = pick(lists);
    if (uri) return this.startHer({ contextUri: uri }, 'sugerencia', moodId);
    const uris = await this.searchUris(mood?.musica?.busqueda ?? [], this.cfg.sugerencias.cancionesPorBusqueda);
    if (!uris.length) return 'nomusic';
    return this.startHer({ uris }, 'sugerencia', moodId);
  }

  /**
   * Dispositivo donde poner música: el que ya está en uso o, si no hay, un ordenador.
   * Nunca enciende por su cuenta altavoces u otros dispositivos (podrían estar en otra habitación).
   */
  /** Pone canciones de una búsqueda concreta (lo que le pides en el chat: un artista, un estilo...). */
  async playSearch(query: string): Promise<PlayResult> {
    const q = query.trim();
    if (!q || !this.connected) return 'nomusic';
    const tracks = await this.api.searchTracks(q, 0).catch(() => []);
    if (!tracks.length) return 'nomusic';
    return this.startHer({ uris: shuffle(tracks.map((t) => t.uri)) }, 'sugerencia', this.game.mood.id);
  }

  /** Controles básicos pedidos en el chat. No cuentan como "saltar su canción". */
  async control(kind: 'pause' | 'resume' | 'next'): Promise<PlayResult> {
    if (!this.connected) return 'error';
    this.ownActionUntil = Date.now() + OWN_ACTION_MS;
    try {
      if (kind === 'pause') await this.api.pause();
      else if (kind === 'next') await this.api.next();
      else {
        const device = await this.ensureDevice();
        if (!device) return 'nodevice';
        await this.api.play({ deviceId: device });
      }
    } catch (err) {
      console.error('[música] Control fallido:', String(err));
      return err instanceof SpotifyError && err.reason === 'NO_ACTIVE_DEVICE' ? 'nodevice' : 'error';
    }
    setTimeout(() => void this.poll(true), 1500);
    return 'ok';
  }

  private async ensureDevice(): Promise<string | null> {
    if (this.state?.deviceId) return this.state.deviceId;
    const devices = await this.api.devices().catch(() => []);
    const d = devices.find((x) => x.isActive) ?? devices.find((x) => x.type === 'Computer' && !x.isRestricted);
    return d?.id ?? null;
  }

  private async startHer(opts: { contextUri?: string; uris?: string[] }, kind: HerSession['kind'], moodId: string): Promise<PlayResult> {
    const device = await this.ensureDevice();
    if (!device) return 'nodevice';
    this.ownActionUntil = Date.now() + OWN_ACTION_MS;
    try {
      // En playlists, aleatorio para que no empiece siempre por la misma canción.
      if (opts.contextUri) await this.api.setShuffle(true, device).catch(() => {});
      await this.api.play({ ...opts, deviceId: device });
    } catch (err) {
      console.error('[música] No se puede reproducir:', String(err));
      return err instanceof SpotifyError && err.reason === 'NO_ACTIVE_DEVICE' ? 'nodevice' : 'error';
    }
    this.her = { kind, moodId, uris: new Set(opts.uris ?? []), contextUri: opts.contextUri ?? null };
    setTimeout(() => void this.poll(true), 1500);
    return 'ok';
  }

  private async searchUris(queries: string[], n: number): Promise<string[]> {
    const found = new Set<string>();
    for (const q of shuffle(queries)) {
      if (found.size >= n) break;
      try {
        const tracks = await this.api.searchTracks(q, Math.floor(Math.random() * 40));
        for (const t of shuffle(tracks)) found.add(t.uri);
      } catch (err) {
        console.warn('[música] Búsqueda fallida:', q, String(err));
      }
    }
    return shuffle([...found]).slice(0, n);
  }

  // ---------- Travesuras ----------

  /** Travesura musical. `welcome` = la de bienvenida, que no espera a que pase el tiempo entre travesuras. */
  async mischief(welcome = false): Promise<boolean> {
    if (this.busy || !this.connected || !this.userActive || this.game.quiet) return false;
    if (!welcome && !this.game.canMischief()) return false;
    this.busy = true;
    try {
      const st = this.state ?? (await this.api.playback().catch(() => null));
      const playing = !!st?.isPlaying;
      const w = this.cfg.travesura.pesos;
      const options: [MischiefKind, number][] = [
        ['pausar', playing ? w.pausar : 0],
        ['saltar', playing ? w.saltar : 0],
        ['secuestrar', w.secuestrar],
        ['cola', playing ? w.cola : 0],
      ];
      const total = options.reduce((s, [, p]) => s + p, 0);
      if (total <= 0) return false;
      let r = Math.random() * total;
      const kind = (options.find(([, p]) => (r -= p) < 0) ?? options[2])[0];

      // La de bienvenida no espera al cooldown, pero sí lo reinicia (para que no vengan dos seguidas).
      this.game.markMischief();
      this.ownActionUntil = Date.now() + OWN_ACTION_MS;
      const moodId = this.game.mood.id;
      const n = this.cfg.travesura.cancionesPorTravesura;

      switch (kind) {
        case 'pausar':
          await this.api.pause();
          break;
        case 'saltar':
          await this.api.next();
          break;
        case 'secuestrar': {
          const uris = await this.searchUris(this.cfg.travesura.busquedas, n);
          if (!uris.length || (await this.startHer({ uris }, 'travesura', moodId)) !== 'ok') return false;
          break;
        }
        case 'cola': {
          const uris = await this.searchUris(this.cfg.travesura.busquedas, Math.min(5, n));
          for (const uri of uris) await this.api.queue(uri);
          this.her = { kind: 'travesura', moodId, uris: new Set(uris), contextUri: null };
          break;
        }
      }
      this.game.say({ anim: 'mischief', sound: 'risa', bubble: this.i18n.bubble(`mischief_${kind}`) });
      setTimeout(() => void this.poll(true), 1500);
      return true;
    } catch (err) {
      console.error('[música] Travesura fallida:', String(err));
      return false;
    } finally {
      this.busy = false;
    }
  }

  // ---------- Objetos ----------

  /** Efectos especiales de objetos. Devuelve true si se encarga de la reacción. */
  special(name: string): boolean {
    if (name !== 'regalarCancion' || !this.connected) return false;
    void this.giftSong();
    return true;
  }

  /** Vinilo misterioso: te regala una canción de un artista que le gusta. */
  private async giftSong(): Promise<void> {
    let tracks: SpotifyTrack[] = [];
    const artist = pick(this.cfg.artistasFavoritos);
    if (artist) {
      tracks = (await this.api.searchTracks(`artist:"${artist}"`).catch(() => [])).filter((t) =>
        t.artists.some((a) => norm(a) === norm(artist)),
      );
    }
    if (!tracks.length) {
      const q = pick(this.game.mood.musica?.busqueda ?? []) ?? 'feel good';
      tracks = await this.api.searchTracks(q, Math.floor(Math.random() * 30)).catch(() => []);
    }
    const track = pick(tracks);
    const device = track ? await this.ensureDevice() : null;
    if (!track || !device) {
      this.game.say({ anim: 'talk', bubble: this.i18n.bubble(track ? 'musicNoDevice' : 'musicError') });
      return;
    }
    this.ownActionUntil = Date.now() + OWN_ACTION_MS;
    try {
      if (this.state?.isPlaying) await this.api.queue(track.uri);
      else await this.api.play({ uris: [track.uri], deviceId: device });
    } catch (err) {
      console.error('[música] Regalo fallido:', String(err));
      this.game.say({ anim: 'talk', bubble: this.i18n.bubble('musicError') });
      return;
    }
    if (this.her) this.her.uris.add(track.uri);
    else this.her = { kind: 'regalo', moodId: this.game.mood.id, uris: new Set([track.uri]), contextUri: null };
    this.game.say({
      anim: 'happy',
      sound: 'risa',
      bubble: this.i18n.bubble('giftSong', { track: track.name, artist: track.artists[0] ?? '' }),
    });
    setTimeout(() => void this.poll(true), 1500);
  }
}
