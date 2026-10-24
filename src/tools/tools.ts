/**
 * Toolbox tools. Tools turn pointer input into commands: they may preview
 * changes live (a brush stroke, a layer drag, a crop box), but always finish
 * by dispatching a command so History, Actions and the AI see the same thing.
 */

import type { App, AutoSelect, PaintToolId } from "../app";
import { PaintTarget, Stroke } from "../core/brush";
import { BrushPreset, presetToJSON } from "../core/brushes";
import { moveSelectedPixels } from "../core/cmd/edit";
import { movingSet, pixelBounds } from "../core/cmd/layers";
import type { Mask } from "../core/mask";
import { shiftMask } from "../core/maskfx";
import { makeTypeTool } from "../text/typetool";
import { makeFaceSwapTool } from "./faceswaptool";
import { makeTransformTool, startTransform } from "./transformtool";
import { makeRetouchTools } from "./retouchtools";
import { makeMoreTools } from "./moretools";
import { makeVectorTools } from "./vectortools";
import type { Document, Layer, RGBA } from "../core/document";
import type { TileGrid } from "../core/tiles";
import type { SelectMode } from "../core/selection";
import { Rect, rectUnion } from "../core/tiles";

export type ToolId =
  | "marquee"
  | "ellipse"
  | "row"
  | "column"
  | "move"
  | "lasso"
  | "polyLasso"
  | "wand"
  | "crop"
  | "brush"
  | "pencil"
  | "eraser"
  | "bucket"
  | "gradient"
  | "type"
  | "faceSwap"
  | "transform"
  | "stamp"
  | "heal"
  | "spotHeal"
  | "historyBrush"
  | "dodge"
  | "burn"
  | "sponge"
  | "blur"
  | "sharpen"
  | "smudge"
  | "redEye"
  | "magicEraser"
  | "patternStamp"
  | "artHistory"
  | "bgEraser"
  | "colorReplace"
  | "patch"
  | "magneticLasso"
  | "colorSampler"
  | "measure"
  | "notes"
  | "slice"
  | "sliceSelect"
  | "pen"
  | "freeformPen"
  | "addAnchor"
  | "deleteAnchor"
  | "convertPoint"
  | "pathSelect"
  | "directSelect"
  | "rectShape"
  | "roundRectShape"
  | "ellipseShape"
  | "polygonShape"
  | "lineShape"
  | "customShape"
  | "eyedropper"
  | "hand"
  | "zoom";

export interface ToolEvent {
  /** Canvas coordinates (fractional). */
  x: number;
  y: number;
  /** Viewport CSS coordinates. */
  sx: number;
  sy: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  button: number;
  detail: number;
  /** Pen pressure 0..1 (1 for a mouse). */
  pressure: number;
}

export interface Tool {
  id: ToolId;
  label: string;
  /** Single-letter shortcut, PS7 defaults; Shift+letter cycles tools sharing it. */
  shortcut: string;
  icon: string;
  cursor: string;
  hint: string;
  down(e: ToolEvent): void;
  move(e: ToolEvent): void;
  up(e: ToolEvent): void;
  hover?(e: ToolEvent): void;
  dblclick?(e: ToolEvent): void;
  /** Keyboard while the tool is active; return true if handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Called when switching away (cancel half-finished work). */
  deactivate?(): void;
}

export interface CropTool extends Tool {
  readonly active: boolean;
  commit(): void;
  cancel(): void;
}

const CROSSHAIR = "crosshair";

/** Shift adds, Alt subtracts, both intersect; otherwise the options bar mode. */
function selectMode(app: App, e: ToolEvent): SelectMode {
  if (e.shift && e.alt) return "intersect";
  if (e.shift) return "add";
  if (e.alt) return "subtract";
  return app.settings.selectMode;
}

function insideSelection(app: App, x: number, y: number): boolean {
  const s = app.doc?.selection;
  return !!s && !app.doc!.quickMask && s.get(Math.floor(x), Math.floor(y)) >= 128;
}

/** The Move tool's Auto-Select setting (tool presets from before 0.11 hold true / false). */
export function autoSelectMode(v: AutoSelect | boolean | undefined): AutoSelect {
  return v === true ? "layer" : v === "layer" || v === "set" ? v : "off";
}

/** The topmost visible layer with a visible pixel at (x, y) (its mask counts), or null. */
export function layerUnder(doc: Document, x: number, y: number): Layer | null {
  const px = Math.floor(x), py = Math.floor(y);
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    if (!l.visible || doc.parentOf(l.id)?.visible === false) continue;
    const lx = px - l.offsetX, ly = py - l.offsetY;
    if (l.grid.getPixel(lx, ly)[3] === 0) continue;
    if (l.mask && l.maskEnabled && lx >= 0 && ly >= 0 && lx < l.mask.width && ly < l.mask.height && l.mask.get(lx, ly) === 0) continue;
    return l;
  }
  return null;
}

/** pixelBounds, remembered per grid until a tile changes (the bounding box redraws every frame while dragging). */
const boundsCache = new WeakMap<TileGrid, { key: string; local: Rect | null }>();
function layerBounds(l: Layer): Rect | null {
  const key = l.grid.tiles.map((t) => (t ? t.version : 0)).join(",");
  let c = boundsCache.get(l.grid);
  if (!c || c.key !== key) {
    const b = pixelBounds(l);
    c = { key, local: b && { x: b.x - l.offsetX, y: b.y - l.offsetY, w: b.w, h: b.h } };
    boundsCache.set(l.grid, c);
  }
  return c.local && { x: c.local.x + l.offsetX, y: c.local.y + l.offsetY, w: c.local.w, h: c.local.h };
}

/** The Move tool's bounding box: what Free Transform would transform (the active and other selected layers). */
export function moveBounds(doc: Document): Rect | null {
  const active = doc.activeLayer;
  if (!active) return null;
  let r: Rect | null = null;
  for (const l of new Set([active, ...doc.selectedLayers])) if (l.visible && !(l.isBackground && l !== active)) r = rectUnion(r, layerBounds(l));
  return r;
}

export const BOX_HANDLES: [number, number][] = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];

/** Which bounding-box handle (if any) is under the pointer. */
function boundsHandleAt(app: App, e: ToolEvent): number | null {
  const doc = app.doc;
  const b = doc && moveBounds(doc);
  if (!b) return null;
  const z = app.compositor.view.zoom;
  for (let i = 0; i < BOX_HANDLES.length; i++) {
    const [u, v] = BOX_HANDLES[i];
    if (Math.abs(e.x - (b.x + b.w * u)) * z <= 5 && Math.abs(e.y - (b.y + b.h * v)) * z <= 5) return i;
  }
  return null;
}

export function createTools(app: App): Record<ToolId, Tool> {
  // ---------------- shared: dragging the selection outline ----------------
  let selDrag: { x: number; y: number; dx: number; dy: number } | null = null;
  const startSelDrag = (e: ToolEvent) => {
    selDrag = { x: e.x, y: e.y, dx: 0, dy: 0 };
  };
  const moveSelDrag = (e: ToolEvent) => {
    if (!selDrag) return;
    selDrag.dx = Math.round(e.x - selDrag.x);
    selDrag.dy = Math.round(e.y - selDrag.y);
    app.selectionOffset = { dx: selDrag.dx, dy: selDrag.dy };
  };
  const endSelDrag = () => {
    const d = selDrag;
    selDrag = null;
    app.selectionOffset = null;
    if (d && (d.dx || d.dy)) app.run("select.translate", { dx: d.dx, dy: d.dy });
  };

  // ---------------- Marquee family ----------------
  const makeMarquee = (id: "marquee" | "ellipse" | "row" | "column"): Tool => {
    let start: { x: number; y: number } | null = null;
    let mode: SelectMode = "replace";
    let fixedOrigin: { x: number; y: number } | null = null;
    let lastMove: { x: number; y: number } | null = null;
    const shape = id === "ellipse" ? "ellipse" : "rect";
    const compute = (e: ToolEvent): Rect => {
      const s = app.settings;
      const doc = app.doc!;
      if (id === "row") return { x: 0, y: Math.floor(e.y), w: doc.width, h: 1 };
      if (id === "column") return { x: Math.floor(e.x), y: 0, w: 1, h: doc.height };
      if (s.marqueeStyle === "fixed") {
        const p = app.snap(e.x, e.y);
        return { x: Math.round(p.x - (e.alt ? s.marqueeW / 2 : 0)), y: Math.round(p.y - (e.alt ? s.marqueeH / 2 : 0)), w: s.marqueeW, h: s.marqueeH };
      }
      const a = start!;
      const b = app.snap(e.x, e.y);
      let w = Math.round(b.x) - Math.round(a.x);
      let h = Math.round(b.y) - Math.round(a.y);
      if (s.marqueeStyle === "aspect" && s.marqueeW > 0 && s.marqueeH > 0) {
        const r = s.marqueeW / s.marqueeH;
        if (Math.abs(w) / r > Math.abs(h)) h = Math.sign(h || 1) * Math.round(Math.abs(w) / r);
        else w = Math.sign(w || 1) * Math.round(Math.abs(h) * r);
      } else if (e.shift && mode === "replace") {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      let x0 = Math.round(a.x), y0 = Math.round(a.y);
      if (e.alt && mode === "replace") {
        x0 -= w;
        y0 -= h;
        w *= 2;
        h *= 2;
      }
      return { x: w < 0 ? x0 + w : x0, y: h < 0 ? y0 + h : y0, w: Math.abs(w), h: Math.abs(h) };
    };
    const names = { marquee: "Rectangular Marquee Tool", ellipse: "Elliptical Marquee Tool", row: "Single Row Marquee Tool", column: "Single Column Marquee Tool" };
    return {
      id,
      label: names[id],
      shortcut: id === "marquee" || id === "ellipse" ? "M" : "",
      icon: id === "ellipse" ? "ellipse" : id === "row" ? "row" : id === "column" ? "column" : "marquee",
      cursor: CROSSHAIR,
      hint: "Draw a selection. Shift adds, Alt subtracts, Shift+Alt intersects. Drag inside a selection to move its outline.",
      down(e) {
        mode = selectMode(app, e);
        if (mode === "replace" && !e.shift && !e.alt && id !== "row" && id !== "column" && app.settings.marqueeStyle !== "fixed" && insideSelection(app, e.x, e.y)) {
          startSelDrag(e);
          return;
        }
        start = app.snap(e.x, e.y);
        fixedOrigin = start;
        lastMove = { x: e.x, y: e.y };
        app.preview.rect = { ...compute(e), shape };
      },
      move(e) {
        if (selDrag) return moveSelDrag(e);
        if (!start) return;
        // Holding Space while dragging moves the marquee instead of resizing it (as in Photoshop).
        if (app.isHeld("space") && lastMove) {
          start = { x: start.x + e.x - lastMove.x, y: start.y + e.y - lastMove.y };
          if (fixedOrigin) fixedOrigin = { x: fixedOrigin.x + e.x - lastMove.x, y: fixedOrigin.y + e.y - lastMove.y };
        }
        lastMove = { x: e.x, y: e.y };
        app.preview.rect = { ...compute(e), shape };
      },
      up(e) {
        if (selDrag) return endSelDrag();
        if (!start) return;
        const r = compute(e);
        const moved = fixedOrigin && Math.hypot(e.x - fixedOrigin.x, e.y - fixedOrigin.y) * app.compositor.view.zoom > 2;
        start = null;
        app.preview.rect = undefined;
        const s = app.settings;
        if ((r.w < 1 || r.h < 1 || (!moved && id !== "row" && id !== "column" && s.marqueeStyle !== "fixed")) && mode === "replace") {
          if (app.doc?.selection) app.run("select.none");
          return;
        }
        if (r.w < 1 || r.h < 1) return;
        if (shape === "ellipse") app.run("select.ellipse", { ...r, mode, feather: s.marqueeFeather, antiAlias: s.marqueeAntiAlias });
        else app.run("select.rect", { ...r, mode, feather: s.marqueeFeather });
      },
    };
  };

  // ---------------- Lassos ----------------
  let lassoMode: SelectMode = "replace";
  const commitLasso = (tool: "lasso" | "polyLasso") => {
    const pts = app.preview.lasso;
    app.preview.lasso = undefined;
    app.preview.lassoCursor = null;
    if (!pts || pts.length < 3) {
      if (lassoMode === "replace" && app.doc?.selection) app.run("select.none");
      return;
    }
    app.run("select.polygon", {
      points: pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
      tool: tool === "polyLasso" ? "polygonalLasso" : "lasso",
      mode: lassoMode,
      feather: app.settings.lassoFeather,
      antiAlias: app.settings.lassoAntiAlias,
    });
  };
  const lasso: Tool = {
    id: "lasso",
    label: "Lasso Tool",
    shortcut: "L",
    icon: "lasso",
    cursor: CROSSHAIR,
    hint: "Drag to draw a freehand selection. Shift adds, Alt subtracts.",
    down(e) {
      lassoMode = selectMode(app, e);
      if (lassoMode === "replace" && !e.shift && !e.alt && insideSelection(app, e.x, e.y)) return startSelDrag(e);
      app.preview.lasso = [[e.x, e.y]];
    },
    move(e) {
      if (selDrag) return moveSelDrag(e);
      const pts = app.preview.lasso;
      if (!pts) return;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(e.x - lx, e.y - ly) * app.compositor.view.zoom >= 1.5) pts.push([e.x, e.y]);
    },
    up() {
      if (selDrag) return endSelDrag();
      commitLasso("lasso");
    },
  };

  const constrain45 = (from: [number, number], x: number, y: number): [number, number] => {
    const dx = x - from[0], dy = y - from[1];
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const d = Math.hypot(dx, dy);
    return [from[0] + Math.cos(a) * d, from[1] + Math.sin(a) * d];
  };
  const polyLasso: Tool = {
    id: "polyLasso",
    label: "Polygonal Lasso Tool",
    shortcut: "L",
    icon: "polyLasso",
    cursor: CROSSHAIR,
    hint: "Click to add corners; click the start point, double-click or press Enter to close. Backspace removes a corner, Esc cancels.",
    down(e) {
      const pts = app.preview.lasso;
      if (!pts) {
        lassoMode = selectMode(app, e);
        if (lassoMode === "replace" && !e.shift && !e.alt && insideSelection(app, e.x, e.y)) return startSelDrag(e);
        app.preview.lasso = [[e.x, e.y]];
        return;
      }
      let p: [number, number] = [e.x, e.y];
      if (e.shift) p = constrain45(pts[pts.length - 1], e.x, e.y);
      const first = app.toScreen(pts[0][0], pts[0][1]);
      if (pts.length >= 3 && Math.hypot(first.x - e.sx, first.y - e.sy) <= 6) return commitLasso("polyLasso");
      pts.push(p);
    },
    move(e) {
      if (selDrag) return moveSelDrag(e);
      this.hover!(e);
    },
    up() {
      if (selDrag) endSelDrag();
    },
    hover(e) {
      const pts = app.preview.lasso;
      if (!pts) return;
      app.preview.lassoCursor = e.shift ? constrain45(pts[pts.length - 1], e.x, e.y) : [e.x, e.y];
    },
    dblclick() {
      if (app.preview.lasso) commitLasso("polyLasso");
    },
    onKey(e) {
      if (!app.preview.lasso) return false;
      if (e.key === "Enter") commitLasso("polyLasso");
      else if (e.key === "Escape") this.deactivate!();
      else if (e.key === "Backspace" || e.key === "Delete") {
        app.preview.lasso.pop();
        if (!app.preview.lasso.length) this.deactivate!();
      } else return false;
      app.emit("overlay");
      return true;
    },
    deactivate() {
      app.preview.lasso = undefined;
      app.preview.lassoCursor = null;
      app.emit("overlay");
    },
  };

  // ---------------- Magic Wand ----------------
  const wand: Tool = {
    id: "wand",
    label: "Magic Wand Tool",
    shortcut: "W",
    icon: "wand",
    cursor: CROSSHAIR,
    hint: "Click to select similar colors. Shift adds, Alt subtracts.",
    down(e) {
      const s = app.settings;
      app.run("select.wand", {
        x: Math.floor(e.x),
        y: Math.floor(e.y),
        tolerance: s.wandTolerance,
        contiguous: s.wandContiguous,
        antiAlias: s.wandAntiAlias,
        sampleMerged: s.wandSampleMerged,
        mode: selectMode(app, e),
      });
    },
    move() {},
    up() {},
  };

  // ---------------- Move ----------------
  type MoveState =
    | { kind: "layer"; id: number; sx: number; sy: number; dx: number; dy: number; start: { id: number; x: number; y: number; mask: Mask | null }[]; setMasks: { id: number; mask: Mask }[] }
    | { kind: "mask"; id: number; sx: number; sy: number; dx: number; dy: number; orig: Mask }
    | { kind: "pixels"; id: number; sx: number; sy: number; dx: number; dy: number; orig: import("../core/tiles").TileGrid; dup: boolean; dirty: Rect | null }
    | { kind: "guide"; orientation: "horizontal" | "vertical"; index: number };
  let mv: MoveState | null = null;
  const guideAt = (e: ToolEvent): { orientation: "horizontal" | "vertical"; index: number } | null => {
    const doc = app.doc!;
    if (!app.view.extras || !app.view.guides || app.view.lockGuides) return null;
    const tol = 4 / app.compositor.view.zoom;
    const h = doc.guides.h.findIndex((y) => Math.abs(y - e.y) <= tol);
    if (h >= 0) return { orientation: "horizontal", index: h };
    const v = doc.guides.v.findIndex((x) => Math.abs(x - e.x) <= tol);
    return v >= 0 ? { orientation: "vertical", index: v } : null;
  };
  // The Move tool's bounding box (Show Bounding Box).
  app.overlayPainters.add((ctx, s, v) => {
    if (app.active !== s || app.tool.id !== "move" || !app.settings.moveShowBounds || s.doc.selection || mv?.kind === "pixels") return;
    const b = moveBounds(s.doc);
    if (!b) return;
    const x0 = Math.round(b.x * v.zoom + v.x) + 0.5, y0 = Math.round(b.y * v.zoom + v.y) + 0.5;
    const x1 = Math.round((b.x + b.w) * v.zoom + v.x) + 0.5, y1 = Math.round((b.y + b.h) * v.zoom + v.y) + 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000";
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    for (const [u, w] of BOX_HANDLES) {
      const hx = Math.round(x0 + (x1 - x0) * u), hy = Math.round(y0 + (y1 - y0) * w);
      ctx.fillStyle = "#fff";
      ctx.fillRect(hx - 3, hy - 3, 7, 7);
      ctx.strokeRect(hx - 2.5, hy - 2.5, 6, 6);
    }
  });
  const move: Tool = {
    id: "move",
    label: "Move Tool",
    shortcut: "V",
    icon: "move",
    cursor: "move",
    hint: "Drag to move the selected layers (Auto-Select on the options bar picks what you click instead), or the selected pixels (Alt-drag moves a copy). Drag guides to move them. Arrow keys nudge.",
    hover(e) {
      const g = guideAt(e);
      const h = !g && app.settings.moveShowBounds && !app.doc?.selection ? boundsHandleAt(app, e) : null;
      app.viewport.style.cursor = g
        ? g.orientation === "horizontal"
          ? "ns-resize"
          : "ew-resize"
        : h !== null
          ? ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize"][h % 4]
          : app.cursorFor(move);
    },
    down(e) {
      const doc = app.doc!;
      const g = guideAt(e);
      if (g) {
        mv = { kind: "guide", ...g };
        app.preview.guide = { orientation: g.orientation, position: g.orientation === "horizontal" ? doc.guides.h[g.index] : doc.guides.v[g.index] };
        return;
      }
      // Auto-Select (off by default): pick what was clicked. Ctrl-click flips it only if the preference says so.
      let auto = autoSelectMode(app.settings.moveAutoSelect);
      if (e.ctrl && app.prefs.ctrlAutoSelect) auto = auto === "off" ? "layer" : "off";
      if (auto !== "off") {
        const hit = layerUnder(doc, e.x, e.y);
        const target = hit && (auto === "set" ? (doc.parentOf(hit.id) ?? hit) : hit);
        // Clicking one of several selected layers keeps them all selected.
        if (target && !doc.isSelected(target.id) && !(hit && doc.isSelected(hit.id))) app.run("layer.select", { id: target.id });
      }
      if (app.settings.moveShowBounds && !doc.selection) {
        const h = boundsHandleAt(app, e);
        if (h !== null) {
          // Dragging a handle of the bounding box turns into Free Transform, carrying on with the same drag.
          mv = null;
          void startTransform(app, "layer").then((ok) => ok && app.handOverDrag("transform", e));
          return;
        }
      }
      const node = doc.activeNode;
      if (!node) return;
      // Editing an unlinked mask: move the mask on its own.
      if (doc.editMask && node.mask && !node.maskLinked && !doc.quickMask) {
        mv = { kind: "mask", id: node.id, sx: e.x, sy: e.y, dx: 0, dy: 0, orig: node.mask };
        return;
      }
      const l = doc.activeLayer;
      if (l && doc.selection && !doc.quickMask) {
        if (l.locks.pixels) return app.toast(`Could not move the selection because "${l.name}" has its image pixels locked.`);
        if (l.text || l.shape) return void app.askRasterize(l.id);
        mv = { kind: "pixels", id: l.id, sx: e.x, sy: e.y, dx: 0, dy: 0, orig: l.grid.share(), dup: e.alt, dirty: null };
        return;
      }
      const { layers, groups } = movingSet(doc, doc.selectedNodes);
      const locked = layers.find((x) => x.isBackground || x.locks.position);
      if (locked) {
        return app.toast(
          locked.isBackground
            ? "Could not use the move tool because the Background layer is locked. Double-click it in the Layers palette to convert it."
            : `Could not use the move tool because "${locked.name}" has its position locked.`,
        );
      }
      mv = {
        kind: "layer",
        id: node.id,
        sx: e.x,
        sy: e.y,
        dx: 0,
        dy: 0,
        // Unlinked masks stay put on the canvas while their layers move.
        start: layers.map((x) => ({ id: x.id, x: x.offsetX, y: x.offsetY, mask: x.mask && !x.maskLinked ? x.mask : null })),
        setMasks: groups.filter((g) => g.mask && g.maskLinked).map((g) => ({ id: g.id, mask: g.mask! })),
      };
    },
    move(e) {
      const doc = app.doc!;
      if (!mv) return;
      if (mv.kind === "guide") {
        app.preview.guide = { orientation: mv.orientation, position: Math.round(mv.orientation === "horizontal" ? app.snap(0, e.y).y : app.snap(e.x, 0).x) };
        return;
      }
      let dx = Math.round(e.x - mv.sx);
      let dy = Math.round(e.y - mv.sy);
      if (e.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (dx === mv.dx && dy === mv.dy) return;
      mv.dx = dx;
      mv.dy = dy;
      if (mv.kind === "layer") {
        let dirty: Rect | null = null;
        for (const s of mv.start) {
          const l = doc.layerById(s.id)!;
          dirty = rectUnion(dirty, l.bounds());
          l.offsetX = s.x + dx;
          l.offsetY = s.y + dy;
          if (s.mask) l.mask = shiftMask(s.mask, -dx, -dy);
          dirty = rectUnion(dirty, l.bounds());
        }
        for (const sm of mv.setMasks) {
          const g = doc.nodeById(sm.id);
          if (g?.kind === "group") g.mask = shiftMask(sm.mask, dx, dy);
          dirty = { x: 0, y: 0, w: doc.width, h: doc.height };
        }
        doc.dirty(dirty);
      } else if (mv.kind === "mask") {
        const h = doc.nodeById(mv.id);
        if (h) h.mask = shiftMask(mv.orig, dx, dy);
        doc.dirty(null);
      } else {
        const l = doc.layerById(mv.id)!;
        l.grid = mv.orig.share();
        const r = moveSelectedPixels(doc, l, dx, dy, mv.dup);
        doc.dirty(rectUnion(mv.dirty, r));
        mv.dirty = rectUnion(mv.dirty, r);
        app.selectionOffset = { dx, dy };
      }
    },
    up() {
      const doc = app.doc!;
      const m = mv;
      mv = null;
      if (!m) return;
      if (m.kind === "guide") {
        const pos = app.preview.guide!.position;
        app.preview.guide = null;
        app.run("guide.move", { orientation: m.orientation, index: m.index, position: pos });
        return;
      }
      if (m.kind === "layer") {
        let dirty: Rect | null = null;
        for (const s of m.start) {
          const l = doc.layerById(s.id)!;
          dirty = rectUnion(dirty, l.bounds());
          l.offsetX = s.x;
          l.offsetY = s.y;
          if (s.mask) l.mask = s.mask;
        }
        for (const sm of m.setMasks) {
          const g = doc.nodeById(sm.id);
          if (g?.kind === "group") g.mask = sm.mask;
          dirty = null;
        }
        doc.dirty(dirty);
        // No id: the command moves every selected layer, as the preview did.
        if (m.dx || m.dy) app.run("layer.offset", { dx: m.dx, dy: m.dy });
        return;
      }
      if (m.kind === "mask") {
        const h = doc.nodeById(m.id);
        if (h) h.mask = m.orig;
        doc.dirty(null);
        if (m.dx || m.dy) app.run("layer.offsetMask", { id: m.id, dx: m.dx, dy: m.dy });
        return;
      }
      const l = doc.layerById(m.id)!;
      l.grid = m.orig;
      app.selectionOffset = null;
      doc.dirty(m.dirty);
      if (m.dx || m.dy) app.run("edit.moveSelection", { dx: m.dx, dy: m.dy, duplicate: m.dup });
    },
  };

  // ---------------- Crop ----------------
  type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  let cropDrag: { handle: Handle | "new"; sx: number; sy: number; orig: Rect } | null = null;
  const hitCrop = (e: ToolEvent): Handle | null => {
    const r = app.preview.crop;
    if (!r) return null;
    const a = app.toScreen(r.x, r.y), b = app.toScreen(r.x + r.w, r.y + r.h);
    const tol = 6;
    const nearL = Math.abs(e.sx - a.x) <= tol, nearR = Math.abs(e.sx - b.x) <= tol;
    const nearT = Math.abs(e.sy - a.y) <= tol, nearB = Math.abs(e.sy - b.y) <= tol;
    const inX = e.sx > a.x - tol && e.sx < b.x + tol, inY = e.sy > a.y - tol && e.sy < b.y + tol;
    if (nearT && nearL) return "nw";
    if (nearT && nearR) return "ne";
    if (nearB && nearL) return "sw";
    if (nearB && nearR) return "se";
    if (nearT && inX) return "n";
    if (nearB && inX) return "s";
    if (nearL && inY) return "w";
    if (nearR && inY) return "e";
    if (e.sx > a.x && e.sx < b.x && e.sy > a.y && e.sy < b.y) return "move";
    return null;
  };
  const crop: CropTool = {
    id: "crop",
    label: "Crop Tool",
    shortcut: "C",
    icon: "crop",
    cursor: CROSSHAIR,
    hint: "Drag to draw the crop box; drag its handles to adjust. Enter or double-click commits, Esc cancels.",
    get active() {
      return !!app.preview.crop;
    },
    hover(e) {
      const h = hitCrop(e);
      const cur: Record<Handle, string> = { move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };
      app.viewport.style.cursor = h ? cur[h] : CROSSHAIR;
    },
    down(e) {
      const h = hitCrop(e);
      const p = app.snap(e.x, e.y);
      if (h) cropDrag = { handle: h, sx: p.x, sy: p.y, orig: { ...app.preview.crop! } };
      else {
        cropDrag = { handle: "new", sx: p.x, sy: p.y, orig: { x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 } };
        app.preview.crop = { ...cropDrag.orig };
      }
      app.emit("tool");
    },
    move(e) {
      if (!cropDrag) return;
      const p = app.snap(e.x, e.y);
      const o = cropDrag.orig;
      const dx = Math.round(p.x - cropDrag.sx), dy = Math.round(p.y - cropDrag.sy);
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      const h = cropDrag.handle;
      if (h === "new") {
        x1 = Math.round(p.x);
        y1 = Math.round(p.y);
        if (e.shift) {
          const m = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
          x1 = x0 + Math.sign(x1 - x0 || 1) * m;
          y1 = y0 + Math.sign(y1 - y0 || 1) * m;
        }
      } else if (h === "move") {
        x0 += dx; x1 += dx; y0 += dy; y1 += dy;
      } else {
        if (h.includes("w")) x0 += dx;
        if (h.includes("e")) x1 += dx;
        if (h.includes("n")) y0 += dy;
        if (h.includes("s")) y1 += dy;
      }
      app.preview.crop = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    },
    up() {
      cropDrag = null;
      const r = app.preview.crop;
      if (r && (r.w < 1 || r.h < 1)) app.preview.crop = null;
      app.emit("tool");
    },
    dblclick(e) {
      if (hitCrop(e) === "move") crop.commit();
    },
    onKey(e) {
      if (!app.preview.crop) return false;
      if (e.key === "Enter") crop.commit();
      else if (e.key === "Escape") crop.cancel();
      else return false;
      return true;
    },
    commit() {
      const r = app.preview.crop;
      app.preview.crop = null;
      app.emit("tool");
      if (r && r.w >= 1 && r.h >= 1) app.run("image.crop", { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    },
    cancel() {
      app.preview.crop = null;
      app.emit("tool");
      app.emit("overlay");
    },
    deactivate() {
      crop.cancel();
    },
  };

  // ---------------- Brush, Pencil, Eraser ----------------
  let stroke: Stroke | null = null;
  let strokeParams: Record<string, unknown> = {};
  let airbrushTimer = 0;
  let lastPos: [number, number, number] | null = null;
  const lastPoint: Record<PaintToolId, [number, number] | null> = { brush: null, pencil: null, eraser: null };
  /** The Eraser's Erase to History (the History Brush engine); set once the retouch tools exist. */
  let historyEraser: Tool | null = null;
  /** The history eraser while it has the current stroke. */
  let erasing: Tool | null = null;

  /** Where painting goes right now, or null (with a message) if it can't. */
  const target = (label: string): PaintTarget | null => {
    const doc = app.doc!;
    if (doc.quickMask) return { kind: "selection" };
    const n = doc.activeNode;
    if (n && doc.editMask && n.mask) {
      if (!n.visible) {
        app.toast(`Could not use the ${label} because the target ${n.kind === "group" ? "layer set" : "layer"} is hidden.`);
        return null;
      }
      return { kind: "mask", host: n };
    }
    const l = doc.activeLayer;
    if (!l) {
      app.toast(`Could not use the ${label} because a layer set is selected. Select a layer.`);
      return null;
    }
    if (!l.visible) {
      app.toast(`Could not use the ${label} because the target layer is hidden.`);
      return null;
    }
    if (l.locks.pixels) {
      app.toast(`Could not use the ${label} because "${l.name}" has its image pixels locked.`);
      return null;
    }
    if (l.text || l.shape) {
      void app.askRasterize(l.id);
      return null;
    }
    return { kind: "pixels", layer: l };
  };

  const blockTip = (): BrushPreset => {
    const size = 16;
    return { ...app.toolBrush.eraser, size, sampled: { w: size, h: size, data: new Uint8Array(size * size).fill(255) }, shape: null, scatter: null, angle: 0, roundness: 100, spacing: 25 };
  };

  const makePaintTool = (kind: PaintToolId): Tool => {
    const labels = { brush: "Brush Tool", pencil: "Pencil Tool", eraser: "Eraser Tool" };
    const tool: Tool = {
      id: kind,
      label: labels[kind],
      shortcut: kind === "eraser" ? "E" : "B",
      icon: kind,
      cursor: "none",
      hint:
        kind === "eraser"
          ? "Drag to erase. On the Background layer and in masks the eraser paints the background color."
          : "Drag to paint. Shift-click paints a straight line. [ and ] change size, number keys set opacity.",
      down(e) {
        const doc = app.doc!;
        const s = app.settings;
        // Erase to History (Alt flips it for this stroke): paint back the History palette's source.
        if (kind === "eraser" && s.eraserToHistory !== e.alt && historyEraser && !doc.quickMask && !(doc.editMask && doc.activeNode?.mask)) {
          erasing = historyEraser;
          erasing.down({ ...e, alt: false });
          return;
        }
        const t = target(tool.label.toLowerCase());
        if (!t) return;
        let brush = app.toolBrush[kind];
        let fg: RGBA = [...doc.foreground];
        let opacity = 100, flow = 100, mode = "normal";
        let aliased = false;
        if (kind === "brush") {
          opacity = s.brushOpacity;
          flow = s.brushFlow;
          mode = s.brushMode;
        } else if (kind === "pencil") {
          opacity = s.pencilOpacity;
          mode = s.pencilMode;
          if (s.pencilAutoErase && t.kind === "pixels") {
            // Auto Erase: starting on the foreground color paints the background color.
            const px = t.layer.grid.getPixel(Math.floor(e.x) - t.layer.offsetX, Math.floor(e.y) - t.layer.offsetY);
            if (px[0] === fg[0] && px[1] === fg[1] && px[2] === fg[2] && px[3] > 0) fg = [...doc.background];
          }
        } else {
          opacity = s.eraserOpacity;
          flow = s.eraserMode === "brush" ? s.eraserFlow : 100;
          aliased = s.eraserMode !== "brush";
          if (s.eraserMode === "block") brush = blockTip();
        }
        const seed = (Math.random() * 2 ** 31) | 0;
        strokeParams = {
          tool: kind,
          brush: presetToJSON(brush),
          opacity,
          flow,
          mode,
          color: fg.slice(0, 3),
          target: t.kind,
          seed,
          aliased,
        };
        stroke = new Stroke(doc, t, {
          tool: kind,
          brush,
          opacity: opacity / 100,
          flow: flow / 100,
          mode: mode as never,
          fg,
          bg: [...doc.background],
          seed,
          aliased,
        });
        const prev = lastPoint[kind];
        if (e.shift && prev) stroke.addPoint(prev[0], prev[1], e.pressure);
        stroke.addPoint(e.x, e.y, e.pressure);
        lastPos = [e.x, e.y, e.pressure];
        if (brush.airbrush) {
          airbrushTimer = window.setInterval(() => {
            if (stroke && lastPos) stroke.addPoint(lastPos[0], lastPos[1], lastPos[2]);
          }, 60);
        }
      },
      move(e) {
        if (erasing) return erasing.move(e);
        if (!stroke) return;
        stroke.addPoint(e.x, e.y, e.pressure);
        lastPos = [e.x, e.y, e.pressure];
      },
      up(e) {
        if (erasing) {
          const h = erasing;
          erasing = null;
          return h.up(e);
        }
        clearInterval(airbrushTimer);
        if (!stroke) return;
        const s = stroke;
        stroke = null;
        s.end();
        lastPoint[kind] = [s.points[s.points.length - 1][0], s.points[s.points.length - 1][1]];
        const r2 = (v: number) => Math.round(v * 100) / 100;
        const pts = s.points.map(([x, y, p]) => (p === 1 ? [r2(x), r2(y)] : [r2(x), r2(y), r2(p)]));
        app.bus.dispatch("paint.stroke", { ...strokeParams, points: pts }, { applied: true });
      },
    };
    return tool;
  };

  // ---------------- Paint Bucket ----------------
  const bucket: Tool = {
    id: "bucket",
    label: "Paint Bucket Tool",
    shortcut: "G",
    icon: "bucket",
    cursor: CROSSHAIR,
    hint: "Click to fill similarly colored areas with the foreground color.",
    down(e) {
      const s = app.settings;
      app.run("paint.bucket", { x: Math.floor(e.x), y: Math.floor(e.y), tolerance: s.bucketTolerance, contiguous: s.bucketContiguous, opacity: s.bucketOpacity });
    },
    move() {},
    up() {},
  };

  // ---------------- Gradient ----------------
  let gStart: { x: number; y: number } | null = null;
  const gradEnd = (e: ToolEvent): [number, number] => {
    let x = e.x, y = e.y;
    if (e.shift && gStart) {
      // Shift constrains to 45 degree steps.
      const dx = x - gStart.x, dy = y - gStart.y;
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      x = gStart.x + Math.cos(a) * len;
      y = gStart.y + Math.sin(a) * len;
    }
    return [x, y];
  };
  const gradient: Tool = {
    id: "gradient",
    label: "Gradient Tool",
    shortcut: "G",
    icon: "gradient",
    cursor: CROSSHAIR,
    hint: "Drag to draw a gradient (Shift keeps 45-degree angles). On a layer mask it fades the layer; in Quick Mask it makes a soft selection.",
    down(e) {
      const doc = app.doc!;
      const n = doc.activeNode;
      if (!doc.quickMask && !(doc.editMask && n?.mask) && doc.activeLayer?.locks.pixels) {
        return app.toast(`Could not use the gradient tool because "${doc.activeLayer.name}" has its image pixels locked.`);
      }
      const tl = doc.activeLayer;
      if (!doc.quickMask && !(doc.editMask && n?.mask) && (tl?.text || tl?.shape)) return void app.askRasterize(tl.id);
      if (!doc.quickMask && !doc.activeLayer && !(doc.editMask && n?.mask)) {
        return app.toast("Could not use the gradient tool because a layer set is selected. Select a layer, or the set's mask.");
      }
      gStart = { x: e.x, y: e.y };
      app.preview.gradient = [e.x, e.y, e.x, e.y];
      app.emit("overlay");
    },
    move(e) {
      if (!gStart) return;
      const [x, y] = gradEnd(e);
      app.preview.gradient = [gStart.x, gStart.y, x, y];
      app.emit("overlay");
    },
    up(e) {
      if (!gStart) return;
      const [x, y] = gradEnd(e);
      const s0 = gStart;
      gStart = null;
      app.preview.gradient = null;
      app.emit("overlay");
      if (Math.hypot(x - s0.x, y - s0.y) * app.compositor.view.zoom < 2) return;
      const s = app.settings;
      const r = (v: number) => Math.round(v * 10) / 10;
      app.run("paint.gradient", {
        x0: r(s0.x), y0: r(s0.y), x1: r(x), y1: r(y),
        type: s.gradientType, preset: s.gradientPreset, mode: s.gradientMode, opacity: s.gradientOpacity,
        reverse: s.gradientReverse, dither: s.gradientDither, transparency: s.gradientTransparency,
      });
    },
  };

  // ---------------- Eyedropper ----------------
  const sample = (e: ToolEvent) => {
    const doc = app.doc!;
    const n = app.settings.eyedropperSample;
    const x = Math.floor(e.x) - (n >> 1), y = Math.floor(e.y) - (n >> 1);
    if (Math.floor(e.x) < 0 || Math.floor(e.y) < 0 || Math.floor(e.x) >= doc.width || Math.floor(e.y) >= doc.height) return;
    const r = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(n, doc.width - Math.max(0, x)), h: Math.min(n, doc.height - Math.max(0, y)) };
    const px = app.compositor.readPixels(r);
    let R = 0, G = 0, B = 0, A = 0;
    for (let o = 0; o < px.length; o += 4) {
      const a = px[o + 3];
      R += px[o] * a; G += px[o + 1] * a; B += px[o + 2] * a; A += a;
    }
    if (!A) return;
    app.bus.dispatch("color.set", { which: e.alt ? "background" : "foreground", r: Math.round(R / A), g: Math.round(G / A), b: Math.round(B / A) });
  };
  const eyedropper: Tool = {
    id: "eyedropper",
    label: "Eyedropper Tool",
    shortcut: "I",
    icon: "eyedropper",
    cursor: CROSSHAIR,
    hint: "Click to pick the foreground color. Alt-click picks the background color.",
    down: sample,
    move: sample,
    up() {},
  };

  // ---------------- Hand and Zoom ----------------
  let hLast: { sx: number; sy: number } | null = null;
  const hand: Tool = {
    id: "hand",
    label: "Hand Tool",
    shortcut: "H",
    icon: "hand",
    cursor: "grab",
    hint: "Drag to scroll the image. Double-click to fit it on screen.",
    down(e) {
      hLast = { sx: e.sx, sy: e.sy };
      app.viewport.style.cursor = "grabbing";
    },
    move(e) {
      if (!hLast) return;
      app.panBy(e.sx - hLast.sx, e.sy - hLast.sy);
      hLast = { sx: e.sx, sy: e.sy };
    },
    up() {
      hLast = null;
      app.viewport.style.cursor = app.cursorFor(app.tool);
    },
    dblclick() {
      app.fitOnScreen();
    },
  };

  const zoom: Tool = {
    id: "zoom",
    label: "Zoom Tool",
    shortcut: "Z",
    icon: "zoom",
    cursor: "zoom-in",
    hint: "Click to zoom in. Alt-click to zoom out. Double-click for 100%.",
    down(e) {
      if (e.detail > 1) return;
      app.zoomStep(e.alt ? -1 : 1, { sx: e.sx, sy: e.sy });
    },
    move() {},
    up() {},
    dblclick() {
      app.actualPixels();
    },
  };

  const more = makeMoreTools(app);
  const vec = makeVectorTools(app);
  const { spotHeal, heal, eraseToHistory, ...retouch } = makeRetouchTools(app);
  historyEraser = eraseToHistory;
  return {
    marquee: makeMarquee("marquee"),
    ellipse: makeMarquee("ellipse"),
    row: makeMarquee("row"),
    column: makeMarquee("column"),
    move,
    lasso,
    polyLasso,
    magneticLasso: more.magneticLasso,
    wand,
    crop,
    slice: more.slice,
    sliceSelect: more.sliceSelect,
    brush: makePaintTool("brush"),
    pencil: makePaintTool("pencil"),
    eraser: makePaintTool("eraser"),
    bucket,
    gradient,
    type: makeTypeTool(app),
    pathSelect: vec.pathSelect,
    directSelect: vec.directSelect,
    pen: vec.pen,
    freeformPen: vec.freeformPen,
    addAnchor: vec.addAnchor,
    deleteAnchor: vec.deleteAnchor,
    convertPoint: vec.convertPoint,
    rectShape: vec.rectShape,
    roundRectShape: vec.roundRectShape,
    ellipseShape: vec.ellipseShape,
    polygonShape: vec.polygonShape,
    lineShape: vec.lineShape,
    customShape: vec.customShape,
    // Before Face Swap, so J picks the Spot Healing Brush (as in Photoshop).
    spotHeal,
    heal,
    patch: more.patch,
    ...retouch,
    faceSwap: makeFaceSwapTool(app),
    transform: makeTransformTool(app),
    eyedropper,
    colorSampler: more.colorSampler,
    measure: more.measure,
    notes: more.notes,
    hand,
    zoom,
  };
}
