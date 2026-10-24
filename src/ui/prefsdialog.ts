/**
 * Edit > Preferences (Ctrl+K; Ctrl+Alt+K reopens the last section), laid out
 * like Photoshop 7's: one section at a time, picked from the list or with
 * Prev / Next. Changes apply on OK.
 */

import type { App } from "../app";
import { DEFAULT_PREFS, UNIT_LABELS, type Preferences, type Units } from "../prefs";
import { isDesktop } from "../io/files";
import { scratchPlatform, type DiskInfo } from "../io/scratchstore";
import type { UIHooks } from "./actions";
import { confirmDialog, el, modal } from "./dialogs";
import * as storage from "./storage";

type Draft = Preferences;
type Section = { id: string; title: string; build: (d: Draft) => HTMLElement };

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

let lastSection = "general";

export async function preferencesDialog(app: App, ui: UIHooks, section?: string): Promise<void> {
  const draft: Draft = structuredClone(app.prefs);
  let theme = ui.themes().appearance.theme;

  // ---- controls bound to the draft
  const row = (label: string, ...kids: (Node | string)[]) => el("div", { class: "pf-row" }, el("label", { class: "pf-label", text: label }), el("div", { class: "pf-ctl" }, ...kids));
  const check = <K extends keyof Draft>(key: K, label: string, hint?: string) => {
    const c = el("input", { type: "checkbox", checked: !!draft[key] }) as HTMLInputElement;
    c.addEventListener("change", () => ((draft[key] as unknown as boolean) = c.checked));
    return el("label", { class: "pf-check", title: hint ?? "" }, c, el("span", { text: label }), hint ? el("small", { text: hint }) : null);
  };
  const select = <K extends keyof Draft>(key: K, label: string, options: [string, string][], numeric = false) => {
    const s = el("select", { "aria-label": label }) as HTMLSelectElement;
    for (const [v, t] of options) s.append(el("option", { value: v, text: t }));
    s.value = String(draft[key]);
    s.addEventListener("change", () => ((draft as unknown as Record<string, unknown>)[key] = numeric ? +s.value : s.value));
    return row(label + ":", s);
  };
  const number = <K extends keyof Draft>(key: K, label: string, min: number, max: number, suffix = "", step: number | "any" = 1) => {
    const n = el("input", { type: "number", min, max, step, value: String(draft[key]), "aria-label": label }) as HTMLInputElement;
    // Take every keystroke (Enter closes the dialog before a change event would come).
    const take = (fix: boolean) => {
      const raw = +n.value;
      if (!Number.isFinite(raw) || n.value === "") return;
      const v = Math.max(min, Math.min(max, raw));
      if (fix) n.value = String(v);
      (draft as unknown as Record<string, number>)[key] = v;
    };
    n.addEventListener("input", () => take(false));
    n.addEventListener("change", () => take(true));
    return row(label + ":", n, suffix ? el("span", { class: "pf-suffix", text: suffix }) : "");
  };
  const color = <K extends keyof Draft>(key: K, label: string) => {
    const c = el("input", { type: "color", value: String(draft[key]), "aria-label": label }) as HTMLInputElement;
    c.addEventListener("input", () => ((draft as unknown as Record<string, string>)[key] = c.value));
    return row(label + ":", c);
  };
  const group = (title: string, ...kids: (Node | null)[]) => el("fieldset", { class: "pf-group" }, el("legend", { text: title }), ...kids.filter((k): k is Node => !!k));
  const note = (text: string) => el("p", { class: "pf-note", text });
  const unitOptions = (Object.keys(UNIT_LABELS) as Units[]).map((u) => [u, UNIT_LABELS[u]] as [string, string]);

  const sections: Section[] = [
    {
      id: "general",
      title: "General",
      build: () => {
        const themeSel = el("select", { "aria-label": "Theme" }) as HTMLSelectElement;
        for (const t of ui.themes().all()) themeSel.append(el("option", { value: t.id, text: t.name }));
        themeSel.value = theme;
        themeSel.addEventListener("change", () => (theme = themeSel.value));
        return el(
          "div",
          {},
          select("colorPicker", "Color Picker", [["builtin", "Classic Image Editor"], ["system", isDesktop ? "System (Windows)" : "System"]]),
          select("interpolation", "Image Interpolation", [["nearest", "Nearest Neighbor (Faster)"], ["bilinear", "Bilinear"], ["bicubic", "Bicubic (Better)"]]),
          select("redoKey", "Redo Key", [["ctrlZ", "Ctrl+Z (Toggles Undo/Redo)"], ["ctrlShiftZ", "Ctrl+Shift+Z (Ctrl+Z steps back)"], ["ctrlY", "Ctrl+Y (Ctrl+Z steps back)"]]),
          number("historyStates", "History States", 1, 1000),
          row("Theme:", themeSel),
          select("docMode", "Open Images In", [["floating", "Floating Windows"], ["maximized", "Maximized (Tabbed) Windows"]]),
          group(
            "Options",
            check("showToolTips", "Show Tool Tips"),
            check("zoomResizesWindows", "Keyboard Zoom Resizes Windows"),
            check("zoomWithWheel", "Zoom with Scroll Wheel", "Alt or Ctrl + wheel scrolls"),
            check("beepWhenDone", "Beep When Done", "after operations longer than 2 seconds"),
            check("dynamicColorSliders", "Dynamic Color Sliders"),
            check("savePaletteLocations", "Save Palette Locations"),
            check("shiftToolSwitch", "Use Shift Key for Tool Switch"),
          ),
        );
      },
    },
    {
      id: "tools",
      title: "Tools",
      build: () =>
        el(
          "div",
          {},
          group(
            "Move Tool",
            check("ctrlMove", "Hold Ctrl for the Move tool", "from any tool, until Ctrl is released"),
            check("ctrlAutoSelect", "Ctrl-click with the Move tool picks the layer under the pointer", "off: the Move tool always moves the selected layers"),
          ),
          group("Painting", check("altEyedropper", "Hold Alt with painting tools for the Eyedropper")),
          group("Free Transform", check("transformProportional", "Corner handles keep proportions", "Shift scales freely; off: Photoshop 7's way, Shift keeps proportions")),
        ),
    },
    {
      id: "files",
      title: "File Handling",
      build: () =>
        el(
          "div",
          {},
          select("imagePreviews", "Image Previews", [["true", "Always Save"], ["false", "Never Save"]]),
          select("extensionCase", "File Extension", [["lower", "Use Lower Case"], ["upper", "Use Upper Case"]]),
          number("jpegQuality", "JPEG Quality", 0, 12, "(0-12, for Save a Copy as JPEG)"),
          number("recentFiles", "Recent File List Contains", 1, 30, "files"),
          group(
            "File Saving",
            number("recoveryMinutes", "Save Recovery Information Every", 0, 120, "minutes (0: never)"),
            note("Recovery copies of changed images go to the scratch disk and are offered if the editor stops unexpectedly."),
          ),
        ),
    },
    {
      id: "display",
      title: "Display & Cursors",
      build: () =>
        el(
          "div",
          {},
          group(
            "Painting Cursors",
            select("paintingCursor", "Shape", [["standard", "Standard"], ["precise", "Precise"], ["brushSize", "Brush Size"]]),
            check("brushCrosshair", "Show Crosshair in Brush Tip"),
          ),
          group("Other Cursors", select("otherCursor", "Shape", [["standard", "Standard"], ["precise", "Precise"]])),
          check("pixelGrid", "Show Pixel Grid when zoomed in past 600%"),
          note("Caps Lock makes every cursor precise while it is on."),
        ),
    },
    {
      id: "transparency",
      title: "Transparency",
      build: () =>
        el(
          "div",
          {},
          group(
            "Transparency Settings",
            select("checkSize", "Grid Size", [["0", "None"], ["4", "Small"], ["8", "Medium"], ["16", "Large"]], true),
            select("checkColors", "Grid Colors", [["light", "Light"], ["medium", "Medium"], ["dark", "Dark"]]),
          ),
          group("Layer Mask Overlay", color("maskOverlayColor", "Color"), number("maskOverlayOpacity", "Opacity", 0, 100, "%")),
        ),
    },
    {
      id: "units",
      title: "Units & Rulers",
      build: () =>
        el(
          "div",
          {},
          group("Units", select("rulerUnits", "Rulers", unitOptions), select("typeUnits", "Type", [["pixels", "pixels"], ["points", "points"], ["mm", "mm"]])),
          group("New Document Preset Resolution", number("newResolution", "Resolution", 1, 30000, "pixels/inch", "any")),
          group("Point/Pica Size", select("pointsPerInch", "Points per Inch", [["72", "PostScript (72 points/inch)"], ["72.27", "Traditional (72.27 points/inch)"]], true)),
          note("Right-click a ruler to change its units too."),
        ),
    },
    {
      id: "guides",
      title: "Guides, Grid & Slices",
      build: () =>
        el(
          "div",
          {},
          group("Guides", color("guideColor", "Color"), select("guideStyle", "Style", [["lines", "Lines"], ["dashed", "Dashed Lines"]])),
          group(
            "Grid",
            color("gridColor", "Color"),
            select("gridStyle", "Style", [["lines", "Lines"], ["dashed", "Dashed Lines"], ["dots", "Dots"]]),
            number("gridSpacing", "Gridline Every", 0.01, 10000, "", "any"),
            select("gridUnits", "Units", unitOptions),
            number("gridSubdivisions", "Subdivisions", 1, 100),
          ),
          group("Slices", color("sliceColor", "Line Color"), check("showSliceNumbers", "Show Slice Numbers")),
        ),
    },
    {
      id: "scratch",
      title: "Scratch Disks",
      build: (d) => scratchSection(app, d, group, note),
    },
    {
      id: "memory",
      title: "Memory",
      build: (d) => memorySection(app, d, group, note),
    },
  ];

  // ---- layout: section list | panel, with Prev / Next
  let current = sections.find((s) => s.id === (section ?? lastSection)) ?? sections[0];
  const list = el("div", { class: "pf-list", role: "listbox", "aria-label": "Preferences sections" });
  const panel = el("div", { class: "pf-panel" });
  const title = el("h3", { class: "pf-title" });
  const built = new Map<string, HTMLElement>();
  const show = (s: Section) => {
    current = s;
    lastSection = s.id;
    title.textContent = s.title;
    let node = built.get(s.id);
    if (!node) built.set(s.id, (node = s.build(draft)));
    panel.replaceChildren(title, node);
    for (const b of list.children) (b as HTMLElement).classList.toggle("active", (b as HTMLElement).dataset.id === s.id);
  };
  for (const s of sections) {
    const b = el("button", { type: "button", class: "pf-item", text: s.title, "data-id": s.id, role: "option" });
    b.addEventListener("click", () => show(s));
    list.append(b);
  }
  const step = (d: number) => show(sections[(sections.indexOf(current) + d + sections.length) % sections.length]);
  const prev = el("button", { type: "button", class: "btn small", text: "Prev" });
  const next = el("button", { type: "button", class: "btn small", text: "Next" });
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  const reset = el("button", { type: "button", class: "btn small", text: "Reset All..." , title: "Put every preference back to its default" });
  reset.addEventListener("click", async () => {
    if (!(await confirmDialog("Preferences", "Put every preference back to its default? Your choices here are lost.", "Reset"))) return;
    Object.assign(draft, structuredClone(DEFAULT_PREFS));
    built.clear();
    show(current);
  });
  show(current);
  const body = el("div", { class: "pf" }, list, el("div", { class: "pf-main" }, panel, el("div", { class: "pf-nav" }, prev, next, el("span", { class: "pf-spacer" }), reset)));
  const r = await modal("Preferences", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ], 920);
  if (r !== "ok") return;

  // ---- apply
  const before = app.prefs;
  if (theme !== ui.themes().appearance.theme) ui.themes().set({ theme, custom: {} });
  const scratchChanged = JSON.stringify(before.scratchDisks) !== JSON.stringify(draft.scratchDisks);
  if (before.interpolation !== draft.interpolation) {
    // The new default replaces the choices remembered in Image Size and Free Transform.
    storage.remove("transformMethod");
    const is = storage.load<Record<string, unknown> | null>("imageSize", null);
    if (is) {
      delete is.method;
      storage.save("imageSize", is);
    }
  }
  app.setPrefs({ ...draft, imagePreviews: String(draft.imagePreviews) === "true" });
  if (scratchChanged) {
    app.reconfigureScratch().catch((e: unknown) => app.toast(`Could not switch scratch disks: ${e instanceof Error ? e.message : String(e)}.`));
  }
  app.scheduleEnforce();
}

/** Up to four scratch folders (desktop), with their free space. */
function scratchSection(app: App, d: Draft, group: (t: string, ...k: (Node | null)[]) => HTMLElement, note: (t: string) => HTMLElement): HTMLElement {
  const p = scratchPlatform();
  if (!p) return el("div", {}, note("Scratch disks aren't available here: older history stays in memory."));
  if (!p.folders) {
    const info = el("div", { class: "pf-disk" }, "Browser storage");
    void p.diskInfo([]).then((x) => (info.textContent = `Browser storage: ${gb(x[0]?.free ?? 0)} free`));
    return el("div", {}, group("Scratch Disk", info), note("In a browser, history that doesn't fit in memory goes to the browser's private storage for this site. The desktop app lets you choose up to four folders on any drive."));
  }
  const names = ["First", "Second", "Third", "Fourth"];
  const rows = el("div", {});
  const render = () => {
    rows.replaceChildren();
    const dirs = d.scratchDisks;
    for (let i = 0; i < 4; i++) {
      const path = dirs[i] ?? "";
      const label = el("span", { class: "pf-path", text: path || (i === 0 ? "Startup (the system's temporary folder)" : "None") });
      const free = el("span", { class: "pf-free" });
      const choose = el("button", { type: "button", class: "btn small", text: "Choose..." });
      const clear = el("button", { type: "button", class: "btn small", text: "Clear", disabled: !path });
      const usable = i === 0 || !!dirs[i - 1] || !!path;
      choose.disabled = !usable;
      choose.addEventListener("click", async () => {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true, multiple: false, title: `${names[i]} scratch disk` });
        if (!picked || Array.isArray(picked)) return;
        const list = [...d.scratchDisks];
        list[i] = picked;
        d.scratchDisks = list.filter((x, j) => x && list.indexOf(x) === j).slice(0, 4);
        render();
      });
      clear.addEventListener("click", () => {
        d.scratchDisks = d.scratchDisks.filter((_, j) => j !== i);
        render();
      });
      const target = path || (i === 0 ? "" : null);
      if (target !== null)
        void p.diskInfo(target ? [target] : []).then((x: DiskInfo[]) => {
          const info = x[0];
          free.textContent = info?.ok ? `${gb(info.free)} free of ${gb(info.total)}` : (info?.error ?? "");
          free.classList.toggle("bad", !info?.ok);
        });
      rows.append(el("div", { class: "pf-disk" }, el("b", { text: `${names[i]}:` }), label, free, choose, clear));
    }
  };
  render();
  return el(
    "div",
    {},
    group("Scratch Disks", rows),
    note("When open images and their history need more memory than Memory allows, the oldest history goes to the first scratch disk with room, then the next. Fast drives with plenty of free space work best. Recovery copies go to the first one."),
    note(`Using now: ${app.scratchDisks.map((x) => x.path).join(", ") || "-"}`),
  );
}

/** How much memory images may use, and what they use now. */
function memorySection(app: App, d: Draft, group: (t: string, ...k: (Node | null)[]) => HTMLElement, note: (t: string) => HTMLElement): HTMLElement {
  const total = app.memoryTotal;
  const pct = el("input", { type: "range", min: 10, max: 90, step: 5, value: d.memoryPercent, "aria-label": "Memory percent" }) as HTMLInputElement;
  const num = el("input", { type: "number", min: 10, max: 90, step: 1, value: d.memoryPercent, "aria-label": "Memory percent value" }) as HTMLInputElement;
  const ofTotal = el("span", { class: "pf-suffix" });
  const sync = (v: number) => {
    d.memoryPercent = Math.max(10, Math.min(90, Math.round(v)));
    pct.value = num.value = String(d.memoryPercent);
    ofTotal.textContent = `% = ${gb((total * d.memoryPercent) / 100)}`;
  };
  pct.addEventListener("input", () => sync(+pct.value));
  num.addEventListener("input", () => {
    if (num.value !== "" && +num.value >= 10 && +num.value <= 90) {
      d.memoryPercent = Math.round(+num.value);
      pct.value = String(d.memoryPercent);
      ofTotal.textContent = `% = ${gb((total * d.memoryPercent) / 100)}`;
    }
  });
  num.addEventListener("change", () => sync(+num.value));
  sync(d.memoryPercent);
  const st = app.pager?.measure();
  return el(
    "div",
    {},
    group(
      "Memory Usage",
      el("div", { class: "pf-row" }, el("label", { class: "pf-label", text: "Available RAM:" }), el("div", { class: "pf-ctl", text: gb(total) })),
      el("div", { class: "pf-row" }, el("label", { class: "pf-label", text: "Maximum Used by Images:" }), el("div", { class: "pf-ctl" }, num, ofTotal)),
      pct,
    ),
    group(
      "Right Now",
      el("div", { class: "pf-stat", text: st ? `Images and history in memory: ${gb(st.inMemory)}` : "Paging to a scratch disk isn't available here." }),
      st ? el("div", { class: "pf-stat", text: `History on the scratch disk: ${gb(st.onDisk)}` }) : null,
    ),
    note("Above the limit, the oldest history states move to the scratch disk; going back to one reads it in again. Edit > Purge frees memory at once."),
  );
}
