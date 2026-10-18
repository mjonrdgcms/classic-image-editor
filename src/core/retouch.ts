/**
 * The retouching tools' stroke engine: Clone Stamp, Healing Brush, Spot
 * Healing Brush, History Brush, Dodge, Burn, Sponge, Blur, Sharpen and
 * Smudge.
 *
 * Round dabs are laid along the path like the Brush. Each stroke keeps a
 * coverage map (how much the brush has passed over each pixel) and a copy
 * of the layer as it was when the stroke began; every touched pixel is
 * recomputed from the original and its coverage, so going over the same
 * spot again within a stroke builds up smoothly instead of compounding.
 * Smudge is the exception: it drags paint along, so it works on the live
 * pixels dab after dab.
 *
 * The Healing and Spot Healing brushes finish when the stroke ends: the
 * Healing Brush blends the cloned texture into the light and color around
 * it, and the Spot Healing Brush fills what you painted over from its
 * surroundings (see inpaint.ts).
 */

import type { Document, Layer } from "./document";
import { healBlend, inpaint } from "./inpaint";
import { resampleGray, resampleRGBA } from "./resample";
import { Rect, TILE, TILE_PX, TileGrid, rectIntersect, rectUnion } from "./tiles";

/** Most pixels the Spot Healing Brush fills at full size. */
const SPOT_MAX = 40_000;

export type RetouchTool =
  | "clone"
  | "heal"
  | "spotHeal"
  | "history"
  | "dodge"
  | "burn"
  | "sponge"
  | "blur"
  | "sharpen"
  | "smudge"
  | "pattern"
  | "bgErase"
  | "colorReplace"
  | "artHistory";
export const RETOUCH_TOOLS: RetouchTool[] = ["clone", "heal", "spotHeal", "history", "dodge", "burn", "sponge", "blur", "sharpen", "smudge", "pattern", "bgErase", "colorReplace", "artHistory"];
export const ART_STYLES = ["tightShort", "tightMedium", "tightLong", "looseMedium", "looseLong", "dab", "tightCurl", "looseCurl"] as const;
export type ArtStyle = (typeof ART_STYLES)[number];

/** A pattern image (straight RGBA), tiled from the canvas origin. */
export interface PatternImage {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}
export type ToneRange = "shadows" | "midtones" | "highlights";

export interface RetouchOptions {
  tool: RetouchTool;
  /** Brush diameter in pixels. */
  size: number;
  /** 0..100 */
  hardness: number;
  /**
   * 0..1. Opacity for Clone/Heal/History, exposure for Dodge/Burn, flow for
   * Sponge, strength for Blur/Sharpen/Smudge.
   */
  strength: number;
  /** Where Clone and Heal copy from, relative to where you paint (canvas pixels). */
  offset?: [number, number];
  /** Clone and Heal: copy from the merged image instead of the layer. */
  sampleAll?: boolean;
  /** History Brush: the layer as it was, and where it sat on the canvas. */
  historySource?: { grid: TileGrid; offsetX: number; offsetY: number } | null;
  range?: ToneRange;
  sponge?: "saturate" | "desaturate";
  seed?: number;
  /** Pattern Stamp: what to paint. */
  pattern?: PatternImage | null;
  /** Background Eraser / Color Replacement: how close a color must be (0..100). */
  tolerance?: number;
  /** Which color to act on: sampled once at the start, continuously under the brush, or the background color. */
  sampling?: "once" | "continuous" | "background";
  /** Only pixels connected to the brush center, or any under the brush. */
  limits?: "contiguous" | "discontiguous";
  /** Background Eraser: never erase the foreground color. */
  protectFg?: boolean;
  fg?: [number, number, number];
  bg?: [number, number, number];
  /** Color Replacement: what to take from the foreground color. */
  replaceMode?: "hue" | "saturation" | "color" | "luminosity";
  /** Art History Brush. */
  artStyle?: ArtStyle;
  artArea?: number;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export class RetouchStroke {
  private cov = new Map<number, Float32Array>();
  private orig: TileGrid;
  private last: { x: number; y: number } | null = null;
  private residual = 0;
  private srcCache = new Map<number, Uint8ClampedArray>();
  private smudgePatch: Float32Array | null = null;
  private smudgeSize = 0;
  private ox: number;
  private oy: number;
  bounds: Rect | null = null;
  readonly points: [number, number, number][] = [];

  constructor(
    private doc: Document,
    private layer: Layer,
    private o: RetouchOptions,
  ) {
    layer.grid.freeze();
    this.orig = layer.grid.share();
    this.ox = layer.offsetX;
    this.oy = layer.offsetY;
    if ((o.tool === "clone" || o.tool === "heal") && !o.offset) throw new Error("no clone source");
    if ((o.tool === "history" || o.tool === "artHistory") && !o.historySource) throw new Error("no history source");
    if (o.tool === "pattern" && !o.pattern) throw new Error("no pattern");
    this.rnd = mulberry32(o.seed ?? 1);
  }

  private rnd: () => number;
  /** Background Eraser / Color Replacement: the color sampled at the start. */
  private sampled: [number, number, number] | null = null;

  private get spacing(): number {
    const t = this.o.tool;
    if (t === "artHistory") return Math.max(4, (this.o.artArea ?? 50) * 0.35);
    return Math.max(1, this.o.size * (t === "smudge" ? 0.1 : t === "spotHeal" || t === "heal" ? 0.15 : 0.25));
  }

  /** Add a point in canvas coordinates. Returns the canvas rect changed. */
  addPoint(x: number, y: number, pressure = 1): Rect | null {
    this.points.push([x, y, pressure]);
    let dirty: Rect | null = null;
    if (!this.last) {
      dirty = this.dab(x, y);
      this.residual = 0;
    } else {
      const L = this.last;
      const dist = Math.hypot(x - L.x, y - L.y);
      if (dist > 0) {
        const step = this.spacing;
        let t = step - this.residual;
        while (t <= dist) {
          const f = t / dist;
          dirty = rectUnion(dirty, this.dab(L.x + (x - L.x) * f, L.y + (y - L.y) * f));
          t += step;
        }
        this.residual = dist - (t - step);
      }
    }
    this.last = { x, y };
    if (dirty) {
      this.bounds = rectUnion(this.bounds, dirty);
      this.doc.dirty(dirty);
    }
    return dirty;
  }

  /** Finish (Healing and Spot Healing do their work here). Returns the canvas rect changed. */
  end(): Rect | null {
    let r: Rect | null = null;
    if (this.o.tool === "heal") r = this.finishHeal();
    else if (this.o.tool === "spotHeal") r = this.finishSpot();
    this.layer.grid.compact();
    if (r) {
      this.bounds = rectUnion(this.bounds, r);
      this.doc.dirty(r);
    }
    return this.bounds;
  }

  // ------------------------------------------------------------------ dabs

  private tipAt(): (d: number) => number {
    const half = this.o.size / 2;
    const hard = Math.min(1, Math.max(0, this.o.hardness / 100));
    const inner = half * hard, soft = half - inner;
    return (d: number) => {
      if (soft < 1) return Math.min(1, Math.max(0, half + 0.5 - d));
      if (d <= inner) return 1;
      if (d >= half) return 0;
      return 0.5 * (1 + Math.cos((Math.PI * (d - inner)) / soft));
    };
  }

  private dab(cx: number, cy: number): Rect | null {
    const G = this.layer.grid;
    const lx = cx - this.ox, ly = cy - this.oy;
    const reach = this.o.size / 2 + 1.5;
    const area = rectIntersect(
      { x: Math.floor(lx - reach), y: Math.floor(ly - reach), w: Math.ceil(2 * reach) + 1, h: Math.ceil(2 * reach) + 1 },
      { x: 0, y: 0, w: G.width, h: G.height },
    );
    if (!area) return null;
    if (this.o.tool === "smudge") {
      this.smudgeDab(lx, ly, area);
      return { x: area.x + this.ox, y: area.y + this.oy, w: area.w, h: area.h };
    }
    if (this.o.tool === "bgErase" || this.o.tool === "colorReplace") {
      this.matchDab(lx, ly, area);
      return { x: area.x + this.ox, y: area.y + this.oy, w: area.w, h: area.h };
    }
    if (this.o.tool === "artHistory") {
      const r = this.artDab(lx, ly);
      return r && { x: r.x + this.ox, y: r.y + this.oy, w: r.w, h: r.h };
    }
    const tip = this.tipAt();
    const t = this.o.tool;
    // How much one dab adds: building tools (dodge, burn, sponge) build up gently.
    const flow = t === "dodge" || t === "burn" ? 0.35 : t === "sponge" ? 0.3 : t === "blur" || t === "sharpen" ? 0.5 : 1;
    const tx0 = (area.x / TILE) | 0, ty0 = (area.y / TILE) | 0;
    const tx1 = ((area.x + area.w - 1) / TILE) | 0, ty1 = ((area.y + area.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const sub = rectIntersect(area, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        const ti = ty * G.cols + tx;
        let c = this.cov.get(ti);
        if (!c) {
          c = new Float32Array(TILE_PX);
          this.cov.set(ti, c);
        }
        for (let y = sub.y; y < sub.y + sub.h; y++)
          for (let x = sub.x; x < sub.x + sub.w; x++) {
            const a = tip(Math.hypot(x + 0.5 - lx, y + 0.5 - ly)) * flow;
            if (a <= 0) continue;
            const i = (y - ty * TILE) * TILE + (x - tx * TILE);
            c[i] = c[i] + a * (1 - c[i]);
          }
        this.render(sub, ti, tx, ty);
      }
    return { x: area.x + this.ox, y: area.y + this.oy, w: area.w, h: area.h };
  }

  /** Selection coverage over a layer rect (null = everywhere). */
  private selCov(r: Rect): Uint8Array | null {
    const s = this.doc.selection;
    return s ? s.readRegion({ x: r.x + this.ox, y: r.y + this.oy, w: r.w, h: r.h }) : null;
  }

  /** Where Clone/Heal/History copy from, for a layer rect. */
  private source(r: Rect): Uint8ClampedArray {
    const o = this.o;
    if (o.tool === "pattern") {
      // The pattern repeats from the canvas origin, so strokes line up with each other.
      const pt = o.pattern!;
      const out = new Uint8ClampedArray(r.w * r.h * 4);
      for (let y = 0; y < r.h; y++) {
        const py = ((((y + r.y + this.oy) % pt.h) + pt.h) % pt.h) * pt.w;
        for (let x = 0; x < r.w; x++) {
          const px = (((x + r.x + this.ox) % pt.w) + pt.w) % pt.w;
          const si = (py + px) * 4, di = (y * r.w + x) * 4;
          out[di] = pt.data[si];
          out[di + 1] = pt.data[si + 1];
          out[di + 2] = pt.data[si + 2];
          out[di + 3] = pt.data[si + 3];
        }
      }
      return out;
    }
    if (o.tool === "history") {
      const h = o.historySource!;
      return h.grid.readRegion({ x: r.x + this.ox - h.offsetX, y: r.y + this.oy - h.offsetY, w: r.w, h: r.h });
    }
    const [dx, dy] = o.offset!;
    const sx = Math.round(r.x + dx), sy = Math.round(r.y + dy);
    if (!o.sampleAll) return this.orig.readRegion({ x: sx, y: sy, w: r.w, h: r.h });
    // The merged image, cached in canvas tiles as first seen.
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    const cx = sx + this.ox, cy = sy + this.oy;
    const D = { x: 0, y: 0, w: this.doc.width, h: this.doc.height };
    const want = rectIntersect(D, { x: cx, y: cy, w: r.w, h: r.h });
    if (!want) return out;
    const cols = Math.ceil(this.doc.width / TILE);
    const ty1 = ((want.y + want.h - 1) / TILE) | 0, tx1 = ((want.x + want.w - 1) / TILE) | 0;
    for (let ty = (want.y / TILE) | 0; ty <= ty1; ty++)
      for (let tx = (want.x / TILE) | 0; tx <= tx1; tx++) {
        const key = ty * cols + tx;
        const tr = rectIntersect(D, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        let px = this.srcCache.get(key);
        if (!px) {
          px = this.doc.composite(tr);
          this.srcCache.set(key, px);
        }
        const sub = rectIntersect(want, tr)!;
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          const s = ((y - tr.y) * tr.w + (sub.x - tr.x)) * 4;
          const d = ((y - cy) * r.w + (sub.x - cx)) * 4;
          out.set(px.subarray(s, s + sub.w * 4), d);
        }
      }
    return out;
  }

  /** Recompute a tile region from the original pixels and the coverage. */
  private render(sub: Rect, ti: number, tx: number, ty: number): void {
    const o = this.o, l = this.layer;
    const c = this.cov.get(ti)!;
    const orig = this.orig.readRegion(sub);
    const out = orig.slice();
    const sel = this.selCov(sub);
    const keepAlpha = l.locks.transparency;
    const n = sub.w * sub.h;
    const covAt = (k: number) => {
      const x = sub.x + (k % sub.w), y = sub.y + ((k / sub.w) | 0);
      let v = c[(y - ty * TILE) * TILE + (x - tx * TILE)];
      if (sel) v *= sel[k] / 255;
      return v;
    };
    switch (o.tool) {
      case "clone":
      case "heal":
      case "pattern":
      case "history": {
        const src = this.source(sub);
        for (let k = 0; k < n; k++) {
          const t = covAt(k) * (o.tool === "heal" ? 1 : o.strength);
          if (t <= 0) continue;
          mixInto(out, k * 4, orig, src, t);
        }
        break;
      }
      case "spotHeal": {
        // Show where you've painted; the fill happens when you let go.
        for (let k = 0; k < n; k++) {
          const t = covAt(k) * 0.55;
          if (t <= 0) continue;
          const p = k * 4;
          for (let ch = 0; ch < 3; ch++) out[p + ch] = orig[p + ch] + (40 - orig[p + ch]) * t;
          out[p + 3] = Math.max(orig[p + 3], t * 255);
        }
        break;
      }
      case "dodge":
      case "burn": {
        const range = o.range ?? "midtones";
        for (let k = 0; k < n; k++) {
          const t = covAt(k) * o.strength;
          if (t <= 0) continue;
          const p = k * 4;
          const lum = (orig[p] * 0.3 + orig[p + 1] * 0.59 + orig[p + 2] * 0.11) / 255;
          // Which tones are affected, and how strongly.
          const w = range === "shadows" ? (1 - lum) ** 2 : range === "highlights" ? lum ** 2 : 1 - (2 * lum - 1) ** 2 * 0.6;
          const s = t * w * 1.2;
          for (let ch = 0; ch < 3; ch++) {
            const v = orig[p + ch] / 255;
            out[p + ch] = clamp255(255 * (o.tool === "dodge" ? (range === "highlights" ? v + (1 - v) * s * 0.6 : v ** (1 / (1 + s))) : range === "shadows" ? v * (1 - s * 0.6) : v ** (1 + s)));
          }
        }
        break;
      }
      case "sponge": {
        const up = o.sponge !== "desaturate";
        for (let k = 0; k < n; k++) {
          const t = covAt(k) * o.strength;
          if (t <= 0) continue;
          const p = k * 4;
          const g = orig[p] * 0.3 + orig[p + 1] * 0.59 + orig[p + 2] * 0.11;
          const f = up ? 1 + t * 1.5 : 1 - t;
          for (let ch = 0; ch < 3; ch++) out[p + ch] = clamp255(g + (orig[p + ch] - g) * f);
        }
        break;
      }
      case "blur":
      case "sharpen": {
        const sharpen = o.tool === "sharpen";
        // The original, blurred once per tile per stroke.
        const blurred = this.blurredTile(ti, tx, ty, sharpen ? 1 : Math.min(8, 1.2 + o.size / 30));
        for (let k = 0; k < n; k++) {
          const t = covAt(k) * o.strength;
          if (t <= 0) continue;
          const p = k * 4;
          const x = sub.x - tx * TILE + (k % sub.w), y = sub.y - ty * TILE + ((k / sub.w) | 0);
          const b = (y * TILE + x) * 4;
          if (sharpen) {
            for (let ch = 0; ch < 3; ch++) out[p + ch] = clamp255(orig[p + ch] + (orig[p + ch] - blurred[b + ch]) * t * 1.6);
          } else for (let ch = 0; ch < 4; ch++) out[p + ch] = orig[p + ch] + (blurred[b + ch] - orig[p + ch]) * t;
        }
        break;
      }
    }
    if (keepAlpha || l.isBackground) for (let k = 0; k < n; k++) out[k * 4 + 3] = l.isBackground ? 255 : orig[k * 4 + 3];
    l.grid.writeRegion(sub, out);
  }

  private blurCache = new Map<number, Float32Array>();

  /** A whole tile of the original, blurred (with a margin read from its neighbours). */
  private blurredTile(ti: number, tx: number, ty: number, sigma: number): Float32Array {
    let b = this.blurCache.get(ti);
    if (b) return b;
    const pad = Math.ceil(sigma * 3);
    const big = { x: tx * TILE - pad, y: ty * TILE - pad, w: TILE + pad * 2, h: TILE + pad * 2 };
    const all = gaussRGBA(this.orig.readRegion(big), big.w, big.h, sigma);
    b = new Float32Array(TILE_PX * 4);
    for (let y = 0; y < TILE; y++) b.set(all.subarray(((y + pad) * big.w + pad) * 4, ((y + pad) * big.w + pad + TILE) * 4), y * TILE * 4);
    this.blurCache.set(ti, b);
    return b;
  }

  /** Background Eraser and Color Replacement: act on colors close to the sampled one. */
  private matchDab(lx: number, ly: number, area: Rect): void {
    const o = this.o, l = this.layer;
    const tip = this.tipAt();
    const cx = Math.floor(lx), cy = Math.floor(ly);
    // The color to act on, read from the image as it was when the stroke began.
    let target: [number, number, number];
    if (o.sampling === "background" && o.bg) target = o.bg;
    else if (o.sampling === "once" && this.sampled) target = this.sampled;
    else {
      const c = this.orig.getPixel(Math.max(0, Math.min(this.orig.width - 1, cx)), Math.max(0, Math.min(this.orig.height - 1, cy)));
      if (c[3] === 0 && this.sampled) target = this.sampled;
      else target = [c[0], c[1], c[2]];
      this.sampled ??= target;
    }
    const tol = ((o.tolerance ?? 50) / 100) * 255;
    const cur = l.grid.readRegion(area);
    const n = area.w * area.h;
    const diff = (p: number, c: readonly number[]) => Math.max(Math.abs(cur[p] - c[0]), Math.abs(cur[p + 1] - c[1]), Math.abs(cur[p + 2] - c[2]));
    // How much each pixel matches: fully inside the tolerance, fading out over its last third.
    const match = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const p = k * 4;
      if (o.tool === "bgErase" && cur[p + 3] === 0) continue;
      const d = diff(p, target);
      match[k] = d <= tol * 0.67 ? 1 : d >= tol ? 0 : (tol - d) / (tol * 0.33 + 1e-6);
      if (o.protectFg && o.fg && diff(p, o.fg) <= 12) match[k] = 0;
    }
    if (o.limits !== "discontiguous") {
      // Contiguous: only what connects to the brush center.
      const keep = new Uint8Array(n);
      const sx = cx - area.x, sy = cy - area.y;
      const queue: number[] = [];
      if (sx >= 0 && sy >= 0 && sx < area.w && sy < area.h && match[sy * area.w + sx] > 0) {
        keep[sy * area.w + sx] = 1;
        queue.push(sy * area.w + sx);
      }
      while (queue.length) {
        const k = queue.pop()!;
        const x = k % area.w, y = (k / area.w) | 0;
        for (const j of [x > 0 ? k - 1 : -1, x < area.w - 1 ? k + 1 : -1, y > 0 ? k - area.w : -1, y < area.h - 1 ? k + area.w : -1])
          if (j >= 0 && !keep[j] && match[j] > 0) {
            keep[j] = 1;
            queue.push(j);
          }
      }
      for (let k = 0; k < n; k++) if (!keep[k]) match[k] = 0;
    }
    const sel = this.selCov(area);
    const out = cur.slice();
    const fgHsl = o.fg ? rgbToHsl(o.fg[0], o.fg[1], o.fg[2]) : [0, 0, 0];
    for (let k = 0; k < n; k++) {
      if (!match[k]) continue;
      const x = area.x + (k % area.w), y = area.y + ((k / area.w) | 0);
      let a = tip(Math.hypot(x + 0.5 - lx, y + 0.5 - ly)) * match[k] * o.strength;
      if (sel) a *= sel[k] / 255;
      if (a <= 0) continue;
      const p = k * 4;
      if (o.tool === "bgErase") {
        if (!l.locks.transparency && !l.isBackground) out[p + 3] = Math.round(cur[p + 3] * (1 - a));
        continue;
      }
      const [h, s2, li] = rgbToHsl(cur[p], cur[p + 1], cur[p + 2]);
      const m = o.replaceMode ?? "color";
      const nh = m === "hue" || m === "color" ? fgHsl[0] : h;
      const ns = m === "saturation" || m === "color" ? fgHsl[1] : s2;
      const nl = m === "luminosity" ? fgHsl[2] : li;
      const [r, g, b] = hslToRgb(nh, ns, nl);
      out[p] = cur[p] + (r - cur[p]) * a;
      out[p + 1] = cur[p + 1] + (g - cur[p + 1]) * a;
      out[p + 2] = cur[p + 2] + (b - cur[p + 2]) * a;
    }
    l.grid.writeRegion(area, out);
  }

  /** Art History Brush: quick stylized strokes in the colors of a history state. */
  private artDab(lx: number, ly: number): Rect | null {
    const o = this.o, l = this.layer, h = o.historySource!;
    const style = o.artStyle ?? "tightShort";
    const areaR = Math.max(2, (o.artArea ?? 50) / 2);
    const width = Math.max(1, o.size);
    const len = style.endsWith("Short") ? 6 : style.endsWith("Medium") ? 14 : style.endsWith("Long") ? 28 : style === "dab" ? 1 : 18;
    const loose = style.startsWith("loose");
    const curl = style.endsWith("Curl");
    const count = Math.max(1, Math.round((areaR * areaR) / (width * Math.max(4, len) * 0.9)));
    const r = Math.ceil(areaR + len + width + 2);
    const region = rectIntersect({ x: Math.floor(lx) - r, y: Math.floor(ly) - r, w: r * 2 + 1, h: r * 2 + 1 }, { x: 0, y: 0, w: l.grid.width, h: l.grid.height });
    if (!region) return null;
    const src = h.grid.readRegion({ x: region.x + this.ox - h.offsetX, y: region.y + this.oy - h.offsetY, w: region.w, h: region.h });
    const cur = l.grid.readRegion(region);
    const sel = this.selCov(region);
    const W = region.w, H = region.h;
    const lum = (x: number, y: number) => {
      const xx = Math.max(0, Math.min(W - 1, x)), yy = Math.max(0, Math.min(H - 1, y));
      const p = (yy * W + xx) * 4;
      return src[p] * 0.3 + src[p + 1] * 0.59 + src[p + 2] * 0.11;
    };
    const half = width / 2;
    const stamp = (fx: number, fy: number, c: Uint8ClampedArray, ci: number, op: number) => {
      const x0 = Math.max(0, Math.floor(fx - half - 1)), x1 = Math.min(W - 1, Math.ceil(fx + half + 1));
      const y0 = Math.max(0, Math.floor(fy - half - 1)), y1 = Math.min(H - 1, Math.ceil(fy + half + 1));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          let a = Math.max(0, Math.min(1, half + 0.5 - Math.hypot(x + 0.5 - fx, y + 0.5 - fy))) * op;
          if (sel) a *= sel[y * W + x] / 255;
          if (a <= 0) continue;
          const p = (y * W + x) * 4;
          const sa = (c[ci + 3] / 255) * a, da = cur[p + 3] / 255;
          const oa = sa + da * (1 - sa);
          if (oa <= 0) continue;
          for (let ch = 0; ch < 3; ch++) cur[p + ch] = (c[ci + ch] * sa + cur[p + ch] * da * (1 - sa)) / oa;
          cur[p + 3] = l.isBackground || l.locks.transparency ? cur[p + 3] : Math.round(oa * 255);
        }
    };
    const cx = lx - region.x, cy = ly - region.y;
    for (let k = 0; k < count; k++) {
      const ang = this.rnd() * Math.PI * 2, rad = Math.sqrt(this.rnd()) * areaR;
      let x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
      const ix = Math.round(x), iy = Math.round(y);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      const ci = (iy * W + ix) * 4;
      if (src[ci + 3] === 0) continue;
      // Strokes run along edges in the source (across its gradient), with some looseness.
      const gx = lum(ix + 1, iy) - lum(ix - 1, iy), gy = lum(ix, iy + 1) - lum(ix, iy - 1);
      let dir = Math.hypot(gx, gy) > 2 ? Math.atan2(gx, -gy) : this.rnd() * Math.PI * 2;
      dir += (this.rnd() - 0.5) * (loose ? 1.2 : 0.35);
      const turn = curl ? (this.rnd() < 0.5 ? -1 : 1) * (loose ? 0.25 : 0.15) : 0;
      const steps = Math.max(1, Math.round(len / Math.max(1, half)));
      for (let st = 0; st <= steps; st++) {
        stamp(x, y, src, ci, o.strength);
        x += Math.cos(dir) * Math.max(1, half);
        y += Math.sin(dir) * Math.max(1, half);
        dir += turn;
      }
    }
    l.grid.writeRegion(region, cur);
    return region;
  }

  /** Smudge: drag the color under the brush along, mixing as it goes. */
  private smudgeDab(lx: number, ly: number, area: Rect): void {
    const l = this.layer;
    const tip = this.tipAt();
    const S = Math.ceil(this.o.size) + 3;
    const half = S / 2;
    const px0 = Math.floor(lx - half), py0 = Math.floor(ly - half);
    const cur = l.grid.readRegion({ x: px0, y: py0, w: S, h: S });
    if (!this.smudgePatch || this.smudgeSize !== S) {
      // First dab: pick up what's under the brush (premultiplied).
      this.smudgeSize = S;
      this.smudgePatch = new Float32Array(S * S * 4);
      for (let i = 0; i < S * S; i++) {
        const a = cur[i * 4 + 3] / 255;
        for (let ch = 0; ch < 3; ch++) this.smudgePatch[i * 4 + ch] = cur[i * 4 + ch] * a;
        this.smudgePatch[i * 4 + 3] = a;
      }
      return;
    }
    const patch = this.smudgePatch;
    const st = Math.min(0.98, this.o.strength);
    const sel = this.selCov({ x: px0, y: py0, w: S, h: S });
    const out = cur.slice();
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const gx = px0 + x, gy = py0 + y;
        if (gx < area.x || gy < area.y || gx >= area.x + area.w || gy >= area.y + area.h) continue;
        const i = y * S + x;
        let a = tip(Math.hypot(gx + 0.5 - lx, gy + 0.5 - ly)) * st;
        if (sel) a *= sel[i] / 255;
        if (a <= 0) continue;
        const p = i * 4;
        const ca = cur[p + 3] / 255;
        // Lay down the carried paint...
        const outA = ca + (patch[p + 3] - ca) * a;
        for (let ch = 0; ch < 3; ch++) {
          const pm = cur[p + ch] * ca + (patch[p + ch] - cur[p + ch] * ca) * a;
          out[p + ch] = outA > 0 ? clamp255(pm / outA) : 0;
        }
        out[p + 3] = l.isBackground ? 255 : l.locks.transparency ? cur[p + 3] : Math.round(outA * 255);
        // ...and pick up some of the result.
        const na = out[p + 3] / 255;
        const pick = 1 - st;
        for (let ch = 0; ch < 3; ch++) patch[p + ch] += (out[p + ch] * na - patch[p + ch]) * pick;
        patch[p + 3] += (na - patch[p + 3]) * pick;
      }
    l.grid.writeRegion({ x: px0, y: py0, w: S, h: S }, out);
  }

  // ------------------------------------------------------------------ finishing

  /** The stroke's coverage over a layer rect (with the selection applied). */
  private coverage(r: Rect): Float32Array {
    const out = new Float32Array(r.w * r.h);
    const G = this.layer.grid;
    for (const [ti, c] of this.cov) {
      const tx = ti % G.cols, ty = (ti / G.cols) | 0;
      const sub = rectIntersect(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      if (!sub) continue;
      for (let y = sub.y; y < sub.y + sub.h; y++)
        for (let x = sub.x; x < sub.x + sub.w; x++) out[(y - r.y) * r.w + (x - r.x)] = c[(y - ty * TILE) * TILE + (x - tx * TILE)];
    }
    const sel = this.selCov(r);
    if (sel) for (let i = 0; i < out.length; i++) out[i] *= sel[i] / 255;
    return out;
  }

  private strokeRect(margin: number): Rect | null {
    if (!this.bounds) return null;
    const b = this.bounds;
    return rectIntersect(
      { x: b.x - this.ox - margin, y: b.y - this.oy - margin, w: b.w + margin * 2, h: b.h + margin * 2 },
      { x: 0, y: 0, w: this.layer.grid.width, h: this.layer.grid.height },
    );
  }

  private finishHeal(): Rect | null {
    const r = this.strokeRect(Math.max(6, Math.round(this.o.size * 0.25)));
    if (!r) return null;
    const cov = this.coverage(r);
    const dst = this.orig.readRegion(r);
    const src = this.source(r);
    const m = new Float32Array(cov.length);
    for (let i = 0; i < cov.length; i++) m[i] = Math.min(1, cov[i] * 1.25) * this.o.strength;
    const out = healBlend(dst, src, m, r.w, r.h);
    this.writeKeepingAlpha(r, dst, out);
    return { x: r.x + this.ox, y: r.y + this.oy, w: r.w, h: r.h };
  }

  private finishSpot(): Rect | null {
    const margin = Math.max(12, Math.round(this.o.size * 1.5));
    const r = this.strokeRect(margin);
    if (!r) return null;
    const cov = this.coverage(r);
    const data = this.orig.readRegion(r);
    const hole = new Uint8Array(cov.length);
    let any = false;
    for (let i = 0; i < cov.length; i++)
      if (cov[i] > 0.03) {
        hole[i] = 1;
        any = true;
      }
    if (!any) {
      this.layer.grid.writeRegion(r, data);
      return { x: r.x + this.ox, y: r.y + this.oy, w: r.w, h: r.h };
    }
    // Big strokes are filled at a smaller size (then scaled back) so letting go stays quick.
    let holeCount = 0;
    for (let i = 0; i < hole.length; i++) holeCount += hole[i];
    const k = holeCount > SPOT_MAX ? Math.sqrt(SPOT_MAX / holeCount) : 1;
    let fill: Uint8ClampedArray;
    if (k < 1) {
      const sw = Math.max(8, Math.round(r.w * k)), sh = Math.max(8, Math.round(r.h * k));
      const g = resampleGray(Uint8Array.from(hole, (v) => v * 255), r.w, r.h, sw, sh, "bilinear");
      const small = inpaint({ w: sw, h: sh, data: resampleRGBA(data, r.w, r.h, sw, sh, "bilinear"), hole: Uint8Array.from(g, (v) => (v ? 1 : 0)) }, { seed: this.o.seed ?? 1 });
      fill = resampleRGBA(small, sw, sh, r.w, r.h, "bicubic");
    } else fill = inpaint({ w: r.w, h: r.h, data, hole }, { seed: this.o.seed ?? 1, patch: this.o.size < 14 ? 5 : 7 });
    const out = data.slice();
    for (let i = 0; i < cov.length; i++) {
      if (!hole[i]) continue;
      mixInto(out, i * 4, data, fill, Math.min(1, cov[i] * 2.5));
    }
    this.writeKeepingAlpha(r, data, out);
    return { x: r.x + this.ox, y: r.y + this.oy, w: r.w, h: r.h };
  }

  private writeKeepingAlpha(r: Rect, orig: Uint8ClampedArray, out: Uint8ClampedArray): void {
    const l = this.layer;
    if (l.isBackground || l.locks.transparency) for (let i = 3; i < out.length; i += 4) out[i] = l.isBackground ? 255 : orig[i];
    l.grid.writeRegion(r, out);
  }
}

/** out[p..] = orig mixed toward src by t, premultiplied. */
function mixInto(out: Uint8ClampedArray, p: number, orig: Uint8ClampedArray, src: Uint8ClampedArray, t: number): void {
  const oa = orig[p + 3] / 255, sa = src[p + 3] / 255;
  const a = oa + (sa - oa) * t;
  if (a <= 0) {
    out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
    return;
  }
  for (let ch = 0; ch < 3; ch++) out[p + ch] = (orig[p + ch] * oa + (src[p + ch] * sa - orig[p + ch] * oa) * t) / a;
  out[p + 3] = Math.round(a * 255);
}

/** Gaussian blur of straight RGBA (premultiplied inside), separable. */
function gaussRGBA(px: Uint8ClampedArray, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(r * 2 + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const a = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = px[i * 4 + 3] / 255;
    a[i * 4] = px[i * 4] * al;
    a[i * 4 + 1] = px[i * 4 + 1] * al;
    a[i * 4 + 2] = px[i * 4 + 2] * al;
    a[i * 4 + 3] = al;
  }
  const tmp = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        const q = (y * w + xx) * 4, kw = k[i + r];
        c0 += a[q] * kw;
        c1 += a[q + 1] * kw;
        c2 += a[q + 2] * kw;
        c3 += a[q + 3] * kw;
      }
      const o = (y * w + x) * 4;
      tmp[o] = c0;
      tmp[o + 1] = c1;
      tmp[o + 2] = c2;
      tmp[o + 3] = c3;
    }
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        const q = (yy * w + x) * 4, kw = k[i + r];
        c0 += tmp[q] * kw;
        c1 += tmp[q + 1] * kw;
        c2 += tmp[q + 2] * kw;
        c3 += tmp[q + 3] * kw;
      }
      const o = (y * w + x) * 4;
      out[o] = c3 > 1e-4 ? c0 / c3 : 0;
      out[o + 1] = c3 > 1e-4 ? c1 / c3 : 0;
      out[o + 2] = c3 > 1e-4 ? c2 / c3 : 0;
      out[o + 3] = c3 * 255;
    }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
