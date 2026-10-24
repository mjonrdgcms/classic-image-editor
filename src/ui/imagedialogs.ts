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
import { UNIT_LABELS, fromUnits, toUnits, type Units } from "../prefs";

const mb = (w: number, h: number) => {
  const b = w * h * 3;
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}K`;
};

/** Image > Image Size (Ctrl+Alt+I): pixel dimensions, print size and resolution, with or without resampling. */
export async function imageSizeDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const W = doc.width, H = doc.height, R0 = doc.resolution;
  const saved = storage.load<{ constrain: boolean; method?: string; unit: string; docUnit?: string; resUnit?: string; resample?: boolean }>("imageSize", { constrain: true, unit: "px" });
  const P = app.prefs;
  // Pixel sizes are kept unrounded while editing so repeated edits don't drift.
  let wf = W, hf = H, res = R0;
  const clampPx = (v: number) => Math.max(1, Math.min(30000, Math.round(v)));
  const wpx = () => clampPx(wf), hpx = () => clampPx(hf);
  const num = (label: string) => el("input", { type: "number", min: 0, step: "any", "aria-label": label }) as HTMLInputElement;
  const wIn = num("Width in pixels"), hIn = num("Height in pixels");
  const dwIn = num("Document width"), dhIn = num("Document height"), resIn = num("Resolution");
  const unit = el("select", { "aria-label": "Pixel units" }, el("option", { value: "px", text: "pixels" }), el("option", { value: "pct", text: "percent" }));
  unit.value = saved.unit === "pct" ? "pct" : "px";
  const DOC_UNITS: Units[] = ["inches", "cm", "mm", "points", "picas", "percent"];
  const docUnit = el("select", { "aria-label": "Document size units" });
  for (const u of DOC_UNITS) docUnit.append(el("option", { value: u, text: UNIT_LABELS[u] }));
  docUnit.value = DOC_UNITS.includes(saved.docUnit as Units) ? saved.docUnit! : P.rulerUnits !== "pixels" && P.rulerUnits !== "percent" ? P.rulerUnits : "inches";
  const resUnit = el("select", { "aria-label": "Resolution units" }, el("option", { value: "in", text: "pixels/inch" }), el("option", { value: "cm", text: "pixels/cm" }));
  resUnit.value = saved.resUnit === "cm" ? "cm" : "in";
  const constrain = el("input", { type: "checkbox", checked: saved.constrain });
  const resample = el("input", { type: "checkbox", checked: saved.resample ?? true });
  const method = el("select", { "aria-label": "Resample method" });
  for (const [v, t] of [["bicubic", "Bicubic (smooth gradients)"], ["lanczos", "Lanczos (sharpest)"], ["bilinear", "Bilinear"], ["nearest", "Nearest Neighbor (hard edges)"]]) method.append(el("option", { value: v, text: t }));
  method.value = saved.method ?? P.interpolation;
  const info = el("div", { class: "is-info" });
  // Print size in the chosen unit; percent is of the original print size.
  const du = () => docUnit.value as Units;
  const toDoc = (px: number, full: number) => (du() === "percent" ? (px / res / (full / R0)) * 100 : toUnits(px, du(), res, P.pointsPerInch));
  /** A print size in the chosen unit, in inches. */
  const docInches = (v: number, full: number) => (du() === "percent" ? ((v / 100) * full) / R0 : fromUnits(v, du(), 1, P.pointsPerInch));
  const resShown = () => (resUnit.value === "cm" ? res / 2.54 : res);
  const round = (v: number, d: number) => String(Math.round(v * 10 ** d) / 10 ** d);
  const show = () => {
    const pct = unit.value === "pct";
    const set = (i: HTMLInputElement, v: string) => {
      if (document.activeElement !== i) i.value = v;
    };
    const w = wpx(), h = hpx();
    set(wIn, pct ? round((w / W) * 100, 2) : String(w));
    set(hIn, pct ? round((h / H) * 100, 2) : String(h));
    set(dwIn, round(toDoc(wf, W), 3));
    set(dhIn, round(toDoc(hf, H), 3));
    set(resIn, round(resShown(), 3));
    wIn.disabled = hIn.disabled = unit.disabled = !resample.checked;
    method.disabled = !resample.checked;
    if (!resample.checked) constrain.checked = true;
    constrain.disabled = !resample.checked;
    info.textContent = `Pixel dimensions: ${mb(w, h)} (was ${mb(W, H)}) · ${w} × ${h} px`;
  };
  const valueOf = (i: HTMLInputElement) => {
    const v = parseFloat(i.value);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const setW = (nw: number) => {
    wf = Math.max(1, nw);
    if (constrain.checked) hf = (wf / W) * H;
  };
  const setH = (nh: number) => {
    hf = Math.max(1, nh);
    if (constrain.checked) wf = (hf / H) * W;
  };
  wIn.addEventListener("input", () => {
    const v = valueOf(wIn);
    if (v === null) return;
    setW(unit.value === "pct" ? (v / 100) * W : v);
    show();
  });
  hIn.addEventListener("input", () => {
    const v = valueOf(hIn);
    if (v === null) return;
    setH(unit.value === "pct" ? (v / 100) * H : v);
    show();
  });
  // Print width: with resampling the pixels change; without it the resolution does.
  const docEdit = (v: number, full: number, horiz: boolean) => {
    const inches = docInches(v, full);
    if (!(inches > 0)) return;
    if (resample.checked) horiz ? setW(inches * res) : setH(inches * res);
    else res = Math.max(1, Math.min(30000, (horiz ? wf : hf) / inches));
    show();
  };
  dwIn.addEventListener("input", () => {
    const v = valueOf(dwIn);
    if (v !== null) docEdit(v, W, true);
  });
  dhIn.addEventListener("input", () => {
    const v = valueOf(dhIn);
    if (v !== null) docEdit(v, H, false);
  });
  resIn.addEventListener("input", () => {
    const v = valueOf(resIn);
    if (v === null) return;
    const nr = Math.max(1, Math.min(30000, resUnit.value === "cm" ? v * 2.54 : v));
    // With resampling, the print size stays and the pixels follow.
    if (resample.checked) {
      wf = (wf / res) * nr;
      hf = (hf / res) * nr;
    }
    res = nr;
    show();
  });
  for (const x of [unit, docUnit, resUnit]) x.addEventListener("change", show);
  constrain.addEventListener("change", () => {
    if (constrain.checked) hf = (wf / W) * H;
    show();
  });
  resample.addEventListener("change", () => {
    if (!resample.checked) {
      // Without resampling the pixels can't change.
      wf = W;
      hf = H;
    }
    show();
  });
  // Quick presets.
  const presets = el("div", { class: "is-presets" });
  for (const [label, k] of [["25%", 0.25], ["50%", 0.5], ["200%", 2]] as const) {
    const b = el("button", { type: "button", class: "btn small", text: label });
    b.addEventListener("click", () => {
      resample.checked = true;
      wf = W * k;
      hf = H * k;
      show();
    });
    presets.append(b);
  }
  for (const long of [1080, 1920, 3840]) {
    const b = el("button", { type: "button", class: "btn small", text: `${long} px`, title: `Make the long side ${long} pixels` });
    b.addEventListener("click", () => {
      resample.checked = true;
      const k = long / Math.max(W, H);
      wf = W * k;
      hf = H * k;
      show();
    });
    presets.append(b);
  }
  show();
  const row = (label: string, ...kids: (HTMLElement | string)[]) => el("div", { class: "field-row" }, el("label", { text: label }), el("span", {}, ...kids));
  const body = el(
    "div",
    { class: "form" },
    el("fieldset", {}, el("legend", {}, "Pixel Dimensions"), info, row("Width:", wIn, unit), row("Height:", hIn)),
    el("fieldset", {}, el("legend", { text: "Document Size" }), row("Width:", dwIn, docUnit), row("Height:", dhIn), row("Resolution:", resIn, resUnit)),
    el("label", { class: "is-check" }, constrain, "Constrain Proportions"),
    el("label", { class: "is-check" }, resample, "Resample Image:", method),
    presets,
  );
  const r = await modal("Image Size", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  storage.save("imageSize", { constrain: constrain.checked, method: method.value, unit: unit.value, docUnit: docUnit.value, resUnit: resUnit.value, resample: resample.checked });
  const resChanged = Math.abs(res - R0) > 1e-3;
  const w = wpx(), h = hpx();
  if (r !== "ok" || (w === W && h === H && !resChanged)) return;
  app.run("image.resize", { width: w, height: h, method: method.value, ...(resChanged ? { resolution: Math.round(res * 1000) / 1000 } : {}) });
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
