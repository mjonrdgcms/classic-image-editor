/**
 * The Masks palette (properties of the active layer's or set's mask),
 * the Mask Edge dialog, and Layer Mask Display Options.
 */

import type { App } from "../app";
import type { Node } from "../core/document";
import { refineMask } from "../core/maskfx";
import type { Mask } from "../core/mask";
import { el, formDialog, modal } from "./dialogs";
import { colorRangeDialog } from "./dialogs2";
import { ICONS } from "./icons";
import type { MenuItem } from "./menus";

const iconBtn = (icon: string, title: string, fn: () => void) => {
  const b = el("button", { class: "icon-btn", type: "button", title, "aria-label": title });
  b.innerHTML = ICONS[icon] ?? icon;
  b.addEventListener("click", fn);
  return b;
};

const LOAD_SEL = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.15" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke-dasharray="1.6 1.8"/></svg>';
const APPLY = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

function drawMask(cv: HTMLCanvasElement, h: Node, m: Mask, docW: number, docH: number, size: number): void {
  const s = Math.min(size / docW, size / docH);
  const w = Math.max(1, Math.round(docW * s)), hh = Math.max(1, Math.round(docH * s));
  cv.width = w;
  cv.height = hh;
  const img = new ImageData(w, hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < w; x++) {
      const mx = Math.floor((x + 0.5) / s) - h.offsetX, my = Math.floor((y + 0.5) / s) - h.offsetY;
      const v = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? m.get(mx, my) : m.defaultValue;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  cv.getContext("2d")!.putImageData(img, 0, 0);
}

/** A slider row that edits a mask property live and records one history step on release. */
function liveSlider(app: App, label: string, min: number, max: number, unit: string, get: (n: Node) => number, set: (n: Node, v: number) => void, param: string, scale: number) {
  const range = el("input", { type: "range", min, max, step: 1, "aria-label": label });
  const num = el("input", { type: "number", min, max, step: 1, "aria-label": label + " value" });
  let raf = 0;
  let start: number | null = null;
  const live = (v: number) => {
    const doc = app.doc, n = doc?.activeNode;
    if (!doc || !n?.mask) return;
    if (start === null) start = get(n);
    set(n, v);
    range.value = num.value = String(v);
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        doc.dirty(null);
      });
  };
  const commit = () => {
    const doc = app.doc, n = doc?.activeNode;
    if (!doc || !n?.mask || start === null) return;
    const v = get(n);
    // Put the old value back so the command records the change properly.
    set(n, start);
    start = null;
    app.run("layer.setMaskProperties", { id: n.id, [param]: v * scale });
  };
  range.addEventListener("input", () => live(+range.value));
  range.addEventListener("change", commit);
  num.addEventListener("change", () => {
    live(Math.max(min, Math.min(max, +num.value || 0)));
    commit();
  });
  const row = el("div", { class: "mk-row" }, el("label", { text: label }), range, el("span", { class: "mk-num" }, num, el("span", { class: "unit", text: unit })));
  const sync = (n: Node | undefined) => {
    if (start !== null) return;
    const v = n?.mask ? get(n) : min;
    range.value = num.value = String(v);
    range.disabled = num.disabled = !n?.mask;
  };
  return { row, sync };
}

export function masksPalette(app: App, openEdge: () => void, openOptions: () => void) {
  const thumb = el("canvas", { class: "mk-thumb", title: "Click to edit the mask; Alt-click to view it" });
  const title = el("div", { class: "mk-title" });
  const status = el("div", { class: "mk-status" });
  const head = el("div", { class: "mk-head" }, thumb, el("div", { class: "mk-names" }, title, status));
  const density = liveSlider(app, "Density", 0, 100, "%", (n) => Math.round(n.maskDensity * 100), (n, v) => (n.maskDensity = v / 100), "density", 1);
  const feather = liveSlider(app, "Feather", 0, 250, "px", (n) => Math.round(n.maskFeather), (n, v) => (n.maskFeather = v), "feather", 1);

  const edgeBtn = el("button", { type: "button", class: "btn small", text: "Mask Edge..." });
  edgeBtn.addEventListener("click", openEdge);
  const rangeBtn = el("button", { type: "button", class: "btn small", text: "Color Range..." });
  rangeBtn.addEventListener("click", async () => {
    const doc = app.doc;
    const n = doc?.activeNode;
    if (!doc || !n?.mask) return;
    const before = app.bus.history.current?.id;
    await colorRangeDialog(app);
    if (app.bus.history.current?.id !== before && doc.selection) app.run("layer.maskFromSelection", { id: n.id, mode: "replace" });
  });
  const invertBtn = el("button", { type: "button", class: "btn small", text: "Invert" });
  invertBtn.addEventListener("click", () => void app.run("layer.invertMask"));
  const refine = el("div", { class: "mk-buttons" }, edgeBtn, rangeBtn, invertBtn);

  const viewSeg = el("div", { class: "seg mk-view", role: "radiogroup", "aria-label": "View" });
  for (const [v, l] of [["off", "Image"], ["overlay", "Overlay"], ["gray", "Mask"]] as const) {
    const b = el("button", { type: "button", text: l, "data-v": v, role: "radio" });
    b.addEventListener("click", () => {
      const n = app.doc?.activeNode;
      if (n?.mask && n.id !== app.doc!.activeLayerId) return;
      app.setMaskView(v);
    });
    viewSeg.append(b);
  }
  const overlaySwatch = el("button", { type: "button", class: "mk-swatch", title: "Overlay color and opacity" });
  overlaySwatch.addEventListener("click", openOptions);
  const viewRow = el("div", { class: "mk-viewrow" }, el("span", { class: "mk-label", text: "Show" }), viewSeg, overlaySwatch);

  const props = el("div", { class: "mk-props" }, density.row, feather.row, el("div", { class: "mk-label mk-sub", text: "Refine" }), refine, viewRow);

  // No mask yet.
  const add = (label: string, reveal: string, needSel = false) => {
    const b = el("button", { type: "button", class: "btn small", text: label });
    b.addEventListener("click", () => void app.run("layer.addMask", { reveal }));
    return { b, needSel };
  };
  const adds = [add("Reveal All", "all"), add("Hide All", "none"), add("From Selection", "selection", true), add("From Transparency", "transparency")];
  const empty = el("div", { class: "mk-empty" }, el("p", { class: "mk-hint" }), el("div", { class: "mk-buttons" }, ...adds.map((a) => a.b)));

  const body = el("div", { class: "mk-body" }, head, props, empty);

  // Footer: load as selection, apply, enable/disable, link, delete.
  const loadBtn = iconBtn(LOAD_SEL, "Load the mask as a selection", () => void app.run("select.fromMask", { mode: "replace" }));
  const applyBtn = iconBtn(APPLY, "Apply the mask to the layer", () => void app.run("layer.removeMask", { apply: true }));
  const eyeBtn = iconBtn("eye", "Turn the mask off or on", () => {
    const n = app.doc?.activeNode;
    if (n?.mask) app.run("layer.setMaskEnabled", { enabled: !n.maskEnabled });
  });
  const linkBtn = iconBtn("link", "Link or unlink the mask and the layer", () => {
    const n = app.doc?.activeNode;
    if (n?.mask) app.run("layer.setMaskProperties", { linked: !n.maskLinked });
  });
  const trashBtn = iconBtn("trash", "Delete the mask", () => void app.run("layer.removeMask", { apply: false }));
  const footer = el("div", { style: "display:contents" }, loadBtn, applyBtn, eyeBtn, linkBtn, trashBtn);

  let raf = 0;
  const render = () => {
    raf = 0;
    const doc = app.doc;
    const n = doc?.activeNode;
    const has = !!n?.mask;
    head.style.display = props.style.display = has ? "" : "none";
    empty.style.display = has || !n ? "none" : "";
    for (const b of [loadBtn, applyBtn, eyeBtn, linkBtn, trashBtn]) b.disabled = !has;
    if (n && n.kind === "group") applyBtn.disabled = true;
    (empty.querySelector(".mk-hint") as HTMLElement).textContent = !n ? "" : `"${n.name}" has no mask. Add one:`;
    for (const a of adds) a.b.disabled = !n || (n.kind === "layer" && n.isBackground) || (a.needSel && !doc?.selection);
    if (!doc || !n) {
      body.classList.add("none");
      return;
    }
    body.classList.remove("none");
    if (!has) return;
    title.textContent = `${n.name}: ${n.kind === "group" ? "Set Mask" : "Layer Mask"}`;
    const bits = [n.maskEnabled ? "" : "Off", n.maskLinked ? "Linked" : "Unlinked", doc.editMask ? "Editing" : ""].filter(Boolean);
    status.textContent = bits.join(" · ");
    drawMask(thumb, n, n.mask!, doc.width, doc.height, 72);
    thumb.classList.toggle("off", !n.maskEnabled);
    thumb.classList.toggle("target", doc.editMask);
    density.sync(n);
    feather.sync(n);
    eyeBtn.classList.toggle("active", !n.maskEnabled);
    linkBtn.classList.toggle("active", n.maskLinked);
    viewSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === app.maskView));
    overlaySwatch.style.background = app.prefs.maskOverlayColor;
    overlaySwatch.style.opacity = String(0.4 + (app.prefs.maskOverlayOpacity / 100) * 0.6);
  };
  const queue = () => {
    if (!raf) raf = requestAnimationFrame(render);
  };
  thumb.addEventListener("click", (e) => {
    const n = app.doc?.activeNode;
    if (!n?.mask) return;
    if (!app.doc!.editMask) app.run("layer.editMask", { edit: true });
    if (e.altKey) app.setMaskView(app.maskView === "gray" ? "off" : "gray");
  });
  let unsub: (() => void) | null = null;
  app.on("doc", () => {
    queue();
    unsub?.();
    unsub = app.doc?.on((ev) => (ev.type === "layers" || ev.type === "pixels" || ev.type === "selection" ? queue() : undefined)) ?? null;
  });
  app.on("view", queue);
  app.on("prefs", queue);
  queue();

  const menu = (): MenuItem[] => [
    { label: "Mask Edge...", enabled: !!app.doc?.activeNode?.mask, run: openEdge },
    { label: "Layer Mask Display Options...", run: openOptions },
  ];
  return { body, footer, menu };
}

/** Layer > Layer Mask > Mask Edge: smooth, feather, contrast and shift the edge, previewed live. */
export async function maskEdgeDialog(app: App): Promise<void> {
  const doc = app.doc;
  const n = doc?.activeNode;
  if (!doc || !n?.mask) return;
  const orig = n.mask;
  const prevView = app.maskView;
  const p = { smooth: 0, feather: 0, contrast: 0, shift: 0 };
  const rows: [keyof typeof p, string, number, number, string][] = [
    ["smooth", "Smooth", 0, 100, ""],
    ["feather", "Feather", 0, 250, "px"],
    ["contrast", "Contrast", 0, 100, "%"],
    ["shift", "Shift Edge", -100, 100, "%"],
  ];
  let raf = 0;
  const preview = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      n.mask = p.smooth || p.feather || p.contrast || p.shift ? refineMask(orig, p) : orig;
      doc.dirty(null);
      doc.emit({ type: "layers" });
    });
  };
  const body = el("div", { class: "form mk-edge" });
  for (const [k, label, min, max, unit] of rows) {
    const range = el("input", { type: "range", min, max, value: 0, "aria-label": label });
    const num = el("input", { type: "number", min, max, value: 0, "aria-label": label + " value" });
    const set = (v: number) => {
      p[k] = Math.max(min, Math.min(max, Math.round(v)));
      range.value = num.value = String(p[k]);
      preview();
    };
    range.addEventListener("input", () => set(+range.value));
    num.addEventListener("change", () => set(+num.value));
    body.append(el("div", { class: "mk-row" }, el("label", { text: label }), range, el("span", { class: "mk-num" }, num, el("span", { class: "unit", text: unit }))));
  }
  const seg = el("div", { class: "seg" });
  for (const [v, l] of [["overlay", "Overlay"], ["gray", "Mask"], ["off", "Image"]] as const) {
    const b = el("button", { type: "button", text: l, "data-v": v });
    b.addEventListener("click", () => {
      app.setMaskView(v);
      seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    seg.append(b);
  }
  body.append(el("div", { class: "mk-viewrow" }, el("span", { class: "mk-label", text: "Preview" }), seg));
  app.setMaskView(prevView === "off" ? "overlay" : prevView);
  seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", (x as HTMLElement).dataset.v === app.maskView));
  const r = await modal("Mask Edge", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (raf) cancelAnimationFrame(raf);
  n.mask = orig;
  doc.dirty(null);
  doc.emit({ type: "layers" });
  if (r === "ok" && (p.smooth || p.feather || p.contrast || p.shift)) app.run("layer.refineMask", { id: n.id, ...p });
  app.setMaskView(prevView);
}

/** Layer Mask Display Options: overlay color and opacity. */
export async function maskDisplayOptions(app: App): Promise<void> {
  const r = await formDialog("Layer Mask Display Options", [
    { key: "color", label: "Color", type: "color", value: app.prefs.maskOverlayColor },
    { key: "opacity", label: "Opacity", type: "number", value: app.prefs.maskOverlayOpacity, min: 0, max: 100, step: 1, suffix: "%" },
  ]);
  if (!r) return;
  app.setPrefs({ maskOverlayColor: r.color, maskOverlayOpacity: Math.max(0, Math.min(100, Math.round(r.opacity))) });
}
