/**
 * Filters as commands. Every filter in the library becomes "filter.<id>"
 * with a JSON-Schema built from its parameters, so Actions, batch runs,
 * scripts and the AI can use any of them.
 *
 * A filter reads the target (layer pixels, the layer mask being edited, or
 * the Quick Mask) inside the selection plus some context around it, runs,
 * and blends the result back through the selection's soft edges.
 */

import { FILTERS, FILTER_MAP } from "../../filters";
import { BW_DEFAULTS, TONINGS, blackWhite, type BWSettings } from "../../filters/bw";
import type { Img } from "../../filters/img";
import { runFilter, type FilterDef, type FilterEnv, type ParamDef } from "../../filters/types";
import { BLEND_MODES, blendRGB, type BlendMode } from "../blend";
import { CommandBus, CommandContext, CommandDef, ObjectSchema, ParamSchema, ValidationError } from "../commands";
import type { Document, Layer, MaskHost } from "../document";
import { editArea, maskEditArea } from "../selection";
import { Rect, rectIntersect } from "../tiles";
import { assertPixelsEditable, canPaint, hasLayer, paintTarget, targetLayer } from "./common";
import { duplicateLayer } from "./layers";

export interface FilterRegion {
  kind: "pixels" | "mask" | "selection";
  /** The layer, for pixels. */
  layer: Layer | null;
  /** The layer or set whose mask is edited, for masks. */
  host?: MaskHost | null;
  /** Edited area, in target coordinates. */
  area: Rect;
  /** Area plus context, in target coordinates. */
  src: Rect;
  img: Img;
  cov: Uint8Array | null;
  /** Dirty rectangle in document coordinates. */
  docRect: Rect;
}

export function filterEnv(doc: Document, scale = 1): FilterEnv {
  return { fg: [doc.foreground[0], doc.foreground[1], doc.foreground[2]], bg: [doc.background[0], doc.background[1], doc.background[2]], scale };
}

function grayToImg(g: Uint8Array, w: number, h: number): Img {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < g.length; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i];
    d[i * 4 + 3] = 255;
  }
  return { w, h, data: d };
}

/** Work out what a filter will read and where it will write. Throws if it cannot run. */
export function filterRegion(ctx: CommandContext, def: Pick<FilterDef, "pad">, p: Record<string, any>): FilterRegion {
  const doc = ctx.doc;
  const t = paintTarget(ctx);
  const pad = Math.ceil(Math.max(0, def.pad?.(p) ?? 0));
  if (t.kind === "selection") {
    const m = doc.selection!;
    const area = { x: 0, y: 0, w: m.width, h: m.height };
    return { kind: "selection", layer: null, area, src: area, img: grayToImg(m.readRegion(area), area.w, area.h), cov: null, docRect: area };
  }
  if (t.kind === "mask") {
    const h = t.host, m = h.mask!;
    const ea = maskEditArea(doc, h);
    if (!ea) throw new ValidationError("the selection does not cover any of the mask");
    const src = rectIntersect({ x: 0, y: 0, w: m.width, h: m.height }, { x: ea.area.x - pad, y: ea.area.y - pad, w: ea.area.w + pad * 2, h: ea.area.h + pad * 2 })!;
    const img = grayToImg(m.readRegion(src, m.defaultValue), src.w, src.h);
    return { kind: "mask", layer: null, host: h, area: ea.area, src, img, cov: ea.cov, docRect: { x: ea.area.x + h.offsetX, y: ea.area.y + h.offsetY, w: ea.area.w, h: ea.area.h } };
  }
  const l = t.layer;
  const ea = editArea(doc, l);
  if (!ea) throw new ValidationError("the selection does not cover any of the layer");
  const full = { x: 0, y: 0, w: l.grid.width, h: l.grid.height };
  const src = rectIntersect(full, { x: ea.area.x - pad, y: ea.area.y - pad, w: ea.area.w + pad * 2, h: ea.area.h + pad * 2 })!;
  let img: Img;
  {
    img = { w: src.w, h: src.h, data: l.grid.readRegion(src) };
    let any = false;
    for (let i = 3; i < img.data.length && !any; i += 4) if (img.data[i]) any = true;
    if (!any && !(def as FilterDef).ownAlpha) throw new ValidationError(`"${l.name}" is empty here, so there is nothing to filter`);
  }
  return { kind: t.kind, layer: l, area: ea.area, src, img, cov: ea.cov, docRect: { x: ea.area.x + l.offsetX, y: ea.area.y + l.offsetY, w: ea.area.w, h: ea.area.h } };
}

/** Read the current target pixels of a region's area (for Fade). */
function readArea(doc: Document, r: FilterRegion): Uint8ClampedArray {
  if (r.kind === "pixels") return r.layer!.grid.readRegion(r.area);
  const m = r.kind === "mask" ? r.host!.mask! : doc.selection!;
  const g = m.readRegion(r.area, r.kind === "mask" ? m.defaultValue : 0);
  return grayToImg(g, r.area.w, r.area.h).data;
}

function writeArea(doc: Document, r: FilterRegion, px: Uint8ClampedArray): void {
  if (r.kind === "pixels") {
    r.layer!.grid.writeRegion(r.area, px);
    r.layer!.grid.compact();
  } else {
    const g = new Uint8Array(r.area.w * r.area.h);
    for (let i = 0; i < g.length; i++) g[i] = px[i * 4];
    (r.kind === "mask" ? r.host!.mask! : doc.selection!).writeRegion(r.area, g);
  }
  if (r.kind === "selection") doc.emit({ type: "selection" });
  else doc.dirty(r.docRect);
}

/**
 * What Fade needs: the pixels before and after the last filter, and the
 * history state the filter made. Fade is only offered while that state is
 * the current one, so undo, redo or any other step turns it off.
 */
interface LastFilter {
  doc: Document;
  label: string;
  kind: FilterRegion["kind"];
  layerId: number | null;
  area: Rect;
  docRect: Rect;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
  /** History state id of the filter's step (set once it is recorded). */
  stateId: number | null;
}
let lastFilter: LastFilter | null = null;

/** Forget the last filter (its image closed). */
export function forgetFilter(doc?: Document): void {
  if (!doc || lastFilter?.doc === doc) lastFilter = null;
}

/** Call after every command: ties the last filter to the history state it created. */
export function trackFilterState(bus: CommandBus, name: string): void {
  const lf = lastFilter;
  if (!lf || lf.stateId !== null) return;
  if ((name.startsWith("filter.") && name !== "filter.fade") || name === "image.blackWhite") lf.stateId = bus.history.current?.id ?? null;
  else lastFilter = null;
}

/** The region of the last filter, resolved against the live document (undo rebuilds layers). */
function liveRegion(doc: Document, lf: LastFilter): FilterRegion | null {
  if (lf.kind === "selection") return doc.selection ? { kind: "selection", layer: null, area: lf.area, src: lf.area, img: null!, cov: null, docRect: lf.docRect } : null;
  if (lf.kind === "mask") {
    const host = lf.layerId !== null ? doc.nodeById(lf.layerId) : undefined;
    return host?.mask ? { kind: "mask", layer: null, host, area: lf.area, src: lf.area, img: null!, cov: null, docRect: lf.docRect } : null;
  }
  const layer = lf.layerId !== null ? doc.layerById(lf.layerId) : undefined;
  if (!layer) return null;
  return { kind: lf.kind, layer, area: lf.area, src: lf.area, img: null!, cov: null, docRect: lf.docRect };
}

/** Blend a filter result into its region (through the selection's coverage). */
export function commitFilter(doc: Document, r: FilterRegion, out: Img, label: string): void {
  const before = readArea(doc, r);
  const px = before.slice();
  const ox = r.area.x - r.src.x, oy = r.area.y - r.src.y;
  const keepAlpha = r.kind !== "pixels" || r.layer!.isBackground || r.layer!.locks.transparency;
  for (let y = 0; y < r.area.h; y++)
    for (let x = 0; x < r.area.w; x++) {
      const i = y * r.area.w + x;
      const a = r.cov ? r.cov[i] / 255 : 1;
      if (a <= 0) continue;
      const p = i * 4, s = ((y + oy) * out.w + x + ox) * 4;
      for (let c = 0; c < (keepAlpha ? 3 : 4); c++) px[p + c] = px[p + c] + (out.data[s + c] - px[p + c]) * a;
    }
  writeArea(doc, r, px);
  lastFilter = { doc, label, kind: r.kind, layerId: r.layer?.id ?? r.host?.id ?? null, area: r.area, docRect: r.docRect, before, after: readArea(doc, r), stateId: null };
}

/** The name of the filter Fade would fade, or null if Fade is not available. */
export function canFade(doc: Document | null, bus: CommandBus): string | null {
  const lf = lastFilter;
  if (!lf || !doc || lf.doc !== doc || lf.stateId === null || bus.doc !== doc) return null;
  if (bus.history.current?.id !== lf.stateId) return null;
  return liveRegion(doc, lf) ? lf.label : null;
}

// ------------------------------------------------------------------ commands

function schemaFor(p: ParamDef): ParamSchema {
  switch (p.type) {
    case "range":
      return { type: "number", minimum: p.min, maximum: p.max, default: p.default, description: p.label + (p.unit ? ` (${p.unit})` : "") };
    case "select":
      return { type: "string", enum: p.options.map((o) => o[0]), default: p.default, description: p.label };
    case "check":
      return { type: "boolean", default: p.default, description: p.label };
    case "color":
      return { type: "string", default: p.default, description: p.label + " as #rrggbb" };
    case "seed":
      return { type: "integer", minimum: 0, maximum: 1e9, default: p.default, description: "Random seed" };
    case "levels":
      return { type: "string", default: p.default, description: "Levels as 'inBlack,gamma,inWhite,outBlack,outWhite' for RGB|R|G|B" };
    case "curves":
      return { type: "string", default: p.default, description: "Curve points 'x,y;x,y;...' (0-255) for RGB|R|G|B" };
  }
}

export function filterSchema(def: FilterDef): ObjectSchema {
  const properties: Record<string, ParamSchema> = {};
  for (const p of def.params) properties[p.key] = schemaFor(p);
  return { type: "object", properties };
}

function filterCommand(def: FilterDef): CommandDef {
  return {
    name: `filter.${def.id}`,
    label: def.name,
    description: `${def.category} filter. ${def.description}`,
    params: filterSchema(def),
    history: true,
    enabled: canPaint,
    run(ctx, p) {
      const r = filterRegion(ctx, def, p);
      const out = runFilter(def, r.img, p, filterEnv(ctx.doc));
      commitFilter(ctx.doc, r, out, def.name);
    },
  };
}

let fadedName = "Filter";

export const fadeCommand: CommandDef = {
  name: "filter.fade",
  label: () => `Fade ${fadedName}`,
  description: "Fade the last filter or adjustment: blend it with how the image looked before, at an opacity and blend mode.",
  params: {
    type: "object",
    properties: {
      opacity: { type: "number", minimum: 0, maximum: 100, default: 100, description: "Opacity in percent" },
      mode: { type: "string", enum: BLEND_MODES as unknown as string[], default: "normal" },
    },
  },
  history: true,
  enabled: (ctx) => !!canFade(ctx.doc, ctx.bus),
  run(ctx, p: { opacity: number; mode: BlendMode }) {
    if (!canFade(ctx.doc, ctx.bus)) throw new ValidationError("there is no filter to fade (the last step was not a filter)");
    const lf = lastFilter!;
    const region = liveRegion(ctx.doc, lf)!;
    fadedName = lf.label;
    const px = lf.after.slice();
    const k = p.opacity / 100;
    for (let i = 0; i < px.length; i += 4) {
      const b: [number, number, number] = [lf.before[i] / 255, lf.before[i + 1] / 255, lf.before[i + 2] / 255];
      const s: [number, number, number] = [lf.after[i] / 255, lf.after[i + 1] / 255, lf.after[i + 2] / 255];
      const m = p.mode === "normal" ? s : blendRGB(p.mode, b, s);
      for (let c = 0; c < 3; c++) px[i + c] = (b[c] + (m[c] - b[c]) * k) * 255;
      px[i + 3] = lf.before[i + 3] + (lf.after[i + 3] - lf.before[i + 3]) * k;
    }
    writeArea(ctx.doc, region, px);
    lastFilter = null;
  },
};

// ------------------------------------------------------------------ Black & White Lab

const BW_RANGES: Record<string, [number, number]> = {
  reds: [-200, 300], yellows: [-200, 300], greens: [-200, 300], cyans: [-200, 300], blues: [-200, 300], magentas: [-200, 300],
  brightness: [-100, 100], contrast: [-100, 100], blacks: [-100, 100], shadows: [-100, 100], highlights: [-100, 100], whites: [-100, 100],
  clarity: [-100, 100], grain: [0, 100], grainSize: [0.5, 5], grainRough: [0, 100], glow: [0, 100], vignette: [-100, 100], vignetteSize: [0, 100],
  toneAmount: [0, 100], shadowHue: [0, 360], shadowSat: [0, 100], highlightHue: [0, 360], highlightSat: [0, 100], toneBalance: [-100, 100], seed: [0, 1e9],
};

export const bwSchema: ObjectSchema = {
  type: "object",
  properties: {
    ...Object.fromEntries(
      Object.entries(BW_DEFAULTS)
        .filter(([k]) => k !== "toning")
        .map(([k, v]) => [k, { type: "number" as const, minimum: BW_RANGES[k][0], maximum: BW_RANGES[k][1], default: v as number }]),
    ),
    toning: { type: "string", enum: Object.keys(TONINGS), default: "none", description: "Toning: sepia, selenium, platinum, cyanotype, gold, coffee, blueSteel, or split (uses the hue/sat settings)" },
    output: { type: "string", enum: ["current", "newLayer"], default: "current", description: "Convert the layer itself, or a new copy above it" },
  },
};

export const blackWhiteCommand: CommandDef = {
  name: "image.blackWhite",
  label: "Black & White",
  description:
    "Convert to black and white with color-filter sliders (reds, yellows, greens, cyans, blues, magentas in percent; 40/60/40/60/20/80 is neutral), tone (brightness, contrast, blacks, shadows, highlights, whites), clarity, film grain, glow, vignette and toning.",
  params: bwSchema,
  history: true,
  enabled: (ctx) => hasLayer(ctx) && !ctx.doc.quickMask,
  run(ctx, p: BWSettings & { output: string }) {
    if (ctx.doc.quickMask) throw new ValidationError("leave Quick Mask first (Black & White works on layer pixels)");
    // Always the layer's pixels, even while its mask is being edited.
    ctx.doc.editMask = false;
    if (p.output === "newLayer") {
      const src = targetLayer(ctx);
      if (src.locks.pixels) assertPixelsEditable(src);
      duplicateLayer(ctx.doc, src, "Black & White");
      // The copy is pixels, even when the source is a type layer (which stays editable).
      ctx.doc.activeLayer!.text = null;
      ctx.doc.activeLayer!.shape = null;
      ctx.doc.editMask = false;
      ctx.doc.emit({ type: "layers" });
    }
    const l = targetLayer(ctx);
    assertPixelsEditable(l);
    const r = filterRegion(ctx, { pad: () => Math.max(ctx.doc.width, ctx.doc.height) * 0.03 }, p);
    commitFilter(ctx.doc, r, blackWhite(r.img, { ...BW_DEFAULTS, ...p }, 1, { w: ctx.doc.width, h: ctx.doc.height }), "Black & White");
  },
};

export const filterCommands: CommandDef[] = [...FILTERS.map(filterCommand), fadeCommand, blackWhiteCommand];

export { FILTER_MAP };
