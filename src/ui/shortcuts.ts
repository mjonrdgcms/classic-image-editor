/**
 * Keyboard shortcuts: PS7 defaults, user overrides (Edit > Keyboard
 * Shortcuts), and a printable reference. Overrides are saved and can travel
 * with a named workspace.
 */

import type { App } from "../app";
import type { ToolId } from "../tools/tools";
import type { Actions, UIAction } from "./actions";
import { el, isModalOpen, modal } from "./dialogs";
import { prettyShortcut, setShortcutLookup } from "./menus";
import * as storage from "./storage";

/** Turn a KeyboardEvent into a canonical combo like "Ctrl+Shift+N". */
export function comboOf(e: KeyboardEvent): string {
  let key = e.code;
  // Letters follow the layout's labels (AZERTY Z is Z); everything else uses the physical key.
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
  else if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  else if (key.startsWith("Numpad") && /\d$/.test(key)) key = key.slice(6);
  else if (key === "Equal" || key === "NumpadAdd") key = "=";
  else if (key === "Minus" || key === "NumpadSubtract") key = "-";
  else if (key === "BracketLeft") key = "[";
  else if (key === "BracketRight") key = "]";
  else if (key === "Semicolon") key = ";";
  else if (key === "Quote") key = "'";
  else if (key === "Backslash") key = "\\";
  else if (key === "Comma") key = ",";
  else if (key === "Period") key = ".";
  else if (key === "Slash") key = "/";
  else if (key === "Backquote") key = "`";
  else if (/^(Backspace|Delete|Tab|Space|Escape|Enter|Home|End|PageUp|PageDown|Insert|F\d+)$/.test(key) || key.startsWith("Arrow")) {
    /* keep */
  } else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function canonical(s: string): string {
  if (!s) return "";
  const parts = s.split("+");
  let key = parts.pop()!;
  if (key === "" && s.endsWith("++")) key = "=";
  const mods = ["Ctrl", "Alt", "Shift"].filter((m) => parts.includes(m));
  return [...mods, key === "Del" ? "Delete" : key].join("+");
}

const isModifierKey = (e: KeyboardEvent) => ["Control", "Shift", "Alt", "Meta"].includes(e.key);

/** Categories for the editor and the reference. */
const BLEND_IDS = ["normal", "dissolve", "darken", "multiply", "colorBurn", "linearBurn", "lighten", "screen", "colorDodge", "linearDodge", "overlay", "softLight", "hardLight", "vividLight", "linearLight", "pinLight", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "behind", "clear"].map((m) => `blend_${m}`);
const CATEGORIES: [string, string[]][] = [
  ["File", ["new", "open", "close", "closeAll", "savePng", "saveJpeg", "batch"]],
  ["Edit", ["undo", "redo", "stepForward", "stepBackward", "cut", "copy", "copyMerged", "paste", "pasteInto", "clear", "fill", "fillFg", "fillBg", "fillFgKeep", "fillBgKeep", "transformAgain", "defineBrush", "purgeUndo", "purgeClipboard", "purgeHistories", "purgeAll", "keyboardShortcuts", "preferences", "preferencesLast"]],
  ["Image", ["cropToSelection", "invert", "desaturate", "hueSaturation", "brightnessContrast", "autoLevels", "autoContrast", "autoColor", "equalize", "threshold", "posterize", "gradientMap", "channelMixer", "shadowsHighlights", "exposure", "whiteBalance", "vibrance", "bwLab", "flatten"]],
  ["Filter", ["lastFilter", "lastFilterDialog", "filterLibrary", "fade"]],
  [
    "Layer",
    ["newLayer", "newLayerQuick", "newSet", "newSetFromLinked", "fromBackground", "layerViaCopy", "layerViaCut", "duplicateLayer", "deleteLayer", "layerProperties", "editMask", "editLayer", "maskToggle", "maskOverlayToggle", "maskViewGray", "loadMaskSelection", "loadTransparency", "maskLinkToggle", "maskInvert", "maskEdge", "editText", "rasterizeTypeLayer", "typeConvert", "groupWithPrevious", "ungroup", "bringToFront", "bringForward", "sendBackward", "sendToBack", "mergeDown", "mergeVisible", "stampVisible", "selectLayerUp", "selectLayerDown", "selectTopLayer", "selectBottomLayer", "lockTransparency"],
  ],
  ["Blend Modes", ["blendNext", "blendPrev", ...BLEND_IDS]],
  ["Select", ["selectAll", "deselect", "reselect", "inverse", "colorRange", "feather", "border", "smooth", "expand", "contract", "quickMask"]],
  ["View", ["zoomIn", "zoomOut", "fit", "actual", "extras", "showGuides", "showGrid", "rulers", "snap", "lockGuides", "newGuide", "clearGuides", "cycleScreen", "scrollUp", "scrollDown", "scrollLeft", "scrollRight", "scrollUpSmall", "scrollDownSmall", "scrollLeftSmall", "scrollRightSmall", "scrollTopLeft", "scrollBottomRight"]],
  ["Window", ["nextDoc", "prevDoc", "cascade", "tile", "docFloating", "docMaximized", "minimizeDoc", "toggleChrome", "togglePalettes", "toggleToolbox", "toggleOptions", "toggleStatus", "paletteBrushes", "paletteColor", "paletteLayers", "paletteInfo", "paletteActions", "showMasks", "showCharacter", "showParagraph", "workspaceSave"]],
  ["Help", ["shortcuts"]],
  ["Painting", ["defaultColors", "swapColors", "brushSmaller", "brushLarger", "brushSofter", "brushHarder"]],
];

/** Menu labels that need their menu's name to make sense in a list of every command. */
function catalogLabel(id: string, label: string): string {
  const l = label.replace(/\.\.\.$/, "");
  if (id.startsWith("purge")) return `Purge ${l}`;
  if (id === "transformAgain") return "Transform Again";
  return l;
}

export class Shortcuts {
  /** Overrides: binding id -> combo ("" = no shortcut). */
  overrides: Record<string, string>;
  private defaults = new Map<string, string>();
  private bindings = new Map<string, UIAction>();
  private toolGroups = new Map<string, ToolId[]>();
  private lastInGroup = new Map<string, ToolId>();
  private map = new Map<string, string>();
  private actionIds = new Map<UIAction, string>();
  onChange: (() => void) | null = null;
  /** Checked before the shortcut map (Actions' function keys). Return true if handled. */
  preHandler: ((combo: string) => boolean) | null = null;

  /** The label of the command a combo runs, if any. */
  ownerOf(combo: string): string | null {
    const id = this.map.get(canonical(combo));
    if (!id) return null;
    if (id.startsWith("tool")) return "a tool";
    return this.bindings.get(id)?.label.replace(/\.\.\.$/, "") ?? null;
  }

  constructor(
    private app: App,
    actions: Actions,
  ) {
    const extra: Record<string, UIAction> = {
      defaultColors: { label: "Default Foreground/Background Colors", shortcut: "D", run: () => void app.run("color.reset") },
      swapColors: { label: "Switch Foreground/Background Colors", shortcut: "X", run: () => void app.run("color.swap") },
      brushSmaller: { label: "Decrease Brush Size", shortcut: "[", run: () => this.brushStep(-1, false) },
      brushLarger: { label: "Increase Brush Size", shortcut: "]", run: () => this.brushStep(1, false) },
      brushSofter: { label: "Decrease Brush Hardness", shortcut: "Shift+[", run: () => this.brushStep(-1, true) },
      brushHarder: { label: "Increase Brush Hardness", shortcut: "Shift+]", run: () => this.brushStep(1, true) },
    };
    for (const [id, a] of [...Object.entries(actions), ...Object.entries(extra)] as [string, UIAction][]) {
      if (typeof a !== "object" || !a) continue;
      this.bindings.set(id, a);
      this.actionIds.set(a, id);
      if (a.shortcut) this.defaults.set(id, canonical(a.shortcut));
    }
    for (const t of Object.values(app.tools)) {
      if (!t.shortcut) continue;
      this.defaults.set(`tool:${t.id}`, t.shortcut);
    }
    this.overrides = storage.load<Record<string, string>>("shortcuts", {});
    this.rebuild();
    setShortcutLookup((a) => {
      const id = this.actionIds.get(a);
      return id ? this.effective(id) : a.shortcut;
    });
  }

  /** Re-read default shortcuts that depend on preferences (the Redo key), and rebuild the key map. */
  refreshDefaults(): void {
    for (const [id, a] of this.bindings) {
      if (a.shortcut) this.defaults.set(id, canonical(a.shortcut));
      else this.defaults.delete(id);
    }
    this.rebuild();
    this.onChange?.();
  }

  effective(id: string): string {
    return id in this.overrides ? this.overrides[id] : (this.defaults.get(id) ?? "");
  }

  private rebuild(): void {
    this.map.clear();
    this.toolGroups.clear();
    const ids = [...this.bindings.keys(), ...Object.keys(this.app.tools).map((t) => `tool:${t}`)];
    for (const id of ids) {
      const combo = this.effective(id);
      if (!combo) continue;
      if (id.startsWith("tool:")) {
        // Tools sharing a key form a group: the key picks, Shift+key cycles.
        const g = this.toolGroups.get(combo) ?? [];
        g.push(id.slice(5) as ToolId);
        this.toolGroups.set(combo, g);
        if (!this.map.has(combo)) this.map.set(combo, `toolgroup:${combo}`);
        if (!/[+]/.test(combo) && !this.map.has(`Shift+${combo}`)) this.map.set(`Shift+${combo}`, `toolcycle:${combo}`);
      } else if (!this.map.has(combo)) this.map.set(combo, id);
    }
  }

  setOverrides(o: Record<string, string>): void {
    this.overrides = { ...o };
    storage.save("shortcuts", this.overrides);
    this.rebuild();
    this.onChange?.();
  }

  /** All binding ids with labels, grouped. */
  catalog(): { category: string; items: { id: string; label: string }[] }[] {
    const out = CATEGORIES.map(([category, ids]) => ({
      category,
      items: ids.filter((id) => this.bindings.has(id)).map((id) => ({ id, label: catalogLabel(id, this.bindings.get(id)!.label) })),
    }));
    out.push({
      category: "Tools",
      items: Object.values(this.app.tools).map((t) => ({ id: `tool:${t.id}`, label: t.label })),
    });
    return out;
  }

  defaultFor(id: string): string {
    return this.defaults.get(id) ?? "";
  }

  private brushStep(dir: number, hardness: boolean): void {
    const b = this.app.activeBrush;
    if (!b) return;
    if (hardness) {
      if (!b.sampled) b.hardness = Math.max(0, Math.min(100, Math.round((b.hardness + dir * 25) / 25) * 25));
    } else {
      const v = b.size;
      // PS7 steps: 1 px under 10, 10 under 100, 25 under 200, 50 above.
      const step = v < 10 || (dir < 0 && v <= 10) ? 1 : v < 100 || (dir < 0 && v <= 100) ? 10 : v < 200 || (dir < 0 && v <= 200) ? 25 : 50;
      b.size = Math.max(1, Math.min(2500, v + dir * step));
    }
    this.app.emit("brushes");
    this.app.emit("overlay");
  }

  /** Global keyboard handling. */
  install(): void {
    const app = this.app;
    window.addEventListener("keydown", (e) => {
      if (e.getModifierState) app.setCapsLock(e.getModifierState("CapsLock"));
      // Holding Ctrl (Cmd on a Mac) borrows the Move tool.
      const free = !e.repeat && !isModalOpen() && !(e.target as HTMLElement).closest?.("input, select, textarea");
      if ((e.key === "Control" || e.key === "Meta") && free) app.holdCtrl(true);
      // Holding Alt with a painting tool borrows the Eyedropper.
      if (e.key === "Alt" && free) app.holdAlt(true);
      if (isModalOpen() || isModifierKey(e)) return;
      const target = e.target as HTMLElement;
      const typing =
        target.closest?.("input, select, textarea") && !(target instanceof HTMLInputElement && (target.type === "range" || target.type === "checkbox" || target.type === "radio"));
      if (typing) return;
      // Nothing but Space while a stroke or drag is in progress.
      if (app.isDragging && e.code !== "Space") {
        e.preventDefault();
        return;
      }
      // The active tool gets first look (Enter / Esc / Backspace for lassos and crop).
      if (app.hasDoc && app.tool.onKey?.(e)) {
        e.preventDefault();
        return;
      }
      const combo = comboOf(e);
      // Space: the Hand tool (Shift or Alt may be held for the tool underneath, e.g. a constrained marquee);
      // Ctrl+Space: the Zoom tool (in), Ctrl+Alt+Space: zoom out, for as long as the keys are held.
      if (e.code === "Space") {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) app.holdZoom(true);
        else app.holdSpace(true);
        return;
      }
      if (!e.repeat && this.preHandler?.(combo)) {
        e.preventDefault();
        return;
      }
      const id = this.map.get(combo);
      if (id) {
        // Native Ctrl+V fires a paste event with the clipboard image; let it through.
        if ((id === "paste" || id === "pasteInto") && /^Ctrl\+(Shift\+)?V$/.test(combo)) {
          pasteIntoNext = id === "pasteInto";
          return;
        }
        e.preventDefault();
        if (id.startsWith("toolgroup:") || id.startsWith("toolcycle:")) {
          const key = id.slice(id.indexOf(":") + 1);
          const group = this.toolGroups.get(key)!;
          const cur = group.includes(app.tool.id) ? app.tool.id : (this.lastInGroup.get(key) ?? group[0]);
          // Preferences > Use Shift Key for Tool Switch: off, pressing the letter again cycles.
          const cycle = (id.startsWith("toolcycle:") && app.prefs.shiftToolSwitch) || (id.startsWith("toolgroup:") && !app.prefs.shiftToolSwitch);
          const next = cycle && group.includes(app.tool.id) ? group[(group.indexOf(cur) + 1) % group.length] : cur;
          this.lastInGroup.set(key, next);
          app.setTool(next);
          return;
        }
        const a = this.bindings.get(id)!;
        if (!a.enabled || a.enabled()) void a.run();
        return;
      }
      // Alt+arrow with the Move tool: nudge a copy (of the selected pixels, or of the layer).
      if (app.doc && e.altKey && !e.ctrlKey && !e.metaKey && combo.replace(/^(Alt\+)?(Shift\+)?/, "").startsWith("Arrow") && app.tool.id === "move") {
        const k = combo.replace(/^(Alt\+)?(Shift\+)?/, "");
        const d = e.shiftKey ? 10 : 1;
        const dx = k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0;
        const dy = k === "ArrowUp" ? -d : k === "ArrowDown" ? d : 0;
        e.preventDefault();
        if (app.doc.selection && app.doc.activeLayer && !app.doc.quickMask) app.run("edit.moveSelection", { dx, dy, duplicate: true });
        else if (app.doc.activeLayer && !app.doc.activeLayer.isBackground) {
          try {
            app.bus.group("Duplicate Layer", () => {
              app.bus.dispatch("layer.duplicate", {});
              app.bus.dispatch("layer.offset", { dx, dy });
            });
          } catch (err) {
            app.toast(`Could not duplicate the layer: ${err instanceof Error ? err.message : String(err)}.`);
          }
        }
        return;
      }
      if (!app.doc || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = combo.replace("Shift+", "");
      if (key.startsWith("Arrow") && app.tool.id === "move") {
        const d = e.shiftKey ? 10 : 1;
        const dx = key === "ArrowLeft" ? -d : key === "ArrowRight" ? d : 0;
        const dy = key === "ArrowUp" ? -d : key === "ArrowDown" ? d : 0;
        const l = app.doc.activeLayer;
        const n = app.doc.activeNode;
        if (app.doc.editMask && n?.mask && !n.maskLinked && !app.doc.quickMask) app.run("layer.offsetMask", { dx, dy });
        else if (app.doc.selection && l && !app.doc.quickMask) app.run("edit.moveSelection", { dx, dy });
        else if (app.doc.activeNode) app.run("layer.offset", { dx, dy });
        e.preventDefault();
        return;
      }
      if (key.startsWith("Arrow") && app.doc.selection && ["marquee", "ellipse", "lasso", "polyLasso", "wand"].includes(app.tool.id)) {
        const d = e.shiftKey ? 10 : 1;
        app.run("select.translate", { dx: key === "ArrowLeft" ? -d : key === "ArrowRight" ? d : 0, dy: key === "ArrowUp" ? -d : key === "ArrowDown" ? d : 0 });
        e.preventDefault();
        return;
      }
      if (/^[0-9]$/.test(key)) {
        if (this.numberKey(key, e.shiftKey)) e.preventDefault();
        return;
      }
      // Enter: the options bar's first number field (opacity, tolerance...), as in Photoshop.
      if (key === "Enter" && !e.shiftKey) {
        const f = document.querySelector<HTMLInputElement>("#optionsbar input[type=number]:not([disabled])");
        if (f) {
          e.preventDefault();
          f.focus();
          f.select();
        }
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.getModifierState) app.setCapsLock(e.getModifierState("CapsLock"));
      if (e.code === "Space") {
        app.holdSpace(false);
        app.holdZoom(false);
      }
      if (e.key === "Control" || e.key === "Meta") app.holdCtrl(false);
      if (e.key === "Alt") {
        app.holdAlt(false);
        // A lone Alt press would otherwise move focus to the browser's menu.
        e.preventDefault();
      }
    });
    window.addEventListener("blur", () => app.releaseHeldKeys());
  }

  /** The number keys: 1 = 10% ... 0 = 100%, two quick digits for any value (4 then 5 = 45%), Shift for flow. */
  private lastDigit: { key: string; at: number; tool: string; shift: boolean } | null = null;
  private numberKey(key: string, shift: boolean): boolean {
    const app = this.app;
    if (!app.doc) return false;
    const t = app.baseTool.id;
    const now = performance.now();
    const prev = this.lastDigit;
    let v = key === "0" ? 100 : +key * 10;
    if (prev && prev.tool === t && prev.shift === shift && now - prev.at < 600) {
      v = +(prev.key + key);
      this.lastDigit = null;
    } else this.lastDigit = { key, at: now, tool: t, shift };
    v = Math.max(1, Math.min(100, v));
    const s = app.settings as unknown as Record<string, number>;
    if (shift) {
      // Flow (the brush tools with a Flow setting).
      const flow = ({ brush: "brushFlow", eraser: "eraserFlow", sponge: "spongeFlow" } as Record<string, string>)[t];
      if (!flow) return false;
      s[flow] = v;
      app.emit("settings");
      app.status(`Flow ${v}%`);
      return true;
    }
    const opacityKey = (
      {
        brush: "brushOpacity",
        pencil: "pencilOpacity",
        eraser: "eraserOpacity",
        bucket: "bucketOpacity",
        gradient: "gradientOpacity",
        stamp: "stampOpacity",
        patternStamp: "patternStampOpacity",
        historyBrush: "historyBrushOpacity",
        artHistory: "artOpacity",
        magicEraser: "magicEraserOpacity",
        dodge: "dodgeExposure",
        burn: "burnExposure",
        sponge: "spongeFlow",
        blur: "blurStrength",
        sharpen: "sharpenStrength",
        smudge: "smudgeStrength",
      } as Record<string, string>
    )[t];
    if (opacityKey) {
      s[opacityKey] = v;
      app.emit("settings");
      const what = /Exposure$/.test(opacityKey) ? "Exposure" : /Strength$/.test(opacityKey) ? "Strength" : /Flow$/.test(opacityKey) ? "Flow" : "Opacity";
      app.status(`${what} ${v}%`);
      return true;
    }
    // Other tools: the layer's opacity.
    if (app.doc.activeNode && !app.doc.activeLayer?.isBackground) {
      if (prev && prev.tool === t && now - prev.at < 600 && app.bus.history.current?.label === "Opacity Change") {
        // The second digit replaces the first one's step.
        void app.historyMove("back").then(() => app.run("layer.setProperties", { opacity: v }));
      } else app.run("layer.setProperties", { opacity: v });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- dialogs

  async editor(): Promise<void> {
    const draft: Record<string, string> = {};
    for (const c of this.catalog()) for (const it of c.items) draft[it.id] = this.effective(it.id);
    const labelOf = new Map<string, string>();
    for (const c of this.catalog()) for (const it of c.items) labelOf.set(it.id, `${c.category} > ${it.label}`);
    const note = el("p", { class: "sc-note", text: "Click a shortcut, then press the new keys. Backspace removes it, Esc cancels." });
    const search = el("input", { type: "text", placeholder: "Search commands", "aria-label": "Search commands", style: "width:100%" });
    const table = el("div", { class: "sc-table" });
    const fields = new Map<string, HTMLButtonElement>();
    const render = () => {
      table.textContent = "";
      const q = search.value.trim().toLowerCase();
      for (const c of this.catalog()) {
        const items = c.items.filter((it) => !q || it.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
        if (!items.length) continue;
        table.append(el("div", { class: "sc-cat", text: c.category }));
        for (const it of items) {
          const b = el("button", { type: "button", class: "sc-field" + (draft[it.id] !== this.defaultFor(it.id) ? " changed" : ""), text: draft[it.id] ? prettyShortcut(draft[it.id]) : "—" });
          fields.set(it.id, b);
          b.addEventListener("click", () => capture(it.id, b));
          table.append(el("div", { class: "sc-row" }, el("span", { text: it.label }), b));
        }
      }
    };
    let stopCapture: (() => void) | null = null;
    const capture = (id: string, b: HTMLButtonElement) => {
      stopCapture?.();
      b.textContent = "Press keys…";
      b.classList.add("capturing");
      const onKey = (e: KeyboardEvent) => {
        if (isModifierKey(e)) return;
        e.preventDefault();
        // Window capture runs before the dialog's own Esc/Enter handling.
        e.stopImmediatePropagation();
        stopCapture?.();
        if (e.key === "Escape") return render();
        let combo = e.key === "Backspace" || e.key === "Delete" ? "" : comboOf(e);
        const isTool = id.startsWith("tool:");
        if (isTool && combo && (/\+/.test(combo) || combo.length !== 1)) {
          note.textContent = "Tool shortcuts must be a single letter or number (tools sharing a letter cycle with Shift).";
          return render();
        }
        if (combo) {
          // Steal the combo from whatever else had it (tools may share letters).
          for (const [other, v] of Object.entries(draft)) {
            if (other !== id && v === combo && !(isTool && other.startsWith("tool:"))) {
              draft[other] = "";
              note.textContent = `${prettyShortcut(combo)} was used by ${labelOf.get(other)}; that shortcut has been removed.`;
            }
          }
        } else combo = "";
        draft[id] = combo;
        render();
      };
      stopCapture = () => {
        window.removeEventListener("keydown", onKey, true);
        b.classList.remove("capturing");
        stopCapture = null;
      };
      window.addEventListener("keydown", onKey, true);
    };
    search.addEventListener("input", render);
    render();
    const body = el("div", { class: "sc-editor" }, search, table, note);
    const r = await modal("Keyboard Shortcuts", body, [
      { label: "OK", value: "ok", default: true },
      { label: "Cancel", value: "cancel" },
      { label: "Defaults", value: "defaults" },
    ], true);
    (stopCapture as (() => void) | null)?.();
    if (r === "defaults") return this.setOverrides({});
    if (r !== "ok") return;
    const o: Record<string, string> = {};
    for (const [id, v] of Object.entries(draft)) if (v !== this.defaultFor(id)) o[id] = v;
    this.setOverrides(o);
  }

  async reference(): Promise<void> {
    const table = el("div", { class: "sc-table" });
    for (const c of this.catalog()) {
      const items = c.items.filter((it) => this.effective(it.id));
      if (!items.length) continue;
      table.append(el("div", { class: "sc-cat", text: c.category }));
      for (const it of items) table.append(el("div", { class: "sc-row" }, el("span", { text: it.label }), el("kbd", { text: prettyShortcut(this.effective(it.id)) })));
    }
    const extra = el("p", {
      class: "sc-note",
      text: "Also: hold Space for the Hand tool, Ctrl for the Move tool, Ctrl+Space (Ctrl+Alt+Space) to zoom in (out), and Alt with a painting tool for the Eyedropper; Space while drawing a marquee moves it. Ctrl-click or Shift-click layers to select several. Number keys set the tool's opacity or strength (two quick digits for any value, Shift for flow), or the layer's opacity. Arrows nudge with the Move tool; Alt+arrows nudge a copy. Enter jumps to the options bar. Caps Lock makes cursors precise. Double-click the Hand tool to fit on screen, the Zoom tool for 100%. Alt+wheel or pinch zooms. In a browser a few Ctrl shortcuts are reserved; the desktop app receives them all.",
    });
    await modal("Keyboard Shortcuts Reference", el("div", { class: "sc-editor" }, table, extra), [{ label: "OK", value: "ok", default: true }], true);
  }
}

/** Set by the keyboard handler when Ctrl+Shift+V triggers a native paste event. */
export let pasteIntoNext = false;
export function consumePasteInto(): boolean {
  const v = pasteIntoNext;
  pasteIntoNext = false;
  return v;
}
