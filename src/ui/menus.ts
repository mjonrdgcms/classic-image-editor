/**
 * Menus: the menu bar (PS7's menus in PS7's order) and popup menus used by
 * palette flyouts. Items from later milestones show greyed out with a
 * tooltip, so the structure is familiar from day one.
 */

import type { UIAction } from "./actions";
import { el } from "./dialogs";

export type MenuItem =
  | "-"
  | UIAction
  | { label: string; soon: string; shortcut?: string }
  | { label: string; submenu: MenuItem[] | (() => MenuItem[]) }
  | { label: string; run?: () => void; enabled?: boolean | (() => boolean); checked?: boolean | (() => boolean); shortcut?: string };

const isSoon = (i: MenuItem): i is { label: string; soon: string; shortcut?: string } => typeof i === "object" && "soon" in i;
const isSub = (i: MenuItem): i is { label: string; submenu: MenuItem[] | (() => MenuItem[]) } => typeof i === "object" && "submenu" in i;

const val = <T,>(v: T | (() => T) | undefined, fallback: T): T => (v === undefined ? fallback : typeof v === "function" ? (v as () => T)() : v);

/** Display a shortcut the platform's way (Cmd on macOS). */
export function prettyShortcut(s: string): string {
  if (/Mac/.test(navigator.platform)) return s.replace(/Ctrl\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Shift\+/g, "⇧");
  return s;
}

/** Optional hook that returns the live shortcut for an action (after customization). */
let shortcutLookup: ((a: UIAction) => string | undefined) | null = null;
export function setShortcutLookup(fn: (a: UIAction) => string | undefined): void {
  shortcutLookup = fn;
}

interface OpenMenu {
  pops: HTMLElement[];
  onClose?: () => void;
}
let current: OpenMenu | null = null;

export function closeMenus(): void {
  if (!current) return;
  const c = current;
  current = null;
  c.pops.forEach((p) => p.remove());
  c.onClose?.();
}

function renderPop(items: MenuItem[], x: number, y: number, depth: number): HTMLElement {
  const pop = el("div", { class: "menu-pop", role: "menu", style: `left:${x}px;top:${y}px` });
  for (const it of items) {
    if (it === "-") {
      pop.append(el("div", { class: "menu-sep" }));
      continue;
    }
    if (isSub(it)) {
      const row = el("div", { class: "menu-item", role: "menuitem", "aria-haspopup": "true" }, el("span"), el("span", { text: it.label }), el("span"), el("span", { class: "arrow" }));
      row.addEventListener("mouseenter", () => {
        if (!current) return;
        current.pops.splice(depth + 1).forEach((p) => p.remove());
        pop.querySelectorAll(".active").forEach((n) => n.classList.remove("active"));
        row.classList.add("active");
        const r = row.getBoundingClientRect();
        const sub = renderPop(val(it.submenu, []), r.right - 2, r.top - 3, depth + 1);
        document.body.append(sub);
        fit(sub, r.left);
        current.pops.push(sub);
      });
      pop.append(row);
      continue;
    }
    const soon = isSoon(it);
    const disabled = soon || !val((it as { enabled?: boolean | (() => boolean) }).enabled, true);
    const checked = !soon && val((it as { checked?: boolean | (() => boolean) }).checked, false);
    const looked = soon ? undefined : shortcutLookup?.(it as UIAction);
    const sc = soon ? it.shortcut : looked !== undefined ? looked : (it as { shortcut?: string }).shortcut;
    const row = el(
      "div",
      { class: "menu-item" + (disabled ? " disabled" : ""), role: "menuitem", "aria-disabled": disabled, title: soon ? `Planned for ${it.soon}` : "" },
      el("span", { text: checked ? "✓" : "" }),
      el("span", { text: it.label }),
      el("span", { class: "sc", text: sc ? prettyShortcut(sc) : "" }),
      el("span"),
    );
    row.addEventListener("mouseenter", () => {
      if (!current) return;
      current.pops.splice(depth + 1).forEach((p) => p.remove());
      pop.querySelectorAll(".active").forEach((n) => n.classList.remove("active"));
    });
    const run = (it as { run?: () => void | Promise<void> }).run;
    if (!disabled && run) {
      row.addEventListener("click", () => {
        closeMenus();
        void run();
      });
    }
    pop.append(row);
  }
  return pop;
}

/** Keep a popup on screen; flip a submenu to the left if needed. */
function fit(pop: HTMLElement, parentLeft?: number): void {
  const r = pop.getBoundingClientRect();
  if (r.right > window.innerWidth - 2) pop.style.left = (parentLeft !== undefined ? parentLeft - r.width + 2 : window.innerWidth - r.width - 2) + "px";
  if (r.bottom > window.innerHeight - 2) pop.style.top = Math.max(2, window.innerHeight - r.height - 2) + "px";
}

/** Show a popup menu at screen coordinates (palette flyouts, context menus). */
export function showPopupMenu(items: MenuItem[], x: number, y: number, onClose?: () => void): void {
  closeMenus();
  const pop = renderPop(items, x, y, 0);
  document.body.append(pop);
  fit(pop);
  current = { pops: [pop], onClose };
}

document.addEventListener(
  "pointerdown",
  (e) => {
    if (current && !(e.target as HTMLElement).closest?.(".menu-pop, .menu-title")) closeMenus();
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (current && e.key === "Escape") {
    closeMenus();
    e.stopPropagation();
  }
});

export function mountMenuBar(root: HTMLElement, menus: { title: string; items: MenuItem[] | (() => MenuItem[]) }[]): void {
  let openTitle: HTMLElement | null = null;
  const open = (t: HTMLElement, items: MenuItem[]) => {
    const r = t.getBoundingClientRect();
    showPopupMenu(items, r.left, r.bottom, () => {
      t.classList.remove("open");
      if (openTitle === t) openTitle = null;
    });
    t.classList.add("open");
    openTitle = t;
  };
  for (const m of menus) {
    const t = el("div", { class: "menu-title", text: m.title, role: "menuitem", tabindex: -1 });
    t.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (openTitle === t) closeMenus();
      else open(t, val(m.items, []));
    });
    t.addEventListener("mouseenter", () => {
      if (openTitle && openTitle !== t) open(t, val(m.items, []));
    });
    root.append(t);
  }
}
