/** The Paths palette: Work Path, saved paths, the active shape layer's path, and what to do with them. */

import type { App } from "../app";
import type { Document } from "../core/document";
import { shapeCanvasPath } from "../core/shapes";
import { flatten, type VecPath } from "../core/vector";
import { activePathId, onActivePath, pathChosen, setActivePathId } from "../tools/vectortools";
import { el, formDialog } from "./dialogs";
import type { MenuItem } from "./menus";
import { iconButton } from "./palettes";
import type { PaletteParts } from "./workspace";

function thumb(doc: Document, path: VecPath): HTMLCanvasElement {
  const H = 26, W = Math.max(18, Math.round((H * doc.width) / Math.max(1, doc.height)));
  const c = el("canvas", { width: W, height: H, class: "path-thumb" });
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const k = Math.min(W / doc.width, H / doc.height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.beginPath();
  for (const s of flatten(path, 2)) {
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k)));
    if (s.closed) ctx.closePath();
  }
  ctx.fillStyle = "#777";
  ctx.fill("nonzero");
  return c;
}

export function pathsPalette(app: App): PaletteParts {
  const list = el("div", { class: "paths-list", role: "listbox", "aria-label": "Paths" });
  const render = () => {
    list.textContent = "";
    const doc = app.doc;
    if (!doc) return;
    const active = activePathId(doc);
    const shapeLayer = doc.activeLayer?.shape ? doc.activeLayer : null;
    const rows: { id: number | null; name: string; path: VecPath; work: boolean; shape?: boolean }[] = doc.paths.map((p) => ({ id: p.id, name: p.name, path: p.path, work: p.work }));
    if (shapeLayer) rows.push({ id: null, name: `${shapeLayer.name} Shape Path`, path: shapeCanvasPath(shapeLayer), work: false, shape: true });
    if (!rows.length) list.append(el("p", { class: "paths-empty", text: "No paths yet. Draw with the Pen or a Shape tool (set to Path), or make one from a selection." }));
    for (const r of rows) {
      const chosen = pathChosen(doc);
      const on = r.shape ? !chosen : chosen && (r.work ? active === null : active === r.id);
      const row = el("div", { class: "path-row" + (on ? " active" : ""), role: "option", "aria-selected": on }, thumb(doc, r.path), el("span", { class: "path-name" + (r.work ? " work" : "") + (r.shape ? " shape" : ""), text: r.name }));
      row.addEventListener("click", () => {
        setActivePathId(doc, r.shape ? undefined : r.work ? null : r.id);
        app.emit("overlay");
        render();
      });
      row.addEventListener("dblclick", async () => {
        if (r.shape) return;
        const res = await formDialog(r.work ? "Save Path" : "Rename Path", [{ key: "name", label: "Name", type: "text", value: r.work ? nextPathName(doc) : r.name }]);
        if (res?.name) app.run("path.save", r.work ? { name: String(res.name) } : { id: r.id!, name: String(res.name) });
      });
      list.append(row);
    }
  };
  const target = (): Record<string, unknown> => {
    const doc = app.doc;
    if (!doc) return {};
    if (doc.activeLayer?.shape && !pathChosen(doc)) return { shape: true };
    const id = activePathId(doc);
    return id === null ? {} : { id };
  };
  const pathParam = (): Record<string, unknown> => {
    const t = target();
    // Fill and stroke have no "shape" option: pass the shape's path itself.
    if (t.shape && app.doc?.activeLayer?.shape) return { path: shapeCanvasPath(app.doc.activeLayer) };
    return t;
  };
  const footer = el(
    "div",
    { style: "display:contents" },
    iconButton("fillPath", "Fill path with foreground color", () => app.run("path.fill", pathParam())),
    iconButton("strokePath", "Stroke path with the brush (size and color from the Brush tool)", () => {
      const b = app.toolBrush.brush;
      app.run("path.stroke", { ...pathParam(), size: b.size, hardness: b.hardness });
    }),
    iconButton("pathToSel", "Load path as a selection", () => app.run("path.toSelection", target())),
    iconButton("selToPath", "Make work path from selection", () => app.run("path.fromSelection", {})),
    iconButton("newLayer", "Create new path", () => app.run("path.new", {})),
    iconButton("trash", "Delete path", () => {
      const doc = app.doc;
      if (!doc) return;
      const id = activePathId(doc);
      app.run("path.delete", id === null ? {} : { id });
    }),
  );
  const menu = (): MenuItem[] => [
    { label: "New Path...", run: () => void app.run("path.new", {}) },
    { label: "Save Path...", enabled: () => !!app.doc?.paths.some((p) => p.work), run: async () => {
      const doc = app.doc;
      if (!doc) return;
      const r = await formDialog("Save Path", [{ key: "name", label: "Name", type: "text", value: nextPathName(doc) }]);
      if (r?.name) app.run("path.save", { name: String(r.name) });
    } },
    { label: "Delete Path", run: () => void app.run("path.delete", target()) },
    "-",
    { label: "Make Work Path...", enabled: () => !!app.doc?.selection, run: async () => {
      const r = await formDialog("Make Work Path", [{ key: "tolerance", label: "Tolerance", type: "number", value: 2, min: 0.5, max: 10, step: 0.5, suffix: "pixels" }]);
      if (r) app.run("path.fromSelection", { tolerance: r.tolerance });
    } },
    { label: "Make Selection...", run: async () => {
      const r = await formDialog("Make Selection", [
        { key: "feather", label: "Feather Radius", type: "number", value: 0, min: 0, max: 250, suffix: "pixels" },
        { key: "antiAlias", label: "Anti-aliased", type: "checkbox", value: true },
      ]);
      if (r) app.run("path.toSelection", { ...target(), feather: r.feather, antiAlias: r.antiAlias });
    } },
    { label: "Fill Path", run: () => void app.run("path.fill", pathParam()) },
    { label: "Stroke Path", run: () => void app.run("path.stroke", { ...pathParam(), size: app.toolBrush.brush.size, hardness: app.toolBrush.brush.hardness }) },
    "-",
    { label: "Turn Off Path", run: () => app.doc && (setActivePathId(app.doc, undefined), app.emit("overlay")) },
  ];
  app.on("doc", render);
  app.on("sessions", render);
  onActivePath(render);
  render();
  return { body: el("div", { class: "paths-body" }, list), footer, menu };
}

function nextPathName(doc: Document): string {
  let n = 1;
  while (doc.paths.some((p) => p.name === `Path ${n}`)) n++;
  return `Path ${n}`;
}
