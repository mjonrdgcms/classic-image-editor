/** Layer > Layer Style: set, clear and rasterize layer effects. */

import { BLEND_MODES } from "../blend";
import { CommandDef, ObjectSchema, ParamSchema, ValidationError } from "../commands";
import { compositeNodes } from "../composite";
import { Layer } from "../document";
import { FX_KEYS, hasEffects, layerEffects, normalizeStyle, type LayerStyle } from "../styles";
import { TileGrid, rectUnion } from "../tiles";
import { Mask } from "../mask";
import { assertPixelsEditable, nodeId, targetLayer } from "./common";

const n = (minimum: number, maximum: number, description?: string): ParamSchema => ({ type: "number", minimum, maximum, description });
const rgb: ParamSchema = { type: "array", items: { type: "integer", minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3, description: "RGB" };
const mode: ParamSchema = { type: "string", enum: BLEND_MODES };
const on: ParamSchema = { type: "boolean" };
const pct = n(0, 100, "percent");

const shadow: ObjectSchema = {
  type: "object",
  properties: { enabled: on, blendMode: mode, color: rgb, opacity: pct, angle: n(-360, 360, "light angle in degrees"), distance: n(0, 1000), spread: pct, size: n(0, 250) },
};
const glow: ObjectSchema = {
  type: "object",
  properties: { enabled: on, blendMode: mode, color: rgb, opacity: pct, spread: pct, size: n(0, 250), source: { type: "string", enum: ["edge", "center"] } },
};
export const STYLE_SCHEMA: ObjectSchema = {
  type: "object",
  description: "Effects; leave one out (or null) for none. Missing fields use PS7's defaults.",
  properties: {
    dropShadow: shadow,
    innerShadow: shadow,
    outerGlow: glow,
    innerGlow: glow,
    bevel: {
      type: "object",
      properties: {
        enabled: on,
        style: { type: "string", enum: ["inner", "outer", "emboss", "pillow"] },
        depth: n(1, 1000),
        direction: { type: "string", enum: ["up", "down"] },
        size: n(0, 250),
        soften: n(0, 16),
        angle: n(-360, 360),
        altitude: n(0, 90),
        highlightMode: mode,
        highlightColor: rgb,
        highlightOpacity: pct,
        shadowMode: mode,
        shadowColor: rgb,
        shadowOpacity: pct,
      },
    },
    colorOverlay: { type: "object", properties: { enabled: on, blendMode: mode, color: rgb, opacity: pct } },
    stroke: {
      type: "object",
      properties: { enabled: on, size: n(1, 250), position: { type: "string", enum: ["outside", "inside", "center"] }, blendMode: mode, color: rgb, opacity: pct },
    },
  },
};

/** Bake a layer's effects into its pixels (Layer > Rasterize > Layer Style, and merging). */
export function bakeStyle(l: Layer): void {
  const fx = layerEffects(l);
  if (!fx) {
    l.style = null;
    return;
  }
  const r = rectUnion(fx.bounds, l.bounds())!;
  // The layer with its effects, blended normally at full opacity (its own opacity stays on it).
  const copy = Object.assign(new Layer(l.grid.width, l.grid.height, l.name, -3), l.props(), { id: -3, opacity: 1, blendMode: "normal" as const, visible: true, clipped: false });
  copy.grid = l.grid;
  copy.mask = l.mask;
  const px = compositeNodes([copy], r);
  const g = new TileGrid(r.w, r.h);
  g.writeRegion({ x: 0, y: 0, w: r.w, h: r.h }, px);
  g.compact();
  const old = l.bounds();
  l.grid = g;
  l.offsetX = r.x;
  l.offsetY = r.y;
  if (l.mask && l.maskEnabled) l.mask = null; // applied above
  else if (l.mask) {
    // A disabled mask wasn't applied: keep it, moved into the new bounds.
    const m = new Mask(r.w, r.h, l.mask.defaultValue);
    m.writeRegion({ x: old.x - r.x, y: old.y - r.y, w: old.w, h: old.h }, l.mask.readRegion({ x: 0, y: 0, w: old.w, h: old.h }, l.mask.defaultValue));
    m.compact();
    l.mask = m;
  }
  l.style = null;
}

export const styleCommands: CommandDef[] = [
  {
    name: "layer.setStyle",
    label: (p: { style?: LayerStyle | null }) => (p.style && hasEffects(p.style) ? "Layer Style" : "Clear Layer Style"),
    description: "Set a layer's effects: dropShadow, innerShadow, outerGlow, innerGlow, bevel, colorOverlay, stroke. Pass style null (or {}) to clear them.",
    params: { type: "object", properties: { id: nodeId, style: STYLE_SCHEMA } },
    history: true,
    enabled: (ctx) => ctx.doc.layers.length > 0,
    run(ctx, p: { id?: number; style?: LayerStyle }) {
      const l = targetLayer(ctx, p.id);
      if (l.isBackground) throw new ValidationError("the Background layer can't have effects; convert it to a layer first (Layer > New > Layer From Background)");
      const s = normalizeStyle(p.style);
      l.style = s && FX_KEYS.some((k) => s[k]) ? s : null;
      ctx.doc.emit({ type: "layers" });
      ctx.doc.dirty(null);
    },
  },
  {
    name: "layer.rasterizeStyle",
    label: "Rasterize Layer Style",
    description: "Turn a layer's effects into ordinary pixels (the layer mask is applied too).",
    params: { type: "object", properties: { id: nodeId } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeLayer?.style,
    run(ctx, p: { id?: number }) {
      const l = targetLayer(ctx, p.id);
      if (!l.style) throw new ValidationError(`"${l.name}" has no layer style`);
      assertPixelsEditable(l);
      bakeStyle(l);
      ctx.doc.emit({ type: "layers" });
      ctx.doc.dirty(null);
    },
  },
];
