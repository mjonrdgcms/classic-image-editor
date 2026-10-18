/**
 * Window > Appearance > Customize Appearance...
 *
 * Pick a theme from previews, adjust any of its nine colors, corner
 * rounding and text size, and save the result as a theme of your own.
 * Every change previews live; Cancel puts everything back.
 */

import { el, modal } from "./dialogs";
import { COLOR_FIELDS, type Appearance, type Corners, type TextSize, type ThemeColors, type ThemeDef, type ThemeManager } from "./theme";

function mock(c: ThemeColors): HTMLElement {
  const i = (bg: string, cls = "") => el("i", { class: cls, style: `background:${bg}` });
  return el(
    "div",
    { class: "tc-mock", style: `background:${c.workspace};outline:1px solid ${c.border};outline-offset:-1px`, "aria-hidden": "true" },
    el("div", { class: "m-bar", style: `background:${c.bg};border-bottom:1px solid ${c.border}` }),
    el("div", { class: "m-tools", style: `background:${c.bg}` }, i(c.accent), i(c.textDim), i(c.textDim)),
    el(
      "div",
      { class: "m-work" },
      el("div", { class: "m-win", style: `background:${c.panel};outline:1px solid ${c.accent}` }, el("div", { style: `background:${c.raised}` }), el("div", { class: "m-img" })),
    ),
    el("div", { class: "m-dock", style: `background:${c.panel};border-left:1px solid ${c.border}` }, i(c.text), i(c.textDim), i(c.accent, "sel"), i(c.textDim), i(c.textDim)),
  );
}

function segmented<T extends string>(options: [T, string][], value: T, onPick: (v: T) => void): { node: HTMLElement; set: (v: T) => void } {
  const node = el("div", { class: "seg", role: "radiogroup" });
  const btns = options.map(([v, label]) => {
    const b = el("button", { type: "button", role: "radio", text: label });
    b.addEventListener("click", () => {
      set(v);
      onPick(v);
    });
    node.append(b);
    return [v, b] as const;
  });
  const set = (v: T) => btns.forEach(([k, b]) => (b.classList.toggle("on", k === v), b.setAttribute("aria-checked", String(k === v))));
  set(value);
  return { node, set };
}

export async function appearanceDialog(themes: ThemeManager): Promise<void> {
  let original: Appearance = structuredClone(themes.appearance);
  let draft: Appearance = structuredClone(themes.appearance);
  const preview = () => {
    themes.apply(draft);
    render();
  };

  // ---- theme gallery
  const grid = el("div", { class: "theme-grid", role: "radiogroup", "aria-label": "Theme" });
  const cards = new Map<string, HTMLElement>();
  const buildGallery = () => {
    grid.textContent = "";
    cards.clear();
    for (const t of themes.all()) {
      const card = el(
        "button",
        { type: "button", class: "theme-card", role: "radio", title: t.name },
        mock(t.colors),
        el("span", { class: "tc-name" }, t.name, t.user ? el("span", { class: "tc-user", text: "Yours" }) : null),
      );
      card.addEventListener("click", () => {
        draft = { ...draft, theme: t.id, custom: {} };
        preview();
      });
      cards.set(t.id, card);
      grid.append(card);
    }
  };

  // ---- individual colors
  const colorInputs = new Map<keyof ThemeColors, { row: HTMLElement; input: HTMLInputElement }>();
  const colorGrid = el("div", { class: "color-fields" });
  for (const f of COLOR_FIELDS) {
    const input = el("input", { type: "color", "aria-label": f.label });
    input.addEventListener("input", () => {
      draft = { ...draft, custom: { ...draft.custom, [f.key]: input.value } };
      themes.apply(draft);
      renderColors();
    });
    const row = el("label", { class: "color-field" }, input, el("span", { text: f.label }));
    colorInputs.set(f.key, { row, input });
    colorGrid.append(row);
  }
  const resetColors = el("button", { type: "button", class: "btn small", text: "Reset Colors" });
  resetColors.addEventListener("click", () => {
    draft = { ...draft, custom: {} };
    preview();
  });

  // ---- save as / delete
  const nameField = el("input", { type: "text", placeholder: "Theme name", "aria-label": "New theme name", style: "width:180px" });
  const saveBtn = el("button", { type: "button", class: "btn small", text: "Save as Theme" });
  const deleteBtn = el("button", { type: "button", class: "btn small danger", text: "Delete Theme" });
  saveBtn.addEventListener("click", () => {
    const name = nameField.value.trim();
    if (!name) {
      nameField.focus();
      return;
    }
    const def: ThemeDef = themes.saveAs(name, themes.colors(draft));
    draft = { ...draft, theme: def.id, custom: {} };
    themes.set(draft);
    original = structuredClone(draft);
    nameField.value = "";
    buildGallery();
    preview();
  });
  nameField.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      saveBtn.click();
    }
  });
  deleteBtn.addEventListener("click", () => {
    const id = draft.theme;
    themes.deleteSaved(id);
    draft = { ...draft, theme: themes.appearance.theme, custom: {} };
    if (original.theme === id) original = { ...original, theme: draft.theme, custom: {} };
    buildGallery();
    preview();
  });

  // ---- corners and text size
  const corners = segmented<Corners>([["square", "Square"], ["soft", "Soft"], ["round", "Round"]], draft.corners, (v) => {
    draft = { ...draft, corners: v };
    preview();
  });
  const size = segmented<TextSize>([["small", "Small"], ["medium", "Medium"], ["large", "Large"]], draft.textSize, (v) => {
    draft = { ...draft, textSize: v };
    preview();
  });

  const renderColors = () => {
    const c = themes.colors(draft);
    for (const [k, { row, input }] of colorInputs) {
      if (document.activeElement !== input) input.value = c[k];
      row.classList.toggle("changed", k in draft.custom);
    }
    resetColors.disabled = !Object.keys(draft.custom).length;
  };
  const render = () => {
    for (const [id, card] of cards) {
      card.classList.toggle("active", id === draft.theme);
      card.setAttribute("aria-checked", String(id === draft.theme));
    }
    renderColors();
    deleteBtn.style.display = themes.find(draft.theme)?.user ? "" : "none";
    corners.set(draft.corners);
    size.set(draft.textSize);
  };

  buildGallery();
  render();

  const body = el(
    "div",
    { class: "appearance" },
    el("div", { class: "form-heading", text: "Theme" }),
    grid,
    el("div", { class: "form-heading", text: "Colors" }),
    colorGrid,
    el("div", { class: "ap-actions" }, resetColors, el("span", { style: "flex:1" }), nameField, saveBtn, deleteBtn),
    el("div", { class: "form-heading", text: "Layout" }),
    el("div", { class: "ap-row" }, el("span", { class: "label", text: "Corners" }), corners.node),
    el("div", { class: "ap-row" }, el("span", { class: "label", text: "Text size" }), size.node),
  );

  const r = await modal("Appearance", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (r === "ok") themes.set(draft);
  else themes.apply(original);
}
