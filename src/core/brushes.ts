/**
 * Brush presets: the Brushes palette's data. A preset is a tip (round with
 * hardness, or a sampled grayscale image) plus PS7's dynamics sections.
 */

export interface SampledTip {
  w: number;
  h: number;
  /** Opacity per pixel, 0..255 (dark areas of the source become opaque). */
  data: Uint8Array;
}

export interface ShapeDynamics {
  sizeJitter: number; // 0..100 %
  sizeControl: "off" | "fade" | "pressure";
  fadeSteps: number;
  minDiameter: number; // 0..100 %
  angleJitter: number; // 0..100 % of 360
  angleControl: "off" | "direction" | "pressure";
  roundnessJitter: number; // 0..100 %
  minRoundness: number; // 0..100 %
}

export interface Scattering {
  amount: number; // 0..1000 % of diameter
  bothAxes: boolean;
  count: number; // 1..16
  countJitter: number; // 0..100 %
}

export interface ColorDynamics {
  fgBgJitter: number; // 0..100 %
  hueJitter: number;
  saturationJitter: number;
  brightnessJitter: number;
}

export interface OtherDynamics {
  opacityJitter: number; // 0..100 %
  opacityControl: "off" | "fade" | "pressure";
  flowJitter: number;
  flowControl: "off" | "fade" | "pressure";
  fadeSteps: number;
}

export interface BrushPreset {
  name: string;
  /** Diameter in pixels. */
  size: number;
  /** Round tips only, 0..100. */
  hardness: number;
  sampled: SampledTip | null;
  /** % of diameter. */
  spacing: number;
  angle: number; // degrees
  roundness: number; // 1..100 %
  shape: ShapeDynamics | null;
  scatter: Scattering | null;
  color: ColorDynamics | null;
  other: OtherDynamics | null;
  noise: boolean;
  airbrush: boolean;
}

export const DEFAULT_SHAPE: ShapeDynamics = {
  sizeJitter: 0,
  sizeControl: "off",
  fadeSteps: 25,
  minDiameter: 0,
  angleJitter: 0,
  angleControl: "off",
  roundnessJitter: 0,
  minRoundness: 25,
};
export const DEFAULT_SCATTER: Scattering = { amount: 0, bothAxes: false, count: 1, countJitter: 0 };
export const DEFAULT_COLOR: ColorDynamics = { fgBgJitter: 0, hueJitter: 0, saturationJitter: 0, brightnessJitter: 0 };
export const DEFAULT_OTHER: OtherDynamics = { opacityJitter: 0, opacityControl: "off", flowJitter: 0, flowControl: "off", fadeSteps: 25 };

export function roundBrush(size: number, hardness: number, name?: string): BrushPreset {
  return {
    name: name ?? `${hardness >= 100 ? "Hard" : "Soft"} Round ${size} pixels`,
    size,
    hardness,
    sampled: null,
    spacing: 25,
    angle: 0,
    roundness: 100,
    shape: null,
    scatter: null,
    color: null,
    other: null,
    noise: false,
    airbrush: false,
  };
}

// ---------------------------------------------------------------- procedural sampled tips

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTip(size: number, fn: (x: number, y: number, rnd: () => number) => number, seed = 1): SampledTip {
  const rnd = mulberry(seed);
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = Math.max(0, Math.min(255, Math.round(fn(x, y, rnd) * 255)));
  return { w: size, h: size, data };
}

function spatterTip(size: number): SampledTip {
  const rnd = mulberry(7);
  const dots = Array.from({ length: 22 }, () => {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * size * 0.42;
    return { x: size / 2 + Math.cos(a) * d, y: size / 2 + Math.sin(a) * d, r: 0.8 + rnd() * size * 0.07 };
  });
  return makeTip(size, (x, y) => {
    let v = 0;
    for (const p of dots) v = Math.max(v, Math.min(1, Math.max(0, p.r + 0.5 - Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y))));
    return v;
  });
}

function chalkTip(size: number): SampledTip {
  return makeTip(size, (x, y, rnd) => {
    const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
    return d > 1 ? 0 : (1 - d * d) * (rnd() < 0.55 ? 1 : 0.25);
  }, 11);
}

function starTip(size: number): SampledTip {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = (i % 2 ? 0.2 : 0.48) * size;
    pts.push([size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r]);
  }
  const inside = (x: number, y: number) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return makeTip(size, (x, y) => {
    let n = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) n++;
    return n / 9;
  });
}

function grassTip(size: number): SampledTip {
  const rnd = mulberry(3);
  const blades = Array.from({ length: 9 }, () => ({ x: size * (0.2 + rnd() * 0.6), lean: (rnd() - 0.5) * 0.6, h: 0.5 + rnd() * 0.45 }));
  return makeTip(size, (x, y) => {
    let v = 0;
    for (const b of blades) {
      const t = 1 - (y + 0.5) / size;
      if (t > b.h) continue;
      const cx = b.x + b.lean * t * size;
      const w = 1.4 * (1 - t / b.h) + 0.3;
      v = Math.max(v, Math.min(1, Math.max(0, w - Math.abs(x + 0.5 - cx))));
    }
    return v;
  });
}

export function defaultBrushes(): BrushPreset[] {
  const out: BrushPreset[] = [];
  for (const s of [1, 3, 5, 9, 13, 19]) out.push(roundBrush(s, 100));
  for (const s of [5, 9, 13, 17, 21, 27, 35, 45, 65, 100, 200, 300]) out.push(roundBrush(s, 0));
  const sampled = (name: string, tip: SampledTip, extra: Partial<BrushPreset>): BrushPreset => ({
    ...roundBrush(tip.w, 100),
    name,
    sampled: tip,
    ...extra,
  });
  out.push(sampled("Spatter 39 pixels", spatterTip(39), { spacing: 25, shape: { ...DEFAULT_SHAPE, angleJitter: 100, sizeJitter: 30 } }));
  out.push(sampled("Chalk 36 pixels", chalkTip(36), { spacing: 15 }));
  out.push(sampled("Star 33 pixels", starTip(33), { spacing: 120, shape: { ...DEFAULT_SHAPE, angleJitter: 100, sizeJitter: 60 }, scatter: { ...DEFAULT_SCATTER, amount: 150 } }));
  out.push(
    sampled("Dune Grass 50 pixels", grassTip(50), {
      spacing: 25,
      shape: { ...DEFAULT_SHAPE, sizeJitter: 40, angleJitter: 8, roundnessJitter: 0 },
      scatter: { ...DEFAULT_SCATTER, amount: 60, bothAxes: true, count: 2 },
      color: { ...DEFAULT_COLOR, fgBgJitter: 100, hueJitter: 5 },
    }),
  );
  return out;
}

// ---------------------------------------------------------------- serialization

/** JSON-friendly copy (sampled tips as base64). */
export function presetToJSON(p: BrushPreset): unknown {
  return {
    ...p,
    sampled: p.sampled ? { w: p.sampled.w, h: p.sampled.h, b64: bytesToB64(p.sampled.data) } : null,
  };
}

export function presetFromJSON(o: any): BrushPreset {
  const base = roundBrush(13, 100);
  const p = { ...base, ...o } as BrushPreset;
  if (o?.sampled?.b64) p.sampled = { w: o.sampled.w, h: o.sampled.h, data: b64ToBytes(o.sampled.b64) };
  else if (o?.sampled?.data) p.sampled = { w: o.sampled.w, h: o.sampled.h, data: Uint8Array.from(o.sampled.data) };
  else p.sampled = null;
  return p;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export { mulberry };
