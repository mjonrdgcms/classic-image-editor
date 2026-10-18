/**
 * Type layers: a layer whose pixels are rendered from editable text. The
 * text settings live in the layer's props (so history snapshots them); the
 * pixels are re-rendered whenever the text changes. Rendering needs a 2D
 * canvas, so the renderer is plugged in by the UI (tests use a stub).
 */

import type { Document, Layer } from "./document";
import { shiftMask } from "./maskfx";
import { TileGrid } from "./tiles";

export const ANTI_ALIAS = ["none", "sharp", "crisp", "strong", "smooth"] as const;
export type AntiAlias = (typeof ANTI_ALIAS)[number];
export const TEXT_ALIGN = ["left", "center", "right", "justify"] as const;
export type TextAlign = (typeof TEXT_ALIGN)[number];

export interface TextSpec {
  content: string;
  /** Font family (bundled or installed). */
  font: string;
  /** CSS weight 100-900. */
  weight: number;
  italic: boolean;
  /** Size in pixels. */
  size: number;
  /** RGB. */
  color: [number, number, number];
  /** Line spacing in px; 0 = auto (120% of the size). */
  leading: number;
  /** Tracking in 1/1000 em. */
  tracking: number;
  /** Horizontal and vertical scale, percent. */
  hScale: number;
  vScale: number;
  /** Baseline shift in px (up is positive). */
  baselineShift: number;
  align: TextAlign;
  antiAlias: AntiAlias;
  fauxBold: boolean;
  fauxItalic: boolean;
  underline: boolean;
  strikethrough: boolean;
  allCaps: boolean;
  /** Paragraph text: wrap inside this box (layer space, from the anchor). Null = point text. */
  box: { w: number; h: number } | null;
  /** Where the anchor sits inside the layer's pixel grid: point text = first baseline, box = top-left. */
  ax: number;
  ay: number;
}

export const DEFAULT_TEXT: Omit<TextSpec, "content" | "ax" | "ay" | "box"> = {
  font: "Inter",
  weight: 400,
  italic: false,
  size: 48,
  color: [0, 0, 0],
  leading: 0,
  tracking: 0,
  hScale: 100,
  vScale: 100,
  baselineShift: 0,
  align: "left",
  antiAlias: "crisp",
  fauxBold: false,
  fauxItalic: false,
  underline: false,
  strikethrough: false,
  allCaps: false,
};

/** Character and paragraph settings (everything but the text, box and anchor). */
export type TextStyle = typeof DEFAULT_TEXT;
export const STYLE_KEYS = Object.keys(DEFAULT_TEXT) as (keyof TextStyle)[];

/** Rendered text: straight RGBA, with the anchor at (ox, oy) in the bitmap. */
export interface TextBitmap {
  w: number;
  h: number;
  ox: number;
  oy: number;
  data: Uint8ClampedArray;
  /** Height of the first line above its baseline (px), for converting point / paragraph text. */
  ascent?: number;
  /** Drawn with a stand-in font because the real one hasn't loaded yet. */
  fallback?: boolean;
}

export type TextRenderer = (spec: TextSpec) => TextBitmap;

let renderer: TextRenderer = () => ({ w: 1, h: 1, ox: 0, oy: 0, data: new Uint8ClampedArray(4) });

export function setTextRenderer(r: TextRenderer): void {
  renderer = r;
}

/** The anchor point in canvas space. */
export function textAnchor(l: Layer): { x: number; y: number } {
  const t = l.text!;
  return { x: l.offsetX + t.ax, y: l.offsetY + t.ay };
}

/**
 * Re-render a type layer's pixels from its text, keeping the anchor where
 * it is on the canvas. The grid is sized to the text, so moving the layer
 * never clips it. A mask keeps its place on the canvas.
 */
export function renderTextLayer(l: Layer, anchor = textAnchor(l)): { x: number; y: number; w: number; h: number } {
  const t = l.text!;
  const before = l.bounds();
  const bmp = renderer(t);
  const bw = Math.max(1, bmp.w), bh = Math.max(1, bmp.h);
  // Canvas rect of the text; a masked layer never shrinks, so its mask keeps what was painted.
  let x = anchor.x - bmp.ox, y = anchor.y - bmp.oy, w = bw, h = bh;
  if (l.mask) {
    const x1 = Math.max(x + w, before.x + before.w), y1 = Math.max(y + h, before.y + before.h);
    x = Math.min(x, before.x);
    y = Math.min(y, before.y);
    w = x1 - x;
    h = y1 - y;
  }
  const grid = new TileGrid(w, h);
  const dx = anchor.x - bmp.ox - x, dy = anchor.y - bmp.oy - y;
  if (bmp.w > 0 && bmp.h > 0) grid.writeRegion({ x: dx, y: dy, w: bmp.w, h: bmp.h }, bmp.data);
  grid.compact();
  if (l.mask) l.mask = shiftMask(l.mask, l.offsetX - x, l.offsetY - y, w, h);
  l.grid = grid;
  l.offsetX = x;
  l.offsetY = y;
  l.text = { ...t, ax: anchor.x - x, ay: anchor.y - y };
  if (bmp.fallback) fallbackGrids.add(grid);
  const after = l.bounds();
  const x0 = Math.min(before.x, after.x), y0 = Math.min(before.y, after.y);
  return { x: x0, y: y0, w: Math.max(before.x + before.w, after.x + after.w) - x0, h: Math.max(before.y + before.h, after.y + after.h) - y0 };
}

/** Pixels drawn with a stand-in font (redrawn once the font arrives, also after undo / redo). */
const fallbackGrids = new WeakSet<object>();

/** Height above the first baseline, for converting between point and paragraph text. */
export function textAscent(t: TextSpec): number {
  return renderer({ ...t, content: "Hg", box: null }).ascent ?? t.size * 0.8;
}

/**
 * The anchor for `next` that keeps the text where it is when it switches
 * between point text (anchor = first baseline at the alignment point) and
 * paragraph text (anchor = box top-left).
 */
export function convertAnchor(prev: TextSpec, next: TextSpec, anchor: { x: number; y: number }): { x: number; y: number } {
  if (!!prev.box === !!next.box) return anchor;
  const asc = textAscent(next);
  const k = (a: TextAlign) => (a === "center" ? 0.5 : a === "right" ? 1 : 0);
  if (next.box) return { x: anchor.x - next.box.w * k(next.align), y: anchor.y - asc };
  return { x: anchor.x + prev.box!.w * k(next.align), y: anchor.y + asc };
}

/** A name for a type layer from its text, like PS. */
export function textLayerName(content: string): string {
  const s = content.replace(/\s+/g, " ").trim();
  return s ? (s.length > 30 ? s.slice(0, 30) + "…" : s) : "Type";
}

/** Re-render type layers (all, or one font's) that were drawn before their font loaded. */
export function rerenderTextLayers(doc: Document, ready: (t: TextSpec) => boolean): void {
  for (const l of doc.layers) {
    if (!l.text || !fallbackGrids.has(l.grid) || !ready(l.text)) continue;
    try {
      doc.dirty(renderTextLayer(l));
    } catch {
      /* leave it as it is */
    }
  }
}
