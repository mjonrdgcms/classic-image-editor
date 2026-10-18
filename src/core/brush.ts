/**
 * The stroke engine behind the Brush, Pencil and Eraser.
 *
 * Dabs are laid along the path at the preset's spacing, each shaped by the
 * tip (round with hardness, or a sampled image) and PS7's dynamics: size,
 * angle and roundness jitter, scattering, color jitter, opacity and flow
 * jitter, with fade or pen-pressure control. Dabs accumulate into a stroke
 * buffer at the flow rate; the buffer is then applied to the target at the
 * stroke's opacity and paint mode, recomputed from the original pixels each
 * time, so overlapping dabs never exceed the opacity. All randomness comes
 * from a seed, so replaying a recorded stroke gives identical pixels.
 *
 * Targets: a layer's pixels, its layer mask, or the selection (Quick Mask).
 */

import { BlendMode, compositePixel, dissolveHash } from "./blend";
import { BrushPreset, mulberry } from "./brushes";
import type { Document, Layer, MaskHost, RGBA } from "./document";
import { Mask, MaskTile } from "./mask";
import { Rect, TILE, TILE_PX, Tile, rectIntersect, rectUnion } from "./tiles";

export type PaintTarget = { kind: "pixels"; layer: Layer } | { kind: "mask"; host: MaskHost } | { kind: "selection" };
export type PaintMode = BlendMode | "behind" | "clear";

export interface StrokeOptions {
  tool: "brush" | "pencil" | "eraser";
  brush: BrushPreset;
  /** 0..1 */
  opacity: number;
  /** 0..1 */
  flow: number;
  mode: PaintMode;
  fg: RGBA;
  bg: RGBA;
  seed: number;
  /** Hard pixel edges (Pencil, and the Eraser in Pencil or Block mode). */
  aliased?: boolean;
}

export class Stroke {
  private bufs = new Map<number, Float32Array>();
  private origPx = new Map<number, Tile | null>();
  private origMask = new Map<number, MaskTile | null>();
  private last: { x: number; y: number; p: number } | null = null;
  private residual = 0;
  private dabCount = 0;
  private rnd: () => number;
  private grid: { width: number; height: number; cols: number; ox: number; oy: number };
  private pendingSelEmit = false;
  bounds: Rect | null = null;
  readonly points: [number, number, number][] = [];

  constructor(
    private doc: Document,
    private target: PaintTarget,
    private o: StrokeOptions,
  ) {
    this.rnd = mulberry(o.seed);
    if (target.kind === "selection") {
      if (!doc.selection) doc.selection = new Mask(doc.width, doc.height, 0);
      doc.selection.freeze();
      const m = doc.selection;
      this.grid = { width: m.width, height: m.height, cols: m.cols, ox: 0, oy: 0 };
    } else if (target.kind === "mask") {
      const h = target.host;
      if (!h.mask) throw new Error("there is no mask");
      h.mask.freeze();
      this.grid = { width: h.mask.width, height: h.mask.height, cols: h.mask.cols, ox: h.offsetX, oy: h.offsetY };
    } else {
      const l = target.layer;
      l.grid.freeze();
      this.grid = { width: l.grid.width, height: l.grid.height, cols: l.grid.cols, ox: l.offsetX, oy: l.offsetY };
    }
  }

  private get isEraser(): boolean {
    return this.o.tool === "eraser";
  }

  /** Add a point (canvas coordinates, pressure 0..1). */
  addPoint(x: number, y: number, pressure = 1): Rect | null {
    this.points.push([x, y, pressure]);
    const b = this.o.brush;
    const step = Math.max(1, (b.size * b.spacing) / 100);
    let dirty: Rect | null = null;
    if (!this.last) {
      dirty = this.dabAt(x, y, pressure, 0);
      this.residual = 0;
    } else {
      const L = this.last;
      const dist = Math.hypot(x - L.x, y - L.y);
      const dir = (Math.atan2(y - L.y, x - L.x) * 180) / Math.PI;
      if (dist === 0) {
        // Holding still: only the airbrush keeps building up.
        if (b.airbrush) dirty = this.dabAt(x, y, pressure, dir);
      } else {
        let t = step - this.residual;
        while (t <= dist) {
          const f = t / dist;
          dirty = rectUnion(dirty, this.dabAt(L.x + (x - L.x) * f, L.y + (y - L.y) * f, L.p + (pressure - L.p) * f, dir));
          t += step;
        }
        this.residual = dist - (t - step);
      }
    }
    this.last = { x, y, p: pressure };
    if (dirty) {
      this.bounds = rectUnion(this.bounds, dirty);
      this.notify(dirty);
    }
    return dirty;
  }

  private notify(r: Rect): void {
    if (this.target.kind === "selection") {
      if (!this.pendingSelEmit) {
        this.pendingSelEmit = true;
        queueMicrotask(() => {
          this.pendingSelEmit = false;
          this.doc.emit({ type: "selection" });
        });
      }
    } else this.doc.dirty(r);
  }

  end(): Rect | null {
    if (this.target.kind === "pixels") {
      const g = this.target.layer.grid;
      for (const i of this.origPx.keys()) {
        const t = g.tiles[i];
        if (t && t.isEmpty()) g.tiles[i] = null;
      }
    } else if (this.target.kind === "mask") this.target.host.mask!.compact();
    else this.doc.selection!.compact();
    if (this.target.kind === "selection") this.doc.emit({ type: "selection" });
    return this.bounds;
  }

  // ---------------------------------------------------------------- dynamics

  private control(c: "off" | "fade" | "pressure", pressure: number, fadeSteps: number): number {
    if (c === "pressure") return pressure;
    if (c === "fade") return Math.max(0, 1 - this.dabCount / Math.max(1, fadeSteps));
    return 1;
  }

  private dabAt(x: number, y: number, pressure: number, dir: number): Rect | null {
    const b = this.o.brush;
    const rnd = this.rnd;
    let dirty: Rect | null = null;
    const sh = b.shape;
    let size = b.size;
    let angle = b.angle;
    let roundness = b.roundness / 100;
    if (sh) {
      const minD = sh.minDiameter / 100;
      const ctl = this.control(sh.sizeControl, pressure, sh.fadeSteps);
      size *= Math.max(minD, ctl * (1 - (sh.sizeJitter / 100) * rnd()));
      if (sh.angleControl === "direction") angle = b.angle + dir;
      else if (sh.angleControl === "pressure") angle = b.angle + pressure * 360;
      angle += (sh.angleJitter / 100) * 360 * (rnd() - 0.5);
      roundness = Math.max(sh.minRoundness / 100, roundness * (1 - (sh.roundnessJitter / 100) * rnd()));
    }
    let alpha = this.o.flow;
    const ot = b.other;
    if (ot) {
      alpha *= this.control(ot.flowControl, pressure, ot.fadeSteps) * (1 - (ot.flowJitter / 100) * rnd());
      alpha *= this.control(ot.opacityControl, pressure, ot.fadeSteps) * (1 - (ot.opacityJitter / 100) * rnd());
    }
    const color = this.dabColor();
    const sc = b.scatter;
    const count = sc ? Math.max(1, Math.round(sc.count * (1 - (sc.countJitter / 100) * rnd()))) : 1;
    const rad = (dir * Math.PI) / 180;
    for (let k = 0; k < count; k++) {
      let dx = 0, dy = 0;
      if (sc && sc.amount > 0) {
        const spread = (sc.amount / 100) * b.size;
        const across = (rnd() * 2 - 1) * spread;
        const along = sc.bothAxes ? (rnd() * 2 - 1) * spread : 0;
        // Perpendicular to the stroke direction (and along it with both axes).
        dx = -Math.sin(rad) * across + Math.cos(rad) * along;
        dy = Math.cos(rad) * across + Math.sin(rad) * along;
      }
      dirty = rectUnion(dirty, this.renderDab(x + dx, y + dy, size, angle, roundness, alpha, color));
    }
    this.dabCount++;
    return dirty;
  }

  private dabColor(): [number, number, number] {
    const o = this.o;
    const t = this.target;
    // Erasing paints transparency, or the background color where transparency isn't possible.
    let c: RGBA = this.isEraser ? o.bg : o.fg;
    const cd = o.brush.color;
    if (!cd || this.isEraser) return [c[0], c[1], c[2]];
    const rnd = this.rnd;
    if (cd.fgBgJitter > 0) {
      const f = (cd.fgBgJitter / 100) * rnd();
      c = [o.fg[0] + (o.bg[0] - o.fg[0]) * f, o.fg[1] + (o.bg[1] - o.fg[1]) * f, o.fg[2] + (o.bg[2] - o.fg[2]) * f, 255];
    }
    if ((cd.hueJitter || cd.saturationJitter || cd.brightnessJitter) && t.kind === "pixels") {
      let [h, s, v] = rgbToHsv(c[0], c[1], c[2]);
      h = (h + (cd.hueJitter / 100) * (rnd() - 0.5) + 1) % 1;
      s = Math.max(0, Math.min(1, s + (cd.saturationJitter / 100) * (rnd() - 0.5) * 2));
      v = Math.max(0, Math.min(1, v + (cd.brightnessJitter / 100) * (rnd() - 0.5) * 2));
      return hsvToRgb(h, s, v);
    }
    return [c[0], c[1], c[2]];
  }

  /** Accumulate one dab into the stroke buffer and re-apply the touched area. */
  private renderDab(cx: number, cy: number, size: number, angleDeg: number, roundness: number, alpha: number, color: [number, number, number]): Rect | null {
    if (size < 0.5 || alpha <= 0) return null;
    const b = this.o.brush;
    const G = this.grid;
    const lx = cx - G.ox, ly = cy - G.oy;
    const tip = b.sampled;
    const half = size / 2;
    const reach = (tip ? (half * Math.hypot(tip.w, tip.h)) / Math.max(tip.w, tip.h) : half) + 1.5;
    const area = rectIntersect(
      { x: Math.floor(lx - reach), y: Math.floor(ly - reach), w: Math.ceil(2 * reach) + 1, h: Math.ceil(2 * reach) + 1 },
      { x: 0, y: 0, w: G.width, h: G.height },
    );
    if (!area) return null;
    const cos = Math.cos((-angleDeg * Math.PI) / 180), sin = Math.sin((-angleDeg * Math.PI) / 180);
    const pencil = this.o.tool === "pencil" || !!this.o.aliased;
    const hard = Math.min(1, Math.max(0, b.hardness / 100));
    const inner = half * hard;
    const soft = half - inner;
    const scale = tip ? size / Math.max(tip.w, tip.h) : 1;
    const [cr, cg, cb] = [color[0] / 255, color[1] / 255, color[2] / 255];

    const tx0 = (area.x / TILE) | 0, ty0 = (area.y / TILE) | 0;
    const tx1 = ((area.x + area.w - 1) / TILE) | 0, ty1 = ((area.y + area.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const sub = rectIntersect(area, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        const ti = ty * G.cols + tx;
        let buf = this.bufs.get(ti);
        if (!buf) {
          buf = new Float32Array(TILE_PX * 4);
          this.bufs.set(ti, buf);
          this.rememberOriginal(ti);
        }
        let touched = false;
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          for (let x = sub.x; x < sub.x + sub.w; x++) {
            // Pixel center in tip space (rotated, roundness stretches y).
            const px = x + 0.5 - lx, py = y + 0.5 - ly;
            const u = px * cos - py * sin;
            const v = (px * sin + py * cos) / roundness;
            let a: number;
            if (tip) {
              a = sampleTip(tip, u / scale + tip.w / 2, v / scale + tip.h / 2);
            } else {
              const d = Math.hypot(u, v);
              if (soft < 1) a = Math.min(1, Math.max(0, half + 0.5 - d));
              else if (d <= inner) a = 1;
              else if (d >= half) a = 0;
              else a = 0.5 * (1 + Math.cos((Math.PI * (d - inner)) / soft));
            }
            if (pencil) a = a >= 0.5 ? 1 : 0;
            if (a <= 0) continue;
            if (b.noise && a < 1) a *= 0.35 + 0.65 * dissolveHash(x + G.ox, y + G.oy + this.dabCount);
            a *= alpha;
            const o = ((y - ty * TILE) * TILE + (x - tx * TILE)) * 4;
            const k = 1 - a;
            buf[o] = cr * a + buf[o] * k;
            buf[o + 1] = cg * a + buf[o + 1] * k;
            buf[o + 2] = cb * a + buf[o + 2] * k;
            buf[o + 3] = a + buf[o + 3] * k;
            touched = true;
          }
        }
        if (touched) this.apply(ti, tx, ty, sub, buf);
      }
    return { x: area.x + G.ox, y: area.y + G.oy, w: area.w, h: area.h };
  }

  private rememberOriginal(ti: number): void {
    const t = this.target;
    if (t.kind === "pixels") this.origPx.set(ti, t.layer.grid.tiles[ti]);
    else this.origMask.set(ti, (t.kind === "mask" ? t.host.mask! : this.doc.selection!).tiles[ti]);
  }

  /** Recompute a tile region from the original pixels and the stroke buffer. */
  private apply(ti: number, tx: number, ty: number, sub: Rect, buf: Float32Array): void {
    const doc = this.doc;
    const t = this.target;
    const G = this.grid;
    const op = this.o.opacity;
    // Selection coverage limits painting on pixels and masks (not in Quick Mask).
    const cov =
      t.kind !== "selection" && doc.selection
        ? doc.selection.readRegion({ x: sub.x + G.ox, y: sub.y + G.oy, w: sub.w, h: sub.h })
        : null;

    if (t.kind === "pixels") {
      const layer = t.layer;
      const orig = this.origPx.get(ti) ?? null;
      const od = orig?.data;
      let mode: PaintMode = this.o.mode;
      if (this.isEraser) mode = layer.isBackground ? "normal" : "clear";
      // Erasing nothing changes nothing; skip allocating tiles for it.
      if (!od && (mode === "clear" || layer.locks.transparency)) return;
      const dst = layer.grid.writableTile(tx, ty);
      const d = dst.data;
      const keepAlpha = layer.locks.transparency;
      const src = [0, 0, 0, 0];
      const bd = [0, 0, 0, 0];
      for (let y = sub.y; y < sub.y + sub.h; y++)
        for (let x = sub.x; x < sub.x + sub.w; x++) {
          const mi = (y - ty * TILE) * TILE + (x - tx * TILE);
          const o = mi * 4;
          const ba = buf[o + 3];
          if (ba <= 0) continue;
          let A = ba * op;
          if (cov) A *= cov[(y - sub.y) * sub.w + (x - sub.x)] / 255;
          bd[0] = od ? od[o] : 0;
          bd[1] = od ? od[o + 1] : 0;
          bd[2] = od ? od[o + 2] : 0;
          bd[3] = od ? od[o + 3] : 0;
          let r: number, g: number, b: number, a: number;
          if (A <= 0) {
            [r, g, b, a] = bd;
          } else if (mode === "clear") {
            [r, g, b] = bd;
            a = bd[3] * (1 - A);
          } else {
            src[0] = (buf[o] / ba) * 255;
            src[1] = (buf[o + 1] / ba) * 255;
            src[2] = (buf[o + 2] / ba) * 255;
            src[3] = A * 255;
            const cx = x + G.ox, cy = y + G.oy;
            [r, g, b, a] = mode === "behind" ? compositePixel("normal", src, bd, 1, cx, cy) : compositePixel(mode, bd, src, 1, cx, cy);
          }
          if (keepAlpha) a = bd[3];
          if (layer.isBackground) a = 255;
          d[o] = Math.round(r);
          d[o + 1] = Math.round(g);
          d[o + 2] = Math.round(b);
          d[o + 3] = Math.round(a);
        }
      dst.touch();
      return;
    }

    // Masks: move each value toward the dab's gray level.
    const m = t.kind === "mask" ? t.host.mask! : doc.selection!;
    const orig = this.origMask.get(ti) ?? null;
    const dst = m.writable(tx, ty);
    const d = dst.data;
    for (let y = sub.y; y < sub.y + sub.h; y++)
      for (let x = sub.x; x < sub.x + sub.w; x++) {
        const mi = (y - ty * TILE) * TILE + (x - tx * TILE);
        const o = mi * 4;
        const ba = buf[o + 3];
        if (ba <= 0) continue;
        let A = ba * op;
        if (cov) A *= cov[(y - sub.y) * sub.w + (x - sub.x)] / 255;
        const v0 = orig ? orig.data[mi] : m.defaultValue;
        // Gray of the accumulated color.
        const gray = ((0.3 * buf[o] + 0.59 * buf[o + 1] + 0.11 * buf[o + 2]) / ba) * 255;
        d[mi] = Math.round(v0 + (gray - v0) * A);
      }
    dst.touch();
  }
}

function sampleTip(tip: { w: number; h: number; data: Uint8Array }, u: number, v: number): number {
  // Bilinear, transparent outside.
  const x = u - 0.5, y = v - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= tip.w || yy >= tip.h ? 0 : tip.data[yy * tip.w + xx]);
  const v00 = at(x0, y0), v10 = at(x0 + 1, y0), v01 = at(x0, y0 + 1), v11 = at(x0 + 1, y0 + 1);
  return ((v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy) / 255;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, mx ? d / mx : 0, mx];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
