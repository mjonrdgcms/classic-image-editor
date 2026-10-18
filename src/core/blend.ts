/**
 * Layer blend modes: the PS7 set (22 modes, plus Pass Through for layer sets
 * in a later milestone).
 *
 * This is the CPU reference implementation. The GPU compositor in
 * src/gl/shaders.ts implements the same math, and the e2e suite checks the
 * two agree pixel for pixel (within rounding). Formulas follow the W3C
 * Compositing and Blending spec, which matches Photoshop closely; Dissolve
 * uses a deterministic per-pixel hash so CPU and GPU pick the same pixels.
 */

export const BLEND_MODES = [
  "normal",
  "dissolve",
  "darken",
  "multiply",
  "colorBurn",
  "linearBurn",
  "lighten",
  "screen",
  "colorDodge",
  "linearDodge",
  "overlay",
  "softLight",
  "hardLight",
  "vividLight",
  "linearLight",
  "pinLight",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/** Menu labels, with PS7's separator groups marked by a leading "-". */
export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: "Normal",
  dissolve: "Dissolve",
  darken: "Darken",
  multiply: "Multiply",
  colorBurn: "Color Burn",
  linearBurn: "Linear Burn",
  lighten: "Lighten",
  screen: "Screen",
  colorDodge: "Color Dodge",
  linearDodge: "Linear Dodge",
  overlay: "Overlay",
  softLight: "Soft Light",
  hardLight: "Hard Light",
  vividLight: "Vivid Light",
  linearLight: "Linear Light",
  pinLight: "Pin Light",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

/** Index of the first mode in each separator group, for menus. */
export const BLEND_GROUP_STARTS = new Set<BlendMode>(["darken", "lighten", "overlay", "difference", "hue"]);

export function blendIndex(m: BlendMode): number {
  return BLEND_MODES.indexOf(m);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- separable channel functions: b = backdrop, s = source, both 0..1 ----

function colorBurn(b: number, s: number): number {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
}
function colorDodge(b: number, s: number): number {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
}
function hardLight(b: number, s: number): number {
  return s <= 0.5 ? b * 2 * s : screen(b, 2 * s - 1);
}
function screen(b: number, s: number): number {
  return b + s - b * s;
}
function softLight(b: number, s: number): number {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
}
function vividLight(b: number, s: number): number {
  return s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1);
}
function pinLight(b: number, s: number): number {
  return s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1);
}

function separable(mode: BlendMode, b: number, s: number): number {
  switch (mode) {
    case "darken":
      return Math.min(b, s);
    case "multiply":
      return b * s;
    case "colorBurn":
      return colorBurn(b, s);
    case "linearBurn":
      return clamp01(b + s - 1);
    case "lighten":
      return Math.max(b, s);
    case "screen":
      return screen(b, s);
    case "colorDodge":
      return colorDodge(b, s);
    case "linearDodge":
      return clamp01(b + s);
    case "overlay":
      return hardLight(s, b);
    case "softLight":
      return softLight(b, s);
    case "hardLight":
      return hardLight(b, s);
    case "vividLight":
      return vividLight(b, s);
    case "linearLight":
      return clamp01(b + 2 * s - 1);
    case "pinLight":
      return pinLight(b, s);
    case "difference":
      return Math.abs(b - s);
    case "exclusion":
      return b + s - 2 * b * s;
    default:
      return s;
  }
}

// ---- non-separable helpers (W3C) ----

type RGB = [number, number, number];

const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let r: RGB = [c[0], c[1], c[2]];
  if (n < 0) r = r.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return r;
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const sat = (c: RGB) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: RGB, s: number): RGB {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= mn) return [0, 0, 0];
  return c.map((v) => ((v - mn) * s) / (mx - mn)) as RGB;
}

/** B(Cb, Cs) for any mode, on straight RGB in 0..1. */
export function blendRGB(mode: BlendMode, b: RGB, s: RGB): RGB {
  switch (mode) {
    case "hue":
      return setLum(setSat(s, sat(b)), lum(b));
    case "saturation":
      return setLum(setSat(b, sat(s)), lum(b));
    case "color":
      return setLum(s, lum(b));
    case "luminosity":
      return setLum(b, lum(s));
    default:
      return [separable(mode, b[0], s[0]), separable(mode, b[1], s[1]), separable(mode, b[2], s[2])];
  }
}

/** Deterministic per-pixel noise in [0,1), identical to the GLSL version. */
export function dissolveHash(x: number, y: number): number {
  let h = (Math.imul(x >>> 0, 374761393) + Math.imul(y >>> 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffffff) / 16777216;
}

/**
 * Composite one source pixel over one backdrop pixel. All values straight
 * RGBA 0..255; `opacity` 0..1 is the layer opacity. Returns straight RGBA
 * as floats 0..255 (caller rounds). x, y are canvas coordinates (Dissolve).
 */
export function compositePixel(
  mode: BlendMode,
  bd: ArrayLike<number>,
  src: ArrayLike<number>,
  opacity: number,
  x: number,
  y: number,
): [number, number, number, number] {
  let as = (src[3] / 255) * opacity;
  const ab = bd[3] / 255;
  if (mode === "dissolve") as = dissolveHash(x, y) < as ? 1 : 0;
  if (as <= 0) return [bd[0], bd[1], bd[2], bd[3]];
  const cb: RGB = [bd[0] / 255, bd[1] / 255, bd[2] / 255];
  const cs: RGB = [src[0] / 255, src[1] / 255, src[2] / 255];
  let mixed: RGB = cs;
  if (mode !== "normal" && mode !== "dissolve" && ab > 0) {
    const bl = blendRGB(mode, cb, cs);
    mixed = [(1 - ab) * cs[0] + ab * bl[0], (1 - ab) * cs[1] + ab * bl[1], (1 - ab) * cs[2] + ab * bl[2]];
  }
  const ao = as + ab * (1 - as);
  const out: [number, number, number, number] = [0, 0, 0, ao * 255];
  for (let i = 0; i < 3; i++) out[i] = ((mixed[i] * as + cb[i] * ab * (1 - as)) / ao) * 255;
  return out;
}
