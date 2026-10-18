/**
 * Filter > Filter Library: browse every filter with live thumbnails of your
 * own picture, organize them (favorites, collections, hidden), search,
 * preview at size, tune the settings, save them as presets, and apply.
 * Opening a single filter from the menu uses the same dialog, compact.
 */

import type { App } from "../app";
import { CATEGORIES, FILTERS, FILTER_MAP, type FilterDef } from "../filters";
import { Cancelled, FilterLane } from "../filters/client";
import { downscale, type Img } from "../filters/img";
import { sampleScene } from "../filters/sample";
import { defaults, type ParamDef } from "../filters/types";
import { el, formDialog, sheet } from "./dialogs";
import type { FilterRunner } from "./filterrun";
import { showPopupMenu, type MenuItem } from "./menus";
import { pickText, saveText } from "../io/files";
import { histograms } from "../filters/defs/tone";
import { curvesEditor, levelsEditor } from "./toneeditors";

type Section = { kind: "fav" | "recent" | "all" | "hidden" | "search" } | { kind: "cat"; key: string } | { kind: "coll"; key: string };

const STAR = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2l-3.9 2.2.9-4.3-3.3-3 4.4-.5z" fill="currentColor"/></svg>';

/** Build editable controls for a filter's parameters. */
export function paramControls(def: { params: ParamDef[] }, params: Record<string, any>, onChange: () => void, env: { hist?: Uint32Array[] | null } = {}): HTMLElement {
  const box = el("div", { class: "fl-params" });
  for (const p of def.params) {
    const row = el("div", { class: "fl-param fl-" + p.type });
    const label = el("label", { text: p.label });
    row.append(label);
    const set = (v: unknown) => {
      params[p.key] = v;
      onChange();
    };
    if (p.type === "range" || p.type === "seed") {
      const min = p.type === "seed" ? 0 : p.min, max = p.type === "seed" ? 9999 : p.max;
      const step = p.type === "seed" ? 1 : (p.step ?? (max - min > 20 ? 1 : 0.1));
      const slider = el("input", { type: "range", min, max, step, value: params[p.key], "aria-label": p.label });
      const num = el("input", { type: "number", min, max, step, value: params[p.key], "aria-label": p.label + " value" });
      const unit = p.type === "range" ? el("span", { class: "unit", text: p.unit ?? "" }) : null;
      const fix = (v: number) => {
        let x = Math.max(min, Math.min(max, v));
        if (step >= 1 || p.type === "seed") x = Math.round(x);
        else x = Math.round(x * 100) / 100;
        return x;
      };
      slider.addEventListener("input", () => {
        const v = fix(+slider.value);
        num.value = String(v);
        set(v);
      });
      num.addEventListener("change", () => {
        const v = fix(+num.value);
        num.value = slider.value = String(v);
        set(v);
      });
      const ctl = el("div", { class: "fl-slider" }, slider, num, unit);
      if (p.type === "seed") {
        const b = el("button", { type: "button", class: "btn small", text: "Shuffle", title: "Try a different random pattern" });
        b.addEventListener("click", () => {
          const v = Math.floor(Math.random() * 9999);
          num.value = slider.value = String(v);
          set(v);
        });
        ctl.append(b);
      }
      label.htmlFor = "";
      row.append(ctl);
    } else if (p.type === "select") {
      const s = el("select", { "aria-label": p.label });
      for (const [v, l] of p.options) s.append(el("option", { value: v, text: l }));
      s.value = params[p.key];
      s.addEventListener("change", () => set(s.value));
      row.append(s);
    } else if (p.type === "check") {
      const c = el("input", { type: "checkbox", "aria-label": p.label });
      c.checked = !!params[p.key];
      c.addEventListener("change", () => set(c.checked));
      row.prepend(c);
      label.addEventListener("click", () => c.click());
    } else if (p.type === "color") {
      const c = el("input", { type: "color", value: params[p.key], "aria-label": p.label });
      c.addEventListener("input", () => set(c.value));
      row.append(c);
    } else if (p.type === "levels" || p.type === "curves") {
      label.remove();
      row.append((p.type === "levels" ? levelsEditor : curvesEditor)(String(params[p.key] ?? p.default), env.hist ?? null, (v) => set(v)));
    }
    box.append(row);
  }
  if (!def.params.length) box.append(el("p", { class: "fl-note", text: "This filter has no settings." }));
  return box;
}

/** Thumbnails render one at a time in their own worker, visible cards first. */
class Thumbs {
  private lane = new FilterLane();
  private queue: { id: string; cv: HTMLCanvasElement }[] = [];
  private cache = new Map<string, ImageData>();
  private running = false;
  private stopped = false;
  constructor(private src: Img) {}

  want(id: string, cv: HTMLCanvasElement): void {
    const hit = this.cache.get(id);
    if (hit) return this.draw(cv, hit);
    if (!this.queue.some((q) => q.cv === cv)) this.queue.unshift({ id, cv });
    void this.pump();
  }
  private draw(cv: HTMLCanvasElement, d: ImageData) {
    cv.width = d.width;
    cv.height = d.height;
    cv.getContext("2d")!.putImageData(d, 0, 0);
    cv.classList.add("ready");
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length && !this.stopped) {
      const { id, cv } = this.queue.shift()!;
      if (!cv.isConnected) continue;
      const def = FILTER_MAP.get(id)!;
      try {
        const out = await this.lane.run("filter", id, defaults(def), { fg: [0, 0, 0], bg: [255, 255, 255], scale: this.src.w / 900 }, this.src);
        const d = new ImageData(new Uint8ClampedArray(out.data), out.w, out.h);
        this.cache.set(id, d);
        this.draw(cv, d);
      } catch (e) {
        if (e instanceof Cancelled) break;
        cv.classList.add("failed");
      }
    }
    this.running = false;
  }
  stop() {
    this.stopped = true;
    this.lane.dispose();
  }
}

export async function filterLibrary(
  app: App,
  runner: FilterRunner,
  opts: { filter?: string; compact?: boolean; params?: Record<string, unknown>; onApply?: (id: string, params: Record<string, unknown>) => Promise<boolean> } = {},
): Promise<boolean> {
  const org = runner.org;
  const compact = !!opts.compact;
  const hasDoc = !!app.doc;
  const big = compact ? 640 : 480;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ps = runner.previewSource(Math.round(big * dpr));
  const previewImg: Img = ps?.img ?? sampleScene(Math.round(big * dpr * 0.9), Math.round(big * dpr * 0.68));
  const previewScale = ps ? ps.scale : previewImg.w / 900;
  const thumbSrc = downscale(previewImg, 150);
  let hist: Uint32Array[] | null = null;
  const histOf = () => (hist ??= histograms(previewImg));
  const thumbs = new Thumbs(thumbSrc);
  const lane = new FilterLane();

  let section: Section = opts.filter ? { kind: "cat", key: FILTER_MAP.get(opts.filter)?.category ?? CATEGORIES[0] } : org.data.favorites.length ? { kind: "fav" } : { kind: "all" };
  let current: FilterDef | null = opts.filter ? FILTER_MAP.get(opts.filter) ?? null : null;
  let params: Record<string, any> = current ? { ...defaults(current), ...(opts.params ?? org.lastParams(current.id) ?? {}) } : {};
  let query = "";

  // ---------------------------------------------------------------- layout
  const search = el("input", { type: "search", class: "fl-search", placeholder: "Search filters", "aria-label": "Search filters" });
  const nav = el("nav", { class: "fl-nav", "aria-label": "Filter groups" });
  const side = el("div", { class: "fl-side" }, search, nav);
  const galleryTitle = el("div", { class: "fl-gtitle" });
  const grid = el("div", { class: "fl-grid", role: "listbox", "aria-label": "Filters" });
  const gallery = el("div", { class: "fl-gallery" }, galleryTitle, grid);

  const pv = el("canvas", { class: "fl-preview", title: "Hold the mouse button down to see the original" });
  const pvBusy = el("div", { class: "fl-pvbusy" }, el("span", { class: "spinner" }));
  const pvHint = el("div", { class: "fl-pvhint", text: ps ? "Hold to compare" : "Sample picture (no image open)" });
  const pvWrap = el("div", { class: "fl-pvwrap" }, pv, pvBusy, pvHint);
  const dTitle = el("div", { class: "fl-dtitle" });
  const dDesc = el("p", { class: "fl-desc" });
  const paramBox = el("div", { class: "fl-pbox" });
  const presetSel = el("select", { "aria-label": "Saved settings" });
  const presetSave = el("button", { type: "button", class: "btn small", text: "Save..." });
  const presetDel = el("button", { type: "button", class: "btn small", text: "Delete" });
  const presetRow = el("div", { class: "fl-presets" }, el("span", { class: "fl-plabel", text: "Settings" }), presetSel, presetSave, presetDel);
  const applyBtn = el("button", { type: "button", class: "btn default", text: hasDoc ? "Apply" : "Open an Image to Apply" });
  const resetBtn = el("button", { type: "button", class: "btn", text: "Reset" });
  const cancelBtn = el("button", { type: "button", class: "btn", text: compact ? "Cancel" : "Close" });
  const actions = el("div", { class: "fl-actions" }, resetBtn, el("span", { style: "flex:1" }), cancelBtn, applyBtn);
  const detail = el("div", { class: "fl-detail" }, pvWrap, dTitle, dDesc, presetRow, paramBox, actions);
  const more = el("button", { type: "button", class: "btn small", text: "Organize ▾" });
  galleryTitle.append(el("span", { class: "fl-gname" }), el("span", { class: "fl-count" }), more);

  const body = el("div", { class: "fl-body" + (compact ? " compact" : "") }, ...(compact ? [] : [side, gallery]), detail);
  const dlg = sheet(compact && current ? current.name : "Filter Library", body, {
    className: "fl-dialog" + (compact ? " compact" : ""),
    onKey: (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement && e.target.type === "search")) {
        e.preventDefault();
        // Commit a number that was typed but not yet confirmed.
        (document.activeElement as HTMLElement | null)?.blur?.();
        applyBtn.click();
        return true;
      }
      if (e.key === "/" && !(e.target as HTMLElement).closest("input, select")) {
        e.preventDefault();
        search.focus();
        return true;
      }
      return false;
    },
  });

  // ---------------------------------------------------------------- sidebar
  const sectionList = (s: Section): FilterDef[] => {
    const vis = (f: FilterDef) => !org.isHidden(f.id);
    switch (s.kind) {
      case "fav":
        return org.data.favorites.map((id) => FILTER_MAP.get(id)!).filter(Boolean);
      case "recent":
        return org.data.recent.map((id) => FILTER_MAP.get(id)!).filter(Boolean);
      case "all":
        return FILTERS.filter(vis);
      case "hidden":
        return FILTERS.filter((f) => org.isHidden(f.id));
      case "cat":
        return FILTERS.filter((f) => f.category === s.key && vis(f));
      case "coll":
        return (org.data.collections.find((c) => c.id === s.key)?.filters ?? []).map((id) => FILTER_MAP.get(id)!).filter(Boolean);
      case "search": {
        const q = query.toLowerCase().trim();
        const words = q.split(/\s+/);
        return FILTERS.filter((f) => {
          const hay = [f.name, f.category, f.description, ...(f.tags ?? [])].join(" ").toLowerCase();
          return words.every((w) => hay.includes(w));
        });
      }
    }
  };
  const sameSection = (a: Section, b: Section) => a.kind === b.kind && ("key" in a ? a.key : "") === ("key" in b ? b.key : "");
  const sectionName = (s: Section) =>
    s.kind === "fav" ? "Favorites" : s.kind === "recent" ? "Recently Used" : s.kind === "all" ? "All Filters" : s.kind === "hidden" ? "Hidden Filters" : s.kind === "search" ? `Results for "${query}"` : s.kind === "cat" ? s.key : s.kind === "coll" ? (org.data.collections.find((c) => c.id === s.key)?.name ?? "Collection") : "";

  const navItem = (s: Section, label: string, count: number, extra?: HTMLElement) => {
    const b = el("button", { type: "button", class: "fl-navitem" + (sameSection(s, section) ? " on" : ""), "data-kind": s.kind }, el("span", { class: "n", text: label }), el("span", { class: "c", text: String(count) }), extra ?? null);
    b.addEventListener("click", () => {
      section = s;
      query = "";
      search.value = "";
      renderNav();
      renderGrid();
    });
    if (s.kind === "coll") {
      b.addEventListener("dragover", (e) => {
        e.preventDefault();
        b.classList.add("drop");
      });
      b.addEventListener("dragleave", () => b.classList.remove("drop"));
      b.addEventListener("drop", (e) => {
        e.preventDefault();
        b.classList.remove("drop");
        const id = e.dataTransfer?.getData("text/x-filter");
        if (id) org.addTo(s.key, id);
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        collectionMenu(s.key, e.clientX, e.clientY);
      });
    }
    if (s.kind === "fav") {
      b.addEventListener("dragover", (e) => e.preventDefault());
      b.addEventListener("drop", (e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/x-filter");
        if (id && !org.isFavorite(id)) org.toggleFavorite(id);
      });
    }
    return b;
  };
  const head = (t: string, btn?: HTMLElement) => el("div", { class: "fl-navhead" }, el("span", { text: t }), btn ?? null);

  function renderNav() {
    nav.textContent = "";
    nav.append(
      navItem({ kind: "fav" }, "★ Favorites", org.data.favorites.length),
      navItem({ kind: "recent" }, "Recently Used", org.data.recent.length),
      navItem({ kind: "all" }, "All Filters", FILTERS.filter((f) => !org.isHidden(f.id)).length),
    );
    const add = el("button", { type: "button", class: "icon-btn fl-add", title: "New collection", "aria-label": "New collection", text: "+" });
    add.addEventListener("click", () => void newCollection());
    nav.append(head("Collections", add));
    if (!org.data.collections.length) nav.append(el("p", { class: "fl-hint", text: "Make collections for the filters you use together. Drag filters onto them." }));
    for (const c of org.data.collections) {
      const dots = el("span", { class: "fl-dots", title: "Collection options", text: "⋯" });
      dots.addEventListener("click", (e) => {
        e.stopPropagation();
        const r = dots.getBoundingClientRect();
        collectionMenu(c.id, r.right, r.bottom);
      });
      nav.append(navItem({ kind: "coll", key: c.id }, c.name, c.filters.length, dots));
    }
    nav.append(head("Categories"));
    for (const cat of CATEGORIES) nav.append(navItem({ kind: "cat", key: cat }, cat, FILTERS.filter((f) => f.category === cat && !org.isHidden(f.id)).length));
    if (org.data.hidden.length) nav.append(head("Hidden"), navItem({ kind: "hidden" }, "Hidden Filters", org.data.hidden.length));
  }

  async function newCollection(withFilter?: string) {
    const r = await formDialog("New Collection", [{ key: "name", label: "Name", type: "text", value: "My Filters" }]);
    if (!r || !String(r.name).trim()) return;
    const c = org.addCollection(String(r.name).trim());
    if (withFilter) org.addTo(c.id, withFilter);
    section = { kind: "coll", key: c.id };
    renderNav();
    renderGrid();
  }

  function collectionMenu(id: string, x: number, y: number) {
    const c = org.data.collections.find((c) => c.id === id);
    if (!c) return;
    showPopupMenu(
      [
        {
          label: "Rename...",
          run: async () => {
            const r = await formDialog("Rename Collection", [{ key: "name", label: "Name", type: "text", value: c.name }]);
            if (r && String(r.name).trim()) org.renameCollection(id, String(r.name).trim());
          },
        },
        { label: "Move Up", run: () => org.moveCollection(id, -1) },
        { label: "Move Down", run: () => org.moveCollection(id, 1) },
        "-",
        {
          label: "Delete Collection",
          run: () => {
            org.deleteCollection(id);
            if (section.kind === "coll" && section.key === id) section = { kind: "all" };
          },
        },
      ],
      x,
      y,
    );
  }

  // ---------------------------------------------------------------- gallery
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) thumbs.want((en.target as HTMLElement).dataset.id!, en.target.querySelector("canvas")!);
  }, { root: grid, rootMargin: "120px" });

  function cardMenu(f: FilterDef, x: number, y: number) {
    const inColl = section.kind === "coll" ? section.key : null;
    const items: MenuItem[] = [
      { label: org.isFavorite(f.id) ? "Remove from Favorites" : "Add to Favorites", run: () => org.toggleFavorite(f.id) },
      {
        label: "Add to Collection",
        submenu: () => [
          ...org.data.collections.map((c) => ({ label: c.name, checked: c.filters.includes(f.id), run: () => (c.filters.includes(f.id) ? org.removeFrom(c.id, f.id) : org.addTo(c.id, f.id)) })),
          ...(org.data.collections.length ? ["-" as const] : []),
          { label: "New Collection...", run: () => void newCollection(f.id) },
        ],
      },
    ];
    if (inColl) items.push({ label: "Remove from This Collection", run: () => org.removeFrom(inColl, f.id) });
    items.push("-", { label: org.isHidden(f.id) ? "Show in Menus" : "Hide from Menus", run: () => org.setHidden(f.id, !org.isHidden(f.id)) });
    items.push({ label: `Show in ${f.category}`, run: () => ((section = { kind: "cat", key: f.category }), renderNav(), renderGrid()) });
    showPopupMenu(items, x, y);
  }

  function renderGrid() {
    io.disconnect();
    grid.textContent = "";
    const list = sectionList(section);
    (galleryTitle.querySelector(".fl-gname") as HTMLElement).textContent = sectionName(section);
    (galleryTitle.querySelector(".fl-count") as HTMLElement).textContent = `${list.length} filter${list.length === 1 ? "" : "s"}`;
    if (!list.length) {
      const msg =
        section.kind === "fav"
          ? "No favorites yet. Click the star on any filter to add it here."
          : section.kind === "recent"
            ? "Filters you apply will show up here."
            : section.kind === "coll"
              ? "This collection is empty. Drag filters here, or right-click a filter and choose Add to Collection."
              : "No filters match.";
      grid.append(el("p", { class: "fl-empty", text: msg }));
      return;
    }
    for (const f of list) {
      const cv = el("canvas", { class: "fl-thumb", width: thumbSrc.w, height: thumbSrc.h, "aria-hidden": "true" });
      const star = el("button", { type: "button", class: "fl-star" + (org.isFavorite(f.id) ? " on" : ""), title: org.isFavorite(f.id) ? "Remove from Favorites" : "Add to Favorites", "aria-label": "Favorite" });
      star.innerHTML = STAR;
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        org.toggleFavorite(f.id);
      });
      const card = el(
        "div",
        { class: "fl-card" + (current?.id === f.id ? " on" : "") + (org.isHidden(f.id) ? " hidden-f" : ""), role: "option", tabindex: 0, draggable: "true", "data-id": f.id, title: f.description, "aria-selected": current?.id === f.id },
        cv,
        el("div", { class: "fl-cname" }, el("span", { text: f.name }), star),
        section.kind !== "cat" ? el("div", { class: "fl-ccat", text: f.category }) : null,
      );
      card.addEventListener("click", () => select(f.id));
      card.addEventListener("dblclick", () => void apply());
      card.addEventListener("keydown", (e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (e.key === "Enter" && current?.id === f.id) void apply();
          else select(f.id);
        }
      });
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        cardMenu(f, e.clientX, e.clientY);
      });
      card.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/x-filter", f.id);
        e.dataTransfer!.effectAllowed = "copyMove";
      });
      if (section.kind === "coll") {
        const cid = section.key;
        card.addEventListener("dragover", (e) => e.preventDefault());
        card.addEventListener("drop", (e) => {
          e.preventDefault();
          const id = e.dataTransfer?.getData("text/x-filter");
          if (id && id !== f.id) org.addTo(cid, id, f.id);
        });
      }
      grid.append(card);
      io.observe(card);
    }
  }

  search.addEventListener("input", () => {
    query = search.value;
    section = query.trim() ? { kind: "search" } : { kind: "all" };
    renderNav();
    renderGrid();
  });

  more.addEventListener("click", () => {
    const r = more.getBoundingClientRect();
    showPopupMenu(
      [
        { label: "New Collection...", run: () => void newCollection() },
        "-",
        {
          label: "Export Organization...",
          run: async () => {
            await saveText(org.export(), "filter-organization.json");
          },
        },
        {
          label: "Import Organization...",
          run: async () => {
            const t = await pickText([".json"]);
            if (!t) return;
            try {
              org.import(t);
            } catch (e) {
              app.toast((e as Error).message);
            }
          },
        },
        "-",
        { label: "Reset Favorites and Collections", run: () => org.reset() },
      ],
      r.left,
      r.bottom + 2,
    );
  });

  // ---------------------------------------------------------------- detail
  const pctx = pv.getContext("2d")!;
  let shownResult: ImageData | null = null;
  const original = new ImageData(new Uint8ClampedArray(previewImg.data), previewImg.w, previewImg.h);
  pv.width = previewImg.w;
  pv.height = previewImg.h;
  pctx.putImageData(original, 0, 0);
  pv.addEventListener("pointerdown", () => pctx.putImageData(original, 0, 0));
  const restore = () => shownResult && pctx.putImageData(shownResult, 0, 0);
  pv.addEventListener("pointerup", restore);
  pv.addEventListener("pointerleave", restore);

  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (!current) return;
      pvBusy.classList.add("on");
      try {
        const doc = app.doc;
        const env = { fg: doc ? ([...doc.foreground.slice(0, 3)] as [number, number, number]) : ([0, 0, 0] as [number, number, number]), bg: doc ? ([...doc.background.slice(0, 3)] as [number, number, number]) : ([255, 255, 255] as [number, number, number]), scale: previewScale };
        const out = await lane.run("filter", current.id, params, env, previewImg);
        shownResult = new ImageData(new Uint8ClampedArray(out.data), out.w, out.h);
        pctx.putImageData(shownResult, 0, 0);
        pvBusy.classList.remove("on");
      } catch (e) {
        if (!(e instanceof Cancelled)) {
          pvBusy.classList.remove("on");
          app.toast(String((e as Error).message));
        }
      }
    }, 40);
  };

  function renderPresets() {
    presetSel.textContent = "";
    presetSel.append(el("option", { value: "", text: "Default" }));
    if (!current) return;
    const lp = org.lastParams(current.id);
    if (lp) presetSel.append(el("option", { value: "__last", text: "Last Used" }));
    for (const p of org.presets(current.id)) presetSel.append(el("option", { value: p.name, text: p.name }));
    presetDel.disabled = true;
  }
  presetSel.addEventListener("change", () => {
    if (!current) return;
    const v = presetSel.value;
    const base = defaults(current);
    params = v === "" ? base : v === "__last" ? { ...base, ...org.lastParams(current.id) } : { ...base, ...org.presets(current.id).find((p) => p.name === v)?.params };
    presetDel.disabled = !org.presets(current.id).some((p) => p.name === v);
    renderParams();
    refresh();
  });
  presetSave.addEventListener("click", async () => {
    if (!current) return;
    const r = await formDialog("Save Filter Settings", [{ key: "name", label: "Name", type: "text", value: `${current.name} ${org.presets(current.id).length + 1}` }]);
    if (!r || !String(r.name).trim()) return;
    org.savePreset(current.id, String(r.name).trim(), params);
    renderPresets();
    presetSel.value = String(r.name).trim();
    presetDel.disabled = false;
  });
  presetDel.addEventListener("click", () => {
    if (!current || !presetSel.value) return;
    org.deletePreset(current.id, presetSel.value);
    renderPresets();
  });

  function renderParams() {
    paramBox.textContent = "";
    if (current) paramBox.append(paramControls(current, params, refresh, { hist: histOf() }));
  }

  function select(id: string) {
    const f = FILTER_MAP.get(id);
    if (!f) return;
    current = f;
    params = { ...defaults(f), ...(org.lastParams(f.id) ?? {}) };
    for (const c of grid.querySelectorAll<HTMLElement>(".fl-card")) {
      c.classList.toggle("on", c.dataset.id === id);
      c.setAttribute("aria-selected", String(c.dataset.id === id));
    }
    renderDetail();
    refresh();
  }

  function renderDetail() {
    detail.classList.toggle("empty", !current);
    if (!current) {
      dTitle.textContent = "Pick a filter";
      dDesc.textContent = "Click a filter to preview it on your picture. Double-click to apply it straight away.";
      paramBox.textContent = "";
      applyBtn.disabled = true;
      resetBtn.disabled = true;
      presetRow.style.display = "none";
      return;
    }
    dTitle.textContent = "";
    dTitle.append(el("span", { text: current.name }), el("span", { class: "fl-dcat", text: current.category }));
    dDesc.textContent = current.description;
    applyBtn.disabled = !hasDoc;
    resetBtn.disabled = false;
    presetRow.style.display = "";
    if (compact) dlg.caption.textContent = current.name;
    renderPresets();
    renderParams();
  }

  resetBtn.addEventListener("click", () => {
    if (!current) return;
    params = defaults(current);
    presetSel.value = "";
    renderParams();
    refresh();
  });
  cancelBtn.addEventListener("click", () => dlg.close("cancel"));

  let pending: { id: string; params: Record<string, unknown> } | null = null;
  async function apply() {
    if (!current || !hasDoc || pending) return;
    pending = { id: current.id, params: { ...params } };
    dlg.close("apply");
  }
  applyBtn.addEventListener("click", () => void apply());

  const unsub = org.on(() => {
    renderNav();
    renderGrid();
  });

  if (!compact) {
    renderNav();
    renderGrid();
  }
  renderDetail();
  if (current) refresh();
  (compact ? applyBtn : search).focus();

  const how = await dlg.done;
  unsub();
  io.disconnect();
  thumbs.stop();
  lane.dispose();
  clearTimeout(timer);
  if (how !== "apply" || !pending) return false;
  const { id, params: p } = pending;
  return (opts.onApply ?? ((i, q) => runner.apply(i, q)))(id, p);
}
