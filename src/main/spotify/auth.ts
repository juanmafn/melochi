import { safeStorage, shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

/** Hay que registrar exactamente esta dirección en la app de Spotify (Redirect URIs). */
export const REDIRECT_PORT = 8977;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
];
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface StoredToken {
  refreshToken: string;
  clientId: string;
}

const base64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Autorización con Spotify (OAuth "Authorization Code" con PKCE, sin secreto de cliente).
 * El refresh token se guarda cifrado con la protección de datos de Windows (safeStorage).
 */
export class SpotifyAuth {
  private refreshToken: string | null = null;
  private tokenClientId: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string | null> | null = null;
  private loginServer: Server | null = null;

  constructor(
    private tokenPath: string,
    private clientId: () => string | undefined,
  ) {
    this.load();
  }

  /** Hay sesión guardada para el Client ID configurado. */
  get connected(): boolean {
    return !!this.refreshToken && this.tokenClientId === this.clientId();
  }

  private load(): void {
    if (!existsSync(this.tokenPath)) return;
    try {
      const raw = readFileSync(this.tokenPath);
      const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      const data = JSON.parse(json) as StoredToken;
      this.refreshToken = data.refreshToken;
      this.tokenClientId = data.clientId;
    } catch (err) {
      console.warn('[spotify] No se puede leer el token guardado:', err);
    }
  }

  private persist(): void {
    if (!this.refreshToken || !this.tokenClientId) return;
    const json = JSON.stringify({ refreshToken: this.refreshToken, clientId: this.tokenClientId } satisfies StoredToken);
    if (safeStorage.isEncryptionAvailable()) writeFileSync(this.tokenPath, safeStorage.encryptString(json));
    else {
      console.warn('[spotify] Cifrado no disponible: el token se guarda sin cifrar.');
      writeFileSync(this.tokenPath, json, 'utf8');
    }
  }

  logout(): void {
    this.refreshToken = null;
    this.tokenClientId = null;
    this.access = null;
    rmSync(this.tokenPath, { force: true });
  }

  /** Abre el navegador para iniciar sesión y espera la vuelta en el servidor local. */
  async login(): Promise<void> {
    const clientId = this.clientId();
    if (!clientId) throw new Error('NO_CLIENT_ID');
    this.loginServer?.close();

    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));

    const code = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('LOGIN_TIMEOUT'));
      }, LOGIN_TIMEOUT_MS);

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', REDIRECT_URI);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Melochi</title><body style="font-family:Segoe UI,sans-serif;text-align:center;padding:60px">` +
            (ok ? '<h2>¡Listo! / Done!</h2><p>Ya puedes cerrar esta pestaña. / You can close this tab.</p>' : `<h2>Error</h2><p>${(error ?? 'state').replace(/[^\w ._-]/g, '')}</p>`) +
            '</body>',
        );
        clearTimeout(timeout);
        server.close();
        this.loginServer = null;
        if (ok) resolve(url.searchParams.get('code')!);
        else reject(new Error(error ?? 'STATE_MISMATCH'));
      });
      server.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const auth = new URL('https://accounts.spotify.com/authorize');
        auth.search = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state,
          scope: SCOPES.join(' '),
        }).toString();
        void shell.openExternal(auth.toString());
      });
      this.loginServer = server;
    });

    const data = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    this.tokenClientId = clientId;
    this.applyTokens(data);
  }

  /** Token de acceso válido (lo renueva si ha caducado). null si no hay sesión. */
  async accessToken(forceRefresh = false): Promise<string | null> {
    if (!this.connected) return null;
    if (!forceRefresh && this.access && this.access.expiresAt > Date.now() + 30_000) return this.access.token;
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<string | null> {
    try {
      const data = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken!,
        client_id: this.tokenClientId!,
      });
      this.applyTokens(data);
      return this.access!.token;
    } catch (err) {
      console.error('[spotify] No se puede renovar la sesión:', err);
      // invalid_grant = la sesión se revocó: hay que volver a conectar.
      if (String(err).includes('invalid_grant')) this.logout();
      return null;
    }
  }

  private applyTokens(data: { access_token: string; expires_in: number; refresh_token?: string }): void {
    this.access = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    this.persist();
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${json.error ?? res.status}: ${json.error_description ?? ''}`);
    return json as { access_token: string; expires_in: number; refresh_token?: string };
  }
}
