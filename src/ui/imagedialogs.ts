/**
 * Image > Image Size, Canvas Size, Rotate Canvas > Arbitrary, Trim, and
 * Image > Duplicate.
 */

import type { App } from "../app";
import { ANCHORS, trimRect, type Anchor, type TrimBasis } from "../core/cmd/image";
import { encodeProject } from "../io/project";
import { settlePendingEdits } from "../core/history";
import { el, formDialog, modal } from "./dialogs";
import * as storage from "./storage";

const mb = (w: number, h: number) => {
  const b = w * h * 3;
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}K`;
};

/** Image > Image Size (Ctrl+Alt+I). */
export async function imageSizeDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const W = doc.width, H = doc.height;
  const saved = storage.load<{ constrain: boolean; method: string; unit: string }>("imageSize", { constrain: true, method: "bicubic", unit: "px" });
  let w = W, h = H;
  const wIn = el("input", { type: "number", min: 1, step: "any", "aria-label": "Width" });
  const hIn = el("input", { type: "number", min: 1, step: "any", "aria-label": "Height" });
  const unit = el("select", { "aria-label": "Units" }, el("option", { value: "px", text: "pixels" }), el("option", { value: "pct", text: "percent" }));
  unit.value = saved.unit === "pct" ? "pct" : "px";
  const constrain = el("input", { type: "checkbox", checked: saved.constrain });
  const method = el("select", { "aria-label": "Resample" });
  for (const [v, t] of [["bicubic", "Bicubic (smooth gradients)"], ["lanczos", "Lanczos (sharpest)"], ["bilinear", "Bilinear"], ["nearest", "Nearest Neighbor (hard edges)"]]) method.append(el("option", { value: v, text: t }));
  method.value = saved.method;
  const info = el("div", { class: "is-info" });
  const show = () => {
    const pct = unit.value === "pct";
    if (document.activeElement !== wIn) wIn.value = pct ? (Math.round((w / W) * 10000) / 100).toString() : String(w);
    if (document.activeElement !== hIn) hIn.value = pct ? (Math.round((h / H) * 10000) / 100).toString() : String(h);
    info.textContent = `Pixel dimensions: ${mb(w, h)} (was ${mb(W, H)}) · ${w} × ${h} px`;
  };
  const read = (input: HTMLInputElement, full: number) => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.max(1, Math.min(30000, Math.round(unit.value === "pct" ? (v / 100) * full : v)));
  };
  wIn.addEventListener("input", () => {
    const v = read(wIn, W);
    if (v === null) return;
    w = v;
    if (constrain.checked) h = Math.max(1, Math.round((w / W) * H));
    show();
  });
  hIn.addEventListener("input", () => {
    const v = read(hIn, H);
    if (v === null) return;
    h = v;
    if (constrain.checked) w = Math.max(1, Math.round((h / H) * W));
    show();
  });
  unit.addEventListener("change", show);
  constrain.addEventListener("change", () => {
    if (constrain.checked) {
      h = Math.max(1, Math.round((w / W) * H));
      show();
    }
  });
  // Quick presets.
  const presets = el("div", { class: "is-presets" });
  for (const [label, k] of [["25%", 0.25], ["50%", 0.5], ["200%", 2]] as const) {
    const b = el("button", { type: "button", class: "btn small", text: label });
    b.addEventListener("click", () => {
      w = Math.max(1, Math.round(W * k));
      h = Math.max(1, Math.round(H * k));
      show();
    });
    presets.append(b);
  }
  for (const long of [1080, 1920, 3840]) {
    const b = el("button", { type: "button", class: "btn small", text: `${long} px`, title: `Make the long side ${long} pixels` });
    b.addEventListener("click", () => {
      const k = long / Math.max(W, H);
      w = Math.max(1, Math.round(W * k));
      h = Math.max(1, Math.round(H * k));
      show();
    });
    presets.append(b);
  }
  show();
  const body = el(
    "div",
    { class: "form" },
    info,
    el("div", { class: "field-row" }, el("label", { text: "Width:" }), el("span", {}, wIn, unit)),
    el("div", { class: "field-row" }, el("label", { text: "Height:" }), el("span", {}, hIn)),
    el("label", { class: "is-check" }, constrain, "Constrain Proportions"),
    el("div", { class: "field-row" }, el("label", { text: "Resample:" }), el("span", {}, method)),
    presets,
  );
  const r = await modal("Image Size", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  storage.save("imageSize", { constrain: constrain.checked, method: method.value, unit: unit.value });
  if (r !== "ok" || (w === W && h === H)) return;
  app.run("image.resize", { width: w, height: h, method: method.value });
}

/** Image > Canvas Size (Ctrl+Alt+C). */
export async function canvasSizeDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const W = doc.width, H = doc.height;
  let anchor: Anchor = "c";
  const wIn = el("input", { type: "number", min: -29999, max: 30000, value: W, "aria-label": "Width" });
  const hIn = el("input", { type: "number", min: -29999, max: 30000, value: H, "aria-label": "Height" });
  const rel = el("input", { type: "checkbox" });
  rel.addEventListener("change", () => {
    wIn.value = String(rel.checked ? 0 : W);
    hIn.value = String(rel.checked ? 0 : H);
  });
  const grid = el("div", { class: "cs-anchor", role: "group", "aria-label": "Anchor" });
  const arrows: Record<Anchor, string> = { nw: "↖", n: "↑", ne: "↗", w: "←", c: "•", e: "→", sw: "↙", s: "↓", se: "↘" };
  const btns = ANCHORS.map((a) => {
    const b = el("button", { type: "button", class: "cs-cell", "aria-label": `Anchor ${a}`, text: arrows[a] });
    b.addEventListener("click", () => {
      anchor = a;
      btns.forEach((x, i) => x.classList.toggle("on", ANCHORS[i] === a));
    });
    grid.append(b);
    return b;
  });
  btns[4].classList.add("on");
  const body = el(
    "div",
    { class: "form" },
    el("div", { class: "is-info", text: `Current size: ${W} × ${H} px` }),
    el("div", { class: "field-row" }, el("label", { text: "Width:" }), el("span", {}, wIn, "px")),
    el("div", { class: "field-row" }, el("label", { text: "Height:" }), el("span", {}, hIn, "px")),
    el("label", { class: "is-check" }, rel, "Relative"),
    el("div", { class: "field-row" }, el("label", { text: "Anchor:" }), el("span", {}, grid)),
    el("p", { class: "is-note", text: "New area on the Background layer gets the background color." }),
  );
  const r = await modal("Canvas Size", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (r !== "ok") return;
  let w = Math.round(+wIn.value), h = Math.round(+hIn.value);
  if (rel.checked) {
    w += W;
    h += H;
  }
  if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) return app.toast("The canvas must be 1 to 30000 pixels on each side.");
  if (w === W && h === H) return;
  app.run("image.canvasSize", { width: w, height: h, anchor });
}

/** Image > Rotate Canvas > Arbitrary... */
export async function rotateArbitraryDialog(app: App): Promise<void> {
  if (!app.doc) return;
  const r = await formDialog("Rotate Canvas", [
    { key: "angle", label: "Angle", type: "number", value: storage.load("rotateAngle", 15), min: -359.99, max: 359.99, suffix: "°" },
    { key: "dir", label: "Direction", type: "select", value: "cw", options: [["cw", "Clockwise"], ["ccw", "Counterclockwise"]] },
  ]);
  if (!r || !r.angle) return;
  storage.save("rotateAngle", r.angle);
  app.run("image.rotate", { angle: r.dir === "ccw" ? -r.angle : r.angle });
}

/** Image > Trim... */
export async function trimDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const r = await formDialog("Trim", [
    { key: "basis", label: "Based On", type: "select", value: "transparent", options: [["transparent", "Transparent Pixels"], ["topLeft", "Top Left Pixel Color"], ["bottomRight", "Bottom Right Pixel Color"]] },
    { key: "heading", label: "Trim Away", type: "heading" },
    { key: "top", label: "Top", type: "checkbox", value: true },
    { key: "bottom", label: "Bottom", type: "checkbox", value: true },
    { key: "left", label: "Left", type: "checkbox", value: true },
    { key: "right", label: "Right", type: "checkbox", value: true },
  ]);
  if (!r) return;
  const rect = trimRect(doc, r.basis as TrimBasis, r as { top: boolean; bottom: boolean; left: boolean; right: boolean });
  if (!rect) return app.toast("Trimming would leave nothing.");
  if (rect.w === doc.width && rect.h === doc.height) return app.toast("There is nothing to trim.");
  app.run("image.trim", r);
}

/** Image > Duplicate...: a new window with a copy of the image (layers and all). */
export async function duplicateImageDialog(app: App): Promise<void> {
  settlePendingEdits();
  const doc = app.doc;
  if (!doc) return;
  const base = doc.name.replace(/\.[^.]+$/, "");
  const r = await formDialog("Duplicate Image", [
    { key: "name", label: "As", type: "text", value: `${base} copy` },
    { key: "merged", label: "Merged Layers Only", type: "checkbox", value: false },
  ]);
  if (!r) return;
  const name = String(r.name || `${base} copy`);
  if (r.merged) {
    const px = doc.composite();
    app.openImage({ name, width: doc.width, height: doc.height, data: px });
  } else await app.openProject(encodeProject(doc), name);
}
