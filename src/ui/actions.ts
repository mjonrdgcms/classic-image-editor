/**
 * UI actions: what menu items and keyboard shortcuts do. Most wrap
 * CommandBus commands (often after a PS7-style dialog); file, view and
 * workspace actions live here. Every action has a stable id, which is what
 * custom keyboard shortcuts refer to.
 */

import type { App } from "../app";
import type { BrushPreset } from "../core/brushes";
import type { ClipboardImage } from "../core/cmd/edit";
import { baseName, decodeImage, encodeImage, isImageName, isOpenableName, pickOpenFile, readPath, saveBytes, type PickedFile } from "../io/files";
import { isProject } from "../io/project";
import { readSystemClipboard, writeSystemClipboard } from "../io/clipboard";
import { aboutDialog, alertDialog, confirmDialog, formDialog, jpegOptionsDialog, newDocumentDialog } from "./dialogs";
import { colorRangeDialog, preferencesDialog } from "./dialogs2";
import { installPeople, peopleDialog } from "./peopleui";
import { installInpaint } from "./healui";
import { definePatternDialog } from "./patternui";
import { patternToJSON } from "../core/patterns";
import { copyLayerStyle, hasCopiedStyle, layerStyleDialog, pasteLayerStyle } from "./styledialog";
import { FX_KEYS, FX_LABELS, type FxKey } from "../core/styles";
import { load as loadSetting, onSaveFailed, save as saveSetting } from "./storage";
import type { MenuItem } from "./menus";
import type { ThemeManager } from "./theme";
import type { FilterRunner } from "./filterrun";
import type { ActionPlayer } from "./actionspal";
import { FILTER_MAP } from "../filters";
import { BLEND_LABELS, BLEND_MODES } from "../core/blend";
import { canFade } from "../core/cmd/filters";
import type { Workspace } from "./workspace";
import type { TypeTool } from "../text/typetool";

export interface UIAction {
  label: string;
  shortcut?: string;
  run(): void | Promise<void>;
  enabled?(): boolean;
  checked?(): boolean;
}

export interface UIHooks {
  themes(): ThemeManager;
  appearance(): Promise<void>;
  workspace(): Workspace;
  shortcutEditor(): Promise<void>;
  shortcutReference(): Promise<void>;
  filters(): FilterRunner;
  player(): ActionPlayer;
}

export function createActions(app: App, ui: UIHooks) {
  const hasDoc = () => app.hasDoc;
  installPeople(app);
  installInpaint(app);
  onSaveFailed((key) =>
    app.toast(
      key === "actions"
        ? "Your Actions could not be saved: the app's storage is full. Recorded Liquify steps can be large; delete ones you don't need."
        : `Could not save your ${key} settings: the app's storage is full.`,
    ),
  );
  const cmd = (name: string, shortcut?: string, params: Record<string, unknown> = {}, label?: string): UIAction => {
    const d = app.bus.get(name);
    return {
      label: label ?? (d && typeof d.label === "string" ? d.label : name),
      shortcut,
      run: () => void app.run(name, params),
      enabled: () => app.hasDoc && app.bus.isEnabled(name),
    };
  };
  /** Open a filter's dialog (or apply it straight away when it has no settings). */
  const openFilter = async (id: string, params?: Record<string, unknown>) => {
    const def = FILTER_MAP.get(id);
    if (!def) return;
    if (!(await app.readyForPixels())) return;
    if (!def.params.length) return void (await ui.filters().apply(id, {}));
    await (await import("./filterlib")).filterLibrary(app, ui.filters(), { filter: id, compact: true, params });
  };
  const FRESH = new Set(["levels", "curves", "colorBalance"]);
  const adj = (id: string, shortcut?: string, immediate = false): UIAction => ({
    label: (FILTER_MAP.get(id)?.name ?? id) + (immediate ? "" : "..."),
    shortcut,
    enabled: () => app.hasDoc && app.bus.isEnabled(`filter.${id}`),
    // Tone adjustments open fresh each time, as in PS; the others remember their last settings.
    run: () =>
      immediate
        ? void ui.filters().apply(id, { ...Object.fromEntries((FILTER_MAP.get(id)?.params ?? []).map((p) => [p.key, p.default])) })
        : openFilter(id, FRESH.has(id) ? Object.fromEntries((FILTER_MAP.get(id)?.params ?? []).map((p) => [p.key, p.default])) : undefined),
  });
  const view = (key: keyof App["view"], label: string, shortcut?: string): UIAction => ({
    label,
    shortcut,
    run: () => app.setView({ [key]: !app.view[key] }),
    checked: () => !!app.view[key],
  });

  const sel = () => app.hasDoc && !!app.doc!.selection;

  const modifyDialog = async (op: "border" | "smooth" | "expand" | "contract") => {
    const titles = { border: ["Border Selection", "Width"], smooth: ["Smooth Selection", "Sample Radius"], expand: ["Expand Selection", "Expand By"], contract: ["Contract Selection", "Contract By"] };
    const [title, label] = titles[op];
    const r = await formDialog(title, [{ key: "amount", label, type: "number", value: op === "border" ? 4 : 2, min: 1, max: 100, step: 1, suffix: "pixels" }]);
    if (r) app.run("select.modify", { op, amount: Math.round(r.amount) });
  };

  const newLayerDialog = async () => {
    const doc = app.doc!;
    const r = await formDialog("New Layer", [
      { key: "name", label: "Name", type: "text", value: doc.nextLayerName() },
      { key: "clip", label: "Group With Previous Layer", type: "checkbox", value: false },
      { key: "mode", label: "Mode", type: "select", value: "normal", options: blendOptions() },
      { key: "opacity", label: "Opacity", type: "number", value: 100, min: 0, max: 100, suffix: "%" },
    ]);
    if (!r) return;
    app.bus.group("New Layer", () => {
      app.bus.dispatch("layer.new", { name: r.name || doc.nextLayerName() });
      if (r.mode !== "normal" || r.opacity !== 100) app.bus.dispatch("layer.setProperties", { blendMode: r.mode, opacity: r.opacity });
      if (r.clip) app.bus.dispatch("layer.clip", { clipped: true });
    });
  };

  const newSetDialog = async () => {
    const doc = app.doc!;
    const r = await formDialog("New Layer Set", [
      { key: "name", label: "Name", type: "text", value: doc.nextName("Set") },
      { key: "mode", label: "Mode", type: "select", value: "passThrough", options: [["passThrough", "Pass Through"], ...blendOptions()] },
      { key: "opacity", label: "Opacity", type: "number", value: 100, min: 0, max: 100, suffix: "%" },
    ]);
    if (!r) return;
    app.bus.group("New Layer Set", () => {
      app.bus.dispatch("layer.newSet", { name: r.name || doc.nextName("Set") });
      if (r.mode !== "passThrough" || r.opacity !== 100) app.bus.dispatch("layer.setProperties", { blendMode: r.mode, opacity: r.opacity });
    });
  };

  const layerPropertiesDialog = async () => {
    const n = app.doc?.activeNode;
    if (!n) return;
    const r = await formDialog(n.kind === "group" ? "Layer Set Properties" : "Layer Properties", [{ key: "name", label: "Name", type: "text", value: n.name }]);
    if (r && r.name && r.name !== n.name) app.run("layer.setProperties", { name: r.name });
  };

  const fillDialog = async () => {
    const r = await formDialog("Fill", [
      {
        key: "use",
        label: "Use",
        type: "select",
        value: "foreground",
        options: [
          ["foreground", "Foreground Color"],
          ["background", "Background Color"],
          ["contentAware", "Content-Aware"],
          ["pattern", "Pattern"],
          ["black", "Black"],
          ["gray", "50% Gray"],
          ["white", "White"],
        ],
      },
      {
        key: "pattern",
        label: "Custom Pattern",
        type: "select",
        value: String(Math.min(app.settings.patternIndex, app.patterns.length - 1)),
        options: app.patterns.map((p, i) => [String(i), p.name]),
      },
      { key: "opacity", label: "Opacity", type: "number", value: 100, min: 1, max: 100, suffix: "%" },
    ]);
    if (!r) return;
    if (r.use === "contentAware") contentAwareFill();
    else if (r.use === "pattern") {
      const p = app.patterns[+r.pattern];
      if (!p) return void alertDialog("Fill", "There are no patterns yet. Select an area and choose Edit > Define Pattern.");
      app.settings.patternIndex = +r.pattern;
      app.run("edit.fill", { use: "pattern", opacity: r.opacity, pattern: patternToJSON(p) });
    } else app.run("edit.fill", { use: r.use, opacity: r.opacity });
  };

  const strokeDialog = async () => {
    const doc = app.doc!;
    if (!doc.selection) return void alertDialog("Stroke", "Make a selection first; Stroke draws along its edge.");
    const hex = (c: readonly number[]) => "#" + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    const last = { width: 2, location: "center", opacity: 100, ...loadSetting<Record<string, unknown>>("stroke", {}) } as { width: number; location: string; opacity: number };
    const r = await formDialog("Stroke", [
      { key: "h1", label: "Stroke", type: "heading" },
      { key: "width", label: "Width", type: "number", value: last.width, min: 1, max: 250, suffix: "px" },
      { key: "color", label: "Color", type: "color", value: hex(doc.foreground) },
      { key: "h2", label: "Location", type: "heading" },
      { key: "location", label: "Location", type: "select", value: last.location, options: [["inside", "Inside"], ["center", "Center"], ["outside", "Outside"]] },
      { key: "h3", label: "Blending", type: "heading" },
      { key: "opacity", label: "Opacity", type: "number", value: last.opacity, min: 1, max: 100, suffix: "%" },
    ]);
    if (!r) return;
    saveSetting("stroke", { width: r.width, location: r.location, opacity: r.opacity });
    const c = String(r.color);
    const rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    app.run("edit.stroke", { width: r.width, location: r.location, use: "custom", color: rgb, opacity: r.opacity });
  };

  const contentAwareFill = () => {
    if (!app.doc?.selection) return void alertDialog("Content-Aware Fill", "Select what you want to remove first (a loose Lasso around it works best), then choose Content-Aware Fill.");
    // A new seed each time, so running it again gives a different fill.
    app.run("edit.contentAwareFill", { sampleAll: false, seed: 1 + Math.floor(Math.random() * 2147483646) });
  };

  const defineBrush = async () => {
    const doc = app.doc!;
    const b = doc.selection?.bounds();
    if (!b) return void alertDialog("Define Brush", "Make a selection around the shape you want as a brush tip first.");
    if (b.w > 1000 || b.h > 1000) return void alertDialog("Define Brush", "The selection is too large for a brush tip (maximum 1000 x 1000 pixels).");
    const r = await formDialog("Brush Name", [{ key: "name", label: "Name", type: "text", value: `Sampled Brush ${app.brushes.filter((x) => x.sampled).length + 1}` }]);
    if (!r) return;
    // Dark pixels of the merged image become opaque; transparency counts as white.
    const px = doc.composite(b);
    const cov = doc.selection!.readRegion(b);
    const data = new Uint8Array(b.w * b.h);
    for (let i = 0, o = 0; i < data.length; i++, o += 4) {
      const a = px[o + 3] / 255;
      const lum = (0.3 * px[o] + 0.59 * px[o + 1] + 0.11 * px[o + 2]) * a + 255 * (1 - a);
      data[i] = Math.round((255 - lum) * (cov[i] / 255));
    }
    const preset: BrushPreset = {
      ...app.toolBrush.brush,
      name: r.name || "Sampled Brush",
      size: Math.max(b.w, b.h),
      hardness: 100,
      sampled: { w: b.w, h: b.h, data },
      spacing: 25,
      angle: 0,
      roundness: 100,
      shape: null,
      scatter: null,
      color: null,
      other: null,
    };
    app.brushes.push(preset);
    app.saveBrushes();
    app.toolBrush.brush = { ...preset };
    app.emit("brushes");
    app.setTool("brush");
    app.status(`Defined brush "${preset.name}"`);
  };

  const copy = async (merged: boolean, cut = false) => {
    if (!app.run(cut ? "edit.cut" : merged ? "edit.copyMerged" : "edit.copy")) return;
    if (app.bus.clipboard) await writeSystemClipboard(app.bus.clipboard);
  };

  const paste = async (into: boolean) => {
    // Prefer an image another program put on the system clipboard.
    await pasteImage(app, into, await readSystemClipboard());
  };

  const addMask = (reveal: string) => () => void app.run("layer.addMask", { reveal });

  const workspaceSave = async () => {
    const ws = ui.workspace();
    const r = await formDialog("Save Workspace", [
      { key: "name", label: "Name", type: "text", value: "" },
      { key: "shortcuts", label: "Include keyboard shortcuts", type: "checkbox", value: true },
    ]);
    if (!r) return;
    const name = String(r.name).trim();
    if (!name) return void alertDialog("Save Workspace", "Please give the workspace a name.");
    if (ws.names().includes(name) && !(await confirmDialog("Save Workspace", `Replace the workspace "${name}"?`, "Replace"))) return;
    ws.saveAs(name, r.shortcuts);
    app.status(`Saved workspace "${name}"`);
  };

  const workspaceDelete = async () => {
    const ws = ui.workspace();
    const names = ws.names();
    if (!names.length) return void alertDialog("Delete Workspace", "There are no saved workspaces.");
    const r = await formDialog("Delete Workspace", [{ key: "name", label: "Workspace", type: "select", value: names[0], options: names.map((n) => [n, n]) }]);
    if (r && (await confirmDialog("Delete Workspace", `Delete the workspace "${r.name}"?`, "Delete"))) ws.deleteNamed(r.name);
  };

  const workspaceExport = async () => {
    const text = ui.workspace().exportJSON();
    const { saveText } = await import("../io/files");
    await saveText(text, "workspace.json");
  };

  const workspaceImport = async () => {
    const { pickText } = await import("../io/files");
    const t = await pickText([".json"]);
    if (!t) return;
    try {
      ui.workspace().importJSON(t);
      app.status("Workspace imported");
    } catch (e) {
      await alertDialog("Import Workspace", (e as Error).message);
    }
  };

  const actions = {
    // File
    new: {
      label: "New...",
      shortcut: "Ctrl+N",
      async run() {
        const o = await newDocumentDialog(app);
        if (o) app.newDocument(o);
      },
    },
    open: {
      label: "Open...",
      shortcut: "Ctrl+O",
      async run() {
        try {
          const f = await pickOpenFile();
          if (f) await openPicked(app, f);
        } catch (e) {
          await alertDialog("Open", (e as Error).message);
        }
      },
    },
    save: { label: "Save", shortcut: "Ctrl+S", enabled: hasDoc, run: () => void app.saveProject(false) },
    saveAs: { label: "Save As...", shortcut: "Ctrl+Shift+S", enabled: hasDoc, run: () => void app.saveProject(true) },
    revert: {
      label: "Revert",
      shortcut: "F12",
      enabled: () => !!app.doc?.filePath && app.isModified,
      async run() {
        const s = app.active;
        const path = s?.doc.filePath;
        if (!s || !path) return;
        if (!(await confirmDialog("Revert", `Go back to the saved version of "${s.doc.name}"? Changes since then are lost.`, "Revert"))) return;
        try {
          const bytes = await readPath(path);
          s.savedStateId = -1;
          await app.closeSession(s);
          await app.openProject(bytes, baseName(path), path);
        } catch (e) {
          await alertDialog("Revert", (e as Error).message);
        }
      },
    },
    close: {
      label: "Close",
      shortcut: "Ctrl+W",
      enabled: hasDoc,
      async run() {
        if (app.active) await app.requestClose(app.active);
      },
    },
    closeAll: {
      label: "Close All",
      shortcut: "Ctrl+Alt+W",
      enabled: hasDoc,
      async run() {
        for (const s of [...app.sessions]) {
          app.activate(s);
          if (!(await app.requestClose(s))) return;
        }
      },
    },
    savePng: { label: "Save a Copy as PNG...", shortcut: "Ctrl+Alt+Shift+S", enabled: hasDoc, run: () => app.save("png") },
    saveJpeg: {
      label: "Save a Copy as JPEG...",
      shortcut: "Ctrl+Alt+S",
      enabled: hasDoc,
      async run() {
        const q = await jpegOptionsDialog();
        if (q !== null) await app.save("jpeg", q);
      },
    },

    // Edit
    undo: {
      get label() {
        const h = app.bus.history;
        if (h.lastWasUndo && h.canRedo()) return `Redo ${h.states[h.index + 1].label}`;
        return h.canUndo() ? `Undo ${h.current!.label}` : "Undo";
      },
      shortcut: "Ctrl+Z",
      enabled: () => app.hasDoc && (app.bus.history.canUndo() || app.bus.history.canRedo()),
      run: () => app.bus.history.toggle(),
    },
    stepForward: { label: "Step Forward", shortcut: "Ctrl+Shift+Z", enabled: () => app.hasDoc && app.bus.history.canRedo(), run: () => app.bus.history.redo() },
    stepBackward: { label: "Step Backward", shortcut: "Ctrl+Alt+Z", enabled: () => app.hasDoc && app.bus.history.canUndo(), run: () => app.bus.history.undo() },
    cut: { label: "Cut", shortcut: "Ctrl+X", enabled: () => sel() && !!app.doc!.activeLayer, run: () => copy(false, true) },
    copy: { label: "Copy", shortcut: "Ctrl+C", enabled: () => app.hasDoc && !!app.doc!.activeLayer, run: () => copy(false) },
    copyMerged: { label: "Copy Merged", shortcut: "Ctrl+Shift+C", enabled: hasDoc, run: () => copy(true) },
    paste: { label: "Paste", shortcut: "Ctrl+V", run: () => paste(false) },
    pasteInto: { label: "Paste Into", shortcut: "Ctrl+Shift+V", enabled: sel, run: () => paste(true) },
    clear: cmd("edit.clear", "Delete"),
    fill: { label: "Fill...", shortcut: "Shift+F5", enabled: () => app.hasDoc && app.bus.isEnabled("edit.fill"), run: fillDialog },
    exportSlices: {
      label: "Slices as PNG...",
      enabled: () => !!app.doc?.slices.length,
      run: async () => {
        const doc = app.doc;
        if (!doc?.slices.length) return;
        const { zipSync } = await import("fflate");
        const files: Record<string, Uint8Array> = {};
        const used = new Set<string>();
        for (const sl of doc.slices) {
          const px = app.compositor.readPixels({ x: sl.x, y: sl.y, w: sl.w, h: sl.h });
          const blob = await encodeImage(new Uint8ClampedArray(px), sl.w, sl.h, "png", 1);
          let name = sl.name.replace(/[\\/:*?"<>|]+/g, "_") || "slice";
          while (used.has(name)) name += "_";
          used.add(name);
          files[`${name}.png`] = new Uint8Array(await blob.arrayBuffer());
        }
        const base = doc.name.replace(/\.[^.]+$/, "");
        const where = await saveBytes(zipSync(files, { level: 0 }), `${base}-slices.zip`, { name: "ZIP archive", ext: "zip" });
        if (where) app.status(`Saved ${doc.slices.length} slices to ${baseName(where)}`);
      },
    },
    definePattern: { label: "Define Pattern...", enabled: hasDoc, run: () => void definePatternDialog(app) },
    stroke: { label: "Stroke...", enabled: () => app.hasDoc && !!app.doc?.selection && app.bus.isEnabled("edit.stroke"), run: strokeDialog },
    contentAwareFill: { label: "Content-Aware Fill", shortcut: "Shift+Backspace", enabled: () => app.hasDoc && !!app.doc?.activeLayer, run: contentAwareFill },
    fillFg: cmd("edit.fill", "Alt+Backspace", { use: "foreground" }, "Fill with Foreground"),
    fillBg: cmd("edit.fill", "Ctrl+Backspace", { use: "background" }, "Fill with Background"),
    defineBrush: { label: "Define Brush...", enabled: sel, run: defineBrush },
    keyboardShortcuts: { label: "Keyboard Shortcuts...", shortcut: "Ctrl+Alt+Shift+K", run: () => ui.shortcutEditor() },
    preferences: { label: "Preferences...", shortcut: "Ctrl+K", run: () => preferencesDialog(app, ui) },

    // Image
    cropToSelection: {
      label: "Crop",
      enabled: sel,
      run: () => {
        const b = app.doc!.selection!.bounds()!;
        app.run("image.crop", { ...b });
      },
    },
    invert: cmd("image.invert", "Ctrl+I"),
    desaturate: cmd("image.desaturate", "Ctrl+Shift+U"),
    flatten: cmd("image.flatten"),

    // Layer
    newLayer: { label: "Layer...", shortcut: "Ctrl+Shift+N", enabled: hasDoc, run: newLayerDialog },
    newLayerQuick: { ...cmd("layer.new", "Ctrl+Alt+Shift+N"), label: "New Layer (no dialog)" },
    newSet: { label: "Layer Set...", enabled: hasDoc, run: newSetDialog },
    newSetFromLinked: cmd("layer.newSetFrom", undefined, {}, "Layer Set From Linked..."),
    newSetFromSelected: {
      label: "Layer Set From Selected Layers",
      shortcut: "Ctrl+Alt+G",
      enabled: () => !!app.doc && app.doc.selectedLayers.some((l) => !l.isBackground),
      run: () => {
        const ids = app.doc!.selectedLayers.filter((l) => !l.isBackground).map((l) => l.id);
        app.run("layer.newSetFrom", { ids });
      },
    },
    linkSelected: {
      label: "Link Layers",
      enabled: () => (app.doc?.selectedLayers.length ?? 0) > 1,
      run: () => {
        const ls = app.doc!.selectedLayers;
        const linked = ls.every((l) => l.linkId !== null && l.linkId === ls[0].linkId);
        app.run("layer.link", { ids: ls.map((l) => l.id), linked: !linked });
      },
    },
    ...(Object.fromEntries(
      (["top", "vcenter", "bottom", "left", "hcenter", "right"] as const).flatMap((e) => {
        const name = { top: "Top Edges", vcenter: "Vertical Centers", bottom: "Bottom Edges", left: "Left Edges", hcenter: "Horizontal Centers", right: "Right Edges" }[e];
        return [
          [`align_${e}`, { ...cmd("layer.align", undefined, { edge: e }, name), enabled: () => app.hasDoc && app.bus.isEnabled("layer.align") }],
          [`distribute_${e}`, { ...cmd("layer.distribute", undefined, { edge: e }, name), enabled: () => app.hasDoc && app.bus.isEnabled("layer.distribute") }],
        ];
      }),
    ) as Record<`${"align" | "distribute"}_${"top" | "vcenter" | "bottom" | "left" | "hcenter" | "right"}`, UIAction>),
    fromBackground: cmd("layer.fromBackground", undefined, {}, "Layer From Background..."),
    layerViaCopy: cmd("layer.newViaCopy", "Ctrl+J"),
    layerViaCut: cmd("layer.newViaCut", "Ctrl+Shift+J"),
    duplicateLayer: { ...cmd("layer.duplicate"), label: "Duplicate Layer..." },
    deleteLayer: { label: "Delete Layer", enabled: () => app.hasDoc && app.bus.isEnabled("layer.delete"), run: () => void app.run("layer.delete") },
    layerProperties: { label: "Layer Properties...", enabled: () => !!app.doc?.activeNode, run: layerPropertiesDialog },
    maskRevealAll: { label: "Reveal All", enabled: () => app.hasDoc && app.bus.isEnabled("layer.addMask"), run: addMask("all") },
    maskHideAll: { label: "Hide All", enabled: () => app.hasDoc && app.bus.isEnabled("layer.addMask"), run: addMask("none") },
    maskRevealSel: { label: "Reveal Selection", enabled: () => sel() && app.bus.isEnabled("layer.addMask"), run: addMask("selection") },
    maskHideSel: { label: "Hide Selection", enabled: () => sel() && app.bus.isEnabled("layer.addMask"), run: addMask("hideSelection") },
    maskDelete: cmd("layer.removeMask", undefined, { apply: false }, "Discard"),
    maskApply: cmd("layer.removeMask", undefined, { apply: true }, "Apply"),
    maskToggle: {
      get label() {
        const n = app.doc?.activeNode;
        return n?.mask && !n.maskEnabled ? "Enable Layer Mask" : "Disable Layer Mask";
      },
      shortcut: "Shift+Alt+\\",
      enabled: () => !!app.doc?.activeNode?.mask,
      run: () => void app.run("layer.setMaskEnabled", { enabled: !app.doc!.activeNode!.maskEnabled }),
    },
    editMask: {
      label: "Edit Layer Mask",
      shortcut: "Ctrl+\\",
      // A set has no pixels to switch back to.
      enabled: () => !!app.doc?.activeNode?.mask && !(app.doc.editMask && app.doc.activeNode.kind === "group"),
      checked: () => !!app.doc?.editMask,
      run: () => void app.run("layer.editMask", { edit: !app.doc!.editMask }),
    },
    editLayer: {
      label: "Edit Layer Pixels",
      shortcut: "Ctrl+`",
      enabled: () => !!app.doc?.activeNode?.mask && app.doc.editMask && app.doc.activeNode.kind === "layer",
      run: () => void app.run("layer.editMask", { edit: false }),
    },
    maskFromTransparency: {
      label: "From Transparency",
      enabled: () => app.hasDoc && app.bus.isEnabled("layer.addMask") && app.doc!.activeNode?.kind === "layer",
      run: addMask("transparency"),
    },
    maskLinkToggle: {
      get label() {
        const n = app.doc?.activeNode;
        return n?.mask && !n.maskLinked ? "Link Mask to Layer" : "Unlink Mask from Layer";
      },
      enabled: () => !!app.doc?.activeNode?.mask,
      run: () => void app.run("layer.setMaskProperties", { linked: !app.doc!.activeNode!.maskLinked }),
    },
    maskInvert: { label: "Invert Mask", enabled: () => !!app.doc?.activeNode?.mask, run: () => void app.run("layer.invertMask") },
    maskEdge: {
      label: "Mask Edge...",
      enabled: () => !!app.doc?.activeNode?.mask,
      run: async () => (await import("./maskui")).maskEdgeDialog(app),
    },
    maskFromSelection: {
      label: "Mask from Selection",
      enabled: () => sel() && !!app.doc!.activeNode?.mask,
      run: () => void app.run("layer.maskFromSelection", { mode: "replace" }),
    },
    loadMaskSelection: {
      label: "Load Mask as Selection",
      shortcut: "Ctrl+Alt+\\",
      enabled: () => !!app.doc?.activeNode?.mask,
      run: () => void app.run("select.fromMask", { mode: "replace" }),
    },
    loadTransparency: {
      label: "Load Layer Transparency",
      enabled: () => app.doc?.activeNode?.kind === "layer",
      run: () => void app.run("select.fromTransparency", { mode: "replace" }),
    },
    maskOverlayToggle: {
      label: "Show Mask as Overlay",
      shortcut: "\\",
      enabled: () => !!app.doc?.activeNode?.mask && !app.doc.quickMask,
      checked: () => app.maskView === "overlay",
      run: () => app.setMaskView(app.maskView === "overlay" ? "off" : "overlay"),
    },
    maskViewGray: {
      label: "Show Mask Only",
      enabled: () => !!app.doc?.activeNode?.mask && !app.doc.quickMask,
      checked: () => app.maskView === "gray",
      run: () => app.setMaskView(app.maskView === "gray" ? "off" : "gray"),
    },
    maskOptions: {
      label: "Layer Mask Display Options...",
      enabled: hasDoc,
      run: async () => (await import("./maskui")).maskDisplayOptions(app),
    },
    loadSelection: {
      label: "Load Selection...",
      enabled: () => !!app.doc?.activeNode,
      async run() {
        const doc = app.doc!;
        const n = doc.activeNode!;
        const sources: [string, string][] = [];
        if (n.mask) sources.push(["mask", `${n.name} Mask`]);
        sources.push(["transparency", `${n.name} Transparency`]);
        const modes: [string, string][] = [["replace", "New Selection"]];
        if (doc.selection) modes.push(["add", "Add to Selection"], ["subtract", "Subtract from Selection"], ["intersect", "Intersect with Selection"]);
        const r = await formDialog("Load Selection", [
          { key: "source", label: "Channel", type: "select", value: sources[0][0], options: sources },
          { key: "invert", label: "Invert", type: "checkbox", value: false },
          { key: "mode", label: "Operation", type: "select", value: "replace", options: modes },
        ]);
        if (!r) return;
        app.run(r.source === "mask" ? "select.fromMask" : "select.fromTransparency", { id: n.id, mode: r.mode, invert: !!r.invert });
      },
    },
    rasterizeType: { label: "Type", enabled: () => !!app.doc?.activeLayer?.text, run: () => void app.run("layer.rasterizeType") },
    rasterizeTypeLayer: { label: "Rasterize Type", enabled: () => !!app.doc?.activeLayer?.text, run: () => void app.run("layer.rasterizeType") },
    typeConvert: {
      get label() {
        return app.doc?.activeLayer?.text?.box ? "Convert to Point Text" : "Convert to Paragraph Text";
      },
      enabled: () => !!app.doc?.activeLayer?.text,
      run: () => {
        const l = app.doc!.activeLayer!;
        if (l.text!.box) app.run("type.edit", { pointText: true });
        else app.run("type.edit", { box: { w: Math.max(20, Math.ceil(l.grid.width)), h: Math.max(20, Math.ceil(l.grid.height)) } });
      },
    },
    editText: {
      label: "Edit Text",
      enabled: () => !!app.doc?.activeLayer?.text,
      run: () => {
        app.setTool("type");
        (app.tools.type as TypeTool).editLayer(app.doc!.activeLayerId);
      },
    },
    showCharacter: { label: "Character", run: () => ui.workspace().showTogether(["character", "paragraph"]) },
    showParagraph: { label: "Paragraph", run: () => ui.workspace().showTogether(["paragraph", "character"]) },
    showMasks: { label: "Masks", run: () => ui.workspace().show("masks") },
    groupWithPrevious: cmd("layer.clip", "Ctrl+G", { clipped: true }, "Group with Previous"),
    ungroup: { ...cmd("layer.clip", "Ctrl+Shift+G", { clipped: false }, "Ungroup"), enabled: () => !!app.doc?.activeLayer?.clipped },
    bringToFront: cmd("layer.arrange", "Ctrl+Shift+]", { to: "front" }, "Bring to Front"),
    bringForward: cmd("layer.arrange", "Ctrl+]", { to: "forward" }, "Bring Forward"),
    sendBackward: cmd("layer.arrange", "Ctrl+[", { to: "backward" }, "Send Backward"),
    sendToBack: cmd("layer.arrange", "Ctrl+Shift+[", { to: "back" }, "Send to Back"),
    mergeDown: {
      get label() {
        return app.doc?.activeNode?.kind === "group" ? "Merge Layer Set" : "Merge Down";
      },
      shortcut: "Ctrl+E",
      enabled: () => app.hasDoc && app.bus.isEnabled("layer.mergeDown"),
      run: () => void app.run("layer.mergeDown"),
    },
    mergeVisible: cmd("layer.mergeVisible", "Ctrl+Shift+E"),

    // Select
    selectAll: cmd("select.all", "Ctrl+A"),
    deselect: cmd("select.none", "Ctrl+D"),
    reselect: cmd("select.reselect", "Ctrl+Shift+D"),
    inverse: cmd("select.inverse", "Ctrl+Shift+I"),
    selectAllLayers: cmd("layer.selectAll", "Ctrl+Alt+A", {}, "All Layers"),
    deselectLayers: cmd("layer.selectAll", undefined, { none: true }, "Deselect Layers"),
    grow: {
      label: "Grow",
      enabled: () => !!app.doc?.selection,
      run: () => void app.run("select.grow", { tolerance: app.settings.wandTolerance, sampleMerged: app.settings.wandSampleMerged }),
    },
    similar: {
      label: "Similar",
      enabled: () => !!app.doc?.selection,
      run: () => void app.run("select.similar", { tolerance: app.settings.wandTolerance, sampleMerged: app.settings.wandSampleMerged }),
    },
    colorRange: { label: "Color Range...", enabled: hasDoc, run: () => colorRangeDialog(app) },
    styleBlending: { label: "Blending Options...", enabled: () => !!app.doc?.activeLayer, run: () => void layerStyleDialog(app) },
    ...(Object.fromEntries(
      FX_KEYS.map((k) => [`style_${k}`, { label: FX_LABELS[k] + "...", enabled: () => !!app.doc?.activeLayer, run: () => void layerStyleDialog(app, k) }]),
    ) as Record<`style_${FxKey}`, UIAction>),
    copyStyle: { label: "Copy Layer Style", enabled: () => !!app.doc?.activeLayer?.style, run: () => copyLayerStyle(app) },
    pasteStyle: { label: "Paste Layer Style", enabled: () => !!app.doc?.activeLayer && hasCopiedStyle(), run: () => pasteLayerStyle(app) },
    clearStyle: { label: "Clear Layer Style", enabled: () => !!app.doc?.activeLayer?.style, run: () => void app.run("layer.setStyle", { style: null }) },
    rasterizeStyle: cmd("layer.rasterizeStyle", undefined, {}, "Layer Style"),
    rasterizeShape: cmd("layer.rasterizeShape", undefined, {}, "Shape"),
    shapeColor: {
      label: "Change Shape Color...",
      enabled: () => !!app.doc?.activeLayer?.shape,
      run: () => void import("./palettes").then((m) => m.shapeColorDialog(app, app.doc!.activeLayer!.id)),
    },
    removeBackground: {
      label: "Remove Background",
      enabled: () => !!app.doc?.activeLayer && !app.doc.activeLayer.mask,
      run: async () => {
        const doc = app.doc;
        if (!doc) return;
        try {
          const pending = app.bus.prepare("select.subject", { mode: "replace" });
          if (pending) await pending;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (err.name !== "AbortError") app.toast(`Could not find the subject: ${err.message}`);
          return;
        }
        if (app.doc !== doc) return;
        try {
          app.bus.group("Remove Background", () => {
            if (doc.activeLayer?.isBackground) app.bus.dispatch("layer.fromBackground", {});
            app.bus.dispatch("select.subject", { mode: "replace" });
            app.bus.dispatch("layer.addMask", { reveal: "selection" });
            app.bus.dispatch("select.none", {});
          });
          app.toast("Background hidden with a layer mask. Paint on the mask to fix edges, or Shift-click it to turn it off.");
        } catch (e) {
          app.toast(`Remove Background: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    selectSubject: { label: "Subject", enabled: hasDoc, run: () => void app.run("select.subject", { mode: "replace" }) },
    selectPeople: { label: "People...", enabled: hasDoc, run: () => void peopleDialog(app) },
    feather: {
      label: "Feather...",
      shortcut: "Ctrl+Alt+D",
      enabled: sel,
      async run() {
        const r = await formDialog("Feather Selection", [{ key: "radius", label: "Feather Radius", type: "number", value: 5, min: 0.2, max: 250, suffix: "pixels" }]);
        if (r) app.run("select.feather", { radius: r.radius });
      },
    },
    border: { label: "Border...", enabled: sel, run: () => modifyDialog("border") },
    smooth: { label: "Smooth...", enabled: sel, run: () => modifyDialog("smooth") },
    expand: { label: "Expand...", enabled: sel, run: () => modifyDialog("expand") },
    contract: { label: "Contract...", enabled: sel, run: () => modifyDialog("contract") },
    quickMask: {
      label: "Edit in Quick Mask Mode",
      shortcut: "Q",
      enabled: hasDoc,
      checked: () => !!app.doc?.quickMask,
      run: () => void app.run("select.quickMask", { on: !app.doc!.quickMask }),
    },

    // View
    zoomIn: { label: "Zoom In", shortcut: "Ctrl+=", enabled: hasDoc, run: () => app.zoomStep(1) },
    zoomOut: { label: "Zoom Out", shortcut: "Ctrl+-", enabled: hasDoc, run: () => app.zoomStep(-1) },
    fit: { label: "Fit on Screen", shortcut: "Ctrl+0", enabled: hasDoc, run: () => app.fitOnScreen() },
    actual: { label: "Actual Pixels", shortcut: "Ctrl+Alt+0", enabled: hasDoc, run: () => app.actualPixels() },
    extras: view("extras", "Extras", "Ctrl+H"),
    showSelection: view("selectionEdges", "Selection Edges"),
    showGuides: view("guides", "Guides", "Ctrl+;"),
    showGrid: view("grid", "Grid", "Ctrl+'"),
    rulers: view("rulers", "Rulers", "Ctrl+R"),
    snap: view("snap", "Snap", "Ctrl+Shift+;"),
    lockGuides: view("lockGuides", "Lock Guides", "Ctrl+Alt+;"),
    clearGuides: cmd("guide.clear"),
    newGuide: {
      label: "New Guide...",
      enabled: hasDoc,
      async run() {
        const r = await formDialog("New Guide", [
          { key: "orientation", label: "Orientation", type: "select", value: "horizontal", options: [["horizontal", "Horizontal"], ["vertical", "Vertical"]] },
          { key: "position", label: "Position", type: "number", value: 0, suffix: "px" },
        ]);
        if (r) app.run("guide.add", { orientation: r.orientation, position: r.position });
      },
    },
    screenStandard: { label: "Standard Screen Mode", checked: () => app.screenMode === "standard", run: () => app.setScreenMode("standard") },
    screenFullMenu: { label: "Full Screen Mode with Menu Bar", checked: () => app.screenMode === "fullMenu", run: () => app.setScreenMode("fullMenu") },
    screenFull: { label: "Full Screen Mode", checked: () => app.screenMode === "full", run: () => app.setScreenMode("full") },
    cycleScreen: {
      label: "Cycle Screen Modes",
      shortcut: "F",
      run: () => app.setScreenMode(app.screenMode === "standard" ? "fullMenu" : app.screenMode === "fullMenu" ? "full" : "standard"),
    },
    appearance: { label: "Customize Appearance...", run: () => ui.appearance() },

    // Window
    toggleChrome: { label: "Show/Hide Palettes", shortcut: "Tab", run: () => ui.workspace().toggleAllChrome() },
    toggleToolbox: { label: "Tools", checked: () => ui.workspace().layout.toolbox.visible, run: () => ui.workspace().setToolboxVisible(!ui.workspace().layout.toolbox.visible) },
    toggleOptions: { label: "Options", checked: () => ui.workspace().layout.optionsBar, run: () => ui.workspace().setOptionsBar(!ui.workspace().layout.optionsBar) },
    toggleStatus: { label: "Status Bar", checked: () => ui.workspace().layout.statusBar, run: () => ui.workspace().setStatusBar(!ui.workspace().layout.statusBar) },
    workspaceSave: { label: "Save Workspace...", run: workspaceSave },
    workspaceDelete: { label: "Delete Workspace...", run: workspaceDelete },
    workspaceReset: { label: "Reset Palette Locations", run: () => ui.workspace().reset() },
    workspaceExport: { label: "Export Workspace...", run: workspaceExport },
    workspaceImport: { label: "Import Workspace...", run: workspaceImport },

    // Document windows
    nextDoc: { label: "Next Image", shortcut: "Ctrl+Tab", enabled: () => app.sessions.length > 1, run: () => app.cycleDocument(1) },
    prevDoc: { label: "Previous Image", shortcut: "Ctrl+Shift+Tab", enabled: () => app.sessions.length > 1, run: () => app.cycleDocument(-1) },
    cascade: { label: "Cascade", enabled: hasDoc, run: () => app.windows.cascade() },
    tile: { label: "Tile", enabled: hasDoc, run: () => app.windows.tile() },
    docFloating: {
      label: "Floating Image Windows",
      checked: () => app.windows.mode === "floating",
      run: () => app.windows.setMode("floating"),
    },
    docMaximized: {
      label: "Maximized (Tabbed) Image Windows",
      checked: () => app.windows.mode === "maximized",
      run: () => app.windows.setMode("maximized"),
    },
    minimizeDoc: {
      label: "Minimize",
      enabled: () => !!app.active && app.windows.mode === "floating",
      run: () => {
        if (app.active) app.windows.setMinimized(app.active.win, !app.active.win.minimized);
      },
    },

    // Filters
    lastFilter: {
      get label() {
        const l = ui.filters().last;
        return l ? `Last Filter: ${FILTER_MAP.get(l.id)?.name ?? l.id}` : "Last Filter";
      },
      shortcut: "Ctrl+F",
      enabled: () => !!ui.filters().last && app.hasDoc,
      run: () => {
        const l = ui.filters().last;
        if (l) void ui.filters().apply(l.id, l.params);
      },
    },
    lastFilterDialog: {
      label: "Last Filter with Dialog...",
      shortcut: "Ctrl+Alt+F",
      enabled: () => !!ui.filters().last && app.hasDoc,
      run: () => {
        const l = ui.filters().last;
        if (l) return openFilter(l.id, l.params);
      },
    },
    freeTransform: { label: "Free Transform", shortcut: "Ctrl+T", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer") },
    tScale: { label: "Scale", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer", "scale") },
    tRotate: { label: "Rotate", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer", "rotate") },
    tSkew: { label: "Skew", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer", "skew") },
    tDistort: { label: "Distort", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer", "distort") },
    tPerspective: { label: "Perspective", enabled: () => !!app.doc?.activeLayer, run: async () => void (await import("../tools/transformtool")).startTransform(app, "layer", "perspective") },
    tRot180: { label: "Rotate 180°", enabled: () => !!app.doc?.activeLayer, run: async () => (await import("../tools/transformtool")).quickTransform(app, "rotate180") },
    tRotCW: { label: "Rotate 90° CW", enabled: () => !!app.doc?.activeLayer, run: async () => (await import("../tools/transformtool")).quickTransform(app, "rotateCW") },
    tRotCCW: { label: "Rotate 90° CCW", enabled: () => !!app.doc?.activeLayer, run: async () => (await import("../tools/transformtool")).quickTransform(app, "rotateCCW") },
    tFlipH: { label: "Flip Horizontal", enabled: () => !!app.doc?.activeLayer, run: async () => (await import("../tools/transformtool")).quickTransform(app, "flipH") },
    tFlipV: { label: "Flip Vertical", enabled: () => !!app.doc?.activeLayer, run: async () => (await import("../tools/transformtool")).quickTransform(app, "flipV") },
    transformSelection: { label: "Transform Selection", enabled: () => !!app.doc?.selection, run: async () => void (await import("../tools/transformtool")).startTransform(app, "selection") },
    imageSize: { label: "Image Size...", shortcut: "Ctrl+Alt+I", enabled: hasDoc, run: async () => (await import("./imagedialogs")).imageSizeDialog(app) },
    canvasSize: { label: "Canvas Size...", shortcut: "Ctrl+Alt+C", enabled: hasDoc, run: async () => (await import("./imagedialogs")).canvasSizeDialog(app) },
    rotate180: cmd("image.rotate", undefined, { angle: 180 }, "180°"),
    rotateCW: cmd("image.rotate", undefined, { angle: 90 }, "90° CW"),
    rotateCCW: cmd("image.rotate", undefined, { angle: -90 }, "90° CCW"),
    rotateArbitrary: { label: "Arbitrary...", enabled: hasDoc, run: async () => (await import("./imagedialogs")).rotateArbitraryDialog(app) },
    flipCanvasH: cmd("image.flip", undefined, { direction: "horizontal" }, "Flip Canvas Horizontal"),
    flipCanvasV: cmd("image.flip", undefined, { direction: "vertical" }, "Flip Canvas Vertical"),
    trim: { label: "Trim...", enabled: hasDoc, run: async () => (await import("./imagedialogs")).trimDialog(app) },
    duplicateImage: { label: "Duplicate...", enabled: hasDoc, run: async () => (await import("./imagedialogs")).duplicateImageDialog(app) },
    liquify: {
      label: "Liquify...",
      shortcut: "Ctrl+Shift+X",
      enabled: () => !!app.doc?.activeLayer,
      run: async () => void (await import("./liquify")).liquifyDialog(app),
    },
    filterLibrary: { label: "Filter Library...", shortcut: "Ctrl+Alt+Shift+X", run: async () => void ((await app.readyForPixels()) && (await import("./filterlib")).filterLibrary(app, ui.filters())) },
    fade: {
      get label() {
        const n = canFade(app.doc, app.bus);
        return n ? `Fade ${n}...` : "Fade...";
      },
      shortcut: "Ctrl+Shift+F",
      enabled: () => !!canFade(app.doc, app.bus),
      run: async () => {
        const name = canFade(app.doc, app.bus);
        if (!name) return;
        const r = await formDialog(`Fade ${name}`, [
          { key: "opacity", label: "Opacity", type: "number", value: 50, min: 0, max: 100, step: 1, suffix: "%" },
          { key: "mode", label: "Mode", type: "select", value: "normal", options: BLEND_MODES.filter((m) => m !== "dissolve").map((m) => [m, BLEND_LABELS[m]]) },
        ]);
        if (r) app.run("filter.fade", { opacity: r.opacity, mode: r.mode });
      },
    },
    bwLab: {
      label: "Black & White Lab...",
      shortcut: "Ctrl+Alt+Shift+B",
      enabled: hasDoc,
      run: async () => void ((await app.readyForPixels(true)) && (await import("./bwlab")).blackWhiteLab(app)),
    },
    hueSaturation: adj("hueSaturation", "Ctrl+U"),
    brightnessContrast: adj("brightnessContrast"),
    levels: adj("levels", "Ctrl+L"),
    curves: adj("curves", "Ctrl+M"),
    colorBalance: adj("colorBalance", "Ctrl+B"),
    photoFilter: adj("photoFilter"),
    histogram: { label: "Histogram...", enabled: hasDoc, run: async () => (await import("./histogram")).histogramDialog(app) },
    autoLevels: adj("autoLevels", "Ctrl+Shift+L", true),
    autoContrast: adj("autoContrast", "Ctrl+Alt+Shift+L", true),
    equalize: adj("equalize", undefined, true),
    threshold: adj("threshold"),
    posterize: adj("posterizeFx"),
    gradientMap: adj("gradientMap"),
    channelMixer: adj("channelMixer"),
    shadowsHighlights: adj("shadowsHighlights"),
    exposure: adj("exposure"),
    whiteBalance: adj("temperature"),
    vibrance: adj("vibranceFx"),

    // Automate
    batch: { label: "Batch...", run: async () => void (await import("./batch")).batchDialog(app, ui.player()) },

    // Help
    shortcuts: { label: "Keyboard Shortcuts Reference...", shortcut: "F1", run: () => ui.shortcutReference() },
    about: { label: "About Classic Image Editor...", run: () => aboutDialog() },
    aiModels: { label: "AI Models...", run: async () => (await import("./aimodels")).manageModels(app) },
  } satisfies Record<string, UIAction>;

  return Object.assign(actions, { openFilter });
}

export type Actions = ReturnType<typeof createActions>;

/**
 * Paste: `sys` is an image from the system clipboard (or null to use the
 * editor's own clipboard). With no document open, a new one is made.
 */
export async function pasteImage(app: App, into: boolean, sys: ClipboardImage | null): Promise<void> {
  if (sys) app.bus.setClipboard(sys, true);
  const c = app.bus.clipboard;
  if (!c) return void app.toast("There is nothing to paste.");
  if (!app.hasDoc) {
    app.newDocument({ name: app.nextUntitledName(), width: c.w, height: c.h, contents: "transparent" });
    app.doc!.activeLayer!.grid.writeRegion({ x: 0, y: 0, w: c.w, h: c.h }, c.data);
    app.bus.history.reset(app.doc!, "New");
    app.doc!.dirty(null);
    return;
  }
  app.run("edit.paste", { into });
}

export function blendOptions(): [string, string][] {
  return [
    ["normal", "Normal"], ["dissolve", "Dissolve"], ["darken", "Darken"], ["multiply", "Multiply"], ["colorBurn", "Color Burn"],
    ["linearBurn", "Linear Burn"], ["lighten", "Lighten"], ["screen", "Screen"], ["colorDodge", "Color Dodge"], ["linearDodge", "Linear Dodge"],
    ["overlay", "Overlay"], ["softLight", "Soft Light"], ["hardLight", "Hard Light"], ["vividLight", "Vivid Light"], ["linearLight", "Linear Light"],
    ["pinLight", "Pin Light"], ["difference", "Difference"], ["exclusion", "Exclusion"], ["hue", "Hue"], ["saturation", "Saturation"],
    ["color", "Color"], ["luminosity", "Luminosity"],
  ];
}

/** Open the first image from a list of dropped files. */
/** Open every image in a list of dropped files, each in its own window. */
/** File > Open Recent. */
export function recentMenu(app: App): MenuItem {
  return {
    label: "Open Recent",
    submenu: () => {
      const list = app.recentFiles;
      if (!list.length) return [{ label: "No recent files", enabled: false }];
      return [
        ...list.map((path, i) => ({
          label: `${i + 1}. ${baseName(path)}`,
          run: async () => {
            try {
              await openPicked(app, { name: baseName(path), path, bytes: await readPath(path) });
            } catch (e) {
              await alertDialog("Open Recent", `Could not open "${baseName(path)}": ${(e as Error).message}`);
            }
          },
        })),
        "-" as const,
        { label: "Clear Recent", run: () => app.clearRecent() },
      ];
    },
  };
}

/** Open a picked file: a .cie project or a picture. */
export async function openPicked(app: App, f: PickedFile): Promise<void> {
  if (f.name.toLowerCase().endsWith(".cie") || isProject(f.bytes)) await app.openProject(f.bytes, f.name, f.path);
  else {
    app.openImage(await decodeImage(new Blob([f.bytes as BlobPart]), f.name));
    if (f.path) app.addRecent(f.path);
  }
}

export async function openDropped(app: App, files: FileList): Promise<void> {
  for (const f of [...files].filter((f) => isImageName(f.name) || isOpenableName(f.name) || f.type.startsWith("image/"))) {
    try {
      await openPicked(app, { name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
    } catch (e) {
      await alertDialog("Open", (e as Error).message);
    }
  }
}

