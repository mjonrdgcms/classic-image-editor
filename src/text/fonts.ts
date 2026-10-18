/**
 * The font library: ~115 open-license families bundled with the app (loaded
 * on demand from public/fonts), plus the fonts installed on this computer.
 */

import catalog from "./fontcatalog.json";

export type FontCategory = "sans" | "serif" | "display" | "comic" | "script" | "mono" | "installed";

export const CATEGORY_LABELS: Record<FontCategory, string> = {
  sans: "Sans Serif",
  serif: "Serif",
  display: "Display",
  comic: "Comic & Fun",
  script: "Script & Handwriting",
  mono: "Monospace",
  installed: "Installed on this computer",
};

export interface FontFamily {
  family: string;
  category: FontCategory;
  /** Upright weights available (bundled fonts); installed fonts list common weights. */
  weights: number[];
  /** Weights that have a real italic. */
  italics: number[];
  bundled: boolean;
  license?: string;
}

interface CatFace {
  w: number;
  s: number;
  sub: number;
  file: string;
}
interface CatFamily {
  id: string;
  family: string;
  category: FontCategory;
  license: string;
  faces: CatFace[];
}
const CAT = catalog as unknown as { unicode: Record<string, string>; families: CatFamily[] };

export const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
};

export function styleName(weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return w;
  return weight === 400 ? "Italic" : `${w} Italic`;
}

const bundled: FontFamily[] = CAT.families.map((f) => {
  const up = new Set<number>(), it = new Set<number>();
  for (const face of f.faces) (face.s ? it : up).add(face.w);
  return { family: f.family, category: f.category, weights: [...up].sort((a, b) => a - b), italics: [...it].sort((a, b) => a - b), bundled: true, license: f.license };
});

let installed: FontFamily[] = [];
let registered = false;

/** Register every bundled face with the browser (nothing downloads until used). */
export function registerBundledFonts(base = `${import.meta.env.BASE_URL ?? "/"}fonts/`): void {
  if (registered || typeof FontFace === "undefined") return;
  registered = true;
  for (const f of CAT.families)
    for (const face of f.faces) {
      const ff = new FontFace(f.family, `url("${base}${face.file}") format("woff2")`, {
        weight: String(face.w),
        style: face.s ? "italic" : "normal",
        unicodeRange: CAT.unicode[String(face.sub)],
        display: "block",
      });
      document.fonts.add(ff);
    }
}

export function allFamilies(): FontFamily[] {
  return [...bundled, ...installed];
}

export function findFamily(name: string): FontFamily | undefined {
  const n = name.toLowerCase();
  return allFamilies().find((f) => f.family.toLowerCase() === n);
}

export const isBundled = (name: string) => bundled.some((f) => f.family === name);

/** The nearest available weight for a family. */
export function nearestWeight(family: string, weight: number, italic: boolean): number {
  const f = findFamily(family);
  const list = f ? (italic && f.italics.length ? f.italics : f.weights) : [];
  if (!list.length) return weight;
  return list.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), list[0]);
}

/** Every style a family offers, as (weight, italic) pairs. */
export function familyStyles(family: string): { weight: number; italic: boolean }[] {
  const f = findFamily(family);
  if (!f) return [400, 700].flatMap((w) => [{ weight: w, italic: false }, { weight: w, italic: true }]);
  const out: { weight: number; italic: boolean }[] = [];
  for (const w of f.weights) {
    out.push({ weight: w, italic: false });
    if (f.italics.includes(w)) out.push({ weight: w, italic: true });
  }
  for (const w of f.italics) if (!f.weights.includes(w)) out.push({ weight: w, italic: true });
  return out;
}

export const cssFont = (family: string, weight: number, italic: boolean, size: number) =>
  `${italic ? "italic " : ""}${weight} ${size}px "${family.replace(/"/g, "")}", sans-serif`;

/** Load a face (and the glyphs for `text`) before drawing with it. */
export async function ensureFont(family: string, weight = 400, italic = false, text = "AaBb"): Promise<boolean> {
  if (typeof document === "undefined" || !document.fonts) return false;
  try {
    const faces = await document.fonts.load(cssFont(family, weight, italic, 32), text || "A");
    return faces.length > 0 || !isBundled(family);
  } catch {
    return false;
  }
}

export function fontReady(family: string, weight: number, italic: boolean, text = "A"): boolean {
  try {
    return document.fonts.check(cssFont(family, weight, italic, 32), text || "A");
  } catch {
    return true;
  }
}

/** Common Windows / macOS / Linux fonts to look for when the system can't list them. */
const COMMON_SYSTEM = [
  "Arial", "Arial Black", "Bahnschrift", "Calibri", "Cambria", "Candara", "Comic Sans MS", "Consolas", "Constantia", "Corbel",
  "Courier New", "Ebrima", "Franklin Gothic Medium", "Gabriola", "Gadugi", "Georgia", "Impact", "Ink Free", "Javanese Text",
  "Leelawadee UI", "Lucida Console", "Lucida Sans Unicode", "Malgun Gothic", "Microsoft Sans Serif", "MV Boli", "Palatino Linotype",
  "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Black", "Segoe UI Semibold", "Segoe UI Light", "Sitka Text", "Sylfaen",
  "Tahoma", "Times New Roman", "Trebuchet MS", "Verdana", "Garamond", "Book Antiqua", "Century Gothic", "Bookman Old Style",
  "Copperplate Gothic Bold", "Brush Script MT", "Lucida Handwriting", "Old English Text MT", "Papyrus", "Rockwell", "Stencil",
  "Helvetica", "Helvetica Neue", "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima", "Baskerville", "Didot", "Hoefler Text",
  "American Typewriter", "Chalkboard", "Marker Felt", "Menlo", "Monaco", "SF Pro", "DejaVu Sans", "DejaVu Serif", "Liberation Sans",
  "Liberation Serif", "Noto Sans", "Noto Serif", "Ubuntu", "Cantarell",
];

/** Is a family installed? (Compare its width against the generic fallbacks.) */
function installedCheck(family: string): boolean {
  const c = document.createElement("canvas").getContext("2d");
  if (!c) return false;
  const sample = "mmmmmmmmmmlli1WwQ@&";
  for (const base of ["monospace", "serif", "sans-serif"]) {
    c.font = `72px ${base}`;
    const w0 = c.measureText(sample).width;
    c.font = `72px "${family}", ${base}`;
    if (c.measureText(sample).width !== w0) return true;
  }
  return false;
}

/**
 * Find the fonts installed on this computer: the Local Font Access API when
 * the webview allows it, otherwise a check of common font names.
 */
export async function loadInstalledFonts(): Promise<FontFamily[]> {
  const names = new Set<string>();
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (q) {
    try {
      for (const f of await q()) names.add(f.family);
    } catch {
      /* not permitted: fall back to probing */
    }
  }
  if (!names.size) for (const n of COMMON_SYSTEM) if (installedCheck(n)) names.add(n);
  const taken = new Set(bundled.map((f) => f.family.toLowerCase()));
  installed = [...names]
    .filter((n) => !taken.has(n.toLowerCase()))
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({ family, category: "installed" as const, weights: [400, 700], italics: [400, 700], bundled: false }));
  return installed;
}

export function bundledCount(): number {
  return bundled.length;
}
