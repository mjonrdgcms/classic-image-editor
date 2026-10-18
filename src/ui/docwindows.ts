/**
 * Document windows, PS7 style.
 *
 * By default every open image gets its own floating window inside the
 * document area: drag it by its title bar, resize it from its edges, and
 * minimize, maximize or close it from its buttons. Maximized mode fills the
 * area with the active image and shows a tab for each open one. The mode is
 * a preference and is remembered.
 */

import { el } from "./dialogs";
import { ICONS } from "./icons";

export type DocMode = "floating" | "maximized";

export interface DocWindow {
  id: number;
  root: HTMLElement;
  caption: HTMLElement;
  title: HTMLElement;
  grid: HTMLElement;
  viewport: HTMLElement;
  gl: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  rulerTop: HTMLCanvasElement;
  rulerLeft: HTMLCanvasElement;
  /** Floating geometry in px, relative to the document area. */
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
}

export interface WindowHooks {
  /** A window was clicked or otherwise brought forward. */
  activate(w: DocWindow): void;
  /** The close button was pressed (the owner decides whether to close). */
  requestClose(w: DocWindow): void;
  modeChanged(mode: DocMode): void;
}

/** Window chrome: caption (28) + 1px borders, in px. Must match style.css. */
export const CHROME = { w: 2, h: 30 };
const MIN_W = 220;
const MIN_H = 140;

let nextId = 1;

export class DocWindows {
  readonly windows: DocWindow[] = [];
  private order: DocWindow[] = [];
  private tabs: HTMLElement;
  active: DocWindow | null = null;

  constructor(
    readonly area: HTMLElement,
    private hooks: WindowHooks,
    public mode: DocMode,
  ) {
    this.tabs = el("div", { class: "doc-tabs", role: "tablist", "aria-label": "Open images" });
    area.append(this.tabs);
    area.classList.add("mdi");
    new ResizeObserver(() => this.clampAll()).observe(area);
    this.applyMode();
  }

  /** Size of the area windows can use. */
  bounds(): { w: number; h: number } {
    return { w: this.area.clientWidth, h: this.area.clientHeight - (this.mode === "maximized" ? this.tabs.offsetHeight : 0) };
  }

  /**
   * Create a window. contentW/H is the viewport size wanted (the image at
   * its opening zoom); the window is clamped to the area and cascaded.
   */
  create(contentW: number, contentH: number): DocWindow {
    const b = this.bounds();
    const n = this.windows.length;
    const step = 22;
    const w = Math.max(MIN_W, Math.min(b.w - 40, Math.round(contentW + CHROME.w)));
    const h = Math.max(MIN_H, Math.min(b.h - 40, Math.round(contentH + CHROME.h)));
    let x = 12 + (n % 8) * step;
    let y = 12 + (n % 8) * step;
    if (x + w > b.w) x = Math.max(0, b.w - w - 4);
    if (y + h > b.h) y = Math.max(0, b.h - h - 4);

    const rulerTop = el("canvas", { class: "ruler ruler-top", "aria-hidden": "true" });
    const rulerLeft = el("canvas", { class: "ruler ruler-left", "aria-hidden": "true" });
    const gl = el("canvas", { class: "gl" });
    const overlay = el("canvas", { class: "overlay" });
    const viewport = el("div", { class: "viewport" }, gl, overlay);
    const grid = el("div", { class: "doc-grid" }, el("div", { class: "ruler-corner" }), rulerTop, rulerLeft, viewport);
    const title = el("span", { class: "title", text: "" });
    const btn = (icon: string, label: string) => {
      const b = el("button", { type: "button", class: "win-btn", title: label, "aria-label": label });
      b.innerHTML = icon;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      return b;
    };
    const minB = btn('<svg viewBox="0 0 10 10" width="8" height="8"><path d="M1 8h8" stroke="currentColor" stroke-width="2"/></svg>', "Minimize");
    const maxB = btn('<svg viewBox="0 0 10 10" width="8" height="8"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1 2h8" stroke="currentColor" stroke-width="2"/></svg>', "Maximize");
    const closeB = btn(ICONS.close, "Close");
    const caption = el("div", { class: "caption" }, title, el("span", { class: "win-btns" }, minB, maxB, closeB));
    const root = el("div", { class: "docwin", role: "dialog" }, caption, grid);
    for (const edge of ["e", "s", "se", "w", "n", "sw", "ne", "nw"]) root.append(el("div", { class: `win-edge edge-${edge}`, "data-edge": edge }));
    this.area.append(root);

    const win: DocWindow = { id: nextId++, root, caption, title, grid, viewport, gl, overlay, rulerTop, rulerLeft, x, y, w, h, minimized: false };
    this.windows.push(win);
    this.order.push(win);

    root.addEventListener("pointerdown", () => this.hooks.activate(win), true);
    caption.addEventListener("pointerdown", (e) => this.beginMove(e, win));
    caption.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".win-btn")) return;
      this.setMode(this.mode === "floating" ? "maximized" : "floating");
    });
    root.querySelectorAll<HTMLElement>(".win-edge").forEach((h) => h.addEventListener("pointerdown", (e) => this.beginResize(e, win, h.dataset.edge!)));
    minB.addEventListener("click", () => this.setMinimized(win, !win.minimized));
    maxB.addEventListener("click", () => this.setMode(this.mode === "floating" ? "maximized" : "floating"));
    closeB.addEventListener("click", () => this.hooks.requestClose(win));

    this.place(win);
    this.renderTabs();
    return win;
  }

  remove(win: DocWindow): void {
    win.root.remove();
    this.windows.splice(this.windows.indexOf(win), 1);
    this.order.splice(this.order.indexOf(win), 1);
    if (this.active === win) this.active = null;
    this.renderTabs();
  }

  /** The window that should become active after `win` closes. */
  topmost(): DocWindow | null {
    return this.order[this.order.length - 1] ?? null;
  }

  focus(win: DocWindow): void {
    this.active = win;
    this.order.splice(this.order.indexOf(win), 1);
    this.order.push(win);
    this.order.forEach((w, i) => (w.root.style.zIndex = String(i + 1)));
    for (const w of this.windows) w.root.classList.toggle("active", w === win);
    if (win.minimized && this.mode === "maximized") this.setMinimized(win, false);
    this.applyMode();
    this.renderTabs();
  }

  setTitle(win: DocWindow, text: string): void {
    // "name* @ 100% (Layer, RGB)": the name stands out, the rest is quieter.
    const at = text.indexOf(" @ ");
    win.title.textContent = "";
    win.title.append(el("span", { class: "name", text: at < 0 ? text : text.slice(0, at) }));
    if (at >= 0) win.title.append(el("span", { class: "meta", text: text.slice(at + 1) }));
    win.root.setAttribute("aria-label", text);
    this.renderTabs();
  }

  // ---------------------------------------------------------------- geometry

  private place(win: DocWindow): void {
    const s = win.root.style;
    s.left = win.x + "px";
    s.top = win.y + "px";
    s.width = (win.minimized ? 220 : win.w) + "px";
    s.height = win.minimized ? "" : win.h + "px";
  }

  /** Resize a window so its viewport is contentW x contentH (clamped to the area). */
  sizeToContent(win: DocWindow, contentW: number, contentH: number): void {
    if (this.mode === "maximized") return;
    const b = this.bounds();
    win.w = Math.max(MIN_W, Math.min(b.w - win.x - 2, Math.round(contentW + CHROME.w)));
    win.h = Math.max(MIN_H, Math.min(b.h - win.y - 2, Math.round(contentH + CHROME.h)));
    if (win.x + win.w > b.w) win.x = Math.max(0, b.w - win.w);
    if (win.y + win.h > b.h) win.y = Math.max(0, b.h - win.h);
    this.place(win);
  }

  /** The largest viewport a window can have in this area (for Fit on Screen). */
  maxContent(): { w: number; h: number } {
    const b = this.bounds();
    return this.mode === "maximized" ? { w: b.w - CHROME.w, h: b.h - CHROME.h } : { w: b.w - CHROME.w - 4, h: b.h - CHROME.h - 4 };
  }

  /** Move a window so it fills the area from the top-left (Fit on Screen). */
  moveToOrigin(win: DocWindow): void {
    win.x = 0;
    win.y = 0;
    this.place(win);
  }

  private clampAll(): void {
    const b = this.bounds();
    if (!b.w) return;
    for (const w of this.windows) {
      w.x = Math.max(-w.w + 80, Math.min(b.w - 80, w.x));
      w.y = Math.max(0, Math.min(b.h - 24, w.y));
      this.place(w);
    }
  }

  setMinimized(win: DocWindow, v: boolean): void {
    win.minimized = v;
    win.root.classList.toggle("minimized", v);
    if (v) {
      // Park it along the bottom of the area.
      const b = this.bounds();
      const parked = this.windows.filter((w) => w.minimized && w !== win).length;
      win.x = 8 + parked * 228;
      win.y = b.h - 38;
    }
    this.place(win);
    window.dispatchEvent(new Event("resize"));
  }

  cascade(): void {
    this.setMode("floating");
    const b = this.bounds();
    const w = Math.max(MIN_W, Math.round(b.w * 0.6));
    const h = Math.max(MIN_H, Math.round(b.h * 0.6));
    [...this.order].forEach((win, i) => {
      win.minimized = false;
      win.root.classList.remove("minimized");
      win.x = 8 + (i % 10) * 24;
      win.y = 8 + (i % 10) * 24;
      win.w = w;
      win.h = h;
      this.place(win);
    });
  }

  tile(): void {
    this.setMode("floating");
    const b = this.bounds();
    const n = this.windows.length;
    if (!n) return;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cw = Math.floor(b.w / cols), ch = Math.floor(b.h / rows);
    this.windows.forEach((win, i) => {
      win.minimized = false;
      win.root.classList.remove("minimized");
      win.x = (i % cols) * cw;
      win.y = Math.floor(i / cols) * ch;
      win.w = cw - 2;
      win.h = ch - 2;
      this.place(win);
    });
  }

  setMode(mode: DocMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.applyMode();
    this.hooks.modeChanged(mode);
  }

  private applyMode(): void {
    const max = this.mode === "maximized";
    this.area.classList.toggle("maximized", max);
    for (const w of this.windows) {
      w.root.classList.toggle("max", max);
      w.root.style.display = max && w !== this.active ? "none" : "";
      if (!max) this.place(w);
    }
    this.tabs.style.display = max && this.windows.length ? "" : "none";
    window.dispatchEvent(new Event("resize"));
  }

  private renderTabs(): void {
    this.tabs.textContent = "";
    for (const w of this.windows) {
      const t = el("div", { class: "doc-tab" + (w === this.active ? " active" : ""), role: "tab", "aria-selected": w === this.active, text: w.title.querySelector(".name")?.textContent ?? "" });
      t.title = w.root.getAttribute("aria-label") ?? "";
      t.addEventListener("click", () => this.hooks.activate(w));
      const x = el("button", { type: "button", class: "doc-tab-close", "aria-label": "Close", text: "×" });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hooks.requestClose(w);
      });
      t.append(x);
      this.tabs.append(t);
    }
    this.tabs.style.display = this.mode === "maximized" && this.windows.length ? "" : "none";
  }

  // ---------------------------------------------------------------- dragging

  private beginMove(e: PointerEvent, win: DocWindow): void {
    if (e.button !== 0 || this.mode === "maximized") return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, x0 = win.x, y0 = win.y;
    const move = (ev: PointerEvent) => {
      const b = this.bounds();
      win.x = Math.max(-win.w + 80, Math.min(b.w - 80, x0 + ev.clientX - sx));
      win.y = Math.max(0, Math.min(b.h - 24, y0 + ev.clientY - sy));
      this.place(win);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }

  private beginResize(e: PointerEvent, win: DocWindow, edge: string): void {
    if (e.button !== 0 || this.mode === "maximized" || win.minimized) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const o = { x: win.x, y: win.y, w: win.w, h: win.h };
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (edge.includes("e")) win.w = Math.max(MIN_W, o.w + dx);
      if (edge.includes("s")) win.h = Math.max(MIN_H, o.h + dy);
      if (edge.includes("w")) {
        win.w = Math.max(MIN_W, o.w - dx);
        win.x = o.x + o.w - win.w;
      }
      if (edge.includes("n")) {
        win.h = Math.max(MIN_H, o.h - dy);
        win.y = Math.max(0, o.y + o.h - win.h);
      }
      this.place(win);
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }
}
