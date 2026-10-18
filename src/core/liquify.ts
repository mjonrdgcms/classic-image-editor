/**
 * Liquify: a displacement field ("mesh") and the brush operations that
 * shape it, after PS7's Liquify. The field is a backward map at a working
 * resolution: output pixel p shows the source at p + D(p). Distances are in
 * field pixels; `scale` converts field pixels to image pixels.
 */

export type LiquifyTool = "warp" | "reconstruct" | "smooth" | "twirlCW" | "twirlCCW" | "pucker" | "bloat" | "push" | "mirror" | "turbulence" | "freeze" | "thaw";
export type ReconstructMode = "revert" | "rigid" | "stiff" | "smooth" | "loose";

export interface Brush {
  /** Radius in field pixels. */
  radius: number;
  /** 0..1: how hard the edge is (PS "Brush Density"). */
  density: number;
  /** 0..1 strength of a drag (PS "Brush Pressure"). */
  pressure: number;
  /** 0..1 speed of stationary tools (PS "Brush Rate"). */
  rate: number;
  /** 0..1 turbulent jitter. */
  jitter: number;
  mode: ReconstructMode;
}

export class LiquifyField {
  readonly n: number;
  /** Displacement in field pixels. */
  dx: Float32Array;
  dy: Float32Array;
  /** Freeze mask 0..1. */
  freeze: Float32Array;
  /** Bounding box touched since the last call to takeDirty(). */
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.n = w * h;
    this.dx = new Float32Array(this.n);
    this.dy = new Float32Array(this.n);
    this.freeze = new Float32Array(this.n);
  }

  markDirty(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.dirty;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.w, Math.ceil(x1));
    y1 = Math.min(this.h, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;
    this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 };
  }

  takeDirty(): { x0: number; y0: number; x1: number; y1: number } | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  isIdentity(): boolean {
    for (let i = 0; i < this.n; i++) if (this.dx[i] !== 0 || this.dy[i] !== 0) return false;
    return true;
  }

  /** Bilinear sample of the mapping p -> p + D(p) at a field position (clamped). */
  mapAt(x: number, y: number, out: number[]): void {
    const w = this.w, h = this.h;
    const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x, cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
    const x0 = cx | 0, y0 = cy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const fx = cx - x0, fy = cy - y0;
    const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
    const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
    out[0] = x + this.dx[i00] * a + this.dx[i10] * b + this.dx[i01] * c + this.dx[i11] * d;
    out[1] = y + this.dy[i00] * a + this.dy[i10] * b + this.dy[i01] * c + this.dy[i11] * d;
  }

  snapshot(): { dx: Float32Array; dy: Float32Array; freeze: Float32Array } {
    return { dx: this.dx.slice(), dy: this.dy.slice(), freeze: this.freeze.slice() };
  }

  restore(s: { dx: Float32Array; dy: Float32Array; freeze: Float32Array }): void {
    this.dx.set(s.dx);
    this.dy.set(s.dy);
    this.freeze.set(s.freeze);
    this.markDirty(0, 0, this.w, this.h);
  }
}

/** Brush falloff: 1 at the center, 0 at the radius; density sharpens the edge. */
export function falloff(t: number, density: number): number {
  if (t >= 1) return 0;
  const soft = (1 - t * t) * (1 - t * t);
  const hardEdge = 0.55 + density * 0.4;
  const hard = t < hardEdge ? 1 : 1 - (t - hardEdge) / (1 - hardEdge);
  return soft + (hard - soft) * density;
}

/** Smooth 2D noise vector field for Turbulence. */
function turbNoise(x: number, y: number, seed: number): [number, number] {
  const f = (a: number, b: number, s: number) => {
    const xi = Math.floor(a), yi = Math.floor(b);
    const u = a - xi, v = b - yi;
    const h = (i: number, j: number) => {
      let q = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041)) | 0;
      q = Math.imul(q ^ (q >>> 13), 1274126177);
      return (((q ^ (q >>> 16)) >>> 0) / 4294967296) * 2 - 1;
    };
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
    const a0 = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * su;
    const a1 = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * su;
    return a0 + (a1 - a0) * sv;
  };
  return [f(x, y, seed) + 0.5 * f(x * 2, y * 2, seed + 7), f(x, y, seed + 3) + 0.5 * f(x * 2, y * 2, seed + 11)];
}

const tmpOut = [0, 0];

/**
 * Apply one dab of a tool at (cx, cy) in field pixels. `dir` is the drag
 * delta since the last dab (field px) for directional tools; `alt` reverses
 * tools that have a reverse (Push, Mirror, Twirl).
 */
export function applyDab(f: LiquifyField, tool: LiquifyTool, cx: number, cy: number, dir: [number, number], b: Brush, alt = false, seed = 1): void {
  const R = Math.max(1, b.radius);
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(f.w - 1, Math.ceil(cx + R)), y1 = Math.min(f.h - 1, Math.ceil(cy + R));
  if (x1 < x0 || y1 < y0) return;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

  if (tool === "freeze" || tool === "thaw") {
    const target = tool === "freeze" ? 1 : 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const t = Math.hypot(x - cx, y - cy) / R;
        const wgt = falloff(t, b.density) * (0.3 + b.pressure * 0.7);
        if (wgt <= 0) continue;
        const i = y * f.w + x;
        f.freeze[i] += (target - f.freeze[i]) * Math.min(1, wgt);
      }
    f.markDirty(x0, y0, x1 + 1, y1 + 1);
    return;
  }

  // Read the old mapping from a copy of the region (plus margin) so the dab sees a consistent field.
  const dlen = Math.hypot(dir[0], dir[1]);
  const pad = Math.ceil(R * 0.6 + dlen + 2);
  const sx0 = Math.max(0, x0 - pad), sy0 = Math.max(0, y0 - pad);
  const sx1 = Math.min(f.w - 1, x1 + pad), sy1 = Math.min(f.h - 1, y1 + pad);
  const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
  const odx = new Float32Array(sw * sh), ody = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    odx.set(f.dx.subarray((sy0 + y) * f.w + sx0, (sy0 + y) * f.w + sx0 + sw), y * sw);
    ody.set(f.dy.subarray((sy0 + y) * f.w + sx0, (sy0 + y) * f.w + sx0 + sw), y * sw);
  }
  // Bilinear sample of the old mapping (falls back to the live field outside the copy).
  const oldMap = (x: number, y: number, out: number[]) => {
    const lx = x - sx0, ly = y - sy0;
    if (lx < 0 || ly < 0 || lx > sw - 1 || ly > sh - 1) return f.mapAt(x, y, out);
    const xi = lx | 0, yi = ly | 0;
    const xj = xi + 1 < sw ? xi + 1 : xi, yj = yi + 1 < sh ? yi + 1 : yi;
    const fx = lx - xi, fy = ly - yi;
    const a = (1 - fx) * (1 - fy), bb = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
    const i00 = yi * sw + xi, i10 = yi * sw + xj, i01 = yj * sw + xi, i11 = yj * sw + xj;
    out[0] = x + odx[i00] * a + odx[i10] * bb + odx[i01] * c + odx[i11] * d;
    out[1] = y + ody[i00] * a + ody[i10] * bb + ody[i01] * c + ody[i11] * d;
  };

  const p = b.pressure, r = b.rate;
  // Directional tools need a drag.
  let ux = 0, uy = 0;
  if (dlen > 0) {
    ux = dir[0];
    uy = dir[1];
  }
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const t = Math.hypot(x - cx, y - cy) / R;
      let wgt = falloff(t, b.density);
      if (wgt <= 0) continue;
      const i = y * f.w + x;
      wgt *= 1 - f.freeze[i];
      if (wgt <= 0) continue;
      let qx = x, qy = y;
      switch (tool) {
        case "warp":
          // Forward warp: content moves with the drag.
          qx = x - wgt * p * ux;
          qy = y - wgt * p * uy;
          break;
        case "push": {
          // Shift pixels perpendicular to the stroke, to its left (Alt: right).
          // In y-down coordinates the left of direction (ux, uy) is (uy, -ux).
          const s = alt ? -1 : 1;
          qx = x - wgt * p * uy * s;
          qy = y + wgt * p * ux * s;
          break;
        }
        case "twirlCW":
        case "twirlCCW": {
          const sgn = (tool === "twirlCW" ? 1 : -1) * (alt ? -1 : 1);
          const ang = -sgn * wgt * r * 0.12;
          const c = Math.cos(ang), s = Math.sin(ang);
          const rx = x - cx, ry = y - cy;
          qx = cx + rx * c - ry * s;
          qy = cy + rx * s + ry * c;
          break;
        }
        case "pucker":
        case "bloat": {
          // Pucker samples farther out (content shrinks toward the center); Bloat samples closer (grows).
          const sgn = (tool === "pucker" ? 1 : -1) * (alt ? -1 : 1);
          const k = 1 + sgn * wgt * r * 0.06;
          qx = cx + (x - cx) * k;
          qy = cy + (y - cy) * k;
          break;
        }
        case "mirror": {
          // Reflect the content on one side of the stroke into the brush.
          if (dlen <= 0) continue;
          const nx = -uy / dlen, ny = ux / dlen;
          const side = (x - cx) * nx + (y - cy) * ny;
          if ((side > 0) !== alt) continue;
          const rx = x - 2 * side * nx, ry = y - 2 * side * ny;
          oldMap(rx, ry, tmpOut);
          const tx = tmpOut[0], ty = tmpOut[1];
          oldMap(x, y, tmpOut);
          const a = Math.min(1, wgt * p);
          f.dx[i] = tmpOut[0] + (tx - tmpOut[0]) * a - x;
          f.dy[i] = tmpOut[1] + (ty - tmpOut[1]) * a - y;
          continue;
        }
        case "turbulence": {
          const sc = 1 / Math.max(4, R * 0.35);
          const [nx, ny] = turbNoise(x * sc, y * sc, seed);
          const amp = wgt * r * (0.6 + b.jitter * 2.4);
          qx = x + nx * amp;
          qy = y + ny * amp;
          break;
        }
        case "reconstruct":
        case "smooth": {
          const a = Math.min(1, wgt * r * 0.25);
          if (tool === "reconstruct" && b.mode === "revert") {
            f.dx[i] = odx[(y - sy0) * sw + (x - sx0)] * (1 - a);
            f.dy[i] = ody[(y - sy0) * sw + (x - sx0)] * (1 - a);
          } else {
            // Relax toward the local average (smooths kinks; reconstruct also pulls toward zero).
            let sxs = 0, sys = 0, cnt = 0;
            for (let oy = -2; oy <= 2; oy++)
              for (let ox = -2; ox <= 2; ox++) {
                const lx = x + ox * 2 - sx0, ly = y + oy * 2 - sy0;
                if (lx < 0 || ly < 0 || lx >= sw || ly >= sh) continue;
                sxs += odx[ly * sw + lx];
                sys += ody[ly * sw + lx];
                cnt++;
              }
            const k = tool === "reconstruct" ? RECON_PULL[b.mode] : 1;
            const tx = (sxs / cnt) * k, ty = (sys / cnt) * k;
            const ix = odx[(y - sy0) * sw + (x - sx0)], iy = ody[(y - sy0) * sw + (x - sx0)];
            f.dx[i] = ix + (tx - ix) * a;
            f.dy[i] = iy + (ty - iy) * a;
          }
          continue;
        }
      }
      oldMap(qx, qy, tmpOut);
      f.dx[i] = tmpOut[0] - x;
      f.dy[i] = tmpOut[1] - y;
    }
  f.markDirty(x0, y0, x0 + bw, y0 + bh);
}

/** How strongly each reconstruct mode pulls distortion back toward none. */
const RECON_PULL: Record<ReconstructMode, number> = { revert: 0, rigid: 0.55, stiff: 0.75, smooth: 0.92, loose: 0.98 };

/**
 * Reconstruct the whole image (the Reconstruct button): `amount` 0..1 of
 * the way back, according to the mode; frozen areas stay.
 *
 * Revert removes the distortion. The other modes keep the unfrozen area
 * continuous with the frozen areas: they solve for the smoothest field that
 * matches the frozen pixels and is zero at the image border (a harmonic
 * fill, on a coarse grid so it is quick at any size), then mix in a
 * softened copy of the current distortion: none for Rigid, a little for
 * Stiff, more for Smooth, most for Loose.
 */
export function reconstructAll(f: LiquifyField, mode: ReconstructMode, amount: number): void {
  const { w, h, dx, dy, freeze } = f;
  let tx: Float32Array, ty: Float32Array;
  if (mode === "revert") {
    tx = new Float32Array(f.n);
    ty = new Float32Array(f.n);
  } else {
    const k = Math.min(1, 160 / Math.max(w, h));
    const cw = Math.max(2, Math.round(w * k)), ch = Math.max(2, Math.round(h * k));
    const down = (a: Float32Array, max: boolean) => {
      const o = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const y0 = Math.floor((y * h) / ch), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / ch));
        for (let x = 0; x < cw; x++) {
          const x0 = Math.floor((x * w) / cw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / cw));
          let v = 0, n = 0;
          for (let yy = y0; yy < y1; yy++)
            for (let xx = x0; xx < x1; xx++) {
              const s = a[yy * w + xx];
              if (max) v = Math.max(v, s);
              else v += s;
              n++;
            }
          o[y * cw + x] = max ? v : v / n;
        }
      }
      return o;
    };
    // Frozen cells hold the average displacement of their frozen pixels.
    const fz = down(freeze, true);
    const wdx = new Float32Array(f.n), wdy = new Float32Array(f.n);
    for (let i = 0; i < f.n; i++) {
      wdx[i] = dx[i] * freeze[i];
      wdy[i] = dy[i] * freeze[i];
    }
    const fsum = down(freeze, false), cdx = down(wdx, false), cdy = down(wdy, false);
    const ax = down(dx, false), ay = down(dy, false);
    const fixed = new Uint8Array(cw * ch);
    const hx = new Float32Array(cw * ch), hy = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++)
      if (fz[i] > 0.5 && fsum[i] > 0) {
        fixed[i] = 1;
        hx[i] = cdx[i] / fsum[i];
        hy[i] = cdy[i] / fsum[i];
      }
    // Gauss-Seidel with over-relaxation; the border is held at zero.
    const iters = Math.max(60, Math.round((cw + ch) * 2.5));
    for (let it = 0; it < iters; it++)
      for (let y = 1; y < ch - 1; y++)
        for (let x = 1; x < cw - 1; x++) {
          const i = y * cw + x;
          if (fixed[i]) continue;
          const nx = (hx[i - 1] + hx[i + 1] + hx[i - cw] + hx[i + cw]) * 0.25;
          const ny = (hy[i - 1] + hy[i + 1] + hy[i - cw] + hy[i + cw]) * 0.25;
          hx[i] += (nx - hx[i]) * 1.85;
          hy[i] += (ny - hy[i]) * 1.85;
        }
    // Softened current distortion for the looser modes.
    const keep = RECON_KEEP[mode];
    if (keep > 0) {
      const sx = boxSmooth(ax, cw, ch, 2), sy = boxSmooth(ay, cw, ch, 2);
      for (let i = 0; i < cw * ch; i++)
        if (!fixed[i]) {
          hx[i] += (sx[i] - hx[i]) * keep;
          hy[i] += (sy[i] - hy[i]) * keep;
        }
    }
    tx = upsample(hx, cw, ch, w, h);
    ty = upsample(hy, cw, ch, w, h);
  }
  for (let i = 0; i < f.n; i++) {
    const a = amount * (1 - freeze[i]);
    dx[i] += (tx[i] - dx[i]) * a;
    dy[i] += (ty[i] - dy[i]) * a;
  }
  f.markDirty(0, 0, w, h);
}

/** How much of the (softened) current distortion each mode keeps. */
const RECON_KEEP: Record<ReconstructMode, number> = { revert: 0, rigid: 0, stiff: 0.25, smooth: 0.5, loose: 0.75 };

function boxSmooth(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const o = new Float32Array(a.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          s += a[yy * w + xx];
          n++;
        }
      o[y * w + x] = s / n;
    }
  return o;
}

function upsample(a: Float32Array, cw: number, ch: number, w: number, h: number): Float32Array {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(ch - 1, ((y + 0.5) * ch) / h - 0.5));
    const y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(cw - 1, ((x + 0.5) * cw) / w - 0.5));
      const x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0;
      o[y * w + x] = (a[y0 * cw + x0] * (1 - tx) + a[y0 * cw + x1] * tx) * (1 - ty) + (a[y1 * cw + x0] * (1 - tx) + a[y1 * cw + x1] * tx) * ty;
    }
  }
  return o;
}

// ------------------------------------------------------------------ applying

/**
 * Warp RGBA pixels (w x h) by a field covering them, with bilinear
 * sampling of both the field and the source (edges clamp). `fieldScale` =
 * field px per image px.
 */
export function warpPixels(src: Uint8ClampedArray, w: number, h: number, dx: Float32Array, dy: Float32Array, fw: number, fh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const sxF = fw / w, syF = fh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(fh - 1, Math.max(0, (y + 0.5) * syF - 0.5));
    const fy0 = fy | 0, fy1 = fy0 + 1 < fh ? fy0 + 1 : fy0, ty = fy - fy0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(fw - 1, Math.max(0, (x + 0.5) * sxF - 0.5));
      const fx0 = fx | 0, fx1 = fx0 + 1 < fw ? fx0 + 1 : fx0, tx = fx - fx0;
      const a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
      const i00 = fy0 * fw + fx0, i10 = fy0 * fw + fx1, i01 = fy1 * fw + fx0, i11 = fy1 * fw + fx1;
      // Field displacements are in field px: convert to image px.
      let sx = x + (dx[i00] * a + dx[i10] * b + dx[i01] * c + dx[i11] * d) / sxF;
      let sy = y + (dy[i00] * a + dy[i10] * b + dy[i01] * c + dy[i11] * d) / syF;
      sx = sx < 0 ? 0 : sx > w - 1 ? w - 1 : sx;
      sy = sy < 0 ? 0 : sy > h - 1 ? h - 1 : sy;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
      const ux = sx - x0, uy = sy - y0;
      const o = (y * w + x) * 4;
      const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
      const w00 = (1 - ux) * (1 - uy), w10 = ux * (1 - uy), w01 = (1 - ux) * uy, w11 = ux * uy;
      // Premultiplied interpolation so transparent pixels don't bleed color.
      const a00 = src[p00 + 3] * w00, a10 = src[p10 + 3] * w10, a01 = src[p01 + 3] * w01, a11 = src[p11 + 3] * w11;
      const A = a00 + a10 + a01 + a11;
      out[o + 3] = A;
      if (A > 0) for (let ch = 0; ch < 3; ch++) out[o + ch] = (src[p00 + ch] * a00 + src[p10 + ch] * a10 + src[p01 + ch] * a01 + src[p11 + ch] * a11) / A;
    }
  }
  return out;
}

// ------------------------------------------------------------------ mesh encoding (for commands, Actions and files)

export interface EncodedMesh {
  /** Field size. */
  w: number;
  h: number;
  /** Non-zero 32x32 tiles: x, y (tile coords) and base64 Int16 dx,dy pairs in 1/16 field px. */
  tiles: { x: number; y: number; d: string }[];
}

const MT = 32;
const QUANT = 16;

function b64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function encodeMesh(dx: Float32Array, dy: Float32Array, w: number, h: number): EncodedMesh {
  const tiles: EncodedMesh["tiles"] = [];
  for (let ty = 0; ty * MT < h; ty++)
    for (let tx = 0; tx * MT < w; tx++) {
      const a = new Int16Array(MT * MT * 2);
      let any = false;
      for (let y = 0; y < MT; y++)
        for (let x = 0; x < MT; x++) {
          const gx = tx * MT + x, gy = ty * MT + y;
          if (gx >= w || gy >= h) continue;
          const i = gy * w + gx;
          const qx = Math.max(-32767, Math.min(32767, Math.round(dx[i] * QUANT)));
          const qy = Math.max(-32767, Math.min(32767, Math.round(dy[i] * QUANT)));
          if (qx || qy) any = true;
          a[(y * MT + x) * 2] = qx;
          a[(y * MT + x) * 2 + 1] = qy;
        }
      if (any) tiles.push({ x: tx, y: ty, d: b64(new Uint8Array(a.buffer)) });
    }
  return { w, h, tiles };
}

export function decodeMesh(m: EncodedMesh): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(m.w * m.h), dy = new Float32Array(m.w * m.h);
  for (const t of m.tiles) {
    const u8 = unb64(t.d);
    const a = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.length / 2));
    for (let y = 0; y < MT; y++)
      for (let x = 0; x < MT; x++) {
        const gx = t.x * MT + x, gy = t.y * MT + y;
        if (gx >= m.w || gy >= m.h) continue;
        const k = (y * MT + x) * 2;
        if (k + 1 >= a.length) continue;
        dx[gy * m.w + gx] = a[k] / QUANT;
        dy[gy * m.w + gx] = a[k + 1] / QUANT;
      }
  }
  return { dx, dy };
}
