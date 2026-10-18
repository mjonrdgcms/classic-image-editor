/** Short constructors for filter parameters. */

import type { ParamDef } from "./types";

export const range = (key: string, label: string, min: number, max: number, def: number, unit?: string, step?: number): ParamDef => ({ key, label, type: "range", min, max, default: def, unit, step });
export const px = (key: string, label: string, min: number, max: number, def: number, step?: number): ParamDef => ({ key, label, type: "range", min, max, default: def, unit: "px", px: true, step });
export const pct = (key: string, label: string, def: number, min = 0, max = 100): ParamDef => ({ key, label, type: "range", min, max, default: def, unit: "%" });
export const angle = (key: string, label: string, def: number, min = -180, max = 180): ParamDef => ({ key, label, type: "range", min, max, default: def, unit: "°" });
export const sel = (key: string, label: string, options: [string, string][], def: string): ParamDef => ({ key, label, type: "select", options, default: def });
export const check = (key: string, label: string, def: boolean): ParamDef => ({ key, label, type: "check", default: def });
export const color = (key: string, label: string, def: string): ParamDef => ({ key, label, type: "color", default: def });
export const seed = (def = 1): ParamDef => ({ key: "seed", label: "Seed", type: "seed", default: def });
