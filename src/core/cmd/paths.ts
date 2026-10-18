/**
 * Paths and shape layers: the Paths palette (Work Path, saved paths, fill,
 * stroke, load as selection, make from selection) and the Shape tools'
 * shape layers.
 */

import { BrushPreset, roundBrush } from "../brushes";
import { Stroke } from "../brush";
import { CommandContext, CommandDef, ValidationError } from "../commands";
import type { DocPath, Document, RGBA } from "../document";
import { SELECT_MODES, SelectMode, applySelection, featherMask } from "../selection";
import { renderShapeLayer, setShapeCanvasPath, shapeCanvasPath } from "../shapes";
import { TileGrid, rectIntersect } from "../tiles";
import { PATH_SCHEMA, emptyPath, flatten, normalizePath, pathFromMask, pathMask, type VecPath } from "../vector";
import { hasLayer, nodeId, paintTarget, percent, targetLayer } from "./common";

type PathParam = { subpaths: { closed?: boolean; pts: { x: number; y: number; ix?: number; iy?: number; ox?: number; oy?: number }[] }[] };

const pathId = { type: "integer" as const, minimum: 1, description: "Path id in the Paths palette (default: the Work Path)" };
const rgb = { type: "array" as const, items: { type: "integer" as const, minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3, description: "RGB; defaults to the foreground color" };

const nextPathId = (doc: Document) => Math.max(0, ...doc.paths.map((p) => p.id)) + 1;

/** The path a command acts on: given inline, by id, the active shape layer's, or the Work Path. */
export function resolvePath(ctx: CommandContext, p: { id?: number; path?: PathParam; shape?: boolean }): VecPath {
  const doc = ctx.doc;
  if (p.path) return normalizePath(p.path);
  if (p.id !== undefined) {
    const dp = doc.paths.find((x) => x.id === p.id);
    if (!dp) throw new ValidationError(`there is no path ${p.id}`);
    return dp.path;
  }
  if (p.shape && doc.activeLayer?.shape) return shapeCanvasPath(doc.activeLayer);
  const work = doc.paths.find((x) => x.work);
  if (!work || !work.path.subpaths.length) throw new ValidationError("there is no path; draw one with the Pen or a Shape tool first");
  return work.path;
}

function setWorkPath(doc: Document, path: VecPath): void {
  const i = doc.paths.findIndex((x) => x.work);
  const entry: DocPath = { id: i >= 0 ? doc.paths[i].id : nextPathId(doc), name: "Work Path", path, work: true };
  doc.paths = i >= 0 ? doc.paths.map((x, j) => (j === i ? entry : x)) : [...doc.paths, entry];
}

const changed = (doc: Document) => doc.emit({ type: "guides" });

const colorOf = (doc: Document, c?: number[]): RGBA => (c ? [c[0], c[1], c[2], 255] : [...doc.foreground]);

export const pathCommands: CommandDef[] = [
  {
    name: "path.set",
    label: (p: { id?: number }) => (p.id === undefined ? "Work Path" : "Edit Path"),
    description: "Replace a path in the Paths palette (default: the Work Path, made if there is none).",
    params: { type: "object", properties: { id: pathId, path: PATH_SCHEMA }, required: ["path"] },
    history: true,
    run({ doc }, p: { id?: number; path: PathParam }) {
      const path = normalizePath(p.path);
      if (p.id === undefined) setWorkPath(doc, path);
      else {
        const i = doc.paths.findIndex((x) => x.id === p.id);
        if (i < 0) throw new ValidationError(`there is no path ${p.id}`);
        doc.paths = doc.paths.map((x, j) => (j === i ? { ...x, path } : x));
      }
      changed(doc);
    },
  },
  {
    name: "path.save",
    label: (p: { id?: number }) => (p.id === undefined ? "Save Path" : "Rename Path"),
    description: "Save the Work Path under a name (or rename a saved path).",
    params: { type: "object", properties: { id: pathId, name: { type: "string" } }, required: ["name"] },
    history: true,
    run({ doc }, p: { id?: number; name: string }) {
      const i = p.id === undefined ? doc.paths.findIndex((x) => x.work) : doc.paths.findIndex((x) => x.id === p.id);
      if (i < 0) throw new ValidationError(p.id === undefined ? "there is no Work Path to save" : `there is no path ${p.id}`);
      doc.paths = doc.paths.map((x, j) => (j === i ? { ...x, name: p.name || x.name, work: false } : x));
      changed(doc);
    },
  },
  {
    name: "path.new",
    label: "New Path",
    description: "Add an empty saved path to the Paths palette.",
    params: { type: "object", properties: { name: { type: "string" } } },
    history: true,
    run({ doc }, p: { name?: string }) {
      let n = 1;
      while (doc.paths.some((x) => x.name === `Path ${n}`)) n++;
      doc.paths = [...doc.paths, { id: nextPathId(doc), name: p.name ?? `Path ${n}`, path: emptyPath(), work: false }];
      changed(doc);
    },
  },
  {
    name: "path.delete",
    label: "Delete Path",
    description: "Delete a path from the Paths palette (default: the Work Path).",
    params: { type: "object", properties: { id: pathId } },
    history: true,
    enabled: (ctx) => ctx.doc.paths.length > 0,
    run({ doc }, p: { id?: number }) {
      const i = p.id === undefined ? doc.paths.findIndex((x) => x.work) : doc.paths.findIndex((x) => x.id === p.id);
      if (i < 0) throw new ValidationError("there is no such path");
      doc.paths = doc.paths.filter((_, j) => j !== i);
      changed(doc);
    },
  },
  {
    name: "path.toSelection",
    label: "Make Selection",
    description: "Load a path as a selection (default: the Work Path, or the active shape layer's shape with shape true).",
    params: {
      type: "object",
      properties: {
        id: pathId,
        path: PATH_SCHEMA,
        shape: { type: "boolean", default: false },
        mode: { type: "string", enum: SELECT_MODES, default: "replace" },
        feather: { type: "number", minimum: 0, maximum: 250, default: 0 },
        antiAlias: { type: "boolean", default: true },
      },
    },
    history: true,
    run(ctx, p: { id?: number; path?: PathParam; shape: boolean; mode: SelectMode; feather: number; antiAlias: boolean }) {
      const path = resolvePath(ctx, p);
      applySelection(ctx.doc, pathMask(path, ctx.doc.width, ctx.doc.height, p.antiAlias), p.mode, p.feather);
    },
  },
  {
    name: "path.fromSelection",
    label: "Make Work Path",
    description: "Trace the selection's edge into the Work Path; tolerance (0.5-10 px) trades accuracy for fewer points.",
    params: { type: "object", properties: { tolerance: { type: "number", minimum: 0.5, maximum: 10, default: 2 } } },
    history: true,
    enabled: (ctx) => !!ctx.doc.selection,
    run({ doc }, p: { tolerance: number }) {
      if (!doc.selection) throw new ValidationError("make a selection first");
      const path = pathFromMask(doc.selection, p.tolerance);
      if (!path.subpaths.length) throw new ValidationError("the selection is empty");
      setWorkPath(doc, path);
      changed(doc);
    },
  },
  {
    name: "path.fill",
    label: "Fill Path",
    description: "Fill a path's area on the active layer (or its mask) with a color (default the foreground).",
    params: {
      type: "object",
      properties: { id: pathId, path: PATH_SCHEMA, color: rgb, opacity: { ...percent("Opacity in percent"), default: 100 }, feather: { type: "number", minimum: 0, maximum: 250, default: 0 }, antiAlias: { type: "boolean", default: true } },
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; path?: PathParam; color?: number[]; opacity: number; feather: number; antiAlias: boolean }) {
      const doc = ctx.doc;
      const path = resolvePath(ctx, p);
      let m = pathMask(path, doc.width, doc.height, p.antiAlias);
      if (p.feather > 0) m = featherMask(m, p.feather);
      const c = colorOf(doc, p.color);
      const t = paintTarget(ctx);
      const b = m.bounds();
      if (!b) return;
      if (t.kind === "selection") throw new ValidationError("Fill Path does not work in Quick Mask");
      const selCov = doc.selection ? doc.selection.readRegion(b) : null;
      const cov = m.readRegion(b);
      const op = p.opacity / 100;
      if (t.kind === "mask") {
        const h = t.host, mk = h.mask!;
        const r = rectIntersect({ x: b.x - h.offsetX, y: b.y - h.offsetY, w: b.w, h: b.h }, { x: 0, y: 0, w: mk.width, h: mk.height });
        if (!r) return;
        const d = mk.readRegion(r, mk.defaultValue);
        const gray = Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++) {
            const k = (y + r.y + h.offsetY - b.y) * b.w + (x + r.x + h.offsetX - b.x);
            const a = (cov[k] / 255) * op * (selCov ? selCov[k] / 255 : 1);
            const i = y * r.w + x;
            if (a > 0) d[i] = Math.round(d[i] + (gray - d[i]) * a);
          }
        mk.writeRegion(r, d);
        doc.dirty({ x: r.x + h.offsetX, y: r.y + h.offsetY, w: r.w, h: r.h });
        return;
      }
      const l = t.layer;
      const r = rectIntersect({ x: b.x - l.offsetX, y: b.y - l.offsetY, w: b.w, h: b.h }, { x: 0, y: 0, w: l.grid.width, h: l.grid.height });
      if (!r) return;
      const px = l.grid.readRegion(r);
      const keep = l.locks.transparency;
      for (let y = 0; y < r.h; y++)
        for (let x = 0; x < r.w; x++) {
          const k = (y + r.y + l.offsetY - b.y) * b.w + (x + r.x + l.offsetX - b.x);
          const a = (cov[k] / 255) * op * (selCov ? selCov[k] / 255 : 1);
          if (a <= 0) continue;
          const o = (y * r.w + x) * 4;
          const oA = px[o + 3] / 255;
          if (keep && !oA) continue;
          const outA = a + oA * (1 - a);
          for (let ch = 0; ch < 3; ch++) px[o + ch] = Math.round((c[ch] * a + px[o + ch] * oA * (1 - a)) / outA);
          px[o + 3] = keep ? px[o + 3] : l.isBackground ? 255 : Math.round(outA * 255);
        }
      l.grid.writeRegion(r, px);
      doc.dirty({ x: r.x + l.offsetX, y: r.y + l.offsetY, w: r.w, h: r.h });
    },
  },
  {
    name: "path.stroke",
    label: "Stroke Path",
    description: "Paint along a path with a round brush (or the eraser), as if dragging the brush along it.",
    params: {
      type: "object",
      properties: {
        id: pathId,
        path: PATH_SCHEMA,
        tool: { type: "string", enum: ["brush", "pencil", "eraser"], default: "brush" },
        size: { type: "number", minimum: 1, maximum: 2500, default: 5 },
        hardness: { ...percent("Brush hardness"), default: 100 },
        color: rgb,
        opacity: { ...percent("Opacity in percent"), default: 100 },
      },
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; path?: PathParam; tool: "brush" | "pencil" | "eraser"; size: number; hardness: number; color?: number[]; opacity: number }) {
      const doc = ctx.doc;
      const path = resolvePath(ctx, p);
      const brush: BrushPreset = { ...roundBrush(p.size, p.hardness), spacing: 10 };
      for (const s of flatten(path, 0.25)) {
        if (s.pts.length < 1) continue;
        const st = new Stroke(doc, paintTarget(ctx), {
          tool: p.tool,
          brush,
          opacity: p.opacity / 100,
          flow: 1,
          mode: "normal",
          fg: colorOf(doc, p.color),
          bg: [...doc.background],
          seed: 1,
          aliased: p.tool === "pencil",
        });
        for (const [x, y] of s.pts) st.addPoint(x, y, 1);
        if (s.closed) st.addPoint(s.pts[0][0], s.pts[0][1], 1);
        st.end();
      }
    },
  },
  {
    name: "layer.newShape",
    label: "New Shape Layer",
    description: "Make a shape layer: a vector path (canvas pixels) filled with a color, editable with the path tools.",
    params: { type: "object", properties: { path: PATH_SCHEMA, color: rgb, name: { type: "string" } }, required: ["path"] },
    history: true,
    run({ doc }, p: { path: PathParam; color?: number[]; name?: string }) {
      const path = normalizePath(p.path);
      if (!path.subpaths.length) throw new ValidationError("the shape is empty");
      let n = 1;
      while (doc.layers.some((l) => l.name === `Shape ${n}`)) n++;
      const l = doc.addLayer(p.name ?? `Shape ${n}`);
      const c = colorOf(doc, p.color);
      l.grid = new TileGrid(1, 1);
      l.shape = { path, color: [c[0], c[1], c[2]] };
      const r = renderShapeLayer(l);
      doc.emit({ type: "layers" });
      doc.dirty(r);
    },
  },
  {
    name: "layer.setShape",
    label: (p: { color?: unknown }) => (p.color && !(p as { path?: unknown }).path ? "Shape Color" : "Edit Shape"),
    description: "Change a shape layer's path (canvas pixels) or fill color.",
    params: { type: "object", properties: { id: nodeId, path: PATH_SCHEMA, color: rgb } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeLayer?.shape,
    run(ctx, p: { id?: number; path?: PathParam; color?: number[] }) {
      const l = targetLayer(ctx, p.id);
      if (!l.shape) throw new ValidationError(`"${l.name}" is not a shape layer`);
      if (p.color) l.shape = { ...l.shape, color: [p.color[0], p.color[1], p.color[2]] };
      const r = p.path ? setShapeCanvasPath(l, normalizePath(p.path)) : renderShapeLayer(l);
      ctx.doc.emit({ type: "layers" });
      ctx.doc.dirty(r);
    },
  },
  {
    name: "layer.rasterizeShape",
    label: "Rasterize Shape",
    description: "Turn a shape layer into an ordinary pixel layer (the path is no longer editable).",
    params: { type: "object", properties: { id: nodeId } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeLayer?.shape,
    run(ctx, p: { id?: number }) {
      const l = targetLayer(ctx, p.id);
      if (!l.shape) throw new ValidationError(`"${l.name}" is not a shape layer`);
      l.shape = null;
      ctx.doc.emit({ type: "layers" });
    },
  },
];
