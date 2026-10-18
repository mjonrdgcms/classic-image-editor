/**
 * Layer Styles: Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel
 * and Emboss, Color Overlay and Stroke.
 *
 * Effects are computed from the layer's shape (its pixels' alpha, with the
 * layer mask applied) and cached until the layer, its mask or its style
 * changes. Each effect becomes a pixel grid that the compositors (CPU and
 * GPU alike) blend in with the effect's blend mode and opacity: shadows and
 * glows outside the layer below it, everything else above it.
 */

import type { BlendMode } from "./blend";
import { signedDistance } from "./edt";
import { gauss1 } from "../filters/img";
import type { Layer } from "./document";
import type { Mask } from "./mask";
import { Rect, TILE, Tile, TileGrid, rectIntersect, rectUnion } from "./tiles";

type RGB = [number, number, number];

export interface ShadowFx {
  enabled: boolean;
  blendMode: BlendMode;
  color: RGB;
  /** 0..100 */
  opacity: number;
  /** Light angle in degrees (PS: 120 = from the upper left). */
  angle: number;
  distance: number;
  /** Spread (drop) or Choke (inner), 0..100. */
  spread: number;
  size: number;
}

export interface GlowFx {
  enabled: boolean;
  blendMode: BlendMode;
  color: RGB;
  opacity: number;
  /** Spread (outer) or Choke (inner), 0..100. */
  spread: number;
  size: number;
  /** Inner glow: from the edge or the center. */
  source?: "edge" | "center";
}

export interface BevelFx {
  enabled: boolean;
  style: "inner" | "outer" | "emboss" | "pillow";
  /** 1..1000 (percent). */
  depth: number;
  direction: "up" | "down";
  size: number;
  soften: number;
  angle: number;
  altitude: number;
  highlightMode: BlendMode;
  highlightColor: RGB;
  highlightOpacity: number;
  shadowMode: BlendMode;
  shadowColor: RGB;
  shadowOpacity: number;
}

export interface OverlayFx {
  enabled: boolean;
  blendMode: BlendMode;
  color: RGB;
  opacity: number;
}

export interface StrokeFx {
  enabled: boolean;
  size: number;
  position: "outside" | "inside" | "center";
  blendMode: BlendMode;
  color: RGB;
  opacity: number;
}

export interface LayerStyle {
  dropShadow?: ShadowFx;
  innerShadow?: ShadowFx;
  outerGlow?: GlowFx;
  innerGlow?: GlowFx;
  bevel?: BevelFx;
  colorOverlay?: OverlayFx;
  stroke?: StrokeFx;
}

export const FX_KEYS = ["dropShadow", "innerShadow", "outerGlow", "innerGlow", "bevel", "colorOverlay", "stroke"] as const;
export type FxKey = (typeof FX_KEYS)[number];

export const FX_LABELS: Record<FxKey, string> = {
  dropShadow: "Drop Shadow",
  innerShadow: "Inner Shadow",
  outerGlow: "Outer Glow",
  innerGlow: "Inner Glow",
  bevel: "Bevel and Emboss",
  colorOverlay: "Color Overlay",
  stroke: "Stroke",
};

/** PS7's defaults for each effect. */
export const FX_DEFAULTS: { [K in FxKey]-?: NonNullable<LayerStyle[K]> } = {
  dropShadow: { enabled: true, blendMode: "multiply", color: [0, 0, 0], opacity: 75, angle: 120, distance: 5, spread: 0, size: 5 },
  innerShadow: { enabled: true, blendMode: "multiply", color: [0, 0, 0], opacity: 75, angle: 120, distance: 5, spread: 0, size: 5 },
  outerGlow: { enabled: true, blendMode: "screen", color: [255, 255, 190], opacity: 75, spread: 0, size: 5 },
  innerGlow: { enabled: true, blendMode: "screen", color: [255, 255, 190], opacity: 75, spread: 0, size: 5, source: "edge" },
  bevel: {
    enabled: true,
    style: "inner",
    depth: 100,
    direction: "up",
    size: 5,
    soften: 0,
    angle: 120,
    altitude: 30,
    highlightMode: "screen",
    highlightColor: [255, 255, 255],
    highlightOpacity: 75,
    shadowMode: "multiply",
    shadowColor: [0, 0, 0],
    shadowOpacity: 75,
  },
  colorOverlay: { enabled: true, blendMode: "normal", color: [255, 0, 0], opacity: 100 },
  stroke: { enabled: true, size: 3, position: "outside", blendMode: "normal", color: [255, 0, 0], opacity: 100 },
};

/** Something the compositors can draw like a layer. */
export interface FxLayer {
  grid: TileGrid;
  offsetX: number;
  offsetY: number;
  readonly activeMask: Mask | null;
  blendMode: BlendMode;
  /** 0..1 */
  opacity: number;
}

export interface LayerEffects {
  below: FxLayer[];
  above: FxLayer[];
  /** Canvas area the effects can touch. */
  bounds: Rect;
}

export function hasEffects(s: LayerStyle | null | undefined): boolean {
  return !!s && FX_KEYS.some((k) => s[k]?.enabled);
}

/** Longest shadow offset honored (keeps the work and memory bounded). */
export const MAX_DISTANCE = 1000;

/**
 * The canvas area the effects need: the layer's content (by tiles) grown by
 * the reach of glows, strokes and bevels, plus the drop shadow's offset copy.
 */
function fxRegion(l: Layer, s: LayerStyle): Rect | null {
  const g = l.grid;
  let c: Rect | null = null;
  for (let i = 0; i < g.tiles.length; i++)
    if (g.tiles[i]) c = rectUnion(c, { x: (i % g.cols) * TILE, y: ((i / g.cols) | 0) * TILE, w: TILE, h: TILE });
  if (!c) return null;
  c = rectIntersect(c, { x: 0, y: 0, w: g.width, h: g.height })!;
  c = { x: c.x + l.offsetX, y: c.y + l.offsetY, w: c.w, h: c.h };
  const grow = (r: Rect, n: number): Rect => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 });
  let around = 2;
  if (s.outerGlow?.enabled) around = Math.max(around, s.outerGlow.size * 1.2 + 2);
  if (s.stroke?.enabled && s.stroke.position !== "inside") around = Math.max(around, s.stroke.size + 2);
  if (s.bevel?.enabled && s.bevel.style !== "inner") around = Math.max(around, s.bevel.size * 1.2 + 2);
  // Blurs need a margin of their own so nothing is cut at the region's edge.
  let r = grow(c, Math.ceil(around));
  const ds = s.dropShadow;
  if (ds?.enabled) {
    const [dx, dy] = lightOffset(ds.angle, Math.min(MAX_DISTANCE, ds.distance));
    const sh = grow({ x: c.x + Math.round(dx), y: c.y + Math.round(dy), w: c.w, h: c.h }, Math.ceil(ds.size * 1.2 + 2));
    r = rectUnion(r, sh)!;
  }
  return r;
}

// ------------------------------------------------------------------ cache

const tileIds = new WeakMap<object, number>();
let nextTileId = 1;
const idOf = (t: object) => {
  let v = tileIds.get(t);
  if (!v) tileIds.set(t, (v = nextTileId++));
  return v;
};

function keyOf(l: Layer): string {
  let h = 0;
  for (const t of l.grid.tiles) h = (Math.imul(h, 31) + (t ? idOf(t) * 7919 + t.version : 1)) | 0;
  const m = l.activeMask;
  if (m) for (const t of m.tiles) h = (Math.imul(h, 31) + (t ? idOf(t) * 7919 + t.version : 3 + m.defaultValue)) | 0;
  return `${h}|${m ? idOf(m) : 0}|${l.offsetX},${l.offsetY}|${l.grid.width}x${l.grid.height}|${idOf(l.style as object)}`;
}

/**
 * Computed effects, by style. Styles are never mutated (a change makes a new
 * object) and survive undo, which rebuilds Layer objects, so they make a
 * better cache key than the layer; the key string covers the pixels.
 */
const cache = new WeakMap<LayerStyle, { key: string; fx: LayerEffects | null }[]>();

/** The layer's effects, computed (or taken from the cache). Null when it has none. */
export function layerEffects(l: Layer): LayerEffects | null {
  const s = l.style;
  if (!s || !hasEffects(s)) return null;
  const key = keyOf(l);
  let list = cache.get(s);
  const hit = list?.find((e) => e.key === key);
  if (hit) return hit.fx;
  let fx: LayerEffects | null;
  try {
    fx = computeEffects(l, s);
  } catch (e) {
    // Out of memory on a huge layer: draw it without effects rather than not at all.
    console.warn("layer effects failed", e);
    fx = null;
  }
  if (!list) cache.set(s, (list = []));
  list.unshift({ key, fx });
  // A few layers can share one style (duplicates); keep the most recent results.
  list.length = Math.min(list.length, 4);
  return fx;
}

// ------------------------------------------------------------------ rendering

const blur = (a: Float32Array, w: number, h: number, size: number) => (size > 0.5 ? gauss1(a, w, h, size / 2.6) : a.slice());

function shift(a: Float32Array, w: number, h: number, dx: number, dy: number, fill: number): Float32Array {
  const out = new Float32Array(w * h).fill(fill);
  const ix = Math.round(dx), iy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - iy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ix;
      if (sx >= 0 && sx < w) out[y * w + x] = a[sy * w + sx];
    }
  }
  return out;
}

/** Spread / choke: harden a blurred edge so it reaches further at full strength. */
function spread(v: Float32Array, amount: number): Float32Array {
  if (amount <= 0) return v;
  const k = 1 / Math.max(0.02, 1 - amount / 100);
  for (let i = 0; i < v.length; i++) v[i] = Math.min(1, v[i] * k);
  return v;
}

function toGrid(alpha: Float32Array, color: RGB | null, colorOf: ((i: number) => RGB) | null, w: number, h: number): TileGrid {
  const g = new TileGrid(w, h);
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i];
    if (a <= 0.002) continue;
    const c = colorOf ? colorOf(i) : color!;
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  g.writeRegion({ x: 0, y: 0, w, h }, px);
  return g;
}

function fxLayer(grid: TileGrid, r: Rect, blendMode: BlendMode, opacity: number): FxLayer {
  return { grid, offsetX: r.x, offsetY: r.y, activeMask: null, blendMode, opacity: Math.max(0, Math.min(1, opacity / 100)) };
}

/** Light direction for an angle (degrees; 120 = from the upper left). Screen y points down. */
const lightOffset = (angle: number, distance: number): [number, number] => {
  const a = (angle * Math.PI) / 180;
  return [-Math.cos(a) * distance, Math.sin(a) * distance];
};

function computeEffects(l: Layer, s: LayerStyle): LayerEffects | null {
  const r = fxRegion(l, s);
  if (!r) return null;
  const { w, h } = r;
  // The layer's shape (alpha with its mask) over the region.
  const lr = { x: r.x - l.offsetX, y: r.y - l.offsetY, w, h };
  const px = l.grid.readRegion(lr);
  const m = l.activeMask;
  const mv = m ? m.readRegion(lr, m.defaultValue) : null;
  const a = new Float32Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    a[i] = (px[i * 4 + 3] / 255) * (mv ? mv[i] / 255 : 1);
    if (a[i] > 0) any = true;
  }
  if (!any) return { below: [], above: [], bounds: r };
  const below: FxLayer[] = [], above: FxLayer[] = [], bevelTop: FxLayer[] = [];

  const ds = s.dropShadow;
  if (ds?.enabled) {
    const [dx, dy] = lightOffset(ds.angle, Math.min(MAX_DISTANCE, ds.distance));
    const v = spread(blur(shift(a, w, h, dx, dy, 0), w, h, ds.size), ds.spread);
    below.push(fxLayer(toGrid(v, ds.color, null, w, h), r, ds.blendMode, ds.opacity));
  }
  const og = s.outerGlow;
  if (og?.enabled) {
    const v = spread(blur(a, w, h, og.size), og.spread);
    // Only outside the shape matters, but PS lets it show through soft edges too.
    below.push(fxLayer(toGrid(v, og.color, null, w, h), r, og.blendMode, og.opacity));
  }
  const bv = s.bevel;
  if (bv?.enabled) {
    const outer = bv.style === "outer", emboss = bv.style === "emboss", pillow = bv.style === "pillow";
    // Height: the shape, blurred by Size; outer bevels raise the surroundings toward the edge.
    let hgt = blur(a, w, h, bv.size);
    if (bv.soften > 0) hgt = blur(hgt, w, h, bv.soften);
    const depth = (bv.depth / 100) * (bv.direction === "down" ? -1 : 1) * (pillow ? -1 : 1);
    const [lx, ly] = lightOffset(bv.angle, 1);
    const alt = (Math.max(0, Math.min(90, bv.altitude)) * Math.PI) / 180;
    const Lx = -lx * Math.cos(alt), Ly = -ly * Math.cos(alt), Lz = Math.sin(alt);
    const hi = new Float32Array(w * h), sh = new Float32Array(w * h);
    const k = Math.max(1, bv.size) * 1.6 * depth;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = (hgt[i + 1] - hgt[i - 1]) * 0.5 * k, gy = (hgt[i + w] - hgt[i - w]) * 0.5 * k;
        const nl = Math.hypot(gx, gy, 1);
        const d = (-gx * Lx - gy * Ly + Lz) / nl - Lz;
        // Where the effect shows: inside (inner), outside (outer), or both.
        const where = outer ? 1 - a[i] : emboss ? 1 : pillow ? 1 : a[i];
        if (d > 0) hi[i] = Math.min(1, d * 2.2) * where;
        else sh[i] = Math.min(1, -d * 2.2) * where;
      }
    const pair = [fxLayer(toGrid(sh, bv.shadowColor, null, w, h), r, bv.shadowMode, bv.shadowOpacity), fxLayer(toGrid(hi, bv.highlightColor, null, w, h), r, bv.highlightMode, bv.highlightOpacity)];
    // Bevels light everything else, so they go on top (outer bevels sit outside, below the layer).
    if (outer) below.push(...pair);
    else bevelTop.push(...pair);
  }
  const co = s.colorOverlay;
  if (co?.enabled) above.push(fxLayer(toGrid(a, co.color, null, w, h), r, co.blendMode, co.opacity));
  const ig = s.innerGlow;
  if (ig?.enabled) {
    const inv = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = 1 - a[i];
    let v = spread(blur(inv, w, h, ig.size), ig.spread);
    if (ig.source === "center") v = v.map((x) => 1 - Math.min(1, x));
    for (let i = 0; i < w * h; i++) v[i] *= a[i];
    above.push(fxLayer(toGrid(v, ig.color, null, w, h), r, ig.blendMode, ig.opacity));
  }
  const ins = s.innerShadow;
  if (ins?.enabled) {
    const [dx, dy] = lightOffset(ins.angle, Math.min(MAX_DISTANCE, ins.distance));
    const inv = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) inv[i] = 1 - a[i];
    const v = spread(blur(shift(inv, w, h, dx, dy, 1), w, h, ins.size), ins.spread);
    for (let i = 0; i < w * h; i++) v[i] *= a[i];
    above.push(fxLayer(toGrid(v, ins.color, null, w, h), r, ins.blendMode, ins.opacity));
  }
  const st = s.stroke;
  if (st?.enabled && st.size > 0) {
    const m8 = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m8[i] = Math.round(a[i] * 255);
    const sd = signedDistance(m8, w, h);
    const [lo, hi] = st.position === "inside" ? [0, st.size] : st.position === "outside" ? [-st.size, 0] : [-st.size / 2, st.size / 2];
    const v = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) v[i] = Math.max(0, Math.min(1, Math.min(sd[i] - lo, hi - sd[i]) + 0.5));
    // An outside stroke fills right up to the layer's soft edge.
    if (st.position === "outside") for (let i = 0; i < w * h; i++) if (sd[i] > -0.5 && sd[i] < 0.5) v[i] = Math.max(v[i], 1 - a[i]);
    above.push(fxLayer(toGrid(v, st.color, null, w, h), r, st.blendMode, st.opacity));
  }
  above.push(...bevelTop);
  for (const f of [...below, ...above]) f.grid.compact();
  return { below, above, bounds: r };
}

/** Every tile the effects use (so GPU textures for them are kept). */
export function effectTiles(fx: LayerEffects): Tile[] {
  const out: Tile[] = [];
  for (const f of [...fx.below, ...fx.above]) for (const t of f.grid.tiles) if (t) out.push(t);
  return out;
}

/** A deep copy of a style with every effect present filled in from the defaults. */
export function normalizeStyle(s: LayerStyle | null | undefined): LayerStyle | null {
  if (!s) return null;
  const out: LayerStyle = {};
  for (const k of FX_KEYS) {
    const v = s[k];
    if (v) (out as Record<string, unknown>)[k] = JSON.parse(JSON.stringify({ ...FX_DEFAULTS[k], ...v }));
  }
  return Object.keys(out).length ? out : null;
}
