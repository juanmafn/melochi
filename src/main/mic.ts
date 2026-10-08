import { execFile } from 'node:child_process';

const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

/**
 * Nombre del programa que está usando el micrófono ahora mismo (o null). Se ignoran los de `ignore`.
 * Windows anota en el registro cuándo empezó y terminó cada programa a usarlo: LastUsedTimeStop = 0
 * significa que lo sigue usando.
 */
export function micInUse(ignore: string[] = []): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', MIC_KEY, '/s'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : parseMicRegistry(stdout, ignore));
    });
  });
}

/** Analiza la salida de `reg query ...\microphone /s`. */
export function parseMicRegistry(stdout: string, ignore: string[] = []): string | null {
  const skip = new Set(ignore.map((s) => s.toLowerCase()));
  // Clave → { start, stop } (los valores pueden venir en cualquier orden).
  const keys = new Map<string, { start?: string; stop?: string }>();
  let key = '';
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('HKEY_')) {
      key = line;
      continue;
    }
    const m = line.match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i);
    if (!m || !key) continue;
    const entry = keys.get(key) ?? {};
    if (m[1] === 'LastUsedTimeStart') entry.start = m[2];
    else entry.stop = m[2];
    keys.set(key, entry);
  }
  for (const [k, v] of keys) {
    if (v.start && v.start !== '0' && v.stop === '0') {
      // "...\NonPackaged\C:#Program Files#Discord#Discord.exe" → "Discord.exe"
      const last = k.split('\\').pop() ?? k;
      const app = last.split('#').pop() ?? last;
      if (!skip.has(app.toLowerCase())) return app;
    }
  }
  return null;
}
