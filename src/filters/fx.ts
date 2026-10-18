/** Higher-level building blocks shared by many filters. */

import {
  B,
  BAYER8,
  Img,
  RGB,
  blendImgs,
  boxBlur1,
  clamp,
  cloneImg,
  fbm,
  gauss1,
  grayOf,
  hash2,
  lerp,
  luma,
  makeImg,
  mapRGB,
  rgbToHsv,
  hsvToRgb,
  rng,
  gaussRand,
  sobel,
  xdog,
} from "./img";

export const posterize = (src: Img, levels: number): Img => {
  const n = Math.max(2, Math.round(levels));
  const step = 255 / (n - 1);
  return mapRGB(src, (r, g, b) => [Math.round(r / step) * step, Math.round(g / step) * step, Math.round(b / step) * step]);
};

/** Quantize brightness into bands while keeping each pixel's hue (cel shading). */
export function bandLuminance(src: Img, bands: number, softness = 0): Img {
  const n = Math.max(2, Math.round(bands));
  return mapRGB(src, (r, g, b) => {
    const l = luma(r, g, b) / 255;
    const x = l * n;
    const f = Math.floor(Math.min(n - 1, x));
    const t = softness > 0 ? clamp((x - f - (1 - softness) / 2) / Math.max(1e-3, softness), 0, 1) : 0;
    const q = Math.min(1, (f + 0.5 + t) / n);
    const k = l > 0.001 ? q / l : 0;
    return l > 0.001 ? [r * k, g * k, b * k] : [q * 255, q * 255, q * 255];
  });
}

export function saturate(src: Img, amount: number): Img {
  // amount: 1 = unchanged, 0 = gray, 2 = double.
  return mapRGB(src, (r, g, b) => {
    const l = luma(r, g, b);
    return [l + (r - l) * amount, l + (g - l) * amount, l + (b - l) * amount];
  });
}

export function vibrance(src: Img, amount: number): Img {
  return mapRGB(src, (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const s = (mx - mn) / 255;
    const k = 1 + amount * (1 - s);
    const l = luma(r, g, b);
    return [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
  });
}

export function contrast(src: Img, amount: number, pivot = 128): Img {
  // amount -100..100
  const k = amount >= 0 ? 1 + amount / 50 : 1 + amount / 100;
  return mapRGB(src, (r, g, b) => [pivot + (r - pivot) * k, pivot + (g - pivot) * k, pivot + (b - pivot) * k]);
}

/** Ink lines (0..1) from difference of Gaussians: thickness ~ sigma. */
export function inkLines(src: Img, thickness: number, detail = 0.5, threshold = 0.5): Float32Array {
  const g = grayOf(src);
  const pre = gauss1(g, src.w, src.h, 0.6 + (1 - detail) * 1.5);
  const sigma = Math.max(0.4, thickness * 0.5);
  return xdog(pre, src.w, src.h, sigma, 1.6, 18 + detail * 20, 0.05 + threshold * 0.25, 12);
}

/** Paint lines over an image in a color. */
export function overlayInk(src: Img, ink: Float32Array, color: RGB, strength = 1): Img {
  const out = cloneImg(src);
  const d = out.data;
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const k = ink[i] * strength;
    if (k <= 0) continue;
    d[p] = lerp(d[p], color[0], k);
    d[p + 1] = lerp(d[p + 1], color[1], k);
    d[p + 2] = lerp(d[p + 2], color[2], k);
  }
  return out;
}

/** Grayscale halftone screen: returns 0..1 ink coverage per pixel. */
export function halftoneMask(gray: Float32Array, w: number, h: number, cell: number, angleDeg: number, shape: string): Float32Array {
  const out = new Float32Array(w * h);
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  cell = Math.max(2, cell);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x * ca + y * sa) / cell, v = (-x * sa + y * ca) / cell;
      const fu = u - Math.floor(u) - 0.5, fv = v - Math.floor(v) - 0.5;
      const darkness = 1 - gray[y * w + x] / 255;
      let ink: number;
      if (shape === "line") ink = Math.abs(fv) * 2 < darkness ? 1 : 0;
      else if (shape === "square") ink = Math.max(Math.abs(fu), Math.abs(fv)) * 2 < Math.sqrt(darkness) ? 1 : 0;
      else if (shape === "cross") ink = Math.min(Math.abs(fu), Math.abs(fv)) * 2 < darkness * 0.6 ? 1 : 0;
      else {
        // Dot area matches the ink coverage (dots merge past ~78%).
        const r = Math.sqrt(darkness / Math.PI);
        const d = Math.sqrt(fu * fu + fv * fv);
        ink = clamp((r - d) * cell + 0.5, 0, 1);
      }
      out[y * w + x] = ink;
    }
  return out;
}

/** Colored-pencil / pencil-sketch base: color dodge of the inverted blur. */
export function sketchGray(src: Img, radius: number, strength = 1): Float32Array {
  const g = grayOf(src);
  const inv = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) inv[i] = 255 - g[i];
  const bl = gauss1(inv, src.w, src.h, Math.max(0.5, radius));
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    const v = B.colorDodge(g[i], bl[i]);
    out[i] = 255 - (255 - v) * strength;
  }
  return out;
}

/** Paper / canvas / burlap height fields 0..1. */
export function textureField(w: number, h: number, kind: string, scale: number, seed: number): Float32Array {
  const t = new Float32Array(w * h);
  const s = Math.max(0.2, scale);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v: number;
      switch (kind) {
        case "canvas": {
          // Plain weave: threads pass over and under each other.
          const p = 3 * s;
          const cx = Math.floor(x / p), cy = Math.floor(y / p);
          const fx = (x % p) / p, fy = (y % p) / p;
          const over = (cx + cy) % 2 === 0;
          const thread = over ? Math.sin(fy * Math.PI) : Math.sin(fx * Math.PI);
          v = 0.25 + 0.6 * thread * (0.85 + 0.15 * hash2(over ? cx : cy, over ? 0 : 1, seed)) + (hash2(x, y, seed) - 0.5) * 0.1;
          break;
        }
        case "burlap": {
          const a = Math.abs(Math.sin((x / (4 * s)) * Math.PI)), b = Math.abs(Math.sin((y / (4 * s)) * Math.PI));
          v = (Math.floor(x / (4 * s)) + Math.floor(y / (4 * s))) % 2 ? a : b;
          v = v * 0.8 + fbm(x / (6 * s), y / (6 * s), 2, seed) * 0.2;
          break;
        }
        case "brick": {
          const bh = 12 * s, bw = 28 * s;
          const row = Math.floor(y / bh);
          const xx = x + (row % 2 ? bw / 2 : 0);
          const mx = xx % bw, my = y % bh;
          const mortar = mx < 1.6 * s || my < 1.6 * s;
          v = mortar ? 0.1 : 0.7 + fbm(x / (5 * s), y / (5 * s), 3, seed) * 0.3;
          break;
        }
        case "sandstone":
          v = fbm(x / (2 * s), y / (2 * s), 4, seed, 0.6);
          break;
        case "linen": {
          const a = Math.sin((x / (1.4 * s)) * Math.PI) * 0.5 + 0.5, b = Math.sin((y / (1.4 * s)) * Math.PI) * 0.5 + 0.5;
          v = (a + b) / 2 * 0.7 + hash2(Math.floor(x / s), Math.floor(y / (6 * s)), seed) * 0.3;
          break;
        }
        default:
          // paper
          v = fbm(x / (3 * s), y / (3 * s), 4, seed, 0.55) * 0.75 + hash2(x, y, seed) * 0.25;
      }
      t[y * w + x] = clamp(v, 0, 1);
    }
  return t;
}

/** Light a height field and multiply it into the image (Texturizer). */
export function applyRelief(src: Img, height: Float32Array, relief: number, lightDeg = 135, invert = false): Img {
  const { w, h } = src;
  const out = cloneImg(src);
  const d = out.data;
  const la = (lightDeg * Math.PI) / 180;
  const lx = Math.cos(la), ly = -Math.sin(la);
  const k = relief * 6;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hx = height[y * w + Math.min(w - 1, x + 1)] - height[y * w + Math.max(0, x - 1)];
      const hy = height[Math.min(h - 1, y + 1) * w + x] - height[Math.max(0, y - 1) * w + x];
      let shade = (hx * lx + hy * ly) * k * (invert ? -1 : 1);
      shade = clamp(1 + shade, 0.3, 1.7);
      const p = i * 4;
      d[p] = d[p] * shade;
      d[p + 1] = d[p + 1] * shade;
      d[p + 2] = d[p + 2] * shade;
    }
  return out;
}

export function vignette(src: Img, amount: number, size = 0.7, roundness = 1, color: RGB = [0, 0, 0]): Img {
  const { w, h } = src;
  const out = cloneImg(src);
  const d = out.data;
  const cx = w / 2, cy = h / 2;
  const ax = roundness >= 1 ? Math.max(w, h) / 2 : w / 2, ay = roundness >= 1 ? Math.max(w, h) / 2 : h / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / ax, dy = (y - cy) / ay;
      const r = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const k = smooth(size * 0.7, size * 0.7 + 0.6, r) * amount;
      const p = (y * w + x) * 4;
      d[p] = lerp(d[p], color[0], k);
      d[p + 1] = lerp(d[p + 1], color[1], k);
      d[p + 2] = lerp(d[p + 2], color[2], k);
    }
  return out;
}
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Film-like grain: size in px, amount 0..100, luminance-weighted. */
export function grain(src: Img, amount: number, size: number, mono: boolean, seed: number): Img {
  const { w, h } = src;
  const r = rng(seed);
  const s = Math.max(0.5, size);
  const gw = Math.ceil(w / s) + 2, gh = Math.ceil(h / s) + 2;
  const n = 3;
  const fields: Float32Array[] = [];
  for (let c = 0; c < (mono ? 1 : n); c++) {
    let f: Float32Array = new Float32Array(gw * gh);
    for (let i = 0; i < f.length; i++) f[i] = gaussRand(r);
    if (s > 1.2) f = gauss1(f, gw, gh, 0.6);
    fields.push(f);
  }
  const out = cloneImg(src);
  const d = out.data;
  const amp = amount * 0.9;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = x / s, gy = y / s;
      const xi = Math.floor(gx), yi = Math.floor(gy), fx = gx - xi, fy = gy - yi;
      const p = (y * w + x) * 4;
      const l = luma(d[p], d[p + 1], d[p + 2]) / 255;
      // Grain shows most in midtones.
      const k = amp * (0.35 + 0.65 * 4 * l * (1 - l));
      for (let c = 0; c < 3; c++) {
        const f = fields[mono ? 0 : c];
        const a = f[yi * gw + xi], b = f[yi * gw + xi + 1], cc = f[(yi + 1) * gw + xi], dd = f[(yi + 1) * gw + xi + 1];
        const v = lerp(lerp(a, b, fx), lerp(cc, dd, fx), fy);
        d[p + c] = d[p + c] + v * k;
      }
    }
  return out;
}

/** Ordered (Bayer) or error-diffusion dithering to a palette. */
export function ditherTo(src: Img, pal: RGB[], method: string, strength = 1, pixel = 1): Img {
  const { w, h } = src;
  const out = cloneImg(src);
  const d = out.data;
  const near = (r: number, g: number, b: number) => {
    let best = pal[0], bd = Infinity;
    for (const c of pal) {
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      const dd = 0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db;
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    return best;
  };
  if (method === "floyd" || method === "atkinson") {
    const buf = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) buf[i * 3 + c] = d[i * 4 + c];
    const spread: [number, number, number][] =
      method === "floyd"
        ? [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]
        : [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = near(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
        for (let k = 0; k < 3; k++) {
          const err = (buf[i * 3 + k] - c[k]) * strength;
          d[i * 4 + k] = c[k];
          for (const [dx, dy, f] of spread) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || xx >= w || yy >= h) continue;
            buf[(yy * w + xx) * 3 + k] += err * f;
          }
        }
      }
    return out;
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const t = method === "none" ? 0 : ((BAYER8[Math.floor(y / pixel) % 8][Math.floor(x / pixel) % 8] + 0.5) / 64 - 0.5) * 64 * strength;
      const c = near(d[p] + t, d[p + 1] + t, d[p + 2] + t);
      d[p] = c[0];
      d[p + 1] = c[1];
      d[p + 2] = c[2];
    }
  return out;
}

/** Mosaic-average blocks of size px (keeps alpha averaged). */
export function pixelate(src: Img, size: number): Img {
  const { w, h, data } = src;
  const out = makeImg(w, h);
  const d = out.data;
  const s = Math.max(1, Math.round(size));
  for (let by = 0; by < h; by += s)
    for (let bx = 0; bx < w; bx += s) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const ye = Math.min(h, by + s), xe = Math.min(w, bx + s);
      for (let y = by; y < ye; y++)
        for (let x = bx; x < xe; x++) {
          const p = (y * w + x) * 4;
          const al = data[p + 3];
          r += data[p] * al;
          g += data[p + 1] * al;
          b += data[p + 2] * al;
          a += al;
          n++;
        }
      for (let y = by; y < ye; y++)
        for (let x = bx; x < xe; x++) {
          const p = (y * w + x) * 4;
          if (a > 0) {
            d[p] = r / a;
            d[p + 1] = g / a;
            d[p + 2] = b / a;
          }
          d[p + 3] = a / n;
        }
    }
  return out;
}

/** Bloom / glow: blurred bright parts screened on top. */
export function glow(src: Img, radius: number, threshold: number, strength: number, tint?: RGB): Img {
  const { w, h } = src;
  const bright = makeImg(w, h);
  const d = src.data, bd = bright.data;
  for (let p = 0; p < d.length; p += 4) {
    const l = luma(d[p], d[p + 1], d[p + 2]);
    const k = clamp((l - threshold) / Math.max(1, 255 - threshold), 0, 1);
    for (let c = 0; c < 3; c++) bd[p + c] = (tint ? tint[c] * (l / 255) : d[p + c]) * k;
    bd[p + 3] = 255;
  }
  const planes = [0, 1, 2].map((c) => {
    const f = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = bd[i * 4 + c];
    return gauss1(f, w, h, radius);
  });
  const out = cloneImg(src);
  const od = out.data;
  for (let i = 0; i < w * h; i++)
    for (let c = 0; c < 3; c++) od[i * 4 + c] = B.screen(od[i * 4 + c], clamp(planes[c][i] * strength));
  return out;
}

export function tint(src: Img, color: RGB, amount: number): Img {
  return mapRGB(src, (r, g, b) => {
    const l = luma(r, g, b) / 255;
    return [lerp(r, color[0] * l * 1.25, amount), lerp(g, color[1] * l * 1.25, amount), lerp(b, color[2] * l * 1.25, amount)];
  });
}

/** Split toning: shadows toward one hue, highlights toward another. */
export function splitTone(src: Img, shHue: number, shSat: number, hiHue: number, hiSat: number, balance = 0): Img {
  const sh = hsvToRgb(shHue, 1, 1), hi = hsvToRgb(hiHue, 1, 1);
  return mapRGB(src, (r, g, b) => {
    const l = luma(r, g, b) / 255;
    const ws = clamp(1 - l * 2 + balance, 0, 1) * shSat, wh = clamp(l * 2 - 1 - balance, 0, 1) * hiSat;
    const out = [r, g, b];
    for (let c = 0; c < 3; c++) {
      out[c] = B.softLight(out[c], lerp(128, sh[c], ws));
      out[c] = B.softLight(out[c], lerp(128, hi[c], wh));
    }
    return out;
  });
}

export function hueShift(src: Img, deg: number): Img {
  return mapRGB(src, (r, g, b) => {
    const [h, s, v] = rgbToHsv(r, g, b);
    return hsvToRgb(h + deg, s, v);
  });
}

export function edgesMag(src: Img, blur = 0): Float32Array {
  let g = grayOf(src);
  if (blur > 0) g = gauss1(g, src.w, src.h, blur);
  return sobel(g, src.w, src.h).mag;
}

export function blurPlane(p: Float32Array, w: number, h: number, r: number) {
  return boxBlur1(p, w, h, r);
}

export { blendImgs };
