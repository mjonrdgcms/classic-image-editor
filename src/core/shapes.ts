/**
 * Shape layers: a layer whose pixels are a vector path filled with a color.
 * The path (in layer space) stays editable with the path tools; the pixels
 * are re-rendered whenever it changes, as type layers are.
 */

import type { Layer } from "./document";
import { Mask } from "./mask";
import { shiftMask } from "./maskfx";
import { Rect, TileGrid } from "./tiles";
import { mapPath, pathBounds, ringsMask, flatten, translatePath, type VecPath } from "./vector";

export interface ShapeSpec {
  /** In layer space (canvas = layer space + the layer's offset). */
  path: VecPath;
  color: [number, number, number];
}

/** Draw a shape layer's pixels from its path, fitting the layer to the shape. Returns the canvas rect changed. */
export function renderShapeLayer(l: Layer): Rect {
  const spec = l.shape!;
  const before = l.bounds();
  const b = pathBounds(spec.path);
  const x0 = b ? Math.floor(b.x) - 1 : 0, y0 = b ? Math.floor(b.y) - 1 : 0;
  const w = b ? Math.ceil(b.x + b.w) + 1 - x0 : 1, h = b ? Math.ceil(b.y + b.h) + 1 - y0 : 1;
  const local = translatePath(spec.path, -x0, -y0);
  const grid = new TileGrid(w, h);
  if (b) {
    const m = ringsMask(w, h, flatten(local).map((s) => s.pts));
    const cov = m.readRegion({ x: 0, y: 0, w, h });
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < cov.length; i++) {
      if (!cov[i]) continue;
      px[i * 4] = spec.color[0];
      px[i * 4 + 1] = spec.color[1];
      px[i * 4 + 2] = spec.color[2];
      px[i * 4 + 3] = cov[i];
    }
    grid.writeRegion({ x: 0, y: 0, w, h }, px);
    grid.compact();
  }
  if (l.mask) l.mask = shiftMask(l.mask, -x0, -y0, w, h);
  l.grid = grid;
  l.offsetX += x0;
  l.offsetY += y0;
  l.shape = { ...spec, path: local };
  const after = l.bounds();
  const ux = Math.min(before.x, after.x), uy = Math.min(before.y, after.y);
  return { x: ux, y: uy, w: Math.max(before.x + before.w, after.x + after.w) - ux, h: Math.max(before.y + before.h, after.y + after.h) - uy };
}

/** The shape's path in canvas space. */
export function shapeCanvasPath(l: Layer): VecPath {
  return translatePath(l.shape!.path, l.offsetX, l.offsetY);
}

/** Replace a shape layer's path with one given in canvas space, and redraw it. */
export function setShapeCanvasPath(l: Layer, canvasPath: VecPath): Rect {
  l.shape = { ...l.shape!, path: translatePath(canvasPath, -l.offsetX, -l.offsetY) };
  return renderShapeLayer(l);
}

/**
 * Move a shape layer's path through a canvas-space mapping (crop, resize, transform), and redraw it.
 * inv (canvas point after -> before) lets the layer mask follow; without it the mask is dropped.
 */
export function mapShapeLayer(l: Layer, f: (x: number, y: number) => [number, number], inv?: (x: number, y: number) => [number, number]): Rect {
  const canvas = mapPath(shapeCanvasPath(l), f);
  let mask: Mask | null = null, mx = 0, my = 0;
  if (l.mask && inv) {
    const m = l.mask, ox = l.offsetX, oy = l.offsetY;
    const cs = [f(ox, oy), f(ox + m.width, oy), f(ox + m.width, oy + m.height), f(ox, oy + m.height)];
    mx = Math.floor(Math.min(...cs.map((c) => c[0])));
    my = Math.floor(Math.min(...cs.map((c) => c[1])));
    const W = Math.min(MAX_MASK, Math.max(1, Math.ceil(Math.max(...cs.map((c) => c[0]))) - mx));
    const H = Math.min(MAX_MASK, Math.max(1, Math.ceil(Math.max(...cs.map((c) => c[1]))) - my));
    const src = m.readRegion({ x: 0, y: 0, w: m.width, h: m.height }, m.defaultValue);
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const [sx, sy] = inv(mx + x + 0.5, my + y + 0.5);
        out[y * W + x] = Math.round(sampleGray(src, m.width, m.height, sx - ox - 0.5, sy - oy - 0.5, m.defaultValue));
      }
    mask = new Mask(W, H, m.defaultValue);
    mask.writeRegion({ x: 0, y: 0, w: W, h: H }, out);
  }
  l.mask = mask;
  l.offsetX = mx;
  l.offsetY = my;
  l.grid = new TileGrid(1, 1);
  l.shape = { ...l.shape!, path: translatePath(canvas, -mx, -my) };
  return renderShapeLayer(l);
}

const MAX_MASK = 30000;

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
