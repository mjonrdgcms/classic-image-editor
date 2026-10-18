/**
 * The artistic rendering engine behind the painterly, cartoon and sketch
 * filters:
 *  - domain-transform edge-aware smoothing (Gastal & Oliveira 2011),
 *  - an edge tangent flow field from the smoothed structure tensor,
 *  - flow-based XDoG ink lines (Kang 2007 / Winnemöller 2012),
 *  - line integral convolution along the flow (brush streaks, hatching),
 *  - soft luminance quantization,
 *  - a stroke-based painter with bristle texture and impasto relief
 *    (after Hertzmann 1998),
 *  - pigment / paper models for watercolor and drawing media.
 * Everything works on planar Float32 data, O(n) or O(n·k) with small k, so
 * it stays usable on large photos.
 */

import { Img, RGB, clamp, gauss1, hash2, makeImg, rng, valueNoise } from "./img";

// ------------------------------------------------------------------ planes

export interface Planes {
  w: number;
  h: number;
  /** R, G, B in 0..1. */
  c: [Float32Array, Float32Array, Float32Array];
}

export function toPlanes(src: Img): Planes {
  const n = src.w * src.h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const d = src.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    r[i] = d[p] / 255;
    g[i] = d[p + 1] / 255;
    b[i] = d[p + 2] / 255;
  }
  return { w: src.w, h: src.h, c: [r, g, b] };
}

export function fromPlanes(p: Planes, alphaFrom?: Img): Img {
  const out = makeImg(p.w, p.h);
  const d = out.data;
  const [r, g, b] = p.c;
  for (let i = 0, q = 0; i < r.length; i++, q += 4) {
    d[q] = r[i] * 255;
    d[q + 1] = g[i] * 255;
    d[q + 2] = b[i] * 255;
    d[q + 3] = alphaFrom ? alphaFrom.data[q + 3] : 255;
  }
  return out;
}

export const clonePlanes = (p: Planes): Planes => ({ w: p.w, h: p.h, c: [p.c[0].slice(), p.c[1].slice(), p.c[2].slice()] });

export function lumaOf(p: Planes): Float32Array {
  const [r, g, b] = p.c;
  const l = new Float32Array(r.length);
  for (let i = 0; i < l.length; i++) l[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
  return l;
}

// ------------------------------------------------------------------ edge-aware smoothing

/**
 * Recursive domain-transform filter: smooths within regions, stops at
 * edges. sigmaS ~ spatial extent in px, sigmaR ~ edge contrast (0..1).
 * `guide` defaults to the image itself.
 */
export function dtSmooth(src: Planes, sigmaS: number, sigmaR: number, iterations = 3, guide?: Planes): Planes {
  const { w, h } = src;
  const out = clonePlanes(src);
  const G = guide ?? src;
  const n = w * h;
  // Derivatives of the domain transform along x and y.
  const dx = new Float32Array(n), dy = new Float32Array(n);
  const k = sigmaS / Math.max(1e-4, sigmaR);
  const [gr, gg, gb] = G.c;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) dx[i] = 1 + k * (Math.abs(gr[i] - gr[i - 1]) + Math.abs(gg[i] - gg[i - 1]) + Math.abs(gb[i] - gb[i - 1]));
      if (y > 0) dy[i] = 1 + k * (Math.abs(gr[i] - gr[i - w]) + Math.abs(gg[i] - gg[i - w]) + Math.abs(gb[i] - gb[i - w]));
    }
  const Vx = new Float32Array(n), Vy = new Float32Array(n);
  for (let it = 0; it < iterations; it++) {
    const sH = (sigmaS * Math.sqrt(3) * Math.pow(2, iterations - (it + 1))) / Math.sqrt(Math.pow(4, iterations) - 1);
    const lnA = -Math.sqrt(2) / sH;
    for (let i = 0; i < n; i++) {
      Vx[i] = Math.exp(lnA * dx[i]);
      Vy[i] = Math.exp(lnA * dy[i]);
    }
    for (const ch of out.c) {
      // Horizontal passes.
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 1; x < w; x++) ch[row + x] += Vx[row + x] * (ch[row + x - 1] - ch[row + x]);
        for (let x = w - 2; x >= 0; x--) ch[row + x] += Vx[row + x + 1] * (ch[row + x + 1] - ch[row + x]);
      }
      // Vertical passes, walked row by row for cache-friendly access.
      for (let y = 1; y < h; y++) {
        const row = y * w, prev = row - w;
        for (let x = 0; x < w; x++) ch[row + x] += Vy[row + x] * (ch[prev + x] - ch[row + x]);
      }
      for (let y = h - 2; y >= 0; y--) {
        const row = y * w, next = row + w;
        for (let x = 0; x < w; x++) ch[row + x] += Vy[next + x] * (ch[next + x] - ch[row + x]);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ flow field

export interface Flow {
  w: number;
  h: number;
  /** Unit tangent (along edges / isophotes). */
  tx: Float32Array;
  ty: Float32Array;
  /** 0 (no structure) .. 1 (strongly oriented). */
  coh: Float32Array;
  /** Gradient magnitude of the input (0..~1). */
  mag: Float32Array;
}

/** Edge tangent flow from the smoothed structure tensor. sigma ~ how far orientation spreads. */
export function flowField(p: Planes, sigma: number): Flow {
  const { w, h } = p;
  const n = w * h;
  const E = new Float32Array(n), F = new Float32Array(n), G = new Float32Array(n), mag = new Float32Array(n);
  for (const ch of p.c) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1), ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
        const gx = (ch[ym * w + xp] + 2 * ch[y * w + xp] + ch[yp * w + xp] - ch[ym * w + xm] - 2 * ch[y * w + xm] - ch[yp * w + xm]) / 8;
        const gy = (ch[yp * w + xm] + 2 * ch[yp * w + x] + ch[yp * w + xp] - ch[ym * w + xm] - 2 * ch[ym * w + x] - ch[ym * w + xp]) / 8;
        const i = y * w + x;
        E[i] += gx * gx;
        F[i] += gx * gy;
        G[i] += gy * gy;
      }
  }
  for (let i = 0; i < n; i++) mag[i] = Math.sqrt(E[i] + G[i]);
  const Es = gauss1(E, w, h, sigma), Fs = gauss1(F, w, h, sigma), Gs = gauss1(G, w, h, sigma);
  const tx = new Float32Array(n), ty = new Float32Array(n), coh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = Es[i], f = Fs[i], g = Gs[i];
    // Angle of the dominant gradient; the tangent is perpendicular to it.
    const phi = 0.5 * Math.atan2(2 * f, e - g);
    tx[i] = -Math.sin(phi);
    ty[i] = Math.cos(phi);
    const tr = e + g;
    const disc = Math.sqrt((e - g) * (e - g) + 4 * f * f);
    coh[i] = tr > 1e-9 ? disc / tr : 0;
  }
  return { w, h, tx, ty, coh, mag };
}

/** Bilinear sample of a plane with clamped edges. */
export function samp(a: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const i00 = y0 * w + x0;
  const top = a[i00] + (a[y0 * w + x1] - a[i00]) * fx;
  const bot = a[y1 * w + x0] + (a[y1 * w + x1] - a[y1 * w + x0]) * fx;
  return top + (bot - top) * fy;
}

/**
 * Line integral convolution: average `field` along the flow through each
 * pixel over +-len px (triangle weights), e.g. noise into brush streaks.
 * `angle` rotates the flow (0 = along edges, 90 = across them).
 */
export function lic(field: Float32Array, flow: Flow, len: number, angleDeg = 0, step = 1): Float32Array {
  const { w, h, tx, ty } = flow;
  const out = new Float32Array(w * h);
  const ca = Math.cos((angleDeg * Math.PI) / 180), sa = Math.sin((angleDeg * Math.PI) / 180);
  const L = Math.max(1, Math.round(len / step));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = field[i] * (L + 1), wsum = L + 1;
      for (const dir of [1, -1]) {
        let px = x, py = y;
        let vx = tx[i] * ca - ty[i] * sa, vy = tx[i] * sa + ty[i] * ca;
        vx *= dir;
        vy *= dir;
        for (let s = 1; s <= L; s++) {
          px += vx * step;
          py += vy * step;
          if (px < 0 || py < 0 || px > w - 1 || py > h - 1) break;
          const j = (py | 0) * w + (px | 0);
          let nx = tx[j] * ca - ty[j] * sa, ny = tx[j] * sa + ty[j] * ca;
          if (nx * vx + ny * vy < 0) {
            nx = -nx;
            ny = -ny;
          }
          vx = nx;
          vy = ny;
          const wt = L + 1 - s;
          sum += samp(field, w, h, px, py) * wt;
          wsum += wt;
        }
      }
      out[i] = sum / wsum;
    }
  return out;
}

/** Smooth a plane along the flow only (keeps edges crisp across). */
export function flowBlur(field: Float32Array, flow: Flow, sigma: number): Float32Array {
  const { w, h, tx, ty } = flow;
  const out = new Float32Array(w * h);
  const L = Math.max(1, Math.ceil(sigma * 2.5));
  const wts = new Float32Array(L + 1);
  for (let s = 0; s <= L; s++) wts[s] = Math.exp(-(s * s) / (2 * sigma * sigma));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = field[i] * wts[0], wsum = wts[0];
      for (const dir of [1, -1]) {
        let px = x, py = y, vx = tx[i] * dir, vy = ty[i] * dir;
        for (let s = 1; s <= L; s++) {
          px += vx;
          py += vy;
          if (px < 0 || py < 0 || px > w - 1 || py > h - 1) break;
          const j = (py | 0) * w + (px | 0);
          let nx = tx[j], ny = ty[j];
          if (nx * vx + ny * vy < 0) {
            nx = -nx;
            ny = -ny;
          }
          vx = nx;
          vy = ny;
          sum += samp(field, w, h, px, py) * wts[s];
          wsum += wts[s];
        }
      }
      out[i] = sum / wsum;
    }
  return out;
}

// ------------------------------------------------------------------ ink lines

export interface InkOptions {
  /** Line width ~ sigma of the inner Gaussian, px. */
  sigma: number;
  /** Smoothing along the lines, px (longer = cleaner, more continuous). */
  flowSigma?: number;
  /** Sensitivity: higher finds fainter edges (10..80). */
  p?: number;
  /** Threshold: higher = fewer lines (0..1). */
  eps?: number;
  /** Edge sharpness of the strokes. */
  phi?: number;
}

/**
 * Flow-based XDoG: clean, continuous ink lines that follow the image's
 * edges. Returns ink coverage 0..1.
 */
export function flowInk(gray: Float32Array, flow: Flow, o: InkOptions): Float32Array {
  const { w, h, tx, ty } = flow;
  const sigma = Math.max(0.35, o.sigma);
  const k = 1.6;
  const p = o.p ?? 25;
  const eps = o.eps ?? 0.35;
  const phi = o.phi ?? 6;
  // 1. DoG across the edges (along the gradient = perpendicular to the tangent).
  const S = Math.ceil(sigma * k * 2.5);
  const g1 = new Float32Array(S + 1), g2 = new Float32Array(S + 1);
  let s1 = 0, s2 = 0;
  for (let t = 0; t <= S; t++) {
    g1[t] = Math.exp(-(t * t) / (2 * sigma * sigma));
    g2[t] = Math.exp(-(t * t) / (2 * k * k * sigma * sigma));
    s1 += t ? 2 * g1[t] : g1[t];
    s2 += t ? 2 * g2[t] : g2[t];
  }
  const dog = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = ty[i], gy = -tx[i];
      let a = gray[i] * g1[0], b = gray[i] * g2[0];
      for (let t = 1; t <= S; t++) {
        const v1 = samp(gray, w, h, x + gx * t, y + gy * t) + samp(gray, w, h, x - gx * t, y - gy * t);
        a += v1 * g1[t];
        b += v1 * g2[t];
      }
      a /= s1;
      b /= s2;
      dog[i] = (1 + p) * a - p * b;
    }
  // 2. Smooth along the flow for coherent strokes.
  const sm = flowBlur(dog, flow, o.flowSigma ?? 3);
  // 3. Soft threshold.
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const u = sm[i];
    const e = u >= eps ? 1 : 1 + Math.tanh(phi * (u - eps));
    out[i] = 1 - clamp(e, 0, 1);
  }
  return out;
}

/** Thicken (dilate softly) an ink mask by r px. */
export function thicken(ink: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0.25) return ink;
  const b = gauss1(ink, w, h, r * 0.6);
  const out = new Float32Array(ink.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp(Math.max(ink[i], b[i] * 2.2), 0, 1);
  return out;
}

// ------------------------------------------------------------------ tone

/**
 * Soft luminance quantization (Winnemöller 2006): flattens tones into
 * `levels` bands with smooth steps whose sharpness follows `sharpness`.
 * Works on the planes in place, keeping chroma.
 */
export function quantizeLuma(p: Planes, levels: number, sharpness: number): void {
  const [r, g, b] = p.c;
  const q = 1 / Math.max(1, levels - 1);
  for (let i = 0; i < r.length; i++) {
    const l = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    const nearest = Math.round(l / q) * q;
    const lq = nearest + (q / 2) * Math.tanh(sharpness * (l - nearest));
    const d = lq - l;
    r[i] += d;
    g[i] += d;
    b[i] += d;
  }
}

/** Saturation / vibrance in place (amount 1 = unchanged). */
export function saturatePlanes(p: Planes, amount: number): void {
  const [r, g, b] = p.c;
  for (let i = 0; i < r.length; i++) {
    const l = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    r[i] = l + (r[i] - l) * amount;
    g[i] = l + (g[i] - l) * amount;
    b[i] = l + (b[i] - l) * amount;
  }
}

export function clampPlanes(p: Planes): void {
  for (const ch of p.c) for (let i = 0; i < ch.length; i++) ch[i] = ch[i] < 0 ? 0 : ch[i] > 1 ? 1 : ch[i];
}

/** Multiply ink of a color into the planes. */
export function inkOver(p: Planes, ink: Float32Array, color: RGB, strength = 1): void {
  const cr = color[0] / 255, cg = color[1] / 255, cb = color[2] / 255;
  const [r, g, b] = p.c;
  for (let i = 0; i < r.length; i++) {
    const k = ink[i] * strength;
    if (k <= 0) continue;
    r[i] += (cr - r[i]) * k;
    g[i] += (cg - g[i]) * k;
    b[i] += (cb - b[i]) * k;
  }
}

// ------------------------------------------------------------------ noise and paper

/** White noise plane 0..1. */
export function noisePlane(w: number, h: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = r();
  return out;
}

/** Smooth fractal noise plane (scale = feature size in px), 0..1. */
export function fbmPlane(w: number, h: number, scale: number, octaves: number, seed: number, rough = 0.5): Float32Array {
  const out = new Float32Array(w * h);
  const inv = 1 / Math.max(0.5, scale);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0, amp = 1, norm = 0, f = inv;
      for (let o = 0; o < octaves; o++) {
        sum += valueNoise(x * f + o * 17.3, y * f + o * 9.1, seed + o * 31) * amp;
        norm += amp;
        amp *= rough;
        f *= 2;
      }
      out[y * w + x] = sum / norm;
    }
  return out;
}

/** Normalize a plane to 0..1 by its percentiles (robust contrast stretch). */
export function stretch(a: Float32Array, lo = 0.01, hi = 0.99): Float32Array {
  const s = Float32Array.from(a.length > 200000 ? a.filter((_, i) => i % 7 === 0) : a).sort();
  const a0 = s[Math.floor(lo * (s.length - 1))], a1 = s[Math.floor(hi * (s.length - 1))];
  const k = 1 / Math.max(1e-6, a1 - a0);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = clamp((a[i] - a0) * k, 0, 1);
  return out;
}

export type PaperKind = "cold" | "hot" | "rough" | "canvas" | "linen" | "charcoal" | "pastel" | "smooth";

/**
 * Paper / canvas height field 0..1, `scale` ~ grain size multiplier.
 * Watercolor papers are cellular and blotchy; drawing papers have a fine
 * tooth; canvas is a woven grid.
 */
export function paper(w: number, h: number, kind: PaperKind, scale: number, seed: number): Float32Array {
  const s = Math.max(0.3, scale);
  const out = new Float32Array(w * h);
  if (kind === "canvas" || kind === "linen") {
    const pitch = (kind === "canvas" ? 4.2 : 2.6) * s;
    const nz = noisePlane(w, h, seed);
    const slub = fbmPlane(w, h, 40 * s, 2, seed + 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const fx = x / pitch, fy = y / pitch;
        const cx = Math.floor(fx), cy = Math.floor(fy);
        const over = ((cx + cy) & 1) === 0;
        const ux = fx - cx, uy = fy - cy;
        // Threads are rounded; the weave alternates over / under.
        const warp = Math.sin(ux * Math.PI), weft = Math.sin(uy * Math.PI);
        let v = over ? 0.35 + 0.65 * weft * (0.8 + 0.2 * Math.sin(ux * Math.PI)) : 0.35 + 0.65 * warp * (0.8 + 0.2 * Math.sin(uy * Math.PI));
        v *= 0.85 + 0.3 * (slub[y * w + x] - 0.5);
        v += (nz[y * w + x] - 0.5) * 0.12;
        out[y * w + x] = v;
      }
    return stretch(out);
  }
  const fine = noisePlane(w, h, seed);
  const fineB = gauss1(fine, w, h, 0.6 * s);
  switch (kind) {
    case "cold":
    case "rough": {
      const blot = fbmPlane(w, h, (kind === "rough" ? 9 : 6) * s, 4, seed + 1, 0.55);
      const cell = fbmPlane(w, h, 2.2 * s, 2, seed + 2, 0.5);
      for (let i = 0; i < out.length; i++) out[i] = blot[i] * 0.55 + cell[i] * 0.3 + fineB[i] * 0.15;
      break;
    }
    case "hot": {
      const blot = fbmPlane(w, h, 14 * s, 3, seed + 1, 0.5);
      for (let i = 0; i < out.length; i++) out[i] = blot[i] * 0.6 + fineB[i] * 0.4;
      break;
    }
    case "charcoal":
    case "pastel": {
      // Laid paper: fine tooth plus faint parallel ribs.
      const tooth = gauss1(fine, w, h, 0.9 * s);
      const fib = fbmPlane(w, h, 3 * s, 2, seed + 5, 0.5);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const rib = kind === "pastel" ? 0.5 + 0.5 * Math.sin((y / (5 * s)) * Math.PI * 2 + fib[i] * 2) : 0.5;
          out[i] = tooth[i] * 0.6 + fib[i] * 0.25 + rib * 0.15;
        }
      break;
    }
    default:
      for (let i = 0; i < out.length; i++) out[i] = fineB[i];
  }
  return stretch(out);
}

/** Lambert shading of a height field: 1 = flat, >1 lit, <1 shadowed. */
export function shade(height: Float32Array, w: number, h: number, strength: number, lightDeg = 135): Float32Array {
  const la = (lightDeg * Math.PI) / 180;
  const lx = Math.cos(la), ly = -Math.sin(la);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hx = height[y * w + Math.min(w - 1, x + 1)] - height[y * w + Math.max(0, x - 1)];
      const hy = height[Math.min(h - 1, y + 1) * w + x] - height[Math.max(0, y - 1) * w + x];
      // Normal from the gradient; light from above-left.
      const nx = -hx * strength, ny = -hy * strength;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      out[i] = 1 + ((nx * lx + ny * ly) / len) * 1.2;
    }
  return out;
}

// ------------------------------------------------------------------ painting with strokes

export interface StrokeOptions {
  /** Brush radii, largest first (px). */
  radii: number[];
  /** Max stroke length in brush radii. */
  length: number;
  /** Min stroke length in radii. */
  minLength?: number;
  /** Stop a stroke when the color differs from the stroke's by more than this (0..1). */
  colorStop: number;
  /** Paint only where canvas and reference differ more than this (0..1). */
  threshold: number;
  /** Stroke opacity 0..1. */
  opacity: number;
  /** Bristle texture 0 (flat) .. 1 (streaky, dry). */
  bristle: number;
  /** Random color jitter 0..1 (impressionist broken color). */
  jitter: number;
  /** Curvature: 1 follows the flow, 0 straight. */
  curve: number;
  /** Stroke shape: round tip, flat (palette knife) or dab (no length). */
  shape: "round" | "flat" | "dab";
  /** Spacing between stroke starts, in radii (1 = dense). */
  spacing?: number;
  /** Start from a blank canvas of this color (else the blurred image). */
  ground?: RGB | null;
  /** Fixed stroke direction in degrees instead of the image flow. */
  angle?: number | null;
  seed: number;
  /** Optional per-pixel stroke height output (impasto). */
  height?: Float32Array;
  /** Reference blur per layer, as a fraction of the radius. */
  blur?: number;
  /** Flow from the image (shared with other passes). */
  flow?: Flow;
}

/**
 * Stroke-based painterly rendering: several brush sizes from coarse to
 * fine, each laying curved strokes that follow the image's flow where the
 * canvas still differs from a blurred reference. Strokes have a bristle
 * texture and can record their height for impasto lighting.
 */
export function paintStrokes(src: Planes, o: StrokeOptions): Planes {
  const { w, h } = src;
  const n = w * h;
  const R = rng(o.seed);
  const canvas: Planes = o.ground
    ? { w, h, c: [new Float32Array(n).fill(o.ground[0] / 255), new Float32Array(n).fill(o.ground[1] / 255), new Float32Array(n).fill(o.ground[2] / 255)] }
    : (() => {
        const big = Math.max(2, o.radii[0] * 1.5);
        return { w, h, c: src.c.map((ch) => gauss1(ch, w, h, big)) as Planes["c"] };
      })();
  const flow = o.flow ?? flowField(dtSmooth(src, 12, 0.4, 2), Math.max(2, o.radii[o.radii.length - 1] * 1.5));
  const height = o.height;
  const fixed = o.angle != null ? { x: Math.cos((o.angle * Math.PI) / 180), y: Math.sin((o.angle * Math.PI) / 180) } : null;
  const [cr, cg, cb] = canvas.c;

  for (const radius of o.radii) {
    const rad = Math.max(0.75, radius);
    const ref = src.c.map((ch) => gauss1(ch, w, h, Math.max(0.5, rad * (o.blur ?? 0.5)))) as Planes["c"];
    const [rr, rg, rb] = ref;
    const grid = Math.max(1, rad * (o.spacing ?? 1));
    // Stroke starts: one per grid cell where the canvas is still off, in random order.
    const starts: number[] = [];
    for (let gy = 0; gy < h; gy += grid)
      for (let gx = 0; gx < w; gx += grid) {
        const x0 = Math.floor(gx), y0 = Math.floor(gy);
        const x1 = Math.min(w, Math.floor(gx + grid)), y1 = Math.min(h, Math.floor(gy + grid));
        let err = 0, best = -1, bestE = -1, cnt = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            const i = y * w + x;
            const e = Math.abs(cr[i] - rr[i]) + Math.abs(cg[i] - rg[i]) + Math.abs(cb[i] - rb[i]);
            err += e;
            cnt++;
            if (e > bestE) {
              bestE = e;
              best = i;
            }
          }
        if (cnt && err / cnt > o.threshold * 3 && best >= 0) {
          // A little positional jitter keeps the grid from showing.
          const bx = clamp((best % w) + (R() - 0.5) * grid * 0.8, 0, w - 1), by = clamp(Math.floor(best / w) + (R() - 0.5) * grid * 0.8, 0, h - 1);
          starts.push((by | 0) * w + (bx | 0));
        }
      }
    for (let i = starts.length - 1; i > 0; i--) {
      const j = Math.floor(R() * (i + 1));
      [starts[i], starts[j]] = [starts[j], starts[i]];
    }
    for (const s0 of starts) {
      const sx = s0 % w, sy = (s0 / w) | 0;
      // Stroke color from the reference, with broken-color jitter.
      const jit = o.jitter;
      let colR = rr[s0], colG = rg[s0], colB = rb[s0];
      if (jit > 0) {
        const jl = (R() - 0.5) * 0.25 * jit, jh = (R() - 0.5) * 0.3 * jit;
        colR = clamp(colR + jl + jh, 0, 1);
        colG = clamp(colG + jl, 0, 1);
        colB = clamp(colB + jl - jh, 0, 1);
      }
      // Trace the stroke along the flow.
      const pts: number[] = [sx, sy];
      if (o.shape !== "dab") {
        const maxL = Math.max(1, Math.round(o.length * (0.6 + 0.4 * R())));
        const minL = o.minLength ?? 1;
        let x = sx, y = sy;
        let px = 0, py = 0;
        for (let k = 0; k < maxL; k++) {
          const i = (y | 0) * w + (x | 0);
          if (k >= minL) {
            const dc = Math.abs(rr[i] - colR) + Math.abs(rg[i] - colG) + Math.abs(rb[i] - colB);
            const dCanvas = Math.abs(rr[i] - cr[i]) + Math.abs(rg[i] - cg[i]) + Math.abs(rb[i] - cb[i]);
            if (dc > o.colorStop * 3 || dCanvas < dc * 0.5) break;
          }
          let dx = fixed ? fixed.x : flow.tx[i], dy = fixed ? fixed.y : flow.ty[i];
          if (k === 0 && R() < 0.5) {
            dx = -dx;
            dy = -dy;
          }
          if (k > 0) {
            if (dx * px + dy * py < 0) {
              dx = -dx;
              dy = -dy;
            }
            // Curvature filter: blend with the previous direction.
            dx = o.curve * dx + (1 - o.curve) * px;
            dy = o.curve * dy + (1 - o.curve) * py;
            const l = Math.hypot(dx, dy) || 1;
            dx /= l;
            dy /= l;
          }
          px = dx;
          py = dy;
          x += dx * rad;
          y += dy * rad;
          if (x < 0 || y < 0 || x > w - 1 || y > h - 1) break;
          pts.push(x, y);
        }
      }
      drawStroke(canvas, pts, rad, [colR, colG, colB], o, R, height);
    }
  }
  return canvas;
}

let scratchD = new Float32Array(0), scratchA = new Float32Array(0), scratchC = new Float32Array(0);

/** Rasterize one stroke (polyline, radius) with bristles into the canvas. */
function drawStroke(canvas: Planes, pts: number[], rad: number, col: number[], o: StrokeOptions, R: () => number, height?: Float32Array): void {
  const { w, h } = canvas;
  const [cr, cg, cb] = canvas.c;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) {
    x0 = Math.min(x0, pts[k]);
    x1 = Math.max(x1, pts[k]);
    y0 = Math.min(y0, pts[k + 1]);
    y1 = Math.max(y1, pts[k + 1]);
  }
  const pad = rad + 2;
  const bx0 = Math.max(0, Math.floor(x0 - pad)), by0 = Math.max(0, Math.floor(y0 - pad));
  const bx1 = Math.min(w - 1, Math.ceil(x1 + pad)), by1 = Math.min(h - 1, Math.ceil(y1 + pad));
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  if (bw <= 0 || bh <= 0) return;
  const bn = bw * bh;
  if (scratchD.length < bn) {
    scratchD = new Float32Array(bn * 2);
    scratchA = new Float32Array(bn * 2);
    scratchC = new Float32Array(bn * 2);
  }
  const D = scratchD, AL = scratchA, AC = scratchC;
  D.fill(1e9, 0, bn);
  const segs = pts.length / 2 - 1;
  let cum = 0;
  // Distance to the polyline per pixel, with along / across coordinates, one segment at a time.
  const nseg = Math.max(1, segs);
  for (let k = 0; k < nseg; k++) {
    const ax = pts[2 * k], ay = pts[2 * k + 1];
    const bx = segs > 0 ? pts[2 * k + 2] : ax, by = segs > 0 ? pts[2 * k + 3] : ay;
    const vx = bx - ax, vy = by - ay;
    const len = Math.hypot(vx, vy);
    const l2 = len * len || 1;
    const nx = len ? -vy / len : 0, ny = len ? vx / len : 1;
    const sx0 = Math.max(bx0, Math.floor(Math.min(ax, bx) - pad)), sx1 = Math.min(bx1, Math.ceil(Math.max(ax, bx) + pad));
    const sy0 = Math.max(by0, Math.floor(Math.min(ay, by) - pad)), sy1 = Math.min(by1, Math.ceil(Math.max(ay, by) + pad));
    for (let y = sy0; y <= sy1; y++)
      for (let x = sx0; x <= sx1; x++) {
        let t = len ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + vx * t - x, qy = ay + vy * t - y;
        const d = Math.sqrt(qx * qx + qy * qy);
        const j = (y - by0) * bw + (x - bx0);
        if (d < D[j]) {
          D[j] = d;
          AL[j] = cum + t * len;
          AC[j] = ((x - ax) * nx + (y - ay) * ny) / rad;
        }
      }
    cum += len;
  }
  const total = cum;
  const seed = (R() * 1e9) | 0;
  const bristles = 0.35 + 3.2 / Math.max(1, rad / 3);
  const op = o.opacity;
  const flat = o.shape === "flat";
  for (let y = by0; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++) {
      const j = (y - by0) * bw + (x - bx0);
      const best = D[j];
      if (best > rad + 1) continue;
      const along = AL[j], across = AC[j];
      let r = rad;
      // Round strokes taper at the ends; flat (knife) strokes keep square ends.
      if (!flat && segs > 0) {
        const endT = Math.min(along, total - along) / rad;
        if (endT < 1) r = rad * Math.sqrt(Math.max(0, 1 - (1 - endT) * (1 - endT) * 0.6));
      }
      if (best > r + 1) continue;
      let a = best <= r - 1 ? 1 : (r + 1 - best) / 2;
      // Bristles: streaks along the stroke, drier towards the end.
      if (o.bristle > 0) {
        const lane = (across + 1) * bristles * 4;
        const streak = valueNoise(lane, along / (rad * 3), seed) * 0.6 + hash2(Math.floor(lane * 2), Math.floor(along / 2), seed) * 0.4;
        const dry = total > 0 ? along / total : 0;
        const cover = 1 - o.bristle * (0.35 + 0.65 * dry);
        a *= clamp((streak - (1 - cover)) * 3 + 0.5, 0, 1);
      }
      a *= op;
      if (a <= 0.002) continue;
      const i = y * w + x;
      // Paint streaks: each bristle lane carries a slightly lighter or darker load.
      const tone = o.bristle > 0 ? 1 + (valueNoise((across + 1) * bristles * 2.2, along / (rad * 6), seed + 5) - 0.5) * 0.22 * o.bristle : 1;
      cr[i] += (col[0] * tone - cr[i]) * a;
      cg[i] += (col[1] * tone - cg[i]) * a;
      cb[i] += (col[2] * tone - cb[i]) * a;
      if (height) {
        // Paint ridges: thick in the middle, bristle grooves across.
        const prof = Math.sqrt(Math.max(0, 1 - (best / (r + 0.5)) ** 2));
        const groove = 0.6 + 0.4 * Math.sin((across + 1) * bristles * 6 + seed);
        const hv = prof * groove * Math.min(1, rad / 6);
        height[i] += (hv - height[i]) * a;
      }
    }
}

// ------------------------------------------------------------------ watercolor pigment model

/**
 * Darken colors as if pigment were denser (Bousseau 2006): d > 1 darkens,
 * d < 1 lightens; works in place on 0..1 planes.
 */
export function pigmentDensity(p: Planes, density: Float32Array): void {
  for (const ch of p.c)
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i], d = density[i] - 1;
      ch[i] = clamp(c - (c - c * c) * d, 0, 1);
    }
}

/** Shift an image by a displacement field (bilinear), e.g. hand-made wobble. */
export function displace(p: Planes, dx: Float32Array, dy: Float32Array): Planes {
  const { w, h } = p;
  const out: Planes = { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let c = 0; c < 3; c++) out.c[c][i] = samp(p.c[c], w, h, x + dx[i], y + dy[i]);
    }
  return out;
}

/** Gradient magnitude of the luma of planes, blurred a little. */
export function edgeMap(p: Planes, blur: number): Float32Array {
  const { w, h } = p;
  const l = lumaOf(p);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = l[y * w + Math.min(w - 1, x + 1)] - l[y * w + Math.max(0, x - 1)];
      const gy = l[Math.min(h - 1, y + 1) * w + x] - l[Math.max(0, y - 1) * w + x];
      out[y * w + x] = Math.hypot(gx, gy);
    }
  return blur > 0.3 ? gauss1(out, w, h, blur) : out;
}

/**
 * Straight parallel hatching strokes 0..1 (1 = stroke) at an angle:
 * lines `spacing` px apart, broken into dashes of random length, with a
 * slight wobble. `flow` (optional) bends the angle towards the image's
 * flow by `bend` (0..1).
 */
export function hatchPlane(w: number, h: number, angleDeg: number, spacing: number, dash: number, seed: number, flow?: Flow, bend = 0): Float32Array {
  const out = new Float32Array(w * h);
  const a0 = (angleDeg * Math.PI) / 180;
  const sp = Math.max(1.2, spacing);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let a = a0;
      if (flow && bend > 0) {
        const fa = Math.atan2(flow.ty[i], flow.tx[i]);
        // Bend towards the flow, choosing the nearer of the two flow directions.
        let d = fa - a0;
        d = ((d + Math.PI / 2) % Math.PI + Math.PI) % Math.PI - Math.PI / 2;
        a = a0 + d * bend * flow.coh[i];
      }
      const ca = Math.cos(a), sa = Math.sin(a);
      const u = x * ca + y * sa;
      let v = -x * sa + y * ca;
      v += (valueNoise(u / (sp * 8), 0.5, seed) - 0.5) * sp * 0.8;
      const k = Math.floor(v / sp);
      const f = v / sp - k;
      const prof = Math.pow(Math.sin(f * Math.PI), 2.5);
      // Dashes: each line is made of strokes of varying length and pressure.
      const seg = valueNoise(u / Math.max(2, dash), k * 7.31, seed + 1);
      const press = 0.55 + 0.45 * hash2(k, Math.floor(u / Math.max(2, dash)), seed + 2);
      out[i] = prof * press * sstepRaw(0.25, 0.55, seg);
    }
  return out;
}

function sstepRaw(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

/** Tone curve helpers on 0..1 values. */
export const gamma = (v: number, g: number) => Math.pow(clamp(v, 0, 1), g);
export const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
