/**
 * The Brushes palette (PS7 layout): Brush Presets, Brush Tip Shape and the
 * dynamics sections on the left, settings on the right, and a live stroke
 * preview at the bottom. It edits the brush of the active painting tool.
 */

import type { App, BrushToolId } from "../app";
import {
  BrushPreset,
  DEFAULT_COLOR,
  DEFAULT_OTHER,
  DEFAULT_SCATTER,
  DEFAULT_SHAPE,
  defaultBrushes,
  presetFromJSON,
  presetToJSON,
} from "../core/brushes";
import { dabThumb, strokeThumb } from "./brushpreview";
import { confirmDialog, el, formDialog } from "./dialogs";
import type { MenuItem } from "./menus";
import type { PaletteParts } from "./workspace";

type Section = "presets" | "tip" | "shape" | "scatter" | "color" | "other";

const clone = (b: BrushPreset): BrushPreset => presetFromJSON(JSON.parse(JSON.stringify(presetToJSON(b))));

export function brushesPalette(app: App): PaletteParts {
  let section: Section = "presets";
  const root = el("div", { class: "brushes-pal" });
  const side = el("div", { class: "br-side" });
  const main = el("div", { class: "br-main" });
  const preview = el("div", { class: "br-preview" });
  root.append(el("div", { class: "br-top" }, side, main), preview);

  const toolId = (): BrushToolId => {
    const t = app.tool.id as BrushToolId;
    return t in app.toolBrush ? t : "brush";
  };
  const brush = () => app.toolBrush[toolId()];
  const changed = () => {
    app.emit("brushes");
    app.emit("overlay");
  };

  const slider = (label: string, value: number, min: number, max: number, onInput: (v: number) => void, suffix = "%") => {
    const r = el("input", { type: "range", min, max, value, "aria-label": label });
    const n = el("input", { type: "number", min, max, value, "aria-label": label + " value" });
    const set = (v: number) => {
      v = Math.max(min, Math.min(max, Math.round(v)));
      r.value = n.value = String(v);
      onInput(v);
      changed();
      drawPreview();
    };
    r.addEventListener("input", () => set(+r.value));
    n.addEventListener("change", () => set(+n.value));
    return el("div", { class: "br-slider" }, el("label", { text: label }), el("div", { class: "br-slider-row" }, r, n, el("span", { text: suffix })));
  };
  const select = <T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void) => {
    const s = el("select", { "aria-label": label });
    for (const [v, l] of options) s.append(el("option", { value: v, text: l }));
    s.value = value;
    s.addEventListener("change", () => {
      onChange(s.value as T);
      changed();
      drawPreview();
    });
    return el("div", { class: "field-row" }, el("label", { text: label + ":" }), s);
  };
  const check = (label: string, value: boolean, onChange: (v: boolean) => void) => {
    const c = el("input", { type: "checkbox", checked: value });
    c.addEventListener("change", () => {
      onChange(c.checked);
      changed();
      drawPreview();
    });
    return el("label", { class: "br-check" }, c, " " + label);
  };

  const drawPreview = () => {
    preview.textContent = "";
    const w = Math.max(120, root.clientWidth - 12 || 240);
    preview.append(strokeThumb(brush(), w, 56));
  };

  const renderSide = () => {
    side.textContent = "";
    const b = brush();
    const item = (id: Section, label: string, toggle?: { on: boolean; set: (v: boolean) => void }) => {
      const row = el("div", { class: "br-sec" + (section === id ? " active" : "") });
      if (toggle) {
        const c = el("input", { type: "checkbox", checked: toggle.on, "aria-label": `Enable ${label}` });
        c.addEventListener("click", (e) => e.stopPropagation());
        c.addEventListener("change", () => {
          toggle.set(c.checked);
          changed();
          render();
        });
        row.append(c);
      } else row.append(el("span", { class: "br-nocheck" }));
      row.append(el("span", { text: label }));
      row.addEventListener("click", () => {
        section = id;
        render();
      });
      side.append(row);
    };
    const flag = (label: string, on: boolean, set: (v: boolean) => void, soon?: string) => {
      const c = el("input", { type: "checkbox", checked: on, disabled: !!soon });
      c.addEventListener("change", () => {
        set(c.checked);
        changed();
        drawPreview();
      });
      side.append(el("label", { class: "br-sec flag" + (soon ? " soon" : ""), title: soon ? `Planned for ${soon}` : "" }, c, el("span", { text: label })));
    };
    item("presets", "Brush Presets");
    item("tip", "Brush Tip Shape");
    item("shape", "Shape Dynamics", { on: !!b.shape, set: (v) => (b.shape = v ? { ...DEFAULT_SHAPE } : null) });
    item("scatter", "Scattering", { on: !!b.scatter, set: (v) => (b.scatter = v ? { ...DEFAULT_SCATTER, amount: 120 } : null) });
    flag("Texture", false, () => {}, "1.x");
    flag("Dual Brush", false, () => {}, "1.x");
    item("color", "Color Dynamics", { on: !!b.color, set: (v) => (b.color = v ? { ...DEFAULT_COLOR } : null) });
    item("other", "Other Dynamics", { on: !!b.other, set: (v) => (b.other = v ? { ...DEFAULT_OTHER } : null) });
    flag("Noise", b.noise, (v) => (b.noise = v));
    flag("Wet Edges", false, () => {}, "1.x");
    flag("Airbrush", b.airbrush, (v) => (b.airbrush = v));
  };

  const renderPresets = () => {
    const list = el("div", { class: "br-presets", role: "listbox", "aria-label": "Brush presets" });
    const cur = brush();
    app.brushes.forEach((p, i) => {
      const thumb = dabThumb(p, 30, 30);
      const row = el(
        "div",
        { class: "br-preset" + (p.name === cur.name && p.size === cur.size ? " active" : ""), role: "option", title: p.name },
        thumb,
        el("span", { class: "br-size", text: String(Math.round(p.size)) }),
      );
      row.addEventListener("click", () => {
        app.toolBrush[toolId()] = clone(p);
        changed();
        render();
      });
      row.addEventListener("dblclick", async () => {
        const r = await formDialog("Brush Name", [{ key: "name", label: "Name", type: "text", value: p.name }]);
        if (r?.name) {
          app.brushes[i].name = r.name;
          app.saveBrushes();
          render();
        }
      });
      list.append(row);
    });
    main.append(
      slider("Master Diameter", Math.round(cur.size), 1, 2500, (v) => (brush().size = v), "px"),
      list,
    );
  };

  const renderTip = () => {
    const b = brush();
    const tips = el("div", { class: "br-presets small" });
    app.brushes.forEach((p) => {
      const row = el("div", { class: "br-preset", title: p.name }, dabThumb(p, 26, 26));
      row.addEventListener("click", () => {
        const t = brush();
        t.sampled = p.sampled ? { ...p.sampled } : null;
        t.hardness = p.hardness;
        t.size = p.size;
        t.name = p.name;
        changed();
        render();
      });
      tips.append(row);
    });
    main.append(tips, slider("Diameter", Math.round(b.size), 1, 2500, (v) => (brush().size = v), "px"));
    main.append(
      el(
        "div",
        { class: "br-two" },
        slider("Angle", b.angle, -180, 180, (v) => (brush().angle = v), "°"),
        slider("Roundness", b.roundness, 1, 100, (v) => (brush().roundness = v)),
      ),
    );
    if (!b.sampled) main.append(slider("Hardness", b.hardness, 0, 100, (v) => (brush().hardness = v)));
    main.append(slider("Spacing", b.spacing, 1, 1000, (v) => (brush().spacing = v)));
  };

  const control = (label: string, value: string, opts: [string, string][], set: (v: string) => void) => select(label, value, opts as [string, string][], set);

  const renderShape = () => {
    const s = brush().shape!;
    main.append(
      slider("Size Jitter", s.sizeJitter, 0, 100, (v) => (s.sizeJitter = v)),
      control("Control", s.sizeControl, [["off", "Off"], ["fade", "Fade"], ["pressure", "Pen Pressure"]], (v) => (s.sizeControl = v as never)),
      slider("Fade Steps", s.fadeSteps, 1, 999, (v) => (s.fadeSteps = v), ""),
      slider("Minimum Diameter", s.minDiameter, 0, 100, (v) => (s.minDiameter = v)),
      slider("Angle Jitter", s.angleJitter, 0, 100, (v) => (s.angleJitter = v)),
      control("Control", s.angleControl, [["off", "Off"], ["direction", "Direction"], ["pressure", "Pen Pressure"]], (v) => (s.angleControl = v as never)),
      slider("Roundness Jitter", s.roundnessJitter, 0, 100, (v) => (s.roundnessJitter = v)),
      slider("Minimum Roundness", s.minRoundness, 0, 100, (v) => (s.minRoundness = v)),
    );
  };

  const renderScatter = () => {
    const s = brush().scatter!;
    main.append(
      slider("Scatter", s.amount, 0, 1000, (v) => (s.amount = v)),
      check("Both Axes", s.bothAxes, (v) => (s.bothAxes = v)),
      slider("Count", s.count, 1, 16, (v) => (s.count = v), ""),
      slider("Count Jitter", s.countJitter, 0, 100, (v) => (s.countJitter = v)),
    );
  };

  const renderColor = () => {
    const c = brush().color!;
    main.append(
      slider("Foreground/Background Jitter", c.fgBgJitter, 0, 100, (v) => (c.fgBgJitter = v)),
      slider("Hue Jitter", c.hueJitter, 0, 100, (v) => (c.hueJitter = v)),
      slider("Saturation Jitter", c.saturationJitter, 0, 100, (v) => (c.saturationJitter = v)),
      slider("Brightness Jitter", c.brightnessJitter, 0, 100, (v) => (c.brightnessJitter = v)),
    );
  };

  const renderOther = () => {
    const o = brush().other!;
    const ctl: [string, string][] = [["off", "Off"], ["fade", "Fade"], ["pressure", "Pen Pressure"]];
    main.append(
      slider("Opacity Jitter", o.opacityJitter, 0, 100, (v) => (o.opacityJitter = v)),
      control("Control", o.opacityControl, ctl, (v) => (o.opacityControl = v as never)),
      slider("Flow Jitter", o.flowJitter, 0, 100, (v) => (o.flowJitter = v)),
      control("Control", o.flowControl, ctl, (v) => (o.flowControl = v as never)),
      slider("Fade Steps", o.fadeSteps, 1, 999, (v) => (o.fadeSteps = v), ""),
    );
  };

  const render = () => {
    renderSide();
    main.textContent = "";
    const b = brush();
    const toolNote = ["brush", "pencil", "eraser"].includes(app.tool.id) ? "" : " (Brush tool)";
    main.append(el("div", { class: "br-title", text: b.name + toolNote }));
    if (section === "shape" && !b.shape) section = "tip";
    if (section === "scatter" && !b.scatter) section = "tip";
    if (section === "color" && !b.color) section = "tip";
    if (section === "other" && !b.other) section = "tip";
    ({ presets: renderPresets, tip: renderTip, shape: renderShape, scatter: renderScatter, color: renderColor, other: renderOther })[section]();
    drawPreview();
  };

  let pending = false;
  const renderSoon = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      // Don't rebuild while the user is dragging a slider inside the palette.
      if (root.contains(document.activeElement) && (document.activeElement as HTMLInputElement).type === "range") return drawPreview();
      render();
    });
  };
  app.on("brushes", renderSoon);
  app.on("tool", renderSoon);
  new ResizeObserver(() => drawPreview()).observe(root);
  render();

  const menu = (): MenuItem[] => [
    {
      label: "New Brush...",
      run: async () => {
        const r = await formDialog("Brush Name", [{ key: "name", label: "Name", type: "text", value: `${brush().name} copy` }]);
        if (!r?.name) return;
        const b = clone(brush());
        b.name = r.name;
        app.brushes.push(b);
        app.saveBrushes();
        render();
      },
    },
    {
      label: "Delete Brush",
      enabled: () => app.brushes.some((p) => p.name === brush().name),
      run: () => {
        const i = app.brushes.findIndex((p) => p.name === brush().name);
        if (i >= 0) app.brushes.splice(i, 1);
        app.saveBrushes();
        render();
      },
    },
    "-",
    {
      label: "Reset Brushes...",
      run: async () => {
        if (!(await confirmDialog("Reset Brushes", "Replace the current brushes with the default brushes?", "Replace"))) return;
        app.brushes = defaultBrushes();
        app.saveBrushes();
        render();
      },
    },
    {
      label: "Load Brushes...",
      run: async () => {
        const { pickText } = await import("../io/files");
        const t = await pickText([".json"]);
        if (!t) return;
        try {
          const o = JSON.parse(t);
          if (o?.format !== "classic-image-editor-brushes" || !Array.isArray(o.brushes)) throw new Error();
          app.brushes.push(...o.brushes.map(presetFromJSON));
          app.saveBrushes();
          render();
        } catch {
          app.toast("That file is not a brush set saved by this editor.");
        }
      },
    },
    {
      label: "Save Brushes...",
      run: async () => {
        const { saveText } = await import("../io/files");
        await saveText(JSON.stringify({ format: "classic-image-editor-brushes", brushes: app.brushes.map(presetToJSON) }), "brushes.json");
      },
    },
  ];

  return { body: root, menu };
}

// ---------------------------------------------------------------- Tool Presets

interface ToolPreset {
  name: string;
  tool: string;
  settings: Record<string, unknown>;
  brush?: unknown;
}

const PRESET_KEYS: Record<string, string[]> = {
  brush: ["brushOpacity", "brushFlow", "brushMode"],
  pencil: ["pencilOpacity", "pencilMode", "pencilAutoErase"],
  eraser: ["eraserOpacity", "eraserFlow", "eraserMode", "eraserToHistory"],
  bucket: ["bucketTolerance", "bucketContiguous", "bucketOpacity"],
  type: ["typeStyle"],
  gradient: ["gradientType", "gradientPreset", "gradientMode", "gradientOpacity", "gradientReverse", "gradientDither", "gradientTransparency"],
  marquee: ["marqueeFeather", "marqueeStyle", "marqueeW", "marqueeH"],
  ellipse: ["marqueeFeather", "marqueeAntiAlias", "marqueeStyle", "marqueeW", "marqueeH"],
  lasso: ["lassoFeather", "lassoAntiAlias"],
  polyLasso: ["lassoFeather", "lassoAntiAlias"],
  wand: ["wandTolerance", "wandAntiAlias", "wandContiguous", "wandSampleMerged"],
  eyedropper: ["eyedropperSample"],
  move: ["moveAutoSelect", "moveShowBounds"],
};

export function toolPresetsStore(app: App) {
  const load = (): ToolPreset[] => {
    try {
      return JSON.parse(localStorage.getItem("cie.toolPresets") ?? "[]");
    } catch {
      return [];
    }
  };
  const save = (list: ToolPreset[]) => {
    try {
      localStorage.setItem("cie.toolPresets", JSON.stringify(list));
    } catch {
      /* ignore */
    }
    app.emit("brushes");
  };
  return {
    list: load,
    add(name: string) {
      const t = app.tool.id;
      const settings: Record<string, unknown> = {};
      for (const k of PRESET_KEYS[t] ?? []) settings[k] = (app.settings as unknown as Record<string, unknown>)[k];
      const p: ToolPreset = { name, tool: t, settings };
      if (t === "brush" || t === "pencil" || t === "eraser") p.brush = presetToJSON(app.toolBrush[t]);
      save([...load(), p]);
    },
    apply(p: ToolPreset) {
      app.setTool(p.tool as never);
      Object.assign(app.settings, p.settings);
      if (p.brush && (p.tool === "brush" || p.tool === "pencil" || p.tool === "eraser")) app.toolBrush[p.tool] = presetFromJSON(p.brush);
      app.emit("settings");
      app.emit("brushes");
      app.emit("tool");
    },
    remove(i: number) {
      const l = load();
      l.splice(i, 1);
      save(l);
    },
  };
}

export function toolPresetsPalette(app: App): PaletteParts {
  const store = toolPresetsStore(app);
  let currentOnly = true;
  const list = el("div", { class: "tp-list", role: "listbox", "aria-label": "Tool presets" });
  const only = el("input", { type: "checkbox", checked: true });
  only.addEventListener("change", () => {
    currentOnly = only.checked;
    render();
  });
  const render = () => {
    list.textContent = "";
    const all = store.list();
    const shown = all.map((p, i) => ({ p, i })).filter(({ p }) => !currentOnly || p.tool === app.tool.id);
    if (!shown.length) list.append(el("p", { class: "ai-note", text: "No presets yet. Set up a tool, then click the page button below to save it as a preset." }));
    for (const { p, i } of shown) {
      const t = app.tools[p.tool as keyof typeof app.tools];
      const row = el("div", { class: "tp-row", role: "option", title: `${t?.label ?? p.tool}` }, el("span", { class: "tp-name", text: p.name }));
      row.addEventListener("click", () => store.apply(p));
      row.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        if (await confirmDialog("Delete Tool Preset", `Delete "${p.name}"?`, "Delete")) store.remove(i);
      });
      list.append(row);
    }
  };
  const add = el("button", { class: "icon-btn", type: "button", title: "Create new tool preset", "aria-label": "Create new tool preset", text: "+" });
  add.addEventListener("click", async () => {
    const r = await formDialog("New Tool Preset", [{ key: "name", label: "Name", type: "text", value: `${app.tool.label.replace(/ Tool$/, "")} ${store.list().length + 1}` }]);
    if (r?.name) store.add(r.name);
  });
  app.on("tool", render);
  app.on("brushes", render);
  render();
  return {
    body: el("div", { class: "tp-body" }, list, el("label", { class: "br-check" }, only, " Current Tool Only")),
    footer: el("div", { style: "display:contents" }, add),
  };
}
