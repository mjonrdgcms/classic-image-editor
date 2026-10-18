/**
 * Patterns: Edit > Define Pattern, Edit > Fill with a pattern, and the
 * Pattern Stamp. A pattern is a small RGBA image tiled from the canvas
 * origin. Commands carry patterns as { w, h, b64 } so Actions replay them.
 */

import type { ObjectSchema } from "./commands";
import { ValidationError } from "./commands";
import { b64, unb64 } from "./b64";
import type { PatternImage } from "./retouch";

export interface NamedPattern extends PatternImage {
  name: string;
}

export const MAX_PATTERN = 1000;

export const PATTERN_SCHEMA: ObjectSchema = {
  type: "object",
  description: "A pattern: width, height and base64 RGBA pixels (row by row)",
  properties: { name: { type: "string" }, w: { type: "integer", minimum: 1, maximum: MAX_PATTERN }, h: { type: "integer", minimum: 1, maximum: MAX_PATTERN }, b64: { type: "string" } },
  required: ["w", "h", "b64"],
};

export function patternToJSON(p: NamedPattern | PatternImage): { name?: string; w: number; h: number; b64: string } {
  return { name: (p as NamedPattern).name, w: p.w, h: p.h, b64: b64(new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength)) };
}

export function patternFromJSON(j: { name?: string; w: number; h: number; b64: string }): NamedPattern {
  const d = unb64(j.b64);
  if (d.length !== j.w * j.h * 4) throw new ValidationError("the pattern's data does not match its size");
  return { name: j.name ?? "Pattern", w: j.w, h: j.h, data: new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength) };
}

/** Fill a canvas-space region with a pattern (straight RGBA). */
export function patternRegion(p: PatternImage, x0: number, y0: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const py = ((((y + y0) % p.h) + p.h) % p.h) * p.w;
    for (let x = 0; x < w; x++) {
      const si = (py + ((((x + x0) % p.w) + p.w) % p.w)) * 4, di = (y * w + x) * 4;
      out[di] = p.data[si];
      out[di + 1] = p.data[si + 1];
      out[di + 2] = p.data[si + 2];
      out[di + 3] = p.data[si + 3];
    }
  }
  return out;
}

function make(name: string, w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]): NamedPattern {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = f(x, y);
      data.set([r, g, b, a], (y * w + x) * 4);
    }
  return { name, w, h, data };
}

const hash = (x: number, y: number, s = 0) => {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth, seamlessly tiling value noise. */
function tileNoise(x: number, y: number, period: number, cells: number, seed: number): number {
  const fx = (x / period) * cells, fy = (y / period) * cells;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const v = (i: number, j: number) => hash(((i % cells) + cells) % cells, ((j % cells) + cells) % cells, seed);
  return (v(x0, y0) * (1 - sx) + v(x0 + 1, y0) * sx) * (1 - sy) + (v(x0, y0 + 1) * (1 - sx) + v(x0 + 1, y0 + 1) * sx) * sy;
}

/** PS7-style starter patterns, drawn here so nothing has to be shipped. */
export function defaultPatterns(): NamedPattern[] {
  return [
    make("Checkerboard", 32, 32, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [60, 60, 60] : [220, 220, 220])),
    make("Stripes", 24, 24, (x, y) => ((x + y) % 24 < 12 ? [40, 90, 170] : [235, 235, 240])),
    make("Dots", 24, 24, (x, y) => (Math.hypot((x % 24) - 12, (y % 24) - 12) < 6 ? [200, 60, 60] : [250, 240, 225])),
    make("Bricks", 64, 32, (x, y) => {
      const row = y >> 4, bx = (x + (row % 2) * 16) % 32, by = y % 16;
      const mortar = by < 2 || bx < 2;
      const n = tileNoise(x, y, 64, 8, 3) * 30;
      return mortar ? [200, 196, 188] : [150 + n, 70 + n / 2, 50];
    }),
    make("Burlap", 64, 64, (x, y) => {
      const wv = (Math.sin((x / 64) * Math.PI * 16) + Math.sin((y / 64) * Math.PI * 16)) * 12;
      const n = tileNoise(x, y, 64, 16, 7) * 40;
      return [170 + wv + n, 140 + wv + n, 95 + wv / 2 + n / 2];
    }),
    make("Wood", 128, 128, (x, y) => {
      const g = Math.sin((y / 128) * Math.PI * 2 * 6 + tileNoise(x, y, 128, 4, 11) * 6) * 0.5 + 0.5;
      const n = tileNoise(x, y, 128, 32, 5) * 18;
      return [130 + g * 50 + n, 85 + g * 35 + n, 45 + g * 20];
    }),
    make("Clouds", 128, 128, (x, y) => {
      let v = 0;
      for (const [c, a] of [[4, 0.5], [8, 0.25], [16, 0.15], [32, 0.1]] as const) v += tileNoise(x, y, 128, c, c) * a;
      return [120 + v * 135, 160 + v * 95, 230];
    }),
    make("Grass", 64, 64, (x, y) => {
      const n = tileNoise(x, y, 64, 16, 21) * 0.7 + tileNoise(x, y, 64, 4, 9) * 0.3;
      return [40 + n * 40, 110 + n * 90, 40 + n * 30];
    }),
  ];
}
