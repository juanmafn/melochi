import { ImageSource, Rectangle, Texture } from 'pixi.js';
import type { SkinFrame, SkinManifest } from '../../shared/types';

export interface LoadedFrame {
  texture: Texture;
  /** Máscara de opacidad (1 = píxel visible) en el tamaño original del frame, para detectar clics. */
  mask: Uint8Array;
  width: number;
  height: number;
  duration: number;
}

export interface LoadedAnim {
  frames: LoadedFrame[];
  loop: boolean;
  /** Escala propia de la animación (frames dibujados a más resolución). */
  scale: number;
}

export interface LoadedSkin {
  manifest: SkinManifest;
  anims: Map<string, LoadedAnim>;
  destroy(): void;
}

const ALPHA_THRESHOLD = 40;

export function skinUrl(path: string, version: number): string {
  return `melochi://skin/${path.split('/').map(encodeURIComponent).join('/')}?v=${version}`;
}

interface LoadedImage {
  source: ImageSource;
  pixels: ImageData;
}

async function loadImage(path: string, version: number): Promise<LoadedImage> {
  const res = await fetch(skinUrl(path, version));
  if (!res.ok) throw new Error(`No se encuentra ${path}`);
  const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const source = new ImageSource({ resource: bitmap, scaleMode: 'linear' });
  return { source, pixels };
}

function buildFrame(img: LoadedImage, f: SkinFrame, fps: number): LoadedFrame {
  const fw = f.w || img.pixels.width;
  const fh = f.h || img.pixels.height;
  const sw = f.sourceW || fw;
  const sh = f.sourceH || fh;
  const trimmed = sw !== fw || sh !== fh || f.offX !== 0 || f.offY !== 0;

  const mask = new Uint8Array(sw * sh);
  const data = img.pixels.data;
  const iw = img.pixels.width;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      if (data[((f.y + y) * iw + (f.x + x)) * 4 + 3] > ALPHA_THRESHOLD) {
        mask[(f.offY + y) * sw + (f.offX + x)] = 1;
      }
    }
  }

  const texture = new Texture({
    source: img.source,
    frame: new Rectangle(f.x, f.y, fw, fh),
    orig: new Rectangle(0, 0, sw, sh),
    trim: trimmed ? new Rectangle(f.offX, f.offY, fw, fh) : undefined,
  });
  return { texture, mask, width: sw, height: sh, duration: f.duration ?? 1000 / fps };
}

export async function loadSkin(manifest: SkinManifest): Promise<LoadedSkin> {
  const images = new Map<string, Promise<LoadedImage>>();
  const getImage = (path: string) => {
    if (!images.has(path)) images.set(path, loadImage(path, manifest.version));
    return images.get(path)!;
  };

  const anims = new Map<string, LoadedAnim>();
  await Promise.all(
    Object.entries(manifest.animaciones).map(async ([name, anim]) => {
      try {
        const frames = await Promise.all(anim.frames.map(async (f) => buildFrame(await getImage(f.image), f, anim.fps)));
        anims.set(name, { frames, loop: anim.loop, scale: anim.escala ?? 1 });
      } catch (err) {
        console.warn(`[skin] Animación "${name}":`, err);
      }
    }),
  );

  return {
    manifest,
    anims,
    destroy() {
      for (const anim of anims.values()) for (const f of anim.frames) f.texture.destroy(false);
      for (const p of images.values()) p.then((img) => img.source.destroy()).catch(() => {});
    },
  };
}
