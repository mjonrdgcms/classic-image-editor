/** Painting, fills, adjustments, clipboard, crop, guides and colors. */

import { BLEND_MODES } from "../blend";
import { PaintMode, Stroke } from "../brush";
import { BrushPreset, roundBrush } from "../brushes";
import { CommandContext, CommandDef, ObjectSchema, ValidationError } from "../commands";
import { layerSource } from "../composite";
import { Layer, RGBA, type Document } from "../document";
import { bucketFill, clearArea, fillArea, fillPatternArea, strokeArea, type StrokeLocation } from "../fill";
import { PATTERN_SCHEMA, patternFromJSON } from "../patterns";
import { GRADIENT_PRESETS, GRADIENT_TYPES, GradientPreset, GradientType, drawGradient, presetStops } from "../gradient";
import { Mask } from "../mask";
import { shiftMask } from "../maskfx";
import { renderTextLayer, textAnchor } from "../text";
import { renderShapeLayer } from "../shapes";
import { mapPath } from "../vector";
import { editArea, maskEditArea } from "../selection";
import { Rect, TileGrid, rectIntersect } from "../tiles";
import { PAINT_TARGETS, assertPixelsEditable, canPaint, hasLayer, paintTarget, percent, targetLayer } from "./common";

const noParams: ObjectSchema = { type: "object", properties: {} };
const num = (minimum?: number, maximum?: number, extra: Record<string, unknown> = {}) => ({ type: "number" as const, minimum, maximum, ...extra });
const control = { type: "string" as const, enum: ["off", "fade", "pressure"] };

/** JSON-Schema for a brush preset, so Actions and the AI can paint with any brush. */
const brushSchema: ObjectSchema = {
  type: "object",
  description: "A brush preset; omitted fields use a round brush",
  properties: {
    name: { type: "string" },
    size: num(1, 2500),
    hardness: num(0, 100),
    sampled: {
      type: "object",
      properties: { w: { type: "integer", minimum: 1 }, h: { type: "integer", minimum: 1 }, b64: { type: "string" }, data: { type: "array", items: { type: "integer" } } },
    },
    spacing: num(1, 1000),
    angle: num(-360, 360),
    roundness: num(1, 100),
    shape: {
      type: "object",
      properties: {
        sizeJitter: num(0, 100),
        sizeControl: control,
        fadeSteps: num(1, 9999),
        minDiameter: num(0, 100),
        angleJitter: num(0, 100),
        angleControl: { type: "string", enum: ["off", "direction", "pressure"] },
        roundnessJitter: num(0, 100),
        minRoundness: num(0, 100),
      },
    },
    scatter: { type: "object", properties: { amount: num(0, 1000), bothAxes: { type: "boolean" }, count: num(1, 16), countJitter: num(0, 100) } },
    color: { type: "object", properties: { fgBgJitter: num(0, 100), hueJitter: num(0, 100), saturationJitter: num(0, 100), brightnessJitter: num(0, 100) } },
    other: {
      type: "object",
      properties: { opacityJitter: num(0, 100), opacityControl: control, flowJitter: num(0, 100), flowControl: control, fadeSteps: num(1, 9999) },
    },
    noise: { type: "boolean" },
    airbrush: { type: "boolean" },
  },
};

function toPreset(b: Partial<BrushPreset> & { sampled?: unknown } | undefined, size: number, hardness: number): BrushPreset {
  const base = roundBrush(size, hardness);
  if (!b) return base;
  const s = b.sampled as { w: number; h: number; b64?: string; data?: number[] } | null | undefined;
  let sampled = null;
  if (s && (s.b64 || s.data)) {
    const data = s.b64 ? Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0)) : Uint8Array.from(s.data!);
    if (data.length !== s.w * s.h) throw new ValidationError("brush.sampled data does not match its size");
    sampled = { w: s.w, h: s.h, data };
  }
  const merge = <T,>(d: T | null, v: unknown): T | null => (v ? ({ ...(d ?? {}), ...(v as object) } as T) : null);
  return {
    ...base,
    ...b,
    size: b.size ?? size,
    hardness: b.hardness ?? hardness,
    sampled,
    shape: merge({ sizeJitter: 0, sizeControl: "off", fadeSteps: 25, minDiameter: 0, angleJitter: 0, angleControl: "off", roundnessJitter: 0, minRoundness: 25 }, b.shape),
    scatter: merge({ amount: 0, bothAxes: false, count: 1, countJitter: 0 }, b.scatter),
    color: merge({ fgBgJitter: 0, hueJitter: 0, saturationJitter: 0, brightnessJitter: 0 }, b.color),
    other: merge({ opacityJitter: 0, opacityControl: "off", flowJitter: 0, flowControl: "off", fadeSteps: 25 }, b.other),
  } as BrushPreset;
}

function fillColor(ctx: CommandContext, use: string): RGBA {
  const doc = ctx.doc;
  switch (use) {
    case "background":
      return [...doc.background];
    case "black":
      return [0, 0, 0, 255];
    case "white":
      return [255, 255, 255, 255];
    case "gray":
      return [128, 128, 128, 255];
    default:
      return [...doc.foreground];
  }
}

/** Per-pixel RGB function over the active layer (or its mask), inside the selection. */
function adjust(ctx: CommandContext, fn: (r: number, g: number, b: number) => [number, number, number]): void {
  const doc = ctx.doc;
  const t = paintTarget(ctx);
  if (t.kind === "selection") {
    // Quick Mask: adjustments act on the mask as gray.
    const m = (doc.selection ??= new Mask(doc.width, doc.height, 0));
    const r = { x: 0, y: 0, w: m.width, h: m.height };
    const d = m.readRegion(r);
    for (let i = 0; i < d.length; i++) d[i] = fn(d[i], d[i], d[i])[0];
    m.writeRegion(r, d);
    doc.emit({ type: "selection" });
    return;
  }
  if (t.kind === "mask") {
    const h = t.host, m = h.mask!;
    const ea = maskEditArea(doc, h);
    if (!ea) return;
    const { area, cov } = ea;
    const d = m.readRegion(area, m.defaultValue);
    for (let i = 0; i < d.length; i++) {
      const v = fn(d[i], d[i], d[i])[0];
      const a = cov ? cov[i] / 255 : 1;
      d[i] = Math.round(d[i] + (v - d[i]) * a);
    }
    // With no selection the whole mask changes, including the value past its
    // edges (what an unlinked mask uncovers when moved), e.g. for Invert.
    const nd = fn(m.defaultValue, m.defaultValue, m.defaultValue)[0];
    if (!cov && nd !== m.defaultValue && (nd === 0 || nd === 255)) {
      const out = new Mask(m.width, m.height, nd);
      out.writeRegion(area, d);
      h.mask = out;
    } else m.writeRegion(area, d);
    doc.dirty({ x: area.x + h.offsetX, y: area.y + h.offsetY, w: area.w, h: area.h });
    return;
  }
  const l = t.layer;
  const ea = editArea(doc, l);
  if (!ea) return;
  const { area, cov } = ea;
  {
    const px = l.grid.readRegion(area);
    for (let i = 0, p = 0; i < area.w * area.h; i++, p += 4) {
      if (px[p + 3] === 0) continue;
      const a = cov ? cov[i] / 255 : 1;
      if (a <= 0) continue;
      const [r, g, b] = fn(px[p], px[p + 1], px[p + 2]);
      px[p] = Math.round(px[p] + (r - px[p]) * a);
      px[p + 1] = Math.round(px[p + 1] + (g - px[p + 1]) * a);
      px[p + 2] = Math.round(px[p + 2] + (b - px[p + 2]) * a);
    }
    l.grid.writeRegion(area, px);
  }
  doc.dirty({ x: area.x + l.offsetX, y: area.y + l.offsetY, w: area.w, h: area.h });
}

// ---------------------------------------------------------------- clipboard

export interface ClipboardImage {
  w: number;
  h: number;
  /** Straight RGBA. */
  data: Uint8ClampedArray;
}

/** The pixels a Copy takes: selection-covered, cropped to their bounds. */
function copyPixels(ctx: CommandContext, merged: boolean): ClipboardImage {
  const doc = ctx.doc;
  const full: Rect = { x: 0, y: 0, w: doc.width, h: doc.height };
  const sel = doc.selection;
  const b = sel ? rectIntersect(sel.bounds()!, full) : full;
  if (!b) throw new ValidationError("the selected area is empty");
  let px: Uint8ClampedArray;
  const host = doc.activeNode;
  if (merged) px = doc.composite(b);
  else if (doc.editMask && host?.mask && !doc.quickMask) {
    // Copying from a mask copies it as a gray image.
    const g = host.mask.readRegion({ x: b.x - host.offsetX, y: b.y - host.offsetY, w: b.w, h: b.h }, host.mask.defaultValue);
    px = new Uint8ClampedArray(g.length * 4);
    for (let i = 0; i < g.length; i++) px.set([g[i], g[i], g[i], 255], i * 4);
  } else {
    const l = targetLayer(ctx);
    px = layerSource(l, b);
  }
  if (sel) {
    const cov = sel.readRegion(b);
    for (let i = 0, o = 3; i < cov.length; i++, o += 4) px[o] = Math.round((px[o] * cov[i]) / 255);
  }
  let any = false;
  for (let o = 3; o < px.length && !any; o += 4) if (px[o]) any = true;
  if (!any) throw new ValidationError("the selected area is empty");
  return { w: b.w, h: b.h, data: px };
}

// ---------------------------------------------------------------- moving selected pixels

/**
 * Move (or with duplicate, copy) the selected pixels of a layer by dx, dy.
 * The hole left behind is transparent, or background color on the Background.
 * Used live by the Move tool and by the edit.moveSelection command.
 */
export function moveSelectedPixels(doc: import("../document").Document, l: Layer, dx: number, dy: number, duplicate: boolean): Rect | null {
  const sel = doc.selection;
  if (!sel) return null;
  const sb = sel.bounds();
  const b = sb && rectIntersect(sb, l.bounds());
  if (!b) return null;
  const lr = { x: b.x - l.offsetX, y: b.y - l.offsetY, w: b.w, h: b.h };
  const px = l.grid.readRegion(lr);
  const cov = sel.readRegion(b);
  const float = px.slice();
  for (let i = 0, o = 3; i < cov.length; i++, o += 4) float[o] = Math.round((float[o] * cov[i]) / 255);
  if (!duplicate) {
    for (let i = 0, o = 0; i < cov.length; i++, o += 4) {
      const a = cov[i] / 255;
      if (!a) continue;
      if (l.isBackground) for (let c = 0; c < 3; c++) px[o + c] = Math.round(px[o + c] * (1 - a) + doc.background[c] * a);
      else px[o + 3] = Math.round(px[o + 3] * (1 - a));
    }
    l.grid.writeRegion(lr, px);
  }
  // Drop the floated pixels at the new place (source-over).
  const dr = { x: lr.x + dx, y: lr.y + dy, w: lr.w, h: lr.h };
  const dst = l.grid.readRegion(dr);
  for (let o = 0; o < dst.length; o += 4) {
    const a = float[o + 3] / 255;
    if (!a) continue;
    const da = dst[o + 3] / 255;
    const oa = a + da * (1 - a);
    for (let c = 0; c < 3; c++) dst[o + c] = Math.round((float[o + c] * a + dst[o + c] * da * (1 - a)) / oa);
    dst[o + 3] = l.isBackground ? 255 : Math.round(oa * 255);
  }
  l.grid.writeRegion(dr, dst);
  l.grid.compact();
  const moved = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
  return {
    x: Math.min(b.x, moved.x),
    y: Math.min(b.y, moved.y),
    w: Math.max(b.x + b.w, moved.x + moved.w) - Math.min(b.x, moved.x),
    h: Math.max(b.y + b.h, moved.y + moved.h) - Math.min(b.y, moved.y),
  };
}

// ---------------------------------------------------------------- commands

/** Move the document's paths and color samplers through a canvas mapping (crop, resize, rotate). */
export function mapDocPoints(doc: Document, f: (x: number, y: number) => [number, number], W: number, H: number): void {
  doc.paths = doc.paths.map((p) => ({ ...p, path: mapPath(p.path, f) }));
  doc.samplers = doc.samplers
    .map((s) => {
      const [x, y] = f(s.x + 0.5, s.y + 0.5);
      return { x: Math.floor(x), y: Math.floor(y) };
    })
    .filter((s) => s.x >= 0 && s.y >= 0 && s.x < W && s.y < H);
}

/** Crop (or extend) the canvas to a rectangle; new Background area gets the background color. */
export function cropDocument(doc: Document, p: Rect): void {
  if (p.w > 30000 || p.h > 30000) throw new ValidationError("the cropped image would be too large");
  const cropLayer = (l: Layer) => {
    const src = { x: p.x - l.offsetX, y: p.y - l.offsetY, w: p.w, h: p.h };
    const px = l.grid.readRegion(src);
    if (l.isBackground) {
      // Area beyond the old canvas becomes background color.
      const inside = rectIntersect(src, { x: 0, y: 0, w: l.grid.width, h: l.grid.height });
      for (let y = 0; y < p.h; y++)
        for (let x = 0; x < p.w; x++) {
          const gx = src.x + x, gy = src.y + y;
          if (inside && gx >= inside.x && gy >= inside.y && gx < inside.x + inside.w && gy < inside.y + inside.h) continue;
          const o = (y * p.w + x) * 4;
          px[o] = doc.background[0];
          px[o + 1] = doc.background[1];
          px[o + 2] = doc.background[2];
          px[o + 3] = 255;
        }
    }
    const g = new TileGrid(p.w, p.h);
    g.writeRegion({ x: 0, y: 0, w: p.w, h: p.h }, px);
    if (l.mask) {
      const m = new Mask(p.w, p.h, l.mask.defaultValue);
      m.writeRegion({ x: 0, y: 0, w: p.w, h: p.h }, l.mask.readRegion(src, l.mask.defaultValue));
      l.mask = m;
    }
    l.grid = g;
    l.offsetX = 0;
    l.offsetY = 0;
  };
  for (const l of doc.layers) {
    if (l.text) {
      // Type stays editable: move it into the new canvas space and re-render.
      const a = textAnchor(l);
      l.offsetX -= p.x;
      l.offsetY -= p.y;
      renderTextLayer(l, { x: a.x - p.x, y: a.y - p.y });
    } else if (l.shape) {
      // Shapes stay editable too.
      l.offsetX -= p.x;
      l.offsetY -= p.y;
      renderShapeLayer(l);
    } else cropLayer(l);
  }
  // Set masks are canvas-sized: crop them the same way.
  for (const g of doc.groups) if (g.mask) g.mask = shiftMask(g.mask, -p.x, -p.y, p.w, p.h);
  doc.width = p.w;
  doc.height = p.h;
  doc.selection = null;
  doc.lastSelection = null;
  doc.quickMask = false;
  doc.guides = {
    h: doc.guides.h.map((y) => y - p.y).filter((y) => y >= 0 && y <= p.h),
    v: doc.guides.v.map((x) => x - p.x).filter((x) => x >= 0 && x <= p.w),
  };
  // Notes stay on the canvas; slices are cropped with it.
  mapDocPoints(doc, (x, y) => [x - p.x, y - p.y], p.w, p.h);
  doc.notes = doc.notes.map((n) => ({ ...n, x: Math.max(0, Math.min(p.w - 1, n.x - p.x)), y: Math.max(0, Math.min(p.h - 1, n.y - p.y)) }));
  doc.slices = doc.slices
    .map((s) => {
      const x0 = Math.max(0, s.x - p.x), y0 = Math.max(0, s.y - p.y);
      const x1 = Math.min(p.w, s.x + s.w - p.x), y1 = Math.min(p.h, s.y + s.h - p.y);
      return { ...s, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    })
    .filter((s) => s.w > 0 && s.h > 0);
  doc.emit({ type: "size" });
  doc.emit({ type: "layers" });
  doc.emit({ type: "selection" });
  doc.emit({ type: "guides" });
  doc.dirty(null);
}

export const editCommands: CommandDef[] = [
  {
    name: "edit.fill",
    label: "Fill",
    description: "Fill the selection (or the whole active layer, its mask, or the Quick Mask) with a color.",
    params: {
      type: "object",
      properties: {
        use: { type: "string", enum: ["foreground", "background", "black", "white", "gray", "pattern"], default: "foreground" },
        opacity: { ...percent("Fill opacity in percent"), default: 100 },
        pattern: { ...PATTERN_SCHEMA, description: "The pattern, when use is pattern" },
        preserveTransparency: { type: "boolean", default: false, description: "Only color pixels that are already there" },
      },
    },
    history: true,
    enabled: canPaint,
    run(ctx, p: { use: string; opacity: number; preserveTransparency?: boolean; pattern?: { name?: string; w: number; h: number; b64: string } }) {
      if (p.use === "pattern") {
        if (!p.pattern) throw new ValidationError("choose a pattern to fill with");
        const r = fillPatternArea(ctx.doc, paintTarget(ctx), patternFromJSON(p.pattern), p.opacity / 100);
        if (r) ctx.doc.dirty(r);
        return;
      }
      const r = fillArea(ctx.doc, paintTarget(ctx), fillColor(ctx, p.use), p.opacity / 100, !!p.preserveTransparency);
      if (r) ctx.doc.dirty(r);
    },
  },
  {
    name: "edit.stroke",
    label: "Stroke",
    description: "Draw a line of color along the edge of the selection: inside it, centered on it, or outside it.",
    params: {
      type: "object",
      properties: {
        width: { type: "number", minimum: 1, maximum: 250, default: 2, description: "Line width in pixels" },
        location: { type: "string", enum: ["inside", "center", "outside"], default: "center" },
        use: { type: "string", enum: ["foreground", "background", "black", "white", "gray", "custom"], default: "foreground" },
        color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3, description: "RGB, when use is custom" },
        opacity: { ...percent("Opacity in percent"), default: 100 },
      },
    },
    history: true,
    enabled: (ctx) => canPaint(ctx) && !!ctx.doc.selection && !ctx.doc.quickMask,
    run(ctx, p: { width: number; location: StrokeLocation; use: string; color?: number[]; opacity: number }) {
      if (!ctx.doc.selection) throw new ValidationError("make a selection to stroke first");
      const t = paintTarget(ctx);
      if (t.kind === "selection") throw new ValidationError("Stroke does not work in Quick Mask");
      const c: RGBA = p.use === "custom" ? (p.color ? [p.color[0], p.color[1], p.color[2], 255] : [...ctx.doc.foreground]) : fillColor(ctx, p.use);
      const r = strokeArea(ctx.doc, t, c, p.opacity / 100, p.width, p.location);
      if (r) ctx.doc.dirty(r);
    },
  },
  {
    name: "edit.clear",
    label: "Clear",
    description: "Erase the selection (or the whole active layer) to transparency; the Background layer and masks get the background color.",
    params: noParams,
    history: true,
    enabled: canPaint,
    run(ctx) {
      const r = clearArea(ctx.doc, paintTarget(ctx));
      if (r) ctx.doc.dirty(r);
    },
  },
  {
    name: "paint.stroke",
    label: (p: { tool: string }) => (p.tool === "eraser" ? "Eraser" : p.tool === "pencil" ? "Pencil" : "Brush Tool"),
    description:
      "Paint, pencil or erase a stroke through [x, y] or [x, y, pressure] canvas points. Use size/hardness for a round brush or pass a full brush preset.",
    params: {
      type: "object",
      properties: {
        tool: { type: "string", enum: ["brush", "pencil", "eraser"], default: "brush" },
        points: { type: "array", minItems: 1, items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 } },
        size: num(1, 2500, { default: 13 }),
        hardness: { ...percent("Brush hardness in percent"), default: 100 },
        brush: brushSchema,
        opacity: { ...percent("Stroke opacity in percent"), default: 100 },
        flow: { ...percent("Paint flow per dab in percent"), default: 100 },
        mode: { type: "string", enum: [...BLEND_MODES, "behind", "clear"], default: "normal" },
        color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3, description: "RGB; defaults to the foreground color" },
        target: { type: "string", enum: PAINT_TARGETS, description: "Default: the layer mask when it is being edited, the selection in Quick Mask, otherwise pixels" },
        seed: { type: "integer", minimum: 0, default: 1, description: "Random seed for brush dynamics" },
        aliased: { type: "boolean", default: false, description: "Hard pixel edges (pencil-like)" },
      },
      required: ["points"],
    },
    history: true,
    enabled: canPaint,
    run(
      ctx,
      p: { tool: "brush" | "pencil" | "eraser"; points: number[][]; size: number; hardness: number; brush?: Partial<BrushPreset>; opacity: number; flow: number; mode: PaintMode; color?: number[]; target?: string; seed: number; aliased: boolean },
    ) {
      const doc = ctx.doc;
      const fg: RGBA = p.color ? [p.color[0], p.color[1], p.color[2], 255] : [...doc.foreground];
      const s = new Stroke(doc, paintTarget(ctx, p.target), {
        tool: p.tool,
        brush: toPreset(p.brush, p.size, p.hardness),
        opacity: p.opacity / 100,
        flow: p.flow / 100,
        mode: p.mode,
        fg,
        bg: [...doc.background],
        seed: p.seed,
        aliased: p.aliased,
      });
      for (const pt of p.points) s.addPoint(pt[0], pt[1], pt[2] ?? 1);
      s.end();
    },
  },
  {
    name: "paint.bucket",
    label: "Paint Bucket",
    description: "Flood-fill similar colors on the active layer starting at x, y with the foreground color.",
    params: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        tolerance: { type: "integer", minimum: 0, maximum: 255, default: 32 },
        contiguous: { type: "boolean", default: true },
        opacity: { ...percent("Fill opacity in percent"), default: 100 },
      },
      required: ["x", "y"],
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { x: number; y: number; tolerance: number; contiguous: boolean; opacity: number }) {
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      const r = bucketFill(ctx.doc, l, p.x, p.y, [...ctx.doc.foreground], { tolerance: p.tolerance, contiguous: p.contiguous, opacity: p.opacity / 100 });
      if (r) ctx.doc.dirty(r);
    },
  },
  {
    name: "paint.gradient",
    label: "Gradient",
    description:
      "Draw a gradient from (x0, y0) to (x1, y1) in canvas pixels, inside the selection. Works on layer pixels, the layer mask being edited, or Quick Mask. Presets use the current foreground/background colors; pass stops for custom colors.",
    params: {
      type: "object",
      properties: {
        x0: { type: "number" },
        y0: { type: "number" },
        x1: { type: "number" },
        y1: { type: "number" },
        type: { type: "string", enum: GRADIENT_TYPES, default: "linear" },
        preset: { type: "string", enum: GRADIENT_PRESETS, default: "fgToBg" },
        stops: {
          type: "array",
          minItems: 2,
          description: "Custom color stops (overrides preset): [{pos 0..1, color [r,g,b] or [r,g,b,a]}]",
          items: {
            type: "object",
            properties: { pos: num(0, 1), color: { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 4 } },
            required: ["pos", "color"],
          },
        },
        mode: { type: "string", enum: BLEND_MODES, default: "normal" },
        opacity: { ...percent("Opacity in percent"), default: 100 },
        reverse: { type: "boolean", default: false },
        dither: { type: "boolean", default: true },
        transparency: { type: "boolean", default: true, description: "Use the gradient's transparency" },
        target: { type: "string", enum: PAINT_TARGETS, description: "Default: the layer mask when it is being edited, the selection in Quick Mask, otherwise pixels" },
      },
      required: ["x0", "y0", "x1", "y1"],
    },
    history: true,
    enabled: canPaint,
    run(
      ctx,
      p: {
        x0: number; y0: number; x1: number; y1: number; type: GradientType; preset: GradientPreset;
        stops?: { pos: number; color: number[] }[]; mode: (typeof BLEND_MODES)[number]; opacity: number;
        reverse: boolean; dither: boolean; transparency: boolean; target?: string;
      },
    ) {
      const doc = ctx.doc;
      if (Math.hypot(p.x1 - p.x0, p.y1 - p.y0) < 0.5) throw new ValidationError("the gradient needs a start and end point apart");
      const stops = p.stops
        ? p.stops.map((s) => ({ pos: s.pos, color: [s.color[0], s.color[1], s.color[2], s.color[3] ?? 255] as RGBA }))
        : presetStops(p.preset, doc.foreground, doc.background);
      const r = drawGradient(doc, paintTarget(ctx, p.target), { ...p, stops, opacity: p.opacity / 100 });
      if (r) doc.dirty(r);
    },
  },
  {
    name: "image.invert",
    label: "Invert",
    description: "Invert the colors of the active layer (or its mask) inside the selection.",
    params: noParams,
    history: true,
    enabled: canPaint,
    run(ctx) {
      adjust(ctx, (r, g, b) => [255 - r, 255 - g, 255 - b]);
    },
  },
  {
    name: "image.desaturate",
    label: "Desaturate",
    description: "Remove color from the active layer inside the selection.",
    params: noParams,
    history: true,
    enabled: hasLayer,
    run(ctx) {
      adjust(ctx, (r, g, b) => {
        const v = Math.round((Math.max(r, g, b) + Math.min(r, g, b)) / 2);
        return [v, v, v];
      });
    },
  },

  {
    name: "edit.moveSelection",
    label: (p: { duplicate?: boolean }) => (p.duplicate ? "Duplicate" : "Move"),
    description: "Move the selected pixels of the active layer by dx, dy (with duplicate, move a copy). The selection moves too.",
    params: {
      type: "object",
      properties: { dx: { type: "integer" }, dy: { type: "integer" }, duplicate: { type: "boolean", default: false } },
      required: ["dx", "dy"],
    },
    history: true,
    enabled: (ctx) => hasLayer(ctx) && !!ctx.doc.selection,
    run(ctx, p: { dx: number; dy: number; duplicate: boolean }) {
      const doc = ctx.doc;
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      if (!doc.selection) throw new ValidationError("there is no selection");
      const r = moveSelectedPixels(doc, l, p.dx, p.dy, p.duplicate);
      doc.setSelection(doc.selection.translated(p.dx, p.dy));
      if (r) doc.dirty(r);
    },
  },

  // ---------------- clipboard ----------------
  {
    name: "edit.copy",
    label: "Copy",
    description: "Copy the selected pixels of the active layer (or its mask, as gray, when the mask is being edited).",
    params: noParams,
    history: false,
    enabled: (ctx) => hasLayer(ctx) || (ctx.doc.editMask && !!ctx.doc.activeNode?.mask),
    run(ctx) {
      ctx.bus.setClipboard(copyPixels(ctx, false));
    },
  },
  {
    name: "edit.copyMerged",
    label: "Copy Merged",
    description: "Copy the selected area of all visible layers merged.",
    params: noParams,
    history: false,
    run(ctx) {
      ctx.bus.setClipboard(copyPixels(ctx, true));
    },
  },
  {
    name: "edit.cut",
    label: "Cut Pixels",
    description: "Copy the selected pixels of the active layer, then clear them.",
    params: noParams,
    history: true,
    enabled: (ctx) => hasLayer(ctx) && !!ctx.doc.selection,
    run(ctx) {
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      ctx.bus.setClipboard(copyPixels(ctx, false));
      const r = clearArea(ctx.doc, { kind: "pixels", layer: l });
      if (r) ctx.doc.dirty(r);
    },
  },
  {
    name: "edit.paste",
    label: (p: { into?: boolean }) => (p.into ? "Paste Into" : "Paste"),
    description: "Paste the clipboard as a new layer, centered on the selection or canvas. With into, the selection becomes the layer's mask.",
    params: { type: "object", properties: { into: { type: "boolean", default: false } } },
    history: true,
    enabled: (ctx) => !!ctx.bus.clipboard,
    run(ctx, p: { into: boolean }) {
      const doc = ctx.doc;
      const clip = ctx.bus.clipboard;
      if (!clip) throw new ValidationError("the clipboard is empty");
      if (p.into && !doc.selection) throw new ValidationError("Paste Into needs a selection");
      const sb = doc.selection?.bounds() ?? null;
      const cx = sb ? sb.x + sb.w / 2 : doc.width / 2;
      const cy = sb ? sb.y + sb.h / 2 : doc.height / 2;
      const r = { x: Math.round(cx - clip.w / 2), y: Math.round(cy - clip.h / 2), w: clip.w, h: clip.h };
      const host = doc.activeNode;
      if (!p.into && doc.editMask && host?.mask && !doc.quickMask) {
        // Pasting while a mask is being edited pastes into the mask, as gray.
        const m = host.mask;
        const mr = { x: r.x - host.offsetX, y: r.y - host.offsetY, w: r.w, h: r.h };
        const cur = m.readRegion(mr, m.defaultValue);
        for (let i = 0; i < cur.length; i++) {
          const o = i * 4, a = clip.data[o + 3] / 255;
          const g = 0.3 * clip.data[o] + 0.59 * clip.data[o + 1] + 0.11 * clip.data[o + 2];
          cur[i] = Math.round(cur[i] + (g - cur[i]) * a);
        }
        m.writeRegion(mr, cur);
        doc.dirty(r);
        return;
      }
      const l = new Layer(doc.width, doc.height, doc.nextLayerName());
      // Pasted content larger than the canvas keeps its overflow by offsetting the layer.
      const big = clip.w > doc.width || clip.h > doc.height;
      if (big) {
        l.grid = new TileGrid(clip.w, clip.h);
        l.offsetX = r.x;
        l.offsetY = r.y;
        l.grid.writeRegion({ x: 0, y: 0, w: clip.w, h: clip.h }, clip.data);
      } else l.grid.writeRegion(r, clip.data);
      if (p.into) {
        const sel = doc.selection!;
        const m = new Mask(l.grid.width, l.grid.height, 0);
        m.writeRegion({ x: 0, y: 0, w: m.width, h: m.height }, sel.readRegion({ x: l.offsetX, y: l.offsetY, w: m.width, h: m.height }));
        l.mask = m;
      }
      const active = doc.activeNode;
      if (active) doc.insertAboveActive(l);
      else doc.stack.push(l);
      doc.activeLayerId = l.id;
      doc.editMask = false;
      doc.setSelection(null);
      doc.emit({ type: "layers" });
      doc.dirty(rectIntersect(r, { x: 0, y: 0, w: doc.width, h: doc.height }));
    },
  },

  // ---------------- crop ----------------
  {
    name: "image.crop",
    label: "Crop",
    description: "Crop the canvas to a rectangle (it may extend past the canvas; new Background area gets the background color).",
    params: {
      type: "object",
      properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer", minimum: 1 }, h: { type: "integer", minimum: 1 } },
      required: ["x", "y", "w", "h"],
    },
    history: true,
    run({ doc }, p: Rect) {
      cropDocument(doc, p);
    },
  },

  // ---------------- guides ----------------
  {
    name: "guide.add",
    label: "New Guide",
    description: "Add a horizontal guide at a y position or a vertical guide at an x position.",
    params: { type: "object", properties: { orientation: { type: "string", enum: ["horizontal", "vertical"] }, position: { type: "number" } }, required: ["orientation", "position"] },
    history: true,
    run({ doc }, p: { orientation: string; position: number }) {
      (p.orientation === "horizontal" ? doc.guides.h : doc.guides.v).push(Math.round(p.position));
      doc.emit({ type: "guides" });
    },
  },
  {
    name: "guide.move",
    label: "Move Guide",
    description: "Move a guide (by its index in its orientation's list); a position off the canvas deletes it.",
    params: {
      type: "object",
      properties: { orientation: { type: "string", enum: ["horizontal", "vertical"] }, index: { type: "integer", minimum: 0 }, position: { type: "number" } },
      required: ["orientation", "index", "position"],
    },
    history: true,
    run({ doc }, p: { orientation: string; index: number; position: number }) {
      const list = p.orientation === "horizontal" ? doc.guides.h : doc.guides.v;
      if (p.index >= list.length) throw new ValidationError("no such guide");
      const max = p.orientation === "horizontal" ? doc.height : doc.width;
      if (p.position < 0 || p.position > max) list.splice(p.index, 1);
      else list[p.index] = Math.round(p.position);
      doc.emit({ type: "guides" });
    },
  },
  {
    name: "guide.clear",
    label: "Clear Guides",
    description: "Remove all guides.",
    params: noParams,
    history: true,
    enabled: (ctx) => ctx.doc.guides.h.length + ctx.doc.guides.v.length > 0,
    run({ doc }) {
      doc.guides = { h: [], v: [] };
      doc.emit({ type: "guides" });
    },
  },

  // ---------------- colors (not recorded, like PS7) ----------------
  {
    name: "color.set",
    label: "Set Color",
    description: "Set the foreground or background color.",
    params: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["foreground", "background"], default: "foreground" },
        r: { type: "integer", minimum: 0, maximum: 255 },
        g: { type: "integer", minimum: 0, maximum: 255 },
        b: { type: "integer", minimum: 0, maximum: 255 },
      },
      required: ["r", "g", "b"],
    },
    history: false,
    run({ doc }, p: { which: string; r: number; g: number; b: number }) {
      let c: RGBA = [p.r, p.g, p.b, 255];
      // While a mask is being edited, colors are grays (as in PS7).
      if (doc.editMask && doc.activeNode?.mask && !doc.quickMask) {
        const v = Math.round(0.3 * p.r + 0.59 * p.g + 0.11 * p.b);
        c = [v, v, v, 255];
      }
      if (p.which === "background") doc.background = c;
      else doc.foreground = c;
      doc.emit({ type: "colors" });
    },
  },
  {
    name: "color.swap",
    label: "Swap Colors",
    description: "Swap the foreground and background colors.",
    params: noParams,
    history: false,
    run({ doc }) {
      [doc.foreground, doc.background] = [doc.background, doc.foreground];
      doc.emit({ type: "colors" });
    },
  },
  {
    name: "color.reset",
    label: "Default Colors",
    description: "Reset to black foreground and white background (white on black while a mask is being edited).",
    params: noParams,
    history: false,
    run({ doc }) {
      const mask = doc.editMask && !!doc.activeNode?.mask && !doc.quickMask;
      doc.foreground = mask ? [255, 255, 255, 255] : [0, 0, 0, 255];
      doc.background = mask ? [0, 0, 0, 255] : [255, 255, 255, 255];
      doc.emit({ type: "colors" });
    },
  },
];

