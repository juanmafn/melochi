// Empaqueta main, preloads y renderers con esbuild y copia los HTML/CSS a dist/.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const builds = [
  {
    ...common,
    entryPoints: { main: join(root, 'src/main/main.ts') },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'koffi'],
  },
  {
    ...common,
    entryPoints: {
      'preload/overlay': join(root, 'src/preload/overlay.ts'),
      'preload/setup': join(root, 'src/preload/setup.ts'),
      'preload/music': join(root, 'src/preload/music.ts'),
    },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: {
      'renderer/overlay': join(root, 'src/renderer/overlay/main.ts'),
      'renderer/setup': join(root, 'src/renderer/setup/main.ts'),
      'renderer/music': join(root, 'src/renderer/music/main.ts'),
    },
    outdir: dist,
    platform: 'browser',
    format: 'esm',
    target: 'chrome130',
  },
];

function copyStatic() {
  cpSync(join(root, 'src/renderer/static'), join(dist, 'renderer'), { recursive: true });
}

copyStatic();

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
  console.log('Vigilando cambios... (los HTML/CSS se copian solo al arrancar)');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
