import { app } from 'electron';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Paths {
  /** Carpeta con config/ y skins/ editables por el usuario. */
  dataRoot: string;
  config: string;
  skins: string;
  locales: string;
  userData: string;
  save: string;
  settings: string;
  renderer: string;
  preload: string;
}

/**
 * En desarrollo, config/ y skins/ se leen directamente del proyecto para poder editarlos ahí.
 * Empaquetado, se copian la primera vez a %APPDATA%/Melochi y se leen de allí.
 */
export function resolvePaths(): Paths {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const appRoot = app.getAppPath();
  let dataRoot = appRoot;
  let locales = join(appRoot, 'locales');

  if (app.isPackaged) {
    const defaults = join(process.resourcesPath, 'defaults');
    dataRoot = userData;
    locales = join(defaults, 'locales');
    for (const dir of ['config', 'skins']) {
      const target = join(userData, dir);
      if (!existsSync(target) && existsSync(join(defaults, dir))) {
        cpSync(join(defaults, dir), target, { recursive: true });
      }
    }
  }

  return {
    dataRoot,
    config: join(dataRoot, 'config'),
    skins: join(dataRoot, 'skins'),
    locales,
    userData,
    save: join(userData, 'save.json'),
    settings: join(userData, 'settings.json'),
    renderer: join(appRoot, 'dist', 'renderer'),
    preload: join(appRoot, 'dist', 'preload'),
  };
}
