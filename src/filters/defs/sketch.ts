/** Sketch: drawing media, mostly in the foreground/background colors like PS7. */

import { halftoneMask, sketchGray } from "../fx";
import { Img, RGB, clamp, fbm, gauss1, grayOf, hash2, hexRGB, lerp, mapRGB, sobel } from "../img";
import { angle, check, color, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

const C = "Sketch";

/** Paint a 0..1 "ink" amount between paper (bg) and ink (fg). */
function twoTone(src: Img, ink: (i: number) => number, inkC: RGB, paperC: RGB): Img {
  return mapRGB(src, (_r, _g, _b, i) => {
    const k = clamp(ink(i), 0, 1);
    return [lerp(paperC[0], inkC[0], k), lerp(paperC[1], inkC[1], k), lerp(paperC[2], inkC[2], k)];
  });
}

const useColors = check("useFgBg", "Use Foreground/Background Colors", false);
const colorsOf = (p: Record<string, any>, env: { fg: RGB; bg: RGB }, ink = "#1c1c1c", paper = "#f7f4ec"): [RGB, RGB] =>
  p.useFgBg ? [env.fg, env.bg] : [hexRGB(p.ink ?? ink), hexRGB(p.paper ?? paper)];

export const sketchFilters: FilterDef[] = [
  {
    id: "halftonePattern",
    name: "Halftone Pattern",
    category: C,
    description: "Halftone screen of dots, lines or circles in two colors.",
    tags: ["halftone", "screen", "dots"],
    params: [px("size", "Size", 2, 40, 6), sel("shape", "Pattern Type", [["dot", "Dot"], ["line", "Line"], ["square", "Square"], ["cross", "Cross"]], "dot"), angle("angle", "Screen Angle", 45, 0, 180), pct("contrast", "Contrast", 50), useColors],
    run(src, p, env) {
      const [ink, paper] = colorsOf(p, env);
      const g = grayOf(src);
      const k = 1 + (p.contrast - 50) / 40;
      for (let i = 0; i < g.length; i++) g[i] = clamp(128 + (g[i] - 128) * k);
      const m = halftoneMask(g, src.w, src.h, p.size, p.angle, p.shape);
      return twoTone(src, (i) => m[i], ink, paper);
    },
  },
  {
    id: "photocopy",
    name: "Photocopy",
    category: C,
    description: "A worn photocopy: dark edges, washed-out flats.",
    tags: ["xerox", "copy", "zine"],
    params: [px("detail", "Detail", 1, 24, 7), pct("darkness", "Darkness", 50), useColors, pct("toner", "Toner Noise", 20), seed(12)],
    pad: (p) => p.detail * 3,
    run(src, p, env) {
      const [ink, paper] = colorsOf(p, env);
      const g = grayOf(src);
      const bl = gauss1(g, src.w, src.h, p.detail);
      return twoTone(src, (i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const d = (bl[i] - g[i]) / (12 + (100 - p.darkness) * 0.5);
        return d + (hash2(x, y, p.seed) - 0.5) * (p.toner / 100) * 0.8 + (g[i] < 25 ? 1 : 0);
      }, ink, paper);
    },
  },
  {
    id: "stamp",
    name: "Stamp",
    category: C,
    description: "Looks like a rubber stamp print.",
    tags: ["stamp", "rubber", "print"],
    params: [pct("balance", "Light/Dark Balance", 50), range("smooth", "Smoothness", 1, 10, 2), pct("wear", "Wear", 25), useColors, seed(13)],
    pad: (p) => p.smooth * 3,
    run(src, p, env) {
      const [ink, paper] = colorsOf(p, env);
      const g = gauss1(grayOf(src), src.w, src.h, p.smooth * 0.4 * env.scale + 0.3);
      const t = 70 + p.balance * 1.2;
      const sc = 6 * env.scale + 1;
      return twoTone(src, (i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const wear = fbm(x / sc, y / sc, 3, p.seed) < (p.wear / 100) * 0.55 ? 0 : 1;
        return (g[i] < t ? 1 : 0) * wear;
      }, ink, paper);
    },
  },
  {
    id: "basRelief",
    name: "Bas Relief",
    category: C,
    description: "Carves the picture in low relief, lit from one side.",
    tags: ["relief", "carving", "emboss"],
    params: [range("detail", "Detail", 1, 15, 13), range("smooth", "Smoothness", 1, 15, 3), sel("light", "Light", [["135", "Top Left"], ["90", "Top"], ["45", "Top Right"], ["180", "Left"], ["0", "Right"], ["225", "Bottom Left"], ["270", "Bottom"], ["315", "Bottom Right"]], "135"), useColors],
    pad: (p) => p.smooth * 3,
    run(src, p, env) {
      const [ink, paper] = p.useFgBg ? [env.fg, env.bg] : [[60, 60, 64] as RGB, [220, 218, 212] as RGB];
      const g = gauss1(grayOf(src), src.w, src.h, p.smooth * 0.5 * env.scale + 0.3);
      const a = (+p.light * Math.PI) / 180;
      const lx = Math.cos(a), ly = -Math.sin(a);
      const { gx, gy } = sobel(g, src.w, src.h);
      return twoTone(src, (i) => 0.5 - ((gx[i] * lx + gy[i] * ly) / 255) * (p.detail / 4), ink, paper);
    },
  },
  {
    id: "chrome",
    name: "Chrome",
    category: C,
    description: "Turns the picture into polished chrome.",
    tags: ["metal", "liquid", "silver"],
    params: [range("detail", "Detail", 0, 10, 4), range("smooth", "Smoothness", 0, 10, 7)],
    pad: (p) => p.smooth * 3 + 3,
    run(src, p, env) {
      const g = gauss1(grayOf(src), src.w, src.h, (p.smooth * 0.5 + 0.6) * env.scale);
      return mapRGB(src, (_r, _g, _b, i) => {
        const v = 128 + 127 * Math.sin((g[i] / 255) * Math.PI * (1.5 + p.detail * 0.5));
        return [v, v, v * 1.03];
      });
    },
  },
  {
    id: "reticulation",
    name: "Reticulation",
    category: C,
    description: "Clumped, shrunken film emulsion: dark grain in shadows, light grain in highlights.",
    tags: ["grain", "emulsion", "film"],
    params: [pct("density", "Density", 12), range("fg", "Foreground Level", 0, 50, 40), range("bg", "Background Level", 0, 50, 5), useColors, seed(15)],
    run(src, p, env) {
      const [ink, paper] = colorsOf(p, env);
      const g = grayOf(src);
      return twoTone(src, (i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const n = (fbm(x / 1.5, y / 1.5, 2, p.seed) - 0.5) * 2.6 + 0.5;
        return (1 - g[i] / 255) * (1 + p.fg / 200) - p.bg / 200 > n + (p.density - 12) / 100 ? 1 : 0;
      }, ink, paper);
    },
  },
  {
    id: "tornEdges",
    name: "Torn Edges",
    category: C,
    description: "Rough torn-paper shapes in two colors.",
    tags: ["paper", "torn", "ragged"],
    params: [pct("balance", "Image Balance", 50), range("smooth", "Smoothness", 1, 15, 11), range("contrast", "Contrast", 1, 25, 17), useColors, seed(16)],
    pad: (p) => p.smooth * 2,
    run(src, p, env) {
      const [ink, paper] = colorsOf(p, env);
      const g = gauss1(grayOf(src), src.w, src.h, (16 - p.smooth) * 0.2 * env.scale + 0.4);
      const t = 50 + p.balance * 1.5;
      return twoTone(src, (i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        return clamp(((t - g[i]) / 255) * p.contrast * 2 + (hash2(x, y, p.seed) - 0.5) * 1.6, 0, 1) > 0.5 ? 1 : 0;
      }, ink, paper);
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    category: C,
    description: "White linework on blueprint blue, with a faint grid.",
    tags: ["cyanotype", "technical", "plan"],
    params: [px("lines", "Line Softness", 1, 20, 4), pct("grid", "Grid", 30), color("paper", "Paper", "#1d4f91")],
    pad: (p) => p.lines * 3,
    run(src, p) {
      const sk = sketchGray(src, p.lines, 1);
      const paper = hexRGB(p.paper);
      return mapRGB(src, (_r, _g, _b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const line = clamp((255 - sk[i]) / 90, 0, 1);
        const gridOn = (x % 24 === 0 || y % 24 === 0 ? 0.35 : 0) * (p.grid / 100);
        const k = Math.max(line, gridOn);
        return [lerp(paper[0], 235, k), lerp(paper[1], 242, k), lerp(paper[2], 255, k)];
      });
    },
  },
];

