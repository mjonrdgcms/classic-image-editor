/**
 * Building and editing selections: rasterizing shapes into masks, the magic
 * wand, Color Range, feather and Select > Modify.
 */

import type { Document, Layer, MaskHost } from "./document";
import { Mask } from "./mask";
import { Rect, rectIntersect } from "./tiles";

export type SelectMode = "replace" | "add" | "subtract" | "intersect";
export const SELECT_MODES = ["replace", "add", "subtract", "intersect"] as const;

const clampRect = (r: Rect, w: number, h: number) => rectIntersect(r, { x: 0, y: 0, w, h });

// ---------------------------------------------------------------- shapes

export function rectMask(w: number, h: number, r: Rect): Mask {
  const m = new Mask(w, h, 0);
  const c = clampRect({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, w, h);
  if (!c) return m;
  const data = new Uint8Array(c.w * c.h).fill(255);
  m.writeRegion(c, data);
  m.rectHint = c;
  return m;
}

/** Ellipse inscribed in r, 4x4 supersampled on the edge when anti-aliased. */
export function ellipseMask(w: number, h: number, r: Rect, antiAlias = true): Mask {
  const m = new Mask(w, h, 0);
  const area = clampRect({ x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.w) + 1, h: Math.ceil(r.h) + 1 }, w, h);
  if (!area || r.w < 1 || r.h < 1) return m;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, a = r.w / 2, b = r.h / 2;
  const data = new Uint8Array(area.w * area.h);
  const f = (x: number, y: number) => Math.sqrt(((x - cx) / a) ** 2 + ((y - cy) / b) ** 2);
  const inside = (x: number, y: number) => f(x, y) <= 1;
  // Within this band of the edge (in normalized units) a pixel may be partial.
  const band = 1.5 / Math.min(a, b);
  const S = 4;
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      const px = area.x + x, py = area.y + y;
      let v: number;
      if (!antiAlias) v = inside(px + 0.5, py + 0.5) ? 255 : 0;
      else {
        const fc = f(px + 0.5, py + 0.5);
        if (fc < 1 - band) v = 255;
        else if (fc > 1 + band) v = 0;
        else {
          let n = 0;
          for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) if (inside(px + (sx + 0.5) / S, py + (sy + 0.5) / S)) n++;
          v = Math.round((n * 255) / (S * S));
        }
      }
      data[y * area.w + x] = v;
    }
  m.writeRegion(area, data);
  return m;
}

/** Polygon (even-odd), anti-aliased by 4 subrows and exact horizontal coverage. */
export function polygonMask(w: number, h: number, pts: [number, number][], antiAlias = true): Mask {
  const m = new Mask(w, h, 0);
  if (pts.length < 3) return m;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const area = clampRect({ x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0) + 1, h: Math.ceil(y1) - Math.floor(y0) + 1 }, w, h);
  if (!area) return m;
  const cov = new Float32Array(area.w * area.h);
  const S = antiAlias ? 4 : 1;
  const xs: number[] = [];
  for (let y = 0; y < area.h; y++) {
    for (let s = 0; s < S; s++) {
      const sy = area.y + y + (s + 0.5) / S;
      xs.length = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let a = xs[k] - area.x, b = xs[k + 1] - area.x;
        if (!antiAlias) {
          // Pixel centers inside the span.
          a = Math.ceil(a - 0.5);
          b = Math.floor(b - 0.5) + 1;
          for (let x = Math.max(0, a); x < Math.min(area.w, b); x++) cov[y * area.w + x] = 1;
          continue;
        }
        a = Math.max(0, a);
        b = Math.min(area.w, b);
        if (b <= a) continue;
        const ia = Math.floor(a), ib = Math.floor(b);
        const row = y * area.w;
        if (ia === ib) cov[row + ia] += (b - a) / S;
        else {
          cov[row + ia] += (ia + 1 - a) / S;
          for (let x = ia + 1; x < ib; x++) cov[row + x] += 1 / S;
          if (ib < area.w) cov[row + ib] += (b - ib) / S;
        }
      }
    }
  }
  const data = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) data[i] = Math.round(Math.min(1, cov[i]) * 255);
  m.writeRegion(area, data);
  return m;
}

// ---------------------------------------------------------------- pixel-based

export function pixelsFor(doc: Document, layer: Layer | undefined, sampleMerged: boolean): Uint8ClampedArray {
  const full = { x: 0, y: 0, w: doc.width, h: doc.height };
  if (sampleMerged || !layer) return doc.composite(full);
  return layer.grid.readRegion({ x: -layer.offsetX, y: -layer.offsetY, w: doc.width, h: doc.height });
}

export interface WandOptions {
  tolerance: number;
  contiguous: boolean;
  antiAlias: boolean;
  sampleMerged: boolean;
}

/** Magic Wand at a canvas point. */
export function wandMask(doc: Document, x: number, y: number, o: WandOptions): Mask {
  const W = doc.width, H = doc.height;
  const m = new Mask(W, H, 0);
  const sx = Math.floor(x), sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return m;
  const px = pixelsFor(doc, doc.activeLayer, o.sampleMerged);
  const si = (sy * W + sx) * 4;
  const seed = [px[si], px[si + 1], px[si + 2], px[si + 3]];
  const tol = o.tolerance;
  const match = (i: number) => {
    const p = i * 4;
    if (seed[3] === 0 && px[p + 3] === 0) return true;
    return (
      Math.abs(px[p] - seed[0]) <= tol &&
      Math.abs(px[p + 1] - seed[1]) <= tol &&
      Math.abs(px[p + 2] - seed[2]) <= tol &&
      Math.abs(px[p + 3] - seed[3]) <= tol
    );
  };
  const sel = new Uint8Array(W * H);
  if (o.contiguous) {
    const stack: number[] = [sx, sy];
    while (stack.length) {
      const yy = stack.pop()!;
      let xx = stack.pop()!;
      while (xx >= 0 && !sel[yy * W + xx] && match(yy * W + xx)) xx--;
      xx++;
      let up = false, down = false;
      while (xx < W && !sel[yy * W + xx] && match(yy * W + xx)) {
        sel[yy * W + xx] = 255;
        if (yy > 0) {
          const ok = !sel[(yy - 1) * W + xx] && match((yy - 1) * W + xx);
          if (ok && !up) stack.push(xx, yy - 1);
          up = ok;
        }
        if (yy < H - 1) {
          const ok = !sel[(yy + 1) * W + xx] && match((yy + 1) * W + xx);
          if (ok && !down) stack.push(xx, yy + 1);
          down = ok;
        }
        xx++;
      }
    }
  } else {
    for (let i = 0; i < W * H; i++) if (match(i)) sel[i] = 255;
  }
  if (o.antiAlias) softenEdges(sel, W, H);
  m.writeRegion({ x: 0, y: 0, w: W, h: H }, sel);
  return m;
}

/**
 * Select > Grow and Select > Similar: pixels whose color is within
 * `tolerance` of a color already in the selection. Grow only adds pixels
 * connected to the selection; Similar adds them anywhere. The result
 * includes the current selection.
 */
export function growMask(doc: Document, tolerance: number, contiguous: boolean, sampleMerged = false): Mask | null {
  const cur = doc.selection;
  if (!cur) return null;
  const W = doc.width, H = doc.height;
  const px = pixelsFor(doc, doc.activeLayer, sampleMerged);
  const selv = cur.readRegion({ x: 0, y: 0, w: W, h: H });
  // The selected colors, on a 32x32x32 grid, widened by the tolerance.
  const B = 32, S = 8;
  let bins: Uint8Array = new Uint8Array(B * B * B);
  let clear = false;
  for (let i = 0; i < W * H; i++) {
    if (selv[i] < 128) continue;
    const p = i * 4;
    if (px[p + 3] < 128) clear = true;
    else bins[((px[p] >> 3) * B + (px[p + 1] >> 3)) * B + (px[p + 2] >> 3)] = 1;
  }
  const r = Math.round(tolerance / S);
  if (r > 0) {
    // Separable max over each axis.
    for (let axis = 0; axis < 3; axis++) {
      const out = new Uint8Array(bins.length);
      const stride = axis === 0 ? B * B : axis === 1 ? B : 1;
      for (let i = 0; i < bins.length; i++) {
        if (!bins[i]) continue;
        const c = Math.floor(i / stride) % B;
        for (let d = Math.max(0, c - r); d <= Math.min(B - 1, c + r); d++) out[i + (d - c) * stride] = 1;
      }
      bins = out;
    }
  }
  const match = (i: number) => {
    const p = i * 4;
    if (px[p + 3] < 128) return clear;
    return bins[((px[p] >> 3) * B + (px[p + 1] >> 3)) * B + (px[p + 2] >> 3)] === 1;
  };
  const sel = new Uint8Array(W * H);
  if (contiguous) {
    const queue = new Int32Array(W * H);
    let qh = 0, qt = 0;
    for (let i = 0; i < W * H; i++)
      if (selv[i] >= 128) {
        sel[i] = 255;
        queue[qt++] = i;
      }
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % W, y = (i / W) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (j < 0 || sel[j] || !match(j)) continue;
        sel[j] = 255;
        queue[qt++] = j;
      }
    }
  } else for (let i = 0; i < W * H; i++) if (selv[i] >= 128 || match(i)) sel[i] = 255;
  softenEdges(sel, W, H);
  // Keep the old selection's soft edges where it reached further.
  for (let i = 0; i < W * H; i++) if (selv[i] > sel[i]) sel[i] = selv[i];
  const m = new Mask(W, H, 0);
  m.writeRegion({ x: 0, y: 0, w: W, h: H }, sel);
  return m;
}

/** Anti-alias a binary mask's edges with a 3x3 average on boundary pixels only. */
function softenEdges(sel: Uint8Array, W: number, H: number): void {
  const src = sel.slice();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = src[i];
      const l = x > 0 ? src[i - 1] : v, r = x < W - 1 ? src[i + 1] : v;
      const u = y > 0 ? src[i - W] : v, d = y < H - 1 ? src[i + W] : v;
      if (l === v && r === v && u === v && d === v) continue;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          sum += src[yy * W + xx];
          n++;
        }
      // Keep the selected side mostly selected: blend toward the original.
      sel[i] = Math.round((v * 2 + sum / n) / 3);
    }
}

/** Select > Color Range: pixels near `color`, softly by `fuzziness` (0..200). */
export function colorRangeMask(doc: Document, color: [number, number, number], fuzziness: number, sampleMerged = true): Mask {
  const W = doc.width, H = doc.height;
  const px = pixelsFor(doc, doc.activeLayer, sampleMerged);
  const out = new Uint8Array(W * H);
  const f = Math.max(1, fuzziness);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    if (px[p + 3] === 0) continue;
    const d = Math.max(Math.abs(px[p] - color[0]), Math.abs(px[p + 1] - color[1]), Math.abs(px[p + 2] - color[2]));
    const v = 1 - d / f;
    if (v > 0) out[i] = Math.round(Math.min(1, v * 2) * (px[p + 3] / 255) * 255);
  }
  const m = new Mask(W, H, 0);
  m.writeRegion({ x: 0, y: 0, w: W, h: H }, out);
  return m;
}

// ---------------------------------------------------------------- modify

/** Run fn over a contiguous copy of the mask's bounds grown by `pad`. */
function withRegion(m: Mask, pad: number, fn: (d: Uint8Array, w: number, h: number) => Uint8Array): Mask {
  const b = m.bounds();
  const out = new Mask(m.width, m.height, 0);
  if (!b) return out;
  const r = clampRect({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }, m.width, m.height)!;
  const d = fn(m.readRegion(r), r.w, r.h);
  out.writeRegion(r, d);
  return out;
}

function boxBlur(src: Uint8Array, w: number, h: number, rad: number): Uint8Array {
  if (rad < 1) return src;
  const tmp = new Float32Array(w * h);
  const dst = new Uint8Array(w * h);
  const n = 2 * rad + 1;
  // Horizontal (edges clamp to zero outside, like the area beyond the selection).
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -rad; x <= rad; x++) acc += x >= 0 && x < w ? src[y * w + x] : 0;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / n;
      const add = x + rad + 1, sub = x - rad;
      acc += (add < w ? src[y * w + add] : 0) - (sub >= 0 ? src[y * w + sub] : 0);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -rad; y <= rad; y++) acc += y >= 0 && y < h ? tmp[y * w + x] : 0;
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = Math.round(acc / n);
      const add = y + rad + 1, sub = y - rad;
      acc += (add < h ? tmp[add * w + x] : 0) - (sub >= 0 ? tmp[sub * w + x] : 0);
    }
  }
  return dst;
}

/** Gaussian-like blur from three box passes (sigma close to radius / 2). */
function gaussian(src: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const sigma = Math.max(0.5, radius / 2);
  // Box sizes for 3 passes approximating a Gaussian of this sigma.
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4);
  const mm = Math.round(mIdeal);
  let d = src;
  for (let i = 0; i < 3; i++) d = boxBlur(d, w, h, ((i < mm ? wl : wu) - 1) / 2);
  return d;
}

export function featherMask(m: Mask, radius: number): Mask {
  if (radius <= 0) return m.share();
  return withRegion(m, Math.ceil(radius * 2) + 2, (d, w, h) => gaussian(d, w, h, radius));
}

/** Grow (or with min, shrink) by n pixels using an octagonal structuring element. */
function morph(d: Uint8Array, w: number, h: number, n: number, grow: boolean): Uint8Array {
  let cur = d;
  for (let k = 0; k < n; k++) {
    const next = new Uint8Array(w * h);
    const diag = k % 2 === 1; // alternate square and plus for a rounder shape
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = cur[y * w + x];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!diag && dx !== 0 && dy !== 0) continue;
            const xx = x + dx, yy = y + dy;
            const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : cur[yy * w + xx];
            v = grow ? Math.max(v, s) : Math.min(v, s);
          }
        next[y * w + x] = v;
      }
    cur = next;
  }
  return cur;
}

export function expandMask(m: Mask, n: number): Mask {
  return withRegion(m, n + 1, (d, w, h) => morph(d, w, h, n, true));
}

export function contractMask(m: Mask, n: number): Mask {
  return withRegion(m, 1, (d, w, h) => morph(d, w, h, n, false));
}

/** Select > Modify > Border: a soft band n px wide straddling the edge. */
export function borderMask(m: Mask, n: number): Mask {
  const outer = expandMask(m, Math.ceil(n / 2));
  const inner = contractMask(m, Math.floor(n / 2));
  outer.combine(inner, "subtract");
  return featherMask(outer, 1);
}

/** Select > Modify > Smooth: rounds corners and removes specks. */
export function smoothMask(m: Mask, n: number): Mask {
  return withRegion(m, n + 1, (d, w, h) => {
    const b = boxBlur(d, w, h, n);
    for (let i = 0; i < b.length; i++) b[i] = b[i] >= 128 ? 255 : 0;
    return b;
  });
}

// ---------------------------------------------------------------- combine

/** Apply a new shape to the document's selection with a selection mode. */
export function applySelection(doc: Document, shape: Mask, mode: SelectMode, feather = 0): void {
  if (feather > 0) shape = featherMask(shape, feather);
  const cur = doc.selection;
  if (mode === "replace" || !cur) {
    // Subtracting from or intersecting with nothing leaves nothing.
    doc.setSelection(mode === "subtract" || mode === "intersect" || shape.isEmpty() ? null : shape);
    return;
  }
  const next = cur.share();
  next.combine(shape, mode);
  doc.setSelection(next.isEmpty() ? null : next);
}

// ---------------------------------------------------------------- outline

/**
 * Boundary of the selection (threshold 50%) as line segments in canvas
 * pixels: [x0, y0, x1, y1, ...]. Collinear unit edges are merged.
 */
export function outlineSegments(m: Mask): Float32Array {
  if (m.rectHint) {
    const r = m.rectHint;
    return new Float32Array([r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y + r.h, r.x, r.y + r.h, r.x, r.y]);
  }
  const b = m.bounds();
  if (!b) return new Float32Array(0);
  const r = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
  const d = m.readRegion(r);
  const on = (x: number, y: number) => d[y * r.w + x] >= 128;
  const segs: number[] = [];
  // Horizontal edges between row y-1 and y.
  for (let y = 1; y < r.h; y++) {
    let start = -1;
    for (let x = 0; x <= r.w; x++) {
      const edge = x < r.w && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        segs.push(r.x + start, r.y + y, r.x + x, r.y + y);
        start = -1;
      }
    }
  }
  // Vertical edges between column x-1 and x.
  for (let x = 1; x < r.w; x++) {
    let start = -1;
    for (let y = 0; y <= r.h; y++) {
      const edge = y < r.h && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        segs.push(r.x + x, r.y + start, r.x + x, r.y + y);
        start = -1;
      }
    }
  }
  return new Float32Array(segs);
}

// ---------------------------------------------------------------- coverage helper

/**
 * The part of a layer an edit may touch: the selection (if any) intersected
 * with the layer, in layer coordinates, plus per-pixel coverage (null = 100%).
 */
export function editArea(doc: Document, layer: Layer): { area: Rect; cov: Uint8Array | null } | null {
  return editAreaIn(doc, layer.offsetX, layer.offsetY, layer.grid.width, layer.grid.height);
}

/** The same for a mask (a layer's or a set's), in mask coordinates. */
export function maskEditArea(doc: Document, host: MaskHost): { area: Rect; cov: Uint8Array | null } | null {
  const m = host.mask;
  return m ? editAreaIn(doc, host.offsetX, host.offsetY, m.width, m.height) : null;
}

export function editAreaIn(doc: Document, ox: number, oy: number, w: number, h: number): { area: Rect; cov: Uint8Array | null } | null {
  const full: Rect = { x: 0, y: 0, w, h };
  const sel = doc.selection;
  if (!sel) return { area: full, cov: null };
  const b = sel.bounds();
  if (!b) return null;
  const area = rectIntersect(full, { x: b.x - ox, y: b.y - oy, w: b.w, h: b.h });
  if (!area) return null;
  const cov = sel.readRegion({ x: area.x + ox, y: area.y + oy, w: area.w, h: area.h });
  return { area, cov };
}
