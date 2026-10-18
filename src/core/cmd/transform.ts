/**
 * Edit > Free Transform / Transform and Select > Transform Selection:
 * map a rectangle of a layer (or its selected pixels, or the selection
 * itself) onto any four-cornered shape.
 */

import { mapShapeLayer } from "../shapes";
import { CommandDef, ValidationError } from "../commands";
import type { Layer } from "../document";
import { Mask } from "../mask";
import { apply3, invert3, quadBounds, quadOk, squareToQuad, warpGray, warpRGBA, type Quad, type WarpMethod } from "../transform";
import { TileGrid, rectIntersect, type Rect } from "../tiles";
import { assertPixelsEditable, nodeId, targetLayer } from "./common";

const rectSchema = {
  type: "object" as const,
  properties: { x: { type: "number" as const }, y: { type: "number" as const }, w: { type: "number" as const, minimum: 0.01 }, h: { type: "number" as const, minimum: 0.01 } },
  required: ["x", "y", "w", "h"],
};
const quadSchema = { type: "array" as const, items: { type: "number" as const }, minItems: 8, maxItems: 8, description: "Destination corners x0,y0 (top-left), x1,y1 (top-right), x2,y2 (bottom-right), x3,y3 (bottom-left) in canvas pixels" };

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

function checkQuad(q: number[]): Quad {
  if (q.length !== 8 || q.some((v) => !Number.isFinite(v))) throw new ValidationError("the shape needs four corners");
  const quad = q as Quad;
  if (!quadOk(quad)) throw new ValidationError("the shape is folded over itself or too small");
  const b = quadBounds(quad);
  if (b.w > 30000 || b.h > 30000 || b.w * b.h > 300_000_000) throw new ValidationError("the transformed image would be too large");
  return quad;
}

function intRect(r: Rect): Rect {
  const x = Math.floor(r.x), y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

/** Composite `top` (straight RGBA, rect t) over `base` (straight RGBA, rect b), in place. */
function over(base: Uint8ClampedArray, b: Rect, top: Uint8ClampedArray, t: Rect): void {
  for (let y = 0; y < t.h; y++) {
    const by = t.y + y - b.y;
    if (by < 0 || by >= b.h) continue;
    for (let x = 0; x < t.w; x++) {
      const bx = t.x + x - b.x;
      if (bx < 0 || bx >= b.w) continue;
      const s = (y * t.w + x) * 4, d = (by * b.w + bx) * 4;
      const sa = top[s + 3] / 255;
      if (!sa) continue;
      const da = base[d + 3] / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) base[d + c] = (top[s + c] * sa + base[d + c] * da * (1 - sa)) / oa;
      base[d + 3] = oa * 255;
    }
  }
}

export const transformCommands: CommandDef[] = [
  {
    name: "layer.transform",
    label: "Free Transform",
    description:
      "Transform a layer: map a rectangle of it (canvas pixels, usually its content bounds; the rest is dropped) onto a four-cornered shape (scale, rotate, skew, distort, perspective, flip). With selected: true, only the selected pixels move (the selection moves with them).",
    params: {
      type: "object",
      properties: {
        id: nodeId,
        rect: rectSchema,
        quad: quadSchema,
        selected: { type: "boolean", default: false },
        method: { type: "string", enum: ["bicubic", "bilinear", "nearest"], default: "bicubic" },
      },
      required: ["rect", "quad"],
    },
    history: true,
    run(ctx, p: { id?: number; rect: Rect; quad: number[]; selected: boolean; method: WarpMethod }) {
      const doc = ctx.doc;
      const l = targetLayer(ctx, p.id);
      if (l.shape && !(p.selected && doc.selection)) {
        // Shape layers transform as vectors, so they stay crisp and editable.
        if (l.locks.position) throw new ValidationError(`"${l.name}" has its position locked`);
        const q0 = checkQuad(p.quad);
        const M = squareToQuad(q0);
        const R = p.rect;
        const before0 = l.bounds();
        const Mi = invert3(M);
        const r = mapShapeLayer(
          l,
          (x, y) => apply3(M, (x - R.x) / R.w, (y - R.y) / R.h),
          (x, y) => {
            const [u, v] = apply3(Mi, x, y);
            return [R.x + u * R.w, R.y + v * R.h];
          },
        );
        doc.emit({ type: "layers" });
        doc.dirty(union(before0, r));
        return;
      }
      assertPixelsEditable(l);
      const q = checkQuad(p.quad);
      const D = quadBounds(q);
      const before = l.bounds();
      if (p.selected && doc.selection) {
        const R = intRect(p.rect);
        transformSelected(doc, l, R, q, D, p.method);
      } else {
        if (l.isBackground) throw new ValidationError("the Background layer can't be transformed; make it a regular layer first (Layer > New > Layer From Background)");
        if (l.locks.position) throw new ValidationError(`"${l.name}" has its position locked`);
        // The rect (usually the layer's content) is what gets mapped onto the shape.
        const R = intRect(p.rect);
        const src = { x: R.x - l.offsetX, y: R.y - l.offsetY, w: R.w, h: R.h };
        const w = R.w, h = R.h;
        const px = warpRGBA(l.grid.readRegion(src), w, h, q, D, p.method);
        const g = new TileGrid(D.w, D.h);
        g.writeRegion({ x: 0, y: 0, w: D.w, h: D.h }, px);
        g.compact();
        if (l.mask) {
          const m = l.mask;
          let data: Uint8Array;
          if (l.maskLinked) data = warpGray(m.readRegion(src, m.defaultValue), w, h, q, D, m.defaultValue);
          // An unlinked mask stays where it is on the canvas.
          else data = m.readRegion({ x: D.x - l.offsetX, y: D.y - l.offsetY, w: D.w, h: D.h }, m.defaultValue);
          const nm = new Mask(D.w, D.h, m.defaultValue);
          nm.writeRegion({ x: 0, y: 0, w: D.w, h: D.h }, data);
          nm.compact();
          l.mask = nm;
        }
        l.grid = g;
        l.offsetX = D.x;
        l.offsetY = D.y;
      }
      doc.emit({ type: "layers" });
      doc.dirty(union(before, union(l.bounds(), D)));
    },
  },
  {
    name: "select.transform",
    label: "Transform Selection",
    description: "Transform the selection outline itself: map a rectangle of it onto a four-cornered shape.",
    params: { type: "object", properties: { rect: rectSchema, quad: quadSchema }, required: ["rect", "quad"] },
    history: true,
    enabled: (ctx) => !!ctx.doc.selection,
    run({ doc }, p: { rect: Rect; quad: number[] }) {
      const sel = doc.selection;
      if (!sel) throw new ValidationError("there is no selection");
      const q = checkQuad(p.quad);
      const R = intRect(p.rect);
      const D = quadBounds(q);
      const data = warpGray(sel.readRegion(R, 0), R.w, R.h, q, D, 0);
      const m = new Mask(doc.width, doc.height, 0);
      const clip = rectIntersect(D, { x: 0, y: 0, w: doc.width, h: doc.height });
      if (clip) {
        const part = new Uint8Array(clip.w * clip.h);
        for (let y = 0; y < clip.h; y++) part.set(data.subarray((clip.y - D.y + y) * D.w + clip.x - D.x, (clip.y - D.y + y) * D.w + clip.x - D.x + clip.w), y * clip.w);
        m.writeRegion(clip, part);
      }
      m.compact();
      doc.setSelection(m.isEmpty() ? null : m);
    },
  },
];

/** Move just the selected pixels of a layer (the selection goes with them). */
function transformSelected(doc: import("../document").Document, l: Layer, R: Rect, q: Quad, D: Rect, method: WarpMethod): void {
  const sel = doc.selection!;
  const lx = l.offsetX, ly = l.offsetY;
  // The floating pixels: the layer under the selection, faded by its coverage.
  const px = l.grid.readRegion({ x: R.x - lx, y: R.y - ly, w: R.w, h: R.h });
  const cov = sel.readRegion(R, 0);
  const float = new Uint8ClampedArray(px);
  for (let i = 0; i < cov.length; i++) float[i * 4 + 3] = (float[i * 4 + 3] * cov[i]) / 255;
  const warped = warpRGBA(float, R.w, R.h, q, D, method);
  // The layer grows to hold the moved pixels (a Background stays the canvas size).
  const nb = l.isBackground ? l.bounds() : union(l.bounds(), D);
  const base = l.grid.readRegion({ x: nb.x - lx, y: nb.y - ly, w: nb.w, h: nb.h });
  const bg = doc.background;
  for (let y = 0; y < R.h; y++) {
    const by = R.y + y - nb.y;
    if (by < 0 || by >= nb.h) continue;
    for (let x = 0; x < R.w; x++) {
      const bx = R.x + x - nb.x;
      if (bx < 0 || bx >= nb.w) continue;
      const k = cov[y * R.w + x] / 255;
      if (!k) continue;
      const d = (by * nb.w + bx) * 4;
      if (l.isBackground) {
        // The hole left behind takes the background color.
        for (let c = 0; c < 3; c++) base[d + c] = base[d + c] * (1 - k) + bg[c] * k;
        base[d + 3] = 255;
      } else if (l.locks.transparency) {
        // Locked transparency: nothing can go clear; leave the pixels.
      } else base[d + 3] = base[d + 3] * (1 - k);
    }
  }
  over(base, nb, warped, D);
  if (l.isBackground || l.locks.transparency) {
    // Keep alpha where it was.
    const orig = l.grid.readRegion({ x: nb.x - lx, y: nb.y - ly, w: nb.w, h: nb.h });
    for (let i = 3; i < base.length; i += 4) base[i] = l.isBackground ? 255 : orig[i];
  }
  const g = new TileGrid(nb.w, nb.h);
  g.writeRegion({ x: 0, y: 0, w: nb.w, h: nb.h }, base);
  g.compact();
  if (l.mask && (nb.x !== lx || nb.y !== ly || nb.w !== l.grid.width || nb.h !== l.grid.height)) {
    const m = l.mask;
    const nm = new Mask(nb.w, nb.h, m.defaultValue);
    nm.writeRegion({ x: 0, y: 0, w: nb.w, h: nb.h }, m.readRegion({ x: nb.x - lx, y: nb.y - ly, w: nb.w, h: nb.h }, m.defaultValue));
    nm.compact();
    l.mask = nm;
  }
  l.grid = g;
  l.offsetX = nb.x;
  l.offsetY = nb.y;
  // The selection follows the pixels.
  const sdata = warpGray(cov, R.w, R.h, q, D, 0);
  const m = new Mask(doc.width, doc.height, 0);
  const clip = rectIntersect(D, { x: 0, y: 0, w: doc.width, h: doc.height });
  if (clip) {
    const part = new Uint8Array(clip.w * clip.h);
    for (let y = 0; y < clip.h; y++) part.set(sdata.subarray((clip.y - D.y + y) * D.w + clip.x - D.x, (clip.y - D.y + y) * D.w + clip.x - D.x + clip.w), y * clip.w);
    m.writeRegion(clip, part);
  }
  m.compact();
  doc.setSelection(m.isEmpty() ? null : m);
}
