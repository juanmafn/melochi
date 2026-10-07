import type { SpotifyAuth } from './auth';

const API = 'https://api.spotify.com/v1';

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: string[];
  durationMs: number;
}

export interface PlaybackState {
  deviceId: string | null;
  deviceName: string | null;
  isPlaying: boolean;
  progressMs: number;
  track: SpotifyTrack | null;
  contextUri: string | null;
  /** Momento en que se leyó (para estimar el progreso entre consultas). */
  at: number;
}

export interface Device {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
}

export interface PlaylistInfo {
  uri: string;
  name: string;
  owner: string;
}

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(`${status} ${reason} ${message}`.trim());
  }
}

type Json = Record<string, any>;

function parseTrack(item: Json | null | undefined): SpotifyTrack | null {
  if (!item || item.type !== 'track') return null;
  return {
    uri: item.uri,
    name: item.name,
    artists: (item.artists ?? []).map((a: Json) => a.name),
    durationMs: item.duration_ms ?? 0,
  };
}

/** Cliente mínimo de la Web API de Spotify con lo que usa Melochi. */
export class SpotifyApi {
  /** Si Spotify pide esperar (429), no se hace ninguna petición hasta este momento. */
  blockedUntil = 0;

  constructor(private auth: SpotifyAuth) {}

  private async request(method: string, path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}, retried = false): Promise<Json | null> {
    if (Date.now() < this.blockedUntil) throw new SpotifyError(429, 'RATE_LIMITED', '');
    const token = await this.auth.accessToken(retried);
    if (!token) throw new SpotifyError(401, 'NOT_CONNECTED', '');

    const url = new URL(API + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 401 && !retried) return this.request(method, path, opts, true);
    if (res.status === 429) {
      this.blockedUntil = Date.now() + Number(res.headers.get('retry-after') ?? 5) * 1000;
      throw new SpotifyError(429, 'RATE_LIMITED', '');
    }
    // Los comandos del reproductor a veces responden con texto plano (un id), no con JSON.
    const text = await res.text();
    let json: Json | null = null;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
      try {
        json = JSON.parse(text) as Json;
      } catch {
        json = null;
      }
    }
    if (!res.ok) throw new SpotifyError(res.status, json?.error?.reason ?? '', json?.error?.message ?? res.statusText);
    return json;
  }

  async me(): Promise<{ id: string; name: string }> {
    const j = (await this.request('GET', '/me'))!;
    return { id: j.id, name: j.display_name ?? j.id };
  }

  /** Playlists que el usuario tiene en su biblioteca (propias y seguidas). */
  async playlists(max = 200): Promise<PlaylistInfo[]> {
    const out: PlaylistInfo[] = [];
    for (let offset = 0; offset < max; offset += 50) {
      const page = await this.request('GET', '/me/playlists', { query: { limit: 50, offset } });
      for (const p of page?.items ?? []) if (p) out.push({ uri: p.uri, name: p.name, owner: p.owner?.display_name ?? '' });
      if (!page?.next) break;
    }
    return out;
  }

  async playback(): Promise<PlaybackState | null> {
    const j = await this.request('GET', '/me/player', { query: { additional_types: 'track' } });
    if (!j) return null;
    return {
      deviceId: j.device?.id ?? null,
      deviceName: j.device?.name ?? null,
      isPlaying: !!j.is_playing,
      progressMs: j.progress_ms ?? 0,
      track: parseTrack(j.item),
      contextUri: j.context?.uri ?? null,
      at: Date.now(),
    };
  }

  async devices(): Promise<Device[]> {
    const j = await this.request('GET', '/me/player/devices');
    return (j?.devices ?? []).map((d: Json) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: !!d.is_active,
      isRestricted: !!d.is_restricted,
    }));
  }

  async play(opts: { contextUri?: string; uris?: string[]; deviceId?: string | null }): Promise<void> {
    const body: Json = {};
    if (opts.contextUri) body.context_uri = opts.contextUri;
    if (opts.uris) body.uris = opts.uris;
    await this.request('PUT', '/me/player/play', { query: opts.deviceId ? { device_id: opts.deviceId } : {}, body });
  }

  async pause(): Promise<void> {
    await this.request('PUT', '/me/player/pause');
  }

  async next(): Promise<void> {
    await this.request('POST', '/me/player/next');
  }

  async queue(uri: string): Promise<void> {
    await this.request('POST', '/me/player/queue', { query: { uri } });
  }

  async setShuffle(on: boolean, deviceId?: string | null): Promise<void> {
    await this.request('PUT', '/me/player/shuffle', { query: { state: String(on), ...(deviceId ? { device_id: deviceId } : {}) } });
  }

  /** Busca canciones (Spotify devuelve como máximo 10 por petición). */
  async searchTracks(q: string, offset = 0): Promise<SpotifyTrack[]> {
    const j = await this.request('GET', '/search', { query: { q, type: 'track', limit: 10, offset } });
    return (j?.tracks?.items ?? []).map(parseTrack).filter((t: SpotifyTrack | null): t is SpotifyTrack => !!t);
  }
}
