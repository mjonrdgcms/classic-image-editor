/**
 * Type UI: the font menu (every font previewed in itself, searchable, by
 * category, with recent fonts), the Type tool's options bar, and the
 * Character and Paragraph palettes.
 */

import type { App } from "../app";
import { ANTI_ALIAS, TextAlign, TextStyle } from "../core/text";
import { el } from "../ui/dialogs";
import * as storage from "../ui/storage";
import { CATEGORY_LABELS, FontCategory, FontFamily, allFamilies, bundledCount, cssFont, ensureFont, familyStyles, findFamily, loadInstalledFonts, styleName } from "./fonts";
import type { TypeTool } from "./typetool";

export type Part = { node: HTMLElement; sync(): void };

const AA_LABELS: Record<(typeof ANTI_ALIAS)[number], string> = { none: "None", sharp: "Sharp", crisp: "Crisp", strong: "Strong", smooth: "Smooth" };
const SIZES = [6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96, 120, 144, 200, 288];

const typeTool = (app: App) => app.tools.type as TypeTool;
const rgbHex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
const hexRgb = (h: string): [number, number, number] => {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// ---------------------------------------------------------------- font menu

let installedLoaded = false;
const recent = (): string[] => storage.load<string[]>("recentFonts", []);
function addRecent(f: string): void {
  storage.save("recentFonts", [f, ...recent().filter((x) => x !== f)].slice(0, 8));
}

let openMenu: HTMLElement | null = null;
function closeFontMenu(): void {
  openMenu?.remove();
  openMenu = null;
}

/** The font menu: search, categories, recent fonts, each name drawn in its own font. */
export function openFontMenu(anchor: HTMLElement, current: string, pick: (family: string) => void): void {
  if (openMenu) return closeFontMenu();
  const menu = el("div", { class: "font-menu type-ui", role: "dialog", "aria-label": "Fonts" });
  const search = el("input", { type: "search", placeholder: `Search ${bundledCount()}+ fonts`, "aria-label": "Search fonts" });
  const cats: (FontCategory | "all")[] = ["all", "sans", "serif", "display", "comic", "script", "mono", "installed"];
  let cat: FontCategory | "all" = "all";
  const chips = el("div", { class: "fm-cats" });
  for (const c of cats) {
    const b = el("button", { type: "button", class: "fm-cat", text: c === "all" ? "All" : CATEGORY_LABELS[c].replace(" on this computer", "").replace(" & Handwriting", "") });
    b.dataset.cat = c;
    b.addEventListener("click", () => {
      cat = c;
      render();
      search.focus();
    });
    chips.append(b);
  }
  const sample = el("input", { type: "text", placeholder: "Preview text (blank = the font's name)", "aria-label": "Preview text", class: "fm-sample" });
  const list = el("div", { class: "fm-list", role: "listbox" });
  const foot = el("div", { class: "fm-foot" });
  menu.append(search, chips, list, el("div", { class: "fm-bottom" }, sample, foot));

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const row = en.target as HTMLElement;
        io.unobserve(row);
        const fam = row.dataset.family!;
        void ensureFont(fam, 400, false, sample.value || fam).then(() => row.classList.add("loaded"));
      }
    },
    { root: list },
  );

  let rows: HTMLElement[] = [];
  let hi = -1;
  const setHi = (i: number) => {
    rows[hi]?.classList.remove("hi");
    hi = Math.max(0, Math.min(rows.length - 1, i));
    rows[hi]?.classList.add("hi");
    rows[hi]?.scrollIntoView({ block: "nearest" });
  };
  const choose = (f: string) => {
    addRecent(f);
    closeFontMenu();
    pick(f);
  };
  const rowFor = (f: FontFamily) => {
    const row = el("div", { class: "fm-row" + (f.family === current ? " current" : ""), role: "option", title: `${f.family} (${f.bundled ? CATEGORY_LABELS[f.category] + ", " + (f.license ?? "") : "installed"})` });
    row.dataset.family = f.family;
    const prev = el("span", { class: "fm-prev", text: sample.value || f.family });
    prev.style.fontFamily = `"${f.family}", sans-serif`;
    const meta = el("span", { class: "fm-meta", text: `${f.family}${sample.value ? "" : ""}` });
    const styles = familyStyles(f.family).length;
    row.append(prev, el("span", { class: "fm-right" }, sample.value ? meta : null, el("span", { class: "fm-n", text: f.bundled ? `${styles} style${styles === 1 ? "" : "s"}` : "installed" })));
    row.addEventListener("click", () => choose(f.family));
    io.observe(row);
    return row;
  };
  const render = () => {
    chips.querySelectorAll<HTMLElement>(".fm-cat").forEach((b) => b.classList.toggle("on", b.dataset.cat === cat));
    list.textContent = "";
    rows = [];
    const q = search.value.trim().toLowerCase();
    const all = allFamilies().filter((f) => (cat === "all" || f.category === cat) && (!q || f.family.toLowerCase().includes(q) || CATEGORY_LABELS[f.category].toLowerCase().includes(q)));
    const groups: [string, FontFamily[]][] = [];
    if (!q && cat === "all") {
      const rec = recent().map((n) => findFamily(n)).filter((f): f is FontFamily => !!f);
      if (rec.length) groups.push(["Recent", rec]);
    }
    for (const c of Object.keys(CATEGORY_LABELS) as FontCategory[]) {
      const fs = all.filter((f) => f.category === c);
      if (fs.length) groups.push([CATEGORY_LABELS[c], fs]);
    }
    for (const [label, fs] of groups) {
      list.append(el("div", { class: "fm-group", text: label }));
      for (const f of fs) {
        const r = rowFor(f);
        rows.push(r);
        list.append(r);
      }
    }
    if (!rows.length) list.append(el("div", { class: "fm-empty", text: cat === "installed" && !installedLoaded ? "Looking for installed fonts..." : "No fonts match." }));
    foot.textContent = `${all.length} font${all.length === 1 ? "" : "s"}`;
    hi = -1;
    const cur = rows.findIndex((r) => r.dataset.family === current);
    if (cur >= 0 && !q) {
      setHi(cur);
    }
  };
  search.addEventListener("input", render);
  sample.addEventListener("input", render);
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFontMenu();
      anchor.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHi(hi + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && rows[hi]) {
      e.preventDefault();
      choose(rows[hi].dataset.family!);
    }
  });
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const W = 380, H = Math.min(520, window.innerHeight - 24);
  menu.style.width = `${W}px`;
  menu.style.height = `${H}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - W - 8, r.left))}px`;
  menu.style.top = `${r.bottom + H + 8 < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - H - 4)}px`;
  openMenu = menu;
  render();
  search.focus();
  const away = (e: PointerEvent) => {
    if (!openMenu) return document.removeEventListener("pointerdown", away, true);
    if (!menu.contains(e.target as Node) && e.target !== anchor) {
      closeFontMenu();
      document.removeEventListener("pointerdown", away, true);
    }
  };
  document.addEventListener("pointerdown", away, true);
  if (!installedLoaded) {
    installedLoaded = true;
    void loadInstalledFonts().then(() => openMenu === menu && render());
  }
}

// ---------------------------------------------------------------- shared controls

function fontButton(app: App, wide = false): Part {
  const b = el("button", { type: "button", class: "font-pick type-ui" + (wide ? " wide" : ""), "aria-label": "Font family" });
  const name = el("span", { class: "fp-name" });
  b.append(name, el("span", { class: "caret", text: "▾" }));
  b.addEventListener("click", () =>
    openFontMenu(b, typeTool(app).style().font, (family) => {
      const st = typeTool(app).style();
      const styles = familyStyles(family);
      // Keep the weight / italic if the new family has them.
      const best = styles.reduce((a, s) => (Math.abs(s.weight - st.weight) + (s.italic !== st.italic ? 1000 : 0) < Math.abs(a.weight - st.weight) + (a.italic !== st.italic ? 1000 : 0) ? s : a), styles[0] ?? { weight: 400, italic: false });
      void ensureFont(family, best.weight, best.italic).then(() => typeTool(app).applyStyle({ font: family, weight: best.weight, italic: best.italic }));
    }),
  );
  return {
    node: b,
    sync: () => {
      const f = typeTool(app).style().font;
      name.textContent = f;
      name.style.fontFamily = `"${f}", sans-serif`;
      b.title = `Font: ${f}`;
    },
  };
}

function styleSelect(app: App): Part {
  const s = el("select", { "aria-label": "Font style", class: "type-ui" });
  let fam = "";
  s.addEventListener("change", () => {
    const [w, i] = s.value.split("|");
    typeTool(app).applyStyle({ weight: +w, italic: i === "1" });
  });
  return {
    node: s,
    sync: () => {
      const st = typeTool(app).style();
      if (fam !== st.font) {
        fam = st.font;
        s.textContent = "";
        for (const o of familyStyles(fam)) s.append(el("option", { value: `${o.weight}|${o.italic ? 1 : 0}`, text: styleName(o.weight, o.italic) }));
      }
      const v = `${st.weight}|${st.italic ? 1 : 0}`;
      if (![...s.options].some((o) => o.value === v)) s.append(el("option", { value: v, text: styleName(st.weight, st.italic) }));
      s.value = v;
    },
  };
}

/** A number field for one text setting, with an optional preset list. */
function numField(app: App, key: keyof TextStyle, label: string, opts: { min: number; max: number; step?: number; unit?: string; presets?: number[]; icon?: string; auto?: string }): Part {
  const id = `tf-${key}-${Math.random().toString(36).slice(2, 7)}`;
  const n = el("input", { type: "number", min: opts.min, max: opts.max, step: opts.step ?? 1, "aria-label": label, title: label, class: "type-ui" });
  if (opts.presets) n.setAttribute("list", id);
  const dl = opts.presets ? el("datalist", { id }) : null;
  for (const v of opts.presets ?? []) dl!.append(el("option", { value: v }));
  // Sizes are stored in pixels and shown in Preferences > Units & Rulers > Type (points or mm use the image's resolution).
  const lengths = opts.unit === "px";
  const k = () => {
    if (!lengths) return 1;
    const ppi = app.doc?.resolution ?? app.prefs.newResolution;
    const u = app.prefs.typeUnits;
    return u === "points" ? app.prefs.pointsPerInch / ppi : u === "mm" ? 25.4 / ppi : 1;
  };
  const unitText = () => (lengths ? { pixels: "px", points: "pt", mm: "mm" }[app.prefs.typeUnits] : (opts.unit ?? ""));
  n.addEventListener("change", () => {
    let v = +n.value / k();
    if (!isFinite(v)) return;
    v = Math.max(opts.min, Math.min(opts.max, v));
    typeTool(app).applyStyle({ [key]: v } as Partial<TextStyle>);
  });
  const unit = opts.unit ? el("span", { class: "unit", text: unitText() }) : null;
  const node = el("label", { class: "tf-num type-ui", title: label }, opts.icon ? el("span", { class: "tf-icon", text: opts.icon }) : label + ":", n, unit, dl);
  return {
    node,
    sync: () => {
      const v = typeTool(app).style()[key] as number;
      if (document.activeElement !== n) n.value = opts.auto && !v ? "" : String(Math.round(v * k() * 10) / 10);
      if (opts.auto) n.placeholder = opts.auto;
      if (unit) unit.textContent = unitText();
    },
  };
}

function aaSelect(app: App): Part {
  const s = el("select", { "aria-label": "Anti-aliasing", title: "Anti-aliasing", class: "type-ui" });
  for (const a of ANTI_ALIAS) s.append(el("option", { value: a, text: AA_LABELS[a] }));
  s.addEventListener("change", () => typeTool(app).applyStyle({ antiAlias: s.value as TextStyle["antiAlias"] }));
  return { node: el("label", { class: "type-ui" }, el("span", { class: "tf-aa", text: "aa" }), s), sync: () => (s.value = typeTool(app).style().antiAlias) };
}

function alignButtons(app: App, justify: boolean): Part {
  const box = el("span", { class: "mode-btns type-align type-ui", role: "group", "aria-label": "Alignment" });
  const items: [TextAlign, string][] = [
    ["left", "Left align text"],
    ["center", "Center text"],
    ["right", "Right align text"],
  ];
  if (justify) items.push(["justify", "Justify (paragraph text)"]);
  const btns = items.map(([a, title]) => {
    const b = el("button", { type: "button", class: "mode-btn align-btn align-" + a, title, "aria-label": title });
    b.innerHTML = alignIcon(a);
    b.addEventListener("click", () => typeTool(app).applyStyle({ align: a }));
    box.append(b);
    return [a, b] as const;
  });
  return {
    node: box,
    sync: () =>
      btns.forEach(([a, b]) => {
        b.classList.toggle("active", typeTool(app).style().align === a);
        if (a === "justify") b.disabled = !typeTool(app).isParagraph();
      }),
  };
}

function alignIcon(a: TextAlign): string {
  const rows = [12, 8, 12, 6];
  const lines = rows
    .map((w, i) => {
      const len = a === "justify" ? 12 : w;
      const x = a === "left" || a === "justify" ? 2 : a === "center" ? 8 - len / 2 : 14 - len;
      return `<path d="M${x} ${3.5 + i * 3}h${len}"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${lines}</svg>`;
}

function colorSwatch(app: App): Part {
  const c = el("input", { type: "color", "aria-label": "Text color", title: "Text color", class: "type-color type-ui" });
  c.addEventListener("change", () => typeTool(app).applyStyle({ color: hexRgb(c.value) }));
  return { node: c, sync: () => (c.value = rgbHex(typeTool(app).style().color)) };
}

function toggle(app: App, key: "fauxBold" | "fauxItalic" | "allCaps" | "underline" | "strikethrough", text: string, title: string, css: string): Part {
  const b = el("button", { type: "button", class: "tf-toggle type-ui", title, "aria-label": title, "aria-pressed": "false" });
  b.innerHTML = `<span style="${css}">${text}</span>`;
  b.addEventListener("click", () => typeTool(app).applyStyle({ [key]: !typeTool(app).style()[key] }));
  return {
    node: b,
    sync: () => {
      const on = !!typeTool(app).style()[key];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    },
  };
}

// ---------------------------------------------------------------- options bar

export function typeOptionParts(app: App, openPalettes: () => void): Part[] {
  const t = typeTool(app);
  const commit = el("button", { type: "button", class: "btn small type-ui", text: "✓ Commit", title: "Commit the text (Ctrl+Enter)" });
  const cancel = el("button", { type: "button", class: "btn small type-ui", text: "✕ Cancel", title: "Cancel the edit (Esc)" });
  commit.addEventListener("mousedown", (e) => e.preventDefault());
  cancel.addEventListener("mousedown", (e) => e.preventDefault());
  commit.addEventListener("click", () => t.commit());
  cancel.addEventListener("click", () => t.cancel());
  const pal = el("button", { type: "button", class: "btn small type-ui", text: "Character / Paragraph", title: "Show the Character and Paragraph palettes" });
  pal.addEventListener("click", openPalettes);
  return [
    fontButton(app),
    styleSelect(app),
    numField(app, "size", "Font size", { min: 1, max: 5000, unit: "px", presets: SIZES, icon: "T↕" }),
    aaSelect(app),
    alignButtons(app, false),
    colorSwatch(app),
    { node: pal, sync: () => {} },
    {
      node: el("span", { class: "type-edit-btns type-ui" }, commit, cancel),
      sync: () => {
        commit.parentElement!.style.display = t.editing ? "" : "none";
      },
    },
  ];
}

// ---------------------------------------------------------------- palettes

function bindSync(app: App, parts: Part[]): void {
  const sync = () => parts.forEach((p) => p.sync());
  for (const topic of ["settings", "doc", "tool", "sessions", "prefs"] as const) app.on(topic, sync);
  sync();
}

export function characterPalette(app: App): { body: HTMLElement } {
  const font = fontButton(app, true);
  const style = styleSelect(app);
  const size = numField(app, "size", "Font size", { min: 1, max: 5000, unit: "px", presets: SIZES, icon: "T↕" });
  const leading = numField(app, "leading", "Leading (line spacing); blank = auto", { min: 0, max: 10000, unit: "px", icon: "A↕", auto: "Auto" });
  const tracking = numField(app, "tracking", "Tracking (1/1000 em)", { min: -1000, max: 10000, step: 10, icon: "AV" });
  const shift = numField(app, "baselineShift", "Baseline shift", { min: -5000, max: 5000, unit: "px", icon: "A↑" });
  const vs = numField(app, "vScale", "Vertical scale", { min: 1, max: 1000, unit: "%", icon: "↕T" });
  const hs = numField(app, "hScale", "Horizontal scale", { min: 1, max: 1000, unit: "%", icon: "↔T" });
  const col = colorSwatch(app);
  const aa = aaSelect(app);
  const toggles = [
    toggle(app, "fauxBold", "T", "Faux Bold", "font-weight:800"),
    toggle(app, "fauxItalic", "T", "Faux Italic", "font-style:italic"),
    toggle(app, "allCaps", "TT", "All Caps", "font-size:10px;letter-spacing:-0.5px"),
    toggle(app, "underline", "T", "Underline", "text-decoration:underline"),
    toggle(app, "strikethrough", "T", "Strikethrough", "text-decoration:line-through"),
  ];
  const leadingNum = leading.node.querySelector("input")!;
  leadingNum.addEventListener("change", () => {
    if (leadingNum.value === "") typeTool(app).applyStyle({ leading: 0 });
  });
  const parts = [font, style, size, leading, tracking, shift, vs, hs, col, aa, ...toggles];
  bindSync(app, parts);
  const body = el(
    "div",
    { class: "char-pal type-ui" },
    el("div", { class: "cp-row" }, font.node),
    el("div", { class: "cp-row" }, style.node),
    el("div", { class: "cp-grid" }, size.node, leading.node, tracking.node, shift.node, vs.node, hs.node),
    el("div", { class: "cp-row" }, el("span", { class: "cp-label", text: "Color" }), col.node, el("span", { class: "spacer" }), aa.node),
    el("div", { class: "cp-row cp-toggles" }, ...toggles.map((t) => t.node)),
    el("p", { class: "cp-note", text: `${bundledCount()} font families come with the app; installed fonts appear under Installed in the font menu.` }),
  );
  return { body };
}

export function paragraphPalette(app: App): { body: HTMLElement } {
  const align = alignButtons(app, true);
  const convert = el("button", { type: "button", class: "btn small type-ui" });
  convert.addEventListener("click", () => {
    const l = app.doc?.activeLayer;
    if (!l?.text) return;
    if (l.text.box) app.run("type.edit", { pointText: true });
    else {
      const b = l.bounds();
      app.run("type.edit", { box: { w: Math.max(20, Math.ceil(b.w)), h: Math.max(20, Math.ceil(b.h)) } });
    }
  });
  const info = el("p", { class: "cp-note" });
  const parts: Part[] = [
    align,
    {
      node: convert,
      sync: () => {
        const l = app.doc?.activeLayer;
        convert.disabled = !l?.text || typeTool(app).editing;
        convert.textContent = l?.text?.box ? "Convert to Point Text" : "Convert to Paragraph Text";
        info.textContent = l?.text
          ? l.text.box
            ? `Paragraph text in a ${Math.round(l.text.box.w)} × ${Math.round(l.text.box.h)} px box: lines wrap to fit.`
            : "Point text: each line runs from where you clicked. Drag a box with the Type tool for wrapping paragraph text."
          : "Select a type layer, or click with the Type tool (T) to start typing.";
      },
    },
  ];
  bindSync(app, parts);
  return { body: el("div", { class: "para-pal type-ui" }, el("div", { class: "cp-row" }, align.node), el("div", { class: "cp-row" }, convert), info) };
}

/** A small "T" thumbnail for type layers in the Layers palette. */
export function typeThumbFont(family: string): string {
  return cssFont(family, 700, false, 18);
}
