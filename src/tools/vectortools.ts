/**
 * Vector tools: the Pen, Freeform Pen, Add / Delete Anchor Point and
 * Convert Point tools (P), Path Selection and Direct Selection (A), and the
 * Rectangle, Rounded Rectangle, Ellipse, Polygon, Line and Custom Shape
 * tools (U).
 *
 * They edit the "target path": the active shape layer's shape, or the path
 * chosen in the Paths palette (the Work Path by default). Edits are shown
 * live in the overlay and committed as one command when the drag ends.
 */

import type { App } from "../app";
import type { Document } from "../core/document";
import { shapeCanvasPath } from "../core/shapes";
import {
  clonePath,
  corner,
  customShapePath,
  ellipsePath,
  flatten,
  linePath,
  nearestOnPath,
  polygonPath,
  rectPath,
  roundedRectPath,
  splitSegment,
  subpathFromPolyline,
  type Anchor,
  type Subpath,
  type VecPath,
} from "../core/vector";
import type { Tool, ToolEvent, ToolId } from "./tools";

/**
 * Which palette path each document is editing: a saved path's id, null for
 * the Work Path, or undefined when nothing was chosen. A choice is kept
 * until another layer becomes active.
 */
const activePath = new WeakMap<Document, { id: number | null; layerId: number }>();
const listeners = new Set<() => void>();

function choice(doc: Document): { id: number | null } | null {
  const c = activePath.get(doc);
  if (!c || c.layerId !== doc.activeLayerId) return null;
  if (c.id !== null && !doc.paths.some((p) => p.id === c.id)) return null;
  return c;
}

/** The chosen palette path's id (null: the Work Path, or nothing chosen). */
export function activePathId(doc: Document): number | null {
  return choice(doc)?.id ?? null;
}
/** Whether a palette path (the Work Path included) is chosen. */
export function pathChosen(doc: Document): boolean {
  return !!choice(doc);
}
export function setActivePathId(doc: Document, id: number | null | undefined): void {
  if (id === undefined) activePath.delete(doc);
  else activePath.set(doc, { id, layerId: doc.activeLayerId });
  for (const f of listeners) f();
}
export function onActivePath(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

type Target = { kind: "shape"; layerId: number; path: VecPath } | { kind: "path"; id: number | null; path: VecPath };

/**
 * What the path tools edit right now: a path chosen in the Paths palette,
 * else the active shape layer's shape, else the Work Path. With palette
 * true (the Pen in Paths mode), never a shape layer.
 */
export function targetPath(app: App, palette = false): Target | null {
  const doc = app.doc;
  if (!doc) return null;
  const l = doc.activeLayer;
  if (l?.shape && !palette && !pathChosen(doc)) return { kind: "shape", layerId: l.id, path: shapeCanvasPath(l) };
  const id = activePathId(doc);
  const dp = id !== null ? doc.paths.find((p) => p.id === id) : doc.paths.find((p) => p.work);
  return { kind: "path", id: dp && !dp.work ? dp.id : null, path: dp ? dp.path : { subpaths: [] } };
}

function commit(app: App, t: Target, path: VecPath, label?: string): void {
  if (t.kind === "shape") {
    app.run("layer.setShape", { id: t.layerId, path });
  } else {
    app.run("path.set", t.id === null ? { path } : { id: t.id, path });
    // Keep editing this path with the other path tools.
    if (app.doc) setActivePathId(app.doc, t.id);
  }
  if (label) app.status(label);
}

export const PEN_FAMILY: ToolId[] = ["pen", "freeformPen", "addAnchor", "deleteAnchor", "convertPoint"];
export const SHAPE_TOOLS: ToolId[] = ["rectShape", "roundRectShape", "ellipseShape", "polygonShape", "lineShape", "customShape"];
export const PATH_TOOLS: ToolId[] = [...PEN_FAMILY, "pathSelect", "directSelect", ...SHAPE_TOOLS];

export function makeVectorTools(app: App): Record<string, Tool> {
  const z = () => app.compositor.view.zoom;
  const near = (ax: number, ay: number, e: ToolEvent, px = 6) => Math.hypot(ax - e.x, ay - e.y) * z() <= px;

  /** A live edit shown instead of the committed path while dragging. */
  let live: VecPath | null = null;
  /** The pen's subpath in progress, and the rubber band end. */
  let pen: { sub: Subpath; target: Target; dragging: boolean; doc: unknown } | null = null;
  let rubber: [number, number] | null = null;
  /** Selected subpaths (Path Selection) and the selected anchor (Direct Selection). */
  let selSubs = new Set<number>();
  let selAnchor: { sub: number; pt: number } | null = null;
  // The selected subpaths / anchor belong to one path at one history state; anything else makes them stale.
  const objIds = new WeakMap<object, number>();
  let objN = 0;
  const idOf = (o: object | null | undefined) => {
    if (!o) return 0;
    if (!objIds.has(o)) objIds.set(o, ++objN);
    return objIds.get(o)!;
  };
  const keyNow = () => {
    const t = targetPath(app);
    return t ? `${idOf(app.doc)}|${t.kind}|${t.kind === "shape" ? t.layerId : t.id}|${idOf(app.bus.history.current)}` : "";
  };
  let selKey = "";
  const checkSel = () => {
    if ((selSubs.size || selAnchor) && selKey !== keyNow()) {
      selSubs = new Set();
      selAnchor = null;
    }
  };
  const markSel = () => void (selKey = keyNow());
  /** Shape being dragged out. */
  let shapeDrag: { x0: number; y0: number; subs: Subpath[] } | null = null;

  // ---------------- overlay ----------------
  app.overlayPainters.add((ctx, s, v) => {
    if (s !== app.active) return;
    const tool = app.tool.id;
    const showAll = PATH_TOOLS.includes(tool);
    const t = targetPath(app);
    if (!t) return;
    const path = live ?? t.path;
    const toS = (x: number, y: number): [number, number] => [x * v.zoom + v.x, y * v.zoom + v.y];
    // Only show a palette path when a path tool is active or it's chosen in the palette.
    if (!showAll && !(t.kind === "path" && pathChosen(s.doc))) return;
    const drawPath = (p: VecPath, color: string, width = 1) => {
      ctx.beginPath();
      for (const sp of flatten(p, 0.5 / v.zoom)) {
        sp.pts.forEach(([x, y], i) => (i ? ctx.lineTo(...toS(x, y)) : ctx.moveTo(...toS(x, y))));
        if (sp.closed) ctx.closePath();
      }
      ctx.strokeStyle = "rgba(0,0,0,.55)";
      ctx.lineWidth = width + 2;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    drawPath(path, "#4aa3ff");
    if (pen) drawPath({ subpaths: [pen.sub] }, "#4aa3ff", 1.5);
    if (shapeDrag) drawPath({ subpaths: shapeDrag.subs }, "#4aa3ff", 1.5);
    // Rubber band from the last pen point.
    if (pen && rubber && !pen.dragging && pen.sub.pts.length) {
      const a = pen.sub.pts[pen.sub.pts.length - 1];
      ctx.beginPath();
      ctx.moveTo(...toS(a.x, a.y));
      ctx.bezierCurveTo(...toS(a.ox, a.oy), ...toS(rubber[0], rubber[1]), ...toS(rubber[0], rubber[1]));
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#4aa3ff";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!showAll) return;
    // Anchors (and handles of the selected anchor and its neighbours).
    const anchorsOf = (p: VecPath, filled: (si: number) => boolean) =>
      p.subpaths.forEach((sp, si) =>
        sp.pts.forEach((a, pi) => {
          const [x, y] = toS(a.x, a.y);
          const showHandles = (selAnchor && selAnchor.sub === si && Math.abs(selAnchor.pt - pi) <= 1) || (pen && sp === pen.sub);
          if (showHandles) {
            for (const [hx, hy] of [
              [a.ix, a.iy],
              [a.ox, a.oy],
            ]) {
              if (hx === a.x && hy === a.y) continue;
              const [sx, sy] = toS(hx, hy);
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(sx, sy);
              ctx.strokeStyle = "#4aa3ff";
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.beginPath();
              ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
              ctx.fillStyle = "#4aa3ff";
              ctx.fill();
            }
          }
          const sel = selAnchor && selAnchor.sub === si && selAnchor.pt === pi;
          ctx.fillStyle = sel || filled(si) ? "#4aa3ff" : "#fff";
          ctx.strokeStyle = "#1d5fa8";
          ctx.lineWidth = 1;
          ctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
          ctx.strokeRect(Math.round(x) - 3.5, Math.round(y) - 3.5, 7, 7);
        }),
      );
    checkSel();
    if (tool === "pathSelect") anchorsOf(path, (si) => selSubs.has(si));
    else if (tool !== "rectShape" && !SHAPE_TOOLS.includes(tool)) anchorsOf(path, () => false);
    if (pen) anchorsOf({ subpaths: [pen.sub] }, () => false);
  });

  const repaint = () => app.emit("overlay");

  // ---------------- hit tests ----------------
  const anchorAt = (p: VecPath, e: ToolEvent): { sub: number; pt: number; part: "anchor" | "in" | "out" } | null => {
    // Handles of the selected anchor first (they can sit on top of other anchors).
    if (selAnchor) {
      const sp = p.subpaths[selAnchor.sub];
      for (let k = Math.max(0, selAnchor.pt - 1); sp && k <= Math.min(sp.pts.length - 1, selAnchor.pt + 1); k++) {
        const a = sp.pts[k];
        if ((a.ox !== a.x || a.oy !== a.y) && near(a.ox, a.oy, e)) return { sub: selAnchor.sub, pt: k, part: "out" };
        if ((a.ix !== a.x || a.iy !== a.y) && near(a.ix, a.iy, e)) return { sub: selAnchor.sub, pt: k, part: "in" };
      }
    }
    for (let si = p.subpaths.length - 1; si >= 0; si--) {
      const sp = p.subpaths[si];
      for (let pi = 0; pi < sp.pts.length; pi++) if (near(sp.pts[pi].x, sp.pts[pi].y, e)) return { sub: si, pt: pi, part: "anchor" };
    }
    return null;
  };
  const subpathAt = (p: VecPath, e: ToolEvent): number => {
    const n = nearestOnPath(p, e.x, e.y);
    if (n && n.d * z() <= 6) return n.sub;
    // Inside a closed subpath counts too.
    const flat = flatten(p, 1);
    for (let si = flat.length - 1; si >= 0; si--) {
      const pts = flat[si].pts;
      if (!flat[si].closed || pts.length < 3) continue;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if (yi > e.y !== yj > e.y && e.x < ((xj - xi) * (e.y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return si;
    }
    return -1;
  };

  // ---------------- Pen ----------------
  const finishPen = (close: boolean) => {
    const p = pen;
    pen = null;
    rubber = null;
    if (!p || p.doc !== app.doc || p.sub.pts.length < 2) return repaint();
    const sub = { ...p.sub, closed: close };
    // The path may have changed since the pen started (Ctrl for Direct Selection, undo): add to it as it is now.
    const now = targetPath(app, app.settings.penMode === "path");
    const same = now && (now.kind === "shape" ? p.target.kind === "shape" && now.layerId === p.target.layerId : p.target.kind === "path" && now.id === p.target.id);
    if (same) p.target = now;
    if (app.settings.penMode === "shape" && p.target.kind !== "shape") {
      if (sub.pts.length >= 2) app.run("layer.newShape", { path: { subpaths: [{ ...sub, closed: true }] } });
      return repaint();
    }
    const path = clonePath(p.target.path);
    path.subpaths.push(sub);
    commit(app, p.target, path);
    repaint();
  };
  const constrain = (from: Anchor | undefined, e: ToolEvent): [number, number] => {
    if (!from || !e.shift) return [e.x, e.y];
    const dx = e.x - from.x, dy = e.y - from.y;
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(dx, dy);
    return [from.x + Math.cos(a) * d, from.y + Math.sin(a) * d];
  };
  const penTool: Tool = {
    id: "pen",
    label: "Pen Tool",
    shortcut: "P",
    icon: "pen",
    cursor: "crosshair",
    hint: "Click for corner points, drag for curves. Click the first point to close; Enter or Esc ends an open path. Ctrl switches to Direct Selection.",
    down(e) {
      const t = targetPath(app, app.settings.penMode === "path");
      if (!t) return;
      if (pen && pen.doc !== app.doc) pen = null;
      if (!pen) pen = { sub: { closed: false, pts: [] }, target: t, dragging: false, doc: app.doc };
      const sub = pen.sub;
      if (sub.pts.length >= 2 && near(sub.pts[0].x, sub.pts[0].y, e, 7)) return finishPen(true);
      const [x, y] = constrain(sub.pts[sub.pts.length - 1], e);
      sub.pts.push(corner(x, y));
      pen.dragging = true;
      repaint();
    },
    move(e) {
      if (!pen || !pen.dragging) return;
      const a = pen.sub.pts[pen.sub.pts.length - 1];
      // Dragging pulls out symmetric handles (Alt breaks the in-handle free).
      a.ox = e.x;
      a.oy = e.y;
      if (!e.alt) {
        a.ix = 2 * a.x - e.x;
        a.iy = 2 * a.y - e.y;
      }
      repaint();
    },
    hover(e) {
      if (!pen) return;
      rubber = constrain(pen.sub.pts[pen.sub.pts.length - 1], e);
      repaint();
    },
    up() {
      if (pen) pen.dragging = false;
    },
    dblclick() {
      if (pen) {
        // The double-click's second press added a point; drop it.
        pen.sub.pts.pop();
        finishPen(false);
      }
    },
    onKey(ev) {
      if (!pen) return false;
      if (ev.key === "Enter" || ev.key === "Escape") {
        finishPen(false);
        return true;
      }
      if (ev.key === "Backspace" || ev.key === "Delete") {
        pen.sub.pts.pop();
        if (!pen.sub.pts.length) pen = null;
        repaint();
        return true;
      }
      return false;
    },
    deactivate: () => finishPen(false),
  };

  // ---------------- Freeform Pen ----------------
  let free: [number, number][] | null = null;
  const freeformPen: Tool = {
    id: "freeformPen",
    label: "Freeform Pen Tool",
    shortcut: "P",
    icon: "freeformPen",
    cursor: "crosshair",
    hint: "Drag to draw a path freehand; it's smoothed into curves. End near the start to close it.",
    down(e) {
      free = [[e.x, e.y]];
    },
    move(e) {
      if (!free) return;
      const [lx, ly] = free[free.length - 1];
      if (Math.hypot(e.x - lx, e.y - ly) * z() >= 2) free.push([e.x, e.y]);
      live = null;
      app.preview.lasso = [...free];
      repaint();
    },
    up() {
      const pts = free;
      free = null;
      app.preview.lasso = undefined;
      repaint();
      const t = targetPath(app, app.settings.penMode === "path");
      if (!pts || pts.length < 3 || !t) return;
      const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) * z() < 12;
      const sub = subpathFromPolyline(pts, closed, Math.max(0.75, 2 / z()));
      if (app.settings.penMode === "shape" && t.kind !== "shape") return void app.run("layer.newShape", { path: { subpaths: [{ ...sub, closed: true }] } });
      const path = clonePath(t.path);
      path.subpaths.push(sub);
      commit(app, t, path);
    },
  };

  // ---------------- Add / Delete / Convert anchor ----------------
  const addAnchor: Tool = {
    id: "addAnchor",
    label: "Add Anchor Point Tool",
    shortcut: "P",
    icon: "addAnchor",
    cursor: "crosshair",
    hint: "Click a path segment to add an anchor point there.",
    down(e) {
      const t = targetPath(app);
      if (!t) return;
      const n = nearestOnPath(t.path, e.x, e.y);
      if (!n || n.d * z() > 6) return app.toast("Click on a path segment to add a point.");
      const path = clonePath(t.path);
      path.subpaths[n.sub] = splitSegment(path.subpaths[n.sub], n.seg, Math.min(0.98, Math.max(0.02, n.t)));
      selAnchor = { sub: n.sub, pt: n.seg + 1 };
      commit(app, t, path);
    },
    move() {},
    up() {},
  };
  const deleteAnchor: Tool = {
    id: "deleteAnchor",
    label: "Delete Anchor Point Tool",
    shortcut: "P",
    icon: "deleteAnchor",
    cursor: "crosshair",
    hint: "Click an anchor point to remove it.",
    down(e) {
      const t = targetPath(app);
      if (!t) return;
      selAnchor = null;
      const h = anchorAt(t.path, e);
      if (!h || h.part !== "anchor") return;
      const path = clonePath(t.path);
      const sp = path.subpaths[h.sub];
      sp.pts.splice(h.pt, 1);
      if (sp.pts.length < 2) path.subpaths.splice(h.sub, 1);
      commit(app, t, path);
    },
    move() {},
    up() {},
  };
  let convertDrag: { t: Target; path: VecPath; sub: number; pt: number } | null = null;
  const convertPoint: Tool = {
    id: "convertPoint",
    label: "Convert Point Tool",
    shortcut: "P",
    icon: "convertPoint",
    cursor: "crosshair",
    hint: "Click a smooth point to make it a corner; drag from a corner to pull out curve handles.",
    down(e) {
      const t = targetPath(app);
      if (!t) return;
      const h = anchorAt(t.path, e);
      if (!h || h.part !== "anchor") return;
      selAnchor = { sub: h.sub, pt: h.pt };
      const path = clonePath(t.path);
      const a = path.subpaths[h.sub].pts[h.pt];
      const smooth = a.ix !== a.x || a.iy !== a.y || a.ox !== a.x || a.oy !== a.y;
      Object.assign(a, corner(a.x, a.y));
      convertDrag = { t, path, sub: h.sub, pt: h.pt };
      live = path;
      // A click on a smooth point makes it a corner straight away.
      if (smooth) (convertDrag as { wasSmooth?: boolean }).wasSmooth = true;
      repaint();
    },
    move(e) {
      if (!convertDrag) return;
      const a = convertDrag.path.subpaths[convertDrag.sub].pts[convertDrag.pt];
      a.ox = e.x;
      a.oy = e.y;
      a.ix = 2 * a.x - e.x;
      a.iy = 2 * a.y - e.y;
      repaint();
    },
    up() {
      const d = convertDrag;
      convertDrag = null;
      live = null;
      if (d) commit(app, d.t, d.path);
    },
  };

  // ---------------- Path Selection ----------------
  let moveDrag: { t: Target; base: VecPath; sx: number; sy: number; moved: boolean } | null = null;
  const pathSelect: Tool = {
    id: "pathSelect",
    label: "Path Selection Tool",
    shortcut: "A",
    icon: "pathSelect",
    cursor: "default",
    hint: "Click a path to select it, drag to move it (Alt-drag copies). Shift-click selects more. Delete removes the selected paths.",
    down(e) {
      checkSel();
      const t = targetPath(app);
      if (!t) return;
      const si = subpathAt(t.path, e);
      if (si < 0) {
        selSubs = new Set();
        repaint();
        return;
      }
      if (e.shift) selSubs.has(si) ? selSubs.delete(si) : selSubs.add(si);
      else if (!selSubs.has(si)) selSubs = new Set([si]);
      let base = clonePath(t.path);
      if (e.alt) {
        // Alt-drag: move copies, leaving the originals.
        const copies = [...selSubs].map((i) => clonePath({ subpaths: [base.subpaths[i]] }).subpaths[0]);
        const start = base.subpaths.length;
        base.subpaths.push(...copies);
        selSubs = new Set(copies.map((_, k) => start + k));
      }
      moveDrag = { t, base, sx: e.x, sy: e.y, moved: e.alt };
      markSel();
      repaint();
    },
    move(e) {
      if (!moveDrag) return;
      let dx = e.x - moveDrag.sx, dy = e.y - moveDrag.sy;
      if (e.shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      if (Math.hypot(dx, dy) * z() > 1) moveDrag.moved = true;
      const p = clonePath(moveDrag.base);
      for (const i of selSubs) p.subpaths[i] = { ...p.subpaths[i], pts: p.subpaths[i].pts.map((a) => ({ x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy })) };
      live = p;
      repaint();
    },
    up() {
      const d = moveDrag;
      moveDrag = null;
      const p = live;
      live = null;
      if (d && d.moved && p) commit(app, d.t, p);
      markSel();
      repaint();
    },
    onKey(ev) {
      checkSel();
      if ((ev.key !== "Delete" && ev.key !== "Backspace") || !selSubs.size) return false;
      const t = targetPath(app);
      if (!t) return false;
      const path = { subpaths: t.path.subpaths.filter((_, i) => !selSubs.has(i)) };
      selSubs = new Set();
      commit(app, t, path);
      return true;
    },
  };

  // ---------------- Direct Selection ----------------
  let pointDrag: { t: Target; base: VecPath; sub: number; pt: number; part: "anchor" | "in" | "out"; sx: number; sy: number; moved: boolean } | null = null;
  const directSelect: Tool = {
    id: "directSelect",
    label: "Direct Selection Tool",
    shortcut: "A",
    icon: "directSelect",
    cursor: "default",
    hint: "Drag anchor points and their handles to reshape a path (Alt moves one handle on its own). Delete removes the selected point.",
    down(e) {
      checkSel();
      const t = targetPath(app);
      if (!t) return;
      const h = anchorAt(t.path, e);
      if (!h) {
        const n = nearestOnPath(t.path, e.x, e.y);
        selAnchor = n && n.d * z() <= 6 ? { sub: n.sub, pt: n.seg } : null;
        markSel();
        repaint();
        return;
      }
      if (h.part === "anchor") selAnchor = { sub: h.sub, pt: h.pt };
      markSel();
      pointDrag = { t, base: clonePath(t.path), ...h, sx: e.x, sy: e.y, moved: false };
      repaint();
    },
    move(e) {
      const d = pointDrag;
      if (!d) return;
      const dx = e.x - d.sx, dy = e.y - d.sy;
      if (Math.hypot(dx, dy) * z() > 1) d.moved = true;
      const p = clonePath(d.base);
      const a = p.subpaths[d.sub].pts[d.pt];
      if (d.part === "anchor") Object.assign(a, { x: a.x + dx, y: a.y + dy, ix: a.ix + dx, iy: a.iy + dy, ox: a.ox + dx, oy: a.oy + dy });
      else {
        const [hx, hy, ox, oy] = d.part === "out" ? ["ox", "oy", "ix", "iy"] as const : ["ix", "iy", "ox", "oy"] as const;
        a[hx] += dx;
        a[hy] += dy;
        // Smooth points keep their handles in line (Alt breaks them apart).
        const b = d.base.subpaths[d.sub].pts[d.pt];
        const otherLen = Math.hypot(b[ox] - b.x, b[oy] - b.y);
        if (!e.alt && otherLen > 0) {
          const len = Math.hypot(a[hx] - a.x, a[hy] - a.y) || 1;
          a[ox] = a.x - ((a[hx] - a.x) / len) * otherLen;
          a[oy] = a.y - ((a[hy] - a.y) / len) * otherLen;
        }
      }
      live = p;
      repaint();
    },
    up() {
      const d = pointDrag;
      pointDrag = null;
      const p = live;
      live = null;
      if (d && d.moved && p) commit(app, d.t, p);
      markSel();
      repaint();
    },
    onKey(ev) {
      checkSel();
      if ((ev.key !== "Delete" && ev.key !== "Backspace") || !selAnchor) return false;
      const t = targetPath(app);
      if (!t) return false;
      const path = clonePath(t.path);
      const sp = path.subpaths[selAnchor.sub];
      if (!sp) return false;
      sp.pts.splice(selAnchor.pt, 1);
      if (sp.pts.length < 2) path.subpaths.splice(selAnchor.sub, 1);
      selAnchor = null;
      commit(app, t, path);
      return true;
    },
  };

  // ---------------- Shape tools ----------------
  const shapeOf = (id: ToolId, x0: number, y0: number, x1: number, y1: number, e: ToolEvent): Subpath[] => {
    const s = app.settings;
    if (id === "lineShape") {
      let [ex, ey] = [x1, y1];
      if (e.shift) {
        const a = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x1 - x0, y1 - y0);
        ex = x0 + Math.cos(a) * d;
        ey = y0 + Math.sin(a) * d;
      }
      return [linePath(x0, y0, ex, ey, s.lineWeight, s.lineArrowStart, s.lineArrowEnd)];
    }
    let w = x1 - x0, h = y1 - y0;
    // Shift: square / circle / unstretched; Alt: from the center.
    if (e.shift) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    let x = Math.min(x0, x0 + w), y = Math.min(y0, y0 + h);
    let W = Math.abs(w), H = Math.abs(h);
    if (e.alt) {
      x = x0 - W;
      y = y0 - H;
      W *= 2;
      H *= 2;
    }
    switch (id) {
      case "rectShape":
        return [rectPath(x, y, W, H)];
      case "roundRectShape":
        return [roundedRectPath(x, y, W, H, s.shapeRadius)];
      case "ellipseShape":
        return [ellipsePath(x, y, W, H)];
      case "polygonShape":
        return [polygonPath(x, y, W, H, s.polygonSides, s.polygonIndent)];
      default:
        return customShapePath(s.customShape, x, y, W, H);
    }
  };
  const makeShape = (id: ToolId, label: string, icon: string): Tool => ({
    id,
    label,
    shortcut: "U",
    icon,
    cursor: "crosshair",
    hint: "Drag to draw (Shift: keep proportions, Alt: from the center). The options bar picks a shape layer, a path, or pixels.",
    down(e) {
      shapeDrag = { x0: e.x, y0: e.y, subs: [] };
    },
    move(e) {
      if (!shapeDrag) return;
      shapeDrag.subs = shapeOf(id, shapeDrag.x0, shapeDrag.y0, e.x, e.y, e);
      repaint();
    },
    up(e) {
      const d = shapeDrag;
      shapeDrag = null;
      repaint();
      if (!d) return;
      const subs = shapeOf(id, d.x0, d.y0, e.x, e.y, e);
      if (Math.hypot(e.x - d.x0, e.y - d.y0) * z() < 3) return;
      const path: VecPath = { subpaths: subs };
      const mode = app.settings.shapeMode;
      const name = label.replace(/ Tool$/, "");
      if (mode === "shape") app.run("layer.newShape", { path, name: nextName(app, name) });
      else if (mode === "pixels") app.run("path.fill", { path });
      else {
        const t = targetPath(app, true);
        if (!t) return;
        const p = clonePath(t.path);
        p.subpaths.push(...subs);
        commit(app, t, p);
      }
    },
  });

  return {
    pen: penTool,
    freeformPen,
    addAnchor,
    deleteAnchor,
    convertPoint,
    pathSelect,
    directSelect,
    rectShape: makeShape("rectShape", "Rectangle Tool", "shape"),
    roundRectShape: makeShape("roundRectShape", "Rounded Rectangle Tool", "roundRect"),
    ellipseShape: makeShape("ellipseShape", "Ellipse Tool", "ellipseShape"),
    polygonShape: makeShape("polygonShape", "Polygon Tool", "polygonShape"),
    lineShape: makeShape("lineShape", "Line Tool", "lineShape"),
    customShape: makeShape("customShape", "Custom Shape Tool", "customShape"),
  };
}

function nextName(app: App, base: string): string {
  const doc = app.doc!;
  let n = 1;
  while (doc.layers.some((l) => l.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}
