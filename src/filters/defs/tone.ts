/**
 * The classic tone and color adjustments: Levels, Curves, Color Balance and
 * Photo Filter. Levels and Curves keep all their settings in one compact
 * string so they record into Actions like any filter:
 *
 *   levels: "inBlack,gamma,inWhite,outBlack,outWhite" for RGB|R|G|B
 *   curves: "x,y;x,y;..." points (0..255) for RGB|R|G|B
 */

import { clamp, hexRGB, mapRGB, type Img } from "../img";
import { check, color, pct, range, sel } from "../p";
import type { FilterDef, ParamDef } from "../types";

const T = "Color & Tone";

// ------------------------------------------------------------------ Levels

export interface LevelsChannel {
  inBlack: number;
  gamma: number;
  inWhite: number;
  outBlack: number;
  outWhite: number;
}

export const LEVELS_IDENTITY = "0,1,255,0,255|0,1,255,0,255|0,1,255,0,255|0,1,255,0,255";

export function parseLevels(s: string): LevelsChannel[] {
  const parts = String(s || LEVELS_IDENTITY).split("|");
  const out: LevelsChannel[] = [];
  for (let c = 0; c < 4; c++) {
    const v = (parts[c] ?? "0,1,255,0,255").split(",").map(Number);
    const ok = (x: number, d: number) => (Number.isFinite(x) ? x : d);
    const inBlack = clamp(ok(v[0], 0), 0, 253), inWhite = clamp(ok(v[2], 255), inBlack + 2, 255);
    out.push({ inBlack, gamma: clamp(ok(v[1], 1), 0.1, 9.99), inWhite, outBlack: clamp(ok(v[3], 0), 0, 255), outWhite: clamp(ok(v[4], 255), 0, 255) });
  }
  return out;
}

export const formatLevels = (ch: LevelsChannel[]) => ch.map((c) => [c.inBlack, Math.round(c.gamma * 100) / 100, c.inWhite, c.outBlack, c.outWhite].join(",")).join("|");

export function levelsLUT(c: LevelsChannel): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let t = (i - c.inBlack) / (c.inWhite - c.inBlack);
    t = clamp(t, 0, 1);
    t = Math.pow(t, 1 / c.gamma);
    lut[i] = Math.round(c.outBlack + t * (c.outWhite - c.outBlack));
  }
  return lut;
}

/** Histograms of an image: [luminosity, red, green, blue], 256 bins each (alpha-weighted). */
export function histograms(img: Img): Uint32Array[] {
  const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    h[1][d[i]]++;
    h[2][d[i + 1]]++;
    h[3][d[i + 2]]++;
    h[0][Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114)]++;
  }
  return h;
}

/** Auto Levels for one histogram: clip a little at each end (like PS's 0.1%). */
export function autoRange(hist: Uint32Array, clip = 0.001): [number, number] {
  let total = 0;
  for (const v of hist) total += v;
  if (!total) return [0, 255];
  const cut = total * clip;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 254 && (acc += hist[lo]) <= cut) lo++;
  acc = 0;
  while (hi > lo + 1 && (acc += hist[hi]) <= cut) hi--;
  return [lo, hi];
}

// ------------------------------------------------------------------ Curves

export type CurvePoints = [number, number][];
const IDENT: CurvePoints = [
  [0, 0],
  [255, 255],
];
export const CURVES_IDENTITY = "0,0;255,255|0,0;255,255|0,0;255,255|0,0;255,255";

export function parseCurves(s: string): CurvePoints[] {
  const parts = String(s || CURVES_IDENTITY).split("|");
  const out: CurvePoints[] = [];
  for (let c = 0; c < 4; c++) {
    const pts = (parts[c] ?? "")
      .split(";")
      .map((p) => p.split(",").map(Number) as [number, number])
      .filter((p) => p.length === 2 && p.every(Number.isFinite))
      .map(([x, y]) => [clamp(Math.round(x), 0, 255), clamp(Math.round(y), 0, 255)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    // One point per x.
    const uniq: CurvePoints = [];
    for (const p of pts) if (!uniq.length || uniq[uniq.length - 1][0] !== p[0]) uniq.push(p);
    out.push(uniq.length >= 2 ? uniq : IDENT.map((p) => [...p] as [number, number]));
  }
  return out;
}

export const formatCurves = (c: CurvePoints[]) => c.map((pts) => pts.map(([x, y]) => `${x},${y}`).join(";")).join("|");

/** A smooth curve through the points that never overshoots (monotone cubic where the points rise). */
export function curveLUTFrom(pts: CurvePoints): Uint8Array {
  const lut = new Uint8Array(256);
  const n = pts.length;
  if (n < 2) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // Tangents: Catmull-Rom style, then Fritsch-Carlson limits where the data is monotone.
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1, xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
      const t2 = t * t, t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    }
    lut[x] = clamp(Math.round(y), 0, 255);
  }
  return lut;
}

export const CURVE_PRESETS: [string, string][] = [
  ["Default", CURVES_IDENTITY],
  ["Increase Contrast", "0,0;64,52;192,204;255,255|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Strong Contrast", "0,0;64,40;192,216;255,255|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Lighter", "0,0;128,160;255,255|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Darker", "0,0;128,96;255,255|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Linear Contrast", "0,0;32,16;224,240;255,255|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Fade (Matte)", "0,40;64,72;192,200;255,240|0,0;255,255|0,0;255,255|0,0;255,255"],
  ["Cross Process", "0,0;255,255|0,0;64,40;192,220;255,255|0,0;64,56;192,210;255,255|0,40;255,210"],
  ["Negative", "0,255;255,0|0,0;255,255|0,0;255,255|0,0;255,255"],
];

// ------------------------------------------------------------------ Color Balance

function colorBalance(src: Img, p: Record<string, number | boolean>): Img {
  // Weights for shadows / midtones / highlights by lightness (as in PS: smooth overlapping bands).
  const tones = ["s", "m", "h"] as const;
  const shift = tones.map((t) => [Number(p[t + "CR"]) || 0, Number(p[t + "MG"]) || 0, Number(p[t + "YB"]) || 0]);
  return mapRGB(src, (r, g, b) => {
    const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
    const ws = clamp((0.333 - l) / 0.25 + 0.5, 0, 1) * 0.7;
    const wh = clamp((l - 0.667) / 0.25 + 0.5, 0, 1) * 0.7;
    const wm = clamp(1 - Math.abs(l - 0.5) * 3, 0, 1) * 0.7;
    const w = [ws, wm, wh];
    let dr = 0, dg = 0, db = 0;
    for (let k = 0; k < 3; k++) {
      dr += shift[k][0] * w[k];
      dg += shift[k][1] * w[k];
      db += shift[k][2] * w[k];
    }
    let R = r + dr, G = g + dg, B = b + db;
    if (p.preserve) {
      // Keep the original luminosity.
      const before = 0.299 * r + 0.587 * g + 0.114 * b, after = 0.299 * R + 0.587 * G + 0.114 * B;
      const k = before - after;
      R += k;
      G += k;
      B += k;
    }
    return [R, G, B];
  });
}

// ------------------------------------------------------------------ the filters

const levelsParam: ParamDef = { key: "levels", label: "Levels", type: "levels", default: LEVELS_IDENTITY };
const curvesParam: ParamDef = { key: "curves", label: "Curves", type: "curves", default: CURVES_IDENTITY };

const PHOTO_FILTERS: [string, string, string][] = [
  ["warm85", "Warming Filter (85)", "#ec8a00"],
  ["warmLBA", "Warming Filter (LBA)", "#fa9600"],
  ["warm81", "Warming Filter (81)", "#ebb113"],
  ["cool80", "Cooling Filter (80)", "#006dff"],
  ["coolLBB", "Cooling Filter (LBB)", "#005dff"],
  ["cool82", "Cooling Filter (82)", "#00b5ff"],
  ["red", "Red", "#ea1a1a"],
  ["orange", "Orange", "#f28413"],
  ["yellow", "Yellow", "#f9e31c"],
  ["green", "Green", "#19c919"],
  ["cyan", "Cyan", "#1dcbea"],
  ["blue", "Blue", "#1d35ea"],
  ["violet", "Violet", "#9b1dea"],
  ["magenta", "Magenta", "#e318e3"],
  ["sepia", "Sepia", "#ac7a33"],
  ["underwater", "Underwater", "#00c1b1"],
  ["custom", "Custom (color below)", ""],
];

export const toneFilters: FilterDef[] = [
  {
    id: "levels",
    name: "Levels",
    category: T,
    description: "Set the black point, white point and midtone brightness, overall or per channel, with a live histogram. Auto finds them for you.",
    adjustment: true,
    tags: ["levels", "black point", "white point", "gamma", "histogram"],
    params: [levelsParam],
    run(src, p) {
      const ch = parseLevels(p.levels);
      const master = levelsLUT(ch[0]);
      const luts = [1, 2, 3].map((c) => {
        const l = levelsLUT(ch[c]);
        const out = new Uint8Array(256);
        for (let i = 0; i < 256; i++) out[i] = master[l[i]];
        return out;
      });
      return mapRGB(src, (r, g, b) => [luts[0][r], luts[1][g], luts[2][b]]);
    },
  },
  {
    id: "curves",
    name: "Curves",
    category: T,
    description: "Reshape the tones with a curve: click to add points and drag them, overall or per channel. Presets for contrast, fades and cross processing.",
    adjustment: true,
    tags: ["curves", "contrast", "tone curve"],
    params: [curvesParam],
    run(src, p) {
      const c = parseCurves(p.curves);
      const master = curveLUTFrom(c[0]);
      const luts = [1, 2, 3].map((k) => {
        const l = curveLUTFrom(c[k]);
        const out = new Uint8Array(256);
        for (let i = 0; i < 256; i++) out[i] = master[l[i]];
        return out;
      });
      return mapRGB(src, (r, g, b) => [luts[0][r], luts[1][g], luts[2][b]]);
    },
  },
  {
    id: "colorBalance",
    name: "Color Balance",
    category: T,
    description: "Push the shadows, midtones and highlights toward red, green or blue (or away, toward cyan, magenta or yellow).",
    adjustment: true,
    tags: ["color balance", "tint", "cast"],
    params: [
      range("sCR", "Shadows: Cyan ↔ Red", -100, 100, 0),
      range("sMG", "Shadows: Magenta ↔ Green", -100, 100, 0),
      range("sYB", "Shadows: Yellow ↔ Blue", -100, 100, 0),
      range("mCR", "Midtones: Cyan ↔ Red", -100, 100, 0),
      range("mMG", "Midtones: Magenta ↔ Green", -100, 100, 0),
      range("mYB", "Midtones: Yellow ↔ Blue", -100, 100, 0),
      range("hCR", "Highlights: Cyan ↔ Red", -100, 100, 0),
      range("hMG", "Highlights: Magenta ↔ Green", -100, 100, 0),
      range("hYB", "Highlights: Yellow ↔ Blue", -100, 100, 0),
      check("preserve", "Preserve Luminosity", true),
    ],
    run: (src, p) => colorBalance(src, p),
  },
  {
    id: "photoFilter",
    name: "Photo Filter",
    category: T,
    description: "Like a colored filter on the lens: warming, cooling, or any color, with density.",
    adjustment: true,
    tags: ["warming", "cooling", "tint", "lens filter"],
    params: [sel("filter", "Filter", PHOTO_FILTERS.map(([v, l]) => [v, l]), "warm85"), color("color", "Custom Color", "#ec8a00"), pct("density", "Density", 25), check("preserve", "Preserve Luminosity", true)],
    run(src, p) {
      const preset = PHOTO_FILTERS.find((f) => f[0] === p.filter);
      const hex = preset && preset[2] ? preset[2] : p.color;
      const [fr, fg, fb] = hexRGB(hex);
      const k = p.density / 100;
      return mapRGB(src, (r, g, b) => {
        // Multiply by the filter color, mixed in by density.
        let R = r * (1 - k + (k * fr) / 255), G = g * (1 - k + (k * fg) / 255), B = b * (1 - k + (k * fb) / 255);
        if (p.preserve) {
          const before = 0.299 * r + 0.587 * g + 0.114 * b, after = 0.299 * R + 0.587 * G + 0.114 * B;
          const s = after > 0.5 ? before / after : 1;
          R *= s;
          G *= s;
          B *= s;
        }
        return [R, G, B];
      });
    },
  },
];
