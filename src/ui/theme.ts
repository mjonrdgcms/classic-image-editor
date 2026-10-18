/**
 * Interface themes.
 *
 * A theme is nine base colors. Everything else the stylesheet needs (hover
 * and pressed states, strong borders, selection fills, shadows, text on the
 * accent color) is derived from them, so a custom theme only has to pick
 * those nine and still looks consistent. Corner rounding and text size are
 * separate settings that work with any theme.
 */

import * as storage from "./storage";

export interface ThemeColors {
  /** Menu bar, options bar, toolbox and status bar. */
  bg: string;
  /** Palette and window surfaces. */
  panel: string;
  /** Buttons, tabs, raised controls. */
  raised: string;
  /** Text fields and lists. */
  field: string;
  /** Hairlines between areas. */
  border: string;
  text: string;
  textDim: string;
  /** Selection, active tool, focus. */
  accent: string;
  /** Behind the image windows and around the image. */
  workspace: string;
}

export const COLOR_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "bg", label: "Bars and toolbox" },
  { key: "panel", label: "Panels and windows" },
  { key: "raised", label: "Buttons and tabs" },
  { key: "field", label: "Text fields and lists" },
  { key: "border", label: "Borders" },
  { key: "text", label: "Text" },
  { key: "textDim", label: "Secondary text" },
  { key: "accent", label: "Accent" },
  { key: "workspace", label: "Image area" },
];

export interface ThemeDef {
  id: string;
  name: string;
  colors: ThemeColors;
  user?: boolean;
}

export type Corners = "square" | "soft" | "round";
export type TextSize = "small" | "medium" | "large";

export interface Appearance {
  theme: string;
  /** Per-color changes on top of the chosen theme. */
  custom: Partial<ThemeColors>;
  corners: Corners;
  textSize: TextSize;
}

export const THEMES: ThemeDef[] = [
  {
    id: "graphite",
    name: "Graphite",
    colors: { bg: "#1c1d20", panel: "#25262a", raised: "#303136", field: "#18191b", border: "#37383e", text: "#e4e5e8", textDim: "#9ea1a9", accent: "#6b9cff", workspace: "#131416" },
  },
  {
    id: "darkroom",
    name: "Darkroom",
    colors: { bg: "#1a1614", panel: "#231e1b", raised: "#2f2824", field: "#151210", border: "#3b322d", text: "#eee4dc", textDim: "#a09186", accent: "#f0a04b", workspace: "#0f0c0b" },
  },
  {
    id: "cyanotype",
    name: "Cyanotype",
    colors: { bg: "#0f1b2d", panel: "#152338", raised: "#1e304b", field: "#0c1626", border: "#283c5c", text: "#e0eaf6", textDim: "#8ca2bf", accent: "#7dd3e8", workspace: "#0a1322" },
  },
  {
    id: "slate",
    name: "Slate",
    colors: { bg: "#33363b", panel: "#3c4046", raised: "#464a51", field: "#2b2e32", border: "#52575e", text: "#eef0f3", textDim: "#bcc0c7", accent: "#8ec5ff", workspace: "#26282c" },
  },
  {
    id: "moss",
    name: "Moss",
    colors: { bg: "#181d1a", panel: "#202722", raised: "#2b342d", field: "#141815", border: "#343f37", text: "#e4ece5", textDim: "#91a295", accent: "#a6d36f", workspace: "#111412" },
  },
  {
    id: "dusk",
    name: "Dusk",
    colors: { bg: "#1d1a24", panel: "#26222f", raised: "#322c3d", field: "#18161e", border: "#3c3648", text: "#ece7f3", textDim: "#9d95ab", accent: "#c49bff", workspace: "#141218" },
  },
  {
    id: "studio",
    name: "Studio",
    colors: { bg: "#e7e9ed", panel: "#f5f6f8", raised: "#ffffff", field: "#ffffff", border: "#d2d6dc", text: "#1c2026", textDim: "#5b626c", accent: "#2f6fdb", workspace: "#c6cad1" },
  },
  {
    id: "linen",
    name: "Linen",
    colors: { bg: "#e9e5de", panel: "#f5f2ed", raised: "#fffdf9", field: "#fffdf9", border: "#d6cfc4", text: "#2a2520", textDim: "#665d53", accent: "#18766d", workspace: "#cbc4b8" },
  },
  {
    id: "classic",
    name: "Classic 2002",
    colors: { bg: "#d4d0c8", panel: "#d4d0c8", raised: "#e6e3dd", field: "#ffffff", border: "#9d998f", text: "#000000", textDim: "#524f4a", accent: "#0a246a", workspace: "#808080" },
  },
  {
    id: "contrast",
    name: "High Contrast",
    colors: { bg: "#000000", panel: "#0b0b0b", raised: "#1c1c1c", field: "#000000", border: "#a0a0a0", text: "#ffffff", textDim: "#d6d6d6", accent: "#ffd400", workspace: "#000000" },
  },
];

export const DEFAULT_APPEARANCE: Appearance = { theme: "graphite", custom: {}, corners: "soft", textSize: "medium" };

// ------------------------------------------------------------------ color math

type RGB = [number, number, number];

export function parseHex(h: string): RGB {
  let s = h.trim().replace(/^#/, "");
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
}

export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a), y = parseHex(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance. */
export function luminance(h: string): number {
  const c = parseHex(h).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const rgba = (h: string, a: number) => {
  const [r, g, b] = parseHex(h);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/** Every CSS custom property a theme sets. */
export function deriveTokens(c: ThemeColors, corners: Corners, textSize: TextSize): Record<string, string> {
  const dark = luminance(c.panel) < 0.18;
  const accentText = contrast(c.accent, "#ffffff") >= contrast(c.accent, "#10131a") ? "#ffffff" : "#10131a";
  const radius = { square: [0, 0, 0], soft: [3, 5, 9], round: [5, 8, 13] }[corners];
  const size = { small: 11, medium: 12, large: 13 }[textSize];
  const shade = dark ? "0, 0, 0" : "24, 32, 48";
  return {
    "--bg": c.bg,
    "--panel": c.panel,
    "--raised": c.raised,
    "--field": c.field,
    "--border": c.border,
    "--text": c.text,
    "--text-dim": c.textDim,
    "--accent": c.accent,
    "--workspace": c.workspace,
    "--hover": mix(c.raised, c.text, 0.08),
    "--pressed": mix(c.raised, c.text, 0.16),
    "--panel-hover": mix(c.panel, c.text, 0.06),
    "--border-strong": mix(c.border, c.text, 0.28),
    "--divider": mix(c.panel, c.border, 0.7),
    "--accent-text": accentText,
    "--accent-soft": rgba(c.accent, dark ? 0.22 : 0.16),
    "--accent-line": rgba(c.accent, 0.55),
    "--sel-bg": mix(c.panel, c.accent, dark ? 0.3 : 0.2),
    "--sel-text": c.text,
    "--scroll": mix(c.panel, c.text, 0.22),
    "--danger": dark ? "#ff7b72" : "#c62828",
    "--shadow-sm": `0 1px 2px rgba(${shade}, ${dark ? 0.4 : 0.1})`,
    "--shadow-md": `0 4px 14px rgba(${shade}, ${dark ? 0.4 : 0.12}), 0 1px 3px rgba(${shade}, ${dark ? 0.35 : 0.1})`,
    "--shadow-lg": `0 18px 48px rgba(${shade}, ${dark ? 0.55 : 0.2}), 0 3px 10px rgba(${shade}, ${dark ? 0.4 : 0.12})`,
    "--backdrop": dark ? "rgba(0, 0, 0, 0.45)" : "rgba(24, 32, 48, 0.22)",
    "--r-sm": radius[0] + "px",
    "--r-md": radius[1] + "px",
    "--r-lg": radius[2] + "px",
    "--fs": size + "px",
    "--fs-sm": size - 1 + "px",
    // Older names still read by a few components.
    "--face": c.panel,
    "--face-2": mix(c.raised, c.text, 0.08),
  };
}

// ------------------------------------------------------------------ manager

const KEY = "appearance";
const SAVED_KEY = "themes";

export class ThemeManager {
  appearance: Appearance;
  saved: ThemeDef[];
  /** Called whenever colors on screen change (including live previews). */
  onApply: (() => void) | null = null;

  constructor() {
    const a = storage.load<Partial<Appearance>>(KEY, {});
    // Older versions stored "classic" / "dark" under "theme".
    const legacy = storage.load<string | null>("theme", null);
    this.appearance = { ...DEFAULT_APPEARANCE, ...(legacy === "classic" && !a.theme ? { theme: "classic" } : {}), ...a, custom: { ...(a.custom ?? {}) } };
    this.saved = storage.load<ThemeDef[]>(SAVED_KEY, []).filter((t) => t && t.id && t.colors).map((t) => ({ ...t, user: true }));
    if (!this.find(this.appearance.theme)) this.appearance.theme = DEFAULT_APPEARANCE.theme;
  }

  all(): ThemeDef[] {
    return [...THEMES, ...this.saved];
  }

  find(id: string): ThemeDef | undefined {
    return this.all().find((t) => t.id === id);
  }

  /** The colors in effect: the chosen theme plus any per-color changes. */
  colors(a: Appearance = this.appearance): ThemeColors {
    const base = (this.find(a.theme) ?? THEMES[0]).colors;
    return { ...base, ...a.custom };
  }

  get isDark(): boolean {
    return luminance(this.colors().panel) < 0.18;
  }

  /** Apply an appearance to the page (does not save it). */
  apply(a: Appearance = this.appearance): void {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(deriveTokens(this.colors(a), a.corners, a.textSize))) root.style.setProperty(k, v);
    const dark = luminance(this.colors(a).panel) < 0.18;
    root.dataset.tone = dark ? "dark" : "light";
    root.dataset.theme = a.theme;
    root.dataset.corners = a.corners;
    root.style.colorScheme = dark ? "dark" : "light";
    this.onApply?.();
  }

  /** Change and save the appearance. */
  set(patch: Partial<Appearance>): void {
    this.appearance = { ...this.appearance, ...patch, custom: { ...(patch.custom ?? (patch.theme && patch.theme !== this.appearance.theme ? {} : this.appearance.custom)) } };
    storage.save(KEY, this.appearance);
    this.apply();
  }

  /** Save colors as a named theme (replacing one of yours with the same name) and switch to it. */
  saveAs(name: string, colors: ThemeColors = this.colors()): ThemeDef {
    const existing = this.saved.find((t) => t.name.toLowerCase() === name.toLowerCase());
    const def: ThemeDef = { id: existing?.id ?? "user-" + Date.now().toString(36), name, colors: { ...colors }, user: true };
    this.saved = existing ? this.saved.map((t) => (t === existing ? def : t)) : [...this.saved, def];
    storage.save(SAVED_KEY, this.saved);
    this.set({ theme: def.id, custom: {} });
    return def;
  }

  deleteSaved(id: string): void {
    this.saved = this.saved.filter((t) => t.id !== id);
    storage.save(SAVED_KEY, this.saved);
    if (this.appearance.theme === id) this.set({ theme: DEFAULT_APPEARANCE.theme, custom: {} });
  }

  /** The image-area color as 0..1 RGB, for the GPU pasteboard (reads what is on screen, so previews count). */
  pasteboard(): [number, number, number] {
    const css = getComputedStyle(document.documentElement).getPropertyValue("--workspace").trim();
    const [r, g, b] = parseHex(css || this.colors().workspace);
    return [r / 255, g / 255, b / 255];
  }
}
