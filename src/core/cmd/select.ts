/** Select menu and selection-tool commands. */

import { CommandDef, ObjectSchema, ValidationError } from "../commands";
import { Mask } from "../mask";
import {
  SELECT_MODES,
  SelectMode,
  applySelection,
  borderMask,
  colorRangeMask,
  contractMask,
  ellipseMask,
  expandMask,
  featherMask,
  growMask,
  polygonMask,
  rectMask,
  smoothMask,
  wandMask,
} from "../selection";

const mode = { type: "string" as const, enum: SELECT_MODES, default: "replace", description: "replace, add to, subtract from or intersect with the current selection" };
const feather = { type: "number" as const, minimum: 0, maximum: 250, default: 0, description: "Feather radius in pixels" };
const antiAlias = { type: "boolean" as const, default: true };
const rectProps = { x: { type: "number" as const }, y: { type: "number" as const }, w: { type: "number" as const, minimum: 1 }, h: { type: "number" as const, minimum: 1 } };
const noParams: ObjectSchema = { type: "object", properties: {} };
const hasSel: CommandDef["enabled"] = (ctx) => !!ctx.doc.selection;

type ShapeParams = { mode: SelectMode; feather: number; antiAlias?: boolean };

export const selectCommands: CommandDef[] = [
  {
    name: "select.rect",
    label: "Rectangular Marquee",
    description: "Select a rectangle in canvas pixels (1 px tall or wide for single row/column).",
    params: { type: "object", properties: { ...rectProps, mode, feather }, required: ["x", "y", "w", "h"] },
    history: true,
    run({ doc }, p: { x: number; y: number; w: number; h: number } & ShapeParams) {
      applySelection(doc, rectMask(doc.width, doc.height, p), p.mode, p.feather);
    },
  },
  {
    name: "select.ellipse",
    label: "Elliptical Marquee",
    description: "Select the ellipse inscribed in a rectangle.",
    params: { type: "object", properties: { ...rectProps, mode, feather, antiAlias }, required: ["x", "y", "w", "h"] },
    history: true,
    run({ doc }, p: { x: number; y: number; w: number; h: number } & ShapeParams) {
      applySelection(doc, ellipseMask(doc.width, doc.height, p, p.antiAlias), p.mode, p.feather);
    },
  },
  {
    name: "select.polygon",
    label: (p: { tool?: string }) => (p.tool === "polygonalLasso" ? "Polygonal Lasso" : p.tool === "magneticLasso" ? "Magnetic Lasso" : "Lasso"),
    description: "Select inside a closed polygon given as [x, y] canvas points (the Lasso tools).",
    params: {
      type: "object",
      properties: {
        points: { type: "array", minItems: 3, items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
        tool: { type: "string", enum: ["lasso", "polygonalLasso", "magneticLasso"], default: "lasso" },
        mode,
        feather,
        antiAlias,
      },
      required: ["points"],
    },
    history: true,
    run({ doc }, p: { points: [number, number][] } & ShapeParams) {
      applySelection(doc, polygonMask(doc.width, doc.height, p.points, p.antiAlias), p.mode, p.feather);
    },
  },
  {
    name: "select.wand",
    label: "Magic Wand",
    description: "Select pixels similar in color to the one at x, y.",
    params: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        tolerance: { type: "integer", minimum: 0, maximum: 255, default: 32 },
        contiguous: { type: "boolean", default: true },
        antiAlias,
        sampleMerged: { type: "boolean", default: false, description: "Use All Layers" },
        mode,
      },
      required: ["x", "y"],
    },
    history: true,
    run({ doc }, p: { x: number; y: number; tolerance: number; contiguous: boolean; antiAlias: boolean; sampleMerged: boolean; mode: SelectMode }) {
      applySelection(doc, wandMask(doc, p.x, p.y, p), p.mode);
    },
  },
  {
    name: "select.colorRange",
    label: "Color Range",
    description: "Select all pixels near a color across the image; fuzziness 0-200 widens and softens the range.",
    params: {
      type: "object",
      properties: {
        r: { type: "integer", minimum: 0, maximum: 255 },
        g: { type: "integer", minimum: 0, maximum: 255 },
        b: { type: "integer", minimum: 0, maximum: 255 },
        fuzziness: { type: "integer", minimum: 0, maximum: 200, default: 40 },
        mode,
      },
      required: ["r", "g", "b"],
    },
    history: true,
    run({ doc }, p: { r: number; g: number; b: number; fuzziness: number; mode: SelectMode }) {
      applySelection(doc, colorRangeMask(doc, [p.r, p.g, p.b], p.fuzziness), p.mode);
    },
  },
  {
    name: "select.all",
    label: "Select All",
    description: "Select the whole canvas.",
    params: noParams,
    history: true,
    run({ doc }) {
      doc.setSelection(Mask.full(doc.width, doc.height));
    },
  },
  {
    name: "select.none",
    label: "Deselect",
    description: "Remove the selection.",
    params: noParams,
    history: true,
    enabled: hasSel,
    run({ doc }) {
      doc.setSelection(null);
    },
  },
  {
    name: "select.reselect",
    label: "Reselect",
    description: "Bring back the last selection that was removed.",
    params: noParams,
    history: true,
    enabled: (ctx) => !!ctx.doc.lastSelection,
    run({ doc }) {
      if (!doc.lastSelection) throw new ValidationError("there is no previous selection");
      doc.setSelection(doc.lastSelection.share());
    },
  },
  {
    name: "select.inverse",
    label: "Inverse",
    description: "Invert the selection.",
    params: noParams,
    history: true,
    enabled: hasSel,
    run({ doc }) {
      if (!doc.selection) throw new ValidationError("there is no selection");
      const m = doc.selection.share();
      m.invert();
      doc.setSelection(m.isEmpty() ? null : m);
    },
  },
  {
    name: "select.grow",
    label: "Grow",
    description: "Add the pixels next to the selection that are close in color to it (uses the Magic Wand tolerance).",
    params: {
      type: "object",
      properties: { tolerance: { type: "integer", minimum: 0, maximum: 255, default: 32 }, sampleMerged: { type: "boolean", default: false, description: "Use All Layers" } },
    },
    history: true,
    enabled: hasSel,
    run({ doc }, p: { tolerance: number; sampleMerged: boolean }) {
      const m = growMask(doc, p.tolerance, true, p.sampleMerged);
      if (!m) throw new ValidationError("there is no selection to grow");
      doc.setSelection(m);
    },
  },
  {
    name: "select.similar",
    label: "Similar",
    description: "Add every pixel in the image that is close in color to the selection (uses the Magic Wand tolerance).",
    params: {
      type: "object",
      properties: { tolerance: { type: "integer", minimum: 0, maximum: 255, default: 32 }, sampleMerged: { type: "boolean", default: false, description: "Use All Layers" } },
    },
    history: true,
    enabled: hasSel,
    run({ doc }, p: { tolerance: number; sampleMerged: boolean }) {
      const m = growMask(doc, p.tolerance, false, p.sampleMerged);
      if (!m) throw new ValidationError("there is no selection to extend");
      doc.setSelection(m);
    },
  },
  {
    name: "select.feather",
    label: "Feather",
    description: "Soften the selection edge by a radius in pixels.",
    params: { type: "object", properties: { radius: { type: "number", minimum: 0.2, maximum: 250 } }, required: ["radius"] },
    history: true,
    enabled: hasSel,
    run({ doc }, p: { radius: number }) {
      if (!doc.selection) throw new ValidationError("there is no selection");
      const m = featherMask(doc.selection, p.radius);
      doc.setSelection(m.isEmpty() ? null : m);
    },
  },
  {
    name: "select.modify",
    label: (p: { op: string }) => p.op[0].toUpperCase() + p.op.slice(1),
    description: "Select > Modify: border, smooth, expand or contract the selection by a number of pixels.",
    params: {
      type: "object",
      properties: { op: { type: "string", enum: ["border", "smooth", "expand", "contract"] }, amount: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["op", "amount"],
    },
    history: true,
    enabled: hasSel,
    run({ doc }, p: { op: string; amount: number }) {
      const s = doc.selection;
      if (!s) throw new ValidationError("there is no selection");
      const m =
        p.op === "border" ? borderMask(s, p.amount) : p.op === "smooth" ? smoothMask(s, p.amount) : p.op === "expand" ? expandMask(s, p.amount) : contractMask(s, p.amount);
      doc.setSelection(m.isEmpty() ? null : m);
    },
  },
  {
    name: "select.translate",
    label: "Move Selection",
    description: "Move the selection outline (not the pixels) by dx, dy.",
    params: { type: "object", properties: { dx: { type: "integer" }, dy: { type: "integer" } }, required: ["dx", "dy"] },
    history: true,
    enabled: hasSel,
    run({ doc }, p: { dx: number; dy: number }) {
      if (!doc.selection) throw new ValidationError("there is no selection");
      const m = doc.selection.translated(p.dx, p.dy);
      doc.setSelection(m.isEmpty() ? null : m);
    },
  },
  {
    name: "select.quickMask",
    label: (p: { on: boolean }) => (p.on ? "Quick Mask" : "Clear Quick Mask"),
    description: "Enter or leave Quick Mask mode, where painting edits the selection (red = unselected).",
    params: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
    history: true,
    run({ doc }, p: { on: boolean }) {
      if (p.on === doc.quickMask) return;
      doc.quickMask = p.on;
      if (p.on) {
        // No selection means everything is selectable: start from a clear mask.
        if (!doc.selection) doc.selection = Mask.full(doc.width, doc.height);
      } else if (doc.selection) {
        const s = doc.selection;
        s.compact();
        if (s.isEmpty()) doc.selection = null;
      }
      doc.emit({ type: "selection" });
    },
  },
];
