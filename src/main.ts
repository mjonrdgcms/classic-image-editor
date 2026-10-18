import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-400-italic.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "./style.css";
import { App } from "./app";
import { imageFromPasteEvent } from "./io/clipboard";
import { createActions, openDropped, openPicked, pasteImage } from "./ui/actions";
import { baseName, isDesktop, launchFiles, readPath } from "./io/files";
import { appearanceDialog } from "./ui/appearance";
import { alertDialog, confirmDialog, el, modal } from "./ui/dialogs";
import { buildMenus } from "./ui/menudefs";
import { mountMenuBar } from "./ui/menus";
import { mountOptionsBar } from "./ui/optionsbar";
import { Overlay } from "./ui/overlay";
import { paletteDefs } from "./ui/palettes";
import { mountRulers } from "./ui/rulers";
import { Shortcuts, consumePasteInto } from "./ui/shortcuts";
import { ThemeManager } from "./ui/theme";
import { FilterOrg } from "./ui/filterorg";
import { FilterRunner } from "./ui/filterrun";
import { ActionStore } from "./ui/actionstore";
import { ActionPlayer, actionsPalette, setFilterRunner } from "./ui/actionspal";
import { filterLibrary } from "./ui/filterlib";
import { blackWhiteLab } from "./ui/bwlab";
import { mountToolbox } from "./ui/toolbox";
import { Workspace } from "./ui/workspace";
import { TextSpec, rerenderTextLayers, setTextRenderer } from "./core/text";
import { ensureFont, fontReady, nearestWeight, registerBundledFonts } from "./text/fonts";
import { renderText } from "./text/render";

const $ = (id: string) => document.getElementById(id)!;

function boot(): void {
  // Colors first, so nothing flashes in the wrong theme.
  const themes = new ThemeManager();
  themes.apply();
  let app: App;
  try {
    app = new App($("docarea"));
  } catch (e) {
    $("welcome").innerHTML = "";
    $("welcome").append(el("div", {}, el("h1", { text: "Graphics not available" }), el("p", { text: (e as Error).message })));
    return;
  }
  // Type: the bundled font library and the canvas text renderer. A layer
  // drawn before its font finished loading is redrawn once it arrives.
  registerBundledFonts();
  const waiting = new Set<string>();
  const failed = new Set<string>();
  const keyOf = (t: TextSpec) => `${t.font}|${nearestWeight(t.font, t.weight, t.italic)}|${t.italic}`;
  const ready = (t: TextSpec) => failed.has(keyOf(t)) || fontReady(t.font, nearestWeight(t.font, t.weight, t.italic), t.italic, t.content);
  setTextRenderer((t) => {
    const bmp = renderText(t);
    if (!ready(t)) {
      bmp.fallback = true;
      const key = keyOf(t);
      if (!waiting.has(key)) {
        waiting.add(key);
        void ensureFont(t.font, nearestWeight(t.font, t.weight, t.italic), t.italic, t.content).then((ok) => {
          waiting.delete(key);
          if (!ok) failed.add(key);
          for (const s of app.sessions) rerenderTextLayers(s.doc, ready);
        });
      }
    }
    return bmp;
  });
  void ensureFont("Inter", 400, false);

  // Each image window gets its own overlay (selection edges, guides) and rulers.
  app.onSessionCreated = (s) => {
    new Overlay(app, s);
    // Undo / redo can bring back text drawn before its font loaded: redraw it.
    s.doc.on((ev) => ev.type === "layers" && rerenderTextLayers(s.doc, ready));
    mountRulers(app, s);
  };
  app.confirmRasterize = (name, kind) =>
    kind === "shape"
      ? confirmDialog("Rasterize Shape", `"${name}" is a shape layer. It must be rasterized before you can do that, and its shape will no longer be editable. Rasterize it?`, "Rasterize")
      : confirmDialog("Rasterize Type", `"${name}" is a type layer. It must be rasterized before you can do that, and its text will no longer be editable. Rasterize it?`, "Rasterize");
  app.confirmClose = async (s) => {
    const r = await modal("Unsaved Changes", el("p", { text: `Save changes to "${s.doc.name}" before closing?` }), [
      { label: "Save", value: "save", default: true },
      { label: "Don't Save", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ]);
    if (r === "discard") return true;
    if (r !== "save") return false;
    if (app.active !== s) app.activate(s);
    return app.saveProject(false);
  };

  // ---- appearance ----
  themes.onApply = () => {
    app.setPasteboard(themes.pasteboard());
    app.emit("theme");
  };
  themes.onApply();

  // ---- filters and Actions ----
  const filterOrg = new FilterOrg();
  const filters = new FilterRunner(app, filterOrg);
  setFilterRunner(filters);
  const actionStore = new ActionStore();
  const player = new ActionPlayer(app, actionStore, {
    filter: (id, params) => filterLibrary(app, filters, { filter: id, compact: true, params }),
    blackWhite: (params) => blackWhiteLab(app, params),
  });

  // ---- actions, shortcuts, workspace ----
  let workspace: Workspace;
  let shortcuts: Shortcuts;
  const actions = createActions(app, {
    filters: () => filters,
    player: () => player,
    themes: () => themes,
    appearance: () => appearanceDialog(themes),
    workspace: () => workspace,
    shortcutEditor: () => shortcuts.editor(),
    shortcutReference: () => shortcuts.reference(),
  });
  shortcuts = new Shortcuts(app, actions);
  // Function keys assigned to Actions play them.
  actionStore.shortcutOwner = (combo) => shortcuts.ownerOf(combo);
  shortcuts.preHandler = (combo) => {
    const a = actionStore.byKey(combo);
    if (!a || !a.enabled || actionStore.playing) return false;
    void player.playWithMessage(a);
    return true;
  };
  const keyFor = (id: string) => shortcuts.effective(`tool:${id}`);

  const well = mountOptionsBar($("optionsbar"), app, () => workspace.show("brushes"), () => workspace.showTogether(["character", "paragraph"]), () => workspace.show("paths"));
  mountToolbox($("toolbox"), app, keyFor as never);
  workspace = new Workspace(app, paletteDefs(app, actions, { actions: () => actionsPalette(app, player, { batch: () => void actions.batch.run() }) }), {
    main: $("main"),
    dock: $("palettes"),
    floats: $("floats"),
    toolbox: $("toolbox"),
    well,
    optionsBar: $("optionsbar"),
    statusBar: $("statusbar"),
  });
  workspace.getShortcuts = () => ({ ...shortcuts.overrides });
  workspace.onShortcuts = (s) => shortcuts.setOverrides(s);
  shortcuts.onChange = () => app.emit("tool");
  app.on("screen", () => workspace.render());
  mountMenuBar($("menubar"), buildMenus(app, actions, workspace, themes, { org: filterOrg, open: actions.openFilter }));
  shortcuts.install();
  mountStatusBar(app);

  // ---- window titles and the welcome screen ----
  const syncTitles = () => {
    const doc = app.doc;
    $("welcome").style.display = app.sessions.length ? "none" : "";
    if (app.active) app.updateTitle(app.active);
    document.title = doc ? `${doc.name}${app.isModified ? "*" : ""} - Classic Image Editor` : "Classic Image Editor";
  };
  for (const t of ["doc", "view", "sessions"] as const) app.on(t, syncTitles);
  syncTitles();

  // ---- drag and drop to open ----
  const area = $("docarea");
  area.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    area.classList.add("drop-target");
  });
  area.addEventListener("dragleave", (e) => {
    if (!area.contains(e.relatedTarget as Node)) area.classList.remove("drop-target");
  });
  area.addEventListener("drop", (e) => {
    area.classList.remove("drop-target");
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    void openDropped(app, e.dataTransfer.files);
  });

  // ---- paste (Ctrl+V reaches us as a native paste event carrying the image) ----
  document.addEventListener("paste", async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest?.("input, textarea")) return;
    e.preventDefault();
    const into = consumePasteInto();
    await pasteImage(app, into, await imageFromPasteEvent(e));
  });

  window.addEventListener("beforeunload", (e) => {
    if (app.anyModified) e.preventDefault();
  });
  window.addEventListener("error", (e) => console.error(e.error));
  window.addEventListener("unhandledrejection", (e) => {
    void alertDialog("Error", String((e.reason as Error)?.message ?? e.reason));
  });

  // Scripting surface: the same commands the menus use. The AI palette (M2) builds on this.
  (window as unknown as { editor: unknown }).editor = {
    app,
    bus: app.bus,
    workspace,
    shortcuts,
    actions,
    themes,
    filters,
    filterOrg,
    actionStore,
    player,
    // Commands with slow setup (people detection) return a promise.
    run: (name: string, params: Record<string, unknown> = {}) => {
      const pending = app.bus.prepare(name, params);
      return pending ? pending.then(() => app.bus.dispatch(name, params)) : app.bus.dispatch(name, params);
    },
    commands: () => app.bus.list().map((c) => ({ name: c.name, description: c.description, params: c.params })),
  };
  app.setTool("brush");
  // Files the app was opened with (double-clicking a .cie file).
  const openLaunched = () =>
    launchFiles().then(async (paths) => {
      for (const path of paths)
        try {
          await openPicked(app, { name: baseName(path), path, bytes: await readPath(path) });
        } catch (e) {
          await alertDialog("Open", (e as Error).message);
        }
    });
  void openLaunched();
  // macOS: files double-clicked in Finder while the editor is running.
  if (isDesktop) void import("@tauri-apps/api/event").then(({ listen }) => listen("open-files", () => void openLaunched()));
}

function mountStatusBar(app: App): void {
  const zoom = el("input", { class: "zoom-field", type: "text", value: "", "aria-label": "Zoom" });
  const zoomCell = el("div", { class: "cell" }, zoom);
  const docCell = el("div", { class: "cell", title: "Flattened size / layered size in memory" });
  const hint = el("div", { class: "cell hint" });
  const gpu = el("div", { class: "cell", title: "Time spent compositing the last change" });
  $("statusbar").append(zoomCell, docCell, hint, gpu);
  zoom.addEventListener("change", () => {
    const v = parseFloat(zoom.value);
    if (v > 0) app.setZoom(v / 100);
  });
  zoom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") zoom.blur();
  });
  const fmt = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + "M" : Math.ceil(b / 1024) + "K");
  const sync = () => {
    const doc = app.doc;
    if (document.activeElement !== zoom) zoom.value = doc ? +(app.compositor.view.zoom * 100).toFixed(2) + "%" : "";
    if (doc) {
      let tiles = 0;
      for (const l of doc.layers) for (const t of l.grid.tiles) if (t) tiles++;
      docCell.textContent = `Doc: ${fmt(doc.width * doc.height * 3)}/${fmt(tiles * 256 * 256 * 4)}`;
    } else docCell.textContent = "Doc: -";
    hint.textContent =
      app.statusMessage ||
      (app.doc?.quickMask
        ? "Quick Mask: paint black to mask, white to select. Press Q to return to the selection."
        : app.maskView === "gray"
          ? "Showing the layer mask. Paint on it directly; Alt-click its thumbnail (or press Esc) to see the image."
          : app.maskView === "overlay"
            ? "Layer mask overlay: hidden areas are tinted. Press \\ to turn it off."
            : app.tool.hint);
  };
  app.on("composite", () => {
    gpu.textContent = `${app.compositor.stats.lastTiles} tiles, ${app.compositor.stats.lastCompositeMs.toFixed(1)} ms`;
  });
  for (const t of ["doc", "view", "tool", "status"] as const) app.on(t, sync);
  sync();
}

boot();
