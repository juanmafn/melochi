import { app } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Paths {
  /** Carpeta con config/ y skins/ editables por el usuario. */
  dataRoot: string;
  config: string;
  /** Configuración original del programa (empaquetado): rellena lo que falte en la del usuario. */
  defaultConfig: string | null;
  skins: string;
  locales: string;
  userData: string;
  save: string;
  settings: string;
  renderer: string;
  preload: string;
}

/** La skin que trae el programa: se actualiza con cada versión (para personalizar, hay que copiarla). */
const BUNDLED_SKIN = 'placeholder';

/**
 * En desarrollo, config/ y skins/ se leen directamente del proyecto para poder editarlos ahí.
 * Empaquetado, se copian la primera vez a %APPDATA%/Melochi y se leen de allí. Al instalar una versión
 * nueva, se añaden los archivos nuevos y se actualiza la skin provisional, sin tocar lo que hayas cambiado.
 */
export function resolvePaths(): Paths {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const appRoot = app.getAppPath();
  let dataRoot = appRoot;
  let locales = join(appRoot, 'locales');
  let defaultConfig: string | null = null;

  if (app.isPackaged) {
    const defaults = join(process.resourcesPath, 'defaults');
    dataRoot = userData;
    locales = join(defaults, 'locales');
    defaultConfig = join(defaults, 'config');
    syncDefaults(defaults, userData);
  }

  return {
    dataRoot,
    config: join(dataRoot, 'config'),
    defaultConfig,
    skins: join(dataRoot, 'skins'),
    locales,
    userData,
    save: join(userData, 'save.json'),
    settings: join(userData, 'settings.json'),
    renderer: join(appRoot, 'dist', 'renderer'),
    preload: join(appRoot, 'dist', 'preload'),
  };
}

function syncDefaults(defaults: string, userData: string): void {
  const marker = join(userData, 'defaults-version.txt');
  const version = app.getVersion();
  let installed = '';
  try {
    installed = readFileSync(marker, 'utf8').trim();
  } catch {
    // Primera vez.
  }
  if (installed === version) return;

  // config/: solo los archivos que falten (los que existen pueden estar editados; lo nuevo dentro de
  // ellos lo rellena loadConfig con la configuración original).
  const configDir = join(userData, 'config');
  mkdirSync(configDir, { recursive: true });
  for (const f of readdirSync(join(defaults, 'config'))) {
    if (!existsSync(join(configDir, f))) cpSync(join(defaults, 'config', f), join(configDir, f));
  }

  // skins/: las que falten, y la provisional se actualiza (conservando su personality.md si la has editado).
  const skinsDir = join(userData, 'skins');
  mkdirSync(skinsDir, { recursive: true });
  for (const skin of readdirSync(join(defaults, 'skins'))) {
    const target = join(skinsDir, skin);
    if (existsSync(target) && skin !== BUNDLED_SKIN) continue;
    const personality = join(target, 'personality.md');
    const kept = existsSync(personality) ? readFileSync(personality) : null;
    cpSync(join(defaults, 'skins', skin), target, { recursive: true, force: true });
    if (kept && installed) writeFileSync(personality, kept);
  }
  writeFileSync(marker, version);
}
