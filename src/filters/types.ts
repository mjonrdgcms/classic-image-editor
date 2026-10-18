/** What a filter is: metadata, parameters, and a pure function on pixels. */

import type { Img, RGB } from "./img";

export type ParamDef =
  | { key: string; label: string; type: "range"; min: number; max: number; step?: number; default: number; unit?: string; /** A distance in pixels: scaled down for previews. */ px?: boolean }
  | { key: string; label: string; type: "select"; options: [string, string][]; default: string }
  | { key: string; label: string; type: "check"; default: boolean }
  | { key: string; label: string; type: "color"; default: string }
  | { key: string; label: string; type: "seed"; default: number }
  /** Levels settings for RGB, R, G, B in one string (see defs/tone.ts). */
  | { key: string; label: string; type: "levels"; default: string }
  /** Curve points for RGB, R, G, B in one string (see defs/tone.ts). */
  | { key: string; label: string; type: "curves"; default: string };

export interface FilterEnv {
  fg: RGB;
  bg: RGB;
  /** 1 for the real image, smaller for previews (already applied to px params). */
  scale: number;
}

export interface FilterDef {
  /** Stable id; the command is "filter.<id>". */
  id: string;
  name: string;
  category: string;
  description: string;
  params: ParamDef[];
  run(src: Img, p: Record<string, any>, env: FilterEnv): Img;
  /** Extra pixels of context needed around a selection (blurs, distortions). */
  pad?(p: Record<string, any>): number;
  /** The filter sets its own alpha (blurs, distortions, renders). */
  ownAlpha?: boolean;
  /** Search words. */
  tags?: string[];
  /** Shown under Image > Adjustments as well. */
  adjustment?: boolean;
}

export const CATEGORIES = [
  "Cartoon & Comic",
  "Artistic",
  "Sketch",
  "Blur",
  "Sharpen",
  "Noise",
  "Distort",
  "Pixelate",
  "Stylize",
  "Render",
  "Photo Looks",
  "Retro & Pixel",
  "Texture",
  "Color & Tone",
  "Other",
] as const;

export function defaults(def: FilterDef): Record<string, any> {
  const o: Record<string, any> = {};
  for (const p of def.params) o[p.key] = p.default;
  return o;
}

/** Scale pixel-distance parameters for a preview made at `scale`. */
export function scaled(def: FilterDef, p: Record<string, any>, scale: number): Record<string, any> {
  if (scale >= 1) return p;
  const o = { ...p };
  for (const d of def.params) if (d.type === "range" && d.px && typeof o[d.key] === "number") o[d.key] = o[d.key] * scale;
  return o;
}

/** Run a filter, restoring the source alpha unless it manages its own. */
export function runFilter(def: FilterDef, src: Img, p: Record<string, any>, env: FilterEnv): Img {
  const out = def.run(src, scaled(def, p, env.scale), env);
  if (!def.ownAlpha && out !== src) {
    const d = out.data, s = src.data;
    for (let i = 3; i < d.length; i += 4) d[i] = s[i];
  }
  return out;
}
