import type { SkinManifest } from '../../shared/types';
import { skinUrl } from './skin';

/** Reproduce los sonidos de la skin (skin.json → "sonidos"). */
export class SoundPlayer {
  private manifest: SkinManifest | null = null;
  volume = 0.6;
  muted = false;

  setSkin(manifest: SkinManifest): void {
    this.manifest = manifest;
  }

  play(event: string): void {
    const files = this.manifest?.sonidos[event];
    if (this.muted || !files?.length || !this.manifest) return;
    const file = files[Math.floor(Math.random() * files.length)];
    const audio = new Audio(skinUrl(file, this.manifest.version));
    audio.volume = this.volume;
    audio.play().catch(() => {});
  }
}
