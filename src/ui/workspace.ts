/**
 * The customizable workspace.
 *
 * Palettes live in groups (tabbed palette windows). A group is docked in the
 * right-hand column or floats anywhere over the workspace. Drag a group by
 * its title strip to move it (drop it on the dock column to dock it); drag a
 * tab to move that palette into another group, into the palette well in the
 * options bar, onto the dock as a new group, or anywhere else as a new
 * floating group. The toolbox can float or dock too.
 *
 * The layout autosaves and is restored on the next start. Window > Workspace
 * saves named layouts (optionally with keyboard shortcuts), loads, deletes,
 * resets, exports and imports them.
 */

import type { App } from "../app";
import { el } from "./dialogs";
import { ICONS } from "./icons";
import { MenuItem, showPopupMenu } from "./menus";
import * as storage from "./storage";

export interface PaletteParts {
  body: HTMLElement;
  footer?: HTMLElement;
  /** Items for the palette's flyout menu (the triangle button). */
  menu?: () => MenuItem[];
}

export interface PaletteDef {
  id: string;
  title: string;
  /** Milestone it arrives in, for placeholders. */
  soon?: string;
  /** Takes the leftover height when docked. */
  grow?: boolean;
  /** Preferred width when floating or popped from the well. */
  width?: number;
  build(): PaletteParts;
}

export interface GroupLayout {
  id: string;
  tabs: string[];
  active: string;
  collapsed: boolean;
  dock: "right" | "float";
  /** Floating geometry, relative to the workspace area. */
  x: number;
  y: number;
  w: number;
  /** Fixed height (px), or 0 for natural height. */
  h: number;
}

export interface WorkspaceLayout {
  version: 1;
  groups: GroupLayout[];
  well: string[];
  toolbox: { dock: "left" | "float"; x: number; y: number; visible: boolean };
  optionsBar: boolean;
  statusBar: boolean;
  dockWidth: number;
  /** Keyboard shortcut overrides saved with a named workspace. */
  shortcuts?: Record<string, string>;
}

let gid = 1;
const newId = () => `g${Date.now().toString(36)}${gid++}`;

export function defaultLayout(): WorkspaceLayout {
  const g = (tabs: string[], h = 0): GroupLayout => ({ id: newId(), tabs, active: tabs[0], collapsed: false, dock: "right", x: 0, y: 0, w: 240, h });
  return {
    version: 1,
    groups: [g(["navigator", "info"]), g(["color", "swatches", "styles", "masks"]), g(["history", "actions"], 170), g(["layers", "channels", "paths"])],
    well: ["brushes", "toolPresets"],
    toolbox: { dock: "left", x: 8, y: 8, visible: true },
    optionsBar: true,
    statusBar: true,
    dockWidth: 280,
  };
}

interface Containers {
  main: HTMLElement;
  dock: HTMLElement;
  floats: HTMLElement;
  toolbox: HTMLElement;
  well: HTMLElement;
  optionsBar: HTMLElement;
  statusBar: HTMLElement;
}

export class Workspace {
  layout: WorkspaceLayout;
  private defs = new Map<string, PaletteDef>();
  private parts = new Map<string, PaletteParts>();
  private groupEls = new Map<string, HTMLElement>();
  private wellPop: HTMLElement | null = null;
  private zTop = 10;
  private listeners = new Set<() => void>();
  /** Applies shortcut overrides when a workspace that has them is loaded. */
  onShortcuts: ((s: Record<string, string>) => void) | null = null;
  /** Current shortcut overrides, to include when saving a workspace. */
  getShortcuts: (() => Record<string, string>) | null = null;

  constructor(
    private app: App,
    defs: PaletteDef[],
    private c: Containers,
  ) {
    for (const d of defs) this.defs.set(d.id, d);
    // Preferences > Save Palette Locations: off, every start begins with the default layout.
    const saved = app.prefs.savePaletteLocations ? storage.load<WorkspaceLayout | null>("workspace.current", null) : null;
    this.layout = this.sanitize(saved ?? defaultLayout());
    this.setupToolboxDrag();
    this.setupDockSplitter();
    new ResizeObserver(() => this.clampFloats()).observe(c.main);
    this.render();
  }

  // ---------------------------------------------------------------- state

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    storage.saveSoon("workspace.current", () => this.layout);
    this.listeners.forEach((fn) => fn());
  }

  /** Repair a stored layout: drop unknown palettes, add missing ones. */
  private sanitize(l: WorkspaceLayout): WorkspaceLayout {
    const def = defaultLayout();
    if (!l || l.version !== 1 || !Array.isArray(l.groups)) return def;
    const known = (id: string) => this.defs.has(id);
    const seen = new Set<string>();
    const uniq = (ids: string[]) => ids.filter((id) => known(id) && !seen.has(id) && (seen.add(id), true));
    const groups = l.groups
      .map((g) => ({ ...g, id: g.id || newId(), tabs: uniq(g.tabs ?? []) }))
      .filter((g) => g.tabs.length)
      .map((g) => ({ ...g, active: g.tabs.includes(g.active) ? g.active : g.tabs[0] }));
    const well = uniq(l.well ?? []);
    return {
      ...def,
      ...l,
      groups,
      well,
      toolbox: { ...def.toolbox, ...(l.toolbox ?? {}) },
      dockWidth: Math.max(180, Math.min(600, l.dockWidth || def.dockWidth)),
    };
  }

  private partsFor(id: string): PaletteParts {
    let p = this.parts.get(id);
    if (!p) {
      const d = this.defs.get(id)!;
      p = d.soon
        ? { body: el("p", { class: "ai-note", text: `The ${d.title} palette arrives in ${d.soon}.` }) }
        : d.build();
      this.parts.set(id, p);
    }
    return p;
  }

  title(id: string): string {
    return this.defs.get(id)?.title ?? id;
  }

  allPalettes(): PaletteDef[] {
    return [...this.defs.values()];
  }

  private groupOf(id: string): GroupLayout | undefined {
    return this.layout.groups.find((g) => g.tabs.includes(id));
  }

  /** Open = showing as the front tab of an expanded group, or in the well. */
  isOpen(id: string): boolean {
    const g = this.groupOf(id);
    return !!g && g.active === id && !g.collapsed;
  }

  // ---------------------------------------------------------------- palette operations

  /** Window menu: show a palette (bring its group forward, or reopen it). */
  show(id: string): void {
    // Showing a palette brings hidden palettes back (Tab / Shift+Tab).
    this.chromeHidden = this.palettesHidden = false;
    if (this.layout.well.includes(id)) {
      this.openWell(id);
      return;
    }
    let g = this.groupOf(id);
    if (!g) {
      g = { id: newId(), tabs: [id], active: id, collapsed: false, dock: "float", x: 80, y: 60, w: this.defs.get(id)?.width ?? 240, h: 0 };
      this.layout.groups.push(g);
    }
    g.active = id;
    g.collapsed = false;
    this.render();
    this.bringToFront(g.id);
    this.changed();
  }

  /** Show palettes that belong together (Character + Paragraph) as tabs of one floating group. */
  showTogether(ids: string[]): void {
    if (ids.some((id) => this.groupOf(id) || this.layout.well.includes(id))) return this.show(ids.find((id) => this.groupOf(id) || this.layout.well.includes(id))!);
    const g: GroupLayout = { id: newId(), tabs: [...ids], active: ids[0], collapsed: false, dock: "float", x: 80, y: 60, w: this.defs.get(ids[0])?.width ?? 240, h: 0 };
    this.layout.groups.push(g);
    this.render();
    this.bringToFront(g.id);
    this.changed();
  }

  /** Window menu: hide a palette (closes it out of its group). */
  hide(id: string): void {
    this.closeWell();
    this.removeTab(id);
    this.render();
    this.changed();
  }

  /** Is the palette's popover open in the well? */
  isWellOpen(id: string): boolean {
    return !!this.wellPop && this.wellPop.dataset.palette === id;
  }

  toggle(id: string): void {
    if ((this.chromeHidden || this.palettesHidden) && !this.layout.well.includes(id)) return this.show(id);
    if (this.layout.well.includes(id)) this.isWellOpen(id) ? this.closeWell() : this.openWell(id);
    else this.isOpen(id) ? this.hide(id) : this.show(id);
  }

  /** Take a palette out of the well into a new floating window. */
  fromWell(id: string): void {
    this.closeWell();
    this.removeTab(id);
    const g: GroupLayout = { id: newId(), tabs: [id], active: id, collapsed: false, dock: "float", x: 80, y: 60, w: this.defs.get(id)?.width ?? 240, h: 0 };
    this.layout.groups.push(g);
    this.render();
    this.bringToFront(g.id);
    this.changed();
  }

  private removeTab(id: string): void {
    this.layout.well = this.layout.well.filter((x) => x !== id);
    for (const g of this.layout.groups) {
      const i = g.tabs.indexOf(id);
      if (i < 0) continue;
      g.tabs.splice(i, 1);
      if (g.active === id) g.active = g.tabs[Math.max(0, i - 1)] ?? "";
    }
    this.layout.groups = this.layout.groups.filter((g) => g.tabs.length);
  }

  toWell(id: string): void {
    this.removeTab(id);
    this.layout.well.push(id);
    this.render();
    this.changed();
  }

  private setActive(g: GroupLayout, id: string): void {
    g.active = id;
    g.collapsed = false;
    this.render();
    this.changed();
  }

  /** Window > Workspace > Reset Palette Locations. */
  reset(): void {
    const keepShortcuts = this.layout.shortcuts;
    this.layout = defaultLayout();
    if (keepShortcuts) this.layout.shortcuts = keepShortcuts;
    this.render();
    this.changed();
  }

  // ---------------------------------------------------------------- named workspaces

  names(): string[] {
    return Object.keys(storage.load<Record<string, WorkspaceLayout>>("workspaces", {})).sort((a, b) => a.localeCompare(b));
  }

  saveAs(name: string, includeShortcuts: boolean): void {
    const all = storage.load<Record<string, WorkspaceLayout>>("workspaces", {});
    const copy: WorkspaceLayout = JSON.parse(JSON.stringify(this.layout));
    if (includeShortcuts && this.getShortcuts) copy.shortcuts = this.getShortcuts();
    else delete copy.shortcuts;
    all[name] = copy;
    storage.save("workspaces", all);
    this.listeners.forEach((fn) => fn());
  }

  loadNamed(name: string): boolean {
    const l = storage.load<Record<string, WorkspaceLayout>>("workspaces", {})[name];
    if (!l) return false;
    this.apply(l);
    return true;
  }

  deleteNamed(name: string): void {
    const all = storage.load<Record<string, WorkspaceLayout>>("workspaces", {});
    delete all[name];
    storage.save("workspaces", all);
    this.listeners.forEach((fn) => fn());
  }

  /** Apply a layout object (from a saved workspace or an imported file). */
  apply(l: WorkspaceLayout): void {
    this.layout = this.sanitize(JSON.parse(JSON.stringify(l)));
    if (l.shortcuts && this.onShortcuts) this.onShortcuts(l.shortcuts);
    this.render();
    this.changed();
  }

  exportJSON(): string {
    const copy: WorkspaceLayout = JSON.parse(JSON.stringify(this.layout));
    if (this.getShortcuts) copy.shortcuts = this.getShortcuts();
    return JSON.stringify({ format: "classic-image-editor-workspace", ...copy }, null, 2);
  }

  importJSON(text: string): void {
    const o = JSON.parse(text);
    if (o?.format !== "classic-image-editor-workspace") throw new Error("This file is not a Classic Image Editor workspace.");
    delete o.format;
    this.apply(o as WorkspaceLayout);
  }

  // ---------------------------------------------------------------- chrome visibility

  setToolboxVisible(v: boolean): void {
    this.layout.toolbox.visible = v;
    this.render();
    this.changed();
  }

  setOptionsBar(v: boolean): void {
    this.layout.optionsBar = v;
    this.render();
    this.changed();
  }

  setStatusBar(v: boolean): void {
    this.layout.statusBar = v;
    this.render();
    this.changed();
  }

  /** Tab: hide everything except the menu bar and document (PS7). */
  private chromeHidden = false;
  toggleAllChrome(): void {
    this.chromeHidden = !this.chromeHidden;
    this.palettesHidden = false;
    this.render();
  }

  /** Shift+Tab: hide the palettes but keep the toolbox, options bar and status bar (PS7). */
  private palettesHidden = false;
  togglePalettes(): void {
    this.palettesHidden = !this.palettesHidden;
    this.chromeHidden = false;
    this.render();
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    // A palette's content can only live in one place: close the well popover first.
    this.closeWell();
    const L = this.layout;
    const { main, dock, floats, toolbox, well, optionsBar, statusBar } = this.c;
    const hideAll = this.chromeHidden;
    document.getElementById("app")!.dataset.screen = this.app.screenMode;
    // Grid columns: toolbox | document | dock.
    const docked = L.groups.filter((g) => g.dock === "right");
    const tbDocked = L.toolbox.visible && L.toolbox.dock === "left" && !hideAll;
    const hidePalettes = hideAll || this.palettesHidden;
    const dockW = docked.length && !hidePalettes ? L.dockWidth : 0;
    main.style.gridTemplateColumns = `${tbDocked ? "var(--toolbox-w)" : "0"} 1fr ${dockW ? dockW + "px" : "0"}`;
    dock.style.display = dockW ? "" : "none";
    optionsBar.style.display = L.optionsBar && !hideAll ? "" : "none";
    statusBar.style.display = L.statusBar && !this.chromeHidden ? "" : "none";
    document.getElementById("app")!.style.gridTemplateRows = `${this.app.screenMode === "full" ? "0" : "var(--menubar-h)"} ${L.optionsBar && !hideAll ? "var(--options-h)" : "0"} 1fr ${L.statusBar && !this.chromeHidden ? "var(--status-h)" : "0"}`;

    // Toolbox.
    toolbox.style.display = L.toolbox.visible && !hideAll ? "" : "none";
    toolbox.classList.toggle("floating", L.toolbox.dock === "float");
    if (L.toolbox.dock === "float") {
      if (toolbox.parentElement !== floats) floats.append(toolbox);
      toolbox.style.left = L.toolbox.x + "px";
      toolbox.style.top = L.toolbox.y + "px";
    } else {
      if (toolbox.parentElement !== main) main.prepend(toolbox);
      toolbox.style.left = toolbox.style.top = "";
    }

    // Groups.
    const live = new Set<string>();
    dock.querySelector(".dock-splitter") || dock.prepend(el("div", { class: "dock-splitter", title: "Drag to resize the palette dock" }));
    for (const g of L.groups) {
      live.add(g.id);
      const node = this.renderGroup(g);
      node.style.display = hidePalettes ? "none" : "";
      if (g.dock === "right") {
        dock.append(node); // keeps array order
        node.classList.remove("floating");
        node.style.left = node.style.top = node.style.width = "";
        node.style.height = g.h && !g.collapsed ? g.h + "px" : "";
        // Layers/History take the leftover height but never shrink below a usable size.
        node.style.flex = this.isGrow(g) && !g.h && !g.collapsed ? "1 0 260px" : "";
      } else {
        if (node.parentElement !== floats) floats.append(node);
        node.classList.add("floating");
        node.style.left = g.x + "px";
        node.style.top = g.y + "px";
        node.style.width = g.w + "px";
        node.style.height = g.h && !g.collapsed ? g.h + "px" : "";
        node.style.flex = "";
      }
    }
    for (const [id, node] of this.groupEls)
      if (!live.has(id)) {
        node.remove();
        this.groupEls.delete(id);
      }

    // Palette well.
    well.textContent = "";
    if (!L.well.length) well.append(el("span", { class: "well-empty", text: "Palette Well" }));
    for (const id of L.well) {
      const t = el("div", { class: "well-tab", text: this.title(id), "data-palette": id, title: `${this.title(id)} (drag out to undock)` });
      t.addEventListener("pointerdown", (e) => this.beginTabDrag(e, id, null, t));
      well.append(t);
    }
    this.clampFloats();
    window.dispatchEvent(new Event("resize"));
  }

  private isGrow(g: GroupLayout): boolean {
    return g.tabs.some((t) => this.defs.get(t)?.grow);
  }

  private renderGroup(g: GroupLayout): HTMLElement {
    let node = this.groupEls.get(g.id);
    if (!node) {
      node = el("div", { class: "palette", "data-group": g.id });
      const gid = g.id;
      node.addEventListener("pointerdown", () => this.layout.groups.find((x) => x.id === gid)?.dock === "float" && this.bringToFront(gid), true);
      this.groupEls.set(g.id, node);
    }
    node.textContent = "";
    node.classList.toggle("collapsed", g.collapsed);
    const title = el("div", { class: "titlebar", title: "Drag to move this palette" });
    if (g.dock === "float") {
      const x = el("button", { class: "pal-close", type: "button", "aria-label": "Close palette", title: "Close" });
      x.innerHTML = ICONS.close;
      x.addEventListener("pointerdown", (e) => e.stopPropagation());
      x.addEventListener("click", () => {
        for (const t of [...g.tabs]) this.removeTab(t);
        this.render();
        this.changed();
      });
      title.append(x);
    }
    title.addEventListener("pointerdown", (e) => this.beginGroupDrag(e, g));
    title.addEventListener("dblclick", () => {
      g.collapsed = !g.collapsed;
      this.render();
      this.changed();
    });
    const tabs = el("div", { class: "tabs", role: "tablist" });
    for (const id of g.tabs) {
      const d = this.defs.get(id)!;
      const t = el("div", {
        class: "tab" + (id === g.active ? " active" : "") + (d.soon ? " soon" : ""),
        role: "tab",
        "aria-selected": id === g.active,
        text: d.title,
        "data-palette": id,
        title: d.soon ? `Planned for ${d.soon}` : `${d.title} (drag to move)`,
      });
      t.addEventListener("pointerdown", (e) => this.beginTabDrag(e, id, g, t));
      t.addEventListener("dblclick", () => {
        g.collapsed = !g.collapsed;
        this.render();
        this.changed();
      });
      tabs.append(t);
    }
    const menuBtn = el("button", { class: "pal-menu", type: "button", title: "Palette menu", "aria-label": "Palette menu", text: "▸" });
    menuBtn.addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showPopupMenu(this.paletteMenu(g.active, g), r.right, r.bottom);
    });
    tabs.append(el("span", { class: "spacer" }), menuBtn);
    node.append(title, tabs);
    if (!g.collapsed) {
      const p = this.partsFor(g.active);
      const body = el("div", { class: "body" });
      body.append(p.body);
      node.append(body);
      if (p.footer) node.append(el("div", { class: "footer" }, p.footer));
      const grip = el("div", { class: "grip", title: "Drag to resize" });
      grip.addEventListener("pointerdown", (e) => this.beginResize(e, g, node!));
      node.append(grip);
    }
    return node;
  }

  /** The flyout menu for a palette: its own items plus layout items. */
  private paletteMenu(id: string, g: GroupLayout | null): MenuItem[] {
    const p = this.partsFor(id);
    const own = p.menu ? p.menu() : [];
    const items: MenuItem[] = [...own];
    if (own.length) items.push("-");
    if (g) {
      items.push({ label: "Dock to Palette Well", run: () => this.toWell(id) });
      if (g.dock === "right") items.push({ label: "Float Palette", run: () => this.floatGroup(g) });
      else items.push({ label: "Dock to Palette Column", run: () => this.dockGroup(g, this.layout.groups.filter((x) => x.dock === "right").length) });
    } else items.push({ label: "Remove from Palette Well", run: () => this.fromWell(id) });
    items.push({ label: `Close ${this.title(id)}`, run: () => this.hide(id) });
    return items;
  }

  bringToFront(groupId: string): void {
    const n = this.groupEls.get(groupId);
    if (n) n.style.zIndex = String(++this.zTop);
  }

  private floatGroup(g: GroupLayout): void {
    const n = this.groupEls.get(g.id);
    const r = n?.getBoundingClientRect();
    const m = this.c.main.getBoundingClientRect();
    g.dock = "float";
    g.x = r ? r.left - m.left - 40 : 80;
    g.y = r ? r.top - m.top : 60;
    g.w = r ? r.width : 240;
    this.render();
    this.bringToFront(g.id);
    this.changed();
  }

  private dockGroup(g: GroupLayout, dockIndex: number): void {
    g.dock = "right";
    const groups = this.layout.groups.filter((x) => x !== g);
    const docked = groups.filter((x) => x.dock === "right");
    const before = docked[dockIndex];
    const at = before ? groups.indexOf(before) : groups.length;
    groups.splice(at, 0, g);
    this.layout.groups = groups;
    this.render();
    this.changed();
  }

  /** Keep floating windows reachable after the window shrinks. */
  private clampFloats(): void {
    const m = this.c.main.getBoundingClientRect();
    if (!m.width) return;
    for (const g of this.layout.groups) {
      if (g.dock !== "float") continue;
      g.x = Math.max(-g.w + 60, Math.min(m.width - 60, g.x));
      g.y = Math.max(0, Math.min(m.height - 24, g.y));
      const n = this.groupEls.get(g.id);
      if (n) {
        n.style.left = g.x + "px";
        n.style.top = g.y + "px";
      }
    }
    const tb = this.layout.toolbox;
    if (tb.dock === "float") {
      tb.x = Math.max(0, Math.min(m.width - 56, tb.x));
      tb.y = Math.max(0, Math.min(m.height - 40, tb.y));
    }
  }

  // ---------------------------------------------------------------- palette well popover

  openWell(id: string): void {
    this.closeWell();
    const tab = this.c.well.querySelector(`[data-palette="${id}"]`) as HTMLElement | null;
    const p = this.partsFor(id);
    const pop = el("div", { class: "palette well-pop", "data-palette": id, style: `width:${this.defs.get(id)?.width ?? 260}px` });
    const tabs = el("div", { class: "tabs" }, el("div", { class: "tab active", text: this.title(id) }));
    const menuBtn = el("button", { class: "pal-menu", type: "button", title: "Palette menu", text: "▸" });
    menuBtn.addEventListener("click", (e) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      showPopupMenu(this.paletteMenu(id, null), r.right, r.bottom);
    });
    tabs.append(el("span", { class: "spacer" }), menuBtn);
    const body = el("div", { class: "body" });
    body.append(p.body);
    pop.append(tabs, body);
    if (p.footer) pop.append(el("div", { class: "footer" }, p.footer));
    document.body.append(pop);
    const r = (tab ?? this.c.well).getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.right - w)) + "px";
    pop.style.top = r.bottom + 2 + "px";
    tab?.classList.add("open");
    this.wellPop = pop;
    const close = (e: PointerEvent) => {
      if (pop.contains(e.target as Node) || (e.target as HTMLElement).closest?.(".menu-pop")) return;
      if ((e.target as HTMLElement).closest?.(".well-tab")) return;
      this.closeWell();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && this.closeWell();
    setTimeout(() => document.addEventListener("pointerdown", close, true));
    document.addEventListener("keydown", esc);
    (pop as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", esc);
    };
    window.dispatchEvent(new Event("resize"));
  }

  closeWell(): void {
    const p = this.wellPop as (HTMLElement & { _cleanup?: () => void }) | null;
    if (!p) return;
    p._cleanup?.();
    p.remove();
    this.wellPop = null;
    this.c.well.querySelectorAll(".open").forEach((n) => n.classList.remove("open"));
  }

  // ---------------------------------------------------------------- dragging

  /** Where a dragged tab or group would land. */
  private dropTarget(x: number, y: number, ignoreGroup: string | null) {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const tabs = under?.closest(".tabs") as HTMLElement | null;
    const groupEl = tabs?.closest("[data-group]") as HTMLElement | null;
    if (groupEl && groupEl.dataset.group !== ignoreGroup) {
      // Insert among the group's tabs by x position.
      const tabEls = [...groupEl.querySelectorAll(".tab")] as HTMLElement[];
      let index = tabEls.length;
      tabEls.forEach((t, i) => {
        const r = t.getBoundingClientRect();
        if (index === tabEls.length && x < r.left + r.width / 2) index = i;
      });
      return { kind: "group" as const, group: groupEl.dataset.group!, index };
    }
    if (under?.closest("#palette-well")) return { kind: "well" as const };
    const d = this.c.dock.getBoundingClientRect();
    const dockVisible = this.c.dock.style.display !== "none";
    const nearRight = x > this.c.main.getBoundingClientRect().right - 40;
    if ((dockVisible && x >= d.left && x <= d.right && y >= d.top && y <= d.bottom) || nearRight) {
      const docked = this.layout.groups.filter((g) => g.dock === "right" && g.id !== ignoreGroup);
      let index = docked.length;
      docked.forEach((g, i) => {
        const r = this.groupEls.get(g.id)?.getBoundingClientRect();
        if (r && index === docked.length && y < r.top + r.height / 2) index = i;
      });
      return { kind: "dock" as const, index };
    }
    return { kind: "float" as const };
  }

  private indicator: HTMLElement | null = null;

  private showIndicator(t: ReturnType<Workspace["dropTarget"]>): void {
    if (!this.indicator) {
      this.indicator = el("div", { class: "drop-indicator" });
      document.body.append(this.indicator);
    }
    const ind = this.indicator;
    ind.style.display = "none";
    if (t.kind === "dock") {
      const d = this.c.dock.getBoundingClientRect();
      const docked = this.layout.groups.filter((g) => g.dock === "right");
      const at = docked[t.index];
      const r = at ? this.groupEls.get(at.id)!.getBoundingClientRect() : null;
      const y = r ? r.top - 2 : (docked.length ? this.groupEls.get(docked[docked.length - 1].id)!.getBoundingClientRect().bottom + 2 : d.top + 4);
      const left = this.c.dock.style.display === "none" ? this.c.main.getBoundingClientRect().right - this.layout.dockWidth : d.left;
      Object.assign(ind.style, { display: "block", left: left + 4 + "px", top: y - 2 + "px", width: (d.width || this.layout.dockWidth) - 8 + "px", height: "4px" });
    } else if (t.kind === "group") {
      const g = this.groupEls.get(t.group)!.querySelector(".tabs")!.getBoundingClientRect();
      Object.assign(ind.style, { display: "block", left: g.left + "px", top: g.top + "px", width: g.width + "px", height: g.height + "px", background: "rgba(74,168,255,0.25)" });
      return;
    } else if (t.kind === "well") {
      const w = this.c.well.getBoundingClientRect();
      Object.assign(ind.style, { display: "block", left: w.left + "px", top: w.top + "px", width: w.width + "px", height: w.height + "px", background: "rgba(74,168,255,0.25)" });
      return;
    }
    ind.style.background = "";
  }

  private hideIndicator(): void {
    this.indicator?.remove();
    this.indicator = null;
  }

  private beginTabDrag(e: PointerEvent, id: string, g: GroupLayout | null, tabEl: HTMLElement): void {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    let ghost: HTMLElement | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        this.closeWell();
        ghost = el("div", { class: "tab-ghost", text: this.title(id) });
        document.body.append(ghost);
      }
      ghost.style.left = ev.clientX + 8 + "px";
      ghost.style.top = ev.clientY + 8 + "px";
      ghost.style.display = "none";
      const t = this.dropTarget(ev.clientX, ev.clientY, g && g.tabs.length === 1 ? g.id : null);
      ghost.style.display = "";
      this.showIndicator(t);
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      this.hideIndicator();
      if (!ghost) {
        // A click: activate the tab (or pop open the well palette).
        if (g) this.setActive(g, id);
        else this.wellPop ? this.closeWell() : this.openWell(id);
        return;
      }
      ghost.remove();
      const t = this.dropTarget(ev.clientX, ev.clientY, g && g.tabs.length === 1 ? g.id : null);
      const m = this.c.main.getBoundingClientRect();
      if (t.kind === "group") {
        const dest = this.layout.groups.find((x) => x.id === t.group)!;
        const srcIdx = dest.tabs.indexOf(id);
        let index = t.index;
        if (srcIdx >= 0 && srcIdx < index) index--;
        this.removeTab(id);
        if (!this.layout.groups.includes(dest)) this.layout.groups.push(dest);
        dest.tabs.splice(Math.min(index, dest.tabs.length), 0, id);
        dest.active = id;
        dest.collapsed = false;
      } else if (t.kind === "well") {
        this.removeTab(id);
        this.layout.well.push(id);
      } else {
        const w = g ? (this.groupEls.get(g.id)?.offsetWidth ?? 240) : (this.defs.get(id)?.width ?? 240);
        this.removeTab(id);
        const ng: GroupLayout = {
          id: newId(),
          tabs: [id],
          active: id,
          collapsed: false,
          dock: t.kind === "dock" ? "right" : "float",
          x: ev.clientX - m.left - 30,
          y: ev.clientY - m.top - 10,
          w,
          h: 0,
        };
        if (t.kind === "dock") {
          const docked = this.layout.groups.filter((x) => x.dock === "right");
          const before = docked[t.index];
          this.layout.groups.splice(before ? this.layout.groups.indexOf(before) : this.layout.groups.length, 0, ng);
        } else this.layout.groups.push(ng);
        this.render();
        this.bringToFront(ng.id);
        this.changed();
        return;
      }
      this.render();
      this.changed();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    void tabEl;
    e.preventDefault();
  }

  private beginGroupDrag(e: PointerEvent, g: GroupLayout): void {
    if (e.button !== 0) return;
    const node = this.groupEls.get(g.id)!;
    const m = this.c.main.getBoundingClientRect();
    const start = node.getBoundingClientRect();
    const offX = e.clientX - start.left, offY = e.clientY - start.top;
    const sx = e.clientX, sy = e.clientY;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
        moving = true;
        if (g.dock === "right") {
          g.dock = "float";
          g.w = start.width;
          this.render();
        }
        this.bringToFront(g.id);
        node.classList.add("dragging");
      }
      g.x = ev.clientX - m.left - offX;
      g.y = ev.clientY - m.top - offY;
      node.style.left = g.x + "px";
      node.style.top = g.y + "px";
      node.style.pointerEvents = "none";
      const t = this.dropTarget(ev.clientX, ev.clientY, g.id);
      node.style.pointerEvents = "";
      this.showIndicator(t.kind === "dock" ? t : { kind: "float" });
    };
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      this.hideIndicator();
      node.classList.remove("dragging");
      if (!moving) return;
      node.style.pointerEvents = "none";
      const t = this.dropTarget(ev.clientX, ev.clientY, g.id);
      node.style.pointerEvents = "";
      if (t.kind === "dock") this.dockGroup(g, t.index);
      else if (t.kind === "group") {
        // Dropping a whole group onto another's tabs merges them.
        const dest = this.layout.groups.find((x) => x.id === t.group)!;
        dest.tabs.splice(t.index, 0, ...g.tabs);
        dest.active = g.active;
        this.layout.groups = this.layout.groups.filter((x) => x !== g);
        this.render();
        this.changed();
      } else {
        this.clampFloats();
        this.changed();
      }
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    e.preventDefault();
  }

  private beginResize(e: PointerEvent, g: GroupLayout, node: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const r = node.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      g.h = Math.max(90, Math.round(r.height + ev.clientY - sy));
      node.style.height = g.h + "px";
      node.style.flex = "";
      if (g.dock === "float") {
        g.w = Math.max(180, Math.round(r.width + ev.clientX - sx));
        node.style.width = g.w + "px";
      }
      window.dispatchEvent(new Event("resize"));
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      this.changed();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  private setupToolboxDrag(): void {
    const tb = this.c.toolbox;
    tb.addEventListener("pointerdown", (e) => {
      const handle = (e.target as HTMLElement).closest(".toolbox-logo, .toolbox-grip");
      if (!handle || e.button !== 0) return;
      e.preventDefault();
      const L = this.layout.toolbox;
      const m = this.c.main.getBoundingClientRect();
      const r = tb.getBoundingClientRect();
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      const sx = e.clientX, sy = e.clientY;
      let moving = false;
      const move = (ev: PointerEvent) => {
        if (!moving) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          moving = true;
          if (L.dock === "left") {
            L.dock = "float";
            this.render();
          }
        }
        L.x = ev.clientX - m.left - offX;
        L.y = ev.clientY - m.top - offY;
        tb.style.left = L.x + "px";
        tb.style.top = L.y + "px";
      };
      const up = (ev: PointerEvent) => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (!moving) return;
        // Drop near the left edge to dock it again.
        if (ev.clientX - m.left < 40) L.dock = "left";
        this.render();
        this.changed();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
    tb.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest(".toolbox-logo, .toolbox-grip")) return;
      const L = this.layout.toolbox;
      L.dock = L.dock === "left" ? "float" : "left";
      this.render();
      this.changed();
    });
  }

  private setupDockSplitter(): void {
    this.c.dock.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).classList.contains("dock-splitter")) return;
      e.preventDefault();
      const sx = e.clientX;
      const w0 = this.layout.dockWidth;
      const move = (ev: PointerEvent) => {
        this.layout.dockWidth = Math.max(180, Math.min(600, w0 - (ev.clientX - sx)));
        this.c.main.style.gridTemplateColumns = this.c.main.style.gridTemplateColumns.replace(/\S+$/, this.layout.dockWidth + "px");
        window.dispatchEvent(new Event("resize"));
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        this.render();
        this.changed();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }
}
