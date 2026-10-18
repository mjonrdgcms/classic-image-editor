/** Shared helpers for command definitions. */

import type { PaintTarget } from "../brush";
import { CommandContext, ValidationError } from "../commands";
import type { Layer, Node } from "../document";

export const percent = (description: string) => ({ type: "number" as const, minimum: 0, maximum: 100, description });
export const nodeId = { type: "integer" as const, minimum: 1, description: "Layer or set id; defaults to the active one" };

export function targetLayer(ctx: CommandContext, id?: number): Layer {
  const l = id ? ctx.doc.layerById(id) : ctx.doc.activeLayer;
  if (!l) throw new ValidationError(id ? `no layer with id ${id}` : "no pixel layer is active (a layer set is selected)");
  return l;
}

export function targetNode(ctx: CommandContext, id?: number): Node {
  const n = id ? ctx.doc.nodeById(id) : ctx.doc.activeNode;
  if (!n) throw new ValidationError(id ? `no layer or set with id ${id}` : "nothing is selected in the Layers palette");
  return n;
}

export const hasLayer = (ctx: CommandContext) => !!ctx.doc.activeLayer;
/** Something to paint on: a layer, a mask being edited (also a set's), or Quick Mask. */
export const canPaint = (ctx: CommandContext) => hasLayer(ctx) || ctx.doc.quickMask || (ctx.doc.editMask && !!ctx.doc.activeNode?.mask);

/** Thrown when an edit needs a type layer's pixels; the UI offers to rasterize it and retry. */
export class NeedsRasterizeError extends ValidationError {
  constructor(
    public layerId: number,
    name: string,
    public kind: "type" | "shape" = "type",
  ) {
    super(kind === "shape" ? `"${name}" is a shape layer; rasterize it first (Layer > Rasterize > Shape)` : `"${name}" is a type layer; rasterize it first (Layer > Rasterize > Type)`);
  }
}

/** Refuse edits to a pixel-locked layer, or to a type layer's pixels. */
export function assertPixelsEditable(l: Layer): void {
  if (l.locks.pixels) throw new ValidationError(`"${l.name}" has its image pixels locked`);
  if (l.text) throw new NeedsRasterizeError(l.id, l.name);
  if (l.shape) throw new NeedsRasterizeError(l.id, l.name, "shape");
}

/**
 * Where painting and fills go: the selection in Quick Mask, the layer mask
 * when it is being edited, otherwise the layer's pixels.
 */
export function paintTarget(ctx: CommandContext, explicit?: string): PaintTarget {
  const doc = ctx.doc;
  if (explicit === "selection" || (!explicit && doc.quickMask)) {
    if (!doc.quickMask && explicit === "selection" && !doc.selection) throw new ValidationError("there is no selection to paint");
    return { kind: "selection" };
  }
  const n = doc.activeNode;
  if (n && (explicit === "mask" || (!explicit && doc.editMask && n.mask))) {
    if (!n.mask) throw new ValidationError(`"${n.name}" has no layer mask`);
    return { kind: "mask", host: n };
  }
  const l = targetLayer(ctx);
  assertPixelsEditable(l);
  return { kind: "pixels", layer: l };
}

export const PAINT_TARGETS = ["pixels", "mask", "selection"] as const;
