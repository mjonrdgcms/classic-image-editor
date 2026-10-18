/** Distort and Pixelate. */

import { glow, halftoneMask, pixelate } from "../fx";
import { Img, cellColors, clamp, cloneImg, fbm, hash2, lerp, makeImg, mapRGB, remap, rng, sample, voronoi } from "../img";
import { angle, check, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

const D = "Distort";
const P = "Pixelate";
const edgeOpt = sel("edge", "Edges", [["clamp", "Repeat Edge Pixels"], ["wrap", "Wrap Around"], ["clear", "Transparent"]], "clamp");
const edgeMode = (e: string) => (e === "wrap" ? 1 : e === "clear" ? 2 : 0);

/** Map in coordinates normalized to the center (-1..1 on the shorter side). */
function radial(src: Img, fn: (r: number, a: number) => [number, number] | null, edge = 0): Img {
  const cx = src.w / 2, cy = src.h / 2, R = Math.min(src.w, src.h) / 2;
  return remap(src, (x, y, o) => {
    const dx = (x - cx) / R, dy = (y - cy) / R;
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    const m = fn(r, a);
    if (!m) return false;
    o[0] = cx + Math.cos(m[1]) * m[0] * R;
    o[1] = cy + Math.sin(m[1]) * m[0] * R;
  }, edge);
}

export const distortFilters: FilterDef[] = [
  {
    id: "twirl",
    name: "Twirl",
    category: D,
    description: "Spins the center more than the edges, like stirring paint.",
    tags: ["swirl", "spin", "whirl"],
    params: [angle("angle", "Angle", 50, -999, 999)],
    ownAlpha: true,
    run: (src, p) => radial(src, (r, a) => (r >= 1 ? null : [r, a + ((p.angle * Math.PI) / 180) * (1 - r) * (1 - r)])),
  },
  {
    id: "pinch",
    name: "Pinch",
    category: D,
    description: "Squeezes the middle inward, or pushes it out with a negative amount.",
    tags: ["squeeze", "bulge"],
    params: [pct("amount", "Amount", 50, -100, 100)],
    ownAlpha: true,
    run: (src, p) => radial(src, (r, a) => (r >= 1 ? null : [Math.pow(r, 1 - 0.5 * (p.amount / 100)), a])),
  },
  {
    id: "spherize",
    name: "Spherize",
    category: D,
    description: "Wraps the picture around a sphere.",
    tags: ["sphere", "bulge", "ball"],
    params: [pct("amount", "Amount", 100, -100, 100), sel("mode", "Mode", [["normal", "Normal"], ["h", "Horizontal Only"], ["v", "Vertical Only"]], "normal")],
    ownAlpha: true,
    run(src, p) {
      const k = p.amount / 100;
      const cx = src.w / 2, cy = src.h / 2;
      return remap(src, (x, y, o) => {
        let dx = (x - cx) / cx, dy = (y - cy) / cy;
        if (p.mode === "h") dy = 0;
        if (p.mode === "v") dx = 0;
        const r = Math.hypot(dx, dy);
        if (r >= 1) return false;
        const z = Math.sqrt(1 - r * r);
        const s = lerp(1, k >= 0 ? (Math.asin(r) / (Math.PI / 2)) / Math.max(r, 1e-6) : r / Math.max(Math.sin((r * Math.PI) / 2), 1e-6), Math.abs(k));
        void z;
        o[0] = cx + ((x - cx) * (p.mode === "v" ? 1 : s));
        o[1] = cy + ((y - cy) * (p.mode === "h" ? 1 : s));
      });
    },
  },
  {
    id: "fisheye",
    name: "Fisheye",
    category: D,
    description: "Ultra-wide fisheye lens: strong curvature that grows toward the edges.",
    tags: ["lens", "wide", "barrel"],
    params: [pct("amount", "Amount", 60, -100, 100), pct("zoom", "Zoom", 100, 50, 200)],
    ownAlpha: true,
    run(src, p) {
      const k = p.amount / 100, z = p.zoom / 100;
      return radial(src, (r, a) => {
        const rr = r / z;
        return [rr * (1 - k * 0.5 * (1 - Math.min(1, rr * rr))), a];
      }, 2);
    },
  },
  {
    id: "ripple",
    name: "Ripple",
    category: D,
    description: "Small, irregular ripples like the surface of a pond.",
    tags: ["water", "wavy"],
    params: [pct("amount", "Amount", 100, -999, 999), sel("size", "Size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], "medium")],
    ownAlpha: true,
    run(src, p, env) {
      const wl = ({ small: 8, medium: 18, large: 36 } as Record<string, number>)[p.size] * env.scale + 1;
      const amp = (p.amount / 100) * 4 * env.scale;
      return remap(src, (x, y, o) => {
        o[0] = x + Math.sin((y / wl) * Math.PI * 2 + fbm(x / 40, y / 40, 1) * 2) * amp;
        o[1] = y + Math.sin((x / wl) * Math.PI * 2) * amp * 0.5;
      });
    },
  },
  {
    id: "wave",
    name: "Wave",
    category: D,
    description: "Regular waves with a wavelength and height you choose.",
    tags: ["sine", "wavy"],
    params: [px("wavelength", "Wavelength", 2, 999, 60), px("amplitude", "Amplitude", 1, 999, 10), sel("type", "Type", [["sine", "Sine"], ["triangle", "Triangle"], ["square", "Square"]], "sine"), sel("dir", "Direction", [["both", "Both"], ["h", "Horizontal"], ["v", "Vertical"]], "both"), edgeOpt],
    ownAlpha: true,
    run(src, p) {
      const f = (t: number) => {
        const s = t - Math.floor(t);
        return p.type === "triangle" ? 1 - 4 * Math.abs(s - 0.5) : p.type === "square" ? (s < 0.5 ? 1 : -1) : Math.sin(t * Math.PI * 2);
      };
      return remap(src, (x, y, o) => {
        o[0] = x + (p.dir !== "v" ? f(y / p.wavelength) * p.amplitude : 0);
        o[1] = y + (p.dir !== "h" ? f(x / p.wavelength) * p.amplitude : 0);
      }, edgeMode(p.edge));
    },
  },
  {
    id: "zigzag",
    name: "ZigZag",
    category: D,
    description: "Radial ripples around the center, like a stone dropped in water.",
    tags: ["pond", "rings", "water"],
    params: [pct("amount", "Amount", 30, -100, 100), range("ridges", "Ridges", 1, 20, 6), sel("style", "Style", [["pond", "Pond Ripples"], ["out", "Out From Center"], ["around", "Around Center"]], "pond")],
    ownAlpha: true,
    run(src, p) {
      const k = p.amount / 100;
      return radial(src, (r, a) => {
        if (r >= 1) return null;
        const wave = Math.sin(r * p.ridges * Math.PI * 2) * k * 0.08 * (1 - r);
        if (p.style === "around") return [r, a + wave * 4];
        if (p.style === "out") return [r + wave, a];
        return [r + wave, a + wave * 2];
      });
    },
  },
  {
    id: "polar",
    name: "Polar Coordinates",
    category: D,
    description: "Bends the picture into a circle (tiny planet), or unrolls a circle into a strip.",
    tags: ["tiny planet", "little planet", "circle"],
    params: [sel("mode", "Mode", [["toPolar", "Rectangular to Polar"], ["toRect", "Polar to Rectangular"]], "toPolar")],
    ownAlpha: true,
    run(src, p) {
      const { w, h } = src;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
      return remap(src, (x, y, o) => {
        if (p.mode === "toPolar") {
          const dx = x - cx, dy = y - cy;
          const r = Math.hypot(dx, dy) / R;
          const a = Math.atan2(dx, -dy);
          o[0] = ((a / (Math.PI * 2) + 0.5) % 1) * w;
          o[1] = h - r * h;
        } else {
          const a = (x / w) * Math.PI * 2 - Math.PI;
          const r = (1 - y / h) * R;
          o[0] = cx + Math.sin(a) * r;
          o[1] = cy - Math.cos(a) * r;
        }
      }, 1);
    },
  },
  {
    id: "glass",
    name: "Glass",
    category: D,
    description: "As if seen through textured glass.",
    tags: ["frosted", "refraction"],
    params: [px("distortion", "Distortion", 0, 20, 5), range("smooth", "Smoothness", 1, 15, 3), sel("texture", "Texture", [["frosted", "Frosted"], ["blocks", "Blocks"], ["canvas", "Canvas"], ["tiny", "Tiny Lens"]], "frosted"), pct("scale", "Scaling", 100, 50, 200), seed(31)],
    ownAlpha: true,
    run(src, p, env) {
      const sc = (p.smooth * 3 * (p.scale / 100)) * env.scale + 1;
      return remap(src, (x, y, o) => {
        let nx: number, ny: number;
        if (p.texture === "blocks") {
          const bx = Math.floor(x / (sc * 3)), by = Math.floor(y / (sc * 3));
          nx = hash2(bx, by, p.seed) - 0.5;
          ny = hash2(bx, by, p.seed + 3) - 0.5;
        } else if (p.texture === "canvas") {
          nx = Math.sin(x / sc) * 0.5;
          ny = Math.sin(y / sc) * 0.5;
        } else if (p.texture === "tiny") {
          const lx = ((x / (sc * 2)) % 1) - 0.5, ly = ((y / (sc * 2)) % 1) - 0.5;
          nx = -lx;
          ny = -ly;
        } else {
          nx = fbm(x / sc, y / sc, 3, p.seed) - 0.5;
          ny = fbm(x / sc, y / sc, 3, p.seed + 17) - 0.5;
        }
        o[0] = x + nx * p.distortion * 2;
        o[1] = y + ny * p.distortion * 2;
      });
    },
  },
  {
    id: "oceanRipple",
    name: "Ocean Ripple",
    category: D,
    description: "Random, closely spaced ripples, as if under water.",
    tags: ["underwater", "ripple"],
    params: [px("size", "Ripple Size", 1, 15, 9), px("magnitude", "Ripple Magnitude", 0, 20, 9), seed(32)],
    ownAlpha: true,
    run: (src, p) =>
      remap(src, (x, y, o) => {
        const s = Math.max(1, p.size);
        o[0] = x + (fbm(x / s, y / s, 2, p.seed) - 0.5) * p.magnitude;
        o[1] = y + (fbm(x / s, y / s, 2, p.seed + 5) - 0.5) * p.magnitude;
      }),
  },
  {
    id: "liquify",
    name: "Liquid Warp",
    category: D,
    description: "Smooth, flowing random warping, like melted wax.",
    tags: ["melt", "warp", "flow", "trippy"],
    params: [px("strength", "Strength", 1, 200, 30), px("scale", "Scale", 10, 600, 120), range("detail", "Detail", 1, 6, 3), seed(33)],
    ownAlpha: true,
    run: (src, p) =>
      remap(src, (x, y, o) => {
        const s = Math.max(1, p.scale);
        const qx = fbm(x / s, y / s, p.detail, p.seed), qy = fbm(x / s + 5.2, y / s + 1.3, p.detail, p.seed);
        o[0] = x + (fbm(x / s + 4 * qx, y / s + 4 * qy, p.detail, p.seed + 1) - 0.5) * p.strength * 2;
        o[1] = y + (fbm(x / s + 4 * qx + 1.7, y / s + 4 * qy + 9.2, p.detail, p.seed + 2) - 0.5) * p.strength * 2;
      }),
  },
  {
    id: "kaleidoscope",
    name: "Kaleidoscope",
    category: D,
    description: "Mirrors a wedge of the picture around the center.",
    tags: ["mirror", "mandala", "symmetry"],
    params: [range("segments", "Segments", 2, 24, 8), angle("rotation", "Rotation", 0), pct("zoom", "Zoom", 100, 30, 300)],
    ownAlpha: true,
    run(src, p) {
      const seg = (Math.PI * 2) / Math.round(p.segments);
      const rot = (p.rotation * Math.PI) / 180;
      return radial(src, (r, a) => {
        let t = (((a - rot) % seg) + seg) % seg;
        if (t > seg / 2) t = seg - t;
        return [r / (p.zoom / 100), t + rot];
      }, 1);
    },
  },
  {
    id: "mirror",
    name: "Mirror",
    category: D,
    description: "Reflects one half (or quarter) of the picture onto the other.",
    tags: ["symmetry", "reflect", "flip"],
    params: [sel("mode", "Mirror", [["left", "Left onto Right"], ["right", "Right onto Left"], ["top", "Top onto Bottom"], ["bottom", "Bottom onto Top"], ["quad", "Four Ways"]], "left")],
    ownAlpha: true,
    run(src, p) {
      const { w, h } = src;
      return remap(src, (x, y, o) => {
        const mx = p.mode === "left" || p.mode === "quad" ? (x > w / 2 ? w - x : x) : p.mode === "right" ? (x < w / 2 ? w - x : x) : x;
        const my = p.mode === "top" || p.mode === "quad" ? (y > h / 2 ? h - y : y) : p.mode === "bottom" ? (y < h / 2 ? h - y : y) : y;
        o[0] = mx;
        o[1] = my;
      });
    },
  },
  {
    id: "diffuseGlow",
    name: "Diffuse Glow",
    category: D,
    description: "Soft diffused light with fine grain, as if seen through a soft diffusion filter.",
    tags: ["glow", "grain", "dreamy"],
    params: [range("graininess", "Graininess", 0, 10, 6), range("glow", "Glow Amount", 0, 20, 10), range("clear", "Clear Amount", 0, 20, 15), seed(34)],
    pad: () => 16,
    run(src, p, env) {
      const r = rng(p.seed);
      const g = glow(src, 8 * env.scale + 1, 255 - p.glow * 9, (20 - p.clear) / 12 + 0.2, [255, 255, 255]);
      return mapRGB(g, (rr, gg, b) => {
        const n = (r() - 0.5) * p.graininess * 6;
        return [rr + n, gg + n, b + n];
      });
    },
  },
  {
    id: "rgbSplit",
    name: "RGB Split",
    category: D,
    description: "Shifts the red, green and blue channels apart, like a misaligned print or a glitch.",
    tags: ["glitch", "chromatic aberration", "anaglyph"],
    params: [px("distance", "Distance", 0, 60, 6), angle("angle", "Angle", 0), sel("mode", "Mode", [["linear", "Linear"], ["radial", "From Center"]], "linear")],
    pad: (p) => p.distance,
    ownAlpha: true,
    run(src, p) {
      const out = cloneImg(src);
      const a = (p.angle * Math.PI) / 180;
      const s = new Float32Array(4);
      const cx = src.w / 2, cy = src.h / 2;
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const q = (y * src.w + x) * 4;
          for (const [c, k] of [[0, 1], [2, -1]] as const) {
            let dx: number, dy: number;
            if (p.mode === "radial") {
              const r = Math.hypot(x - cx, y - cy) / Math.max(cx, cy);
              dx = ((x - cx) / Math.max(1, Math.hypot(x - cx, y - cy))) * p.distance * r * k;
              dy = ((y - cy) / Math.max(1, Math.hypot(x - cx, y - cy))) * p.distance * r * k;
            } else {
              dx = Math.cos(a) * p.distance * k;
              dy = -Math.sin(a) * p.distance * k;
            }
            sample(src, x + 0.5 - dx, y + 0.5 - dy, s);
            out.data[q + c] = s[0 + c];
          }
        }
      return out;
    },
  },
  {
    id: "glitch",
    name: "Glitch",
    category: D,
    description: "Digital corruption: shifted slices, channel offsets and scan lines.",
    tags: ["datamosh", "vhs", "corrupt", "cyberpunk"],
    params: [pct("amount", "Amount", 50), px("slice", "Slice Height", 2, 120, 24), check("scan", "Scan Lines", true), seed(35)],
    ownAlpha: true,
    run(src, p) {
      const r = rng(p.seed);
      const out = cloneImg(src);
      const k = p.amount / 100;
      const s = new Float32Array(4);
      let y = 0;
      while (y < src.h) {
        const hh = Math.max(1, Math.round(p.slice * (0.3 + r())));
        const shift = r() < k * 0.6 ? (r() - 0.5) * src.w * 0.15 * k : 0;
        const ch = (r() - 0.5) * 16 * k;
        for (let yy = y; yy < Math.min(src.h, y + hh); yy++)
          for (let x = 0; x < src.w; x++) {
            const q = (yy * src.w + x) * 4;
            sample(src, x + 0.5 - shift, yy + 0.5, s);
            out.data[q] = s[0];
            out.data[q + 1] = s[1];
            out.data[q + 2] = s[2];
            out.data[q + 3] = s[3];
            if (ch) {
              sample(src, x + 0.5 - shift - ch, yy + 0.5, s);
              out.data[q] = s[0];
            }
            if (p.scan && yy % 3 === 0) for (let c = 0; c < 3; c++) out.data[q + c] *= 0.82;
          }
        y += hh;
      }
      return out;
    },
  },

  // ---------------------------------------------------------- Pixelate
  {
    id: "mosaic",
    name: "Mosaic",
    category: P,
    description: "Square blocks of solid color.",
    tags: ["pixelate", "blocks", "censor"],
    params: [px("size", "Cell Size", 2, 200, 12)],
    ownAlpha: true,
    run: (src, p) => pixelate(src, Math.max(1, p.size)),
  },
  {
    id: "crystallize",
    name: "Crystallize",
    category: P,
    description: "Irregular polygon cells of solid color.",
    tags: ["voronoi", "cells", "polygon"],
    params: [px("size", "Cell Size", 3, 300, 18), seed(41)],
    run(src, p) {
      const cells = voronoi(src.w, src.h, p.size, p.seed);
      const col = cellColors(src, cells);
      return mapRGB(src, (_r, _g, _b, i) => {
        const k = cells.id[i] * 4;
        return [col[k], col[k + 1], col[k + 2]];
      });
    },
  },
  {
    id: "stainedGlass",
    name: "Stained Glass",
    category: P,
    description: "Glass cells of color held in dark lead, with light glowing through.",
    tags: ["church", "window", "cells", "voronoi"],
    params: [px("size", "Cell Size", 4, 120, 22), px("border", "Border Thickness", 0, 12, 3, 0.5), pct("light", "Light Intensity", 30), color2("lead", "#1c1a18"), seed(42)],
    run(src, p) {
      const cells = voronoi(src.w, src.h, p.size, p.seed);
      const col = cellColors(src, cells);
      const lead = hex(p.lead);
      const cx = src.w / 2, cy = src.h / 2, R = Math.hypot(cx, cy);
      return mapRGB(src, (_r, _g, _b, i) => {
        const k = cells.id[i] * 4;
        const edge = cells.d2[i] - cells.d1[i];
        const x = i % src.w, y = (i / src.w) | 0;
        const lightK = 1 + (p.light / 100) * (1 - Math.hypot(x - cx, y - cy) / R) * 0.6;
        const bev = clamp(edge / (p.border * 2 + 2), 0, 1);
        const c = [col[k] * lightK * (0.85 + 0.15 * bev), col[k + 1] * lightK * (0.85 + 0.15 * bev), col[k + 2] * lightK * (0.85 + 0.15 * bev)];
        const t = clamp(p.border - edge + 0.5, 0, 1);
        return [lerp(c[0], lead[0], t), lerp(c[1], lead[1], t), lerp(c[2], lead[2], t)];
      });
    },
  },
  {
    id: "pointillize",
    name: "Pointillize",
    category: P,
    description: "Random dots of color on a background-colored canvas, like Seurat.",
    tags: ["dots", "seurat", "pointillism"],
    params: [px("size", "Cell Size", 3, 100, 8), check("useBg", "Use Background Color", true), seed(43)],
    run(src, p, env) {
      const cells = voronoi(src.w, src.h, p.size, p.seed);
      const col = cellColors(src, cells);
      const bg = p.useBg ? env.bg : [255, 255, 255];
      const rad = p.size * 0.48;
      return mapRGB(src, (_r, _g, _b, i) => {
        const k = cells.id[i] * 4;
        const t = clamp(rad - cells.d1[i] + 0.5, 0, 1);
        const j = (hash2(cells.id[i], 1, p.seed) - 0.5) * 40;
        return [lerp(bg[0], col[k] + j, t), lerp(bg[1], col[k + 1] + j, t), lerp(bg[2], col[k + 2] + j, t)];
      });
    },
  },
  {
    id: "colorHalftone",
    name: "Color Halftone",
    category: P,
    description: "CMYK halftone screens at their classic angles.",
    tags: ["cmyk", "print", "dots", "halftone"],
    params: [px("radius", "Max. Radius", 2, 60, 8), angle("c", "Cyan Angle", 108, 0, 180), angle("m", "Magenta Angle", 162, 0, 180), angle("y", "Yellow Angle", 90, 0, 180), angle("k", "Black Angle", 45, 0, 180)],
    run(src, p) {
      const { w, h } = src;
      const n = w * h;
      const C = new Float32Array(n), M = new Float32Array(n), Y = new Float32Array(n), K = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        const r = src.data[q] / 255, g = src.data[q + 1] / 255, b = src.data[q + 2] / 255;
        const k = 1 - Math.max(r, g, b);
        K[i] = 255 - k * 255;
        C[i] = 255 - (k < 1 ? (1 - r - k) / (1 - k) : 0) * 255;
        M[i] = 255 - (k < 1 ? (1 - g - k) / (1 - k) : 0) * 255;
        Y[i] = 255 - (k < 1 ? (1 - b - k) / (1 - k) : 0) * 255;
      }
      const cell = p.radius * 2;
      const mc = halftoneMask(C, w, h, cell, p.c, "dot"), mm = halftoneMask(M, w, h, cell, p.m, "dot"), my = halftoneMask(Y, w, h, cell, p.y, "dot"), mk = halftoneMask(K, w, h, cell, p.k, "dot");
      return mapRGB(src, (_r, _g, _b, i) => {
        const r = 255 * (1 - mc[i]) * (1 - mk[i]), g = 255 * (1 - mm[i]) * (1 - mk[i]), b = 255 * (1 - my[i]) * (1 - mk[i]);
        return [r, g, b];
      });
    },
  },
  {
    id: "fragment",
    name: "Fragment",
    category: P,
    description: "Four offset copies averaged together, like a shaky double exposure.",
    tags: ["offset", "shake"],
    params: [px("offset", "Offset", 1, 40, 4)],
    pad: (p) => p.offset,
    ownAlpha: true,
    run(src, p) {
      const out = makeImg(src.w, src.h);
      const s = new Float32Array(4);
      const o = p.offset;
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const acc = [0, 0, 0, 0];
          for (const [dx, dy] of [[o, o], [-o, o], [o, -o], [-o, -o]]) {
            sample(src, x + 0.5 + dx, y + 0.5 + dy, s);
            for (let c = 0; c < 4; c++) acc[c] += s[c];
          }
          const q = (y * src.w + x) * 4;
          for (let c = 0; c < 4; c++) out.data[q + c] = acc[c] / 4;
        }
      return out;
    },
  },
  {
    id: "mezzotint",
    name: "Mezzotint",
    category: P,
    description: "Random dots, lines or strokes in fully saturated colors.",
    tags: ["engraving", "dots", "print"],
    params: [sel("type", "Type", [["fine", "Fine Dots"], ["medium", "Medium Dots"], ["coarse", "Coarse Dots"], ["short", "Short Lines"], ["long", "Long Strokes"]], "medium"), seed(44)],
    run(src, p) {
      const sz = ({ fine: 1, medium: 2, coarse: 3, short: 1, long: 1 } as Record<string, number>)[p.type];
      return mapRGB(src, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const hx = p.type === "short" ? Math.floor(x / 4) : p.type === "long" ? Math.floor(x / 14) : Math.floor(x / sz);
        const hy = Math.floor(y / sz);
        return [r, g, b].map((v, c) => (v / 255 > hash2(hx, hy, p.seed + c) ? 255 : 0));
      });
    },
  },
  {
    id: "facet",
    name: "Facet",
    category: P,
    description: "Clumps similar colors into flat facets, like a hand painting.",
    params: [],
    pad: () => 3,
    run(src) {
      const cells = voronoi(src.w, src.h, 3, 1, 0.9);
      const col = cellColors(src, cells);
      return mapRGB(src, (_r, _g, _b, i) => {
        const k = cells.id[i] * 4;
        return [col[k], col[k + 1], col[k + 2]];
      });
    },
  },
  {
    id: "hexagons",
    name: "Hexagons",
    category: P,
    description: "A honeycomb of solid-color hexagons.",
    tags: ["honeycomb", "hex", "pixelate"],
    params: [px("size", "Hexagon Size", 3, 200, 16), px("gap", "Gap", 0, 10, 0, 0.5)],
    run(src, p) {
      const s = Math.max(2, p.size);
      const hw = Math.sqrt(3) * s, hh = 1.5 * s;
      const centerOf = (x: number, y: number): [number, number] => {
        const row = Math.round(y / hh);
        const best: [number, number] = [0, 0];
        let bd = Infinity;
        for (let r = row - 1; r <= row + 1; r++) {
          const off = r % 2 ? hw / 2 : 0;
          const col = Math.round((x - off) / hw);
          for (let c = col - 1; c <= col + 1; c++) {
            const cx = c * hw + off, cy = r * hh;
            const d = (x - cx) ** 2 + (y - cy) ** 2;
            if (d < bd) {
              bd = d;
              best[0] = cx;
              best[1] = cy;
            }
          }
        }
        return best;
      };
      const out = cloneImg(src);
      const sm = new Float32Array(4);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const [cx, cy] = centerOf(x, y);
          sample(src, cx, cy, sm);
          const q = (y * src.w + x) * 4;
          const d = Math.hypot(x - cx, y - cy);
          const inGap = p.gap > 0 && d > s * 0.86 - p.gap;
          out.data[q] = inGap ? 20 : sm[0];
          out.data[q + 1] = inGap ? 20 : sm[1];
          out.data[q + 2] = inGap ? 22 : sm[2];
        }
      return out;
    },
  },
  {
    id: "lowPoly",
    name: "Low Poly",
    category: P,
    description: "Flat-shaded triangles, like a low-polygon 3D render.",
    tags: ["triangles", "geometric", "polygon"],
    params: [px("size", "Triangle Size", 6, 200, 28), pct("jitter", "Irregularity", 60), pct("shading", "Facet Shading", 25), seed(45)],
    run(src, p) {
      const s = Math.max(4, p.size);
      const gx = Math.ceil(src.w / s) + 2, gy = Math.ceil(src.h / s) + 2;
      const vx = new Float32Array(gx * gy), vy = new Float32Array(gx * gy);
      for (let j = 0; j < gy; j++)
        for (let i = 0; i < gx; i++) {
          const k = j * gx + i;
          const jit = p.jitter / 100;
          vx[k] = (i - 0.5) * s + (i > 0 && i < gx - 1 ? (hash2(i, j, p.seed) - 0.5) * s * jit : 0);
          vy[k] = (j - 0.5) * s + (j > 0 && j < gy - 1 ? (hash2(i, j, p.seed + 1) - 0.5) * s * jit : 0);
        }
      const out = cloneImg(src);
      const sm = new Float32Array(4);
      const tri = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, shade: number) => {
        sample(src, (ax + bx + cx) / 3, (ay + by + cy) / 3, sm);
        const col = [sm[0] * shade, sm[1] * shade, sm[2] * shade];
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(src.w - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(src.h - 1, Math.ceil(Math.max(ay, by, cy)));
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (!area) return;
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
            const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
            const q = (y * src.w + x) * 4;
            out.data[q] = col[0];
            out.data[q + 1] = col[1];
            out.data[q + 2] = col[2];
          }
      };
      for (let j = 0; j < gy - 1; j++)
        for (let i = 0; i < gx - 1; i++) {
          const a = j * gx + i, b = a + 1, c = a + gx, d = c + 1;
          const sh = p.shading / 100;
          tri(vx[a], vy[a], vx[b], vy[b], vx[d], vy[d], 1 + sh * 0.12);
          tri(vx[a], vy[a], vx[d], vy[d], vx[c], vy[c], 1 - sh * 0.12);
        }
      return out;
    },
  },
  {
    id: "bricks",
    name: "Toy Bricks",
    category: P,
    description: "Rebuilds the picture from plastic toy bricks with round studs.",
    tags: ["lego", "bricks", "studs", "toy"],
    params: [px("size", "Brick Size", 6, 80, 16), range("colors", "Palette Colors", 0, 32, 0)],
    run(src, p) {
      const s = Math.max(4, Math.round(p.size));
      const base = pixelate(src, s);
      return mapRGB(base, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const fx = (x % s) + 0.5, fy = (y % s) + 0.5;
        const d = Math.hypot(fx - s / 2, fy - s / 2);
        const stud = d < s * 0.3;
        const rim = Math.abs(d - s * 0.3) < 1;
        let k = 1;
        if (fx < 1 || fy < 1) k = 1.15;
        if (fx > s - 1 || fy > s - 1) k = 0.72;
        if (stud) k *= 1 + (s / 2 - fy) / (s * 1.4);
        if (rim) k *= fy > s / 2 ? 0.75 : 1.2;
        return [r * k, g * k, b * k];
      });
    },
  },
  {
    id: "ledScreen",
    name: "LED Screen",
    category: P,
    description: "Glowing round LEDs on a dark panel, like a stadium screen.",
    tags: ["led", "display", "dots", "matrix"],
    params: [px("size", "LED Size", 3, 40, 8), pct("glow", "Glow", 40)],
    run(src, p) {
      const s = Math.max(2, Math.round(p.size));
      const base = pixelate(src, s);
      return mapRGB(base, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const d = Math.hypot((x % s) + 0.5 - s / 2, (y % s) + 0.5 - s / 2) / (s / 2);
        const k = d < 0.7 ? 1.15 : clamp(1 - (d - 0.7) / 0.3, 0, 1) * (p.glow / 100) * 0.8;
        return [r * k, g * k, b * k];
      });
    },
  },
  {
    id: "crossStitch",
    name: "Cross Stitch",
    category: P,
    description: "Embroidered X stitches on fabric.",
    tags: ["embroidery", "needlework", "craft"],
    params: [px("size", "Stitch Size", 3, 40, 8), color2("fabric", "#efe9dc")],
    run(src, p) {
      const s = Math.max(3, Math.round(p.size));
      const base = pixelate(src, s);
      const fab = hex(p.fabric);
      return mapRGB(base, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const fx = (x % s) + 0.5, fy = (y % s) + 0.5;
        const d1 = Math.abs(fx - fy) / Math.SQRT2, d2 = Math.abs(fx + fy - s) / Math.SQRT2;
        const t = s * 0.16;
        const on = d1 < t || d2 < t;
        if (!on) return [fab[0] - ((x + y) % 2) * 8, fab[1] - ((x + y) % 2) * 8, fab[2] - ((x + y) % 2) * 8];
        const shade = 1 - Math.min(d1, d2) / t * 0.3;
        return [r * shade, g * shade, b * shade];
      });
    },
  },
];

function color2(key: string, def: string) {
  return { key, label: key === "lead" ? "Lead Color" : "Fabric", type: "color" as const, default: def };
}
function hex(h: string): [number, number, number] {
  const n = parseInt(String(h).replace("#", ""), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

