/**
 * Non-destructive mask Density and Feather (the Masks palette).
 *
 * The painted mask stays as it is; compositing uses an "effective" mask:
 * the painted one blurred by Feather and lifted toward white by Density
 * (100% = as painted, 0% = no effect). The result is cached per painted
 * mask and updated only around tiles that changed, so painting on a
 * feathered mask stays responsive.
 */

import { gauss1 } from "../filters/img";
import { Mask } from "./mask";
import { TILE } from "./tiles";

interface Cache {
  density: number;
  feather: number;
  /** Version of each painted tile when last processed (-1 = default, null tile). */
  versions: Int32Array;
  out: Mask;
}

const caches = new WeakMap<Mask, Cache>();

/** Feather radius in px -> Gaussian sigma. */
const sigmaOf = (feather: number) => feather / 2;

function tileVersion(m: Mask, i: number): number {
  const t = m.tiles[i];
  return t ? t.version : -1 - m.defaultValue;
}

/** Recompute the effective mask in a region (painted-mask coordinates). */
function computeRegion(src: Mask, out: Mask, density: number, feather: number, x0: number, y0: number, x1: number, y1: number): void {
  const pad = Math.ceil(sigmaOf(feather) * 3) + 1;
  const rx = Math.max(0, x0 - pad), ry = Math.max(0, y0 - pad);
  const rw = Math.min(src.width, x1 + pad) - rx, rh = Math.min(src.height, y1 + pad) - ry;
  // Read with a margin; past the mask's edges the edge values continue, so
  // feathering doesn't fade the borders of the canvas.
  const ex = rx - pad, ey = ry - pad, ew = rw + pad * 2, eh = rh + pad * 2;
  const raw = src.readRegion({ x: rx, y: ry, w: rw, h: rh }, src.defaultValue);
  let f = new Float32Array(ew * eh);
  for (let y = 0; y < eh; y++) {
    const sy = Math.min(rh - 1, Math.max(0, y - pad)) * rw;
    for (let x = 0; x < ew; x++) f[y * ew + x] = raw[sy + Math.min(rw - 1, Math.max(0, x - pad))];
  }
  if (feather > 0) f = gauss1(f, ew, eh, sigmaOf(feather)) as Float32Array<ArrayBuffer>;
  const w = x1 - x0, h = y1 - y0;
  const res = new Uint8Array(w * h);
  const k = 1 - density;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f[(y + y0 - ey) * ew + (x + x0 - ex)];
      res[y * w + x] = Math.round(v + (255 - v) * k);
    }
  out.writeRegion({ x: x0, y: y0, w, h }, res);
}

/**
 * The mask compositing should use. Returns `m` itself when Density is 100%
 * and Feather is 0.
 */
export function effectiveMask(m: Mask, density: number, feather: number): Mask {
  if (density >= 1 && feather <= 0) return m;
  let c = caches.get(m);
  const n = m.tiles.length;
  if (!c || c.density !== density || c.feather !== feather) {
    // The default outside value after density (may be a gray).
    const def = Math.round(m.defaultValue + (255 - m.defaultValue) * (1 - density));
    const out = new Mask(m.width, m.height, def as 0 | 255);
    computeRegion(m, out, density, feather, 0, 0, m.width, m.height);
    const versions = new Int32Array(n);
    for (let i = 0; i < n; i++) versions[i] = tileVersion(m, i);
    c = { density, feather, versions, out };
    caches.set(m, c);
    return out;
  }
  // Only redo tiles near painted tiles that changed.
  const reach = Math.ceil((sigmaOf(feather) * 3 + 1) / TILE);
  let tx0 = Infinity, ty0 = Infinity, tx1 = -1, ty1 = -1;
  for (let i = 0; i < n; i++) {
    const v = tileVersion(m, i);
    if (c.versions[i] === v) continue;
    c.versions[i] = v;
    const tx = i % m.cols, ty = (i / m.cols) | 0;
    tx0 = Math.min(tx0, tx - reach);
    ty0 = Math.min(ty0, ty - reach);
    tx1 = Math.max(tx1, tx + reach);
    ty1 = Math.max(ty1, ty + reach);
  }
  if (tx1 >= 0) {
    const x0 = Math.max(0, tx0) * TILE, y0 = Math.max(0, ty0) * TILE;
    const x1 = Math.min(m.width, (Math.min(m.cols - 1, tx1) + 1) * TILE), y1 = Math.min(m.height, (Math.min(m.rows - 1, ty1) + 1) * TILE);
    computeRegion(m, c.out, density, feather, x0, y0, x1, y1);
  }
  return c.out;
}

/**
 * A mask shifted by dx, dy (optionally resized to w x h, e.g. for a host of
 * another size); uncovered areas take the default value.
 */
export function shiftMask(m: Mask, dx: number, dy: number, w = m.width, h = m.height): Mask {
  const out = new Mask(w, h, m.defaultValue);
  if (!dx && !dy && w === m.width && h === m.height) {
    out.tiles = m.share().tiles;
    return out;
  }
  out.writeRegion({ x: 0, y: 0, w, h }, m.readRegion({ x: -dx, y: -dy, w, h }, m.defaultValue));
  return out;
}

/**
 * Mask Edge (destructive refine): smooth, feather, contrast and shift the
 * edge of a mask. Returns a new mask.
 */
export function refineMask(m: Mask, o: { smooth: number; feather: number; contrast: number; shift: number }): Mask {
  const W = m.width, H = m.height;
  const raw = m.readRegion({ x: 0, y: 0, w: W, h: H }, m.defaultValue);
  let f: Float32Array = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) f[i] = raw[i];
  // Smooth: blur then re-threshold softly, which rounds jagged corners.
  if (o.smooth > 0) {
    const b = gauss1(f, W, H, o.smooth * 0.7);
    for (let i = 0; i < f.length; i++) {
      const t = (b[i] - 127.5) / 127.5;
      f[i] = 127.5 + 127.5 * Math.tanh(t * 2.2) / Math.tanh(2.2);
    }
  }
  if (o.feather > 0) f = gauss1(f, W, H, o.feather / 2);
  // Shift edge: move the 50% point in or out (percent of a soft edge's width).
  if (o.shift) for (let i = 0; i < f.length; i++) f[i] = f[i] + (o.shift / 100) * 127.5;
  // Contrast: steepen the edge (100 = hard edge).
  if (o.contrast > 0) {
    const k = 1 + (o.contrast / 100) * 30;
    for (let i = 0; i < f.length; i++) f[i] = 127.5 + (f[i] - 127.5) * k;
  }
  const out = new Mask(W, H, m.defaultValue);
  const res = new Uint8Array(raw.length);
  for (let i = 0; i < res.length; i++) res[i] = Math.max(0, Math.min(255, Math.round(f[i])));
  out.writeRegion({ x: 0, y: 0, w: W, h: H }, res);
  return out;
}
