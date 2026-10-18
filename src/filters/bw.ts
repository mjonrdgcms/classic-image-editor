/**
 * The Black & White Lab's conversion.
 *
 * Gray comes from six color sliders the way a photographer uses lens
 * filters: each pixel's gray = its darkest channel, plus how much of its
 * strongest primary (red, green or blue) and its secondary (yellow, cyan
 * or magenta) the sliders let through. Then local contrast, a parametric
 * tone curve, film grain, vignette, halation and toning.
 */

import { grain, vignette } from "./fx";
import { Img, RGB, clamp, cloneImg, curveLUT, gauss1, hsvToRgb, lerp, luma } from "./img";

export interface BWSettings {
  reds: number;
  yellows: number;
  greens: number;
  cyans: number;
  blues: number;
  magentas: number;
  brightness: number;
  contrast: number;
  blacks: number;
  shadows: number;
  highlights: number;
  whites: number;
  clarity: number;
  grain: number;
  grainSize: number;
  grainRough: number;
  glow: number;
  vignette: number;
  vignetteSize: number;
  toning: string;
  toneAmount: number;
  shadowHue: number;
  shadowSat: number;
  highlightHue: number;
  highlightSat: number;
  toneBalance: number;
  seed: number;
}

export const BW_DEFAULTS: BWSettings = {
  reds: 40,
  yellows: 60,
  greens: 40,
  cyans: 60,
  blues: 20,
  magentas: 80,
  brightness: 0,
  contrast: 0,
  blacks: 0,
  shadows: 0,
  highlights: 0,
  whites: 0,
  clarity: 0,
  grain: 0,
  grainSize: 1.4,
  grainRough: 50,
  glow: 0,
  vignette: 0,
  vignetteSize: 50,
  toning: "none",
  toneAmount: 50,
  shadowHue: 220,
  shadowSat: 30,
  highlightHue: 40,
  highlightSat: 30,
  toneBalance: 0,
  seed: 1,
};

export const COLOR_KEYS = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export const COLOR_HUES: Record<ColorKey, number> = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

/** Toning recipes: [shadow hue, shadow sat, highlight hue, highlight sat] (sat 0..100). */
export const TONINGS: Record<string, { label: string; tone?: [number, number, number, number] }> = {
  none: { label: "None (Neutral)" },
  sepia: { label: "Sepia", tone: [30, 45, 40, 35] },
  selenium: { label: "Selenium", tone: [320, 22, 30, 6] },
  platinum: { label: "Platinum / Palladium", tone: [30, 25, 45, 18] },
  cyanotype: { label: "Cyanotype", tone: [212, 65, 200, 40] },
  gold: { label: "Gold", tone: [225, 20, 45, 22] },
  coffee: { label: "Coffee", tone: [25, 55, 35, 20] },
  blueSteel: { label: "Blue Steel", tone: [215, 30, 210, 8] },
  split: { label: "Split Tone (Custom)" },
};

/** Gray value 0..255 for one pixel under the color sliders (percent). */
export function grayFor(r: number, g: number, b: number, w: number[]): number {
  // w: [reds, yellows, greens, cyans, blues, magentas] as fractions.
  let mx: number, md: number, mn: number, prim: number, sec: number;
  if (r >= g && r >= b) {
    mx = r;
    prim = w[0];
    if (g >= b) {
      md = g;
      mn = b;
      sec = w[1];
    } else {
      md = b;
      mn = g;
      sec = w[5];
    }
  } else if (g >= r && g >= b) {
    mx = g;
    prim = w[2];
    if (r >= b) {
      md = r;
      mn = b;
      sec = w[1];
    } else {
      md = b;
      mn = r;
      sec = w[3];
    }
  } else {
    mx = b;
    prim = w[4];
    if (r >= g) {
      md = r;
      mn = g;
      sec = w[5];
    } else {
      md = g;
      mn = r;
      sec = w[3];
    }
  }
  return mn + (mx - md) * prim + (md - mn) * sec;
}

/** Which slider governs this color most (for click-and-drag on the image). */
export function dominantColor(r: number, g: number, b: number): ColorKey {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 8) return "reds";
  let h: number;
  if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  return COLOR_KEYS[Math.round(h) % 6];
}

/** The tone curve as a 256-entry LUT. */
export function toneLUT(s: BWSettings): Uint8ClampedArray {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 16; i++) {
    const x = i / 16;
    let y = x;
    // Brightness: gamma-like midtone lift.
    if (s.brightness) y = Math.pow(y, Math.pow(2, -s.brightness / 70));
    // Contrast: S-curve around the middle.
    if (s.contrast) {
      const k = s.contrast / 100;
      const sc = 0.5 + (y - 0.5) * (1 + k * 1.2);
      const soft = y + (Math.sin((y - 0.5) * Math.PI) * 0.5 + 0.5 - y) * k;
      y = k > 0 ? lerp(sc, soft, 0.6) : 0.5 + (y - 0.5) * (1 + k * 0.8);
    }
    const bump = (c: number, wdt: number) => Math.exp(-((x - c) ** 2) / (2 * wdt * wdt));
    y += (s.blacks / 100) * 0.18 * Math.pow(1 - x, 4);
    y += (s.shadows / 100) * 0.16 * bump(0.25, 0.12);
    y += (s.highlights / 100) * 0.16 * bump(0.75, 0.12);
    y += (s.whites / 100) * 0.18 * Math.pow(x, 4);
    pts.push([x * 255, clamp(y, 0, 1) * 255]);
  }
  // Keep it monotone so tones never flip.
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  return curveLUT(pts);
}

/** Tint color for a gray value under the toning settings (luminance kept). */
function toneColor(v: number, s: BWSettings): RGB {
  let tone = TONINGS[s.toning]?.tone;
  if (s.toning === "split") tone = [s.shadowHue, s.shadowSat, s.highlightHue, s.highlightSat];
  if (!tone) return [v, v, v];
  const amt = s.toneAmount / 50;
  const l = v / 255;
  const bal = s.toneBalance / 100;
  const wh = clamp((l - 0.5 + bal * 0.5) * 2.2 + 0.5, 0, 1);
  const hue = lerpHue(tone[0], tone[2], wh);
  const sat = clamp(lerp(tone[1], tone[3], wh) / 100 * amt, 0, 1) * (1 - Math.pow(Math.abs(l - 0.5) * 2, 3) * 0.6);
  const c = hsvToRgb(hue, sat, 1);
  const cl = luma(c[0], c[1], c[2]) / 255;
  return [clamp((c[0] / 255 / cl) * v), clamp((c[1] / 255 / cl) * v), clamp((c[2] / 255 / cl) * v)];
}
function lerpHue(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return a + d * t;
}

/** Convert an image (straight RGBA). `scale` shrinks pixel radii for previews. */
export function blackWhite(src: Img, s: BWSettings, scale = 1, fullSize?: { w: number; h: number }): Img {
  const { w, h } = src;
  const n = w * h;
  const wts = COLOR_KEYS.map((k) => s[k] / 100);
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = grayFor(src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2], wts);
  // Clarity: midtone local contrast with a radius tied to the picture size.
  if (s.clarity) {
    const side = fullSize ? Math.max(fullSize.w, fullSize.h) : Math.max(w, h);
    const rad = Math.max(2, side * 0.015) * scale;
    const bl = gauss1(gray, w, h, rad);
    const k = s.clarity / 70;
    for (let i = 0; i < n; i++) {
      const l = clamp(gray[i] / 255, 0, 1);
      gray[i] += (gray[i] - bl[i]) * k * (1 - Math.pow(2 * l - 1, 2));
    }
  }
  const lut = toneLUT(s);
  const out = cloneImg(src);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    const v = lut[Math.round(clamp(gray[i]))];
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  let img = out;
  // Halation / infrared glow from the highlights.
  if (s.glow > 0) {
    const g2 = new Float32Array(n);
    for (let i = 0; i < n; i++) g2[i] = Math.max(0, d[i * 4] - 150) * 1.6;
    const bl = gauss1(g2, w, h, Math.max(1, Math.max(w, h) * 0.01));
    const k = s.glow / 100;
    for (let i = 0; i < n; i++) {
      const v = d[i * 4];
      const sc = 255 - ((255 - v) * (255 - clamp(bl[i] * k))) / 255;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = sc;
    }
  }
  if (s.grain > 0) {
    const size = Math.max(0.5, s.grainSize * Math.max(scale, 0.35));
    img = grain(img, s.grain * 0.55 * (0.6 + s.grainRough / 125), size, true, s.seed);
    // Rough grain: a second, coarser layer.
    if (s.grainRough > 50) img = grain(img, s.grain * 0.2 * ((s.grainRough - 50) / 50), size * 2.2, true, s.seed + 1);
  }
  if (s.vignette) img = vignette(img, Math.abs(s.vignette) / 100, 0.35 + s.vignetteSize / 100, 1, s.vignette > 0 ? [0, 0, 0] : [255, 255, 255]);
  if (s.toning !== "none") {
    const id = img.data;
    for (let i = 0; i < n; i++) {
      const c = toneColor(id[i * 4], s);
      id[i * 4] = c[0];
      id[i * 4 + 1] = c[1];
      id[i * 4 + 2] = c[2];
    }
  }
  return img;
}

export interface BWPreset {
  name: string;
  group: string;
  s: Partial<BWSettings>;
}

const w = (r: number, y: number, g: number, c: number, b: number, m: number): Partial<BWSettings> => ({ reds: r, yellows: y, greens: g, cyans: c, blues: b, magentas: m });

export const BW_PRESETS: BWPreset[] = [
  { name: "Neutral", group: "Filters", s: {} },
  { name: "Red Filter", group: "Filters", s: { ...w(120, 110, -10, -50, -50, 120), contrast: 15 } },
  { name: "Orange Filter", group: "Filters", s: { ...w(100, 100, 20, -20, -30, 70), contrast: 8 } },
  { name: "Yellow Filter", group: "Filters", s: w(120, 110, 40, -30, 0, 70) },
  { name: "Green Filter", group: "Filters", s: w(40, 100, 150, 80, -20, 40) },
  { name: "Blue Filter", group: "Filters", s: w(-10, 0, 10, 120, 150, 60) },
  { name: "Infrared", group: "Filters", s: { ...w(-40, 235, 144, -68, -3, -107), glow: 45, contrast: 10 } },
  { name: "Maximum White", group: "Filters", s: w(100, 100, 100, 100, 100, 100) },
  { name: "Maximum Black", group: "Filters", s: w(0, 0, 0, 0, 0, 0) },
  { name: "Lighter", group: "Filters", s: w(70, 80, 70, 80, 50, 90) },
  { name: "Darker", group: "Filters", s: w(15, 30, 15, 30, 0, 50) },

  { name: "Tri-X 400", group: "Film", s: { ...w(50, 75, 40, 50, 15, 70), contrast: 28, blacks: -10, grain: 38, grainSize: 1.6, grainRough: 60, seed: 4 } },
  { name: "HP5 Plus", group: "Film", s: { ...w(45, 65, 45, 55, 25, 75), contrast: 10, shadows: 12, grain: 32, grainSize: 1.4, grainRough: 45, seed: 5 } },
  { name: "T-Max 100", group: "Film", s: { ...w(40, 60, 45, 60, 25, 80), contrast: 16, clarity: 15, grain: 8, grainSize: 0.8, grainRough: 20, seed: 6 } },
  { name: "Neopan Acros", group: "Film", s: { ...w(35, 60, 55, 60, 25, 70), contrast: 20, highlights: 8, grain: 8, grainSize: 0.8, grainRough: 25, seed: 7 } },
  { name: "Delta 3200", group: "Film", s: { ...w(45, 70, 40, 50, 20, 70), contrast: 30, blacks: 18, grain: 70, grainSize: 2.4, grainRough: 85, seed: 8 } },
  { name: "Pan F 50", group: "Film", s: { ...w(45, 65, 40, 55, 15, 75), contrast: 38, blacks: -25, whites: 10, grain: 4, grainSize: 0.7, seed: 9 } },
  { name: "Kodak Portra BW", group: "Film", s: { ...w(70, 80, 40, 45, 20, 75), contrast: -8, shadows: 15, highlights: -8, grain: 14, grainSize: 1.1, seed: 10 } },

  { name: "Ansel (Landscape)", group: "Looks", s: { ...w(120, 110, 10, -40, -40, 110), contrast: 22, clarity: 45, blacks: -15, whites: 12 } },
  { name: "Film Noir", group: "Looks", s: { ...w(50, 70, 40, 50, 15, 70), contrast: 55, blacks: -35, shadows: -15, vignette: 45, vignetteSize: 40, grain: 20, grainSize: 1.3 } },
  { name: "Soft Portrait", group: "Looks", s: { ...w(85, 85, 40, 55, 15, 80), contrast: -12, highlights: 10, shadows: 18, clarity: -25, glow: 18 } },
  { name: "Street Grit", group: "Looks", s: { ...w(45, 65, 40, 55, 20, 70), contrast: 45, clarity: 55, grain: 45, grainSize: 1.8, grainRough: 70, vignette: 25 } },
  { name: "Silver Gelatin", group: "Looks", s: { ...w(45, 65, 40, 60, 20, 80), contrast: 18, toning: "selenium", toneAmount: 40, grain: 10 } },
  { name: "Holga", group: "Looks", s: { ...w(50, 70, 40, 50, 15, 70), contrast: 40, vignette: 75, vignetteSize: 30, grain: 30, grainSize: 1.8, glow: 15 } },
  { name: "High Key", group: "Looks", s: { ...w(80, 90, 70, 80, 50, 90), brightness: 35, contrast: -20, whites: 25, shadows: 30 } },
  { name: "Low Key", group: "Looks", s: { ...w(30, 45, 25, 40, 10, 55), brightness: -30, contrast: 35, blacks: -30, vignette: 35 } },
  { name: "Antique Sepia", group: "Looks", s: { contrast: -10, blacks: 25, toning: "sepia", toneAmount: 70, grain: 25, vignette: 40, vignetteSize: 45 } },
  { name: "Cyanotype Print", group: "Looks", s: { ...w(70, 80, 50, 40, 10, 70), contrast: 15, toning: "cyanotype", toneAmount: 80 } },
  { name: "Platinum Print", group: "Looks", s: { contrast: -6, blacks: 20, shadows: 8, toning: "platinum", toneAmount: 55 } },
];

/** Find colors sliders that spread gray tones the widest (Auto). */
export function autoWeights(src: Img): Partial<BWSettings> {
  const n = src.w * src.h;
  const step = Math.max(1, Math.floor(n / 6000));
  const score = (wv: number[]) => {
    let s = 0, s2 = 0, k = 0, clip = 0;
    for (let i = 0; i < n; i += step) {
      const v = grayFor(src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2], wv);
      s += v;
      s2 += v * v;
      if (v < 2 || v > 253) clip++;
      k++;
    }
    const m = s / k;
    return Math.sqrt(Math.max(0, s2 / k - m * m)) - (clip / k) * 300 - Math.abs(m - 128) * 0.15;
  };
  let best = [0.4, 0.6, 0.4, 0.6, 0.2, 0.8];
  let bs = score(best);
  let rnd = 12345;
  const r = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < 300; it++) {
    const c = best.map((v) => clamp(v + (r() - 0.5) * (it < 150 ? 0.8 : 0.3), -0.5, 2));
    const sc = score(c);
    if (sc > bs) {
      bs = sc;
      best = c;
    }
  }
  const out: Partial<BWSettings> = {};
  COLOR_KEYS.forEach((k, i) => (out[k] = Math.round(best[i] * 100)));
  return out;
}
