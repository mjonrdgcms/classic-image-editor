/** Layer, layer set, mask, clipping, lock and link commands. */

import { BLEND_MODES } from "../blend";
import { CommandContext, CommandDef, ValidationError } from "../commands";
import { compositeNodes, layerSource } from "../composite";
import { Document, Group, GroupBlend, Layer, Node } from "../document";
import { shiftMask } from "../maskfx";
import { Rect, TILE, TileGrid, rectIntersect, rectUnion } from "../tiles";
import { Mask } from "../mask";
import { layerEffects } from "../styles";
import { bakeStyle } from "./styles";
import { assertPixelsEditable, hasLayer, nodeId, percent, targetLayer, targetNode } from "./common";

// ---------------------------------------------------------------- helpers

function contentBounds(l: Layer): Rect | null {
  let r: Rect | null = null;
  const g = l.grid;
  for (let i = 0; i < g.tiles.length; i++)
    if (g.tiles[i]) r = rectUnion(r, { x: (i % g.cols) * TILE + l.offsetX, y: ((i / g.cols) | 0) * TILE + l.offsetY, w: TILE, h: TILE });
  return r;
}

/** Enlarge a layer's pixel grid (and mask) so it covers canvas rect r. */
export function growLayer(l: Layer, r: Rect): void {
  const b = l.bounds();
  const u = rectUnion(b, r)!;
  if (u.x === b.x && u.y === b.y && u.w === b.w && u.h === b.h) return;
  const g = new TileGrid(u.w, u.h);
  g.writeRegion({ x: b.x - u.x, y: b.y - u.y, w: b.w, h: b.h }, l.grid.readRegion({ x: 0, y: 0, w: b.w, h: b.h }));
  g.compact();
  if (l.mask) {
    const m = new Mask(u.w, u.h, l.mask.defaultValue);
    m.writeRegion({ x: b.x - u.x, y: b.y - u.y, w: b.w, h: b.h }, l.mask.readRegion({ x: 0, y: 0, w: b.w, h: b.h }, l.mask.defaultValue));
    m.compact();
    l.mask = m;
  }
  l.grid = g;
  l.offsetX = u.x;
  l.offsetY = u.y;
}

/** The tight bounds of a layer's visible pixels (canvas space), or null if it's empty. */
export function pixelBounds(l: Layer): Rect | null {
  const g = l.grid;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let ty = 0; ty < g.rows; ty++)
    for (let tx = 0; tx < g.cols; tx++) {
      const t = g.getTile(tx, ty);
      if (!t) continue;
      // Skip tiles that can't change the bounds found so far.
      if (tx * TILE >= x0 && tx * TILE + TILE - 1 <= x1 && ty * TILE >= y0 && ty * TILE + TILE - 1 <= y1) continue;
      const tw = Math.min(TILE, g.width - tx * TILE), th = Math.min(TILE, g.height - ty * TILE);
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++)
          if (t.data[(y * TILE + x) * 4 + 3]) {
            const gx = tx * TILE + x, gy = ty * TILE + y;
            if (gx < x0) x0 = gx;
            if (gx > x1) x1 = gx;
            if (gy < y0) y0 = gy;
            if (gy > y1) y1 = gy;
          }
    }
  if (x1 < 0) return null;
  return { x: x0 + l.offsetX, y: y0 + l.offsetY, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const ALIGN_EDGES = ["top", "vcenter", "bottom", "left", "hcenter", "right"] as const;
type AlignEdge = (typeof ALIGN_EDGES)[number];

/** The selected layers and sets as movable units, each with its pixel bounds. */
function alignUnits(doc: Document): { layers: Layer[]; groups: Group[]; b: Rect }[] {
  const out: { layers: Layer[]; groups: Group[]; b: Rect }[] = [];
  for (const n of doc.selectedNodes) {
    // A set selected along with its own contents moves as the set.
    if (n.kind === "layer" && doc.parentOf(n.id) && doc.isSelected(doc.parentOf(n.id)!.id)) continue;
    const m = movingSet(doc, [n]);
    if (m.layers.some((l) => l.isBackground || l.locks.position)) continue;
    let b: Rect | null = null;
    for (const l of m.layers) b = rectUnion(b, pixelBounds(l));
    if (!b) continue;
    // Linked layers selected together are one unit (or they would move twice).
    const same = out.find((u) => u.layers.some((l) => m.layers.includes(l)));
    if (same) {
      for (const l of m.layers) if (!same.layers.includes(l)) same.layers.push(l);
      for (const g of m.groups) if (!same.groups.includes(g)) same.groups.push(g);
      same.b = rectUnion(same.b, b)!;
    } else out.push({ ...m, b });
  }
  return out;
}

function shiftUnit(u: { layers: Layer[]; groups: Group[] }, dx: number, dy: number): void {
  if (!dx && !dy) return;
  for (const l of u.layers) {
    l.offsetX += dx;
    l.offsetY += dy;
    if (l.mask && !l.maskLinked) l.mask = shiftMask(l.mask, -dx, -dy);
  }
  for (const g of u.groups) if (g.mask && g.maskLinked) g.mask = shiftMask(g.mask, dx, dy);
}

const edgeOf = (b: Rect, e: AlignEdge): number =>
  e === "top" ? b.y : e === "bottom" ? b.y + b.h : e === "vcenter" ? b.y + b.h / 2 : e === "left" ? b.x : e === "right" ? b.x + b.w : b.x + b.w / 2;
const vertical = (e: AlignEdge) => e === "top" || e === "vcenter" || e === "bottom";

/** Merge Layers: the selected layers become one, where the topmost was. Hidden ones are dropped. */
function mergeSelected(doc: Document): void {
  const layers = doc.selectedLayers;
  if (layers.length < 2) throw new ValidationError("select two or more layers to merge");
  const full = canvasRect(doc);
  const bg = layers[0].isBackground ? layers[0] : null;
  const top = layers[layers.length - 1];
  // What to draw, bottom to top: whole sets as sets (with their opacity, mode and mask), loose layers as layers.
  const draw: Node[] = [];
  for (const n of doc.stack) {
    if (n.kind === "layer") {
      if (layers.includes(n) && n.visible) draw.push(n);
      continue;
    }
    const picked = n.children.filter((c) => layers.includes(c));
    if (!picked.length) continue;
    if (picked.length === n.children.length) {
      if (n.visible) draw.push(n);
      continue;
    }
    const plain = n.visible && n.opacity === 1 && (n.blendMode === "passThrough" || n.blendMode === "normal") && !n.activeMask;
    if (!plain) throw new ValidationError(`merge the whole set "${n.name}" (or set it to 100% Pass Through with no mask) to merge only some of its layers`);
    if (n.visible) for (const c of picked) if (c.visible) draw.push(c);
  }
  const px = compositeNodes(draw, full);
  const merged = new Layer(doc.width, doc.height, bg ? bg.name : top.name);
  if (bg) {
    merged.isBackground = true;
    for (let o = 0; o < px.length; o += 4) {
      const a = px[o + 3] / 255;
      for (let c = 0; c < 3; c++) px[o + c] = px[o + c] * a + doc.background[c] * (1 - a);
      px[o + 3] = 255;
    }
  }
  merged.grid.writeRegion(full, px);
  merged.grid.compact();
  // Into the topmost layer's place (the Background's, when it is part of it).
  const keep = bg ?? top;
  const wasParent = new Set(layers.map((l) => doc.parentOf(l.id)?.id).filter((id): id is number => id !== undefined));
  const at = doc.locate(keep.id)!;
  at.list.splice(at.index, 1, merged);
  for (const l of layers) if (l !== keep) doc.remove(l.id);
  // Sets the merge emptied go too.
  for (const g of doc.groups) if (!g.children.length && wasParent.has(g.id)) doc.remove(g.id);
  doc.activeLayerId = merged.id;
  doc.editMask = false;
  doc.emit({ type: "layers" });
  doc.dirty(null);
}

/** What moves when these nodes move: sets bring their contents (and masks), layers their linked layers. */
export function movingSet(doc: Document, nodes: Node[]): { layers: Layer[]; groups: Group[] } {
  const ids = new Set<number>();
  const groups: Group[] = [];
  for (const n of nodes) {
    if (n.kind === "group") {
      groups.push(n);
      for (const c of n.children) ids.add(c.id);
    } else for (const l of doc.linked(n)) ids.add(l.id);
  }
  return { layers: doc.layers.filter((l) => ids.has(l.id)), groups };
}

export function duplicateLayer(doc: Document, src: Layer, name: string, above = true): Layer {
  const l = new Layer(src.grid.width, src.grid.height, name);
  Object.assign(l, { ...src.props(), id: l.id, name, isBackground: false, linkId: null, locks: { ...src.locks } });
  l.grid = src.grid.share();
  l.mask = src.mask ? src.mask.share() : null;
  const at = doc.locate(src.id)!;
  (at.list as Node[]).splice(at.index + (above ? 1 : 0), 0, l);
  doc.activeLayerId = l.id;
  return l;
}

/** Write a canvas-space RGBA region into a layer (layer may be offset). */
function writeCanvas(l: Layer, r: Rect, px: Uint8ClampedArray): void {
  l.grid.writeRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h }, px);
}

/** A stand-in for `l` with its mask baked in and neutral blending, for merging. */
function neutralCopy(l: Layer, r: Rect): Layer {
  const c = new Layer(l.grid.width, l.grid.height, l.name, -1);
  c.offsetX = l.offsetX;
  c.offsetY = l.offsetY;
  writeCanvas(c, r, layerSource(l, r));
  return c;
}

const canvasRect = (doc: Document): Rect => ({ x: 0, y: 0, w: doc.width, h: doc.height });

const ARRANGE = ["front", "forward", "backward", "back"] as const;

function bottomLimit(doc: Document, list: Node[]): number {
  return list === doc.stack && doc.stack[0]?.kind === "layer" && (doc.stack[0] as Layer).isBackground ? 1 : 0;
}

// ---------------------------------------------------------------- commands

export const layerCommands: CommandDef[] = [
  {
    name: "layer.align",
    label: (p: { edge: string }) => `Align ${{ top: "Top Edges", vcenter: "Vertical Centers", bottom: "Bottom Edges", left: "Left Edges", hcenter: "Horizontal Centers", right: "Right Edges" }[p.edge] ?? ""}`,
    description:
      "Line up the selected layers' contents by an edge or center: to each other, or to the selection when there is one (then a single layer works too).",
    params: { type: "object", properties: { edge: { type: "string", enum: ALIGN_EDGES } }, required: ["edge"] },
    history: true,
    enabled: (ctx) => ctx.doc.selectedNodes.length > 1 || (!!ctx.doc.selection && !!ctx.doc.activeNode),
    run({ doc }, p: { edge: AlignEdge }) {
      const units = alignUnits(doc);
      const selB = doc.selection?.bounds() ?? null;
      if (!units.length || (!selB && units.length < 2)) throw new ValidationError("select two or more movable layers (or make a selection) to align");
      let ref: Rect = selB ?? units[0].b;
      if (!selB) for (const u of units) ref = rectUnion(ref, u.b)!;
      const target = edgeOf(ref, p.edge);
      for (const u of units) {
        const d = Math.round(target - edgeOf(u.b, p.edge));
        if (vertical(p.edge)) shiftUnit(u, 0, d);
        else shiftUnit(u, d, 0);
      }
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.distribute",
    label: "Distribute",
    description: "Space three or more selected layers evenly by an edge or center, keeping the outermost ones where they are.",
    params: { type: "object", properties: { edge: { type: "string", enum: ALIGN_EDGES } }, required: ["edge"] },
    history: true,
    enabled: (ctx) => ctx.doc.selectedNodes.length > 2,
    run({ doc }, p: { edge: AlignEdge }) {
      const units = alignUnits(doc);
      if (units.length < 3) throw new ValidationError("select three or more movable layers to distribute");
      units.sort((a, b) => edgeOf(a.b, p.edge) - edgeOf(b.b, p.edge));
      const first = edgeOf(units[0].b, p.edge), last = edgeOf(units[units.length - 1].b, p.edge);
      units.forEach((u, i) => {
        const d = Math.round(first + ((last - first) * i) / (units.length - 1) - edgeOf(u.b, p.edge));
        if (vertical(p.edge)) shiftUnit(u, 0, d);
        else shiftUnit(u, d, 0);
      });
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.new",
    label: "New Layer",
    description: "Create a new empty layer above the active layer (inside the active set, if any) and make it active.",
    params: { type: "object", properties: { name: { type: "string" } } },
    history: true,
    run({ doc }, p: { name?: string }) {
      doc.addLayer(p.name ?? doc.nextLayerName());
      doc.editMask = false;
      doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.newSet",
    label: "New Layer Set",
    description: "Create a new, empty layer set (group) above the active layer.",
    params: { type: "object", properties: { name: { type: "string" } } },
    history: true,
    run({ doc }, p: { name?: string }) {
      const g = new Group(p.name ?? doc.nextName("Set"));
      doc.insertAboveActive(g);
      doc.activeLayerId = g.id;
      doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.newSetFrom",
    label: "New Set From Linked",
    description: "Move the given layers (default: the active layer and those linked to it) into a new layer set.",
    params: { type: "object", properties: { ids: { type: "array", items: { type: "integer" } }, name: { type: "string" } } },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { ids?: number[]; name?: string }) {
      const doc = ctx.doc;
      const ids = p.ids ?? doc.linked(targetLayer(ctx)).map((l) => l.id);
      const layers = ids.map((id) => doc.layerById(id)).filter((l): l is Layer => !!l);
      if (!layers.length) throw new ValidationError("no layers to group");
      if (layers.some((l) => l.isBackground)) throw new ValidationError("the Background layer can't go into a set");
      // The set goes where the topmost of the layers was (at the top level).
      const flat = doc.layers;
      layers.sort((a, b) => flat.indexOf(a) - flat.indexOf(b));
      const top = layers[layers.length - 1];
      const topAt = doc.locate(top.id)!;
      const anchor = topAt.group ?? top;
      const g = new Group(p.name ?? doc.nextName("Set"));
      const ai = doc.stack.indexOf(anchor);
      doc.stack.splice(ai + 1, 0, g);
      for (const l of layers) {
        doc.remove(l.id);
        g.children.push(l);
      }
      doc.activeLayerId = g.id;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.duplicate",
    label: "Duplicate Layer",
    description: "Duplicate a layer (pixels, mask and properties) directly above it; without an id, every selected layer.",
    params: { type: "object", properties: { id: nodeId, name: { type: "string" } } },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; name?: string }) {
      const doc = ctx.doc;
      const sel = doc.selectedLayers;
      if (!p.id && p.name === undefined && sel.length > 1) {
        // Duplicate every selected layer; the copies become the selection.
        const copies = sel.map((l) => duplicateLayer(doc, l, `${l.name} copy`));
        doc.selectNodes(copies[copies.length - 1].id, copies.map((c) => c.id));
        doc.emit({ type: "layers" });
        doc.dirty(null);
        return;
      }
      const src = targetLayer(ctx, p.id);
      duplicateLayer(doc, src, p.name ?? `${src.name} copy`);
      doc.emit({ type: "layers" });
      doc.dirty(src.bounds());
    },
  },
  {
    name: "layer.newViaCopy",
    label: "Layer via Copy",
    description: "Copy the selected pixels of the active layer to a new layer (the whole layer if nothing is selected).",
    params: { type: "object", properties: {} },
    history: true,
    enabled: hasLayer,
    run(ctx) {
      viaCopyOrCut(ctx, false);
    },
  },
  {
    name: "layer.newViaCut",
    label: "Layer via Cut",
    description: "Move the selected pixels of the active layer to a new layer.",
    params: { type: "object", properties: {} },
    history: true,
    enabled: (ctx) => hasLayer(ctx) && !!ctx.doc.selection,
    run(ctx) {
      viaCopyOrCut(ctx, true);
    },
  },
  {
    name: "layer.delete",
    labelBefore: true,
    label: (p: { contents?: boolean }, ctx) =>
      !(p as { id?: number }).id && ctx.doc.selectedNodes.length > 1
        ? "Delete Layers"
        : ctx.doc.nodeById((p as { id?: number }).id ?? ctx.doc.activeLayerId)?.kind === "group"
          ? "Delete Layer Set"
          : "Delete Layer",
    description: "Delete a layer, or a layer set (with its contents unless contents is false).",
    params: { type: "object", properties: { id: nodeId, contents: { type: "boolean", default: true } } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode && (ctx.doc.activeNode.kind === "group" || ctx.doc.layers.length > 1),
    run(ctx, p: { id?: number; contents: boolean }) {
      const doc = ctx.doc;
      const many = !p.id && doc.selectedNodes.length > 1;
      if (many) {
        // Several selected: delete them all (sets with their contents, unless contents is false).
        const nodes = doc.selectedNodes;
        const gone = new Set<number>();
        for (const x of nodes) for (const l of x.kind === "group" ? (p.contents ? x.children : []) : [x]) gone.add(l.id);
        if (doc.layers.every((l) => gone.has(l.id))) throw new ValidationError("a document needs at least one layer");
        const flat = doc.flatNodes;
        const lowest = flat.indexOf(nodes[0]);
        for (const x of nodes) if (x.kind === "layer") doc.remove(x.id);
        for (const x of nodes) {
          if (x.kind !== "group") continue;
          const at = doc.locate(x.id);
          if (!at) continue;
          at.list.splice(at.index, 1, ...(p.contents ? [] : x.children));
        }
        const below = flat.slice(0, lowest).reverse().find((x) => doc.nodeById(x.id));
        doc.activeLayerId = (below ?? doc.flatNodes[doc.flatNodes.length - 1])?.id ?? 0;
        doc.editMask = false;
        doc.emit({ type: "layers" });
        doc.dirty(null);
        return;
      }
      const n = targetNode(ctx, p.id);
      const at = doc.locate(n.id)!;
      if (n.kind === "layer" && doc.layers.length <= 1) throw new ValidationError("a document needs at least one layer");
      if (n.kind === "group") {
        if (p.contents && doc.layers.length - n.children.length < 1) throw new ValidationError("a document needs at least one layer");
        at.list.splice(at.index, 1);
        if (!p.contents) doc.stack.splice(at.index, 0, ...n.children);
      } else at.list.splice(at.index, 1);
      // Activate the node below, as PS7 does.
      const next =
        !at.list.length && at.group ? at.group : (at.list[Math.max(0, Math.min(at.index - 1, at.list.length - 1))] ?? doc.stack[doc.stack.length - 1]);
      doc.activeLayerId = next ? next.id : 0;
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.select",
    label: "Select Layer",
    description:
      "Make a layer or layer set active. mode add keeps the other selected layers (Ctrl-click), toggle adds or removes it, range selects everything between the active layer and this one (Shift-click).",
    params: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, mode: { type: "string", enum: ["replace", "add", "toggle", "range"], default: "replace" } },
      required: ["id"],
    },
    history: false,
    run(ctx, p: { id: number; mode: "replace" | "add" | "toggle" | "range" }) {
      const doc = ctx.doc;
      targetNode(ctx, p.id);
      if (doc.activeLayerId !== p.id) doc.editMask = false;
      const cur = doc.selectedNodes.map((n) => n.id);
      if (p.mode === "toggle" && doc.isSelected(p.id) && cur.length > 1) {
        // Deselect it; the topmost remaining one becomes active if it was.
        const rest = cur.filter((i) => i !== p.id);
        doc.selectNodes(p.id === doc.activeLayerId ? rest[rest.length - 1] : doc.activeLayerId, rest);
      } else if (p.mode === "add" || p.mode === "toggle") doc.selectNodes(p.id, [...cur, p.id]);
      else if (p.mode === "range") {
        const flat = doc.flatNodes.map((n) => n.id);
        const a = flat.indexOf(doc.activeLayerId), b = flat.indexOf(p.id);
        const [lo, hi] = a < 0 ? [b, b] : [Math.min(a, b), Math.max(a, b)];
        doc.selectNodes(p.id, flat.slice(lo, hi + 1));
      } else doc.activeLayerId = p.id;
      doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.selectAll",
    label: "Select All Layers",
    description: "Select every layer (except the Background), or none (just the active one) with none true.",
    params: { type: "object", properties: { none: { type: "boolean", default: false } } },
    history: false,
    enabled: hasLayer,
    run({ doc }, p: { none: boolean }) {
      const all = doc.layers.filter((l) => !l.isBackground);
      if (p.none || !all.length) doc.selectNodes(doc.activeLayerId, []);
      else doc.selectNodes(all.some((l) => l.id === doc.activeLayerId) ? doc.activeLayerId : all[all.length - 1].id, all.map((l) => l.id));
      doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.setProperties",
    label: (p: Record<string, unknown>) => {
      const keys = Object.keys(p).filter((k) => k !== "id");
      if (keys.length === 1 && keys[0] === "visible") return p.visible ? "Show Layer" : "Hide Layer";
      if (keys.length === 1 && keys[0] === "expanded") return "Layer Set Expand";
      if (p.name !== undefined) return "Layer Properties";
      if (p.blendMode !== undefined) return "Blending Change";
      return "Opacity Change";
    },
    description: "Change a layer's or set's name, opacity (0-100), blend mode or visibility. Sets also accept the blend mode passThrough.",
    params: {
      type: "object",
      properties: {
        id: nodeId,
        name: { type: "string" },
        opacity: percent("Opacity in percent"),
        blendMode: { type: "string", enum: [...BLEND_MODES, "passThrough"], description: "Blend mode" },
        visible: { type: "boolean" },
        expanded: { type: "boolean", description: "Layer sets: open or closed in the palette" },
      },
    },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode,
    run(ctx, p: { id?: number; name?: string; opacity?: number; blendMode?: GroupBlend; visible?: boolean; expanded?: boolean }) {
      const sel = ctx.doc.selectedNodes;
      if (!p.id && sel.length > 1 && p.name === undefined && p.expanded === undefined) {
        // Opacity, blend mode and visibility apply to every selected layer and set.
        for (const n of sel) {
          if (n.kind === "layer" && n.isBackground) continue;
          if (p.opacity !== undefined) n.opacity = p.opacity / 100;
          if (p.blendMode !== undefined && (p.blendMode !== "passThrough" || n.kind === "group")) (n as { blendMode: GroupBlend }).blendMode = p.blendMode;
          if (p.visible !== undefined) n.visible = p.visible;
        }
        ctx.doc.emit({ type: "layers" });
        ctx.doc.dirty(null);
        return;
      }
      const n = targetNode(ctx, p.id);
      if (n.kind === "layer") {
        if (p.blendMode === "passThrough") throw new ValidationError("only layer sets can use Pass Through");
        if (n.isBackground && p.blendMode && p.blendMode !== "normal")
          throw new ValidationError("the Background layer can't change blend mode; convert it to a layer first");
        if (n.isBackground && p.opacity !== undefined && p.opacity !== 100)
          throw new ValidationError("the Background layer can't change opacity; convert it to a layer first");
      }
      if (p.name !== undefined) n.name = p.name;
      if (p.opacity !== undefined) n.opacity = p.opacity / 100;
      if (p.blendMode !== undefined) (n as { blendMode: GroupBlend }).blendMode = p.blendMode;
      if (p.visible !== undefined) n.visible = p.visible;
      if (p.expanded !== undefined && n.kind === "group") n.expanded = p.expanded;
      ctx.doc.emit({ type: "layers" });
      if (p.expanded === undefined || Object.keys(p).length > 2) ctx.doc.dirty(null);
    },
  },
  {
    name: "layer.offset",
    label: "Move",
    description: "Move a layer (and any layers linked to it) by dx, dy pixels. Without an id, every selected layer and set moves.",
    params: { type: "object", properties: { id: nodeId, dx: { type: "integer" }, dy: { type: "integer" } }, required: ["dx", "dy"] },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode && !(ctx.doc.activeLayer?.isBackground ?? false),
    run(ctx, p: { id?: number; dx: number; dy: number }) {
      const doc = ctx.doc;
      const { layers, groups } = movingSet(doc, p.id ? [targetNode(ctx, p.id)] : doc.selectedNodes);
      for (const l of layers) {
        if (l.isBackground) throw new ValidationError("the Background layer is locked; convert it to a layer to move it");
        if (l.locks.position) throw new ValidationError(`"${l.name}" has its position locked`);
      }
      let dirty: Rect | null = null;
      for (const l of layers) {
        dirty = rectUnion(dirty, l.bounds());
        l.offsetX += p.dx;
        l.offsetY += p.dy;
        // An unlinked mask stays where it is on the canvas.
        if (l.mask && !l.maskLinked) l.mask = shiftMask(l.mask, -p.dx, -p.dy);
        dirty = rectUnion(dirty, l.bounds());
      }
      // A set's linked mask travels with the set.
      for (const g of groups)
        if (g.mask && g.maskLinked) {
          g.mask = shiftMask(g.mask, p.dx, p.dy);
          dirty = canvasRect(doc);
        }
      doc.emit({ type: "layers" });
      doc.dirty(dirty);
    },
  },

  {
    name: "layer.reorder",
    label: "Layer Order",
    description: "Move a layer or set to position index (0 = bottom) within a parent set (parent 0 = top level).",
    params: {
      type: "object",
      properties: { id: nodeId, index: { type: "integer", minimum: 0 }, parent: { type: "integer", minimum: 0, description: "Set id, or 0 for the top level; default: stay in the current container" } },
      required: ["index"],
    },
    history: true,
    run(ctx, p: { id?: number; index: number; parent?: number }) {
      const doc = ctx.doc;
      const n = targetNode(ctx, p.id);
      if (n.kind === "layer" && n.isBackground) throw new ValidationError("the Background layer must stay at the bottom");
      const from = doc.locate(n.id)!;
      let parent: Group | null = from.group;
      if (p.parent !== undefined) {
        if (p.parent === 0) parent = null;
        else {
          const g = doc.nodeById(p.parent);
          if (g?.kind !== "group") throw new ValidationError(`no layer set with id ${p.parent}`);
          if (n.kind === "group") throw new ValidationError("layer sets can't be nested");
          parent = g;
        }
      }
      from.list.splice(from.index, 1);
      const list: Node[] = parent ? parent.children : doc.stack;
      const to = Math.max(bottomLimit(doc, list), Math.min(p.index, list.length));
      list.splice(to, 0, n);
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.arrange",
    label: "Layer Order",
    description: "Bring a layer or set to the front, forward one step, backward one step, or send it to the back, within its set.",
    params: { type: "object", properties: { id: nodeId, to: { type: "string", enum: ARRANGE } }, required: ["to"] },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeNode && !(ctx.doc.activeLayer?.isBackground ?? false),
    run(ctx, p: { id?: number; to: (typeof ARRANGE)[number] }) {
      const doc = ctx.doc;
      const n = targetNode(ctx, p.id);
      if (n.kind === "layer" && n.isBackground) throw new ValidationError("the Background layer must stay at the bottom");
      const at = doc.locate(n.id)!;
      const lo = bottomLimit(doc, at.list);
      const hi = at.list.length - 1;
      const to = p.to === "front" ? hi : p.to === "back" ? lo : Math.max(lo, Math.min(hi, at.index + (p.to === "forward" ? 1 : -1)));
      if (to === at.index) return;
      at.list.splice(at.index, 1);
      at.list.splice(to, 0, n);
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.fromBackground",
    label: "Layer From Background",
    description: "Convert the Background layer into a normal layer so it can move, change opacity or hold transparency.",
    params: { type: "object", properties: { name: { type: "string" } } },
    history: true,
    enabled: (ctx) => ctx.doc.stack[0]?.kind === "layer" && (ctx.doc.stack[0] as Layer).isBackground,
    run(ctx, p: { name?: string }) {
      const bg = ctx.doc.stack[0];
      if (bg?.kind !== "layer" || !bg.isBackground) throw new ValidationError("there is no Background layer");
      bg.isBackground = false;
      bg.name = p.name ?? "Layer 0";
      ctx.doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.mergeDown",
    labelBefore: true,
    label: (_p, ctx) => (ctx.doc.selectedNodes.length > 1 ? "Merge Layers" : ctx.doc.activeNode?.kind === "group" ? "Merge Layer Set" : "Merge Down"),
    description: "Merge the active layer into the layer below it, or merge the active layer set into one layer. With several layers selected, merge them into one.",
    params: { type: "object", properties: {} },
    history: true,
    enabled: (ctx) => {
      const n = ctx.doc.activeNode;
      if (!n) return false;
      if (ctx.doc.selectedNodes.length > 1) return true;
      if (n.kind === "group") return n.children.length > 0;
      const at = ctx.doc.locate(n.id)!;
      return at.index > 0 && at.list[at.index - 1].kind === "layer";
    },
    run(ctx) {
      const doc = ctx.doc;
      const n = targetNode(ctx);
      const full = canvasRect(doc);
      if (doc.selectedNodes.length > 1) {
        mergeSelected(doc);
        return;
      }
      if (n.kind === "group") {
        const merged = new Layer(doc.width, doc.height, n.name);
        const px = compositeNodes(n.children, full);
        // The set's mask is part of what you see, so it is merged in.
        const gm = n.activeMask?.readRegion(full, n.activeMask.defaultValue);
        if (gm) for (let i = 0, o = 3; i < gm.length; i++, o += 4) px[o] = Math.round((px[o] * gm[i]) / 255);
        merged.grid.writeRegion(full, px);
        merged.blendMode = n.blendMode === "passThrough" ? "normal" : n.blendMode;
        merged.opacity = n.opacity;
        merged.visible = n.visible;
        const at = doc.locate(n.id)!;
        at.list.splice(at.index, 1, merged);
        doc.activeLayerId = merged.id;
      } else {
        const at = doc.locate(n.id)!;
        const lower = at.list[at.index - 1];
        if (!lower || lower.kind !== "layer") throw new ValidationError("there is no layer below to merge into");
        assertPixelsEditable(lower);
        // Effects are part of what you see, so they are merged in.
        if (lower.style) bakeStyle(lower);
        const fx = n.style ? layerEffects(n) : null;
        let area = rectUnion(rectUnion(contentBounds(lower), contentBounds(n)), fx?.bounds ?? null);
        area = area && rectIntersect(area, full);
        if (area && n.visible) {
          growLayer(lower, area);
          const base = neutralCopy(lower, area);
          const upper = Object.assign(new Layer(n.grid.width, n.grid.height, n.name, -2), n.props(), { id: -2 });
          upper.grid = n.grid;
          upper.mask = n.mask;
          const px = compositeNodes([base, upper], area);
          lower.mask = null;
          lower.maskEnabled = true;
          writeCanvas(lower, area, px);
          if (lower.isBackground) lower.grid.compact();
        }
        at.list.splice(at.index, 1);
        doc.activeLayerId = lower.id;
      }
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.mergeVisible",
    label: "Merge Visible",
    description: "Merge all visible layers and sets into one layer; hidden layers are kept.",
    params: { type: "object", properties: {} },
    history: true,
    enabled: (ctx) => ctx.doc.layers.filter((l) => l.visible).length > 0,
    run({ doc }) {
      const full = canvasRect(doc);
      const visible = doc.stack.filter((n) => n.visible);
      if (!visible.length) throw new ValidationError("there are no visible layers");
      // Composite the whole stack: hidden layers drop out on their own, and clipping stays intact.
      const px = compositeNodes(doc.stack, full);
      const first = visible[0];
      const bg = first.kind === "layer" && first.isBackground ? first : null;
      const merged = new Layer(doc.width, doc.height, bg ? "Background" : first.kind === "layer" ? first.name : doc.nextLayerName());
      merged.isBackground = !!bg;
      if (bg) {
        for (let o = 0; o < px.length; o += 4) {
          const a = px[o + 3] / 255;
          for (let c = 0; c < 3; c++) px[o + c] = px[o + c] * a + doc.background[c] * (1 - a);
          px[o + 3] = 255;
        }
      }
      merged.grid.writeRegion(full, px);
      // Keep hidden nodes in place (hidden layers inside merged sets move to the top
      // level); the merged layer takes the lowest visible slot.
      const next: Node[] = [];
      for (const n of doc.stack) {
        if (n === first) next.push(merged);
        if (!n.visible) next.push(n);
        else if (n.kind === "group") {
          for (const c of n.children)
            if (!c.visible) {
              c.clipped = false;
              next.push(c);
            }
        }
      }
      doc.stack = next;
      doc.activeLayerId = merged.id;
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "layer.stampVisible",
    label: "Merge Visible to New Layer",
    description: "Put a merged copy of everything visible on a new layer above the active one, leaving the layers as they are (Ctrl+Alt+Shift+E).",
    params: { type: "object", properties: { name: { type: "string" } } },
    history: true,
    enabled: (ctx) => ctx.doc.layers.some((l) => l.visible),
    run({ doc }, p: { name?: string }) {
      const full = canvasRect(doc);
      const px = compositeNodes(doc.stack, full);
      const l = doc.addLayer(p.name ?? doc.nextLayerName());
      l.grid.writeRegion(full, px);
      l.grid.compact();
      doc.activeLayerId = l.id;
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },
  {
    name: "image.flatten",
    label: "Flatten Image",
    description: "Merge all visible layers into a single Background layer; hidden layers are discarded.",
    params: { type: "object", properties: {} },
    history: true,
    run({ doc }) {
      const px = doc.composite();
      for (let p = 0; p < px.length; p += 4) {
        const a = px[p + 3] / 255;
        px[p] = px[p] * a + 255 * (1 - a);
        px[p + 1] = px[p + 1] * a + 255 * (1 - a);
        px[p + 2] = px[p + 2] * a + 255 * (1 - a);
        px[p + 3] = 255;
      }
      doc.stack = [];
      const bg = doc.addLayer("Background", 0);
      bg.isBackground = true;
      bg.grid.writeRegion(canvasRect(doc), px);
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(null);
    },
  },

  // ---------------- clipping, locks, links ----------------
  {
    name: "layer.clip",
    label: (p: { clipped: boolean }) => (p.clipped ? "Group with Previous" : "Ungroup"),
    description: "Clip a layer to the layer below it (PS7 clipping group), or release it.",
    params: { type: "object", properties: { id: nodeId, clipped: { type: "boolean", default: true } } },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; clipped: boolean }) {
      const l = targetLayer(ctx, p.id);
      if (p.clipped) {
        const at = ctx.doc.locate(l.id)!;
        const below = at.list[at.index - 1];
        if (!below || below.kind !== "layer") throw new ValidationError("there is no layer below to clip to");
        if (l.isBackground) throw new ValidationError("the Background layer can't be clipped");
      }
      l.clipped = p.clipped;
      ctx.doc.emit({ type: "layers" });
      ctx.doc.dirty(null);
    },
  },
  {
    name: "layer.setLocks",
    label: "Lock Change",
    description: "Lock or unlock a layer's transparency, image pixels and/or position.",
    params: {
      type: "object",
      properties: { id: nodeId, transparency: { type: "boolean" }, pixels: { type: "boolean" }, position: { type: "boolean" }, all: { type: "boolean" } },
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; transparency?: boolean; pixels?: boolean; position?: boolean; all?: boolean }) {
      const n = targetNode(ctx, p.id);
      const layers = n.kind === "group" ? n.children : [n];
      for (const l of layers) {
        if (p.all !== undefined) l.locks = { transparency: p.all, pixels: p.all, position: p.all };
        if (p.transparency !== undefined) l.locks.transparency = p.transparency;
        if (p.pixels !== undefined) l.locks.pixels = p.pixels;
        if (p.position !== undefined) l.locks.position = p.position;
      }
      ctx.doc.emit({ type: "layers" });
    },
  },
  {
    name: "layer.link",
    label: (p: { linked: boolean }) => (p.linked ? "Link Layers" : "Unlink Layers"),
    description: "Link layers so they move together, or unlink them.",
    params: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "integer" }, minItems: 1 }, linked: { type: "boolean", default: true } },
      required: ["ids"],
    },
    history: true,
    run({ doc }, p: { ids: number[]; linked: boolean }) {
      const layers = p.ids.map((id) => {
        const l = doc.layerById(id);
        if (!l) throw new ValidationError(`no layer with id ${id}`);
        return l;
      });
      if (p.linked) {
        const existing = layers.find((l) => l.linkId !== null)?.linkId;
        const id = existing ?? Math.max(0, ...doc.layers.map((l) => l.linkId ?? 0)) + 1;
        for (const l of layers) l.linkId = id;
      } else {
        for (const l of layers) l.linkId = null;
        // A link of one is no link.
        const counts = new Map<number, number>();
        for (const l of doc.layers) if (l.linkId !== null) counts.set(l.linkId, (counts.get(l.linkId) ?? 0) + 1);
        for (const l of doc.layers) if (l.linkId !== null && counts.get(l.linkId) === 1) l.linkId = null;
      }
      doc.emit({ type: "layers" });
    },
  },

];

function viaCopyOrCut(ctx: CommandContext, cut: boolean): void {
  const doc = ctx.doc;
  const src = targetLayer(ctx);
  if (!doc.selection) {
    duplicateLayer(doc, src, doc.nextLayerName());
    doc.emit({ type: "layers" });
    doc.dirty(src.bounds());
    return;
  }
  if (cut) assertPixelsEditable(src);
  const b = rectIntersect(doc.selection.bounds()!, src.bounds());
  if (!b) throw new ValidationError("the selected area is empty");
  const px = src.grid.readRegion({ x: b.x - src.offsetX, y: b.y - src.offsetY, w: b.w, h: b.h });
  const cov = doc.selection.readRegion(b);
  for (let i = 0, o = 3; i < cov.length; i++, o += 4) px[o] = Math.round((px[o] * cov[i]) / 255);
  let any = false;
  for (let o = 3; o < px.length && !any; o += 4) if (px[o]) any = true;
  if (!any) throw new ValidationError("the selected area is empty");
  if (cut) {
    const rest = src.grid.readRegion({ x: b.x - src.offsetX, y: b.y - src.offsetY, w: b.w, h: b.h });
    for (let i = 0, o = 0; i < cov.length; i++, o += 4) {
      if (src.isBackground) {
        const a = cov[i] / 255;
        for (let c = 0; c < 3; c++) rest[o + c] = Math.round(rest[o + c] * (1 - a) + doc.background[c] * a);
      } else rest[o + 3] = Math.round(rest[o + 3] * (1 - cov[i] / 255));
    }
    src.grid.writeRegion({ x: b.x - src.offsetX, y: b.y - src.offsetY, w: b.w, h: b.h }, rest);
    src.grid.compact();
  }
  const l = new Layer(doc.width, doc.height, doc.nextLayerName());
  const at = doc.locate(src.id)!;
  (at.list as Node[]).splice(at.index + 1, 0, l);
  writeCanvas(l, b, px);
  doc.activeLayerId = l.id;
  doc.editMask = false;
  doc.emit({ type: "layers" });
  doc.dirty(b);
}
