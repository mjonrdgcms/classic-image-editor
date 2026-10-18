/**
 * Layer mask commands. Masks live on layers and on layer sets ("hosts");
 * a layer's mask is in layer space and moves with it while linked, a set's
 * mask is in canvas space. Density and Feather are non-destructive.
 */

import { CommandContext, CommandDef, ValidationError } from "../commands";
import { compositeNodes } from "../composite";
import type { Document, Layer, MaskHost, Node } from "../document";
import { Mask } from "../mask";
import { refineMask, shiftMask } from "../maskfx";
import { SELECT_MODES, type SelectMode, applySelection } from "../selection";
import { assertPixelsEditable, nodeId, targetNode } from "./common";

const hostOf = (ctx: CommandContext, id?: number): Node => targetNode(ctx, id);

function needMask(h: MaskHost): Mask {
  if (!h.mask) throw new ValidationError(`"${h.name}" has no layer mask`);
  return h.mask;
}

/** Host-space rectangle covering the whole canvas. */
const hostCanvas = (doc: Document, h: MaskHost) => ({ x: -h.offsetX, y: -h.offsetY, w: doc.width, h: doc.height });

/** A mask covers its layer's pixel grid (which can be larger than the canvas), or the canvas for a set. */
const hostSize = (doc: Document, h: Node) => (h.kind === "layer" ? { w: h.grid.width, h: h.grid.height } : { w: doc.width, h: doc.height });

/** A mask for `h` (host space, host-sized) from a canvas-space mask. */
function fromCanvas(doc: Document, h: Node, canvasMask: Mask | null, fallback: 0 | 255): Mask {
  const { w, h: hh } = hostSize(doc, h);
  const m = new Mask(w, hh, fallback);
  if (!canvasMask) return m;
  m.writeRegion({ x: 0, y: 0, w, h: hh }, canvasMask.readRegion({ x: h.offsetX, y: h.offsetY, w, h: hh }, fallback));
  return m;
}

/** A host's mask (as composited) in canvas space, document-sized. */
export function maskInCanvas(doc: Document, h: MaskHost, effective = true): Mask {
  const src = effective ? (h.activeMask ?? h.mask!) : h.mask!;
  const m = new Mask(doc.width, doc.height, 0);
  m.writeRegion({ x: 0, y: 0, w: doc.width, h: doc.height }, src.readRegion(hostCanvas(doc, h), src.defaultValue));
  return m;
}

/** The alpha of a layer or set as a canvas-space mask. */
function transparencyMask(doc: Document, n: Node): Mask {
  const r = { x: 0, y: 0, w: doc.width, h: doc.height };
  const px = n.kind === "layer" ? n.grid.readRegion({ x: -n.offsetX, y: -n.offsetY, w: doc.width, h: doc.height }) : compositeNodes(n.children, r);
  const a = new Uint8Array(doc.width * doc.height);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  const m = new Mask(doc.width, doc.height, 0);
  m.writeRegion(r, a);
  return m;
}

/** A layer's alpha over its whole pixel grid (including any part off the canvas), in layer space. */
function gridAlphaMask(l: Layer): Mask {
  const r = { x: 0, y: 0, w: l.grid.width, h: l.grid.height };
  const px = l.grid.readRegion(r);
  const a = new Uint8Array(r.w * r.h);
  for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
  const m = new Mask(r.w, r.h, 0);
  m.writeRegion(r, a);
  return m;
}

/** Selecting a mask turns the foreground and background colors into grays. */
function grayColors(doc: Document): void {
  const g = (c: number[]) => {
    const v = Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
    return [v, v, v, 255] as [number, number, number, number];
  };
  doc.foreground = g(doc.foreground);
  doc.background = g(doc.background);
  doc.emit({ type: "colors" });
}

function changed(doc: Document, h: MaskHost): void {
  doc.emit({ type: "layers" });
  doc.dirty(null);
  void h;
}

/** Canvas-sized mask, inverted in place when asked. */
function inverted(m: Mask, invert?: boolean): Mask {
  if (!invert) return m;
  const r = { x: 0, y: 0, w: m.width, h: m.height };
  const d = m.readRegion(r, m.defaultValue);
  for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
  m.writeRegion(r, d);
  return m;
}

const selectMode = { type: "string" as const, enum: SELECT_MODES, default: "replace" };

export const maskCommands: CommandDef[] = [
  {
    name: "layer.addMask",
    label: "Add Layer Mask",
    description: "Add a layer mask to a layer or layer set: reveal all, hide all, reveal or hide the selection, or from the layer's transparency.",
    params: {
      type: "object",
      properties: { id: nodeId, reveal: { type: "string", enum: ["all", "none", "selection", "hideSelection", "transparency"], default: "all" } },
    },
    history: true,
    enabled: (ctx) => {
      const n = ctx.doc.activeNode;
      return !!n && !n.mask && !(n.kind === "layer" && n.isBackground);
    },
    run(ctx, p: { id?: number; reveal: string }) {
      const doc = ctx.doc;
      const h = hostOf(ctx, p.id);
      if (h.kind === "layer" && h.isBackground) throw new ValidationError("the Background layer can't have a mask; convert it to a layer first");
      if (h.mask) throw new ValidationError(`"${h.name}" already has a layer mask`);
      let m: Mask;
      if (p.reveal === "selection" || p.reveal === "hideSelection") {
        if (!doc.selection) throw new ValidationError("there is no selection");
        m = fromCanvas(doc, h, doc.selection, 0);
        if (p.reveal === "hideSelection") m.invert();
      } else if (p.reveal === "transparency") m = h.kind === "layer" ? gridAlphaMask(h) : fromCanvas(doc, h, transparencyMask(doc, h), 0);
      else {
        const sz = hostSize(doc, h);
        m = new Mask(sz.w, sz.h, p.reveal === "none" ? 0 : 255);
      }
      Object.assign(h, { mask: m, maskEnabled: true, maskDensity: 1, maskFeather: 0, maskLinked: true });
      doc.editMask = true;
      grayColors(doc);
      changed(doc, h);
    },
  },
  {
    name: "layer.removeMask",
    label: (p: { apply: boolean }) => (p.apply ? "Apply Layer Mask" : "Delete Layer Mask"),
    description: "Remove a layer's or set's mask. On a layer it can be applied to the pixels first (with its density and feather).",
    params: { type: "object", properties: { id: nodeId, apply: { type: "boolean", default: false } } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; apply: boolean }) {
      const doc = ctx.doc;
      const h = hostOf(ctx, p.id);
      needMask(h);
      if (p.apply) {
        if (h.kind === "group") throw new ValidationError("a layer set's mask can't be applied, only deleted");
        assertPixelsEditable(h);
        const r = { x: 0, y: 0, w: h.grid.width, h: h.grid.height };
        // Apply what you see (density and feather included); a disabled mask applies as painted.
        const src = h.activeMask ?? h.mask!;
        const px = h.grid.readRegion(r);
        const mv = src.readRegion(r, src.defaultValue);
        for (let i = 0, o = 3; i < mv.length; i++, o += 4) px[o] = Math.round((px[o] * mv[i]) / 255);
        h.grid.writeRegion(r, px);
        h.grid.compact();
      }
      Object.assign(h, { mask: null, maskEnabled: true, maskDensity: 1, maskFeather: 0, maskLinked: true });
      doc.editMask = false;
      changed(doc, h);
    },
  },
  {
    name: "layer.setMaskEnabled",
    label: (p: { enabled: boolean }) => (p.enabled ? "Enable Layer Mask" : "Disable Layer Mask"),
    description: "Turn a mask's effect on or off without deleting it.",
    params: { type: "object", properties: { id: nodeId, enabled: { type: "boolean" } }, required: ["enabled"] },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; enabled: boolean }) {
      const h = hostOf(ctx, p.id);
      needMask(h);
      h.maskEnabled = p.enabled;
      changed(ctx.doc, h);
    },
  },
  {
    name: "layer.editMask",
    label: "Edit Target",
    description: "Choose whether painting edits the active layer's or set's mask (true) or the layer's pixels (false).",
    params: { type: "object", properties: { edit: { type: "boolean" } }, required: ["edit"] },
    history: false,
    run(ctx, p: { edit: boolean }) {
      const n = ctx.doc.activeNode;
      if (!n) throw new ValidationError("nothing is selected in the Layers palette");
      if (p.edit && !n.mask) throw new ValidationError(`"${n.name}" has no layer mask`);
      if (!p.edit && n.kind === "group") throw new ValidationError("a layer set has no pixels of its own to edit");
      ctx.doc.editMask = p.edit;
      if (p.edit) grayColors(ctx.doc);
      ctx.doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.setMaskProperties",
    label: (p: { linked?: boolean; density?: number; feather?: number }) =>
      p.linked !== undefined && p.density === undefined && p.feather === undefined ? (p.linked ? "Link Layer Mask" : "Unlink Layer Mask") : "Mask Properties",
    description: "Set a mask's density (0-100%, 100 = as painted), feather (blur radius in px, non-destructive) or whether it moves with its layer (linked).",
    params: {
      type: "object",
      properties: {
        id: nodeId,
        density: { type: "number", minimum: 0, maximum: 100, description: "Percent" },
        feather: { type: "number", minimum: 0, maximum: 250, description: "Pixels" },
        linked: { type: "boolean" },
      },
    },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; density?: number; feather?: number; linked?: boolean }) {
      const h = hostOf(ctx, p.id);
      needMask(h);
      if (p.density !== undefined) h.maskDensity = Math.round(p.density) / 100;
      if (p.feather !== undefined) h.maskFeather = Math.round(p.feather * 10) / 10;
      if (p.linked !== undefined) h.maskLinked = p.linked;
      changed(ctx.doc, h);
    },
  },
  {
    name: "layer.offsetMask",
    label: "Move Layer Mask",
    description: "Move a mask by dx, dy without moving its layer.",
    params: { type: "object", properties: { id: nodeId, dx: { type: "integer" }, dy: { type: "integer" } }, required: ["dx", "dy"] },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; dx: number; dy: number }) {
      const h = hostOf(ctx, p.id);
      h.mask = shiftMask(needMask(h), p.dx, p.dy);
      changed(ctx.doc, h);
    },
  },
  {
    name: "layer.moveMask",
    label: (p: { copy: boolean }) => (p.copy ? "Copy Layer Mask" : "Move Layer Mask"),
    description: "Move (or copy) a mask from one layer or set to another. Replaces any mask the target had.",
    params: { type: "object", properties: { from: nodeId, to: { type: "integer", minimum: 1 }, copy: { type: "boolean", default: false } }, required: ["to"] },
    history: true,
    run(ctx, p: { from?: number; to: number; copy: boolean }) {
      const doc = ctx.doc;
      const src = hostOf(ctx, p.from);
      const dst = doc.nodeById(p.to);
      if (!dst) throw new ValidationError(`no layer or set with id ${p.to}`);
      if (dst === src) throw new ValidationError("drop the mask on a different layer");
      if (dst.kind === "layer" && dst.isBackground) throw new ValidationError("the Background layer can't have a mask");
      const m = needMask(src);
      const sz = hostSize(doc, dst);
      dst.mask = shiftMask(m, src.offsetX - dst.offsetX, src.offsetY - dst.offsetY, sz.w, sz.h);
      Object.assign(dst, { maskEnabled: src.maskEnabled, maskDensity: src.maskDensity, maskFeather: src.maskFeather, maskLinked: src.maskLinked });
      if (!p.copy) Object.assign(src, { mask: null, maskEnabled: true, maskDensity: 1, maskFeather: 0, maskLinked: true });
      doc.activeLayerId = dst.id;
      doc.editMask = true;
      changed(doc, dst);
    },
  },
  {
    name: "layer.refineMask",
    label: "Mask Edge",
    description: "Refine a mask's edge: smooth jaggies (0-100), feather (px), contrast (0-100, crisper) and shift the edge (-100 shrink to 100 grow).",
    params: {
      type: "object",
      properties: {
        id: nodeId,
        smooth: { type: "number", minimum: 0, maximum: 100, default: 0 },
        feather: { type: "number", minimum: 0, maximum: 250, default: 0 },
        contrast: { type: "number", minimum: 0, maximum: 100, default: 0 },
        shift: { type: "number", minimum: -100, maximum: 100, default: 0 },
      },
    },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; smooth: number; feather: number; contrast: number; shift: number }) {
      const h = hostOf(ctx, p.id);
      h.mask = refineMask(needMask(h), p);
      changed(ctx.doc, h);
    },
  },
  {
    name: "layer.invertMask",
    label: "Invert Layer Mask",
    description: "Invert a mask: what was hidden shows and what showed is hidden.",
    params: { type: "object", properties: { id: nodeId } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number }) {
      const h = hostOf(ctx, p.id);
      const m = needMask(h);
      // Invert the default too, so areas outside the canvas follow.
      const out = new Mask(m.width, m.height, (255 - m.defaultValue) as 0 | 255);
      const r = { x: 0, y: 0, w: m.width, h: m.height };
      const d = m.readRegion(r, m.defaultValue);
      for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
      out.writeRegion(r, d);
      h.mask = out;
      changed(ctx.doc, h);
    },
  },
  {
    name: "layer.maskFromSelection",
    label: "Mask from Selection",
    description: "Change a mask using the selection: replace it, add the selection to it, subtract or intersect.",
    params: { type: "object", properties: { id: nodeId, mode: selectMode } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; mode: SelectMode }) {
      const doc = ctx.doc;
      const h = hostOf(ctx, p.id);
      const m = needMask(h);
      const sel = fromCanvas(doc, h, doc.selection, 0);
      if (p.mode === "replace") h.mask = sel;
      else {
        const next = new Mask(m.width, m.height, m.defaultValue);
        next.writeRegion({ x: 0, y: 0, w: m.width, h: m.height }, m.readRegion({ x: 0, y: 0, w: m.width, h: m.height }, m.defaultValue));
        next.combine(sel, p.mode);
        h.mask = next;
      }
      changed(doc, h);
    },
  },
  {
    name: "select.fromMask",
    label: "Load Selection",
    description: "Load a layer's or set's mask (as it composites) as a selection: replace, add, subtract or intersect.",
    params: { type: "object", properties: { id: nodeId, mode: selectMode, invert: { type: "boolean", default: false } } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode?.mask,
    run(ctx, p: { id?: number; mode: SelectMode; invert?: boolean }) {
      const doc = ctx.doc;
      const h = hostOf(ctx, p.id);
      needMask(h);
      applySelection(doc, inverted(maskInCanvas(doc, h), p.invert), p.mode);
    },
  },
  {
    name: "select.fromTransparency",
    label: "Load Selection",
    description: "Select a layer's (or set's) non-transparent pixels: replace, add, subtract or intersect.",
    params: { type: "object", properties: { id: nodeId, mode: selectMode, invert: { type: "boolean", default: false } } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode,
    run(ctx, p: { id?: number; mode: SelectMode; invert?: boolean }) {
      const doc = ctx.doc;
      applySelection(doc, inverted(transparencyMask(doc, hostOf(ctx, p.id)), p.invert), p.mode);
    },
  },
];
