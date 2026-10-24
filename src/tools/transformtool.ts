/**
 * Free Transform (Ctrl+T), Edit > Transform and Select > Transform
 * Selection: a box with handles over the layer (or its selected pixels, or
 * the selection outline).
 *
 *   drag inside           move (Shift: straight)
 *   drag a handle         scale (corners keep proportions by default, see
 *                         Preferences; Shift does the opposite; Alt: from the center)
 *   drag outside the box  rotate (Shift: 15° steps)
 *   Ctrl + corner         distort that corner
 *   Ctrl + side           skew
 *   Ctrl+Alt+Shift corner perspective
 *   Enter / double-click  apply; Esc cancels; Ctrl+Z undoes the last handle move
 *
 * The preview is drawn over the image (projective, in small triangles);
 * the real pixels are only touched once, by the layer.transform command.
 */

import { pendingEdits } from "../core/history";
import type { App, Session } from "../app";
import type { Layer } from "../core/document";
import { apply3, quadOk, rectQuad, squareToQuad, type Quad } from "../core/transform";
import { TILE, TileGrid, rectUnion, type Rect } from "../core/tiles";
import { el } from "../ui/dialogs";
import * as storage from "../ui/storage";
import type { Tool, ToolEvent, ToolId } from "./tools";

export type TransformMode = "free" | "scale" | "rotate" | "skew" | "distort" | "perspective";
type Target = "layer" | "selection";

interface TState {
  session: Session;
  target: Target;
  layerId: number;
  /** Only the selected pixels move. */
  selected: boolean;
  rect: Rect;
  quad: Quad;
  history: Quad[];
  mode: TransformMode;
  /** Rotation center (canvas). */
  ref: [number, number];
  /** The floating picture for the preview (may be smaller than rect). */
  image: HTMLCanvasElement | null;
  /** The layer's real grid, hidden during the preview. */
  original: TileGrid | null;
  /** Other selected layers transformed along with it, and their real grids. */
  others: { id: number; original: TileGrid }[];
  prevTool: ToolId;
}

let st: TState | null = null;
const listeners = new Set<() => void>();
const changed = (app: App) => {
  for (const fn of listeners) fn();
  app.emit("overlay");
};

export function transformActive(): boolean {
  return !!st;
}

/** The tight bounds of a layer's visible pixels (canvas space), or null if it's empty. */
export function contentBounds(l: Layer): Rect | null {
  const g = l.grid;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let ty = 0; ty < g.rows; ty++)
    for (let tx = 0; tx < g.cols; tx++) {
      const t = g.getTile(tx, ty);
      if (!t) continue;
      const tw = Math.min(TILE, g.width - tx * TILE), th = Math.min(TILE, g.height - ty * TILE);
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++)
          if (t.data[(y * TILE + x) * 4 + 3]) {
            const gx = tx * TILE + x, gy = ty * TILE + y;
            if (gx < x0) x0 = gx;
            if (gx > x1) x1 = gx;
            if (gy < y0) y0 = gy;
            if (gy > y1) y1 = gy;
          }
    }
  if (x1 < 0) return null;
  return { x: x0 + l.offsetX, y: y0 + l.offsetY, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const center = (q: Quad): [number, number] => [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];

/** Begin a transform of the active layer (or selection outline). Returns false if it can't. */
export async function startTransform(app: App, target: Target, mode: TransformMode = "free"): Promise<boolean> {
  const s = app.active;
  const doc = app.doc;
  if (!s || !doc || st) return false;
  if (target === "selection") {
    const b = doc.selection?.bounds();
    if (!b) return void app.toast("There is no selection to transform."), false;
    st = { session: s, target, layerId: 0, selected: false, rect: b, quad: rectQuad(b), history: [], mode, ref: [b.x + b.w / 2, b.y + b.h / 2], image: null, original: null, others: [], prevTool: app.baseTool.id };
  } else {
    if (!doc.activeLayer) return void app.toast("Select a layer to transform (layer sets can't be transformed yet)."), false;
    if (!(await app.readyForPixels(true, !doc.selection))) return false;
    let l = doc.activeLayer!;
    if (l.locks.pixels) return void app.toast(`Could not transform because "${l.name}" has its image pixels locked.`), false;
    const selected = !!doc.selection;
    if (!selected && l.isBackground) {
      // Like PS: the Background becomes a regular layer so it can move.
      if (!app.run("layer.fromBackground", {})) return false;
      l = doc.activeLayer!;
    }
    if (!selected && l.locks.position) return void app.toast(`Could not transform because "${l.name}" has its position locked.`), false;
    // Several layers selected (and no pixel selection): they transform together.
    const others = selected ? [] : doc.selectedLayers.filter((x) => x.id !== l.id && !x.isBackground && x.visible);
    const group = others.filter((x) => !x.locks.position && !x.locks.pixels && !x.text);
    if (group.length < others.length) app.toast("Type layers and locked layers are left out of the transform.");
    if (group.length) {
      let rect: Rect | null = null;
      for (const x of [l, ...group]) rect = rectUnion(rect, contentBounds(x));
      if (!rect) return void app.toast("There is nothing on these layers to transform."), false;
      st = { session: s, target, layerId: l.id, selected: false, rect, quad: rectQuad(rect), history: [], mode, ref: [rect.x + rect.w / 2, rect.y + rect.h / 2], image: null, original: null, others: [], prevTool: app.baseTool.id };
      buildGroupPreview([l, ...group]);
      app.setTool("transform");
      changed(app);
      return true;
    }
    let rect: Rect | null;
    if (selected) {
      rect = doc.selection!.bounds();
    } else rect = contentBounds(l);
    if (!rect || rect.w < 1 || rect.h < 1) return void app.toast("There is nothing on this layer to transform."), false;
    st = { session: s, target, layerId: l.id, selected, rect, quad: rectQuad(rect), history: [], mode, ref: [rect.x + rect.w / 2, rect.y + rect.h / 2], image: null, original: null, others: [], prevTool: app.baseTool.id };
    buildPreview(l);
  }
  app.setTool("transform");
  changed(app);
  return true;
}

/** Make the floating picture and hide the pixels it came from. */
function buildPreview(l: Layer): void {
  const t = st!;
  const doc = t.session.doc;
  const r = t.rect;
  const px = l.grid.readRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h });
  const cov = t.selected ? doc.selection!.readRegion(r, 0) : null;
  const mask = l.mask && l.maskEnabled ? l.mask.readRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h }, l.mask.defaultValue) : null;
  for (let i = 0; i < r.w * r.h; i++) {
    let a = px[i * 4 + 3];
    if (cov) a = (a * cov[i]) / 255;
    if (mask && !t.selected) a = (a * mask[i]) / 255;
    px[i * 4 + 3] = a * l.opacity;
  }
  // Preview at most 2048 px on its long side.
  const k = Math.min(1, 2048 / Math.max(r.w, r.h));
  const full = el("canvas", { width: r.w, height: r.h });
  full.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(px), r.w, r.h), 0, 0);
  let img = full;
  if (k < 1) {
    img = el("canvas", { width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) });
    const c = img.getContext("2d")!;
    c.imageSmoothingQuality = "high";
    c.drawImage(full, 0, 0, img.width, img.height);
  }
  t.image = img;
  // Hide the moving pixels: the whole layer, or just the selected ones.
  t.original = l.grid;
  if (!t.selected) l.grid = new TileGrid(l.grid.width, l.grid.height);
  else {
    const g = l.grid.share();
    const lr = { x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h };
    const base = g.readRegion(lr);
    for (let i = 0; i < r.w * r.h; i++) {
      const c = cov![i] / 255;
      if (!c) continue;
      if (l.isBackground) {
        for (let ch = 0; ch < 3; ch++) base[i * 4 + ch] = base[i * 4 + ch] * (1 - c) + doc.background[ch] * c;
      } else base[i * 4 + 3] = base[i * 4 + 3] * (1 - c);
    }
    g.writeRegion(lr, base);
    l.grid = g;
  }
  doc.dirty(l.bounds());
}

/** Several layers: one floating picture of all of them (bottom to top), and all of them hidden. */
function buildGroupPreview(layers: Layer[]): void {
  const t = st!;
  const doc = t.session.doc;
  const r = t.rect;
  const order = doc.layers.filter((x) => layers.includes(x));
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  for (const l of order) {
    const px = l.grid.readRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h });
    const mask = l.mask && l.maskEnabled ? l.mask.readRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h }, l.mask.defaultValue) : null;
    for (let i = 0; i < r.w * r.h; i++) {
      const p = i * 4;
      let a = (px[p + 3] / 255) * l.opacity;
      if (mask) a *= mask[i] / 255;
      if (a <= 0) continue;
      const da = out[p + 3] / 255, oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) out[p + c] = (px[p + c] * a + out[p + c] * da * (1 - a)) / oa;
      out[p + 3] = oa * 255;
    }
  }
  const k = Math.min(1, 2048 / Math.max(r.w, r.h));
  const full = el("canvas", { width: r.w, height: r.h });
  full.getContext("2d")!.putImageData(new ImageData(out, r.w, r.h), 0, 0);
  let img = full;
  if (k < 1) {
    img = el("canvas", { width: Math.max(1, Math.round(r.w * k)), height: Math.max(1, Math.round(r.h * k)) });
    const c = img.getContext("2d")!;
    c.imageSmoothingQuality = "high";
    c.drawImage(full, 0, 0, img.width, img.height);
  }
  t.image = img;
  for (const l of layers) {
    if (l.id === t.layerId) t.original = l.grid;
    else t.others.push({ id: l.id, original: l.grid });
    l.grid = new TileGrid(l.grid.width, l.grid.height);
    doc.dirty(l.bounds());
  }
}

/** Put the real pixels back. */
function restore(): Layer | null {
  const t = st;
  if (!t || t.target !== "layer") return null;
  const doc = t.session.doc;
  const l = doc.layerById(t.layerId);
  if (l && t.original) {
    l.grid = t.original;
    doc.dirty(l.bounds());
  }
  for (const o of t.others) {
    const x = doc.layerById(o.id);
    if (x) {
      x.grid = o.original;
      doc.dirty(x.bounds());
    }
  }
  t.original = null;
  return l ?? null;
}

function end(app: App): void {
  const t = st;
  st = null;
  if (t && app.tool.id === "transform") app.setTool(t.prevTool === "transform" ? "move" : t.prevTool);
  changed(app);
}

export function commitTransform(app: App): void {
  const t = st;
  if (!t) return;
  const unchanged = t.quad.every((v, i) => Math.abs(v - rectQuad(t.rect)[i]) < 1e-6);
  const l = restore();
  end(app);
  if (unchanged) return;
  if (!quadOk(t.quad)) return app.toast("Could not apply the transform: the shape is folded over itself.");
  if (app.active !== t.session) app.activate(t.session);
  const quad = t.quad.map((v) => Math.round(v * 1000) / 1000);
  const method = transformMethod(app);
  // Remembered for Edit > Transform > Again (Ctrl+Shift+T).
  lastTransform = { target: t.target, rect: { ...t.rect }, quad: [...t.quad] as Quad };
  if (t.target === "selection") app.run("select.transform", { rect: t.rect, quad });
  else if (l && t.others.length) {
    const ids = [l.id, ...t.others.map((o) => o.id)];
    try {
      app.bus.group("Free Transform", () => {
        for (const id of ids) app.bus.dispatch("layer.transform", { id, rect: t.rect, quad, selected: false, method });
      });
    } catch (e) {
      app.toast(`Could not complete Free Transform: ${e instanceof Error ? e.message : String(e)}.`);
    }
  } else if (l) app.run("layer.transform", { id: l.id, rect: t.rect, quad, selected: t.selected, method });
}

/** The last applied Free Transform, as a canvas mapping. */
let lastTransform: { target: Target; rect: Rect; quad: Quad } | null = null;

export function hasLastTransform(): boolean {
  return !!lastTransform;
}

/** The interpolation for transforms (the options bar's choice, which follows the Preferences default). */
export function transformMethod(app: App): string {
  return storage.load("transformMethod", app.prefs.interpolation);
}

/**
 * Edit > Transform > Again: repeat the last transform's exact mapping on what
 * would be transformed now (the selection outline, the selected pixels, or
 * the layers), as Photoshop does.
 */
export async function transformAgain(app: App): Promise<void> {
  const doc = app.doc;
  const last = lastTransform;
  if (!doc || st) return;
  if (!last) return app.toast("There is no transform to repeat yet.");
  const M = squareToQuad(last.quad);
  const R = last.rect;
  const f = (x: number, y: number) => apply3(M, (x - R.x) / R.w, (y - R.y) / R.h);
  const mapRect = (r: Rect) => {
    const c = rectQuad(r);
    const out: number[] = [];
    for (let i = 0; i < 8; i += 2) out.push(...f(c[i], c[i + 1]));
    return out.map((v) => Math.round(v * 1000) / 1000) as Quad;
  };
  if (last.target === "selection") {
    const b = doc.selection?.bounds();
    if (!b) return app.toast("There is no selection to transform.");
    const quad = mapRect(b);
    if (!quadOk(quad)) return;
    app.run("select.transform", { rect: b, quad });
    return;
  }
  if (!doc.activeLayer) return app.toast("Select a layer to transform.");
  if (!(await app.readyForPixels(true, !doc.selection))) return;
  const l = doc.activeLayer;
  const method = transformMethod(app);
  if (doc.selection) {
    const b = doc.selection.bounds();
    if (b) app.run("layer.transform", { id: l.id, rect: b, quad: mapRect(b), selected: true, method });
    return;
  }
  const layers = doc.selectedLayers.filter((x) => x.visible && !x.isBackground && !x.text && !x.locks.position && !x.locks.pixels);
  if (!layers.includes(l)) layers.push(l);
  let rect: Rect | null = null;
  for (const x of layers) rect = rectUnion(rect, contentBounds(x));
  if (!rect) return app.toast("There is nothing on this layer to transform.");
  const quad = mapRect(rect);
  if (!quadOk(quad)) return app.toast("Could not apply the transform: the shape is folded over itself.");
  const r = rect;
  try {
    app.bus.group("Transform Again", () => {
      for (const x of layers) app.bus.dispatch("layer.transform", { id: x.id, rect: r, quad, selected: false, method });
    });
  } catch (e) {
    app.toast(`Could not transform again: ${e instanceof Error ? e.message : String(e)}.`);
  }
}

export function cancelTransform(app: App): void {
  if (!st) return;
  restore();
  end(app);
}

/** Edit > Transform > Rotate 180° etc.: apply a fixed transform straight away. */
export async function quickTransform(app: App, kind: "rotate180" | "rotateCW" | "rotateCCW" | "flipH" | "flipV", target: Target = "layer"): Promise<void> {
  if (!(await startTransform(app, target))) return;
  const t = st!;
  const q = t.quad;
  const [cx, cy] = center(q);
  const pts: [number, number][] = [
    [q[0], q[1]],
    [q[2], q[3]],
    [q[4], q[5]],
    [q[6], q[7]],
  ];
  const map = (f: (x: number, y: number) => [number, number]) => pts.flatMap(([x, y]) => f(x - cx, y - cy)).map((v, i) => v + (i % 2 ? cy : cx)) as Quad;
  t.quad =
    kind === "rotate180" ? map((x, y) => [-x, -y]) : kind === "rotateCW" ? map((x, y) => [-y, x]) : kind === "rotateCCW" ? map((x, y) => [y, -x]) : kind === "flipH" ? map((x, y) => [-x, y]) : map((x, y) => [x, -y]);
  commitTransform(app);
}

// ------------------------------------------------------------------ drawing

/** Draw an image onto a projective quad by splitting it into small affine triangles. */
function drawProjective(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, q: Quad, toScreen: (x: number, y: number) => [number, number]): void {
  const H = squareToQuad(q);
  const persp = Math.abs(H[6]) + Math.abs(H[7]) > 1e-9;
  if (!persp) {
    // A plain parallelogram is one affine draw: no seams.
    const [ax, ay] = toScreen(q[0], q[1]), [bx, by] = toScreen(q[2], q[3]), [dx, dy] = toScreen(q[6], q[7]);
    ctx.save();
    ctx.transform((bx - ax) / img.width, (by - ay) / img.width, (dx - ax) / img.height, (dy - ay) / img.height, ax, ay);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
    return;
  }
  const n = persp ? 16 : 1;
  const iw = img.width, ih = img.height;
  const pt = (u: number, v: number) => toScreen(...apply3(H, u, v));
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
      const a = pt(u0, v0), b = pt(u1, v0), c = pt(u1, v1), d = pt(u0, v1);
      tri(ctx, img, [u0 * iw, v0 * ih], [u1 * iw, v0 * ih], [u1 * iw, v1 * ih], a, b, c, persp);
      tri(ctx, img, [u0 * iw, v0 * ih], [u1 * iw, v1 * ih], [u0 * iw, v1 * ih], a, c, d, persp);
    }
}

function tri(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, s0: number[], s1: number[], s2: number[], d0: number[], d1: number[], d2: number[], pad: boolean): void {
  // Affine map from image triangle to screen triangle.
  const den = s0[0] * (s1[1] - s2[1]) + s1[0] * (s2[1] - s0[1]) + s2[0] * (s0[1] - s1[1]);
  if (!den) return;
  const a = (d0[0] * (s1[1] - s2[1]) + d1[0] * (s2[1] - s0[1]) + d2[0] * (s0[1] - s1[1])) / den;
  const b = (d0[1] * (s1[1] - s2[1]) + d1[1] * (s2[1] - s0[1]) + d2[1] * (s0[1] - s1[1])) / den;
  const c = (d0[0] * (s2[0] - s1[0]) + d1[0] * (s0[0] - s2[0]) + d2[0] * (s1[0] - s0[0])) / den;
  const d = (d0[1] * (s2[0] - s1[0]) + d1[1] * (s0[0] - s2[0]) + d2[1] * (s1[0] - s0[0])) / den;
  const e = (d0[0] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[0] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[0] * (s0[0] * s1[1] - s1[0] * s0[1])) / den;
  const f = (d0[1] * (s1[0] * s2[1] - s2[0] * s1[1]) + d1[1] * (s2[0] * s0[1] - s0[0] * s2[1]) + d2[1] * (s0[0] * s1[1] - s1[0] * s0[1])) / den;
  ctx.save();
  ctx.beginPath();
  // Grow the clip a hair so neighboring triangles don't leave hairline seams.
  const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
  const g = pad ? 0.9 : 0.3;
  const grow = (p: number[]) => {
    const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / l) * g, p[1] + (dy / l) * g];
  };
  const [p0, p1, p2] = [grow(d0), grow(d1), grow(d2)];
  ctx.moveTo(p0[0], p0[1]);
  ctx.lineTo(p1[0], p1[1]);
  ctx.lineTo(p2[0], p2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// ------------------------------------------------------------------ the tool

type Hit = { kind: "corner"; i: number } | { kind: "edge"; i: number } | { kind: "move" } | { kind: "rotate" } | { kind: "ref" };

const insideQuad = (q: Quad, x: number, y: number) => {
  let c = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = q[i * 2], yi = q[i * 2 + 1], xj = q[j * 2], yj = q[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

export function makeTransformTool(app: App): Tool {
  // Any other command while transforming cancels it first (the real pixels come back).
  app.bus.onBeforeCommand(() => {
    if (st) cancelTransform(app);
  });
  // So do history moves, saving and anything else that reads the whole document.
  pendingEdits.add(() => {
    if (st) cancelTransform(app);
  });
  const view = () => st!.session.compositor.view;
  const toScreen = (x: number, y: number): [number, number] => {
    const v = view();
    return [x * v.zoom + v.x, y * v.zoom + v.y];
  };
  const corners = (q: Quad): [number, number][] => [
    [q[0], q[1]],
    [q[2], q[3]],
    [q[4], q[5]],
    [q[6], q[7]],
  ];
  const mids = (q: Quad): [number, number][] => [0, 1, 2, 3].map((i) => [(q[i * 2] + q[((i + 1) % 4) * 2]) / 2, (q[i * 2 + 1] + q[((i + 1) % 4) * 2 + 1]) / 2]);

  app.overlayPainters.add((ctx, s) => {
    const t = st;
    if (!t || t.session !== s) return;
    const q = t.quad;
    if (t.image) {
      ctx.imageSmoothingQuality = "high";
      drawProjective(ctx, t.image, q, toScreen);
    }
    // Outline, handles and the center point.
    const sc = corners(q).map(([x, y]) => toScreen(x, y));
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.beginPath();
    sc.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.setLineDash([]);
    const handle = (x: number, y: number) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
      ctx.strokeStyle = "#000";
      ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
    };
    sc.forEach(([x, y]) => handle(x, y));
    mids(q)
      .map(([x, y]) => toScreen(x, y))
      .forEach(([x, y]) => handle(x, y));
    const [rx, ry] = toScreen(...t.ref);
    ctx.beginPath();
    ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = "#000";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx - 7, ry);
    ctx.lineTo(rx + 7, ry);
    ctx.moveTo(rx, ry - 7);
    ctx.lineTo(rx, ry + 7);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.stroke();
  });

  const hit = (e: ToolEvent): Hit => {
    const t = st!;
    const near = (p: [number, number], r = 7) => {
      const [x, y] = toScreen(...p);
      return Math.hypot(x - e.sx, y - e.sy) <= r;
    };
    if (near(t.ref, 6)) return { kind: "ref" };
    const cs = corners(t.quad);
    for (let i = 0; i < 4; i++) if (near(cs[i])) return { kind: "corner", i };
    const ms = mids(t.quad);
    for (let i = 0; i < 4; i++) if (near(ms[i])) return { kind: "edge", i };
    if (insideQuad(t.quad, e.x, e.y)) return t.mode === "rotate" ? { kind: "rotate" } : { kind: "move" };
    return { kind: "rotate" };
  };

  let drag: { hit: Hit; start: Quad; sx: number; sy: number; ref: [number, number]; ctrl: boolean; alt: boolean; shift: boolean } | null = null;

  /** Express v in the basis (u, w); returns [a, b] with v = a*u + b*w. */
  const inBasis = (v: [number, number], u: [number, number], w: [number, number]): [number, number] => {
    const det = u[0] * w[1] - u[1] * w[0] || 1e-9;
    return [(v[0] * w[1] - v[1] * w[0]) / det, (u[0] * v[1] - u[1] * v[0]) / det];
  };

  const update = (e: ToolEvent) => {
    const t = st!;
    const d = drag!;
    const q0 = d.start;
    const P = corners(q0);
    const mode = t.mode;
    const h = d.hit;
    const dx = e.x - d.sx, dy = e.y - d.sy;
    const set = (pts: [number, number][]) => {
      const nq = pts.flat() as Quad;
      if (quadOk(nq)) t.quad = nq;
    };
    if (h.kind === "ref") {
      t.ref = [d.ref[0] + dx, d.ref[1] + dy];
      return;
    }
    if (h.kind === "move") {
      let mx = dx, my = dy;
      if (e.shift) Math.abs(dx) > Math.abs(dy) ? (my = 0) : (mx = 0);
      set(P.map(([x, y]) => [x + mx, y + my]));
      t.ref = [d.ref[0] + mx, d.ref[1] + my];
      return;
    }
    if (h.kind === "rotate" || (mode === "rotate" && h.kind !== "edge")) {
      const [rx, ry] = d.ref;
      let a = Math.atan2(e.y - ry, e.x - rx) - Math.atan2(d.sy - ry, d.sx - rx);
      if (e.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      const c = Math.cos(a), s = Math.sin(a);
      set(P.map(([x, y]) => [rx + (x - rx) * c - (y - ry) * s, ry + (x - rx) * s + (y - ry) * c]));
      return;
    }
    const ctrl = e.ctrl;
    if (h.kind === "corner") {
      const i = h.i;
      const perspective = mode === "perspective" || (ctrl && e.alt && e.shift);
      const distort = mode === "distort" || (ctrl && !perspective);
      if (perspective) {
        // Move this corner and its partner on the same edge in opposite directions.
        const horiz = Math.abs(dx) >= Math.abs(dy);
        const partner = horiz ? [1, 0, 3, 2][i] : [3, 2, 1, 0][i];
        const along = horiz ? [P[1][0] - P[0][0], P[1][1] - P[0][1]] : [P[3][0] - P[0][0], P[3][1] - P[0][1]];
        const len = Math.hypot(along[0], along[1]) || 1;
        const ux = along[0] / len, uy = along[1] / len;
        const amt = dx * ux + dy * uy;
        const pts = P.map((p) => [...p] as [number, number]);
        pts[i] = [P[i][0] + ux * amt, P[i][1] + uy * amt];
        pts[partner] = [P[partner][0] - ux * amt, P[partner][1] - uy * amt];
        set(pts);
        return;
      }
      if (distort || mode === "skew") {
        const pts = P.map((p) => [...p] as [number, number]);
        pts[i] = [P[i][0] + dx, P[i][1] + dy];
        set(pts);
        return;
      }
    }
    if (h.kind === "edge" && (ctrl || mode === "skew" || mode === "distort" || mode === "perspective")) {
      // Skew: slide this side along its own direction.
      const a = h.i, b = (h.i + 1) % 4;
      const ex = P[b][0] - P[a][0], ey = P[b][1] - P[a][1];
      const len = Math.hypot(ex, ey) || 1;
      const amt = (dx * ex + dy * ey) / len;
      const pts = P.map((p) => [...p] as [number, number]);
      pts[a] = [P[a][0] + (ex / len) * amt, P[a][1] + (ey / len) * amt];
      pts[b] = [P[b][0] + (ex / len) * amt, P[b][1] + (ey / len) * amt];
      set(pts);
      return;
    }
    // Scale, in the box's own (possibly rotated or skewed) frame.
    const u: [number, number] = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
    const w: [number, number] = [P[3][0] - P[0][0], P[3][1] - P[0][1]];
    // Which sides move: corners move two, edges one.
    const movesX = h.kind === "corner" ? (h.i === 1 || h.i === 2 ? 1 : -1) : h.kind === "edge" ? (h.i === 1 ? 1 : h.i === 3 ? -1 : 0) : 0;
    const movesY = h.kind === "corner" ? (h.i >= 2 ? 1 : -1) : h.kind === "edge" ? (h.i === 2 ? 1 : h.i === 0 ? -1 : 0) : 0;
    const [du, dw] = inBasis([dx, dy], u, w);
    const fromCenter = e.alt;
    // Scale factors along u and w (1 = unchanged).
    let su = 1 + (movesX * du) * (fromCenter ? 2 : 1);
    let sw = 1 + (movesY * dw) * (fromCenter ? 2 : 1);
    if (!movesX) su = 1;
    if (!movesY) sw = 1;
    // Corners keep proportions by default (Preferences); Shift does the opposite.
    const proportional = app.prefs.transformProportional !== e.shift;
    if (proportional && h.kind === "corner") {
      const m = Math.abs(su) > Math.abs(sw) ? su : sw;
      su = Math.sign(su || 1) * Math.abs(m);
      sw = Math.sign(sw || 1) * Math.abs(m);
    } else if (e.shift && h.kind === "edge") {
      // Shift on a side scales proportionally too.
      const m = movesX ? su : sw;
      su = sw = m;
    }
    // The fixed point: the opposite corner/side, or the center.
    const c0 = center(q0);
    const anchor: [number, number] = fromCenter
      ? c0
      : [
          P[0][0] + u[0] * (movesX > 0 ? 0 : movesX < 0 ? 1 : 0.5) + w[0] * (movesY > 0 ? 0 : movesY < 0 ? 1 : 0.5),
          P[0][1] + u[1] * (movesX > 0 ? 0 : movesX < 0 ? 1 : 0.5) + w[1] * (movesY > 0 ? 0 : movesY < 0 ? 1 : 0.5),
        ];
    set(
      P.map(([x, y]) => {
        const [a, b] = inBasis([x - anchor[0], y - anchor[1]], u, w);
        const na = a * su, nb = b * sw;
        return [anchor[0] + na * u[0] + nb * w[0], anchor[1] + na * u[1] + nb * w[1]];
      }),
    );
    if (!drag?.hit || drag.hit.kind !== "ref") t.ref = center(t.quad);
  };

  const cursorFor = (h: Hit, e: ToolEvent): string => {
    if (h.kind === "move") return "move";
    if (h.kind === "ref") return "crosshair";
    if (h.kind === "rotate") return "alias";
    if (e.ctrl) return "default";
    return h.kind === "corner" ? (h.i % 2 ? "nesw-resize" : "nwse-resize") : h.i % 2 ? "ew-resize" : "ns-resize";
  };

  const tool: Tool = {
    id: "transform",
    label: "Free Transform",
    shortcut: "",
    icon: "move",
    cursor: "default",
    get hint() {
      return `Drag handles to scale (Shift: ${app.prefs.transformProportional ? "free" : "keep proportions"}, Alt: from center); drag outside to rotate; Ctrl-drag a corner to distort, a side to skew. Enter applies, Esc cancels.`;
    },
    hover(e) {
      if (!st) return;
      app.viewport.style.cursor = cursorFor(hit(e), e);
    },
    down(e) {
      const t = st;
      if (!t) return;
      if (app.active !== t.session) return;
      t.history.push(t.quad);
      drag = { hit: hit(e), start: [...t.quad] as Quad, sx: e.x, sy: e.y, ref: [...t.ref] as [number, number], ctrl: e.ctrl, alt: e.alt, shift: e.shift };
    },
    move(e) {
      if (!drag || !st) return;
      update(e);
      changed(app);
    },
    up() {
      drag = null;
      changed(app);
    },
    dblclick(e) {
      if (st && insideQuad(st.quad, e.x, e.y)) commitTransform(app);
    },
    onKey(e) {
      if (!st || e.type !== "keydown") return false;
      if (e.key === "Enter") commitTransform(app);
      else if (e.key === "Escape") cancelTransform(app);
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        const prev = st.history.pop();
        if (prev) {
          st.quad = prev;
          st.ref = center(prev);
          changed(app);
        }
      } else if (e.key.startsWith("Arrow")) {
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0, dy = e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0;
        st.history.push(st.quad);
        st.quad = st.quad.map((v, i) => v + (i % 2 ? dy : dx)) as Quad;
        st.ref = [st.ref[0] + dx, st.ref[1] + dy];
        changed(app);
      } else return false;
      return true;
    },
    deactivate() {
      // Switching tools (or windows) applies the transform, as in PS.
      if (st) commitTransform(app);
    },
  };
  return tool;
}

// ------------------------------------------------------------------ options bar

type Part = { node: HTMLElement; sync(): void };

/** Numbers for the current shape when it is a plain scale/rotate of the rect. */
function affineParams(t: TState) {
  const q = t.quad, r = t.rect;
  const ux = q[2] - q[0], uy = q[3] - q[1], wx = q[6] - q[0], wy = q[7] - q[1];
  return { cx: center(q)[0], cy: center(q)[1], sw: (Math.hypot(ux, uy) / r.w) * 100, sh: (Math.hypot(wx, wy) / r.h) * 100, angle: (Math.atan2(uy, ux) * 180) / Math.PI };
}

export function transformOptionParts(app: App): Part[] {
  const fields: Record<"cx" | "cy" | "sw" | "sh" | "angle", HTMLInputElement> = {
    cx: el("input", { type: "number", step: "any", "aria-label": "X" }),
    cy: el("input", { type: "number", step: "any", "aria-label": "Y" }),
    sw: el("input", { type: "number", step: "any", "aria-label": "Width percent" }),
    sh: el("input", { type: "number", step: "any", "aria-label": "Height percent" }),
    angle: el("input", { type: "number", step: "any", "aria-label": "Angle" }),
  };
  const link = el("input", { type: "checkbox", title: "Keep proportions", checked: app.prefs.transformProportional });
  const apply = (changedKey: keyof typeof fields) => {
    const t = st;
    if (!t) return;
    const p = affineParams(t);
    const v = (k: keyof typeof fields) => (Number.isFinite(+fields[k].value) ? +fields[k].value : p[k]);
    let sw = v("sw"), sh = v("sh");
    if (link.checked) {
      if (changedKey === "sw") sh = sw;
      if (changedKey === "sh") sw = sh;
    }
    const cx = v("cx"), cy = v("cy"), a = (v("angle") * Math.PI) / 180;
    const hw = (t.rect.w * sw) / 200, hh = (t.rect.h * sh) / 200;
    const c = Math.cos(a), s = Math.sin(a);
    const pt = (x: number, y: number) => [cx + x * c - y * s, cy + x * s + y * c];
    const nq = [...pt(-hw, -hh), ...pt(hw, -hh), ...pt(hw, hh), ...pt(-hw, hh)] as Quad;
    if (!quadOk(nq)) return;
    t.history.push(t.quad);
    t.quad = nq;
    t.ref = [cx, cy];
    changed(app);
  };
  for (const k of Object.keys(fields) as (keyof typeof fields)[]) fields[k].addEventListener("change", () => apply(k));
  const method = el("select", { "aria-label": "Interpolation" });
  for (const [v, l] of [["bicubic", "Bicubic"], ["bilinear", "Bilinear"], ["nearest", "Nearest Neighbor"]]) method.append(el("option", { value: v, text: l }));
  method.value = transformMethod(app);
  method.addEventListener("change", () => storage.save("transformMethod", method.value));
  const ok = el("button", { type: "button", class: "btn small", text: "✓ Apply", title: "Apply the transform (Enter)" });
  const cancel = el("button", { type: "button", class: "btn small", text: "✕ Cancel", title: "Cancel (Esc)" });
  ok.addEventListener("click", () => commitTransform(app));
  cancel.addEventListener("click", () => cancelTransform(app));
  const num = (label: string, input: HTMLInputElement, suffix = "") => el("label", { class: "tf-num" }, label, input, suffix);
  const parts: Part[] = [
    {
      node: el("span", { class: "tf-fields" }, num("X:", fields.cx, "px"), num("Y:", fields.cy, "px"), num("W:", fields.sw, "%"), el("label", { class: "tf-link", title: "Keep proportions" }, link, "🔗"), num("H:", fields.sh, "%"), num("∠", fields.angle, "°")),
      sync: () => {
        const t = st;
        if (!t) return;
        const p = affineParams(t);
        const fmt = (n: number, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d);
        for (const k of Object.keys(fields) as (keyof typeof fields)[]) if (document.activeElement !== fields[k]) fields[k].value = fmt(p[k], k === "cx" || k === "cy" ? 0 : 1);
      },
    },
    { node: el("label", {}, "Interpolation:", method), sync: () => {} },
    { node: el("span", { class: "tf-btns" }, ok, cancel), sync: () => {} },
  ];
  const sync = () => parts.forEach((p) => p.sync());
  listeners.clear();
  listeners.add(sync);
  return parts;
}
