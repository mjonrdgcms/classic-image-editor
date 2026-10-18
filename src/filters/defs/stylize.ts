/** Stylize and Render. */

import { glow } from "../fx";
import { Img, B, atScale, clamp, cloneImg, fbm, gauss1, grayOf, hash2, hexRGB, hsvToRgb, lerp, luma, makeImg, mapRGB, pathBlur, rng, sobel } from "../img";
import { angle, check, color, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

const S = "Stylize";
const R = "Render";

function emboss(src: Img, ang: number, height: number, amount: number, keepColor: boolean): Img {
  const g = grayOf(src);
  const a = (ang * Math.PI) / 180;
  const dx = Math.cos(a) * height, dy = -Math.sin(a) * height;
  const out = cloneImg(src);
  const { w, h } = src;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x1 = Math.min(w - 1, Math.max(0, Math.round(x - dx))), y1 = Math.min(h - 1, Math.max(0, Math.round(y - dy)));
      const x2 = Math.min(w - 1, Math.max(0, Math.round(x + dx))), y2 = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
      const v = (g[y2 * w + x2] - g[y1 * w + x1]) * (amount / 100);
      const q = (y * w + x) * 4;
      if (keepColor) for (let c = 0; c < 3; c++) out.data[q + c] = src.data[q + c] + v;
      else out.data[q] = out.data[q + 1] = out.data[q + 2] = 128 + v;
    }
  return out;
}

export const stylizeFilters: FilterDef[] = [
  {
    id: "findEdges",
    name: "Find Edges",
    category: S,
    description: "Outlines edges in dark lines on white, in their own colors.",
    tags: ["edges", "outline", "contour"],
    params: [],
    pad: () => 2,
    run(src) {
      const out = cloneImg(src);
      const { w, h } = src;
      for (let c = 0; c < 3; c++) {
        const ch = new Float32Array(w * h);
        for (let i = 0; i < ch.length; i++) ch[i] = src.data[i * 4 + c];
        const { mag } = sobel(ch, w, h);
        for (let i = 0; i < ch.length; i++) out.data[i * 4 + c] = 255 - mag[i] * 0.5;
      }
      return out;
    },
  },
  {
    id: "glowingEdges",
    name: "Glowing Edges",
    category: S,
    description: "Neon-like glowing edges on black.",
    tags: ["neon", "edges", "glow", "tron"],
    params: [px("width", "Edge Width", 1, 14, 2), range("brightness", "Edge Brightness", 0, 20, 6), range("smooth", "Smoothness", 1, 15, 5)],
    pad: (p) => p.width * 3 + 4,
    run(src, p, env) {
      const out = cloneImg(src);
      const { w, h } = src;
      for (let c = 0; c < 3; c++) {
        let ch: Float32Array = new Float32Array(w * h);
        for (let i = 0; i < ch.length; i++) ch[i] = src.data[i * 4 + c];
        ch = gauss1(ch, w, h, p.smooth * 0.25 * env.scale + 0.3);
        let { mag } = sobel(ch, w, h);
        if (p.width > 1) mag = gauss1(mag, w, h, p.width * 0.5);
        for (let i = 0; i < ch.length; i++) out.data[i * 4 + c] = mag[i] * (0.2 + p.brightness * 0.12);
      }
      return out;
    },
  },
  {
    id: "neonEdges",
    name: "Neon Lines",
    category: S,
    description: "Bright neon tubes along the edges, glowing in a color you choose, on a dark background.",
    tags: ["neon", "synthwave", "glow", "cyberpunk"],
    params: [color("tube", "Tube Color", "#ff2bd6"), color("tube2", "Second Color", "#21e6ff"), px("glow", "Glow", 1, 40, 8), pct("bg", "Show Picture", 15)],
    pad: (p) => p.glow * 3,
    run(src, p, env) {
      const g = gauss1(grayOf(src), src.w, src.h, 1.2 * env.scale + 0.3);
      const { mag } = sobel(g, src.w, src.h);
      const a = hexRGB(p.tube), b = hexRGB(p.tube2);
      const lines = mapRGB(src, (_r, _g, _b, i) => {
        const k = clamp((mag[i] - 30) / 80, 0, 1);
        const t = (i % src.w) / src.w;
        return [lerp(a[0], b[0], t) * k, lerp(a[1], b[1], t) * k, lerp(a[2], b[2], t) * k];
      });
      const gl = glow(lines, p.glow, 10, 1.4);
      const bgK = p.bg / 100;
      return mapRGB(gl, (r, gg, bb, i) => {
        const q = i * 4;
        return [r + src.data[q] * bgK * 0.5, gg + src.data[q + 1] * bgK * 0.5, bb + src.data[q + 2] * bgK * 0.5];
      });
    },
  },
  {
    id: "emboss",
    name: "Emboss",
    category: S,
    description: "Raised or stamped look in gray, lit from an angle.",
    tags: ["relief", "raised", "stamped"],
    params: [angle("angle", "Angle", 135), px("height", "Height", 1, 10, 3), pct("amount", "Amount", 100, 1, 500)],
    pad: (p) => p.height + 1,
    run: (src, p) => emboss(src, p.angle, Math.max(0.5, p.height), p.amount, false),
  },
  {
    id: "embossColor",
    name: "Color Emboss",
    category: S,
    description: "Embossed relief that keeps the original colors.",
    tags: ["relief", "raised"],
    params: [angle("angle", "Angle", 135), px("height", "Height", 1, 10, 2), pct("amount", "Amount", 100, 1, 500)],
    pad: (p) => p.height + 1,
    run: (src, p) => emboss(src, p.angle, Math.max(0.5, p.height), p.amount, true),
  },
  {
    id: "solarize",
    name: "Solarize",
    category: S,
    description: "Mixes a negative and a positive, like exposing a print to light while developing it.",
    tags: ["sabattier", "darkroom"],
    params: [range("threshold", "Threshold", 0, 255, 128)],
    run: (src, p) => mapRGB(src, (r, g, b) => [r > p.threshold ? 255 - r : r, g > p.threshold ? 255 - g : g, b > p.threshold ? 255 - b : b]),
  },
  {
    id: "traceContour",
    name: "Trace Contour",
    category: S,
    description: "Thin lines where brightness crosses a level, like a contour map.",
    tags: ["contour", "topographic", "lines"],
    params: [range("level", "Level", 0, 255, 128), sel("edge", "Edge", [["lower", "Lower"], ["upper", "Upper"]], "upper"), range("bands", "Extra Levels", 0, 12, 0)],
    pad: () => 2,
    run(src, p) {
      const { w, h } = src;
      const out = cloneImg(src);
      const levels = [p.level];
      for (let k = 1; k <= p.bands; k++) levels.push((p.level + (k * 256) / (p.bands + 1)) % 256);
      for (let c = 0; c < 3; c++)
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const q = (y * w + x) * 4 + c;
            const v = src.data[q];
            const n = x + 1 < w ? src.data[q + 4] : v, s = y + 1 < h ? src.data[q + w * 4] : v;
            let line = false;
            for (const L of levels) {
              const above = p.edge === "upper" ? v >= L : v <= L;
              const nn = p.edge === "upper" ? n >= L : n <= L, ss = p.edge === "upper" ? s >= L : s <= L;
              if (above !== nn || above !== ss) line = true;
            }
            out.data[q] = line ? 0 : 255;
          }
      return out;
    },
  },
  {
    id: "wind",
    name: "Wind",
    category: S,
    description: "Fine horizontal streaks blowing from the bright edges.",
    tags: ["streaks", "blast", "speed"],
    params: [sel("method", "Method", [["wind", "Wind"], ["blast", "Blast"], ["stagger", "Stagger"]], "wind"), sel("dir", "Direction", [["right", "From the Right"], ["left", "From the Left"]], "right"), seed(51)],
    pad: () => 40,
    run(src, p, env) {
      const len = ({ wind: 18, blast: 40, stagger: 26 } as Record<string, number>)[p.method] * env.scale + 2;
      const dir = p.dir === "right" ? 1 : -1;
      const out = cloneImg(src);
      const { w, h } = src;
      const g = grayOf(src);
      for (let y = 0; y < h; y++) {
        let carry = -1, left = 0;
        for (let k = 0; k < w; k++) {
          const x = dir > 0 ? w - 1 - k : k;
          const i = y * w + x;
          const xp = x + dir;
          const edge = xp >= 0 && xp < w && g[i] - g[y * w + xp] > 14;
          if (edge && hash2(x, y, p.seed) < (p.method === "stagger" ? 0.45 : 0.8)) {
            carry = i;
            left = Math.round(len * (0.4 + hash2(y, x, p.seed + 1)));
          }
          if (carry >= 0 && left > 0) {
            const t = left / len;
            for (let c = 0; c < 3; c++) out.data[i * 4 + c] = Math.max(out.data[i * 4 + c], lerp(out.data[i * 4 + c], src.data[carry * 4 + c], t));
            left--;
          }
        }
      }
      return out;
    },
  },
  {
    id: "diffuse",
    name: "Diffuse",
    category: S,
    description: "Shuffles pixels randomly so the picture looks less focused, or only the darks or lights.",
    tags: ["scatter", "jitter"],
    params: [sel("mode", "Mode", [["normal", "Normal"], ["darken", "Darken Only"], ["lighten", "Lighten Only"], ["aniso", "Anisotropic"]], "normal"), px("radius", "Radius", 1, 10, 2), seed(52)],
    pad: (p) => p.radius,
    run(src, p) {
      const r = rng(p.seed);
      const out = cloneImg(src);
      const { w, h } = src;
      const rad = Math.max(1, Math.round(p.radius));
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const xx = Math.min(w - 1, Math.max(0, x + Math.round((r() * 2 - 1) * rad))), yy = Math.min(h - 1, Math.max(0, y + Math.round((r() * 2 - 1) * rad)));
          const q = (y * w + x) * 4, s = (yy * w + xx) * 4;
          const ls = luma(src.data[s], src.data[s + 1], src.data[s + 2]), lq = luma(src.data[q], src.data[q + 1], src.data[q + 2]);
          if (p.mode === "darken" && ls > lq) continue;
          if (p.mode === "lighten" && ls < lq) continue;
          if (p.mode === "aniso" && Math.abs(ls - lq) > 40) continue;
          for (let c = 0; c < 4; c++) out.data[q + c] = src.data[s + c];
        }
      return out;
    },
    ownAlpha: true,
  },
  {
    id: "tiles",
    name: "Tiles",
    category: S,
    description: "Breaks the picture into tiles, each slightly offset.",
    tags: ["tiles", "broken", "offset"],
    params: [range("count", "Number of Tiles", 1, 99, 10), pct("offset", "Maximum Offset", 10, 1, 99), sel("fill", "Fill Empty Area With", [["bg", "Background Color"], ["fg", "Foreground Color"], ["inverse", "Inverse Image"], ["original", "Unaltered Image"]], "bg"), seed(53)],
    ownAlpha: true,
    run(src, p, env) {
      const ts = Math.max(2, Math.min(src.w, src.h) / p.count);
      const out = cloneImg(src);
      const fill = p.fill === "bg" ? env.bg : p.fill === "fg" ? env.fg : null;
      for (let q = 0; q < out.data.length; q += 4) {
        if (fill) {
          out.data[q] = fill[0];
          out.data[q + 1] = fill[1];
          out.data[q + 2] = fill[2];
          out.data[q + 3] = 255;
        } else if (p.fill === "inverse") for (let c = 0; c < 3; c++) out.data[q + c] = 255 - src.data[q + c];
      }
      const maxOff = ts * (p.offset / 100);
      for (let ty = 0; ty * ts < src.h; ty++)
        for (let tx = 0; tx * ts < src.w; tx++) {
          const ox = Math.round((hash2(tx, ty, p.seed) - 0.5) * 2 * maxOff), oy = Math.round((hash2(tx, ty, p.seed + 1) - 0.5) * 2 * maxOff);
          const x0 = Math.floor(tx * ts), y0 = Math.floor(ty * ts), x1 = Math.min(src.w, Math.floor((tx + 1) * ts)), y1 = Math.min(src.h, Math.floor((ty + 1) * ts));
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const dx = x + ox, dy = y + oy;
              if (dx < 0 || dy < 0 || dx >= src.w || dy >= src.h) continue;
              const s = (y * src.w + x) * 4, d = (dy * src.w + dx) * 4;
              for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c];
            }
        }
      return out;
    },
  },
  {
    id: "extrude",
    name: "Extrude",
    category: S,
    description: "Turns the picture into 3D blocks or pyramids.",
    tags: ["3d", "blocks", "pyramids"],
    params: [sel("type", "Type", [["blocks", "Blocks"], ["pyramids", "Pyramids"]], "blocks"), px("size", "Size", 2, 255, 24), range("depth", "Depth", 1, 255, 40)],
    run(src, p) {
      const s = Math.max(2, Math.round(p.size));
      const out = cloneImg(src);
      for (let by = 0; by < src.h; by += s)
        for (let bx = 0; bx < src.w; bx += s) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = by; y < Math.min(src.h, by + s); y++)
            for (let x = bx; x < Math.min(src.w, bx + s); x++) {
              const q = (y * src.w + x) * 4;
              r += src.data[q];
              g += src.data[q + 1];
              b += src.data[q + 2];
              n++;
            }
          r /= n;
          g /= n;
          b /= n;
          const k = (p.depth / 255) * 0.6;
          for (let y = by; y < Math.min(src.h, by + s); y++)
            for (let x = bx; x < Math.min(src.w, bx + s); x++) {
              const fx = (x - bx) / s, fy = (y - by) / s;
              let shade = 1;
              if (p.type === "pyramids") {
                const face = fy < fx ? (fy < 1 - fx ? 0 : 1) : fy < 1 - fx ? 3 : 2;
                shade = [1 + k * 0.6, 1 - k * 0.3, 1 - k * 0.7, 1 + k * 0.2][face];
              } else {
                const bev = 0.18;
                if (fx < bev || fy < bev) shade = 1 + k * 0.6;
                else if (fx > 1 - bev || fy > 1 - bev) shade = 1 - k * 0.7;
              }
              const q = (y * src.w + x) * 4;
              out.data[q] = r * shade;
              out.data[q + 1] = g * shade;
              out.data[q + 2] = b * shade;
            }
        }
      return out;
    },
  },
  {
    id: "outline",
    name: "Outline Glow",
    category: S,
    description: "A soft colored halo around the shapes of a layer with transparency (or around bright areas).",
    tags: ["halo", "sticker", "stroke"],
    params: [px("size", "Size", 1, 60, 8), color("color", "Color", "#ffffff"), pct("opacity", "Opacity", 90)],
    pad: (p) => p.size * 3,
    ownAlpha: true,
    run(src, p) {
      const { w, h } = src;
      const a = new Float32Array(w * h);
      let hasAlpha = false;
      for (let i = 0; i < a.length; i++) {
        a[i] = src.data[i * 4 + 3];
        if (a[i] < 250) hasAlpha = true;
      }
      if (!hasAlpha) for (let i = 0; i < a.length; i++) a[i] = luma(src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]) > 200 ? 255 : 0;
      const bl = gauss1(a, w, h, p.size / 2);
      const c = hexRGB(p.color);
      const out = cloneImg(src);
      for (let i = 0; i < a.length; i++) {
        const halo = clamp(bl[i] * 2.2, 0, 255) * (p.opacity / 100);
        const q = i * 4;
        const sa = src.data[q + 3] / 255, ha = halo / 255;
        const oa = sa + ha * (1 - sa);
        for (let k = 0; k < 3; k++) out.data[q + k] = oa > 0 ? (src.data[q + k] * sa + c[k] * ha * (1 - sa)) / oa : 0;
        out.data[q + 3] = oa * 255;
      }
      return out;
    },
  },

  // ---------------------------------------------------------- Render
  {
    id: "clouds",
    name: "Clouds",
    category: R,
    description: "Soft cloud pattern between the foreground and background colors.",
    tags: ["noise", "sky", "smoke"],
    params: [px("scale", "Scale", 10, 1000, 160), range("detail", "Detail", 1, 8, 6), check("useFgBg", "Use Foreground/Background Colors", true), seed(61)],
    ownAlpha: true,
    run(src, p, env) {
      const fg = p.useFgBg ? env.fg : [40, 80, 160], bg = p.useFgBg ? env.bg : [240, 245, 255];
      const out = makeImg(src.w, src.h);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const v = fbm(x / p.scale, y / p.scale, p.detail, p.seed);
          const q = (y * src.w + x) * 4;
          for (let c = 0; c < 3; c++) out.data[q + c] = lerp(fg[c], bg[c], clamp((v - 0.2) / 0.6, 0, 1));
          out.data[q + 3] = 255;
        }
      return out;
    },
  },
  {
    id: "differenceClouds",
    name: "Difference Clouds",
    category: R,
    description: "Clouds combined with the picture in Difference mode; repeat it for marbled veins.",
    tags: ["marble", "veins"],
    params: [px("scale", "Scale", 10, 1000, 160), range("detail", "Detail", 1, 8, 6), seed(62)],
    run(src, p, env) {
      return mapRGB(src, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const v = clamp((fbm(x / p.scale, y / p.scale, p.detail, p.seed) - 0.2) / 0.6, 0, 1);
        return [r, g, b].map((s, c) => Math.abs(s - lerp(env.fg[c], env.bg[c], v)));
      });
    },
  },
  {
    id: "fibers",
    name: "Fibers",
    category: R,
    description: "Woven fiber texture in the foreground and background colors.",
    tags: ["wood", "grain", "fabric"],
    params: [range("variance", "Variance", 1, 64, 16), range("strength", "Strength", 1, 64, 4), seed(63)],
    ownAlpha: true,
    run(src, p, env) {
      const out = makeImg(src.w, src.h);
      const sx = 30 / p.variance, sy = 300 / p.strength;
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const v = fbm(x / sx, y / sy, 4, p.seed);
          const q = (y * src.w + x) * 4;
          for (let c = 0; c < 3; c++) out.data[q + c] = lerp(env.fg[c], env.bg[c], v);
          out.data[q + 3] = 255;
        }
      return out;
    },
  },
  {
    id: "plasma",
    name: "Plasma",
    category: R,
    description: "Swirling psychedelic color plasma.",
    tags: ["psychedelic", "rainbow", "trippy"],
    params: [px("scale", "Scale", 20, 1000, 200), range("turbulence", "Turbulence", 1, 8, 3), pct("blend", "Blend with Picture", 0), seed(64)],
    ownAlpha: true,
    run(src, p) {
      const out = cloneImg(src);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const v = fbm(x / p.scale, y / p.scale, p.turbulence, p.seed) * 3 + Math.sin(x / p.scale * 3) * 0.3 + Math.cos(y / p.scale * 2.4) * 0.3;
          const c = hsvToRgb(v * 360, 0.75, 1);
          const q = (y * src.w + x) * 4;
          const k = p.blend / 100;
          for (let ch = 0; ch < 3; ch++) out.data[q + ch] = lerp(c[ch], B.overlay(src.data[q + ch], c[ch]), k);
          out.data[q + 3] = 255;
        }
      return out;
    },
  },
  {
    id: "lensFlare",
    name: "Lens Flare",
    category: R,
    description: "A bright light source with ghosting rings across the frame.",
    tags: ["sun", "flare", "light"],
    params: [pct("x", "Center X", 25), pct("y", "Center Y", 25), pct("brightness", "Brightness", 100, 10, 300), sel("lens", "Lens Type", [["zoom", "50-300mm Zoom"], ["prime35", "35mm Prime"], ["prime105", "105mm Prime"]], "zoom")],
    run(src, p) {
      const { w, h } = src;
      const lx = (p.x / 100) * w, ly = (p.y / 100) * h;
      const cx = w / 2, cy = h / 2;
      const R0 = Math.min(w, h);
      const k = p.brightness / 100;
      const ghosts: [number, number, [number, number, number], number][] = (p.lens === "prime35"
        ? [[0.4, 0.05, [120, 200, 255], 0.25], [1.3, 0.09, [255, 160, 80], 0.2], [1.7, 0.03, [180, 255, 160], 0.3]]
        : p.lens === "prime105"
          ? [[0.6, 0.03, [255, 210, 160], 0.3], [1.5, 0.05, [140, 180, 255], 0.25]]
          : [[0.3, 0.04, [255, 150, 90], 0.3], [0.7, 0.07, [120, 255, 160], 0.18], [1.2, 0.12, [100, 140, 255], 0.14], [1.6, 0.03, [255, 230, 160], 0.35], [2, 0.06, [255, 120, 200], 0.15]]) as never;
      return mapRGB(src, (r, g, b, i) => {
        const x = i % w, y = (i / w) | 0;
        const d = Math.hypot(x - lx, y - ly) / R0;
        let add = Math.exp(-d * 18) * 255 * 1.6 + Math.exp(-d * 4) * 90;
        const ang = Math.atan2(y - ly, x - lx);
        add += Math.pow(Math.abs(Math.cos(ang * 6)), 40) * Math.exp(-d * 5) * 120;
        const out = [r + add * k, g + add * 0.95 * k, b + add * 0.85 * k];
        for (const [t, rad, col, a] of ghosts) {
          const gx = lx + (cx - lx) * t, gy = ly + (cy - ly) * t;
          const gd = Math.hypot(x - gx, y - gy) / R0;
          const ring = clamp(1 - Math.abs(gd - rad) / (rad * 0.35 + 0.004), 0, 1) * 0.6 + (gd < rad ? 0.4 : 0);
          for (let c = 0; c < 3; c++) out[c] += col[c] * ring * a * k;
        }
        return out;
      });
    },
  },
  {
    id: "lightRays",
    name: "Light Rays",
    category: R,
    description: "Sunbeams streaming out from the bright areas.",
    tags: ["god rays", "sunbeams", "volumetric"],
    params: [pct("x", "Source X", 50), pct("y", "Source Y", 20), pct("length", "Ray Length", 50, 5, 100), pct("strength", "Strength", 80), range("threshold", "Brightness Threshold", 100, 250, 165)],
    run(src, p) {
      const lx = (p.x / 100) * src.w, ly = (p.y / 100) * src.h;
      const bright = mapRGB(src, (r, g, b) => {
        const l = luma(r, g, b);
        const k = clamp((l - p.threshold) / (255 - p.threshold + 1), 0, 1);
        return [r * k, g * k, b * k];
      });
      const rays = atScale(bright, 0.5, (s, k) =>
        pathBlur(s, (x, y, t, o) => {
          const f = (t + 0.5) * (p.length / 100);
          o[0] = x + (lx * k - x) * f;
          o[1] = y + (ly * k - y) * f;
        }, 28),
      );
      const k = (p.strength / 100) * 2.5;
      return mapRGB(src, (r, g, b, i) => {
        const q = i * 4;
        return [B.screen(r, clamp(rays.data[q] * k)), B.screen(g, clamp(rays.data[q + 1] * k)), B.screen(b, clamp(rays.data[q + 2] * k))];
      });
    },
  },
  {
    id: "speedLines",
    name: "Speed Lines",
    category: R,
    description: "Manga-style radial speed lines around a focus point.",
    tags: ["manga", "action", "comic", "focus"],
    params: [pct("x", "Focus X", 50), pct("y", "Focus Y", 50), range("count", "Lines", 20, 400, 120), pct("clear", "Clear Center", 40), color("color", "Line Color", "#111111"), seed(65)],
    run(src, p) {
      const lx = (p.x / 100) * src.w, ly = (p.y / 100) * src.h;
      const R0 = Math.hypot(src.w, src.h) / 2;
      const col = hexRGB(p.color);
      const n = Math.round(p.count);
      return mapRGB(src, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const a = (Math.atan2(y - ly, x - lx) / (Math.PI * 2) + 0.5) * n;
        const k = Math.floor(a);
        const width = 0.15 + hash2(k, 0, p.seed) * 0.5;
        const start = (p.clear / 100) * (0.6 + hash2(k, 1, p.seed) * 0.5);
        const d = Math.hypot(x - lx, y - ly) / R0;
        const f = Math.abs(a - k - 0.5) * 2;
        const on = f < width * clamp((d - start) * 3, 0, 1) ? 1 : 0;
        return [lerp(r, col[0], on), lerp(g, col[1], on), lerp(b, col[2], on)];
      });
    },
  },
];

