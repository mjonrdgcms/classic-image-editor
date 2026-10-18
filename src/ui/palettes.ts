/**
 * Palette contents: Navigator, Info, Color, Swatches, History, Layers,
 * Brushes, Tool Presets, plus placeholders for later milestones. The
 * Workspace decides where each one lives.
 */

import { pathsPalette } from "./pathspalette";
import { samplerValues } from "../tools/moretools";
import { layerStyleDialog, stylesPalette } from "./styledialog";
import { FX_KEYS, hasEffects } from "../core/styles";
import type { App } from "../app";
import { ZOOM_STEPS } from "../app";
import { BLEND_GROUP_STARTS, BLEND_LABELS, BLEND_MODES } from "../core/blend";
import type { Group, Layer, MaskHost, Node } from "../core/document";
import type { Mask } from "../core/mask";
import type { Actions } from "./actions";
import { brushesPalette, toolPresetsPalette } from "./brushes";
import { confirmDialog, el, formDialog, modal } from "./dialogs";
import { ICONS } from "./icons";
import { showPopupMenu, type MenuItem } from "./menus";
import * as storage from "./storage";
import { hex } from "./toolbox";
import type { PaletteDef, PaletteParts } from "./workspace";
import { masksPalette } from "./maskui";
import type { TypeTool } from "../text/typetool";
import { characterPalette, paragraphPalette } from "../text/typeui";

/** Pick a new fill color for a shape layer. */
export async function shapeColorDialog(app: App, id: number): Promise<void> {
  const l = app.doc?.layerById(id);
  if (!l?.shape) return;
  const hex = "#" + l.shape.color.map((v) => v.toString(16).padStart(2, "0")).join("");
  const r = await formDialog("Shape Color", [{ key: "color", label: "Fill Color", type: "color", value: hex }]);
  if (!r) return;
  const c = String(r.color);
  app.run("layer.setShape", { id, color: [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) });
}

export function iconButton(icon: string, title: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = el("button", { class: "icon-btn", type: "button", title, "aria-label": title });
  b.innerHTML = ICONS[icon];
  if (onClick) b.addEventListener("click", onClick);
  else b.disabled = true;
  return b;
}

/** Coalesce bursts of updates into one per animation frame (or slower). */
function throttle(fn: () => void, ms = 0): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      fn();
    };
    if (ms) setTimeout(run, ms);
    else requestAnimationFrame(run);
  };
}

// ---------------------------------------------------------------- Navigator

function navigator(app: App): HTMLElement {
  const view = el("div", { class: "nav-view" });
  const cv = el("canvas");
  view.append(cv);
  const ctx = cv.getContext("2d")!;
  let thumb: { img: ImageData; x: number; y: number; scale: number } | null = null;

  const redrawThumb = throttle(() => {
    const doc = app.doc;
    const w = view.clientWidth;
    const h = view.clientHeight;
    if (!doc || !w) {
      thumb = null;
      draw();
      return;
    }
    const t = app.compositor.renderThumbnail(w - 8, h - 8);
    if (!t) return;
    thumb = {
      img: new ImageData(new Uint8ClampedArray(t.data.buffer as ArrayBuffer), t.w, t.h),
      x: Math.round((w - t.w) / 2),
      y: Math.round((h - t.h) / 2),
      scale: t.w / doc.width,
    };
    draw();
  }, 250);

  const draw = () => {
    const w = view.clientWidth;
    const h = view.clientHeight;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (!thumb || !app.doc) return;
    ctx.putImageData(thumb.img, thumb.x, thumb.y);
    // The red view box: what the document window currently shows.
    const tl = app.toCanvas(0, 0);
    const br = app.toCanvas(app.viewport.clientWidth, app.viewport.clientHeight);
    const x0 = Math.max(0, tl.x);
    const y0 = Math.max(0, tl.y);
    const x1 = Math.min(app.doc.width, br.x);
    const y1 = Math.min(app.doc.height, br.y);
    ctx.strokeStyle = "#e00000";
    ctx.lineWidth = 2;
    ctx.strokeRect(thumb.x + x0 * thumb.scale, thumb.y + y0 * thumb.scale, (x1 - x0) * thumb.scale, (y1 - y0) * thumb.scale);
  };

  // Click or drag in the Navigator to scroll the view there.
  const jump = (e: PointerEvent) => {
    if (!thumb || !app.doc) return;
    const r = view.getBoundingClientRect();
    const cx = (e.clientX - r.left - thumb.x) / thumb.scale;
    const cy = (e.clientY - r.top - thumb.y) / thumb.scale;
    const v = app.compositor.view;
    app.panBy(app.viewport.clientWidth / 2 - (cx * v.zoom + v.x), app.viewport.clientHeight / 2 - (cy * v.zoom + v.y));
  };
  view.addEventListener("pointerdown", (e) => {
    view.setPointerCapture(e.pointerId);
    jump(e);
  });
  view.addEventListener("pointermove", (e) => {
    if (e.buttons & 1) jump(e);
  });

  // Zoom slider on a log scale over PS7's range, plus a percent field.
  const lo = Math.log(ZOOM_STEPS[0]);
  const hi = Math.log(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
  const slider = el("input", { type: "range", min: 0, max: 1000, value: 500, "aria-label": "Zoom" });
  const field = el("input", { type: "number", min: 1, max: 1600, value: 100, "aria-label": "Zoom percent" });
  slider.addEventListener("input", () => app.setZoom(Math.exp(lo + ((hi - lo) * +slider.value) / 1000)));
  field.addEventListener("change", () => app.setZoom(+field.value / 100));
  const zin = el("button", { class: "icon-btn", type: "button", title: "Zoom In" }, "▲");
  const zout = el("button", { class: "icon-btn", type: "button", title: "Zoom Out" }, "▼");
  zin.addEventListener("click", () => app.zoomStep(1));
  zout.addEventListener("click", () => app.zoomStep(-1));
  const syncZoom = () => {
    const z = app.compositor.view.zoom;
    slider.value = String(Math.round(((Math.log(z) - lo) / (hi - lo)) * 1000));
    if (document.activeElement !== field) field.value = String(+(z * 100).toFixed(2));
    draw();
  };
  app.on("view", syncZoom);
  app.on("doc", redrawThumb);
  app.on("theme", redrawThumb);
  app.on("composite", redrawThumb);
  app.on("sessions", redrawThumb);
  new ResizeObserver(redrawThumb).observe(view);
  return el("div", {}, view, el("div", { class: "nav-zoom" }, field, "%", zout, slider, zin));
}

// ---------------------------------------------------------------- Info

function info(app: App): HTMLElement {
  const v = (id: string) => el("span", { class: "v", "data-k": id, text: "" });
  const R = v("r"), G = v("g"), B = v("b"), A = v("a"), X = v("x"), Y = v("y"), W = v("w"), H = v("h");
  const k = (t: string) => el("span", { class: "k", text: t });
  const grid = el(
    "div",
    { class: "info-grid" },
    k("R:"), R, k("X:"), X,
    k("G:"), G, k("Y:"), Y,
    k("B:"), B, el("span"), el("span"),
    k("A:"), A, el("span"), el("span"),
    el("div", { class: "rule" }),
    k("W:"), W, k("H:"), H,
  );
  const samplers = el("div", { class: "info-samplers" });
  const update = throttle(() => {
    const doc = app.doc;
    const p = app.pointer;
    const inside = !!doc && !!p && p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
    if (inside) {
      const px = app.compositor.readPixels({ x: Math.floor(p!.x), y: Math.floor(p!.y), w: 1, h: 1 });
      R.textContent = String(px[0]);
      G.textContent = String(px[1]);
      B.textContent = String(px[2]);
      A.textContent = Math.round((px[3] / 255) * 100) + "%";
      X.textContent = String(Math.floor(p!.x));
      Y.textContent = String(Math.floor(p!.y));
    } else {
      for (const n of [R, G, B, A, X, Y]) n.textContent = "";
    }
    const r = app.preview.rect ?? app.preview.crop ?? doc?.selection?.bounds() ?? null;
    W.textContent = r ? String(Math.round(r.w)) : "";
    H.textContent = r ? String(Math.round(r.h)) : "";
    // Color Sampler readouts.
    samplers.textContent = "";
    for (const sv of samplerValues(app))
      samplers.append(el("div", { class: "info-sampler" }, el("span", { class: "k", text: `#${sv.i + 1}` }), el("span", { class: "v", text: `R ${sv.rgb[0]}  G ${sv.rgb[1]}  B ${sv.rgb[2]}` }), el("span", { class: "sw", style: `background:rgb(${sv.rgb.join(",")})` })));
  });
  app.on("pointer", update);
  app.on("doc", update);
  app.on("overlay", update);
  return el("div", {}, grid, samplers);
}

// ---------------------------------------------------------------- Color

function color(app: App): HTMLElement {
  let editing: "foreground" | "background" = "foreground";
  const fg = el("div", { class: "chip fg", title: "Edit foreground color" });
  const bg = el("div", { class: "chip bg", title: "Edit background color" });
  fg.addEventListener("click", () => {
    editing = "foreground";
    sync();
  });
  bg.addEventListener("click", () => {
    editing = "background";
    sync();
  });
  const hexField = el("input", { type: "text", value: "#000000", style: "width:66px", "aria-label": "Hex color" });
  const rows = (["R", "G", "B"] as const).map((ch, i) => {
    const r = el("input", { type: "range", min: 0, max: 255, value: 0, "aria-label": ch });
    const n = el("input", { type: "number", min: 0, max: 255, value: 0, "aria-label": ch + " value" });
    const track = el("div", { class: "track" });
    const set = (val: number) => {
      const c = current();
      c[i] = Math.max(0, Math.min(255, Math.round(val || 0)));
      app.run("color.set", { which: editing, r: c[0], g: c[1], b: c[2] });
    };
    r.addEventListener("input", () => set(+r.value));
    n.addEventListener("change", () => set(+n.value));
    return { ch, r, n, track, row: el("div", { class: "color-row" }, el("span", { text: ch }), r, n) };
  });
  hexField.addEventListener("change", () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hexField.value.trim());
    if (!m) return sync();
    const v = parseInt(m[1], 16);
    app.run("color.set", { which: editing, r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 });
  });
  const current = (): number[] => {
    const d = app.doc;
    const c = d ? (editing === "foreground" ? d.foreground : d.background) : [0, 0, 0, 255];
    return [c[0], c[1], c[2]];
  };
  const sync = () => {
    const d = app.doc;
    fg.style.background = d ? hex(d.foreground) : "#000";
    bg.style.background = d ? hex(d.background) : "#fff";
    fg.classList.toggle("editing", editing === "foreground");
    bg.classList.toggle("editing", editing === "background");
    const c = current();
    rows.forEach(({ r, n }, i) => {
      r.value = String(c[i]);
      if (document.activeElement !== n) n.value = String(c[i]);
      // Gradient track showing where this channel goes.
      const lo = [...c];
      const hiC = [...c];
      lo[i] = 0;
      hiC[i] = 255;
      r.style.background = `linear-gradient(90deg, ${hex(lo)}, ${hex(hiC)})`;
    });
    if (document.activeElement !== hexField) hexField.value = hex(c);
  };
  app.on("settings", sync);
  app.on("doc", sync);
  sync();
  return el(
    "div",
    {},
    el("div", { class: "color-head" }, el("div", { class: "chips" }, fg, bg), hexField),
    ...rows.map((r) => r.row),
  );
}

function swatches(app: App): HTMLElement {
  const grid = el("div", { class: "swatch-grid" });
  const colors: string[] = [];
  // Primaries and secondaries, then grays, then a hue x lightness ramp.
  colors.push("#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#ffffff");
  for (let i = 0; i <= 10; i++) {
    const v = Math.round(255 - (255 * i) / 10).toString(16).padStart(2, "0");
    colors.push(`#${v}${v}${v}`);
  }
  for (const l of [80, 65, 50, 35, 22]) for (let h = 0; h < 360; h += 30) colors.push(`hsl(${h} 90% ${l}%)`);
  colors.push("#c69c6d", "#a67c52", "#8c6239", "#754c24", "#603913", "#f5deb3", "#ffe4c4");
  for (const c of colors) {
    const b = el("button", { type: "button", title: "Click: foreground. Ctrl-click: background.", style: `background:${c}` });
    b.addEventListener("click", (e) => {
      const rgb = getComputedStyle(b).backgroundColor.match(/\d+/g)!.map(Number);
      app.run("color.set", { which: e.ctrlKey || e.metaKey || e.altKey ? "background" : "foreground", r: rgb[0], g: rgb[1], b: rgb[2] });
    });
    grid.append(b);
  }
  return grid;
}

// ---------------------------------------------------------------- History

function history(app: App, actions: Actions): PaletteParts {
  const list = el("div", { class: "history-list", role: "listbox", "aria-label": "History states" });
  const render = throttle(() => {
    const h = app.bus.history;
    list.textContent = "";
    if (!app.doc) return;
    h.snapshots.forEach((s, i) => {
      const row = el("div", { class: "history-row snapshot", role: "option", title: "Click to return to this snapshot" }, el("span", { class: "snap-icon" }), el("span", { text: s.label }));
      row.addEventListener("click", () => h.restoreSnapshot(i));
      row.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        if (await confirmDialog("Delete Snapshot", `Delete "${s.label}"?`, "Delete")) h.deleteSnapshot(i);
      });
      list.append(row);
    });
    if (h.snapshots.length) list.append(el("div", { class: "history-sep" }));
    h.states.forEach((s, i) => {
      const row = el(
        "div",
        { class: "history-row" + (i === h.index ? " current" : i > h.index ? " future" : ""), role: "option", "aria-selected": i === h.index },
        el("span", { class: "dot" }),
        el("span", { text: s.label }),
      );
      row.addEventListener("click", () => h.jump(i));
      list.append(row);
    });
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  });
  app.on("doc", render);
  const footer = el(
    "div",
    { style: "display:contents" },
    iconButton("newLayer", "Create new snapshot", () => app.hasDoc && app.bus.history.addSnapshot()),
    iconButton("trash", "Step Backward", () => app.hasDoc && app.bus.history.undo()),
  );
  const menu = (): MenuItem[] => [
    actions.stepForward,
    actions.stepBackward,
    "-",
    { label: "New Snapshot...", enabled: app.hasDoc, run: async () => {
      const r = await formDialog("New Snapshot", [{ key: "name", label: "Name", type: "text", value: `Snapshot ${app.bus.history.snapshots.length + 1}` }]);
      if (r) app.bus.history.addSnapshot(r.name || undefined);
    } },
    { label: "Clear History", enabled: app.hasDoc && app.bus.history.states.length > 1, run: () => app.bus.history.clear() },
  ];
  return { body: list, footer, menu };
}

// ---------------------------------------------------------------- Layers

type ThumbSize = 0 | 20 | 32 | 48;

function drawThumb(cv: HTMLCanvasElement, size: number, docW: number, docH: number, sample: (x: number, y: number) => [number, number, number, number], checker: boolean): void {
  const s = Math.min(size / docW, size / docH);
  const w = Math.max(1, Math.round(docW * s));
  const h = Math.max(1, Math.round(docH * s));
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d")!;
  ctx.clearRect(0, 0, size, size);
  const ox = Math.round((size - w) / 2), oy = Math.round((size - h) / 2);
  if (checker)
    for (let y = 0; y < h; y += 4)
      for (let x = 0; x < w; x += 4) {
        ctx.fillStyle = ((x + y) / 4) % 2 ? "#ccc" : "#fff";
        ctx.fillRect(ox + x, oy + y, Math.min(4, w - x), Math.min(4, h - y));
      }
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) img.data.set(sample(Math.floor((x + 0.5) / s), Math.floor((y + 0.5) / s)), (y * w + x) * 4);
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.drawImage(tmp, ox, oy);
}

function layers(app: App, actions: Actions): PaletteParts {
  let thumbSize = storage.load<ThumbSize>("layersThumb", 32);
  const mode = el("select", { "aria-label": "Blend mode" });
  const passOpt = el("option", { value: "passThrough", text: "Pass Through" });
  mode.append(passOpt);
  BLEND_MODES.forEach((m) => {
    if (BLEND_GROUP_STARTS.has(m)) mode.append(el("option", { disabled: true, text: "────────" }));
    mode.append(el("option", { value: m, text: BLEND_LABELS[m] }));
  });
  const opacity = el("input", { type: "number", min: 0, max: 100, value: 100, "aria-label": "Opacity" });
  mode.addEventListener("change", () => app.run("layer.setProperties", { blendMode: mode.value }));
  opacity.addEventListener("change", () => app.run("layer.setProperties", { opacity: Math.max(0, Math.min(100, Math.round(+opacity.value))) }));
  const head = el("div", { class: "layer-head" }, mode, el("label", {}, "Opacity:"), opacity, "%");

  const lockBtn = (icon: string, title: string, key: "transparency" | "pixels" | "position" | "all") => {
    const b = el("button", { type: "button", class: "lock-btn", title, "aria-label": title, "aria-pressed": "false" });
    b.innerHTML = ICONS[icon];
    b.addEventListener("click", () => {
      const l = app.doc?.activeLayer;
      if (!l) return;
      const on = key === "all" ? !(l.locks.transparency && l.locks.pixels && l.locks.position) : !l.locks[key];
      app.run("layer.setLocks", { [key]: on });
    });
    return b;
  };
  const locks = {
    transparency: lockBtn("lockTransparency", "Lock transparent pixels", "transparency"),
    pixels: lockBtn("lockPixels", "Lock image pixels", "pixels"),
    position: lockBtn("lockPosition", "Lock position", "position"),
    all: lockBtn("lockAll", "Lock all", "all"),
  };
  const lockRow = el(
    "div",
    { class: "layer-lock" },
    "Lock:",
    locks.transparency,
    locks.pixels,
    locks.position,
    locks.all,
    el("span", { style: "flex:1" }),
    el("span", { class: "fill-label", title: "Fill opacity arrives with layer styles (M4)", text: "Fill: 100%" }),
  );
  const list = el("div", { class: "layer-list", role: "listbox", "aria-label": "Layers" });

  const layerThumb = (l: Layer): HTMLElement => {
    const doc = app.doc!;
    if (l.text) {
      // Type layers show a "T", as in PS; double-click edits the text.
      const t = el("div", { class: "thumb type-thumb", title: `Type layer (${l.text.font}). Double-click to edit the text.`, text: "T" });
      t.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        app.setTool("type");
        (app.tools.type as TypeTool).editLayer(l.id);
      });
      return t;
    }
    const cv = el("canvas", { class: "thumb", title: "Click to edit the layer's pixels" });
    if (thumbSize) drawThumb(cv, thumbSize, doc.width, doc.height, (x, y) => l.grid.getPixel(x - l.offsetX, y - l.offsetY), true);
    return cv;
  };
  const maskThumb = (l: MaskHost, m: Mask) => {
    const doc = app.doc!;
    const cv = el("canvas", {
      class: "thumb mask-thumb" + (l.maskEnabled ? "" : " disabled"),
      title: "Click to edit the mask. Shift-click: turn off. Alt-click: view the mask. Alt+Shift-click: overlay. Ctrl-click: load as selection. Drag to the trash to remove, or onto another layer to move it (Alt: copy).",
    });
    if (thumbSize)
      drawThumb(cv, thumbSize, doc.width, doc.height, (x, y) => {
        const lx = x - l.offsetX, ly = y - l.offsetY;
        const v = lx >= 0 && ly >= 0 && lx < m.width && ly < m.height ? m.get(lx, ly) : m.defaultValue;
        return [v, v, v, 255];
      }, false);
    return cv;
  };

  // ---------- drag to reorder ----------
  type Drop = { id: number; zone: "above" | "below" | "into" } | { trash: true } | { duplicate: true } | null;
  let drag: { id: number; sx: number; sy: number; started: boolean; ghost?: HTMLElement; drop: Drop } | null = null;
  const clearMarks = () => list.querySelectorAll(".drop-above, .drop-below, .drop-into").forEach((n) => n.classList.remove("drop-above", "drop-below", "drop-into"));
  const dropAt = (x: number, y: number): Drop => {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    if (under?.closest("[data-drop=trash]")) return { trash: true };
    if (under?.closest("[data-drop=new]")) return { duplicate: true };
    const row = under?.closest(".layer-row") as HTMLElement | null;
    if (!row || !list.contains(row)) return null;
    const r = row.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    const isSet = row.dataset.kind === "group";
    return { id: +row.dataset.id!, zone: isSet ? (f < 0.25 ? "above" : f > 0.75 ? "below" : "into") : f < 0.5 ? "above" : "below" };
  };
  const applyDrop = (id: number, d: Drop) => {
    const doc = app.doc!;
    if (!d) return;
    if ("trash" in d) return void app.run("layer.delete", { id });
    if ("duplicate" in d) {
      const n = doc.nodeById(id);
      if (n?.kind === "layer") app.run("layer.duplicate", { id });
      return;
    }
    if (d.id === id) return;
    const moving = doc.nodeById(id)!;
    const target = doc.nodeById(d.id)!;
    const tAt = doc.locate(target.id)!;
    let parent: Group | null;
    let index: number;
    if (target.kind === "group" && d.zone === "into") {
      if (moving.kind === "group") return app.toast("Layer sets can't be nested.");
      parent = target;
      index = target.children.length;
    } else if (target.kind === "group" && d.zone === "below" && target.expanded && moving.kind === "layer") {
      parent = target;
      index = target.children.length;
    } else {
      parent = tAt.group;
      index = d.zone === "above" ? tAt.index + 1 : tAt.index;
      if (moving.kind === "group" && parent) {
        // A set dropped among a set's layers lands next to that set.
        const gi = doc.stack.indexOf(parent);
        index = d.zone === "above" ? gi + 1 : gi;
        parent = null;
      }
    }
    const from = doc.locate(id)!;
    if (from.group === parent && from.index < index) index--;
    app.run("layer.reorder", { id, index, parent: parent ? parent.id : 0 });
  };
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
      drag.started = true;
      const n = app.doc?.nodeById(drag.id);
      drag.ghost = el("div", { class: "tab-ghost", text: n?.name ?? "" });
      document.body.append(drag.ghost);
    }
    drag.ghost!.style.left = e.clientX + 10 + "px";
    drag.ghost!.style.top = e.clientY + 6 + "px";
    drag.ghost!.style.display = "none";
    drag.drop = dropAt(e.clientX, e.clientY);
    drag.ghost!.style.display = "";
    clearMarks();
    const d = drag.drop;
    if (d && "id" in d) list.querySelector(`.layer-row[data-id="${d.id}"]`)?.classList.add("drop-" + d.zone);
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearMarks();
    d.ghost?.remove();
    if (d.started) applyDrop(d.id, d.drop);
  });

  // ---------- masks ----------
  /** Ctrl-click: replace; +Shift add; +Alt subtract; +Shift+Alt intersect. */
  const selMode = (e: MouseEvent) => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");

  /** Remove a mask, asking whether to apply it first (as PS7 does). */
  const removeMaskAsk = async (n: Node) => {
    if (!n.mask) return;
    if (n.kind === "group") {
      const r = await modal("Delete Layer Mask", el("p", { text: `Delete the mask of the set "${n.name}"?` }), [
        { label: "Delete", value: "delete", default: true },
        { label: "Cancel", value: "cancel" },
      ]);
      if (r === "delete") app.run("layer.removeMask", { id: n.id, apply: false });
      return;
    }
    const r = await modal("Remove Layer Mask", el("p", { text: `Apply the mask to "${n.name}" before removing it?` }), [
      { label: "Apply", value: "apply", default: true },
      { label: "Discard", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ]);
    if (r === "apply" || r === "discard") app.run("layer.removeMask", { id: n.id, apply: r === "apply" });
  };

  let maskDrag: { id: number; sx: number; sy: number; started: boolean; ghost?: HTMLElement; alt: boolean } | null = null;
  document.addEventListener("pointermove", (e) => {
    if (!maskDrag) return;
    if (!maskDrag.started) {
      if (Math.hypot(e.clientX - maskDrag.sx, e.clientY - maskDrag.sy) < 5) return;
      maskDrag.started = true;
      maskDrag.ghost = el("div", { class: "tab-ghost", text: "Layer Mask" });
      document.body.append(maskDrag.ghost);
    }
    maskDrag.alt = e.altKey;
    maskDrag.ghost!.textContent = e.altKey ? "Copy Layer Mask" : "Layer Mask";
    maskDrag.ghost!.style.left = e.clientX + 10 + "px";
    maskDrag.ghost!.style.top = e.clientY + 6 + "px";
    clearMarks();
    maskDrag.ghost!.style.display = "none";
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    maskDrag.ghost!.style.display = "";
    const row = under?.closest(".layer-row") as HTMLElement | null;
    if (row && +row.dataset.id! !== maskDrag.id) row.classList.add("drop-into");
  });
  document.addEventListener("pointerup", (e) => {
    const d = maskDrag;
    maskDrag = null;
    if (!d) return;
    clearMarks();
    d.ghost?.remove();
    if (!d.started) return;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const doc = app.doc;
    if (!doc) return;
    if (under?.closest("[data-drop=trash]")) return void removeMaskAsk(doc.nodeById(d.id)!);
    const row = under?.closest(".layer-row") as HTMLElement | null;
    const to = row ? +row.dataset.id! : 0;
    if (!to || to === d.id) return;
    app.run("layer.moveMask", { from: d.id, to, copy: d.alt || e.altKey });
  });

  /** The chain icon and mask thumbnail for a layer or set. */
  const maskWidgets = (n: Node, active: boolean): HTMLElement[] => {
    const doc = app.doc!;
    const chain = el("button", {
      type: "button",
      class: "mask-link" + (n.maskLinked ? "" : " unlinked"),
      title: n.maskLinked ? "The mask moves with the layer. Click to unlink." : "The mask stays put when the layer moves. Click to link.",
      "aria-pressed": n.maskLinked,
    });
    chain.innerHTML = n.maskLinked ? ICONS.link : "";
    chain.addEventListener("click", (e) => {
      e.stopPropagation();
      app.run("layer.setMaskProperties", { id: n.id, linked: !n.maskLinked });
    });
    const m = maskThumb(n, n.mask!);
    if (doc.editMask && active) m.classList.add("target");
    if (active && app.maskView !== "off") m.classList.add(app.maskView === "gray" ? "viewing" : "overlaying");
    const select = () => {
      if (n.id !== doc.activeLayerId) app.run("layer.select", { id: n.id });
      if (!doc.editMask) app.run("layer.editMask", { edit: true });
    };
    m.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      maskDrag = { id: n.id, sx: e.clientX, sy: e.clientY, started: false, alt: e.altKey };
    });
    m.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) return void app.run("select.fromMask", { id: n.id, mode: selMode(e) });
      if (e.shiftKey && !e.altKey) return void app.run("layer.setMaskEnabled", { id: n.id, enabled: !n.maskEnabled });
      select();
      if (e.altKey) {
        const want = e.shiftKey ? "overlay" : "gray";
        app.setMaskView(app.maskView === want ? "off" : want);
      }
    });
    m.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      select();
      actions.showMasks.run();
    });
    const badge = thumbSize ? m : el("span", { class: "mask-badge", text: "mask" });
    if (!thumbSize) badge.addEventListener("click", (e) => (e.stopPropagation(), select()));
    return [chain, badge];
  };

  // ---------- rows ----------
  const rowFor = (n: Node, indent: boolean) => {
    const doc = app.doc!;
    const active = n.id === doc.activeLayerId;
    const vis = el("div", { class: "vis", title: "Show/hide (Alt-click: show only this)" });
    vis.innerHTML = n.visible ? ICONS.eye : "";
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.altKey) {
        // Alt-click: show only this one, or show everything again.
        const others = doc.layers.filter((l) => l.id !== n.id);
        const solo = others.some((l) => l.visible);
        app.bus.group(solo ? "Show Only" : "Show All", () => {
          for (const l of others) if (l.visible === solo) app.bus.dispatch("layer.setProperties", { id: l.id, visible: !solo });
          if (!n.visible) app.bus.dispatch("layer.setProperties", { id: n.id, visible: true });
        });
      } else app.run("layer.setProperties", { id: n.id, visible: !n.visible });
    });
    const mark = el("div", { class: "mark" });
    const al = doc.activeLayer;
    if (active && n.kind === "layer") mark.innerHTML = doc.editMask && n.mask ? ICONS.maskEdit : ICONS.brush;
    else if (active && n.kind === "group" && doc.editMask && n.mask) mark.innerHTML = ICONS.maskEdit;
    else if (n.kind === "layer" && al && n.linkId !== null && n.linkId === al.linkId) mark.innerHTML = ICONS.link;
    if (n.kind === "layer" && !active) {
      mark.title = "Click to link with the active layer";
      mark.addEventListener("click", (e) => {
        e.stopPropagation();
        const a = doc.activeLayer;
        if (!a) return;
        const linked = n.linkId !== null && n.linkId === a.linkId;
        app.run("layer.link", { ids: linked ? [n.id] : [a.id, n.id], linked: !linked });
      });
    }
    const content = el("div", { class: "content" });
    if (n.kind === "group") {
      const tri = el("button", { type: "button", class: "set-toggle", "aria-label": n.expanded ? "Collapse set" : "Expand set" });
      tri.innerHTML = n.expanded ? ICONS.setOpen : ICONS.setClosed;
      tri.addEventListener("click", (e) => {
        e.stopPropagation();
        // Disclosure is view state, not an edit: no History entry.
        n.expanded = !n.expanded;
        render();
      });
      const folder = el("span", { class: "set-icon" });
      folder.innerHTML = ICONS.folder;
      content.append(tri, folder);
      if (n.mask) content.append(...maskWidgets(n, active));
    } else {
      if (n.clipped && doc.clipBase(n)) {
        const c = el("span", { class: "clip-arrow", title: "Clipped to the layer below" });
        c.innerHTML = ICONS.clipArrow;
        content.append(c);
      }
      const t = layerThumb(n);
      if (n.mask && !doc.editMask && active) t.classList.add("target");
      if (!n.mask && active) t.classList.add("target");
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) return void app.run("select.fromTransparency", { id: n.id, mode: selMode(e) });
        if (e.shiftKey) return void app.run("layer.select", { id: n.id, mode: "range" });
        if (n.id !== doc.activeLayerId || doc.selectedIds.size) app.run("layer.select", { id: n.id });
        if (doc.editMask) app.run("layer.editMask", { edit: false });
      });
      t.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (n.shape) void shapeColorDialog(app, n.id);
        else if (!n.isBackground && !n.text) void layerStyleDialog(app);
      });
      if (thumbSize) content.append(t);
      if (n.mask) content.append(...maskWidgets(n, active));
    }
    const base = n.kind === "layer" && doc.layers.some((x) => x.clipped && doc.clipBase(x) === n);
    const name = el("div", { class: "name" + (n.kind === "layer" && n.isBackground ? " bg" : "") + (base ? " clip-base" : ""), text: n.name });
    const lockIcons = n.kind === "layer" && (n.locks.transparency || n.locks.pixels || n.locks.position) ? el("span", { class: "lock-ind", title: "Locked" }) : null;
    if (lockIcons) lockIcons.innerHTML = ICONS.lockAll;
    content.append(name);
    if (lockIcons) content.append(lockIcons);
    if (n.kind === "layer" && n.style && hasEffects(n.style)) {
      const fx = el("button", { type: "button", class: "fx-badge", title: "Layer effects: double-click to edit", text: "fx" });
      fx.addEventListener("click", (e) => e.stopPropagation());
      fx.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        if (n.id !== doc.activeLayerId) app.run("layer.select", { id: n.id });
        void layerStyleDialog(app);
      });
      content.append(fx);
    }
    const row = el(
      "div",
      {
        class: "layer-row" + (active ? " active" : doc.selectedIds.has(n.id) ? " selected" : "") + (n.visible ? "" : " hidden-layer") + (indent ? " in-set" : "") + (n.kind === "group" ? " set-row" : ""),
        role: "option",
        "aria-selected": active,
        "data-id": n.id,
        "data-kind": n.kind,
        style: `--thumb:${thumbSize || 16}px`,
      },
      vis,
      mark,
      content,
    );
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("input, .vis, .mark, .set-toggle")) return;
      if (n.kind === "layer" && n.isBackground) return;
      drag = { id: n.id, sx: e.clientX, sy: e.clientY, started: false, drop: null };
    });
    row.addEventListener("click", (e) => {
      if (e.altKey && n.kind === "layer") {
        // Alt-click: toggle clipping with the layer below (PS7's Alt-click on the border).
        return void app.run("layer.clip", { id: n.id, clipped: !n.clipped });
      }
      // Ctrl-click adds or removes a layer from the selection; Shift-click selects a range.
      if (e.ctrlKey || e.metaKey) return void app.run("layer.select", { id: n.id, mode: "toggle" });
      if (e.shiftKey) return void app.run("layer.select", { id: n.id, mode: "range" });
      if (n.id !== doc.activeLayerId || doc.selectedIds.size) app.run("layer.select", { id: n.id });
    });
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (n.kind === "layer" && n.isBackground) return void app.run("layer.fromBackground");
      const input = el("input", { type: "text", value: n.name });
      name.replaceChildren(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit: boolean) => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (commit && v && v !== n.name) app.run("layer.setProperties", { id: n.id, name: v });
        else render();
      };
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
    });
    return row;
  };

  const render = () => {
    const doc = app.doc;
    list.textContent = "";
    mode.disabled = opacity.disabled = !doc;
    Object.values(locks).forEach((b) => (b.disabled = !doc?.activeLayer || !!doc.activeLayer.isBackground));
    if (!doc) return;
    const n = doc.activeNode;
    passOpt.hidden = n?.kind !== "group";
    mode.value = n ? n.blendMode : "normal";
    if (document.activeElement !== opacity) opacity.value = String(Math.round((n?.opacity ?? 1) * 100));
    const bg = n?.kind === "layer" && n.isBackground;
    mode.disabled = opacity.disabled = !n || bg;
    const al = doc.activeLayer;
    const L = al?.locks;
    const set = (b: HTMLButtonElement, on: boolean) => {
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    };
    set(locks.transparency, !!L?.transparency);
    set(locks.pixels, !!L?.pixels);
    set(locks.position, !!L?.position);
    set(locks.all, !!L && L.transparency && L.pixels && L.position);
    for (let i = doc.stack.length - 1; i >= 0; i--) {
      const node = doc.stack[i];
      list.append(rowFor(node, false));
      if (node.kind === "group" && node.expanded) for (let j = node.children.length - 1; j >= 0; j--) list.append(rowFor(node.children[j], true));
    }
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  const refreshThumbs = throttle(() => {
    if (!app.doc || !thumbSize) return;
    render();
  }, 400);
  let unsub: (() => void) | null = null;
  const renderSoon = throttle(render);
  app.on("doc", () => {
    renderSoon();
    unsub?.();
    unsub = app.doc?.on((ev) => (ev.type === "pixels" ? refreshThumbs() : ev.type === "layers" ? renderSoon() : undefined)) ?? null;
  });
  render();

  const maskBtn = iconButton("mask", "Add layer mask (Alt-click: hide all / hide selection)", (e) => {
    const doc = app.doc;
    if (!doc) return;
    const hasSel = !!doc.selection;
    app.run("layer.addMask", { reveal: e.altKey ? (hasSel ? "hideSelection" : "none") : hasSel ? "selection" : "all" });
  });
  const trash = iconButton("trash", "Delete layer (or drag a layer or mask here)", async () => {
    const n = app.doc?.activeNode;
    if (!n) return;
    if (app.doc!.editMask && n.mask) return void removeMaskAsk(n);
    if (n.kind === "group" && n.children.length) {
      const r = await modal("Delete Layer Set", el("p", { text: `Delete the layer set "${n.name}" and its contents, or just the set?` }), [
        { label: "Set and Contents", value: "all", default: true },
        { label: "Set Only", value: "set" },
        { label: "Cancel", value: "cancel" },
      ]);
      if (r === "all" || r === "set") app.run("layer.delete", { contents: r === "all" });
      return;
    }
    app.run("layer.delete");
  });
  trash.dataset.drop = "trash";
  const fxBtn = iconButton("fx", "Add a layer style", () => {
    const r = fxBtn.getBoundingClientRect();
    showPopupMenu([actions.styleBlending, "-", ...FX_KEYS.map((k) => actions[`style_${k}`])], r.left, r.top - 8);
  });
  const newBtn = iconButton("newLayer", "Create a new layer (drag a layer here to duplicate it)", () => app.run("layer.new"));
  newBtn.dataset.drop = "new";
  const footer = el(
    "div",
    { style: "display:contents" },
    fxBtn,
    maskBtn,
    iconButton("folder", "Create a new set", () => app.run("layer.newSet")),
    iconButton("adjust", "Create new fill or adjustment layer (planned for M3)"),
    newBtn,
    trash,
  );
  const menu = (): MenuItem[] => [
    actions.newLayer,
    actions.duplicateLayer,
    actions.deleteLayer,
    "-",
    actions.newSet,
    actions.newSetFromLinked,
    "-",
    actions.layerProperties,
    "-",
    actions.mergeDown,
    actions.mergeVisible,
    actions.flatten,
    "-",
    {
      label: "Palette Options...",
      run: async () => {
        const r = await formDialog("Layers Palette Options", [
          { key: "size", label: "Thumbnail Size", type: "select", value: String(thumbSize), options: [["0", "None"], ["20", "Small"], ["32", "Medium"], ["48", "Large"]] },
        ]);
        if (!r) return;
        thumbSize = +r.size as ThumbSize;
        storage.save("layersThumb", thumbSize);
        render();
      },
    },
  ];
  return { body: el("div", { class: "layers-body" }, head, lockRow, list), footer, menu };
}

// ---------------------------------------------------------------- registry

export function paletteDefs(app: App, actions: Actions, extra: { actions: () => { body: HTMLElement; footer?: HTMLElement; menu?: () => MenuItem[] } }): PaletteDef[] {
  return [
    { id: "navigator", title: "Navigator", build: () => ({ body: navigator(app) }) },
    { id: "info", title: "Info", build: () => ({ body: info(app) }) },
    { id: "color", title: "Color", build: () => ({ body: color(app) }) },
    { id: "swatches", title: "Swatches", build: () => ({ body: swatches(app) }) },
    { id: "styles", title: "Styles", build: () => ({ body: stylesPalette(app) }) },
    { id: "history", title: "History", grow: true, build: () => history(app, actions) },
    { id: "actions", title: "Actions", grow: true, width: 280, build: extra.actions },
    { id: "layers", title: "Layers", grow: true, build: () => layers(app, actions) },
    { id: "masks", title: "Masks", build: () => masksPalette(app, () => void actions.maskEdge.run(), () => void actions.maskOptions.run()) },
    { id: "channels", title: "Channels", soon: "1.x", build: () => ({ body: el("div") }) },
    { id: "paths", title: "Paths", build: () => pathsPalette(app) },
    { id: "brushes", title: "Brushes", width: 470, build: () => brushesPalette(app) },
    { id: "toolPresets", title: "Tool Presets", width: 240, build: () => toolPresetsPalette(app) },
    { id: "character", title: "Character", width: 260, build: () => characterPalette(app) },
    { id: "paragraph", title: "Paragraph", width: 260, build: () => paragraphPalette(app) },
  ];
}
