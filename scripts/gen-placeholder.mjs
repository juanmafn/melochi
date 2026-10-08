// Genera la skin provisional "placeholder": una gota con ojos, iconos de objetos y sonidos sencillos.
// Sirve también como ejemplo de los dos formatos de animación: carpetas de frames y sprite sheets.
//   node scripts/gen-placeholder.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'skins', 'placeholder');
// Solo se borra lo que genera este script (personality.md se edita a mano y se conserva).
for (const p of ['anims', 'items', 'sounds', 'skin.json', 'icon.png']) rmSync(join(out, p), { recursive: true, force: true });

// ====================================================================
// Rasterizado con funciones de distancia (SDF) y antialiasing
// ====================================================================

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Float32Array(w * h * 4); // RGBA premultiplicado, 0..1
  }

  /** Pinta la forma `sdf` (negativa dentro) con el color [r, g, b] y opacidad `a`. */
  fill(sdf, [r, g, b], a = 1) {
    const { w, h, d } = this;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cov = clamp(0.5 - sdf(x + 0.5, y + 0.5), 0, 1) * a;
        if (cov <= 0) continue;
        const i = (y * w + x) * 4;
        const k = 1 - cov;
        d[i] = (r / 255) * cov + d[i] * k;
        d[i + 1] = (g / 255) * cov + d[i + 1] * k;
        d[i + 2] = (b / 255) * cov + d[i + 2] * k;
        d[i + 3] = cov + d[i + 3] * k;
      }
    }
  }

  /** Pinta con contorno oscuro de `t` píxeles. */
  outlined(sdf, color, t = 2, outline = shade(color, 0.5)) {
    this.fill((x, y) => sdf(x, y) - t, outline);
    this.fill(sdf, color);
  }

  blit(src, ox, oy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const si = (y * src.w + x) * 4;
        const di = ((oy + y) * this.w + ox + x) * 4;
        for (let c = 0; c < 4; c++) this.d[di + c] = src.d[si + c];
      }
    }
  }

  /** Reduce el tamaño promediando bloques (para el icono de la bandeja). */
  downscale(f) {
    const o = new Img(this.w / f, this.h / f);
    for (let y = 0; y < o.h; y++)
      for (let x = 0; x < o.w; x++)
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += this.d[((y * f + j) * this.w + x * f + i) * 4 + c];
          o.d[(y * o.w + x) * 4 + c] = s / (f * f);
        }
    return o;
  }

  png() {
    const png = new PNG({ width: this.w, height: this.h });
    for (let i = 0; i < this.w * this.h; i++) {
      const a = this.d[i * 4 + 3];
      for (let c = 0; c < 3; c++) png.data[i * 4 + c] = a > 0 ? Math.round(clamp(this.d[i * 4 + c] / a, 0, 1) * 255) : 0;
      png.data[i * 4 + 3] = Math.round(a * 255);
    }
    return PNG.sync.write(png);
  }
}

const ellipse = (cx, cy, rx, ry) => (x, y) => (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);
const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;
const segment = (ax, ay, bx, by, r) => (x, y) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
};
const box = (cx, cy, hw, hh, r = 0) => (x, y) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const polygon = (v) => (x, y) => {
  let d = (x - v[0][0]) ** 2 + (y - v[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = v.length - 1; i < v.length; j = i, i++) {
    const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1];
    const wx = x - v[i][0], wy = y - v[i][1];
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    d = Math.min(d, (wx - ex * h) ** 2 + (wy - ey * h) ** 2);
    const c1 = y >= v[i][1], c2 = y < v[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
};
const union = (...fs) => (x, y) => Math.min(...fs.map((f) => f(x, y)));
const intersect = (...fs) => (x, y) => Math.max(...fs.map((f) => f(x, y)));
const below = (ly) => (x, y) => ly - y; // dentro si y > ly
const above = (ly) => (x, y) => y - ly; // dentro si y < ly
/** Trazo de media elipse: 'top' (forma ^) o 'bottom' (forma ‿). */
const arc = (cx, cy, rx, ry, t, half) => intersect((x, y) => Math.abs(ellipse(cx, cy, rx, ry)(x, y)) - t, half === 'top' ? above(cy) : below(cy));
const ring = (cx, cy, r, t) => (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - t;

function shade([r, g, b], k) {
  return [clamp(r * k, 0, 255), clamp(g * k, 0, 255), clamp(b * k, 0, 255)];
}
function hex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const C = {
  ink: hex('#2b2d42'),
  white: hex('#ffffff'),
  mouth: hex('#7a2531'),
  tongue: hex('#ff8fa3'),
  cheek: hex('#ff8fa3'),
  accent: hex('#ff8a65'),
  mint: hex('#7fd1b9'),
  sun: hex('#ffd166'),
  red: hex('#ef6f6c'),
  sky: hex('#7cc6fe'),
  steam: hex('#e9ecef'),
  heart: hex('#f06292'),
  gold: hex('#ffd166'),
  brown: hex('#8d5a2b'),
};

// ====================================================================
// La mascota provisional
// ====================================================================

const S = 128; // tamaño de cada frame

function heart(img, x, y, s, color = C.heart, a = 1) {
  img.fill(union(circle(x - s * 0.5, y, s * 0.55), circle(x + s * 0.5, y, s * 0.55), polygon([[x - s, y + s * 0.2], [x + s, y + s * 0.2], [x, y + s * 1.25]])), color, a);
}
function sparkle(img, x, y, s, color = C.gold) {
  img.fill(polygon([[x, y - s], [x + s * 0.28, y - s * 0.28], [x + s, y], [x + s * 0.28, y + s * 0.28], [x, y + s], [x - s * 0.28, y + s * 0.28], [x - s, y], [x - s * 0.28, y - s * 0.28]]), color);
}
function drop(img, x, y, s, color = C.sky) {
  img.fill(union(circle(x, y + s * 0.4, s * 0.6), polygon([[x - s * 0.55, y + s * 0.2], [x + s * 0.55, y + s * 0.2], [x, y - s * 0.9]])), color);
}
/** Nota musical (corchea). */
function note(img, x, y, a = 1) {
  img.fill(ellipse(x, y + 6, 4, 3), C.ink, a);
  img.fill(segment(x + 3.4, y + 5, x + 3.4, y - 8, 1.1), C.ink, a);
  img.fill(segment(x + 3.4, y - 8, x + 8, y - 4, 1.3), C.ink, a);
}
function puff(img, x, y, s, a) {
  img.fill(union(circle(x, y, s), circle(x + s * 0.8, y + s * 0.2, s * 0.75), circle(x - s * 0.8, y + s * 0.2, s * 0.7)), C.steam, a);
}

/**
 * Dibuja la gota. Opciones:
 *  color, dx, dy (desplazamiento), sx, sy (estirar), eyes, mouth, mouthK (apertura), look (-1..1),
 *  feet: [[dx, dy], [dx, dy]], antenna (ángulo en radianes), cheeks, extras: fn(img, geo)
 */
function drawPet(o) {
  const img = new Img(S, S);
  const col = o.color ?? C.mint;
  const dark = shade(col, 0.55);
  const rx = 40 * (o.sx ?? 1);
  const ry = 36 * (o.sy ?? 1);
  const base = 118 + (o.dy ?? 0);
  const cx = 64 + (o.dx ?? 0);
  const cy = base - ry;
  const look = o.look ?? 0.6;
  const feet = o.feet ?? [[0, 0], [0, 0]];

  // Pies (detrás del cuerpo)
  for (const [i, s] of [[0, -1], [1, 1]]) {
    const [fx, fy] = feet[i];
    img.outlined(ellipse(cx + s * 17 + fx, base + 2 + fy, 10, 6), shade(col, 0.8), 2, dark);
  }
  // Antena
  const a = o.antenna ?? 0;
  const ax0 = cx, ay0 = cy - ry + 6;
  const ax1 = ax0 + Math.sin(a) * 20, ay1 = ay0 - Math.cos(a) * 20;
  img.fill(segment(ax0, ay0, ax1, ay1, 2.2), dark);
  img.outlined(circle(ax1, ay1, 5.5), C.accent, 2, shade(C.accent, 0.55));
  // Cuerpo
  img.outlined(ellipse(cx, cy, rx, ry), col, 3, dark);
  img.fill(ellipse(cx, cy + ry * 0.38, rx * 0.62, ry * 0.45), shade(col, 1.18), 0.7);
  img.fill(ellipse(cx - rx * 0.48, cy - ry * 0.5, 7, 4.5), C.white, 0.6);

  // Ojos
  const ey = cy - 3;
  for (const s of [-1, 1]) {
    const x = cx + s * 14 + look * 2;
    switch (o.eyes ?? 'open') {
      case 'open':
        img.fill(ellipse(x, ey, 7.5, 9.5), C.white);
        img.fill(circle(x + look * 2, ey + 1, 4.6), C.ink);
        img.fill(circle(x + look * 2 - 1.6, ey - 1.6, 1.6), C.white);
        break;
      case 'surprised':
        img.fill(ellipse(x, ey, 8.5, 10.5), C.white);
        img.fill(circle(x, ey, 2.8), C.ink);
        break;
      case 'happy':
        img.fill(arc(x, ey + 3, 7, 6, 1.7, 'top'), C.ink);
        break;
      case 'closed':
        img.fill(arc(x, ey - 2, 7, 5, 1.6, 'bottom'), C.ink);
        break;
      case 'blink':
        img.fill(segment(x - 6, ey + 1, x + 6, ey + 1, 1.6), C.ink);
        break;
      case 'angry': {
        img.fill(ellipse(x, ey + 2, 7, 7.5), C.white);
        img.fill(circle(x + look * 1.5, ey + 3, 4), C.ink);
        const inner = x - s * 8;
        const outer = x + s * 9;
        img.fill(segment(outer, ey - 12, inner, ey - 5, 2.4), C.ink);
        break;
      }
    }
  }

  // Mejillas
  if (o.cheeks) for (const s of [-1, 1]) img.fill(ellipse(cx + s * 26 + look * 2, cy + 8, 6, 3.5), C.cheek, 0.55);

  // Boca
  const mx = cx + look * 3;
  const my = cy + 13;
  const k = o.mouthK ?? 1;
  switch (o.mouth ?? 'smile') {
    case 'smile':
      img.fill(arc(mx, my - 3, 7, 5, 1.6, 'bottom'), C.ink);
      break;
    case 'bigsmile': {
      const m = intersect(ellipse(mx, my - 2, 9, 8), below(my - 2));
      img.fill(m, C.mouth);
      img.fill(intersect(ellipse(mx, my + 5, 5, 3.5), m), C.tongue);
      break;
    }
    case 'open':
      img.fill(ellipse(mx, my, 5.5, Math.max(1.2, 5.5 * k)), C.mouth);
      break;
    case 'o':
      img.fill(ellipse(mx, my, 3.5, 4), C.mouth);
      break;
    case 'frown':
      img.fill(arc(mx, my + 4, 7, 5, 1.6, 'top'), C.ink);
      break;
    case 'flat':
      img.fill(segment(mx - 5, my, mx + 5, my, 1.5), C.ink);
      break;
  }

  o.extras?.(img, { cx, cy, rx, ry, mx, my, base });
  return img;
}

const sin = (i, n, amp = 1, phase = 0) => Math.sin((i / n) * Math.PI * 2 + phase) * amp;

function steam(t) {
  return (img, g) => {
    const rise = (t % 1) * 10;
    puff(img, g.cx - g.rx - 2, g.cy - g.ry + 6 - rise, 5, 1 - (t % 1) * 0.6);
    puff(img, g.cx + g.rx + 2, g.cy - g.ry + 6 - rise, 5, 1 - (t % 1) * 0.6);
  };
}

/** Definición de cada animación: número de frames, fps, bucle y función que pinta el frame i. */
const ANIMS = {
  idle: { n: 6, fps: 6, f: (i) => ({ sy: 1 + sin(i, 6, 0.03), sx: 1 - sin(i, 6, 0.02), antenna: sin(i, 6, 0.12), eyes: i === 4 ? 'blink' : 'open' }) },
  feliz_idle: {
    n: 6,
    fps: 8,
    f: (i) => ({
      color: C.sun,
      dy: -Math.abs(sin(i, 6, 8)),
      sy: 1 + sin(i, 6, 0.04),
      eyes: 'happy',
      mouth: 'bigsmile',
      cheeks: true,
      antenna: sin(i, 6, 0.3),
      extras: (img, g) => {
        sparkle(img, g.cx - g.rx - 6, g.cy - 18 + (i % 3) * 3, 5 + (i % 2) * 2);
        sparkle(img, g.cx + g.rx + 4, g.cy - 6 - (i % 3) * 3, 4 + ((i + 1) % 2) * 2);
      },
    }),
  },
  cabreada_idle: {
    n: 4,
    fps: 8,
    f: (i) => ({ color: C.red, dx: [-1.5, 1.5, -1, 1][i], eyes: 'angry', mouth: 'frown', antenna: [-0.15, 0.15, -0.1, 0.1][i], look: 0, extras: steam(i / 4) }),
  },
  walk: {
    n: 6,
    fps: 10,
    f: (i) => ({
      dy: -Math.abs(sin(i, 6, 4)),
      feet: [[sin(i, 6, 6), -Math.max(0, sin(i, 6, 5))], [-sin(i, 6, 6), -Math.max(0, -sin(i, 6, 5))]],
      antenna: -0.25 + sin(i, 6, 0.1),
      look: 1,
    }),
  },
  cabreada_walk: {
    n: 6,
    fps: 12,
    f: (i) => ({
      color: C.red,
      dy: -Math.abs(sin(i, 6, 3)),
      feet: [[sin(i, 6, 7), -Math.max(0, sin(i, 6, 5))], [-sin(i, 6, 7), -Math.max(0, -sin(i, 6, 5))]],
      eyes: 'angry',
      mouth: 'frown',
      antenna: -0.35,
      look: 1,
      extras: steam(i / 6),
    }),
  },
  drag: {
    n: 4,
    fps: 8,
    f: (i) => ({
      sy: 1.12,
      sx: 0.92,
      dy: -6,
      dx: sin(i, 4, 2),
      eyes: 'surprised',
      mouth: 'o',
      look: 0,
      feet: [[2, 6], [-2, 6]],
      antenna: sin(i, 4, 0.4),
      extras: (img, g) => drop(img, g.cx + g.rx + 2, g.cy - g.ry + 14 + i, 4, C.sky),
    }),
  },
  fall: { n: 2, fps: 6, f: (i) => ({ sy: 1.05, sx: 0.96, eyes: 'surprised', mouth: 'o', look: 0, feet: [[-3, 3], [3, 3]], antenna: i ? 0.3 : -0.3 }) },
  eat: {
    n: 6,
    fps: 8,
    loop: true,
    f: (i) => ({
      eyes: 'happy',
      mouth: 'open',
      mouthK: [1, 0.3, 0.9, 0.2, 0.8, 0.3][i],
      cheeks: true,
      sy: 1 + [0, -0.03, 0.01, -0.03, 0.01, -0.02][i],
      extras: (img, g) => {
        if (i % 2) img.fill(circle(g.mx + 10, g.my + 6 + i, 1.8), hex('#c8853f'));
        if (i % 3 === 1) img.fill(circle(g.mx - 9, g.my + 8, 1.5), hex('#c8853f'));
      },
    }),
  },
  drink: {
    n: 6,
    fps: 8,
    loop: true,
    f: (i) => ({
      eyes: i % 3 === 2 ? 'closed' : 'happy',
      mouth: 'o',
      look: 1,
      extras: (img, g) => {
        const x = g.cx + g.rx - 2;
        const y = g.my + 10;
        img.fill(segment(x - 2, y - 14, g.mx + 3, g.my, 1.5), C.accent);
        img.outlined(box(x, y, 8, 11, 2), hex('#bde0fe'), 1.5, hex('#4a7fb0'));
        img.fill(box(x, y + 4 - (i % 3), 6.5, 6 + (i % 3), 1.5), C.sky);
        img.fill(circle(x - 2, y - 2 + ((i * 3) % 8), 1.2), C.white);
      },
    }),
  },
  happy: {
    n: 6,
    fps: 10,
    loop: true,
    f: (i) => ({
      dy: -[0, 10, 16, 10, 0, 0][i],
      sy: [0.9, 1.06, 1.08, 1.04, 0.9, 1][i],
      sx: [1.08, 0.96, 0.95, 0.97, 1.08, 1][i],
      eyes: 'happy',
      mouth: 'bigsmile',
      cheeks: true,
      antenna: sin(i, 6, 0.35),
      feet: i > 0 && i < 4 ? [[-3, -2], [3, -2]] : [[0, 0], [0, 0]],
      extras: (img, g) => {
        if (i >= 1 && i <= 3) {
          sparkle(img, g.cx - g.rx - 4, g.cy - 10, 5);
          sparkle(img, g.cx + g.rx + 4, g.cy - 14, 6);
        }
      },
    }),
  },
  angry: {
    n: 6,
    fps: 12,
    loop: true,
    f: (i) => ({
      color: hex('#f08a7e'),
      dx: [-2, 2, -2, 2, -1, 1][i],
      sy: 0.97,
      eyes: 'angry',
      mouth: 'frown',
      look: 0,
      antenna: [-0.2, 0.2, -0.2, 0.2, -0.1, 0.1][i],
      extras: (img, g) => {
        steam(i / 6)(img, g);
        const x = g.cx + g.rx - 8;
        const y = g.cy - g.ry + 4;
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) img.fill(arc(x + dx * 4.5, y + dy * 4.5, 3, 3, 1.3, dy < 0 ? 'bottom' : 'top'), hex('#d62828'));
      },
    }),
  },
  dance: {
    n: 8,
    fps: 10,
    loop: true,
    f: (i) => ({
      dx: sin(i, 8, 6),
      dy: -Math.abs(sin(i, 8, 6, Math.PI / 2)),
      sx: 1 + sin(i, 8, 0.05, Math.PI / 2),
      sy: 1 - sin(i, 8, 0.05, Math.PI / 2),
      eyes: 'happy',
      mouth: 'bigsmile',
      cheeks: true,
      antenna: sin(i, 8, 0.45),
      feet: [[sin(i, 8, 4), -Math.max(0, sin(i, 8, 5))], [sin(i, 8, 4), -Math.max(0, -sin(i, 8, 5))]],
      extras: (img, g) => {
        const t = i / 8;
        note(img, g.cx - g.rx - 6, g.cy - 6 - t * 18, 1 - t * 0.6);
        note(img, g.cx + g.rx + 4, g.cy - 20 - ((t + 0.5) % 1) * 18, 1 - ((t + 0.5) % 1) * 0.6);
      },
    }),
  },
  mischief: {
    n: 6,
    fps: 10,
    loop: true,
    f: (i) => ({
      color: C.red,
      dx: [-1.5, 1.5, -1, 1, -1.5, 1.5][i],
      sy: 1 + [0, 0.03, 0, 0.03, 0, 0.03][i],
      eyes: 'angry',
      mouth: 'bigsmile',
      look: 0,
      antenna: [-0.25, 0.25, -0.2, 0.2, -0.25, 0.25][i],
      extras: (img, g) => {
        // Cuernecitos de diablillo
        for (const s of [-1, 1]) {
          const x = g.cx + s * 20;
          const y = g.cy - g.ry + 8;
          img.outlined(polygon([[x - 6, y + 2], [x + 6, y + 2], [x + s * 6, y - 12]]), hex('#d62828'), 1.5, hex('#7a1c1c'));
        }
      },
    }),
  },
  talk: { n: 4, fps: 8, f: (i) => ({ mouth: 'open', mouthK: [0.9, 0.3, 0.7, 0.2][i], antenna: sin(i, 4, 0.1), sy: 1 + sin(i, 4, 0.015) }) },
  petted: {
    n: 6,
    fps: 8,
    loop: true,
    f: (i) => ({
      eyes: 'closed',
      mouth: 'smile',
      cheeks: true,
      sx: 1 + sin(i, 6, 0.04),
      sy: 1 - sin(i, 6, 0.04),
      antenna: sin(i, 6, 0.2),
      extras: (img, g) => {
        heart(img, g.cx + g.rx - 2, g.cy - g.ry - 2 - i * 2.5, 5, C.heart, 1 - i / 8);
        if (i > 2) heart(img, g.cx - g.rx + 6, g.cy - g.ry + 4 - (i - 3) * 3, 4, C.heart, 1 - (i - 3) / 5);
      },
    }),
  },
};

// Formato de cada animación en la skin de ejemplo: la mayoría como carpetas de frames y algunas como sprite sheets.
const AS_SHEET_ASEPRITE = ['walk', 'cabreada_walk']; // una sheet con dos etiquetas (frameTags)
const AS_SHEET_TEXTUREPACKER = ['cabreada_idle']; // formato hash

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const rendered = {};
for (const [name, a] of Object.entries(ANIMS)) rendered[name] = Array.from({ length: a.n }, (_, i) => drawPet(a.f(i)));

const skinAnims = {};
for (const [name, a] of Object.entries(ANIMS)) {
  const loop = a.loop ?? true;
  if (AS_SHEET_ASEPRITE.includes(name) || AS_SHEET_TEXTUREPACKER.includes(name)) continue;
  rendered[name].forEach((img, i) => write(join(out, 'anims', name, `${String(i).padStart(3, '0')}.png`), img.png()));
  skinAnims[name] = { frames: `anims/${name}/`, fps: a.fps, loop };
}

// Sprite sheet estilo Aseprite (frames en array, con duración y etiquetas)
{
  const names = AS_SHEET_ASEPRITE;
  const total = names.reduce((s, n) => s + ANIMS[n].n, 0);
  const sheet = new Img(S * total, S);
  const frames = [];
  const frameTags = [];
  let idx = 0;
  for (const name of names) {
    const from = idx;
    for (const img of rendered[name]) {
      sheet.blit(img, idx * S, 0);
      frames.push({
        filename: `${name} ${idx - from}.png`,
        frame: { x: idx * S, y: 0, w: S, h: S },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: S, h: S },
        sourceSize: { w: S, h: S },
        duration: Math.round(1000 / ANIMS[name].fps),
      });
      idx++;
    }
    frameTags.push({ name, from, to: idx - 1, direction: 'forward' });
  }
  write(join(out, 'anims', 'walks.png'), sheet.png());
  write(
    join(out, 'anims', 'walks.json'),
    JSON.stringify({ frames, meta: { app: 'https://www.aseprite.org/', image: 'walks.png', format: 'RGBA8888', size: { w: sheet.w, h: S }, scale: '1', frameTags } }, null, 1),
  );
  for (const name of names) skinAnims[name] = { sheet: 'anims/walks.json', tag: name, loop: true };
}

// Sprite sheet estilo TexturePacker (frames en hash)
for (const name of AS_SHEET_TEXTUREPACKER) {
  const imgs = rendered[name];
  const sheet = new Img(S * imgs.length, S);
  const frames = {};
  imgs.forEach((img, i) => {
    sheet.blit(img, i * S, 0);
    frames[`${name}_${String(i).padStart(2, '0')}.png`] = {
      frame: { x: i * S, y: 0, w: S, h: S },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: S, h: S },
      sourceSize: { w: S, h: S },
    };
  });
  write(join(out, 'anims', `${name}.png`), sheet.png());
  write(join(out, 'anims', `${name}.json`), JSON.stringify({ frames, meta: { app: 'https://www.codeandweb.com/texturepacker', image: `${name}.png`, format: 'RGBA8888', size: { w: sheet.w, h: S }, scale: '1' } }, null, 1));
  skinAnims[name] = { sheet: `anims/${name}.json`, fps: ANIMS[name].fps, loop: ANIMS[name].loop ?? true };
}

// Icono de la bandeja del sistema
write(join(out, 'icon.png'), rendered.idle[0].downscale(4).png());

// ====================================================================
// Iconos de objetos (48x48)
// ====================================================================

const I = 48;
const ICONS = {
  galleta: (g) => {
    g.outlined(circle(24, 24, 17), hex('#d9a066'));
    for (const [x, y] of [[17, 18], [29, 16], [22, 29], [31, 28], [14, 27]]) g.fill(circle(x, y, 2.4), hex('#5e3a1a'));
  },
  manzana: (g) => {
    g.fill(segment(24, 12, 26, 5, 1.6), C.brown);
    g.fill(polygon([[26, 9], [34, 4], [38, 8], [30, 12]]), hex('#6a994e'));
    g.outlined(union(ellipse(18, 27, 11, 14), ellipse(30, 27, 11, 14)), hex('#e63946'));
    g.fill(ellipse(16, 21, 3, 4.5), C.white, 0.6);
  },
  onigiri: (g) => {
    g.outlined((x, y) => polygon([[24, 8], [41, 38], [7, 38]])(x, y) - 3, hex('#f8f9fa'), 2, hex('#adb5bd'));
    g.fill(box(24, 35, 9, 7, 1), hex('#2d6a4f'));
  },
  pizza: (g) => {
    g.outlined(polygon([[8, 12], [40, 12], [24, 42]]), hex('#ffd166'), 2, hex('#c08a2b'));
    g.fill(box(24, 11, 17, 4, 3), hex('#d08c4a'));
    for (const [x, y] of [[18, 19], [29, 20], [24, 29]]) g.fill(circle(x, y, 3.2), hex('#d62828'));
  },
  tarta: (g) => {
    g.fill(ellipse(24, 40, 20, 4), hex('#dee2e6'));
    g.outlined(box(24, 29, 15, 10, 3), hex('#f7a8c4'), 2, hex('#c76b8f'));
    g.fill(union(box(24, 20, 15, 3.5, 3), circle(14, 23, 3), circle(24, 23.5, 3), circle(34, 23, 3)), C.white);
    g.fill(segment(26, 9, 28, 4, 1), hex('#6a994e'));
    g.outlined(circle(25, 13, 4.5), hex('#d62828'), 1.5);
  },
  ramen_picante: (g) => {
    g.fill(segment(14, 6, 30, 24, 1.6), C.brown);
    g.fill(segment(19, 5, 33, 24, 1.6), C.brown);
    g.outlined(intersect(circle(24, 24, 18), below(24)), hex('#d62828'), 2, hex('#7a1c1c'));
    g.fill(ellipse(24, 24, 18, 4.5), hex('#f4a261'));
    for (const x of [16, 22, 28]) g.fill(arc(x, 24, 3, 2.5, 1, 'bottom'), hex('#ffe08a'));
    g.fill(polygon([[33, 21], [40, 17], [37, 23]]), hex('#ff0000'));
  },
  banquete: (g) => {
    g.outlined(ellipse(24, 32, 21, 9), hex('#f1f3f5'), 2, hex('#adb5bd'));
    g.outlined(ellipse(21, 26, 11, 8), hex('#c8763a'), 2, hex('#7a4420'));
    g.fill(segment(30, 23, 38, 17, 2.2), C.white);
    g.fill(circle(39, 16, 2.6), C.white);
    g.fill(circle(10, 30, 3), hex('#6a994e'));
    g.fill(circle(36, 32, 3), hex('#e63946'));
    sparkle(g, 9, 11, 5);
  },
  agua: (g) => {
    g.outlined((x, y) => union(circle(24, 29, 12), polygon([[13, 25], [35, 25], [24, 5]]))(x, y), hex('#4fb3d9'), 2, hex('#1d6f93'));
    g.fill(ellipse(19, 28, 2.5, 4), C.white, 0.7);
  },
  zumo: (g) => {
    g.fill(segment(28, 4, 25, 16, 1.4), hex('#e63946'));
    g.outlined(polygon([[12, 12], [36, 12], [32, 42], [16, 42]]), hex('#ffe8cc'), 2, hex('#c08a2b'));
    g.fill(polygon([[13.5, 17], [34.5, 17], [31.5, 40], [16.5, 40]]), hex('#f4a261'));
    g.outlined(circle(36, 13, 6), hex('#ffb347'), 1.5, hex('#e07a1f'));
  },
  batido: (g) => {
    g.fill(segment(29, 2, 26, 14, 1.6), hex('#e63946'));
    g.outlined(polygon([[14, 14], [34, 14], [31, 44], [17, 44]]), hex('#f7a8c4'), 2, hex('#c76b8f'));
    g.fill(union(circle(17, 13, 4), circle(24, 11, 5), circle(31, 13, 4)), C.white);
    g.outlined(circle(24, 6, 3.5), hex('#d62828'), 1.2);
  },
  refresco: (g) => {
    g.outlined(box(24, 26, 11, 17, 4), hex('#2a9d8f'), 2, hex('#14524b'));
    g.fill(ellipse(24, 10, 9, 2.5), hex('#ced4da'));
    g.fill(box(24, 27, 11, 5), hex('#e9c46a'));
    for (const [x, y, r] of [[38, 12, 2], [41, 20, 1.5], [36, 26, 1.2]]) g.fill(ring(x, y, r, 0.6), hex('#4fb3d9'));
  },
  te_tila: (g) => {
    for (const x of [18, 25]) g.fill(arc(x, 9, 2.5, 3, 1, x === 18 ? 'top' : 'bottom'), hex('#adb5bd'));
    g.fill(ring(37, 28, 6, 2), hex('#d4a373'));
    g.outlined(intersect(box(22, 28, 14, 14, 6), below(16)), hex('#fefae0'), 2, hex('#d4a373'));
    g.fill(ellipse(22, 18, 12, 3), hex('#a3b18a'));
  },
  elixir: (g) => {
    const flask = union(circle(24, 30, 14), box(24, 12, 5, 8, 1));
    g.fill((x, y) => flask(x, y) - 2, hex('#5a189a'));
    const bands = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'];
    bands.forEach((c, i) => g.fill(intersect(circle(24, 30, 14), below(18 + i * 5.5), above(18 + (i + 1) * 5.5)), hex(c)));
    g.fill(box(24, 12, 5, 8, 1), hex('#e0d7f5'), 0.6);
    g.fill(box(24, 5, 6, 3, 1), C.brown);
    g.fill(ellipse(18, 26, 2.5, 4), C.white, 0.6);
  },
  pelota: (g) => {
    g.outlined(circle(24, 24, 17), hex('#c5e063'), 2, hex('#6b8a1a'));
    g.fill(intersect(ring(6, 24, 16, 1.6), circle(24, 24, 17)), C.white);
    g.fill(intersect(ring(42, 24, 16, 1.6), circle(24, 24, 17)), C.white);
  },
  laser: (g) => {
    g.fill(circle(38, 10, 7), hex('#ff0000'), 0.25);
    g.fill(circle(38, 10, 3.5), hex('#ff0000'));
    g.fill(segment(10, 38, 31, 17, 5), hex('#495057'));
    g.fill(segment(10, 38, 31, 17, 3), hex('#868e96'));
    g.fill(circle(32, 16, 2.4), hex('#ff6b6b'));
  },
  peluche: (g) => {
    for (const s of [-1, 1]) g.outlined(circle(24 + s * 12, 13, 6), hex('#b07d4f'), 2, hex('#6b4423'));
    g.outlined(circle(24, 27, 15), hex('#b07d4f'), 2, hex('#6b4423'));
    g.fill(ellipse(24, 32, 7, 5), hex('#e6c7a3'));
    g.fill(ellipse(24, 30, 2.6, 2), C.ink);
    for (const s of [-1, 1]) g.fill(circle(24 + s * 6, 23, 2), C.ink);
  },
  auriculares: (g) => {
    g.fill(arc(24, 26, 16, 16, 2.6, 'top'), hex('#343a40'));
    for (const s of [-1, 1]) g.outlined(box(24 + s * 16, 30, 5, 9, 3), C.accent, 2, hex('#a8432a'));
  },
  chuche_paz: (g) => {
    g.fill(polygon([[12, 24], [3, 15], [3, 33]]), hex('#ffafcc'));
    g.fill(polygon([[36, 24], [45, 15], [45, 33]]), hex('#ffafcc'));
    g.outlined(ellipse(24, 24, 13, 10), hex('#ff8fab'), 2, hex('#c9184a'));
    g.fill(ring(24, 24, 5.5, 1.2), C.white);
    g.fill(segment(24, 18.5, 24, 29.5, 1.2), C.white);
    g.fill(segment(24, 24, 20, 28, 1.2), C.white);
    g.fill(segment(24, 24, 28, 28, 1.2), C.white);
  },
  carta_disculpa: (g) => {
    g.outlined(box(24, 25, 18, 13, 2), hex('#fff8e7'), 2, hex('#adb5bd'));
    g.fill(union(segment(7, 13, 24, 27, 1.2), segment(41, 13, 24, 27, 1.2)), hex('#adb5bd'));
    heart(g, 24, 25, 5, hex('#d62828'));
  },
  vinilo: (g) => {
    g.fill(circle(24, 24, 19), hex('#1b1b1b'));
    for (const r of [9, 12, 15]) g.fill(ring(24, 24, r, 0.4), hex('#495057'));
    g.fill(circle(24, 24, 6), C.accent);
    g.fill(circle(24, 24, 1.4), hex('#1b1b1b'));
    g.fill(arc(24, 24, 16, 16, 1, 'top'), C.white, 0.15);
  },
  reloj_arena: (g) => {
    g.fill(polygon([[13, 9], [35, 9], [24, 24]]), hex('#ced4da'), 0.6);
    g.fill(polygon([[13, 39], [35, 39], [24, 24]]), hex('#ced4da'), 0.6);
    g.fill(polygon([[18, 15], [30, 15], [24, 22]]), hex('#e9c46a'));
    g.fill(polygon([[15, 39], [33, 39], [24, 31]]), hex('#e9c46a'));
    g.fill(segment(24, 22, 24, 38, 0.7), hex('#e9c46a'));
    g.fill(box(24, 7, 15, 2.5, 1), C.brown);
    g.fill(box(24, 41, 15, 2.5, 1), C.brown);
  },
};

for (const [id, draw] of Object.entries(ICONS)) {
  const g = new Img(I, I);
  draw(g);
  write(join(out, 'items', `${id}.png`), g.png());
}

// ====================================================================
// Sonidos (WAV mono 22 kHz)
// ====================================================================

const RATE = 22050;

function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(clamp(s, -1, 1) * 32767), 44 + i * 2));
  return buf;
}

/** Tono con barrido de frecuencia. `wave`: 'sine' | 'square' | 'tri'. */
function tone(dur, f0, f1, { wave = 'sine', vol = 0.5, vibrato = 0, decay = 0 } = {}) {
  const n = Math.floor(dur * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 + (f1 - f0) * t + Math.sin(i / RATE * 30) * vibrato;
    phase += (2 * Math.PI * f) / RATE;
    let s = Math.sin(phase);
    if (wave === 'square') s = Math.sign(s) * 0.6 + Math.sin(phase * 3) * 0.2;
    if (wave === 'tri') s = (2 / Math.PI) * Math.asin(Math.sin(phase));
    const env = Math.min(1, i / (RATE * 0.005)) * Math.min(1, (n - i) / (RATE * 0.02)) * (decay ? Math.exp(-t * decay) : 1);
    out[i] = s * vol * env;
  }
  return out;
}
const silence = (dur) => new Float32Array(Math.floor(dur * RATE));
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const mix = (a, b) => a.map((v, i) => v + (b[i] ?? 0));

const SOUNDS = {
  saludo: concat(tone(0.1, 520, 720, { wave: 'tri' }), tone(0.14, 720, 980, { wave: 'tri', vibrato: 20 })),
  risa: concat(...[0, 1, 2].flatMap((k) => [tone(0.07, 760 + k * 60, 1000 + k * 60, { wave: 'tri' }), silence(0.045)])),
  grunido: tone(0.38, 150, 110, { wave: 'square', vol: 0.35, vibrato: 25 }),
  comer: concat(tone(0.08, 320, 230, { wave: 'tri' }), silence(0.06), tone(0.08, 300, 210, { wave: 'tri' })),
  beber: concat(...[0, 1, 2].flatMap((k) => [tone(0.06, 650 - k * 90, 380 - k * 60, { vol: 0.45 }), silence(0.05)])),
  recoger: mix(tone(0.32, 1320, 1320, { decay: 7, vol: 0.35 }), tone(0.32, 1980, 1980, { decay: 9, vol: 0.15 })),
  pop: tone(0.07, 900, 280, { vol: 0.45 }),
  petted: tone(0.5, 85, 80, { wave: 'square', vol: 0.18, vibrato: 12 }).map((v, i) => v * (0.6 + 0.4 * Math.sin(i / RATE * 2 * Math.PI * 22))),
};

for (const [name, samples] of Object.entries(SOUNDS)) write(join(out, 'sounds', `${name}.wav`), wav(Array.from(samples)));

// ====================================================================
// skin.json (con comentarios: el juego acepta JSON con // comentarios)
// ====================================================================

const animLines = Object.entries(skinAnims)
  .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  .join(',\n');
const soundLines = Object.keys(SOUNDS)
  .map((k) => `    ${JSON.stringify(k)}: [${JSON.stringify(`sounds/${k}.wav`)}]`)
  .join(',\n');

write(
  join(out, 'skin.json'),
  `// Skin provisional generada por scripts/gen-placeholder.mjs. Cópiala como plantilla para tu propia skin.
{
  "nombre": "Gota provisional",
  // Escala con la que se dibuja (1 = tamaño real de los PNG).
  "escala": 1,
  // Punto de apoyo de los pies, normalizado: [0.5, 1] = centro abajo.
  "ancla": [0.5, 1],
  // Cada animación puede ser:
  //   { "frames": "carpeta/", "fps": 8, "loop": true }            → PNG numerados (000.png, 001.png...)
  //   { "sheet": "x.json", "fps": 8 }                              → sprite sheet de TexturePacker o Aseprite
  //   { "sheet": "x.json", "tag": "walk" }                         → una etiqueta (frameTags) de Aseprite
  // Nombres: idle, walk, drag, fall, eat, drink, happy, angry, talk, petted...
  // Variantes por mood: "<mood>_<animación>" (feliz_idle, cabreada_walk...). Si no existe, se usa la genérica.
  "animaciones": {
${animLines}
  },
  // Sonidos por evento. Si hay varios, se elige uno al azar.
  "sonidos": {
${soundLines}
  }
}
`,
);

console.log(`Skin provisional generada en ${out}`);
