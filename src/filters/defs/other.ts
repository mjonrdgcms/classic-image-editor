/** Texture and Other. */

import { applyRelief, textureField } from "../fx";
import { clamp, cloneImg, convolve, fbm, gaussianBlur, hash2, hexRGB, lerp, luma, mapRGB, minMax, rng, voronoi } from "../img";
import { check, color, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

const X = "Texture";
const O = "Other";

export const otherFilters: FilterDef[] = [
  {
    id: "texturizer",
    name: "Texturizer",
    category: X,
    description: "Prints the picture onto canvas, burlap, brick, sandstone or linen.",
    tags: ["canvas", "burlap", "brick", "relief"],
    params: [sel("texture", "Texture", [["canvas", "Canvas"], ["burlap", "Burlap"], ["brick", "Brick"], ["sandstone", "Sandstone"], ["linen", "Linen"], ["paper", "Paper"]], "canvas"), pct("scaling", "Scaling", 100, 50, 200), pct("relief", "Relief", 40), sel("light", "Light", [["135", "Top Left"], ["90", "Top"], ["45", "Top Right"], ["180", "Left"], ["0", "Right"], ["270", "Bottom"]], "135"), check("invert", "Invert", false), seed(101)],
    run: (src, p, env) => applyRelief(src, textureField(src.w, src.h, p.texture, (p.scaling / 100) * env.scale + 0.15, p.seed), p.relief / 100, +p.light, p.invert),
  },
  {
    id: "grainTexture",
    name: "Grain",
    category: X,
    description: "Adds texture grain: regular, soft, sprinkles, clumped, contrasty, stippled, horizontal or vertical.",
    tags: ["grain", "noise", "speckle"],
    params: [pct("intensity", "Intensity", 40), pct("contrast", "Contrast", 50), sel("type", "Grain Type", [["regular", "Regular"], ["soft", "Soft"], ["sprinkles", "Sprinkles"], ["clumped", "Clumped"], ["contrasty", "Contrasty"], ["stippled", "Stippled"], ["horizontal", "Horizontal"], ["vertical", "Vertical"]], "regular"), seed(102)],
    run(src, p) {
      const r = rng(p.seed);
      const k = p.intensity / 100, cK = p.contrast / 50;
      return mapRGB(src, (R, G, B, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        let n: number;
        switch (p.type) {
          case "soft":
            n = (fbm(x / 1.5, y / 1.5, 2, p.seed) - 0.5) * 120;
            break;
          case "sprinkles":
            n = r() < 0.06 * k ? (r() < 0.5 ? -200 : 200) : 0;
            break;
          case "clumped":
            n = (fbm(x / 3, y / 3, 3, p.seed) - 0.5) * 220;
            break;
          case "contrasty":
            n = (r() < 0.5 ? -1 : 1) * 90;
            break;
          case "stippled": {
            const l = luma(R, G, B);
            return r() * 255 > l ? [R * (1 - k), G * (1 - k), B * (1 - k)] : [lerp(R, 255, k * 0.6), lerp(G, 255, k * 0.6), lerp(B, 255, k * 0.6)];
          }
          case "horizontal":
            n = (hash2(0, y, p.seed) - 0.5) * 160;
            break;
          case "vertical":
            n = (hash2(x, 0, p.seed) - 0.5) * 160;
            break;
          default:
            n = (r() - 0.5) * 160;
        }
        n *= k;
        return [128 + (R + n - 128) * cK, 128 + (G + n - 128) * cK, 128 + (B + n - 128) * cK];
      });
    },
  },
  {
    id: "craquelure",
    name: "Craquelure",
    category: X,
    description: "Cracked old-varnish texture, like an aged oil painting.",
    tags: ["cracks", "aged", "old painting"],
    params: [px("spacing", "Crack Spacing", 4, 100, 18), pct("depth", "Crack Depth", 60), pct("brightness", "Crack Brightness", 40), seed(103)],
    run(src, p) {
      const cells = voronoi(src.w, src.h, p.spacing, p.seed, 1);
      const height = new Float32Array(src.w * src.h);
      for (let i = 0; i < height.length; i++) height[i] = clamp((cells.d2[i] - cells.d1[i]) / 3, 0, 1);
      const out = applyRelief(src, height, p.depth / 100);
      return mapRGB(out, (r, g, b, i) => {
        const crack = height[i] < 0.25 ? (1 - height[i] * 4) * (p.depth / 100) : 0;
        const k = 1 - crack * (1 - p.brightness / 100) * 0.8;
        return [r * k, g * k, b * k];
      });
    },
  },
  {
    id: "patchwork",
    name: "Patchwork",
    category: X,
    description: "Small squares of solid color, like a quilt, with raised edges.",
    tags: ["quilt", "squares"],
    params: [px("size", "Square Size", 2, 40, 6), pct("relief", "Relief", 40)],
    run(src, p) {
      const s = Math.max(2, Math.round(p.size));
      const out = cloneImg(src);
      const height = new Float32Array(src.w * src.h);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const cx = Math.min(src.w - 1, Math.floor(x / s) * s + (s >> 1)), cy = Math.min(src.h - 1, Math.floor(y / s) * s + (s >> 1));
          const q = (y * src.w + x) * 4, c = (cy * src.w + cx) * 4;
          for (let k = 0; k < 3; k++) out.data[q + k] = src.data[c + k];
          height[y * src.w + x] = x % s === 0 || y % s === 0 ? 0 : 1;
        }
      return applyRelief(out, height, p.relief / 100);
    },
  },
  {
    id: "frame",
    name: "Picture Frame",
    category: X,
    description: "Adds a mat or frame around the edge of the picture.",
    tags: ["border", "mat", "edge", "frame"],
    params: [sel("style", "Style", [["mat", "White Mat"], ["black", "Black Border"], ["wood", "Wood Frame"], ["polaroid", "Instant Photo"], ["film", "Film Strip"], ["rounded", "Rounded Corners"]], "mat"), pct("size", "Size", 6, 1, 25), color("color", "Custom Color", "#ffffff"), check("useColor", "Use Custom Color", false), seed(104)],
    run(src, p) {
      const { w, h } = src;
      const m = Math.round((Math.min(w, h) * p.size) / 100);
      const custom = hexRGB(p.color);
      return mapRGB(src, (r, g, b, i) => {
        const x = i % w, y = (i / w) | 0;
        const bottomExtra = p.style === "polaroid" ? m * 2.5 : 0;
        const inside = x >= m && y >= m && x < w - m && y < h - m - bottomExtra;
        if (p.style === "rounded") {
          const rad = m * 2;
          const cx = x < rad ? rad : x > w - rad ? w - rad : x, cy = y < rad ? rad : y > h - rad ? h - rad : y;
          const d = Math.hypot(x - cx, y - cy);
          const col = p.useColor ? custom : [255, 255, 255];
          const k = clamp(d - rad + 1, 0, 1);
          return [lerp(r, col[0], k), lerp(g, col[1], k), lerp(b, col[2], k)];
        }
        if (inside) {
          if (p.style === "mat") {
            const e = Math.min(x - m, y - m, w - m - 1 - x, h - m - 1 - y);
            if (e < 2) return [r * 0.7, g * 0.7, b * 0.7];
          }
          return [r, g, b];
        }
        if (p.useColor) return custom;
        switch (p.style) {
          case "black":
            return [12, 12, 12];
          case "wood": {
            const grain = fbm(x / 60, y / 4, 4, p.seed) * 0.5 + fbm(y / 60, x / 4, 4, p.seed) * 0.5;
            const horiz = Math.min(y, h - 1 - y) < Math.min(x, w - 1 - x);
            const gv = horiz ? fbm(x / 80, y / 3, 4, p.seed) : fbm(y / 80, x / 3, 4, p.seed);
            const k = 0.6 + gv * 0.6 + grain * 0.1;
            const bevel = Math.min(x, y, w - 1 - x, h - 1 - y) / Math.max(1, m);
            const sh = bevel < 0.15 ? 1.2 : bevel > 0.85 ? 0.7 : 1;
            return [120 * k * sh, 72 * k * sh, 38 * k * sh];
          }
          case "film": {
            const holes = (y < m || y >= h - m) && (Math.floor(x / (m * 0.9)) % 2 === 0) && Math.abs(((y < m ? y : h - 1 - y) / m) - 0.5) < 0.25;
            return holes ? [235, 230, 220] : [18, 16, 14];
          }
          case "polaroid":
            return [246, 244, 238];
          default:
            return [250, 250, 248];
        }
      });
    },
  },

  // ---------------------------------------------------------- Other
  {
    id: "highPass",
    name: "High Pass",
    category: O,
    description: "Keeps only fine detail on mid-gray; set the layer to Overlay to sharpen.",
    params: [px("radius", "Radius", 0.1, 250, 10, 0.1)],
    pad: (p) => p.radius * 3,
    run(src, p) {
      const bl = gaussianBlur(src, p.radius);
      return mapRGB(src, (r, g, b, i) => [128 + r - bl.data[i * 4], 128 + g - bl.data[i * 4 + 1], 128 + b - bl.data[i * 4 + 2]]);
    },
  },
  {
    id: "minimum",
    name: "Minimum",
    category: O,
    description: "Spreads dark areas and shrinks light ones.",
    tags: ["erode", "choke", "spread"],
    params: [px("radius", "Radius", 1, 100, 1)],
    pad: (p) => p.radius,
    run: (src, p) => minMax(src, Math.max(1, p.radius), false),
  },
  {
    id: "maximum",
    name: "Maximum",
    category: O,
    description: "Spreads light areas and shrinks dark ones.",
    tags: ["dilate", "spread"],
    params: [px("radius", "Radius", 1, 100, 1)],
    pad: (p) => p.radius,
    run: (src, p) => minMax(src, Math.max(1, p.radius), true),
  },
  {
    id: "offset",
    name: "Offset",
    category: O,
    description: "Shifts the picture by a distance, wrapping it around or filling the gap.",
    tags: ["wrap", "shift", "seamless", "tile"],
    params: [px("x", "Horizontal", -2000, 2000, 50), px("y", "Vertical", -2000, 2000, 50), sel("edge", "Undefined Areas", [["wrap", "Wrap Around"], ["repeat", "Repeat Edge Pixels"], ["clear", "Set to Transparent"]], "wrap")],
    ownAlpha: true,
    run(src, p) {
      const out = cloneImg(src);
      const dx = Math.round(p.x), dy = Math.round(p.y);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          let sx = x - dx, sy = y - dy;
          const q = (y * src.w + x) * 4;
          if (p.edge === "wrap") {
            sx = ((sx % src.w) + src.w) % src.w;
            sy = ((sy % src.h) + src.h) % src.h;
          } else if (p.edge === "repeat") {
            sx = Math.min(src.w - 1, Math.max(0, sx));
            sy = Math.min(src.h - 1, Math.max(0, sy));
          } else if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) {
            out.data[q + 3] = 0;
            continue;
          }
          const s = (sy * src.w + sx) * 4;
          for (let c = 0; c < 4; c++) out.data[q + c] = src.data[s + c];
        }
      return out;
    },
  },
  {
    id: "custom",
    name: "Custom",
    category: O,
    description: "Your own 3 x 3 convolution: each pixel becomes a weighted sum of its neighbors.",
    tags: ["kernel", "convolution", "matrix"],
    params: [
      range("k0", "Top Left", -999, 999, 0), range("k1", "Top", -999, 999, -1), range("k2", "Top Right", -999, 999, 0),
      range("k3", "Left", -999, 999, -1), range("k4", "Center", -999, 999, 5), range("k5", "Right", -999, 999, -1),
      range("k6", "Bottom Left", -999, 999, 0), range("k7", "Bottom", -999, 999, -1), range("k8", "Bottom Right", -999, 999, 0),
      range("scale", "Scale", 1, 9999, 1), range("offset", "Offset", -9999, 9999, 0),
    ],
    pad: () => 2,
    run: (src, p) => convolve(src, [p.k0, p.k1, p.k2, p.k3, p.k4, p.k5, p.k6, p.k7, p.k8], 3, p.scale || 1, p.offset),
  },
];
