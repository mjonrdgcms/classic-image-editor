/**
 * Edit > Preferences: everything the user can set once and keep, grouped as
 * in Photoshop 7's Preferences dialog. Each value here is read somewhere in
 * the app; nothing is decorative.
 */

import type { DocMode } from "./ui/docwindows";

export type Units = "pixels" | "inches" | "cm" | "mm" | "points" | "picas" | "percent";
export type TypeUnits = "pixels" | "points" | "mm";
export type Interpolation = "nearest" | "bilinear" | "bicubic";
export type RedoKey = "ctrlZ" | "ctrlShiftZ" | "ctrlY";
export type LineStyle = "lines" | "dashed" | "dots";

export interface Preferences {
  // ---- General
  /** Built-in (Photoshop-style) Color Picker, or the system's. */
  colorPicker: "builtin" | "system";
  /** Default resampling for Image Size and Free Transform. */
  interpolation: Interpolation;
  /** Ctrl+Z toggles undo/redo (PS7 default), or Ctrl+Z is multi-level undo with Ctrl+Shift+Z / Ctrl+Y to redo. */
  redoKey: RedoKey;
  historyStates: number;
  showToolTips: boolean;
  /** Zooming with the keyboard resizes a floating image window to fit. */
  zoomResizesWindows: boolean;
  /** The mouse wheel zooms (instead of scrolling; Alt+wheel does the other). */
  zoomWithWheel: boolean;
  /** Play a short sound when a long operation finishes. */
  beepWhenDone: boolean;
  /** The Color palette's slider tracks show the colors each slider would give. */
  dynamicColorSliders: boolean;
  /** Remember where palettes are between sessions. */
  savePaletteLocations: boolean;
  /** Shift+letter cycles the tools sharing a key (off: pressing the letter again cycles). */
  shiftToolSwitch: boolean;
  /** How documents open: in floating windows (PS7 default) or maximized. */
  docMode: DocMode;
  /** Free Transform corner handles keep proportions unless Shift is held (off: the reverse, as in PS7). */
  transformProportional: boolean;
  /** Holding Ctrl switches to the Move tool until it is released. */
  ctrlMove: boolean;
  /** With the Move tool, Ctrl-click flips Auto-Select for that click (Photoshop's way). Off: the Move tool always moves the chosen layers. */
  ctrlAutoSelect: boolean;
  /** Holding Alt with the painting tools switches to the Eyedropper. */
  altEyedropper: boolean;

  // ---- File Handling
  /** Save a preview picture inside .cie files (shown by the system and Open Recent). */
  imagePreviews: boolean;
  /** Extensions of saved copies: .png or .PNG. */
  extensionCase: "lower" | "upper";
  /** How many files Open Recent lists. */
  recentFiles: number;
  /** Save recovery copies of changed images to the scratch disk every N minutes (0: never). */
  recoveryMinutes: number;
  /** Default JPEG quality (0-12) for Save a Copy as JPEG. */
  jpegQuality: number;

  // ---- Display & Cursors
  paintingCursor: "standard" | "precise" | "brushSize";
  otherCursor: "standard" | "precise";
  /** A small crosshair in the middle of brush-size cursors. */
  brushCrosshair: boolean;
  /** Show the pixel grid when zoomed in past 600%. */
  pixelGrid: boolean;

  // ---- Transparency
  checkSize: 0 | 4 | 8 | 16;
  checkColors: "light" | "medium" | "dark";
  /** Layer mask overlay (rubylith) color and opacity (%). */
  maskOverlayColor: string;
  maskOverlayOpacity: number;

  // ---- Units & Rulers
  rulerUnits: Units;
  typeUnits: TypeUnits;
  /** Resolution (pixels per inch) for new images and for opened files that don't say. */
  newResolution: number;
  /** PostScript (72) or traditional (72.27) points per inch. */
  pointsPerInch: 72 | 72.27;

  // ---- Guides, Grid & Slices
  guideColor: string;
  guideStyle: "lines" | "dashed";
  gridColor: string;
  gridStyle: LineStyle;
  /** Gridline spacing, in gridUnits. */
  gridSpacing: number;
  gridUnits: Units;
  gridSubdivisions: number;
  sliceColor: string;
  showSliceNumbers: boolean;

  // ---- Scratch Disks
  /** Up to four folders, used in order (empty: the system's temporary folder). */
  scratchDisks: string[];

  // ---- Memory
  /** How much of the computer's memory images and their history may use, in percent. */
  memoryPercent: number;
}

export const DEFAULT_PREFS: Preferences = {
  colorPicker: "builtin",
  interpolation: "bicubic",
  redoKey: "ctrlZ",
  historyStates: 50,
  showToolTips: true,
  zoomResizesWindows: false,
  zoomWithWheel: false,
  beepWhenDone: false,
  dynamicColorSliders: true,
  savePaletteLocations: true,
  shiftToolSwitch: true,
  docMode: "floating",
  transformProportional: true,
  ctrlMove: true,
  ctrlAutoSelect: false,
  altEyedropper: true,

  imagePreviews: true,
  extensionCase: "lower",
  recentFiles: 12,
  recoveryMinutes: 10,
  jpegQuality: 10,

  paintingCursor: "brushSize",
  otherCursor: "standard",
  brushCrosshair: false,
  pixelGrid: true,

  checkSize: 8,
  checkColors: "light",
  maskOverlayColor: "#ff0000",
  maskOverlayOpacity: 50,

  rulerUnits: "pixels",
  typeUnits: "pixels",
  newResolution: 72,
  pointsPerInch: 72,

  guideColor: "#4aa8ff",
  guideStyle: "lines",
  gridColor: "#8a8a8a",
  gridStyle: "lines",
  gridSpacing: 64,
  gridUnits: "pixels",
  gridSubdivisions: 4,
  sliceColor: "#40a0ff",
  showSliceNumbers: true,

  scratchDisks: [],

  memoryPercent: 50,
};

export const UNIT_LABELS: Record<Units, string> = { pixels: "pixels", inches: "inches", cm: "cm", mm: "mm", points: "points", picas: "picas", percent: "percent" };
export const UNIT_SHORT: Record<Units, string> = { pixels: "px", inches: "in", cm: "cm", mm: "mm", points: "pt", picas: "pc", percent: "%" };

/** Pixels in one unit at a resolution (percent needs the full length). */
export function pxPerUnit(u: Units, ppi: number, ptsPerInch: number, full = 100): number {
  switch (u) {
    case "pixels":
      return 1;
    case "inches":
      return ppi;
    case "cm":
      return ppi / 2.54;
    case "mm":
      return ppi / 25.4;
    case "points":
      return ppi / ptsPerInch;
    case "picas":
      return (ppi / ptsPerInch) * 12;
    case "percent":
      return full / 100;
  }
}

/** Pixels to a unit value. */
export function toUnits(px: number, u: Units, ppi: number, ptsPerInch: number, full = 100): number {
  return px / pxPerUnit(u, ppi, ptsPerInch, full);
}

/** A unit value to pixels. */
export function fromUnits(v: number, u: Units, ppi: number, ptsPerInch: number, full = 100): number {
  return v * pxPerUnit(u, ppi, ptsPerInch, full);
}

/** Saved preferences over the defaults (unknown or mistyped values fall back). */
export function loadPrefs(saved: Partial<Preferences>): Preferences {
  const p = { ...DEFAULT_PREFS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) {
    const d = (DEFAULT_PREFS as unknown as Record<string, unknown>)[k];
    if (d === undefined) continue;
    if (Array.isArray(d) ? Array.isArray(v) : typeof v === typeof d) p[k] = v;
  }
  return p as unknown as Preferences;
}

/** A length for display: whole pixels, two decimals for inches, one for most others. */
export function formatLength(px: number, u: Units, ppi: number, ptsPerInch: number, full = 100): string {
  const v = toUnits(px, u, ppi, ptsPerInch, full);
  const digits = u === "pixels" ? 0 : u === "inches" ? 2 : u === "percent" || u === "cm" || u === "picas" ? 1 : u === "mm" || u === "points" ? 1 : 2;
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}
