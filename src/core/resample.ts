/**
 * Resampling for Image Size and transforms: separable filters that widen
 * when shrinking (so downsizing never aliases), on premultiplied color.
 */

export type ResampleMethod = "nearest" | "bilinear" | "bicubic" | "lanczos";
export const RESAMPLE_METHODS: ResampleMethod[] = ["nearest", "bilinear", "bicubic", "lanczos"];

const KERNELS: Record<Exclude<ResampleMethod, "nearest">, { r: number; f: (x: number) => number }> = {
  bilinear: { r: 1, f: (x) => Math.max(0, 1 - Math.abs(x)) },
  bicubic: {
    r: 2,
    f: (x) => {
      // Catmull-Rom (a = -0.5): sharp without much ringing.
      x = Math.abs(x);
      const a = -0.5;
      if (x < 1) return (a + 2) * x * x * x - (a + 3) * x * x + 1;
      if (x < 2) return a * x * x * x - 5 * a * x * x + 8 * a * x - 4 * a;
      return 0;
    },
  },
  lanczos: {
    r: 3,
    f: (x) => {
      if (x === 0) return 1;
      if (Math.abs(x) >= 3) return 0;
      const px = Math.PI * x;
      return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
    },
  },
};

/** Weights for resampling n samples to m: per output, the first input index and its weights. */
function weights(n: number, m: number, method: Exclude<ResampleMethod, "nearest">): { start: Int32Array; len: Int32Array; w: Float32Array; stride: number } {
  const k = KERNELS[method];
  const scale = m / n;
  const widen = Math.max(1, 1 / scale);
  const support = k.r * widen;
  const stride = Math.ceil(support * 2) + 2;
  const start = new Int32Array(m), len = new Int32Array(m), w = new Float32Array(m * stride);
  for (let o = 0; o < m; o++) {
    const c = (o + 0.5) / scale - 0.5;
    const a = Math.max(0, Math.ceil(c - support)), b = Math.min(n - 1, Math.floor(c + support));
    let sum = 0;
    const cnt = Math.min(stride, b - a + 1);
    for (let i = 0; i < cnt; i++) {
      const v = k.f((a + i - c) / widen);
      w[o * stride + i] = v;
      sum += v;
    }
    if (cnt <= 0 || Math.abs(sum) < 1e-8) {
      // Off the end: take the nearest sample.
      start[o] = Math.max(0, Math.min(n - 1, Math.round(c)));
      len[o] = 1;
      w[o * stride] = 1;
      continue;
    }
    for (let i = 0; i < cnt; i++) w[o * stride + i] /= sum;
    start[o] = a;
    len[o] = cnt;
  }
  return { start, len, w, stride };
}

/** Resample interleaved float channels (ch per pixel). */
function resampleFloat(src: Float32Array, w: number, h: number, nw: number, nh: number, ch: number, method: ResampleMethod): Float32Array {
  if (method === "nearest") {
    const out = new Float32Array(nw * nh * ch);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / nh));
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / nw));
        for (let c = 0; c < ch; c++) out[(y * nw + x) * ch + c] = src[(sy * w + sx) * ch + c];
      }
    }
    return out;
  }
  // Horizontal pass, then vertical.
  const wx = weights(w, nw, method);
  const tmp = new Float32Array(nw * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < nw; x++) {
      const s = wx.start[x], l = wx.len[x], base = x * wx.stride;
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let i = 0; i < l; i++) acc += src[(y * w + s + i) * ch + c] * wx.w[base + i];
        tmp[(y * nw + x) * ch + c] = acc;
      }
    }
  const wy = weights(h, nh, method);
  const out = new Float32Array(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const s = wy.start[y], l = wy.len[y], base = y * wy.stride;
    for (let x = 0; x < nw; x++)
      for (let c = 0; c < ch; c++) {
        let acc = 0;
        for (let i = 0; i < l; i++) acc += tmp[((s + i) * nw + x) * ch + c] * wy.w[base + i];
        out[(y * nw + x) * ch + c] = acc;
      }
  }
  return out;
}

/**
 * Resample straight RGBA (alpha-correct: color is premultiplied while
 * filtering). One channel at a time, to keep memory down on big images.
 */
export function resampleRGBA(src: Uint8ClampedArray, w: number, h: number, nw: number, nh: number, method: ResampleMethod = "bicubic"): Uint8ClampedArray {
  const n = w * h, nn = nw * nh;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = src[i * 4 + 3] / 255;
  const alpha = resampleFloat(f, w, h, nw, nh, 1, method);
  const out = new Uint8ClampedArray(nn * 4);
  for (let i = 0; i < nn; i++) out[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, alpha[i])) * 255);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) f[i] = (src[i * 4 + c] * src[i * 4 + 3]) / 255;
    const r = resampleFloat(f, w, h, nw, nh, 1, method);
    for (let i = 0; i < nn; i++) {
      const a = alpha[i];
      if (a > 0.5 / 255) out[i * 4 + c] = r[i] / Math.min(1, a);
    }
  }
  return out;
}

/** Resample one 8-bit channel (masks, selections). */
export function resampleGray(src: Uint8Array, w: number, h: number, nw: number, nh: number, method: ResampleMethod = "bicubic"): Uint8Array {
  const f = new Float32Array(w * h);
  for (let i = 0; i < f.length; i++) f[i] = src[i];
  const r = resampleFloat(f, w, h, nw, nh, 1, method);
  const out = new Uint8Array(nw * nh);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(r[i])));
  return out;
}
