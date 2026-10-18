/** Cartoon & Comic. */

import { halftoneMask, inkLines, overlayInk, saturate } from "../fx";
import { Img, RGB, cloneImg, downscale, gauss1, grayOf, guidedSmooth, hexRGB, luma, makeImg, mapRGB, median, medianCut, nearest, resizeNearest } from "../img";
import { check, color, pct, px, range, sel } from "../p";
import type { FilterDef } from "../types";

const C = "Cartoon & Comic";

function smoothFor(src: Img, strength: number, scale = 1): Img {
  // Two guided passes give flat, cartoon-like color fields with crisp edges.
  const r = Math.max(1, Math.round(strength * 2 * scale));
  let s = guidedSmooth(src, r, 18 + strength * 4);
  if (strength > 4) s = guidedSmooth(s, Math.max(1, Math.round(r * 0.6)), 16 + strength * 3);
  return s;
}

const PALETTES: Record<string, RGB[]> = {
  warhol: [[24, 22, 66], [232, 32, 120], [255, 214, 0], [120, 230, 240]],
  lichtenstein: [[20, 20, 20], [230, 30, 40], [255, 220, 40], [240, 240, 235]],
  neon: [[10, 0, 40], [255, 0, 170], [0, 255, 200], [250, 255, 120]],
  retro: [[38, 70, 83], [231, 111, 81], [244, 162, 97], [233, 196, 106]],
  candy: [[90, 30, 110], [255, 90, 160], [120, 220, 255], [255, 250, 210]],
  mint: [[20, 50, 50], [40, 160, 130], [250, 120, 90], [250, 240, 220]],
};
const palOpts: [string, string][] = [["warhol", "Warhol"], ["lichtenstein", "Lichtenstein"], ["neon", "Neon"], ["retro", "Retro"], ["candy", "Candy"], ["mint", "Mint"]];

function popMap(src: Img, pal: RGB[]): Img {
  const n = pal.length;
  return mapRGB(src, (r, g, b) => pal[Math.min(n - 1, Math.floor((luma(r, g, b) / 256) * n))]);
}

export const cartoonFilters: FilterDef[] = [
  {
    id: "popArt",
    name: "Pop Art",
    category: C,
    description: "Maps the picture's tones to four bold flat colors.",
    tags: ["warhol", "poster", "screen print"],
    params: [sel("palette", "Palette", palOpts, "warhol"), range("smooth", "Smoothness", 0, 10, 3), check("ink", "Outlines", false)],
    pad: (p) => p.smooth * 4 + 8,
    run(src, p, env) {
      const s = p.smooth > 0 ? smoothFor(src, p.smooth, env.scale) : src;
      const out = popMap(s, PALETTES[p.palette] ?? PALETTES.warhol);
      return p.ink ? overlayInk(out, inkLines(src, 1.5 * env.scale + 0.5, 0.4, 0.5), [10, 10, 10], 1) : out;
    },
  },
  {
    id: "popArtGrid",
    name: "Pop Art Grid",
    category: C,
    description: "Four copies of the picture in a 2 x 2 grid, each in different pop colors.",
    tags: ["warhol", "grid", "quad"],
    params: [range("smooth", "Smoothness", 0, 10, 2), px("gap", "Gap", 0, 40, 0)],
    run(src, p, env) {
      const { w, h } = src;
      const out = makeImg(w, h);
      const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
      const small = resizeNearest(downscale(p.smooth > 0 ? smoothFor(src, p.smooth, env.scale) : src, Math.max(hw, hh)), hw, hh);
      const pals = [PALETTES.warhol, PALETTES.neon, PALETTES.candy, PALETTES.retro];
      const g = Math.round(p.gap / 2);
      pals.forEach((pal, k) => {
        const tile = popMap(small, pal);
        const ox = (k % 2) * hw, oy = Math.floor(k / 2) * hh;
        for (let y = 0; y < hh; y++)
          for (let x = 0; x < hw; x++) {
            const inGap = x < g || y < g || x >= hw - g || y >= hh - g;
            const q = ((oy + y) * w + ox + x) * 4, s = (y * hw + x) * 4;
            if (inGap) {
              out.data[q] = out.data[q + 1] = out.data[q + 2] = 250;
            } else {
              out.data[q] = tile.data[s];
              out.data[q + 1] = tile.data[s + 1];
              out.data[q + 2] = tile.data[s + 2];
            }
            out.data[q + 3] = 255;
          }
      });
      return out;
    },
  },
  {
    id: "benDay",
    name: "Ben-Day Dots",
    category: C,
    description: "Prints the picture with cyan, magenta and yellow dot screens, like old comic printing.",
    tags: ["halftone", "dots", "print", "lichtenstein"],
    params: [px("dot", "Dot Size", 3, 30, 8), range("sat", "Ink Saturation", 0, 200, 120, "%"), color("paper", "Paper", "#fff8e8")],
    run(src, p) {
      const { w, h } = src;
      const s = saturate(src, p.sat / 100);
      const paper = hexRGB(p.paper);
      const out = cloneImg(s);
      const plates: [number, number][] = [[0, 15], [1, 75], [2, 0]];
      const masks = plates.map(([c, ang]) => {
        const g = new Float32Array(w * h);
        for (let i = 0; i < g.length; i++) g[i] = s.data[i * 4 + c];
        return halftoneMask(g, w, h, p.dot, ang, "dot");
      });
      for (let i = 0; i < w * h; i++) {
        // Subtractive: each dot removes its complementary color from paper.
        const r = paper[0] * (1 - masks[0][i] * 0.95), g = paper[1] * (1 - masks[1][i] * 0.95), b = paper[2] * (1 - masks[2][i] * 0.95);
        out.data[i * 4] = r;
        out.data[i * 4 + 1] = g;
        out.data[i * 4 + 2] = b;
      }
      return out;
    },
  },
  {
    id: "mangaTone",
    name: "Manga Screentone",
    category: C,
    description: "Black-and-white manga look: ink lines, white highlights and dotted screentone in the midtones.",
    tags: ["manga", "screentone", "black and white", "japanese"],
    params: [px("tone", "Tone Size", 2, 16, 4), px("lines", "Line Weight", 0.5, 6, 1.4, 0.1), pct("black", "Solid Blacks", 25), pct("white", "Highlights", 30)],
    pad: (p) => p.lines * 4 + 4,
    run(src, p) {
      const { w, h } = src;
      const g = gauss1(grayOf(src), w, h, 0.8);
      const tone = halftoneMask(g, w, h, p.tone, 45, "dot");
      const ink = inkLines(src, p.lines, 0.5, 0.5);
      const bt = p.black * 1.6, wt = 255 - p.white * 1.6;
      const out = cloneImg(src);
      for (let i = 0; i < w * h; i++) {
        let v: number;
        if (g[i] < bt) v = 0;
        else if (g[i] > wt) v = 255;
        else v = 255 * (1 - tone[i]);
        v *= 1 - ink[i];
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
      }
      return out;
    },
  },
  {
    id: "paintByNumbers",
    name: "Paint by Numbers",
    category: C,
    description: "Reduces the picture to a few flat colors with outlined regions, like a paint-by-numbers kit.",
    tags: ["regions", "outline", "quantize", "coloring book"],
    params: [range("colors", "Colors", 3, 32, 12), range("clean", "Cleanup", 0, 6, 2), check("fill", "Fill Colors", true), color("lineColor", "Outline", "#50505a")],
    pad: (p) => p.clean * 4 + 2,
    run(src, p) {
      const pal = medianCut(src, Math.round(p.colors));
      let q = mapRGB(src, (r, g, b) => nearest(pal, r, g, b));
      if (p.clean > 0) {
        q = median(q, p.clean);
        q = mapRGB(q, (r, g, b) => nearest(pal, r, g, b));
      }
      const { w, h } = q;
      const line = hexRGB(p.lineColor);
      const out = cloneImg(q);
      const d = q.data;
      const same = (a: number, b: number) => d[a] === d[b] && d[a + 1] === d[b + 1] && d[a + 2] === d[b + 2];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p0 = (y * w + x) * 4;
          const edge = (x + 1 < w && !same(p0, p0 + 4)) || (y + 1 < h && !same(p0, p0 + w * 4));
          for (let c = 0; c < 3; c++) out.data[p0 + c] = edge ? line[c] : p.fill ? d[p0 + c] : 255;
        }
      return out;
    },
  },
  {
    id: "vectorArt",
    name: "Vector Art",
    category: C,
    description: "Smooth flat shapes in a limited palette, like a traced vector illustration.",
    tags: ["flat", "illustration", "trace", "posterize"],
    params: [range("colors", "Colors", 3, 24, 8), range("smooth", "Shape Smoothing", 1, 10, 4)],
    pad: (p) => p.smooth * 5,
    run(src, p, env) {
      const s = smoothFor(src, p.smooth, env.scale);
      const pal = medianCut(s, Math.round(p.colors));
      let q = mapRGB(s, (r, g, b) => nearest(pal, r, g, b));
      q = median(q, Math.max(1, Math.round(p.smooth * 0.6 * env.scale)));
      return mapRGB(q, (r, g, b) => nearest(pal, r, g, b));
    },
  },
];
