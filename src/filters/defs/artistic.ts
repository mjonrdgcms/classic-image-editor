/** Artistic: painterly effects. */

import { gaussianBlur, lerp, mapRGB, median, medianCut, nearest } from "../img";
import { pct, px, range } from "../p";
import type { FilterDef } from "../types";

const C = "Artistic";

export const artisticFilters: FilterDef[] = [
  {
    id: "cutout",
    name: "Cutout",
    category: C,
    description: "Built from roughly cut pieces of colored paper.",
    tags: ["paper", "collage", "posterize"],
    params: [range("levels", "Number of Levels", 2, 10, 5), range("simplicity", "Edge Simplicity", 0, 10, 4), range("fidelity", "Edge Fidelity", 1, 3, 2)],
    pad: (p) => p.simplicity * 3 + 2,
    run(src, p) {
      let s = p.simplicity > 0 ? median(src, p.simplicity) : src;
      const pal = medianCut(s, Math.round(p.levels * (1 + (3 - p.fidelity) * 0)) + 1);
      s = mapRGB(s, (r, g, b) => nearest(pal, r, g, b));
      return p.simplicity > 1 ? mapRGB(median(s, Math.max(1, p.simplicity / 2)), (r, g, b) => nearest(pal, r, g, b)) : s;
    },
  },
  {
    id: "mosaicTiles",
    name: "Mosaic Tiles",
    category: C,
    description: "Small ceramic tiles with grout between them.",
    tags: ["tiles", "grout", "ceramic"],
    params: [px("size", "Tile Size", 3, 60, 12), px("grout", "Grout Width", 0, 8, 1.5, 0.5), pct("light", "Lighten Grout", 60)],
    run(src, p) {
      const { w } = src;
      const s = Math.max(2, p.size);
      const bl = gaussianBlur(src, s / 4);
      const gl = p.light / 100;
      return mapRGB(bl, (r, g, b, i) => {
        const x = i % w, y = (i / w) | 0;
        const off = Math.floor(y / s) % 2 ? s / 2 : 0;
        const fx = (x + off) % s, fy = y % s;
        const grout = fx < p.grout || fy < p.grout;
        if (grout) return [lerp(r * 0.4, 230, gl), lerp(g * 0.4, 225, gl), lerp(b * 0.4, 215, gl)];
        const bevel = (fx < p.grout + 1.5 || fy < p.grout + 1.5 ? 1.15 : 1) * (fx > s - 1.5 || fy > s - 1.5 ? 0.8 : 1);
        return [r * bevel, g * bevel, b * bevel];
      });
    },
  },
];

