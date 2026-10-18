/**
 * The Gradient tool: PS7's five shapes (linear, radial, angle, reflected,
 * diamond) with presets built from the foreground and background colors.
 * Paints layer pixels (with a blend mode), layer masks and Quick Mask.
 */

import type { PaintTarget } from "./brush";
import { BlendMode, compositePixel } from "./blend";
import type { Document, RGBA } from "./document";
import { editAreaIn, maskEditArea } from "./selection";
import type { Rect } from "./tiles";
import { Mask } from "./mask";

export const GRADIENT_TYPES = ["linear", "radial", "angle", "reflected", "diamond"] as const;
export type GradientType = (typeof GRADIENT_TYPES)[number];

export const GRADIENT_PRESETS = [
  "fgToBg",
  "fgToTransparent",
  "blackWhite",
  "whiteBlack",
  "fgToBgToFg",
  "spectrum",
  "chrome",
  "copper",
  "violetOrange",
  "transparentStripes",
] as const;
export type GradientPreset = (typeof GRADIENT_PRESETS)[number];

export const GRADIENT_LABELS: Record<GradientPreset, string> = {
  fgToBg: "Foreground to Background",
  fgToTransparent: "Foreground to Transparent",
  blackWhite: "Black, White",
  whiteBlack: "White, Black",
  fgToBgToFg: "Foreground to Background to Foreground",
  spectrum: "Spectrum",
  chrome: "Chrome",
  copper: "Copper",
  violetOrange: "Violet, Orange",
  transparentStripes: "Transparent Stripes",
};

export const GRADIENT_TYPE_LABELS: Record<GradientType, string> = {
  linear: "Linear Gradient",
  radial: "Radial Gradient",
  angle: "Angle Gradient",
  reflected: "Reflected Gradient",
  diamond: "Diamond Gradient",
};

/** A color stop: position 0..1 and straight RGBA 0..255. */
export interface Stop {
  pos: number;
  color: RGBA;
}

const hex = (h: string, a = 255): RGBA => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

/** Stops for a preset, using the current foreground and background colors. */
export function presetStops(p: GradientPreset, fg: RGBA, bg: RGBA): Stop[] {
  const f: RGBA = [fg[0], fg[1], fg[2], 255];
  const b: RGBA = [bg[0], bg[1], bg[2], 255];
  switch (p) {
    case "fgToBg":
      return [{ pos: 0, color: f }, { pos: 1, color: b }];
    case "fgToTransparent":
      return [{ pos: 0, color: f }, { pos: 1, color: [f[0], f[1], f[2], 0] }];
    case "blackWhite":
      return [{ pos: 0, color: [0, 0, 0, 255] }, { pos: 1, color: [255, 255, 255, 255] }];
    case "whiteBlack":
      return [{ pos: 0, color: [255, 255, 255, 255] }, { pos: 1, color: [0, 0, 0, 255] }];
    case "fgToBgToFg":
      return [{ pos: 0, color: f }, { pos: 0.5, color: b }, { pos: 1, color: f }];
    case "spectrum":
      return ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ff0000"].map((c, i, a) => ({ pos: i / (a.length - 1), color: hex(c) }));
    case "chrome":
      return [
        { pos: 0, color: hex("#29343f") },
        { pos: 0.42, color: hex("#e9eef2") },
        { pos: 0.5, color: hex("#5b4630") },
        { pos: 0.56, color: hex("#c09a6b") },
        { pos: 1, color: hex("#ffffff") },
      ];
    case "copper":
      return [{ pos: 0, color: hex("#97461a") }, { pos: 0.35, color: hex("#fbd8c5") }, { pos: 0.7, color: hex("#6c2e16") }, { pos: 1, color: hex("#efdbcd") }];
    case "violetOrange":
      return [{ pos: 0, color: hex("#290a59") }, { pos: 1, color: hex("#ff7c00") }];
    case "transparentStripes": {
      const out: Stop[] = [];
      for (let i = 0; i < 5; i++) {
        const a = i / 5, w = 1 / 10;
        out.push({ pos: a, color: f }, { pos: a + w - 0.0001, color: f }, { pos: a + w, color: [f[0], f[1], f[2], 0] }, { pos: a + 2 * w - 0.0001, color: [f[0], f[1], f[2], 0] });
      }
      return out;
    }
  }
}

/** Gradient position 0..1 (before reversing) of point x, y for a drag p0 -> p1. */
export function gradientT(type: GradientType, x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return 0;
  const len = Math.sqrt(len2);
  const px = x - x0, py = y - y0;
  let t: number;
  switch (type) {
    case "linear":
      t = (px * dx + py * dy) / len2;
      break;
    case "reflected":
      t = Math.abs((px * dx + py * dy) / len2);
      break;
    case "radial":
      t = Math.sqrt(px * px + py * py) / len;
      break;
    case "diamond": {
      // Distance in the frame rotated to the drag direction (L1 norm).
      const u = (px * dx + py * dy) / len, v = (py * dx - px * dy) / len;
      t = (Math.abs(u) + Math.abs(v)) / len;
      break;
    }
    case "angle": {
      // Sweeps clockwise (on screen) from the drag direction around p0.
      let a = Math.atan2(py, px) - Math.atan2(dy, dx);
      a = -a;
      a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      t = a / (2 * Math.PI);
      break;
    }
  }
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** A 1024-entry lookup table of straight RGBA floats for the stops. */
export function gradientLUT(stops: Stop[], reverse: boolean, transparency: boolean): Float32Array {
  const N = 1024;
  const lut = new Float32Array(N * 4);
  const s = [...stops].sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < N; i++) {
    let t = i / (N - 1);
    if (reverse) t = 1 - t;
    let k = 0;
    while (k < s.length - 2 && t > s[k + 1].pos) k++;
    const a = s[k], b = s[Math.min(k + 1, s.length - 1)];
    const span = b.pos - a.pos;
    const f = span > 0 ? Math.max(0, Math.min(1, (t - a.pos) / span)) : t >= b.pos ? 1 : 0;
    // Interpolate premultiplied so transparent stops don't pull in their color.
    const aa = a.color[3] / 255, ba = b.color[3] / 255;
    const al = aa + (ba - aa) * f;
    for (let c = 0; c < 3; c++) {
      const pm = a.color[c] * aa + (b.color[c] * ba - a.color[c] * aa) * f;
      lut[i * 4 + c] = al > 0 ? pm / al : a.color[c] + (b.color[c] - a.color[c]) * f;
    }
    lut[i * 4 + 3] = transparency ? al * 255 : 255;
  }
  return lut;
}

export interface GradientOptions {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  type: GradientType;
  stops: Stop[];
  mode: BlendMode;
  opacity: number; // 0..1
  reverse: boolean;
  dither: boolean;
  transparency: boolean;
}

/** Ordered-dither offset in -0.5..0.5 (8x8 Bayer), so 8-bit gradients don't band. */
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
const ditherAt = (x: number, y: number) => (BAYER[(y & 7) * 8 + (x & 7)] + 0.5) / 64 - 0.5;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Draw a gradient into the paint target (inside the selection, if any).
 * Returns the canvas rect changed, or null for nothing / the selection.
 */
export function drawGradient(doc: Document, target: PaintTarget, o: GradientOptions): Rect | null {
  const lut = gradientLUT(o.stops, o.reverse, o.transparency);
  const sample = (cx: number, cy: number, out: number[]) => {
    const t = gradientT(o.type, cx + 0.5, cy + 0.5, o.x0, o.y0, o.x1, o.y1);
    const i = Math.round(t * 1023) * 4;
    const d = o.dither ? ditherAt(cx, cy) : 0;
    out[0] = clamp(lut[i] + d);
    out[1] = clamp(lut[i + 1] + d);
    out[2] = clamp(lut[i + 2] + d);
    out[3] = lut[i + 3];
  };
  const src = [0, 0, 0, 0];

  if (target.kind === "selection" || target.kind === "mask") {
    // Masks take the gradient's gray level; its transparency fades the effect.
    let m, area: Rect, cov: Uint8Array | null, ox: number, oy: number;
    if (target.kind === "selection") {
      m = doc.selection ??= new Mask(doc.width, doc.height, 0);
      area = { x: 0, y: 0, w: m.width, h: m.height };
      cov = null;
      ox = oy = 0;
    } else {
      m = target.host.mask!;
      const ea = maskEditArea(doc, target.host);
      if (!ea) return null;
      area = ea.area;
      cov = ea.cov;
      ox = target.host.offsetX;
      oy = target.host.offsetY;
    }
    const d = m.readRegion(area, m.defaultValue);
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++) {
        const i = y * area.w + x;
        const cx = x + area.x + ox, cy = y + area.y + oy;
        sample(cx, cy, src);
        const a = o.opacity * (src[3] / 255) * (cov ? cov[i] / 255 : 1);
        if (a <= 0) continue;
        const g = 0.3 * src[0] + 0.59 * src[1] + 0.11 * src[2];
        // Blend modes act on the gray level too (Multiply darkens a mask, etc.).
        const bd = [d[i], d[i], d[i], 255];
        const r = compositePixel(o.mode, bd, [g, g, g, 255], a, cx, cy);
        d[i] = Math.round(clamp(r[0]));
      }
    m.writeRegion(area, d);
    if (target.kind === "selection") {
      doc.emit({ type: "selection" });
      return null;
    }
    return { x: area.x + ox, y: area.y + oy, w: area.w, h: area.h };
  }

  const layer = target.layer;
  const ea = editAreaIn(doc, layer.offsetX, layer.offsetY, layer.grid.width, layer.grid.height);
  if (!ea) return null;
  const { area, cov } = ea;
  const px = layer.grid.readRegion(area);
  const keepAlpha = layer.locks.transparency;
  const bd = [0, 0, 0, 0];
  for (let y = 0; y < area.h; y++)
    for (let x = 0; x < area.w; x++) {
      const i = y * area.w + x, p = i * 4;
      const cx = x + area.x + layer.offsetX, cy = y + area.y + layer.offsetY;
      sample(cx, cy, src);
      const a = o.opacity * (cov ? cov[i] / 255 : 1);
      if (a <= 0 || src[3] <= 0) continue;
      bd[0] = px[p];
      bd[1] = px[p + 1];
      bd[2] = px[p + 2];
      bd[3] = px[p + 3];
      if (keepAlpha && bd[3] === 0) continue;
      const r = compositePixel(o.mode, bd, src, a, cx, cy);
      px[p] = Math.round(r[0]);
      px[p + 1] = Math.round(r[1]);
      px[p + 2] = Math.round(r[2]);
      px[p + 3] = keepAlpha ? bd[3] : layer.isBackground ? 255 : Math.round(r[3]);
    }
  layer.grid.writeRegion(area, px);
  return { x: area.x + layer.offsetX, y: area.y + layer.offsetY, w: area.w, h: area.h };
}
