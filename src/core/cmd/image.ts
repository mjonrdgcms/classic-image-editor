/**
 * Image menu commands that change the whole document's geometry: Image
 * Size, Canvas Size, Rotate Canvas (90, 180, arbitrary), Flip Canvas and
 * Trim. Every layer, mask, the selection and the guides move together.
 */

import { mapShapeLayer } from "../shapes";
import { CommandDef, ValidationError } from "../commands";
import type { Document } from "../document";
import { Mask } from "../mask";
import { RESAMPLE_METHODS, resampleGray, resampleRGBA, type ResampleMethod } from "../resample";
import { renderTextLayer, textAnchor } from "../text";
import { TileGrid, type Rect } from "../tiles";
import { cropDocument, mapDocPoints } from "./edit";

const MAX = 30000;

function finish(doc: Document): void {
  doc.emit({ type: "size" });
  doc.emit({ type: "layers" });
  doc.emit({ type: "selection" });
  doc.emit({ type: "guides" });
  doc.dirty(null);
}

const fullMask = (m: Mask) => m.readRegion({ x: 0, y: 0, w: m.width, h: m.height }, m.defaultValue);

function maskFrom(data: Uint8Array, w: number, h: number, def: 0 | 255): Mask {
  const m = new Mask(w, h, def);
  m.writeRegion({ x: 0, y: 0, w, h }, data);
  m.compact();
  return m;
}

function gridFrom(data: Uint8ClampedArray, w: number, h: number): TileGrid {
  const g = new TileGrid(w, h);
  g.writeRegion({ x: 0, y: 0, w, h }, data);
  g.compact();
  return g;
}

// ------------------------------------------------------------------ Image Size

export function resizeDocument(doc: Document, W2: number, H2: number, method: ResampleMethod): void {
  const W = doc.width, H = doc.height;
  const kx = W2 / W, ky = H2 / H;
  for (const l of doc.layers) {
    if (l.shape) {
      mapShapeLayer(l, (x, y) => [x * kx, y * ky], (x, y) => [x / kx, y / ky]);
      continue;
    }
    if (l.text) {
      const t = l.text;
      const a = textAnchor(l);
      if (l.mask) {
        const mw = Math.max(1, Math.round(l.mask.width * kx)), mh = Math.max(1, Math.round(l.mask.height * ky));
        l.mask = maskFrom(resampleGray(fullMask(l.mask), l.mask.width, l.mask.height, mw, mh, method), mw, mh, l.mask.defaultValue);
        l.grid = new TileGrid(mw, mh);
      }
      l.offsetX = Math.round(l.offsetX * kx);
      l.offsetY = Math.round(l.offsetY * ky);
      l.text = {
        ...t,
        size: t.size * ky,
        leading: t.leading * ky,
        baselineShift: t.baselineShift * ky,
        hScale: (t.hScale * kx) / ky,
        box: t.box ? { w: t.box.w * kx, h: t.box.h * ky } : null,
      };
      renderTextLayer(l, { x: a.x * kx, y: a.y * ky });
      continue;
    }
    const w = l.grid.width, h = l.grid.height;
    const nw = l.isBackground ? W2 : Math.max(1, Math.round(w * kx));
    const nh = l.isBackground ? H2 : Math.max(1, Math.round(h * ky));
    l.grid = gridFrom(resampleRGBA(l.grid.readRegion({ x: 0, y: 0, w, h }), w, h, nw, nh, method), nw, nh);
    if (l.mask) l.mask = maskFrom(resampleGray(fullMask(l.mask), l.mask.width, l.mask.height, nw, nh, method), nw, nh, l.mask.defaultValue);
    l.offsetX = l.isBackground ? 0 : Math.round(l.offsetX * kx);
    l.offsetY = l.isBackground ? 0 : Math.round(l.offsetY * ky);
  }
  const canvasMask = (m: Mask) => maskFrom(resampleGray(fullMask(m), m.width, m.height, W2, H2, method === "nearest" ? "nearest" : "bilinear"), W2, H2, m.defaultValue);
  for (const g of doc.groups) if (g.mask) g.mask = canvasMask(g.mask);
  if (doc.selection) doc.selection = canvasMask(doc.selection);
  doc.lastSelection = null;
  doc.guides = { h: doc.guides.h.map((y) => Math.round(y * ky)), v: doc.guides.v.map((x) => Math.round(x * kx)) };
  doc.notes = doc.notes.map((n) => ({ ...n, x: Math.round(n.x * kx), y: Math.round(n.y * ky) }));
  mapDocPoints(doc, (x, y) => [x * kx, y * ky], W2, H2);
  doc.slices = doc.slices.map((s) => ({ ...s, x: Math.round(s.x * kx), y: Math.round(s.y * ky), w: Math.max(1, Math.round(s.w * kx)), h: Math.max(1, Math.round(s.h * ky)) }));
  doc.width = W2;
  doc.height = H2;
  finish(doc);
}

// ------------------------------------------------------------------ rotate / flip by right angles

export type Turn = "cw" | "180" | "ccw" | "flipH" | "flipV";

/** Rearrange a w x h array (ch bytes per pixel) for a turn. Returns the data and its new size. */
export function turnPixels<T extends Uint8Array | Uint8ClampedArray>(src: T, w: number, h: number, ch: number, turn: Turn): { data: T; w: number; h: number } {
  const swap = turn === "cw" || turn === "ccw";
  const nw = swap ? h : w, nh = swap ? w : h;
  const out = new (src.constructor as new (n: number) => T)(nw * nh * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let nx: number, ny: number;
      switch (turn) {
        case "cw":
          nx = h - 1 - y;
          ny = x;
          break;
        case "ccw":
          nx = y;
          ny = w - 1 - x;
          break;
        case "180":
          nx = w - 1 - x;
          ny = h - 1 - y;
          break;
        case "flipH":
          nx = w - 1 - x;
          ny = y;
          break;
        default:
          nx = x;
          ny = h - 1 - y;
      }
      const s = (y * w + x) * ch, d = (ny * nw + nx) * ch;
      for (let c = 0; c < ch; c++) out[d + c] = src[s + c];
    }
  return { data: out, w: nw, h: nh };
}

/** Where a rect (x, y, w, h) on a W x H canvas lands after the turn. */
function turnRect(r: Rect, W: number, H: number, turn: Turn): Rect {
  switch (turn) {
    case "cw":
      return { x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w };
    case "ccw":
      return { x: r.y, y: W - (r.x + r.w), w: r.h, h: r.w };
    case "180":
      return { x: W - (r.x + r.w), y: H - (r.y + r.h), w: r.w, h: r.h };
    case "flipH":
      return { x: W - (r.x + r.w), y: r.y, w: r.w, h: r.h };
    default:
      return { x: r.x, y: H - (r.y + r.h), w: r.w, h: r.h };
  }
}

export function turnDocument(doc: Document, turn: Turn): void {
  const W = doc.width, H = doc.height;
  const turnMask = (m: Mask) => {
    const t = turnPixels(fullMask(m), m.width, m.height, 1, turn);
    return maskFrom(t.data, t.w, t.h, m.defaultValue);
  };
  const turnPt = (x: number, y: number): [number, number] =>
    turn === "cw" ? [H - y, x] : turn === "ccw" ? [y, W - x] : turn === "180" ? [W - x, H - y] : turn === "flipH" ? [W - x, y] : [x, H - y];
  const turnBack = (x: number, y: number): [number, number] =>
    turn === "cw" ? [y, H - x] : turn === "ccw" ? [W - y, x] : turn === "180" ? [W - x, H - y] : turn === "flipH" ? [W - x, y] : [x, H - y];
  for (const l of doc.layers) {
    if (l.shape) {
      mapShapeLayer(l, turnPt, turnBack);
      continue;
    }
    // Turned type can't stay editable text.
    l.text = null;
    const r = turnRect(l.bounds(), W, H, turn);
    const t = turnPixels(l.grid.readRegion({ x: 0, y: 0, w: l.grid.width, h: l.grid.height }), l.grid.width, l.grid.height, 4, turn);
    l.grid = gridFrom(t.data, t.w, t.h);
    if (l.mask) l.mask = turnMask(l.mask);
    l.offsetX = r.x;
    l.offsetY = r.y;
  }
  for (const g of doc.groups) if (g.mask) g.mask = turnMask(g.mask);
  if (doc.selection) doc.selection = turnMask(doc.selection);
  doc.lastSelection = null;
  const { h: gh, v: gv } = doc.guides;
  doc.guides =
    turn === "cw"
      ? { h: gv.map((x) => x), v: gh.map((y) => H - y) }
      : turn === "ccw"
        ? { h: gv.map((x) => W - x), v: gh.map((y) => y) }
        : turn === "180"
          ? { h: gh.map((y) => H - y), v: gv.map((x) => W - x) }
          : turn === "flipH"
            ? { h: gh, v: gv.map((x) => W - x) }
            : { h: gh.map((y) => H - y), v: gv };
  // Notes follow the turn; slices go back to whole areas only on 180° turns and flips, so they are cleared.
  const tp = (x: number, y: number): [number, number] =>
    turn === "cw" ? [H - 1 - y, x] : turn === "ccw" ? [y, W - 1 - x] : turn === "180" ? [W - 1 - x, H - 1 - y] : turn === "flipH" ? [W - 1 - x, y] : [x, H - 1 - y];
  doc.notes = doc.notes.map((n) => {
    const [x, y] = tp(n.x, n.y);
    return { ...n, x, y };
  });
  doc.slices = [];
  mapDocPoints(doc, turnPt, turn === "cw" || turn === "ccw" ? H : W, turn === "cw" || turn === "ccw" ? W : H);
  if (turn === "cw" || turn === "ccw") {
    doc.width = H;
    doc.height = W;
  }
  finish(doc);
}

// ------------------------------------------------------------------ arbitrary rotation

/** Sample straight RGBA at (x, y) with bilinear filtering (premultiplied), transparent outside. */
function sampleRGBA(src: Uint8ClampedArray, w: number, h: number, x: number, y: number, out: number[]): void {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i, yy = y0 + j;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const p = (yy * w + xx) * 4, al = (src[p + 3] / 255) * wt;
      r += src[p] * al;
      g += src[p + 1] * al;
      b += src[p + 2] * al;
      a += al;
    }
  out[0] = a > 0 ? r / a : 0;
  out[1] = a > 0 ? g / a : 0;
  out[2] = a > 0 ? b / a : 0;
  out[3] = a * 255;
}

function sampleGray(src: Uint8Array, w: number, h: number, x: number, y: number, def: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let v = 0;
  for (let j = 0; j < 2; j++)
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i, yy = y0 + j;
      const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? def : src[yy * w + xx];
      v += s * (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
    }
  return v;
}

export function rotateDocument(doc: Document, degrees: number): void {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const W = doc.width, H = doc.height;
  const W2 = Math.ceil(Math.abs(W * c) + Math.abs(H * s) - 1e-6), H2 = Math.ceil(Math.abs(W * s) + Math.abs(H * c) - 1e-6);
  if (W2 > MAX || H2 > MAX) throw new ValidationError("the rotated image would be too large");
  const cx = W / 2, cy = H / 2, ncx = W2 / 2, ncy = H2 / 2;
  // New canvas point -> old canvas point (inverse rotation).
  const back = (x: number, y: number): [number, number] => {
    const dx = x - ncx, dy = y - ncy;
    return [cx + dx * c + dy * s, cy - dx * s + dy * c];
  };
  const bg = doc.background;
  const px = [0, 0, 0, 0];
  const forward = (x: number, y: number): [number, number] => {
    const u = x - cx, v = y - cy;
    return [ncx + u * c - v * s, ncy + u * s + v * c];
  };
  for (const l of doc.layers) {
    if (l.shape) {
      mapShapeLayer(l, forward, back);
      continue;
    }
    l.text = null;
    const w = l.grid.width, h = l.grid.height, src = l.grid.readRegion({ x: 0, y: 0, w, h });
    const out = new Uint8ClampedArray(W2 * H2 * 4);
    const msrc = l.mask ? fullMask(l.mask) : null;
    const mout = l.mask ? new Uint8Array(W2 * H2) : null;
    for (let y = 0; y < H2; y++)
      for (let x = 0; x < W2; x++) {
        const [ox, oy] = back(x + 0.5, y + 0.5);
        const lx = ox - l.offsetX - 0.5, ly = oy - l.offsetY - 0.5;
        sampleRGBA(src, w, h, lx, ly, px);
        const o = (y * W2 + x) * 4;
        if (l.isBackground) {
          // Corners outside the old picture get the background color.
          const k = px[3] / 255;
          out[o] = px[0] * k + bg[0] * (1 - k);
          out[o + 1] = px[1] * k + bg[1] * (1 - k);
          out[o + 2] = px[2] * k + bg[2] * (1 - k);
          out[o + 3] = 255;
        } else {
          out[o] = px[0];
          out[o + 1] = px[1];
          out[o + 2] = px[2];
          out[o + 3] = px[3];
        }
        if (mout && msrc) mout[y * W2 + x] = sampleGray(msrc, w, h, lx, ly, l.mask!.defaultValue);
      }
    l.grid = gridFrom(out, W2, H2);
    if (l.mask && mout) l.mask = maskFrom(mout, W2, H2, l.mask.defaultValue);
    l.offsetX = 0;
    l.offsetY = 0;
  }
  const rotMask = (m: Mask) => {
    const src = fullMask(m);
    const out = new Uint8Array(W2 * H2);
    for (let y = 0; y < H2; y++)
      for (let x = 0; x < W2; x++) {
        const [ox, oy] = back(x + 0.5, y + 0.5);
        out[y * W2 + x] = sampleGray(src, W, H, ox - 0.5, oy - 0.5, m.defaultValue === 255 ? 255 : 0);
      }
    return maskFrom(out, W2, H2, m.defaultValue);
  };
  for (const g of doc.groups) if (g.mask) g.mask = rotMask(g.mask);
  if (doc.selection) doc.selection = rotMask(doc.selection);
  doc.lastSelection = null;
  doc.guides = { h: [], v: [] };
  doc.slices = [];
  doc.notes = doc.notes.map((n) => {
    const [x, y] = forward(n.x + 0.5, n.y + 0.5);
    return { ...n, x: Math.max(0, Math.min(W2 - 1, Math.floor(x))), y: Math.max(0, Math.min(H2 - 1, Math.floor(y))) };
  });
  mapDocPoints(doc, forward, W2, H2);
  doc.width = W2;
  doc.height = H2;
  finish(doc);
}

// ------------------------------------------------------------------ Trim

export type TrimBasis = "transparent" | "topLeft" | "bottomRight";

/** The rect Trim would keep (null if nothing would be left). */
export function trimRect(doc: Document, basis: TrimBasis, sides: { top: boolean; bottom: boolean; left: boolean; right: boolean }): Rect | null {
  const W = doc.width, H = doc.height;
  const px = doc.composite({ x: 0, y: 0, w: W, h: H });
  const ref = basis === "topLeft" ? 0 : (W * H - 1) * 4;
  const keep = (i: number) => {
    const p = i * 4;
    if (basis === "transparent") return px[p + 3] > 0;
    return px[p] !== px[ref] || px[p + 1] !== px[ref + 1] || px[p + 2] !== px[ref + 2] || px[p + 3] !== px[ref + 3];
  };
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (keep(y * W + x)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const left = sides.left ? x0 : 0, top = sides.top ? y0 : 0;
  const right = sides.right ? x1 + 1 : W, bottom = sides.bottom ? y1 + 1 : H;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ------------------------------------------------------------------ commands

export const ANCHORS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"] as const;
export type Anchor = (typeof ANCHORS)[number];

/** Where the old canvas sits in a new w x h canvas for an anchor (as a crop rect in old coordinates). */
export function canvasRect(W: number, H: number, w: number, h: number, anchor: Anchor): Rect {
  const col = anchor.includes("w") ? 0 : anchor.includes("e") ? 2 : 1;
  const row = anchor.startsWith("n") ? 0 : anchor.startsWith("s") ? 2 : 1;
  const dx = col === 0 ? 0 : col === 2 ? w - W : Math.round((w - W) / 2);
  const dy = row === 0 ? 0 : row === 2 ? h - H : Math.round((h - H) / 2);
  return { x: -dx, y: -dy, w, h };
}

export const imageCommands: CommandDef[] = [
  {
    name: "image.resize",
    label: "Image Size",
    description: "Resample the whole image (every layer, mask and the selection) to a new width and height in pixels, and/or set its resolution (pixels per inch, which only changes the print size).",
    params: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX },
        height: { type: "integer", minimum: 1, maximum: MAX },
        method: { type: "string", enum: RESAMPLE_METHODS, default: "bicubic", description: "nearest, bilinear, bicubic or lanczos" },
        resolution: { type: "number", minimum: 1, maximum: 30000, description: "Pixels per inch" },
      },
      required: ["width", "height"],
    },
    history: true,
    run({ doc }, p: { width: number; height: number; method: ResampleMethod; resolution?: number }) {
      if (p.resolution !== undefined) {
        doc.resolution = Math.round(p.resolution * 1000) / 1000;
        doc.emit({ type: "size" });
      }
      if (p.width === doc.width && p.height === doc.height) return;
      if (p.width * p.height > 400_000_000) throw new ValidationError("that image would be too large");
      resizeDocument(doc, p.width, p.height, p.method);
    },
  },
  {
    name: "image.canvasSize",
    label: "Canvas Size",
    description: "Change the canvas size without resampling: the picture keeps its pixels and sits at the anchor (nw, n, ne, w, c, e, sw, s, se); new Background area gets the background color.",
    params: {
      type: "object",
      properties: {
        width: { type: "integer", minimum: 1, maximum: MAX },
        height: { type: "integer", minimum: 1, maximum: MAX },
        anchor: { type: "string", enum: [...ANCHORS], default: "c" },
      },
      required: ["width", "height"],
    },
    history: true,
    run({ doc }, p: { width: number; height: number; anchor: Anchor }) {
      if (p.width === doc.width && p.height === doc.height) return;
      cropDocument(doc, canvasRect(doc.width, doc.height, p.width, p.height, p.anchor));
    },
  },
  {
    name: "image.rotate",
    label: (p: { angle: number }) => (p.angle === 180 ? "Rotate Canvas 180°" : p.angle === 90 ? "Rotate Canvas 90° CW" : p.angle === -90 || p.angle === 270 ? "Rotate Canvas 90° CCW" : "Rotate Canvas"),
    description: "Rotate the whole canvas clockwise by an angle in degrees (90, 180, -90 are lossless; other angles enlarge the canvas, filling Background corners with the background color).",
    params: { type: "object", properties: { angle: { type: "number", minimum: -359.99, maximum: 359.99 } }, required: ["angle"] },
    history: true,
    run({ doc }, p: { angle: number }) {
      const a = ((p.angle % 360) + 360) % 360;
      if (a === 0) return;
      if (a === 90) turnDocument(doc, "cw");
      else if (a === 180) turnDocument(doc, "180");
      else if (a === 270) turnDocument(doc, "ccw");
      else rotateDocument(doc, p.angle);
    },
  },
  {
    name: "image.flip",
    label: (p: { direction: string }) => (p.direction === "vertical" ? "Flip Canvas Vertical" : "Flip Canvas Horizontal"),
    description: "Mirror the whole canvas horizontally or vertically.",
    params: { type: "object", properties: { direction: { type: "string", enum: ["horizontal", "vertical"] } }, required: ["direction"] },
    history: true,
    run({ doc }, p: { direction: string }) {
      turnDocument(doc, p.direction === "vertical" ? "flipV" : "flipH");
    },
  },
  {
    name: "image.trim",
    label: "Trim",
    description: "Crop away empty borders: transparent pixels, or pixels the color of the top-left or bottom-right corner, from the chosen sides.",
    params: {
      type: "object",
      properties: {
        basis: { type: "string", enum: ["transparent", "topLeft", "bottomRight"], default: "transparent" },
        top: { type: "boolean", default: true },
        bottom: { type: "boolean", default: true },
        left: { type: "boolean", default: true },
        right: { type: "boolean", default: true },
      },
    },
    history: true,
    run({ doc }, p: { basis: TrimBasis; top: boolean; bottom: boolean; left: boolean; right: boolean }) {
      const r = trimRect(doc, p.basis, p);
      if (!r) throw new ValidationError("trimming would leave nothing");
      if (r.w === doc.width && r.h === doc.height) return;
      cropDocument(doc, r);
    },
  },
];
