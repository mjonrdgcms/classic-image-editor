/**
 * Image primitives shared by the filter library: blurs, convolution,
 * edge detection, edge-preserving smoothing, noise, Voronoi cells,
 * resampling and color math. Everything works on straight RGBA buffers
 * and plain typed arrays, so it runs the same on the main thread and in
 * the preview worker.
 */

export interface Img {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export type RGB = [number, number, number];

export const makeImg = (w: number, h: number): Img => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });
export const cloneImg = (a: Img): Img => ({ w: a.w, h: a.h, data: new Uint8ClampedArray(a.data) });
export const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

export function hexRGB(h: string): RGB {
  const n = parseInt(String(h).replace("#", "").padEnd(6, "0").slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Map every pixel's color (alpha untouched). */
export function mapRGB(src: Img, fn: (r: number, g: number, b: number, i: number) => RGB | number[]): Img {
  const out = cloneImg(src);
  const d = out.data;
  for (let i = 0, p = 0; p < d.length; i++, p += 4) {
    const c = fn(d[p], d[p + 1], d[p + 2], i);
    d[p] = c[0];
    d[p + 1] = c[1];
    d[p + 2] = c[2];
  }
  return out;
}

export function grayOf(src: Img): Float32Array {
  const g = new Float32Array(src.w * src.h);
  const d = src.data;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = luma(d[p], d[p + 1], d[p + 2]);
  return g;
}

export function fromGray(g: Float32Array, w: number, h: number, alphaFrom?: Img): Img {
  const out = makeImg(w, h);
  const d = out.data;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    d[p] = d[p + 1] = d[p + 2] = g[i];
    d[p + 3] = alphaFrom ? alphaFrom.data[p + 3] : 255;
  }
  return out;
}

/** Split into premultiplied float planes (r, g, b, a). */
export function planes(src: Img): Float32Array[] {
  const n = src.w * src.h;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  const d = src.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const al = d[p + 3] / 255;
    r[i] = d[p] * al;
    g[i] = d[p + 1] * al;
    b[i] = d[p + 2] * al;
    a[i] = d[p + 3];
  }
  return [r, g, b, a];
}

export function joinPlanes(pl: Float32Array[], w: number, h: number): Img {
  const out = makeImg(w, h);
  const d = out.data;
  const [r, g, b, a] = pl;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const al = a[i];
    if (al <= 0.5) {
      d[p + 3] = 0;
      continue;
    }
    const k = 255 / al;
    d[p] = r[i] * k;
    d[p + 1] = g[i] * k;
    d[p + 2] = b[i] * k;
    d[p + 3] = al;
  }
  return out;
}

// ------------------------------------------------------------------ blurs

/** One box-blur pass (radius r) along rows then columns. Edges clamp. */
export function boxBlur1(src: Float32Array, w: number, h: number, r: number): Float32Array {
  r = Math.max(0, Math.round(r));
  if (r === 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = src[row] * (r + 1);
    for (let x = 1; x <= r; x++) acc += src[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = tmp[x] * (r + 1);
    for (let y = 1; y <= r; y++) acc += tmp[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      acc += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}

/** Gaussian blur (sigma in px) as three box passes. */
export function gauss1(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let a = src;
  for (let i = 0; i < n; i++) a = boxBlur1(a, w, h, ((i < m ? wl : wu) - 1) / 2);
  return a;
}

export function gaussianBlur(src: Img, sigma: number): Img {
  if (sigma < 0.3) return cloneImg(src);
  return joinPlanes(planes(src).map((p) => gauss1(p, src.w, src.h, sigma)), src.w, src.h);
}

export function boxBlur(src: Img, r: number): Img {
  return joinPlanes(planes(src).map((p) => boxBlur1(p, src.w, src.h, r)), src.w, src.h);
}

// ------------------------------------------------------------------ sampling

/** Bilinear sample into out[0..3]. edge: 0 clamp, 1 wrap, 2 transparent. */
export function sample(src: Img, x: number, y: number, out: Float32Array | number[], edge = 0): void {
  const { w, h, data } = src;
  if (edge === 2 && (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5)) {
    out[0] = out[1] = out[2] = out[3] = 0;
    return;
  }
  x -= 0.5;
  y -= 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (edge === 1) {
    x0 = ((x0 % w) + w) % w;
    x1 = ((x1 % w) + w) % w;
    y0 = ((y0 % h) + h) % h;
    y1 = ((y1 % h) + h) % h;
  } else {
    x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
    y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  }
  const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy) * data[p00 + 3], w10 = fx * (1 - fy) * data[p10 + 3], w01 = (1 - fx) * fy * data[p01 + 3], w11 = fx * fy * data[p11 + 3];
  const wa = w00 + w10 + w01 + w11;
  out[3] = wa;
  if (wa <= 0) {
    out[0] = out[1] = out[2] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) out[c] = (data[p00 + c] * w00 + data[p10 + c] * w10 + data[p01 + c] * w01 + data[p11 + c] * w11) / wa;
}

/** Inverse-map every output pixel to a source position. */
export function remap(src: Img, fn: (x: number, y: number, out: number[]) => boolean | void, edge = 0): Img {
  const out = makeImg(src.w, src.h);
  const d = out.data;
  const pos = [0, 0];
  const s = new Float32Array(4);
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const p = (y * src.w + x) * 4;
      pos[0] = x + 0.5;
      pos[1] = y + 0.5;
      if (fn(x + 0.5, y + 0.5, pos) === false) {
        d[p] = src.data[p];
        d[p + 1] = src.data[p + 1];
        d[p + 2] = src.data[p + 2];
        d[p + 3] = src.data[p + 3];
        continue;
      }
      sample(src, pos[0], pos[1], s, edge);
      d[p] = s[0];
      d[p + 1] = s[1];
      d[p + 2] = s[2];
      d[p + 3] = s[3];
    }
  return out;
}

/** Average of samples along a path; used by motion, radial and wind blurs. */
export function pathBlur(src: Img, path: (x: number, y: number, t: number, out: number[]) => void, samples: number, edge = 0): Img {
  const out = makeImg(src.w, src.h);
  const d = out.data;
  const pos = [0, 0];
  const s = new Float32Array(4);
  const n = Math.max(1, Math.round(samples));
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1) - 0.5;
        path(x + 0.5, y + 0.5, t, pos);
        sample(src, pos[0], pos[1], s, edge);
        r += s[0] * s[3];
        g += s[1] * s[3];
        b += s[2] * s[3];
        a += s[3];
      }
      const p = (y * src.w + x) * 4;
      if (a > 0) {
        d[p] = r / a;
        d[p + 1] = g / a;
        d[p + 2] = b / a;
      }
      d[p + 3] = a / n;
    }
  return out;
}

/** Nearest-neighbor resize (for previews and pixel effects). */
export function resizeNearest(src: Img, w: number, h: number): Img {
  const out = makeImg(w, h);
  const sd = src.data, d = out.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor(((y + 0.5) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor(((x + 0.5) * src.w) / w));
      const s = (sy * src.w + sx) * 4, p = (y * w + x) * 4;
      d[p] = sd[s];
      d[p + 1] = sd[s + 1];
      d[p + 2] = sd[s + 2];
      d[p + 3] = sd[s + 3];
    }
  }
  return out;
}

/** Area-averaging downscale (box filter), good for preview proxies. */
export function downscale(src: Img, maxSide: number): Img {
  const s = Math.min(1, maxSide / Math.max(src.w, src.h));
  if (s >= 1) return cloneImg(src);
  const w = Math.max(1, Math.round(src.w * s)), h = Math.max(1, Math.round(src.h * s));
  const out = makeImg(w, h);
  const acc = new Float64Array(w * h * 5);
  const sd = src.data;
  for (let y = 0; y < src.h; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / src.h));
    for (let x = 0; x < src.w; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / src.w));
      const p = (y * src.w + x) * 4, q = (ty * w + tx) * 5;
      const a = sd[p + 3];
      acc[q] += sd[p] * a;
      acc[q + 1] += sd[p + 1] * a;
      acc[q + 2] += sd[p + 2] * a;
      acc[q + 3] += a;
      acc[q + 4]++;
    }
  }
  const d = out.data;
  for (let i = 0; i < w * h; i++) {
    const q = i * 5, p = i * 4;
    if (acc[q + 3] > 0) {
      d[p] = acc[q] / acc[q + 3];
      d[p + 1] = acc[q + 1] / acc[q + 3];
      d[p + 2] = acc[q + 2] / acc[q + 3];
    }
    d[p + 3] = acc[q + 3] / Math.max(1, acc[q + 4]);
  }
  return out;
}

/** Bilinear resize. */
export function resizeBilinear(src: Img, w: number, h: number): Img {
  const out = makeImg(w, h);
  const s = new Float32Array(4);
  const kx = src.w / w, ky = src.h / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      sample(src, (x + 0.5) * kx, (y + 0.5) * ky, s);
      const p = (y * w + x) * 4;
      out.data[p] = s[0];
      out.data[p + 1] = s[1];
      out.data[p + 2] = s[2];
      out.data[p + 3] = s[3];
    }
  return out;
}

/** Run a smooth (low-frequency) effect at reduced size and scale it back up. */
export function atScale(src: Img, factor: number, fn: (small: Img, k: number) => Img): Img {
  if (factor >= 1 || src.w * src.h < 40000) return fn(src, 1);
  const small = downscale(src, Math.max(16, Math.round(Math.max(src.w, src.h) * factor)));
  const k = small.w / src.w;
  return resizeBilinear(fn(small, k), src.w, src.h);
}

// ------------------------------------------------------------------ convolution & edges

export function convolve(src: Img, k: number[], size: number, divisor = 0, offset = 0, keepAlpha = true): Img {
  const out = makeImg(src.w, src.h);
  const { w, h, data } = src;
  const d = out.data;
  const half = (size - 1) >> 1;
  const div = divisor || k.reduce((a, b) => a + b, 0) || 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < size; j++) {
        const yy = Math.min(h - 1, Math.max(0, y + j - half));
        for (let i = 0; i < size; i++) {
          const kv = k[j * size + i];
          if (!kv) continue;
          const xx = Math.min(w - 1, Math.max(0, x + i - half));
          const p = (yy * w + xx) * 4;
          r += data[p] * kv;
          g += data[p + 1] * kv;
          b += data[p + 2] * kv;
        }
      }
      const p = (y * w + x) * 4;
      d[p] = r / div + offset;
      d[p + 1] = g / div + offset;
      d[p + 2] = b / div + offset;
      d[p + 3] = keepAlpha ? data[p + 3] : 255;
    }
  return out;
}

/** Sobel gradients of a gray plane. */
export function sobel(g: Float32Array, w: number, h: number): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
      const a = g[ym + xm], b = g[ym + x], c = g[ym + xp], d = g[y0 + xm], f = g[y0 + xp], gg = g[yp + xm], hh = g[yp + x], ii = g[yp + xp];
      const sx = c + 2 * f + ii - a - 2 * d - gg;
      const sy = gg + 2 * hh + ii - a - 2 * b - c;
      gx[y0 + x] = sx;
      gy[y0 + x] = sy;
      mag[y0 + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

/**
 * Extended difference of Gaussians: clean, stylized ink lines. Returns
 * 0..1 where 1 is ink.
 */
export function xdog(g: Float32Array, w: number, h: number, sigma: number, k = 1.6, p = 20, eps = 0.1, phi = 10): Float32Array {
  const a = gauss1(g, w, h, sigma), b = gauss1(g, w, h, sigma * k);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const v = ((1 + p) * a[i] - p * b[i]) / 255;
    const e = v >= eps ? 1 : 1 + Math.tanh(phi * (v - eps));
    out[i] = 1 - clamp(e, 0, 1);
  }
  return out;
}

// ------------------------------------------------------------------ edge-preserving smoothing

/** Guided filter (He et al.), guide = gray, applied to each color plane. O(n). */
export function guidedSmooth(src: Img, r: number, eps: number): Img {
  const { w, h } = src;
  const I = grayOf(src);
  const n = w * h;
  const mI = boxBlur1(I, w, h, r);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const vI = boxBlur1(II, w, h, r);
  for (let i = 0; i < n; i++) vI[i] -= mI[i] * mI[i];
  const out = cloneImg(src);
  const d = out.data;
  const e2 = eps * eps;
  for (let c = 0; c < 3; c++) {
    const P = new Float32Array(n);
    for (let i = 0; i < n; i++) P[i] = src.data[i * 4 + c];
    const mP = boxBlur1(P, w, h, r);
    const IP = new Float32Array(n);
    for (let i = 0; i < n; i++) IP[i] = I[i] * P[i];
    const mIP = boxBlur1(IP, w, h, r);
    const A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const cov = mIP[i] - mI[i] * mP[i];
      A[i] = cov / (vI[i] + e2);
      B[i] = mP[i] - A[i] * mI[i];
    }
    const mA = boxBlur1(A, w, h, r), mB = boxBlur1(B, w, h, r);
    for (let i = 0; i < n; i++) d[i * 4 + c] = mA[i] * I[i] + mB[i];
  }
  return out;
}

/** Kuwahara filter via summed-area tables: painterly, edge-keeping. O(n). */
export function kuwahara(src: Img, r: number): Img {
  const { w, h, data } = src;
  r = Math.max(1, Math.round(r));
  const W = w + 1;
  const sat = (fn: (p: number) => number) => {
    const s = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += fn((y * w + x) * 4);
        s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
      }
    }
    return s;
  };
  const S = [0, 1, 2].map((c) => sat((p) => data[p + c]));
  const L = sat((p) => luma(data[p], data[p + 1], data[p + 2]));
  const L2 = sat((p) => {
    const v = luma(data[p], data[p + 1], data[p + 2]);
    return v * v;
  });
  const box = (s: Float64Array, x0: number, y0: number, x1: number, y1: number) => s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
  const out = cloneImg(src);
  const d = out.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = Infinity, bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
      for (let q = 0; q < 4; q++) {
        const x0 = Math.max(0, q & 1 ? x : x - r), x1 = Math.min(w, (q & 1 ? x + r : x) + 1);
        const y0 = Math.max(0, q & 2 ? y : y - r), y1 = Math.min(h, (q & 2 ? y + r : y) + 1);
        const n = (x1 - x0) * (y1 - y0);
        const m = box(L, x0, y0, x1, y1) / n;
        const v = box(L2, x0, y0, x1, y1) / n - m * m;
        if (v < best) {
          best = v;
          bx0 = x0;
          by0 = y0;
          bx1 = x1;
          by1 = y1;
        }
      }
      const n = (bx1 - bx0) * (by1 - by0);
      const p = (y * w + x) * 4;
      d[p] = box(S[0], bx0, by0, bx1, by1) / n;
      d[p + 1] = box(S[1], bx0, by0, bx1, by1) / n;
      d[p + 2] = box(S[2], bx0, by0, bx1, by1) / n;
    }
  return out;
}

/** Per-channel median (Huang's sliding histogram). */
export function median(src: Img, r: number): Img {
  r = Math.max(1, Math.round(r));
  const { w, h, data } = src;
  const out = cloneImg(src);
  const d = out.data;
  const hist = new Int32Array(256);
  const half = ((2 * r + 1) * (2 * r + 1)) >> 1;
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      let count = 0;
      for (let j = -r; j <= r; j++) {
        const yy = Math.min(h - 1, Math.max(0, y + j));
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, i));
          hist[data[(yy * w + xx) * 4 + c]]++;
          count++;
        }
      }
      const target = Math.min(half, count - 1);
      let med = 0, below = 0;
      while (below + hist[med] <= target) below += hist[med++];
      for (let x = 0; x < w; x++) {
        d[(y * w + x) * 4 + c] = med;
        if (x === w - 1) break;
        const xo = Math.max(0, x - r), xi = Math.min(w - 1, x + r + 1);
        for (let j = -r; j <= r; j++) {
          const yy = Math.min(h - 1, Math.max(0, y + j)) * w;
          const vo = data[(yy + xo) * 4 + c], vi = data[(yy + xi) * 4 + c];
          hist[vo]--;
          if (vo < med) below--;
          hist[vi]++;
          if (vi < med) below++;
        }
        while (below > target) below -= hist[--med];
        while (below + hist[med] <= target) below += hist[med++];
      }
    }
  return out;
}

/** Grayscale min / max (erode / dilate) per channel, square window. */
export function minMax(src: Img, r: number, max: boolean): Img {
  const { w, h } = src;
  const out = cloneImg(src);
  r = Math.max(1, Math.round(r));
  const tmp = new Uint8ClampedArray(src.data);
  const pick = max ? Math.max : Math.min;
  // Rows then columns (separable for a square window).
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let v = src.data[(y * w + x) * 4 + c];
        for (let i = -r; i <= r; i++) v = pick(v, src.data[(y * w + Math.min(w - 1, Math.max(0, x + i))) * 4 + c]);
        tmp[(y * w + x) * 4 + c] = v;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let v = tmp[(y * w + x) * 4 + c];
        for (let j = -r; j <= r; j++) v = pick(v, tmp[(Math.min(h - 1, Math.max(0, y + j)) * w + x) * 4 + c]);
        out.data[(y * w + x) * 4 + c] = v;
      }
  return out;
}

// ------------------------------------------------------------------ noise

export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal value noise in 0..1. */
export function fbm(x: number, y: number, octaves: number, seed = 0, rough = 0.5): number {
  let sum = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o * 31) * amp;
    norm += amp;
    amp *= rough;
    f *= 2;
  }
  return sum / norm;
}

/** Gaussian random (Box-Muller) from a uniform source. */
export function gaussRand(r: () => number): number {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ------------------------------------------------------------------ cells

export interface Cells {
  /** Nearest seed index per pixel. */
  id: Int32Array;
  /** Distance to the nearest and second-nearest seed. */
  d1: Float32Array;
  d2: Float32Array;
  sx: Float32Array;
  sy: Float32Array;
  count: number;
}

/** Jittered-grid Voronoi cells of roughly `size` px. */
export function voronoi(w: number, h: number, size: number, seed: number, jitter = 1): Cells {
  size = Math.max(2, size);
  const gw = Math.ceil(w / size) + 1, gh = Math.ceil(h / size) + 1;
  const sx = new Float32Array(gw * gh), sy = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      sx[k] = (i + 0.5 + (hash2(i, j, seed) - 0.5) * jitter) * size;
      sy[k] = (j + 0.5 + (hash2(i, j, seed + 7) - 0.5) * jitter) * size;
    }
  const id = new Int32Array(w * h), d1 = new Float32Array(w * h), d2 = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const cj = Math.floor(y / size);
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(x / size);
      let b1 = Infinity, b2 = Infinity, bi = 0;
      for (let j = Math.max(0, cj - 1); j <= Math.min(gh - 1, cj + 1); j++)
        for (let i = Math.max(0, ci - 1); i <= Math.min(gw - 1, ci + 1); i++) {
          const k = j * gw + i;
          const dx = x + 0.5 - sx[k], dy = y + 0.5 - sy[k];
          const dd = dx * dx + dy * dy;
          if (dd < b1) {
            b2 = b1;
            b1 = dd;
            bi = k;
          } else if (dd < b2) b2 = dd;
        }
      const p = y * w + x;
      id[p] = bi;
      d1[p] = Math.sqrt(b1);
      d2[p] = Math.sqrt(b2);
    }
  }
  return { id, d1, d2, sx, sy, count: gw * gh };
}

/** Average color of each cell. */
export function cellColors(src: Img, cells: Cells): Float32Array {
  const acc = new Float64Array(cells.count * 5);
  const d = src.data;
  for (let i = 0, p = 0; i < cells.id.length; i++, p += 4) {
    const k = cells.id[i] * 5;
    const a = d[p + 3];
    acc[k] += d[p] * a;
    acc[k + 1] += d[p + 1] * a;
    acc[k + 2] += d[p + 2] * a;
    acc[k + 3] += a;
    acc[k + 4]++;
  }
  const out = new Float32Array(cells.count * 4);
  for (let k = 0; k < cells.count; k++) {
    const a = acc[k * 5 + 3];
    if (a > 0) for (let c = 0; c < 3; c++) out[k * 4 + c] = acc[k * 5 + c] / a;
    out[k * 4 + 3] = acc[k * 5 + 4] ? a / acc[k * 5 + 4] : 0;
  }
  return out;
}

// ------------------------------------------------------------------ color

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Map a 0..255 value through a list of color stops (gradient map). */
export function gradientLUT(stops: [number, RGB][]): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const s = [...stops].sort((a, b) => a[0] - b[0]);
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    let i = 0;
    while (i < s.length - 2 && t > s[i + 1][0]) i++;
    const [t0, c0] = s[i], [t1, c1] = s[Math.min(i + 1, s.length - 1)];
    const k = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = lerp(c0[c], c1[c], k);
  }
  return lut;
}

export function applyLUT3(src: Img, lut: Uint8ClampedArray, amount = 1): Img {
  return mapRGB(src, (r, g, b) => {
    const v = Math.round(luma(r, g, b));
    return [lerp(r, lut[v * 3], amount), lerp(g, lut[v * 3 + 1], amount), lerp(b, lut[v * 3 + 2], amount)];
  });
}

/** Tone curve through (x,y) points in 0..255 (monotone cubic). */
export function curveLUT(pts: [number, number][]): Uint8ClampedArray {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const lut = new Uint8ClampedArray(256);
  if (n < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const dx: number[] = [], m: number[] = [], t: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    dx.push(p[i + 1][0] - p[i][0] || 1e-6);
    m.push((p[i + 1][1] - p[i][1]) / dx[i]);
  }
  t[0] = m[0];
  t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= p[0][0]) lut[x] = p[0][1];
    else if (x >= p[n - 1][0]) lut[x] = p[n - 1][1];
    else {
      let i = 0;
      while (x > p[i + 1][0]) i++;
      const h = dx[i], u = (x - p[i][0]) / h;
      const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
      lut[x] = h00 * p[i][1] + h10 * h * t[i] + h01 * p[i + 1][1] + h11 * h * t[i + 1];
    }
  }
  return lut;
}

/** Composite b over a with a blend function and opacity (both straight RGBA, same size). */
export function blendImgs(a: Img, b: Img, fn: (x: number, y: number) => number, opacity = 1): Img {
  const out = cloneImg(a);
  const d = out.data, bd = b.data;
  for (let p = 0; p < d.length; p += 4) {
    const k = (bd[p + 3] / 255) * opacity;
    if (k <= 0) continue;
    for (let c = 0; c < 3; c++) d[p + c] = lerp(d[p + c], fn(d[p + c], bd[p + c]), k);
  }
  return out;
}

export const B = {
  multiply: (a: number, b: number) => (a * b) / 255,
  screen: (a: number, b: number) => 255 - ((255 - a) * (255 - b)) / 255,
  overlay: (a: number, b: number) => (a < 128 ? (2 * a * b) / 255 : 255 - (2 * (255 - a) * (255 - b)) / 255),
  softLight: (a: number, b: number) => {
    const x = a / 255, y = b / 255;
    return 255 * (y < 0.5 ? x - (1 - 2 * y) * x * (1 - x) : x + (2 * y - 1) * ((x <= 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x)) - x));
  },
  add: (a: number, b: number) => Math.min(255, a + b),
  darken: (a: number, b: number) => Math.min(a, b),
  lighten: (a: number, b: number) => Math.max(a, b),
  colorDodge: (a: number, b: number) => (b >= 255 ? 255 : Math.min(255, (a * 255) / (255 - b))),
  normal: (_a: number, b: number) => b,
};

/** Nearest color in a palette (squared RGB distance, weighted). */
export function nearest(pal: RGB[], r: number, g: number, b: number): RGB {
  let best = pal[0], bd = Infinity;
  for (const c of pal) {
    const dr = r - c[0], dg = g - c[1], db = b - c[2];
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Median-cut palette of n colors from a (sub-sampled) image. */
export function medianCut(src: Img, n: number): RGB[] {
  const pts: RGB[] = [];
  const step = Math.max(1, Math.floor((src.w * src.h) / 40000));
  for (let i = 0; i < src.w * src.h; i += step) {
    const p = i * 4;
    if (src.data[p + 3] > 8) pts.push([src.data[p], src.data[p + 1], src.data[p + 2]]);
  }
  if (!pts.length) return [[0, 0, 0]];
  let boxes: RGB[][] = [pts];
  while (boxes.length < n) {
    let bi = -1, range = -1, ch = 0;
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of bx) {
          if (p[c] < lo) lo = p[c];
          if (p[c] > hi) hi = p[c];
        }
        if (hi - lo > range) {
          range = hi - lo;
          bi = i;
          ch = c;
        }
      }
    });
    if (bi < 0) break;
    const bx = boxes[bi].sort((a, b) => a[ch] - b[ch]);
    const mid = bx.length >> 1;
    boxes.splice(bi, 1, bx.slice(0, mid), bx.slice(mid));
  }
  return boxes.map((bx) => {
    const s = [0, 0, 0];
    for (const p of bx) for (let c = 0; c < 3; c++) s[c] += p[c];
    return s.map((v) => v / bx.length) as RGB;
  });
}

/** 8x8 Bayer matrix, values 0..63. */
export const BAYER8 = (() => {
  const m = [[0]];
  let s = 1;
  while (s < 8) {
    const n: number[][] = [];
    for (let y = 0; y < s * 2; y++) {
      n.push([]);
      for (let x = 0; x < s * 2; x++) {
        const v = m[y % s][x % s] * 4;
        n[y].push(v + [0, 2, 3, 1][(y < s ? 0 : 2) + (x < s ? 0 : 1)]);
      }
    }
    m.splice(0, m.length, ...n);
    s *= 2;
  }
  return m;
})();

export function histogram(src: Img): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = src.data;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] < 8) continue;
    r[d[p]]++;
    g[d[p + 1]]++;
    b[d[p + 2]]++;
    l[Math.round(luma(d[p], d[p + 1], d[p + 2]))]++;
  }
  return { r, g, b, l };
}

export function percentile(h: Uint32Array, q: number): number {
  let total = 0;
  for (const v of h) total += v;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    if (acc >= total * q) return i;
  }
  return 255;
}
