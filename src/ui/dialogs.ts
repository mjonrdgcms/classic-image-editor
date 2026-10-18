/**
 * Modal dialogs in the PS7 style: caption bar, form on the left, a column
 * of OK / Cancel buttons on the right.
 */

import type { App, NewDocOptions } from "../app";
import { ICONS } from "./icons";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (typeof v === "boolean") {
      if (v) e.setAttribute(k, "");
    } else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

interface ModalButton {
  label: string;
  value: string;
  default?: boolean;
}

let openCount = 0;

export function isModalOpen(): boolean {
  return openCount > 0;
}

/** Show a modal; resolves with the clicked button's value ("cancel" on Esc). */
export function modal(title: string, body: HTMLElement, buttons: ModalButton[], wide = false): Promise<string> {
  return new Promise((resolve) => {
    openCount++;
    const close = (v: string) => {
      openCount--;
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const btnCol = el("div", { class: "buttons" });
    for (const b of buttons) {
      const btn = el("button", { class: "btn" + (b.default ? " default" : ""), text: b.label, type: "button" });
      btn.addEventListener("click", () => close(b.value));
      btnCol.append(btn);
    }
    const x = el("button", { type: "button", "aria-label": "Close" });
    x.innerHTML = ICONS.close;
    x.addEventListener("click", () => close("cancel"));
    const dlg = el(
      "div",
      { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": title, style: wide ? "max-width:640px" : "" },
      el("div", { class: "caption" }, el("span", { text: title }), x),
      el("div", { class: "content" }, el("div", { class: "form" }, body), btnCol),
    );
    const back = el("div", { class: "modal-backdrop" }, dlg);
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") close("cancel");
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        const def = buttons.find((b) => b.default);
        if (def) {
          e.preventDefault();
          close(def.value);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    (dlg.querySelector("input, select") as HTMLElement | null)?.focus();
    (dlg.querySelector("input") as HTMLInputElement | null)?.select?.();
  });
}

/**
 * A larger dialog that lays out its own buttons (Filter Library, B&W Lab).
 * Esc closes it with "cancel" unless onKey handles the key first.
 */
export function sheet(
  title: string,
  body: HTMLElement,
  opts: { className?: string; onKey?: (e: KeyboardEvent) => boolean } = {},
): { root: HTMLElement; caption: HTMLElement; close: (v?: string) => void; done: Promise<string> } {
  let resolve!: (v: string) => void;
  const done = new Promise<string>((r) => (resolve = r));
  openCount++;
  let closed = false;
  const close = (v = "cancel") => {
    if (closed) return;
    closed = true;
    openCount--;
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    resolve(v);
  };
  const x = el("button", { type: "button", "aria-label": "Close" });
  x.innerHTML = ICONS.close;
  x.addEventListener("click", () => close("cancel"));
  const titleEl = el("span", { text: title });
  const caption = el("div", { class: "caption" }, titleEl, x);
  const root = el("div", { class: "dialog sheet " + (opts.className ?? ""), role: "dialog", "aria-modal": "true", "aria-label": title }, caption, body);
  const back = el("div", { class: "modal-backdrop" }, root);
  const onKey = (e: KeyboardEvent) => {
    // A dialog opened on top of this one handles its own keys.
    const backs = document.querySelectorAll(".modal-backdrop");
    if (backs[backs.length - 1] !== back) return;
    if (opts.onKey?.(e)) {
      e.stopPropagation();
      return;
    }
    const t = e.target as HTMLElement;
    const typing = t.closest?.("input[type=text], input[type=search], input[type=number], textarea");
    e.stopPropagation();
    if (e.key === "Escape" && !document.querySelector(".menu-pop")) close("cancel");
    else if (e.key === "Escape") return;
    else if (!typing && /^(z|Z)$/.test(e.key) && (e.ctrlKey || e.metaKey)) e.preventDefault();
  };
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  return { root, caption: titleEl, close, done };
}

/** A small "working..." pill with an optional Cancel button. */
export function busyPill(label: string, onCancel?: () => void): { set: (label: string) => void; done: () => void } {
  const text = el("span", { text: label });
  const spin = el("span", { class: "spinner", "aria-hidden": "true" });
  const pill = el("div", { class: "busy-pill", role: "status" }, spin, text);
  if (onCancel) {
    const b = el("button", { type: "button", class: "btn small", text: "Cancel" });
    b.addEventListener("click", onCancel);
    pill.append(b);
  }
  document.body.append(pill);
  return { set: (l) => (text.textContent = l), done: () => pill.remove() };
}

export async function alertDialog(title: string, message: string): Promise<void> {
  await modal(title, el("p", { text: message }), [{ label: "OK", value: "ok", default: true }]);
}

export async function confirmDialog(title: string, message: string, ok = "OK"): Promise<boolean> {
  return (await modal(title, el("p", { text: message }), [
    { label: ok, value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ])) === "ok";
}

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: "Custom", w: 0, h: 0 },
  { label: "640 x 480", w: 640, h: 480 },
  { label: "800 x 600", w: 800, h: 600 },
  { label: "1024 x 768", w: 1024, h: 768 },
  { label: "1920 x 1080", w: 1920, h: 1080 },
  { label: "2560 x 1440", w: 2560, h: 1440 },
  { label: "3840 x 2160 (4K)", w: 3840, h: 2160 },
  { label: "Letter, 300 ppi (2550 x 3300)", w: 2550, h: 3300 },
  { label: "A4, 300 ppi (2480 x 3508)", w: 2480, h: 3508 },
  { label: "4 x 6 photo, 300 ppi (1800 x 1200)", w: 1800, h: 1200 },
];

let lastNew = { w: 800, h: 600, contents: "white" as NewDocOptions["contents"] };

export async function newDocumentDialog(app: App): Promise<NewDocOptions | null> {
  const name = el("input", { type: "text", value: app.nextUntitledName() });
  const preset = el("select");
  for (const p of PRESETS) preset.append(el("option", { value: p.label, text: p.label }));
  const width = el("input", { type: "number", min: 1, max: app.maxTextureSize, value: lastNew.w });
  const height = el("input", { type: "number", min: 1, max: app.maxTextureSize, value: lastNew.h });
  const match = () => {
    const p = PRESETS.find((p) => p.w === +width.value && p.h === +height.value);
    preset.value = p ? p.label : "Custom";
  };
  match();
  preset.addEventListener("change", () => {
    const p = PRESETS.find((p) => p.label === preset.value);
    if (p && p.w) {
      width.value = String(p.w);
      height.value = String(p.h);
    }
  });
  width.addEventListener("input", match);
  height.addEventListener("input", match);
  const contents = el("fieldset", {}, el("legend", { text: "Contents" }));
  for (const [v, label] of [
    ["white", "White"],
    ["background", "Background Color"],
    ["transparent", "Transparent"],
  ] as const) {
    contents.append(
      el(
        "label",
        { style: "display:block;margin:3px 0" },
        el("input", { type: "radio", name: "contents", value: v, checked: v === lastNew.contents }),
        " " + label,
      ),
    );
  }
  const size = el("span", { style: "color:var(--text-dim)" });
  const updateSize = () => {
    const bytes = Math.max(0, +width.value) * Math.max(0, +height.value) * 3;
    size.textContent = `Image Size: ${bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + "M" : Math.ceil(bytes / 1024) + "K"}`;
  };
  updateSize();
  width.addEventListener("input", updateSize);
  height.addEventListener("input", updateSize);
  const body = el(
    "div",
    { class: "form" },
    el("div", { class: "field-row" }, el("label", { text: "Name:" }), name),
    el(
      "fieldset",
      {},
      el("legend", {}, "Image Size: ", size),
      el("div", { class: "field-row", style: "margin:4px 0" }, el("label", { text: "Preset Sizes:" }), preset),
      el("div", { class: "field-row", style: "margin:4px 0" }, el("label", { text: "Width:" }), el("span", {}, width, " pixels")),
      el("div", { class: "field-row", style: "margin:4px 0" }, el("label", { text: "Height:" }), el("span", {}, height, " pixels")),
      el("div", { class: "field-row", style: "margin:4px 0" }, el("label", { text: "Mode:" }), el("span", { text: "RGB Color, 8 bits/channel" })),
    ),
    contents,
  );
  const r = await modal("New", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (r !== "ok") return null;
  const w = Math.round(+width.value);
  const h = Math.round(+height.value);
  const max = app.maxTextureSize;
  if (!(w >= 1 && h >= 1 && w <= max && h <= max)) {
    await alertDialog("New", `Width and height must be between 1 and ${max} pixels.`);
    return null;
  }
  const c = (body.querySelector('input[name="contents"]:checked') as HTMLInputElement).value as NewDocOptions["contents"];
  lastNew = { w, h, contents: c };
  return { name: name.value.trim() || app.nextUntitledName(), width: w, height: h, contents: c };
}

/** PS7-style JPEG Options: quality 0-12. Returns 0..1, or null if cancelled. */
export async function jpegOptionsDialog(): Promise<number | null> {
  const q = el("input", { type: "range", min: 0, max: 12, step: 1, value: 10, style: "width:180px" });
  const n = el("input", { type: "number", min: 0, max: 12, value: 10 });
  const label = el("span", { text: "Maximum" });
  const name = (v: number) => (v <= 4 ? "Low" : v <= 7 ? "Medium" : v <= 9 ? "High" : "Maximum");
  const sync = (v: number) => {
    q.value = String(v);
    n.value = String(v);
    label.textContent = name(v);
  };
  q.addEventListener("input", () => sync(+q.value));
  n.addEventListener("input", () => sync(Math.max(0, Math.min(12, +n.value || 0))));
  sync(10);
  const body = el(
    "fieldset",
    {},
    el("legend", { text: "Image Options" }),
    el("div", { style: "display:flex;gap:8px;align-items:center" }, el("span", { text: "Quality:" }), n, label),
    el("div", { style: "display:flex;justify-content:space-between;margin-top:6px" }, el("small", { text: "small file" }), q, el("small", { text: "large file" })),
  );
  const r = await modal("JPEG Options", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  // Map 0..12 onto encoder quality 0.3..1.0.
  return r === "ok" ? 0.3 + (+q.value / 12) * 0.7 : null;
}

export async function shortcutsDialog(): Promise<void> {
  const rows: [string, string][] = [
    ["V  M  B  E  G  I  H  Z", "Move, Marquee, Brush, Eraser, Paint Bucket, Eyedropper, Hand, Zoom"],
    ["J  S  Y  O  R", "Healing / Spot Healing / Red Eye / Face Swap, Clone Stamp, History Brush, Dodge / Burn / Sponge, Blur / Sharpen / Smudge"],
    ["Shift+letter", "Cycle the tools that share a letter"],
    ["D / X", "Default colors / swap colors"],
    ["[  ]", "Brush size down / up (Shift: hardness)"],
    ["1 ... 0", "Brush opacity 10% ... 100%"],
    ["Space (hold)", "Hand tool"],
    ["Ctrl+Z", "Undo / Redo (toggle)"],
    ["Ctrl+Alt+Z / Ctrl+Shift+Z", "Step Backward / Step Forward"],
    ["Ctrl+N / Ctrl+O", "New / Open"],
    ["Ctrl+S / Ctrl+Shift+S", "Save / Save As (.cie keeps layers)"],
    ["Ctrl+Alt+Shift+S", "Save a Copy as PNG"],
    ["Ctrl+Alt+I / Ctrl+Alt+C", "Image Size / Canvas Size"],
    ["Ctrl+T", "Free Transform (Ctrl-drag a corner to distort)"],
    ["Ctrl+L / Ctrl+M / Ctrl+B", "Levels / Curves / Color Balance"],
    ["Ctrl+Shift+N", "New Layer"],
    ["Ctrl+J", "Layer via Copy"],
    ["Ctrl+E", "Merge Down"],
    ["Ctrl+A / Ctrl+D", "Select All / Deselect"],
    ["Ctrl+I / Ctrl+Shift+U", "Invert / Desaturate"],
    ["Alt+Backspace / Ctrl+Backspace", "Fill with foreground / background"],
    ["Shift+Backspace", "Content-Aware Fill the selection"],
    ["Alt-click (Clone Stamp, Healing)", "Set the source"],
    ["Delete", "Clear selection"],
    ["Ctrl+= / Ctrl+-", "Zoom in / out"],
    ["Ctrl+0 / Ctrl+Alt+0", "Fit on Screen / Actual Pixels"],
    ["Alt+wheel, pinch", "Zoom at cursor"],
    ["Arrows (Move tool)", "Nudge 1 px (Shift: 10 px)"],
    ["Tab", "Show / hide palettes"],
  ];
  const table = el("table", { class: "shortcut-table" });
  for (const [k, v] of rows) table.append(el("tr", {}, el("td", { text: k }), el("td", { text: v })));
  const note = el("p", {
    text: "In a browser some Ctrl shortcuts (New, Close) are reserved; the desktop app receives them all.",
    style: "color:var(--text-dim);margin-top:8px",
  });
  await modal("Keyboard Shortcuts", el("div", {}, table, note), [{ label: "OK", value: "ok", default: true }], true);
}

export async function aboutDialog(): Promise<void> {
  const body = el(
    "div",
    {},
    el("p", {}, el("b", { text: "Classic Image Editor" }), " 0.10.0 (Core editing, filters, Black & White Lab, Actions, layer masks, type, Liquify, people selection, face swap, layered .cie files, Free Transform, Levels & Curves, retouching tools, Content-Aware Fill, layer styles, multi-layer selection, shapes and paths, the full PS7 toolbox)"),
    el("p", {
      text: "A fast, offline image editor in the spirit of the classic early-2000s workflow, with a local AI assistant (via Ollama) on the way.",
    }),
    el("p", {
      text: "People selection, Face-Aware Liquify and Face Swap use Google's MediaPipe runtime and models (Apache License 2.0), downloaded once on first use and run on this computer.",
      style: "color:var(--text-dim)",
    }),
    el("p", {
      text: "Not affiliated with or endorsed by Adobe. All names, icons and artwork in this application are original.",
      style: "color:var(--text-dim)",
    }),
  );
  await modal("About Classic Image Editor", body, [{ label: "OK", value: "ok", default: true }]);
}

// ---------------------------------------------------------------- generic forms

export type Field =
  | { key: string; label: string; type: "text"; value: string }
  | { key: string; label: string; type: "number"; value: number; min?: number; max?: number; step?: number; suffix?: string }
  | { key: string; label: string; type: "select"; value: string; options: [string, string][] }
  | { key: string; label: string; type: "checkbox"; value: boolean }
  | { key: string; label: string; type: "color"; value: string }
  | { key: string; label: string; type: "heading" };

/** A simple PS7-style form dialog. Resolves with the values, or null if cancelled. */
export async function formDialog(title: string, fields: Field[], intro?: string): Promise<Record<string, any> | null> {
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const body = el("div", { class: "form" });
  if (intro) body.append(el("p", { text: intro }));
  for (const f of fields) {
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === "heading") {
      body.append(el("div", { class: "form-heading", text: f.label }));
      continue;
    }
    if (f.type === "color") {
      input = el("input", { type: "color", value: f.value, "aria-label": f.label });
      inputs.set(f.key, input);
      body.append(el("div", { class: "field-row" }, el("label", { text: f.label + ":" }), el("span", {}, input)));
      continue;
    }
    if (f.type === "select") {
      input = el("select", { "aria-label": f.label });
      for (const [v, l] of f.options) input.append(el("option", { value: v, text: l }));
      input.value = f.value;
    } else if (f.type === "checkbox") {
      input = el("input", { type: "checkbox", checked: f.value });
      body.append(el("label", { style: "display:flex;gap:6px;align-items:center" }, input, f.label));
      inputs.set(f.key, input);
      continue;
    } else if (f.type === "number") {
      input = el("input", { type: "number", value: f.value, min: f.min ?? "", max: f.max ?? "", step: f.step ?? "any", "aria-label": f.label });
    } else input = el("input", { type: "text", value: f.value, "aria-label": f.label });
    inputs.set(f.key, input);
    const suffix = f.type === "number" && f.suffix ? f.suffix : "";
    body.append(el("div", { class: "field-row" }, el("label", { text: f.label + ":" }), el("span", {}, input, suffix ? " " + suffix : "")));
  }
  const r = await modal(title, body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (r !== "ok") return null;
  const out: Record<string, any> = {};
  for (const f of fields) {
    if (f.type === "heading") continue;
    const i = inputs.get(f.key)!;
    if (f.type === "checkbox") out[f.key] = (i as HTMLInputElement).checked;
    else if (f.type === "number") {
      let v = parseFloat(i.value);
      if (!Number.isFinite(v)) v = f.value;
      if (f.min !== undefined) v = Math.max(f.min, v);
      if (f.max !== undefined) v = Math.min(f.max, v);
      out[f.key] = v;
    } else out[f.key] = i.value;
  }
  return out;
}
