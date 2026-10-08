// Crea el instalador de Windows (release/Melochi-Setup-<versión>.exe).
//   npm run dist
// Compila primero y deja la caché de electron-builder (NSIS y herramientas que descarga) dentro del proyecto,
// en .cache/, para no llenar C:.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache', 'electron-builder');
mkdirSync(cache, { recursive: true });
process.env.ELECTRON_BUILDER_CACHE = cache;

execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit', cwd: root });

const { build, Platform } = await import('electron-builder');
const files = await build({ targets: Platform.WINDOWS.createTarget(), projectDir: root });
console.log('\nInstalador listo:');
for (const f of files.filter((f) => f.endsWith('.exe'))) console.log('  ', f);
