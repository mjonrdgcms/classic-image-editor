/**
 * Layer > Layer Style: the effects dialog (live preview on the canvas),
 * copy / paste / clear, and the Styles palette's ready-made styles.
 */

import type { App } from "../app";
import { BLEND_LABELS, BLEND_MODES, type BlendMode } from "../core/blend";
import type { Layer } from "../core/document";
import { FX_DEFAULTS, FX_KEYS, FX_LABELS, normalizeStyle, type FxKey, type LayerStyle } from "../core/styles";
import { el, modal } from "./dialogs";

type Any = Record<string, unknown>;

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const rgbOf = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

/** Controls for each effect: [field, label, kind, min, max, suffix]. */
type Ctl = [string, string, "range" | "color" | "mode" | "angle" | "select", number?, number?, string?, [string, string][]?];
const CONTROLS: Record<FxKey, Ctl[]> = {
  dropShadow: [
    ["blendMode", "Blend Mode", "mode"],
    ["color", "Color", "color"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
    ["angle", "Angle", "angle", -180, 180, "°"],
    ["distance", "Distance", "range", 0, 300, "px"],
    ["spread", "Spread", "range", 0, 100, "%"],
    ["size", "Size", "range", 0, 250, "px"],
  ],
  innerShadow: [
    ["blendMode", "Blend Mode", "mode"],
    ["color", "Color", "color"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
    ["angle", "Angle", "angle", -180, 180, "°"],
    ["distance", "Distance", "range", 0, 300, "px"],
    ["spread", "Choke", "range", 0, 100, "%"],
    ["size", "Size", "range", 0, 250, "px"],
  ],
  outerGlow: [
    ["blendMode", "Blend Mode", "mode"],
    ["color", "Color", "color"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
    ["spread", "Spread", "range", 0, 100, "%"],
    ["size", "Size", "range", 0, 250, "px"],
  ],
  innerGlow: [
    ["blendMode", "Blend Mode", "mode"],
    ["color", "Color", "color"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
    ["source", "Source", "select", 0, 0, "", [["edge", "Edge"], ["center", "Center"]]],
    ["spread", "Choke", "range", 0, 100, "%"],
    ["size", "Size", "range", 0, 250, "px"],
  ],
  bevel: [
    ["style", "Style", "select", 0, 0, "", [["inner", "Inner Bevel"], ["outer", "Outer Bevel"], ["emboss", "Emboss"], ["pillow", "Pillow Emboss"]]],
    ["depth", "Depth", "range", 1, 1000, "%"],
    ["direction", "Direction", "select", 0, 0, "", [["up", "Up"], ["down", "Down"]]],
    ["size", "Size", "range", 0, 250, "px"],
    ["soften", "Soften", "range", 0, 16, "px"],
    ["angle", "Angle", "angle", -180, 180, "°"],
    ["altitude", "Altitude", "range", 0, 90, "°"],
    ["highlightMode", "Highlight Mode", "mode"],
    ["highlightColor", "Highlight Color", "color"],
    ["highlightOpacity", "Highlight Opacity", "range", 0, 100, "%"],
    ["shadowMode", "Shadow Mode", "mode"],
    ["shadowColor", "Shadow Color", "color"],
    ["shadowOpacity", "Shadow Opacity", "range", 0, 100, "%"],
  ],
  colorOverlay: [
    ["blendMode", "Blend Mode", "mode"],
    ["color", "Color", "color"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
  ],
  stroke: [
    ["size", "Size", "range", 1, 250, "px"],
    ["position", "Position", "select", 0, 0, "", [["outside", "Outside"], ["inside", "Inside"], ["center", "Center"]]],
    ["blendMode", "Blend Mode", "mode"],
    ["opacity", "Opacity", "range", 0, 100, "%"],
    ["color", "Color", "color"],
  ],
};

let copied: LayerStyle | null = null;

/** Make sure there is a layer that can take a style. */
function styleTarget(app: App): Layer | null {
  const l = app.doc?.activeLayer;
  if (!l) {
    app.toast("Select a layer to give it a layer style.");
    return null;
  }
  if (l.isBackground) {
    app.toast("The Background layer can't have effects. Double-click it in the Layers palette to make it a normal layer first.");
    return null;
  }
  return l;
}

export async function layerStyleDialog(app: App, focus?: FxKey): Promise<void> {
  const doc = app.doc;
  const l = doc && styleTarget(app);
  if (!doc || !l) return;
  const original = l.style;
  // Working copy with every effect present (disabled ones keep their settings).
  const st: Record<FxKey, Any> = {} as Record<FxKey, Any>;
  for (const k of FX_KEYS) st[k] = { ...(JSON.parse(JSON.stringify(FX_DEFAULTS[k])) as Any), enabled: false, ...((original?.[k] as Any | undefined) ?? {}) };
  if (focus && !original?.[focus]?.enabled) st[focus].enabled = true;
  let current: FxKey = focus ?? FX_KEYS.find((k) => st[k].enabled) ?? "dropShadow";

  const preview = el("input", { type: "checkbox", checked: true });
  const build = (): LayerStyle | null => {
    const out: Any = {};
    for (const k of FX_KEYS) if (st[k].enabled) out[k] = st[k];
    return normalizeStyle(out as LayerStyle);
  };
  let raf = 0;
  const show = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      l.style = preview.checked ? build() : original;
      doc.dirty(null);
    });
  };

  const list = el("div", { class: "ls-list", role: "listbox", "aria-label": "Effects" });
  const panel = el("div", { class: "ls-panel" });
  const rows = new Map<FxKey, HTMLElement>();
  const renderList = () => {
    for (const [k, row] of rows) {
      row.classList.toggle("active", k === current);
      (row.querySelector("input") as HTMLInputElement).checked = !!st[k].enabled;
    }
  };
  for (const k of FX_KEYS) {
    const cb = el("input", { type: "checkbox", "aria-label": `Enable ${FX_LABELS[k]}` });
    const row = el("div", { class: "ls-row", role: "option" }, cb, el("span", { text: FX_LABELS[k] }));
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      st[k].enabled = cb.checked;
      current = k;
      renderList();
      renderPanel();
      show();
    });
    row.addEventListener("click", () => {
      current = k;
      if (!st[k].enabled) st[k].enabled = true;
      renderList();
      renderPanel();
      show();
    });
    rows.set(k, row);
    list.append(row);
  }

  const renderPanel = () => {
    panel.textContent = "";
    const s = st[current];
    panel.append(el("div", { class: "ls-title", text: FX_LABELS[current] }));
    for (const [field, label, kind, min = 0, max = 100, suffix = "", opts] of CONTROLS[current]) {
      let ctl: HTMLElement;
      if (kind === "range" || kind === "angle") {
        const r = el("input", { type: "range", min, max, step: 1, value: Number(s[field]), "aria-label": label });
        const n = el("input", { type: "number", min, max, step: 1, value: Number(s[field]), "aria-label": label + " value" });
        const set = (v: number) => {
          v = Math.max(min, Math.min(max, Math.round(v)));
          r.value = n.value = String(v);
          s[field] = v;
          show();
        };
        r.addEventListener("input", () => set(+r.value));
        n.addEventListener("change", () => set(+n.value));
        ctl = el("span", { class: "ls-ctl" }, r, n, el("span", { class: "ls-suffix", text: suffix }));
      } else if (kind === "color") {
        const c = el("input", { type: "color", value: hex(s[field] as number[]), "aria-label": label });
        c.addEventListener("input", () => {
          s[field] = rgbOf(c.value);
          show();
        });
        ctl = c;
      } else {
        const sel = el("select", { "aria-label": label });
        const options: [string, string][] = kind === "mode" ? BLEND_MODES.map((m) => [m, BLEND_LABELS[m as BlendMode]]) : (opts ?? []);
        for (const [v, t] of options) sel.append(el("option", { value: v, text: t }));
        sel.value = String(s[field]);
        sel.addEventListener("change", () => {
          s[field] = sel.value;
          show();
        });
        ctl = sel;
      }
      panel.append(el("label", { class: "ls-field" }, el("span", { class: "ls-label", text: label + ":" }), ctl));
    }
    const reset = el("button", { type: "button", class: "btn small", text: "Reset to Default" });
    reset.addEventListener("click", () => {
      st[current] = { ...(JSON.parse(JSON.stringify(FX_DEFAULTS[current])) as Any), enabled: true };
      renderPanel();
      show();
    });
    panel.append(el("div", { class: "ls-foot" }, reset));
  };
  preview.addEventListener("change", show);
  renderList();
  renderPanel();
  show();
  const body = el("div", { class: "ls" }, el("div", { class: "ls-side" }, el("div", { class: "ls-head", text: "Styles" }), list, el("label", { class: "ls-preview" }, preview, "Preview")), panel);
  const r = await modal(`Layer Style: ${l.name}`, body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ], true);
  cancelAnimationFrame(raf);
  const final = build();
  l.style = original;
  doc.dirty(null);
  if (r !== "ok" || app.doc !== doc) return;
  if (!final && !original) return;
  app.run("layer.setStyle", { id: l.id, style: final });
}

export function copyLayerStyle(app: App): void {
  const s = app.doc?.activeLayer?.style;
  if (!s) return void app.toast("The active layer has no layer style to copy.");
  copied = s;
  app.status("Layer style copied.");
}

export function pasteLayerStyle(app: App): void {
  if (!copied) return void app.toast("Copy a layer style first (Layer > Layer Style > Copy Layer Style).");
  if (!styleTarget(app)) return;
  app.run("layer.setStyle", { style: copied });
}

export const hasCopiedStyle = () => !!copied;

// ------------------------------------------------------------------ Styles palette

const c = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
export const STYLE_PRESETS: { name: string; style: LayerStyle }[] = [
  { name: "Drop Shadow", style: { dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 8, size: 10, opacity: 60 } } },
  { name: "Soft Shadow", style: { dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 4, size: 24, opacity: 45 } } },
  { name: "Sticker", style: { stroke: { ...FX_DEFAULTS.stroke, size: 8, color: c(255, 255, 255) }, dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 6, size: 12, opacity: 55 } } },
  { name: "Black Outline", style: { stroke: { ...FX_DEFAULTS.stroke, size: 3, color: c(0, 0, 0) } } },
  { name: "Neon Glow", style: { outerGlow: { ...FX_DEFAULTS.outerGlow, color: c(0, 255, 230), size: 18, spread: 10, opacity: 90 }, innerGlow: { ...FX_DEFAULTS.innerGlow, color: c(220, 255, 255), size: 4, opacity: 80 } } },
  { name: "Warm Glow", style: { outerGlow: { ...FX_DEFAULTS.outerGlow, color: c(255, 190, 60), size: 24, opacity: 80 } } },
  { name: "Emboss", style: { bevel: { ...FX_DEFAULTS.bevel, style: "emboss", size: 6, depth: 150 } } },
  { name: "Chiseled", style: { bevel: { ...FX_DEFAULTS.bevel, size: 10, depth: 300, soften: 0 }, dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 4, size: 6, opacity: 50 } } },
  {
    name: "Gold",
    style: {
      colorOverlay: { ...FX_DEFAULTS.colorOverlay, color: c(214, 170, 60) },
      bevel: { ...FX_DEFAULTS.bevel, size: 8, depth: 220, highlightColor: c(255, 245, 200), shadowColor: c(90, 60, 10), shadowOpacity: 85 },
      dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 5, size: 8, opacity: 55 },
    },
  },
  {
    name: "Chrome",
    style: {
      colorOverlay: { ...FX_DEFAULTS.colorOverlay, color: c(190, 196, 205) },
      bevel: { ...FX_DEFAULTS.bevel, size: 12, depth: 400, altitude: 40, highlightOpacity: 100, shadowOpacity: 90 },
      innerShadow: { ...FX_DEFAULTS.innerShadow, distance: 3, size: 8, opacity: 40 },
    },
  },
  { name: "Inset", style: { innerShadow: { ...FX_DEFAULTS.innerShadow, distance: 4, size: 8, opacity: 70 }, bevel: { ...FX_DEFAULTS.bevel, direction: "down", size: 3, highlightOpacity: 50 } } },
  { name: "Comic", style: { stroke: { ...FX_DEFAULTS.stroke, size: 5, color: c(0, 0, 0) }, dropShadow: { ...FX_DEFAULTS.dropShadow, distance: 7, size: 0, opacity: 100, blendMode: "normal" } } },
];

/** The swatch for a preset: a rounded square with the style, drawn on the CPU. */
async function presetThumb(style: LayerStyle, size = 44): Promise<HTMLCanvasElement> {
  const { Document } = await import("../core/document");
  const d = new Document(size, size);
  const bg = d.addLayer("bg", 0);
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) px.set([236, 236, 236, 255], i * 4);
  bg.grid.writeRegion({ x: 0, y: 0, w: size, h: size }, px);
  const l = d.addLayer("shape");
  const s = new Uint8ClampedArray(size * size * 4);
  const m = 11, rad = 6;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.max(m + rad - x - 0.5, 0, x + 0.5 - (size - m - rad)), dy = Math.max(m + rad - y - 0.5, 0, y + 0.5 - (size - m - rad));
      const a = Math.max(0, Math.min(1, rad + 0.5 - Math.hypot(dx, dy)));
      if (a > 0) s.set([90, 120, 200, Math.round(a * 255)], (y * size + x) * 4);
    }
  l.grid.writeRegion({ x: 0, y: 0, w: size, h: size }, s);
  l.style = normalizeStyle(style);
  const out = d.composite({ x: 0, y: 0, w: size, h: size });
  const cv = el("canvas", { width: size, height: size, class: "sp-thumb" });
  cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(out), size, size), 0, 0);
  return cv;
}

export function stylesPalette(app: App): HTMLElement {
  const grid = el("div", { class: "sp-grid", role: "list" });
  const none = el("button", { type: "button", class: "sp-item sp-none", title: "Clear Style", "aria-label": "Clear Style" });
  none.addEventListener("click", () => app.doc?.activeLayer?.style && app.run("layer.setStyle", { style: null }));
  grid.append(none);
  for (const p of STYLE_PRESETS) {
    const b = el("button", { type: "button", class: "sp-item", title: p.name, "aria-label": p.name });
    void presetThumb(p.style).then((cv) => b.append(cv));
    b.addEventListener("click", () => styleTarget(app) && app.run("layer.setStyle", { style: p.style }));
    grid.append(b);
  }
  return el("div", { class: "sp-body" }, grid, el("p", { class: "sp-note", text: "Click a style to apply it to the active layer. Double-click a layer's fx badge to edit." }));
}
