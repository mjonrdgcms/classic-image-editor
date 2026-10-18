/**
 * The context-sensitive options bar, one layout per tool, with the tool
 * preset picker on the left and the palette well on the right.
 */

import type { App, ToolSettings } from "../app";
import { BLEND_LABELS, BLEND_MODES } from "../core/blend";
import { presetFromJSON, presetToJSON } from "../core/brushes";
import type { SelectMode } from "../core/selection";
import { GRADIENT_LABELS, GRADIENT_PRESETS, GRADIENT_TYPES, GRADIENT_TYPE_LABELS, GradientPreset, GradientType, gradientLUT, gradientT, presetStops } from "../core/gradient";
import type { CropTool } from "../tools/tools";
import { dabThumb } from "./brushpreview";
import { toolPresetsStore } from "./brushes";
import { el, formDialog } from "./dialogs";
import { ICONS } from "./icons";
import { MenuItem, showPopupMenu } from "./menus";
import { typeOptionParts } from "../text/typeui";
import { faceSwapOptionParts } from "../tools/faceswaptool";
import { historySourceOptions } from "../tools/retouchtools";
import { measureOptionParts } from "../tools/moretools";
import { CUSTOM_SHAPES, CUSTOM_SHAPE_LABELS } from "../core/vector";
import { patternThumb } from "./patternui";
import { transformOptionParts } from "../tools/transformtool";

type NumKey = { [K in keyof ToolSettings]: ToolSettings[K] extends number ? K : never }[keyof ToolSettings];
type BoolKey = { [K in keyof ToolSettings]: ToolSettings[K] extends boolean ? K : never }[keyof ToolSettings];
type Part = { node: HTMLElement; sync(): void };

export function mountOptionsBar(root: HTMLElement, app: App, openBrushes: () => void, openType: () => void = () => {}, showPaths: () => void = () => {}): HTMLElement {
  const opts = el("div", { class: "opts" });
  const well = el("div", { class: "palette-well", id: "palette-well", title: "Palette Well: drag palette tabs here" });
  root.append(opts, el("span", { class: "spacer" }), well);

  const number = (label: string, key: NumKey, min: number, max: number, suffix = "", slider = true): Part => {
    const n = el("input", { type: "number", min, max, value: app.settings[key], "aria-label": label });
    const r = el("input", { type: "range", min, max, value: app.settings[key], "aria-label": label + " slider" });
    const set = (v: number) => {
      v = Math.max(min, Math.min(max, Math.round(v)));
      (app.settings[key] as number) = v;
      app.emit("settings");
    };
    n.addEventListener("change", () => set(+n.value));
    r.addEventListener("input", () => set(+r.value));
    return {
      node: el("label", {}, label + ":", n, suffix, slider ? r : null),
      sync: () => {
        if (document.activeElement !== n) n.value = String(app.settings[key]);
        r.value = String(app.settings[key]);
      },
    };
  };
  const check = (label: string, key: BoolKey): Part => {
    const c = el("input", { type: "checkbox", checked: app.settings[key] });
    c.addEventListener("change", () => {
      (app.settings[key] as boolean) = c.checked;
      app.emit("settings");
    });
    return { node: el("label", {}, c, label), sync: () => (c.checked = app.settings[key]) };
  };
  const choice = <K extends keyof ToolSettings>(label: string, key: K, options: [string, string][]): Part => {
    const s = el("select", { "aria-label": label });
    for (const [v, l] of options) s.append(el("option", { value: v, text: l }));
    s.addEventListener("change", () => {
      (app.settings as unknown as Record<string, unknown>)[key] = typeof app.settings[key] === "number" ? +s.value : s.value;
      app.emit("settings");
      render();
    });
    return { node: el("label", {}, label + ":", s), sync: () => (s.value = String(app.settings[key])) };
  };
  const sep = (): Part => ({ node: el("span", { class: "sep" }), sync: () => {} });
  const note = (text: string): Part => ({ node: el("span", { class: "note", text }), sync: () => {} });
  const button = (label: string, fn: () => void, title = ""): Part => {
    const b = el("button", { class: "btn small", type: "button", text: label, title });
    b.addEventListener("click", fn);
    return { node: b, sync: () => {} };
  };

  /** New / Add / Subtract / Intersect selection buttons. */
  const modes = (): Part => {
    const box = el("span", { class: "mode-btns", role: "group", "aria-label": "Selection mode" });
    const items: [SelectMode, string][] = [
      ["replace", "New selection"],
      ["add", "Add to selection (Shift)"],
      ["subtract", "Subtract from selection (Alt)"],
      ["intersect", "Intersect with selection (Shift+Alt)"],
    ];
    const btns = items.map(([m, title]) => {
      const b = el("button", { type: "button", class: "mode-btn mode-" + m, title, "aria-label": title });
      b.addEventListener("click", () => {
        app.settings.selectMode = m;
        app.emit("settings");
      });
      box.append(b);
      return [m, b] as const;
    });
    return { node: box, sync: () => btns.forEach(([m, b]) => b.classList.toggle("active", app.settings.selectMode === m)) };
  };

  /** Brush picker: current tip + size; opens a presets popup. */
  const brushPicker = (): Part => {
    const btn = el("button", { class: "brush-pick", type: "button", title: "Brush preset picker" });
    btn.addEventListener("click", () => {
      const r = btn.getBoundingClientRect();
      const items: MenuItem[] = app.brushes.map((p) => ({
        label: p.name,
        run: () => {
          const id = app.tool.id as import("../app").BrushToolId;
          app.toolBrush[id] = presetFromJSON(JSON.parse(JSON.stringify(presetToJSON(p))));
          app.emit("brushes");
        },
      }));
      items.push("-", { label: "Open Brushes Palette...", run: openBrushes });
      showPopupMenu(items, r.left, r.bottom);
    });
    const sync = () => {
      const b = app.activeBrush;
      btn.textContent = "";
      if (!b) return;
      btn.append(dabThumb(b, 22, 22), el("span", { text: String(Math.round(b.size)) }), el("span", { class: "caret", text: "▾" }));
    };
    return { node: el("label", {}, "Brush:", btn), sync };
  };

  const paintMode = (key: "brushMode" | "pencilMode"): Part => {
    const s = el("select", { "aria-label": "Mode" });
    BLEND_MODES.forEach((m) => {
      s.append(el("option", { value: m, text: BLEND_LABELS[m] }));
      if (m === "dissolve") {
        s.append(el("option", { value: "behind", text: "Behind" }));
        s.append(el("option", { value: "clear", text: "Clear" }));
      }
    });
    s.addEventListener("change", () => {
      app.settings[key] = s.value;
      app.emit("settings");
    });
    return { node: el("label", {}, "Mode:", s), sync: () => (s.value = app.settings[key]) };
  };

  const airbrush = (): Part => {
    const b = el("button", { type: "button", class: "icon-btn airbrush", title: "Enable airbrush capabilities", "aria-label": "Airbrush" });
    b.innerHTML = ICONS.brush;
    b.addEventListener("click", () => {
      const br = app.activeBrush;
      if (!br) return;
      br.airbrush = !br.airbrush;
      app.emit("brushes");
    });
    return { node: b, sync: () => b.classList.toggle("active", !!app.activeBrush?.airbrush) };
  };

  /** A small canvas showing a gradient preset (or a type's shape). */
  const gradSwatch = (preset: GradientPreset, w: number, h: number, type: GradientType = "linear"): HTMLCanvasElement => {
    const c = el("canvas", { width: w, height: h, class: "grad-swatch" });
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    const doc = app.doc;
    const fg = doc?.foreground ?? [0, 0, 0, 255];
    const bg = doc?.background ?? [255, 255, 255, 255];
    const lut = gradientLUT(presetStops(preset, fg, bg), false, true);
    const img = ctx.createImageData(w, h);
    const [x0, y0, x1, y1] = type === "linear" ? [0, 0, w, 0] : type === "reflected" ? [w / 2, 0, w, 0] : [w / 2, h / 2, w, h / 2];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const t = gradientT(type, x + 0.5, y + 0.5, x0, y0, x1, y1);
        const i = Math.round(t * 1023) * 4, o = (y * w + x) * 4;
        // Over a checkerboard so transparency shows.
        const chk = ((x >> 2) + (y >> 2)) & 1 ? 204 : 255;
        const a = lut[i + 3] / 255;
        for (let k = 0; k < 3; k++) img.data[o + k] = lut[i + k] * a + chk * (1 - a);
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    return c;
  };

  const gradientPicker = (): Part => {
    const btn = el("button", { class: "grad-pick", type: "button", title: "Gradient presets", "aria-label": "Gradient preset" });
    const sync = () => {
      btn.textContent = "";
      btn.append(gradSwatch(app.settings.gradientPreset, 72, 16), el("span", { class: "caret", text: "▾" }));
      btn.title = GRADIENT_LABELS[app.settings.gradientPreset];
    };
    btn.addEventListener("click", () => {
      const r = btn.getBoundingClientRect();
      showPopupMenu(
        GRADIENT_PRESETS.map((p) => ({
          label: GRADIENT_LABELS[p],
          checked: app.settings.gradientPreset === p,
          run: () => {
            app.settings.gradientPreset = p;
            app.emit("settings");
          },
        })),
        r.left,
        r.bottom,
      );
    });
    return { node: btn, sync };
  };

  const gradientTypes = (): Part => {
    const box = el("span", { class: "mode-btns grad-types", role: "group", "aria-label": "Gradient type" });
    const btns = GRADIENT_TYPES.map((t) => {
      const b = el("button", { type: "button", class: "mode-btn grad-type", title: GRADIENT_TYPE_LABELS[t], "aria-label": GRADIENT_TYPE_LABELS[t], "data-type": t });
      b.addEventListener("click", () => {
        app.settings.gradientType = t;
        app.emit("settings");
      });
      box.append(b);
      return [t, b] as const;
    });
    const sync = () =>
      btns.forEach(([t, b]) => {
        b.classList.toggle("active", app.settings.gradientType === t);
        b.textContent = "";
        b.append(gradSwatch(app.settings.gradientPreset, 16, 16, t));
      });
    return { node: box, sync };
  };

  const blendMode = (key: "gradientMode"): Part => {
    const s = el("select", { "aria-label": "Mode" });
    BLEND_MODES.forEach((m) => s.append(el("option", { value: m, text: BLEND_LABELS[m] })));
    s.addEventListener("change", () => {
      app.settings[key] = s.value;
      app.emit("settings");
    });
    return { node: el("label", {}, "Mode:", s), sync: () => (s.value = app.settings[key]) };
  };

  const textField = (label: string, key: "noteAuthor"): Part => {
    const i = el("input", { type: "text", value: app.settings[key], "aria-label": label, style: "width:110px" });
    i.addEventListener("change", () => {
      app.settings[key] = i.value;
      app.emit("settings");
    });
    return { node: el("label", {}, label + ":", i), sync: () => document.activeElement !== i && (i.value = app.settings[key]) };
  };
  const colorField = (label: string, key: "noteColor"): Part => {
    const i = el("input", { type: "color", value: app.settings[key], "aria-label": label });
    i.addEventListener("input", () => {
      app.settings[key] = i.value;
      app.emit("settings");
    });
    return { node: el("label", {}, label + ":", i), sync: () => (i.value = app.settings[key]) };
  };

  /** Pattern picker: the current pattern; click for the list. */
  const patternPicker = (): Part => {
    const btn = el("button", { class: "brush-pick", type: "button", title: "Pattern picker" });
    btn.addEventListener("click", () => {
      const r = btn.getBoundingClientRect();
      const items: MenuItem[] = app.patterns.map((p, i) => ({
        label: p.name,
        checked: i === app.settings.patternIndex,
        run: () => {
          app.settings.patternIndex = i;
          app.emit("settings");
          sync();
        },
      }));
      items.push("-", {
        label: "Delete Current Pattern",
        enabled: app.patterns.length > 1,
        run: () => {
          app.patterns.splice(app.settings.patternIndex, 1);
          app.settings.patternIndex = Math.max(0, Math.min(app.settings.patternIndex, app.patterns.length - 1));
          app.savePatterns();
          app.emit("settings");
          sync();
        },
      });
      showPopupMenu(items, r.left, r.bottom);
    });
    const sync = () => {
      btn.textContent = "";
      const p = app.patterns[Math.min(app.settings.patternIndex, app.patterns.length - 1)];
      if (!p) return;
      btn.append(patternThumb(p, 22), el("span", { text: p.name }), el("span", { class: "caret", text: "▾" }));
    };
    return { node: el("label", {}, "Pattern:", btn), sync };
  };

  const palBtn = (): Part => {
    const b = el("button", { type: "button", class: "btn small", text: "Brushes", title: "Show the Brushes palette" });
    b.addEventListener("click", openBrushes);
    return { node: b, sync: () => {} };
  };

  let parts: Part[] = [];
  const render = () => {
    opts.textContent = "";
    const t = app.tool;
    const badge = el("button", { class: "tool-badge", type: "button", title: `${t.label}: tool presets` });
    badge.innerHTML = ICONS[t.icon] + '<span class="caret">▾</span>';
    badge.addEventListener("click", async () => {
      const store = toolPresetsStore(app);
      const list = store.list().filter((p) => p.tool === t.id);
      const r = badge.getBoundingClientRect();
      const items: MenuItem[] = list.map((p) => ({ label: p.name, run: () => store.apply(p) }));
      if (!items.length) items.push({ label: "No presets for this tool", enabled: false });
      items.push("-", {
        label: "New Tool Preset...",
        run: async () => {
          const res = await formDialog("New Tool Preset", [{ key: "name", label: "Name", type: "text", value: `${t.label.replace(/ Tool$/, "")} ${list.length + 1}` }]);
          if (res?.name) store.add(res.name);
        },
      });
      showPopupMenu(items, r.left, r.bottom);
    });
    opts.append(badge);
    const s = app.settings;
    switch (t.id) {
      case "marquee":
      case "ellipse":
        parts = [
          modes(),
          sep(),
          number("Feather", "marqueeFeather", 0, 250, "px", false),
          ...(t.id === "ellipse" ? [check("Anti-aliased", "marqueeAntiAlias")] : []),
          sep(),
          choice("Style", "marqueeStyle", [["normal", "Normal"], ["aspect", "Fixed Aspect Ratio"], ["fixed", "Fixed Size"]]),
          ...(s.marqueeStyle !== "normal" ? [number("Width", "marqueeW", 1, 30000, "", false), number("Height", "marqueeH", 1, 30000, "", false)] : []),
        ];
        break;
      case "row":
      case "column":
        parts = [modes(), sep(), number("Feather", "marqueeFeather", 0, 250, "px", false)];
        break;
      case "lasso":
      case "polyLasso":
        parts = [modes(), sep(), number("Feather", "lassoFeather", 0, 250, "px", false), check("Anti-aliased", "lassoAntiAlias")];
        break;
      case "wand":
        parts = [modes(), sep(), number("Tolerance", "wandTolerance", 0, 255, "", false), check("Anti-aliased", "wandAntiAlias"), check("Contiguous", "wandContiguous"), check("Use All Layers", "wandSampleMerged")];
        break;
      case "crop": {
        const crop = t as CropTool;
        parts = crop.active
          ? [check("Shield cropped area", "cropShield"), sep(), button("✓ Commit", () => crop.commit(), "Commit the crop (Enter)"), button("✕ Cancel", () => crop.cancel(), "Cancel the crop (Esc)")]
          : [note("Drag a crop box, adjust its handles, then press Enter.")];
        break;
      }
      case "brush":
        parts = [brushPicker(), paintMode("brushMode"), sep(), number("Opacity", "brushOpacity", 1, 100, "%"), number("Flow", "brushFlow", 1, 100, "%"), airbrush(), sep(), palBtn()];
        break;
      case "pencil":
        parts = [brushPicker(), paintMode("pencilMode"), sep(), number("Opacity", "pencilOpacity", 1, 100, "%"), check("Auto Erase", "pencilAutoErase"), sep(), palBtn()];
        break;
      case "eraser":
        parts = [
          ...(s.eraserMode !== "block" ? [brushPicker()] : []),
          choice("Mode", "eraserMode", [["brush", "Brush"], ["pencil", "Pencil"], ["block", "Block"]]),
          sep(),
          number("Opacity", "eraserOpacity", 1, 100, "%"),
          ...(s.eraserMode === "brush" ? [number("Flow", "eraserFlow", 1, 100, "%"), airbrush()] : []),
        ];
        break;
      case "stamp":
        parts = [brushPicker(), sep(), number("Opacity", "stampOpacity", 1, 100, "%"), check("Aligned", "stampAligned"), check("Use All Layers", "stampSampleAll"), sep(), note("Alt-click sets the source.")];
        break;
      case "heal":
        parts = [brushPicker(), sep(), check("Aligned", "healAligned"), check("Use All Layers", "healSampleAll"), sep(), note("Alt-click a clean area, then paint over the flaw.")];
        break;
      case "spotHeal":
        parts = [brushPicker(), sep(), note("Paint over spots, blemishes, wires or small objects. Make the brush a little bigger than the spot.")];
        break;
      case "pen":
      case "freeformPen":
        parts = [
          choice("Draw", "penMode", [["path", "Paths"], ["shape", "Shape Layers"]]),
          sep(),
          note(t.id === "pen" ? "Click for corners, drag for curves; click the first point to close. Ctrl: Direct Selection." : "Drag to draw; end at the start to close."),
          sep(),
          button("Paths Palette", () => showPaths()),
        ];
        break;
      case "addAnchor":
      case "deleteAnchor":
      case "convertPoint":
      case "pathSelect":
      case "directSelect":
        parts = [note(t.hint), sep(), button("Paths Palette", () => showPaths())];
        break;
      case "rectShape":
      case "roundRectShape":
      case "ellipseShape":
      case "polygonShape":
      case "lineShape":
      case "customShape":
        parts = [
          choice("Make", "shapeMode", [["shape", "Shape Layer"], ["path", "Path"], ["pixels", "Fill Pixels"]]),
          sep(),
          ...(t.id === "roundRectShape" ? [number("Radius", "shapeRadius", 0, 1000, "px", false)] : []),
          ...(t.id === "polygonShape" ? [number("Sides", "polygonSides", 3, 100, "", false), number("Star Indent", "polygonIndent", 0, 99, "%", false)] : []),
          ...(t.id === "lineShape" ? [number("Weight", "lineWeight", 1, 1000, "px", false), check("Arrow Start", "lineArrowStart"), check("Arrow End", "lineArrowEnd")] : []),
          ...(t.id === "customShape" ? [choice("Shape", "customShape", CUSTOM_SHAPES.map((k) => [k, CUSTOM_SHAPE_LABELS[k]] as [string, string]))] : []),
          note(s.shapeMode === "shape" ? "Fills with the foreground color; double-click the layer thumbnail to change it." : ""),
        ];
        break;
      case "patch":
        parts = [choice("Patch", "patchMode", [["source", "Source"], ["destination", "Destination"]]), sep(), note(s.patchMode === "source" ? "Select the flaw, then drag it onto a clean area." : "Select a clean area, then drag it over the flaw.")];
        break;
      case "magneticLasso":
        parts = [
          modes(),
          sep(),
          number("Feather", "lassoFeather", 0, 250, "px", false),
          check("Anti-aliased", "lassoAntiAlias"),
          sep(),
          number("Width", "magneticWidth", 1, 40, "px", false),
          number("Frequency", "magneticFrequency", 0, 100, "", false),
        ];
        break;
      case "colorSampler":
        parts = [
          note("Up to four samplers; read them in the Info palette."),
          button("Clear", () => {
            if (app.doc) app.doc.samplers = [];
            app.emit("overlay");
            app.emit("doc");
          }),
        ];
        break;
      case "measure":
        parts = measureOptionParts(app);
        break;
      case "notes":
        parts = [
          textField("Author", "noteAuthor"),
          colorField("Color", "noteColor"),
          sep(),
          button("Clear All", () => app.doc?.notes.length && app.run("note.remove", {})),
        ];
        break;
      case "slice":
      case "sliceSelect":
        parts = [
          note("Slices export as separate PNGs (File > Export > Slices)."),
          button("Delete All", () => app.doc?.slices.length && app.run("slice.remove", {})),
        ];
        break;
      case "patternStamp":
        parts = [brushPicker(), sep(), number("Opacity", "patternStampOpacity", 1, 100, "%"), patternPicker(), sep(), note("Edit > Define Pattern adds the selection as a pattern.")];
        break;
      case "artHistory":
        parts = [
          brushPicker(),
          sep(),
          number("Opacity", "artOpacity", 1, 100, "%"),
          choice("Style", "artStyle", [
            ["tightShort", "Tight Short"],
            ["tightMedium", "Tight Medium"],
            ["tightLong", "Tight Long"],
            ["looseMedium", "Loose Medium"],
            ["looseLong", "Loose Long"],
            ["dab", "Dab"],
            ["tightCurl", "Tight Curl"],
            ["looseCurl", "Loose Curl"],
          ]),
          number("Area", "artArea", 1, 500, "px", false),
          choice("Paint from", "historyBrushFrom", historySourceOptions(app)),
        ];
        break;
      case "bgEraser":
        parts = [
          brushPicker(),
          sep(),
          choice("Limits", "bgEraserLimits", [["contiguous", "Contiguous"], ["discontiguous", "Discontiguous"]]),
          number("Tolerance", "bgEraserTolerance", 1, 100, "%"),
          check("Protect Foreground Color", "bgEraserProtectFg"),
          choice("Sampling", "bgEraserSampling", [["continuous", "Continuous"], ["once", "Once"], ["background", "Background Swatch"]]),
        ];
        break;
      case "colorReplace":
        parts = [
          brushPicker(),
          sep(),
          choice("Mode", "colorReplaceMode", [["color", "Color"], ["hue", "Hue"], ["saturation", "Saturation"], ["luminosity", "Luminosity"]]),
          choice("Sampling", "colorReplaceSampling", [["continuous", "Continuous"], ["once", "Once"], ["background", "Background Swatch"]]),
          choice("Limits", "colorReplaceLimits", [["contiguous", "Contiguous"], ["discontiguous", "Discontiguous"]]),
          number("Tolerance", "colorReplaceTolerance", 1, 100, "%"),
        ];
        break;
      case "redEye":
        parts = [number("Pupil Size", "redEyePupil", 1, 100, "%"), number("Darken Amount", "redEyeDarken", 1, 100, "%"), sep(), note("Click a red pupil, or drag a box around the eye.")];
        break;
      case "historyBrush":
        parts = [brushPicker(), sep(), number("Opacity", "historyBrushOpacity", 1, 100, "%"), choice("Paint from", "historyBrushFrom", historySourceOptions(app))];
        break;
      case "magicEraser":
        parts = [
          number("Tolerance", "magicEraserTolerance", 0, 255, "", false),
          check("Anti-aliased", "magicEraserAntiAlias"),
          check("Contiguous", "magicEraserContiguous"),
          check("Use All Layers", "magicEraserSampleMerged"),
          sep(),
          number("Opacity", "magicEraserOpacity", 1, 100, "%"),
        ];
        break;
      case "dodge":
      case "burn": {
        const k = t.id as "dodge" | "burn";
        parts = [
          brushPicker(),
          sep(),
          choice("Range", k === "dodge" ? "dodgeRange" : "burnRange", [["shadows", "Shadows"], ["midtones", "Midtones"], ["highlights", "Highlights"]]),
          number("Exposure", k === "dodge" ? "dodgeExposure" : "burnExposure", 1, 100, "%"),
        ];
        break;
      }
      case "sponge":
        parts = [brushPicker(), sep(), choice("Mode", "spongeMode", [["desaturate", "Desaturate"], ["saturate", "Saturate"]]), number("Flow", "spongeFlow", 1, 100, "%")];
        break;
      case "blur":
      case "sharpen":
      case "smudge":
        parts = [brushPicker(), sep(), number("Strength", t.id === "blur" ? "blurStrength" : t.id === "sharpen" ? "sharpenStrength" : "smudgeStrength", 1, 100, "%")];
        break;
      case "bucket":
        parts = [note("Fill: Foreground"), sep(), number("Opacity", "bucketOpacity", 1, 100, "%"), number("Tolerance", "bucketTolerance", 0, 255, "", false), check("Contiguous", "bucketContiguous")];
        break;
      case "gradient":
        parts = [
          gradientPicker(),
          gradientTypes(),
          sep(),
          blendMode("gradientMode"),
          number("Opacity", "gradientOpacity", 1, 100, "%"),
          check("Reverse", "gradientReverse"),
          check("Dither", "gradientDither"),
          check("Transparency", "gradientTransparency"),
        ];
        break;
      case "type":
        parts = typeOptionParts(app, openType);
        break;
      case "faceSwap":
        parts = faceSwapOptionParts(app);
        break;
      case "transform":
        parts = transformOptionParts(app);
        break;
      case "move": {
        // Align and distribute the selected layers (or align to the selection).
        const ab = (icon: string, title: string, cmd: string, edge: string): Part => {
          const b = el("button", { type: "button", class: "icon-btn", title, "aria-label": title });
          b.innerHTML = ICONS[icon];
          b.addEventListener("click", () => app.run(cmd, { edge }));
          return { node: b, sync: () => ((b as HTMLButtonElement).disabled = !app.hasDoc || !app.bus.isEnabled(cmd)) };
        };
        parts = [
          check("Auto Select Layer", "moveAutoSelect"),
          sep(),
          ab("alignTop", "Align top edges", "layer.align", "top"),
          ab("alignVcenter", "Align vertical centers", "layer.align", "vcenter"),
          ab("alignBottom", "Align bottom edges", "layer.align", "bottom"),
          ab("alignLeft", "Align left edges", "layer.align", "left"),
          ab("alignHcenter", "Align horizontal centers", "layer.align", "hcenter"),
          ab("alignRight", "Align right edges", "layer.align", "right"),
          sep(),
          ab("distV", "Distribute vertical centers", "layer.distribute", "vcenter"),
          ab("distH", "Distribute horizontal centers", "layer.distribute", "hcenter"),
          sep(),
          note("Ctrl/Shift-click layers in the Layers palette to move several at once."),
        ];
        break;
      }
        break;
      case "eyedropper":
        parts = [choice("Sample Size", "eyedropperSample", [["1", "Point Sample"], ["3", "3 by 3 Average"], ["5", "5 by 5 Average"]])];
        break;
      case "hand":
      case "zoom":
        parts = [button("Actual Pixels", () => app.actualPixels()), button("Fit On Screen", () => app.fitOnScreen())];
        break;
    }
    opts.append(...parts.map((p) => p.node));
    parts.forEach((p) => p.sync());
  };

  app.on("tool", render);
  app.on("doc", () => (app.tool.id === "type" || app.tool.id === "faceSwap" || app.tool.id === "move") && parts.forEach((p) => p.sync()));
  app.on("settings", () => parts.forEach((p) => p.sync()));
  app.on("brushes", () => parts.forEach((p) => p.sync()));
  render();
  return well;
}
