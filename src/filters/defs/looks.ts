/** Photo Looks, Retro & Pixel, Color & Tone. */

import { contrast, ditherTo, grain, halftoneMask, hueShift, pixelate, saturate, splitTone, vibrance, vignette } from "../fx";
import { B, Img, RGB, applyLUT3, clamp, cloneImg, curveLUT, gauss1, gaussianBlur, gradientLUT, grayOf, hash2, hexRGB, histogram, hsvToRgb, lerp, luma, mapRGB, medianCut, percentile, rgbToHsv, rng } from "../img";
import { angle, check, color, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

const L = "Photo Looks";
const RP = "Retro & Pixel";
const T = "Color & Tone";

/** Per-channel tone curves (each a list of [in, out] points). */
function curves(src: Img, r: [number, number][], g: [number, number][], b: [number, number][], amount = 1): Img {
  const lr = curveLUT(r), lg = curveLUT(g), lb = curveLUT(b);
  return mapRGB(src, (R, G, Bb) => [lerp(R, lr[R], amount), lerp(G, lg[G], amount), lerp(Bb, lb[Bb], amount)]);
}

const lookAmount = pct("amount", "Strength", 100);

const PIXEL_PALETTES: Record<string, RGB[]> = {
  gameboy: [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]],
  nes: [[0, 0, 0], [124, 124, 124], [188, 188, 188], [252, 252, 252], [168, 16, 0], [248, 56, 0], [252, 160, 68], [0, 120, 0], [0, 184, 0], [184, 248, 24], [0, 0, 188], [0, 120, 248], [104, 136, 252], [148, 0, 132], [216, 0, 204], [248, 120, 248], [172, 124, 0], [248, 184, 0], [0, 136, 136], [0, 232, 216]],
  cga: [[0, 0, 0], [85, 255, 255], [255, 85, 255], [255, 255, 255]],
  c64: [[0, 0, 0], [255, 255, 255], [136, 57, 50], [103, 182, 189], [139, 63, 150], [85, 160, 73], [64, 49, 141], [191, 206, 114], [139, 84, 41], [87, 66, 0], [184, 105, 98], [80, 80, 80], [120, 120, 120], [148, 224, 137], [120, 105, 196], [159, 159, 159]],
  pico8: [[0, 0, 0], [29, 43, 83], [126, 37, 83], [0, 135, 81], [171, 82, 54], [95, 87, 79], [194, 195, 199], [255, 241, 232], [255, 0, 77], [255, 163, 0], [255, 236, 39], [0, 228, 54], [41, 173, 255], [131, 118, 156], [255, 119, 168], [255, 204, 170]],
  mono: [[0, 0, 0], [255, 255, 255]],
  sepia4: [[44, 33, 24], [110, 82, 56], [186, 152, 110], [240, 226, 196]],
  vaporwave: [[25, 8, 52], [96, 16, 120], [255, 64, 160], [64, 220, 255], [255, 220, 120], [250, 245, 255]],
};
const palList: [string, string][] = [["auto", "Adaptive"], ["gameboy", "Game Boy"], ["nes", "NES"], ["c64", "Commodore 64"], ["cga", "CGA"], ["pico8", "PICO-8"], ["vaporwave", "Vaporwave"], ["sepia4", "Sepia 4"], ["mono", "1-bit"]];

export const lookFilters: FilterDef[] = [
  // ---------------------------------------------------------- Photo Looks
  {
    id: "sepia",
    name: "Sepia",
    category: L,
    description: "Warm brown toning, like an old print.",
    tags: ["brown", "antique", "old", "toning"],
    params: [lookAmount, pct("warmth", "Warmth", 60)],
    run(src, p) {
      const t = p.warmth / 100;
      const lut = gradientLUT([[0, [20, 12, 6]], [0.5, [lerp(140, 160, t), lerp(110, 100, t), lerp(85, 60, t)]], [1, [255, 248, 230]]]);
      return applyLUT3(src, lut, p.amount / 100);
    },
  },
  {
    id: "vintage",
    name: "Vintage Film",
    category: L,
    description: "Faded blacks, warm highlights, soft contrast and a little grain, like a print from the seventies.",
    tags: ["retro", "70s", "faded", "analog"],
    params: [lookAmount, pct("fade", "Fade", 40), pct("grain", "Grain", 25), pct("vignette", "Vignette", 30), seed(71)],
    run(src, p) {
      const f = p.fade / 100;
      let s = curves(src, [[0, 30 * f + 10], [128, 140], [255, 240]], [[0, 25 * f + 5], [128, 128], [255, 235]], [[0, 40 * f + 20], [128, 110], [255, 200]], p.amount / 100);
      s = saturate(s, 1 - 0.25 * (p.amount / 100));
      if (p.grain > 0) s = grain(s, p.grain * 0.5, 1.2, true, p.seed);
      return p.vignette > 0 ? vignette(s, p.vignette / 100, 0.75) : s;
    },
  },
  {
    id: "crossProcess",
    name: "Cross Process",
    category: L,
    description: "Slide film developed in the wrong chemicals: crushed blues, glowing yellows, strong contrast.",
    tags: ["xpro", "lomo", "analog"],
    params: [lookAmount],
    run: (src, p) => curves(src, [[0, 0], [64, 40], [192, 225], [255, 255]], [[0, 0], [64, 50], [192, 220], [255, 255]], [[0, 50], [255, 190]], p.amount / 100),
  },
  {
    id: "lomo",
    name: "Lomo",
    category: L,
    description: "Toy-camera look: saturated colors, punchy contrast and a heavy vignette.",
    tags: ["toy camera", "holga", "lomography"],
    params: [lookAmount, pct("vignette", "Vignette", 70), range("sat", "Saturation", 0, 200, 140, "%")],
    run(src, p) {
      let s = contrast(src, 35 * (p.amount / 100));
      s = saturate(s, lerp(1, p.sat / 100, p.amount / 100));
      return vignette(s, p.vignette / 100, 0.55, 1);
    },
  },
  {
    id: "infraredColor",
    name: "Infrared",
    category: L,
    description: "Infrared film: glowing white foliage, dark skies, swapped colors.",
    tags: ["ir", "aerochrome", "false color"],
    params: [lookAmount, sel("style", "Style", [["bw", "Black & White IR"], ["aero", "Aerochrome (Red Foliage)"], ["swap", "Channel Swap"]], "aero"), pct("glow", "Glow", 40)],
    pad: () => 20,
    run(src, p, env) {
      const k = p.amount / 100;
      let s = mapRGB(src, (r, g, b) => {
        const foliage = clamp((g - Math.max(r, b)) / 60, 0, 1);
        if (p.style === "bw") {
          const v = clamp(0.25 * r + 1.6 * g - 0.6 * b + foliage * 60);
          return [lerp(r, v, k), lerp(g, v, k), lerp(b, v, k)];
        }
        if (p.style === "swap") return [lerp(r, b, k), lerp(g, g, k), lerp(b, r, k)];
        return [lerp(r, clamp(g * 1.4 + foliage * 90), k), lerp(g, r * 0.8, k), lerp(b, g * 0.6 + b * 0.4, k)];
      });
      if (p.glow > 0) {
        const bl = gaussianBlur(s, 6 * env.scale + 0.5);
        s = mapRGB(s, (r, g, b, i) => [B.screen(r, bl.data[i * 4] * (p.glow / 100)), B.screen(g, bl.data[i * 4 + 1] * (p.glow / 100)), B.screen(b, bl.data[i * 4 + 2] * (p.glow / 100))]);
      }
      return s;
    },
  },
  {
    id: "bleachBypass",
    name: "Bleach Bypass",
    category: L,
    description: "Silver left in the film: desaturated, harsh, high-contrast war-movie look.",
    tags: ["desaturated", "gritty", "film"],
    params: [lookAmount],
    run(src, p) {
      const k = p.amount / 100;
      return mapRGB(src, (r, g, b) => {
        const l = luma(r, g, b);
        return [r, g, b].map((v) => {
          const ov = B.overlay(v, l);
          return lerp(v, lerp(ov, l, 0.25), k);
        });
      });
    },
  },
  {
    id: "tealOrange",
    name: "Teal & Orange",
    category: L,
    description: "Blockbuster grade: teal shadows, warm orange skin tones and highlights.",
    tags: ["cinematic", "grade", "movie", "hollywood"],
    params: [lookAmount, pct("contrast", "Contrast", 25)],
    run(src, p) {
      let s = splitTone(src, 190, 0.55 * (p.amount / 100), 30, 0.5 * (p.amount / 100), 0);
      return contrast(s, p.contrast * (p.amount / 100));
    },
  },
  {
    id: "cinematic",
    name: "Cinematic",
    category: L,
    description: "Widescreen bars, a filmic tone curve and a subtle color grade.",
    tags: ["movie", "letterbox", "widescreen", "anamorphic"],
    params: [sel("ratio", "Aspect Ratio", [["2.39", "2.39:1 Scope"], ["1.85", "1.85:1 Flat"], ["2", "2:1"], ["none", "No Bars"]], "2.39"), sel("grade", "Grade", [["neutral", "Neutral Film"], ["cool", "Cool Night"], ["warm", "Warm Dusk"], ["green", "Matrix Green"]], "neutral"), pct("amount", "Grade Strength", 70)],
    run(src, p) {
      const k = p.amount / 100;
      let s = curves(src, [[0, 12], [64, 58], [192, 205], [255, 245]], [[0, 12], [64, 58], [192, 205], [255, 245]], [[0, 14], [64, 60], [192, 205], [255, 242]], k);
      if (p.grade === "cool") s = splitTone(s, 215, 0.5 * k, 200, 0.2 * k);
      if (p.grade === "warm") s = splitTone(s, 270, 0.25 * k, 35, 0.5 * k);
      if (p.grade === "green") s = splitTone(s, 140, 0.55 * k, 95, 0.35 * k);
      if (p.ratio === "none") return s;
      const target = src.w / +p.ratio;
      const bar = Math.max(0, Math.round((src.h - target) / 2));
      const out = cloneImg(s);
      for (let y = 0; y < src.h; y++) {
        if (y >= bar && y < src.h - bar) continue;
        for (let x = 0; x < src.w; x++) {
          const q = (y * src.w + x) * 4;
          out.data[q] = out.data[q + 1] = out.data[q + 2] = 0;
        }
      }
      return out;
    },
  },
  {
    id: "polaroid",
    name: "Instant Film",
    category: L,
    description: "Instant-camera colors: lifted shadows, creamy highlights, a slight cyan cast.",
    tags: ["polaroid", "instant", "retro"],
    params: [lookAmount, pct("fade", "Fade", 50)],
    run(src, p) {
      const f = p.fade / 100;
      let s = curves(src, [[0, 30 * f], [128, 132], [255, 245]], [[0, 35 * f], [128, 134], [255, 240]], [[0, 45 * f], [128, 128], [255, 220]], p.amount / 100);
      return saturate(s, 1 - 0.15 * (p.amount / 100));
    },
  },
  {
    id: "goldenHour",
    name: "Golden Hour",
    category: L,
    description: "Warm, glowing late-afternoon light.",
    tags: ["warm", "sunset", "sunlight"],
    params: [lookAmount, pct("glow", "Glow", 35)],
    pad: () => 30,
    run(src, p, env) {
      const k = p.amount / 100;
      let s = curves(src, [[0, 10], [128, 150], [255, 255]], [[0, 5], [128, 128], [255, 240]], [[0, 0], [128, 100], [255, 200]], k);
      if (p.glow > 0) {
        const bl = gaussianBlur(s, 18 * env.scale + 1);
        s = mapRGB(s, (r, g, b, i) => [B.screen(r, bl.data[i * 4] * (p.glow / 140)), B.screen(g, bl.data[i * 4 + 1] * (p.glow / 160)), B.screen(b, bl.data[i * 4 + 2] * (p.glow / 220))]);
      }
      return s;
    },
  },
  {
    id: "moonlight",
    name: "Day for Night",
    category: L,
    description: "Turns daylight into moonlit night: dark, blue and low in color.",
    tags: ["night", "blue", "moon"],
    params: [lookAmount, pct("darkness", "Darkness", 55)],
    run(src, p) {
      const k = p.amount / 100, d = p.darkness / 100;
      return mapRGB(src, (r, g, b) => {
        const l = luma(r, g, b) * (1 - d * 0.7);
        return [lerp(r, l * 0.7, k), lerp(g, l * 0.9, k), lerp(b, l * 1.35 + 10, k)];
      });
    },
  },
  {
    id: "nightVision",
    name: "Night Vision",
    category: L,
    description: "Green phosphor night-vision goggles with noise and a round viewfinder.",
    tags: ["military", "green", "goggles"],
    params: [pct("noise", "Noise", 35), check("scope", "Round Viewfinder", true), seed(72)],
    run(src, p) {
      const r = rng(p.seed);
      let s = mapRGB(src, (R, G, Bb) => {
        const l = clamp(luma(R, G, Bb) * 1.5 + (r() - 0.5) * p.noise * 1.4);
        return [l * 0.2, l, l * 0.25];
      });
      if (p.scope) s = vignette(s, 1, 0.45, 1);
      return s;
    },
  },
  {
    id: "thermal",
    name: "Thermal Camera",
    category: L,
    description: "False-color heat map: cold blues through hot yellows and white.",
    tags: ["heat", "infrared", "predator", "false color"],
    params: [sel("palette", "Palette", [["iron", "Ironbow"], ["rainbow", "Rainbow"], ["white", "White Hot"]], "iron"), pct("contrast", "Contrast", 30)],
    run(src, p) {
      const stops: Record<string, [number, RGB][]> = {
        iron: [[0, [0, 0, 20]], [0.25, [70, 0, 140]], [0.5, [210, 40, 60]], [0.75, [255, 160, 0]], [1, [255, 255, 220]]],
        rainbow: [[0, [0, 0, 128]], [0.2, [0, 0, 255]], [0.4, [0, 255, 255]], [0.6, [0, 255, 0]], [0.8, [255, 255, 0]], [1, [255, 0, 0]]],
        white: [[0, [0, 0, 0]], [1, [255, 255, 255]]],
      };
      return applyLUT3(contrast(src, p.contrast), gradientLUT(stops[p.palette]), 1);
    },
  },
  {
    id: "xray",
    name: "X-Ray",
    category: L,
    description: "Inverted, cool-tinted and glowing, like an X-ray film on a light box.",
    tags: ["medical", "invert", "negative"],
    params: [pct("glow", "Glow", 40)],
    pad: () => 12,
    run(src, p, env) {
      const inv = mapRGB(src, (r, g, b) => {
        const v = 255 - luma(r, g, b);
        return [v * 0.85, v * 0.95, v];
      });
      const bl = gaussianBlur(inv, 4 * env.scale + 0.5);
      return mapRGB(inv, (r, g, b, i) => [B.screen(r, bl.data[i * 4] * (p.glow / 100)), B.screen(g, bl.data[i * 4 + 1] * (p.glow / 100)), B.screen(b, bl.data[i * 4 + 2] * (p.glow / 100))]);
    },
  },
  {
    id: "duotone",
    name: "Duotone",
    category: L,
    description: "Maps the picture's tones between two colors, like a two-ink print.",
    tags: ["two color", "spotify", "gradient"],
    params: [color("dark", "Shadow Color", "#1d1145"), color("light", "Highlight Color", "#ff7b54"), lookAmount, pct("contrast", "Contrast", 15)],
    run: (src, p) => applyLUT3(contrast(src, p.contrast), gradientLUT([[0, hexRGB(p.dark)], [1, hexRGB(p.light)]]), p.amount / 100),
  },
  {
    id: "tritone",
    name: "Tritone",
    category: L,
    description: "Three-ink toning: separate colors for shadows, midtones and highlights.",
    tags: ["three color", "toning"],
    params: [color("dark", "Shadows", "#14213d"), color("mid", "Midtones", "#9c6644"), color("light", "Highlights", "#f6e7cb"), lookAmount],
    run: (src, p) => applyLUT3(src, gradientLUT([[0, hexRGB(p.dark)], [0.5, hexRGB(p.mid)], [1, hexRGB(p.light)]]), p.amount / 100),
  },
  {
    id: "technicolor",
    name: "Two-Strip Technicolor",
    category: L,
    description: "Early two-color film: everything in reds and cyans.",
    tags: ["1930s", "old movie", "two strip"],
    params: [lookAmount],
    run(src, p) {
      const k = p.amount / 100;
      return mapRGB(src, (r, g, b) => {
        const nr = r, ng = (g + b) / 2, nb = (g + b) / 2;
        return [lerp(r, nr * 1.05, k), lerp(g, ng * 0.95, k), lerp(b, nb * 1.05, k)];
      });
    },
  },
  {
    id: "cyberpunk",
    name: "Neon Night",
    category: L,
    description: "Magenta and cyan city-at-night grade with deep shadows.",
    tags: ["cyberpunk", "synthwave", "neon", "blade runner"],
    params: [lookAmount, pct("glow", "Glow", 30)],
    pad: () => 20,
    run(src, p, env) {
      const k = p.amount / 100;
      let s = splitTone(src, 200, 0.7 * k, 315, 0.6 * k, 0);
      s = curves(s, [[0, 0], [64, 40], [255, 255]], [[0, 0], [64, 40], [255, 240]], [[0, 10], [64, 60], [255, 255]], k);
      if (p.glow > 0) {
        const bl = gaussianBlur(s, 10 * env.scale + 1);
        s = mapRGB(s, (r, g, b, i) => [B.screen(r, bl.data[i * 4] * (p.glow / 100)), B.screen(g, bl.data[i * 4 + 1] * (p.glow / 100)), B.screen(b, bl.data[i * 4 + 2] * (p.glow / 100))]);
      }
      return s;
    },
  },
  {
    id: "colorSplash",
    name: "Color Splash",
    category: L,
    description: "Black and white except for one color you pick.",
    tags: ["selective color", "accent", "keep color"],
    params: [angle("hue", "Keep Hue", 0, 0, 360), range("range", "Hue Range", 5, 90, 25, "°"), pct("soft", "Softness", 40)],
    run(src, p) {
      return mapRGB(src, (r, g, b) => {
        const [h, s] = rgbToHsv(r, g, b);
        const dh = Math.min(Math.abs(h - p.hue), 360 - Math.abs(h - p.hue));
        const soft = Math.max(1, p.range * (p.soft / 100));
        const k = clamp((p.range - dh) / soft, 0, 1) * clamp(s * 4, 0, 1);
        const l = luma(r, g, b);
        return [lerp(l, r, k), lerp(l, g, k), lerp(l, b, k)];
      });
    },
  },
  {
    id: "vignetteFx",
    name: "Vignette",
    category: L,
    description: "Darkens (or lightens) the corners to draw the eye to the middle.",
    tags: ["corners", "edges", "frame"],
    params: [pct("amount", "Amount", 50), pct("size", "Midpoint", 60, 0, 100), pct("roundness", "Roundness", 100), color("color", "Color", "#000000")],
    run: (src, p) => vignette(src, p.amount / 100, p.size / 100 + 0.2, p.roundness / 100, hexRGB(p.color)),
  },

  // ---------------------------------------------------------- Retro & Pixel
  {
    id: "pixelArt",
    name: "Pixel Art",
    category: RP,
    description: "Chunky pixels in a limited palette, like a classic video game.",
    tags: ["8-bit", "16-bit", "sprite", "retro game"],
    params: [px("size", "Pixel Size", 2, 64, 8), sel("palette", "Palette", palList, "auto"), range("colors", "Adaptive Colors", 2, 64, 16), sel("dither", "Dithering", [["none", "None"], ["bayer", "Ordered"], ["floyd", "Diffusion"]], "none"), check("outline", "Dark Outlines", false)],
    ownAlpha: true,
    run(src, p) {
      const s = Math.max(1, Math.round(p.size));
      const sw = Math.max(1, Math.ceil(src.w / s)), sh = Math.max(1, Math.ceil(src.h / s));
      // Work on the small image, then scale back up with hard pixels.
      const small = { w: sw, h: sh, data: new Uint8ClampedArray(sw * sh * 4) };
      const blk = pixelate(src, s);
      for (let y = 0; y < sh; y++)
        for (let x = 0; x < sw; x++) {
          const q = (Math.min(src.h - 1, y * s) * src.w + Math.min(src.w - 1, x * s)) * 4, t = (y * sw + x) * 4;
          for (let c = 0; c < 4; c++) small.data[t + c] = blk.data[q + c];
        }
      const pal = p.palette === "auto" ? medianCut(small, Math.round(p.colors)) : PIXEL_PALETTES[p.palette];
      let q = ditherTo(small, pal, p.dither, 0.8);
      if (p.outline) {
        const g = grayOf(q);
        q = mapRGB(q, (r, gg, b, i) => {
          const x = i % sw, y = (i / sw) | 0;
          const n = Math.min(x + 1 < sw ? g[i + 1] : 255, y + 1 < sh ? g[i + sw] : 255);
          return g[i] - n > 60 ? [r * 0.3, gg * 0.3, b * 0.3] : [r, gg, b];
        });
      }
      const out = cloneImg(src);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const t = (Math.floor(y / s) * sw + Math.floor(x / s)) * 4, o = (y * src.w + x) * 4;
          for (let c = 0; c < 3; c++) out.data[o + c] = q.data[t + c];
          out.data[o + 3] = q.data[t + 3] > 127 ? 255 : 0;
        }
      return out;
    },
  },
  {
    id: "dither",
    name: "Dither",
    category: RP,
    description: "Reduces colors with a dither pattern, like old computer graphics or a newspaper.",
    tags: ["1-bit", "bayer", "floyd-steinberg", "atkinson", "mac"],
    params: [sel("palette", "Palette", palList, "mono"), range("colors", "Adaptive Colors", 2, 64, 8), sel("method", "Method", [["bayer", "Ordered (Bayer)"], ["floyd", "Floyd-Steinberg"], ["atkinson", "Atkinson"], ["none", "None"]], "atkinson"), pct("strength", "Strength", 100), px("pixel", "Pixel Size", 1, 8, 1)],
    run(src, p) {
      const pal = p.palette === "auto" ? medianCut(src, Math.round(p.colors)) : PIXEL_PALETTES[p.palette];
      const ps = Math.max(1, Math.round(p.pixel));
      if (ps === 1) return ditherTo(src, pal, p.method, p.strength / 100);
      const blk = pixelate(src, ps);
      return ditherTo(blk, pal, p.method === "floyd" || p.method === "atkinson" ? "bayer" : p.method, p.strength / 100, ps);
    },
  },
  {
    id: "vhs",
    name: "VHS Tape",
    category: RP,
    description: "Worn videotape: color bleed, tracking noise, soft image and a timestamp feel.",
    tags: ["video", "80s", "90s", "analog", "tape"],
    params: [pct("bleed", "Color Bleed", 50), pct("noise", "Tracking Noise", 35), pct("soft", "Softness", 40), check("lines", "Scan Lines", true), seed(81)],
    pad: () => 20,
    ownAlpha: true,
    run(src, p, env) {
      const r = rng(p.seed);
      const soft = gaussianBlur(src, (p.soft / 100) * 1.6 * env.scale + 0.2);
      const out = cloneImg(soft);
      const shift = Math.round((p.bleed / 100) * 6 * env.scale);
      const bands: number[] = [];
      for (let i = 0; i < 3; i++) bands.push(r() * src.h);
      for (let y = 0; y < src.h; y++) {
        const jitter = bands.some((b) => Math.abs(y - b) < 4 * env.scale + 1) ? (r() - 0.5) * 20 * (p.noise / 100) * env.scale : 0;
        for (let x = 0; x < src.w; x++) {
          const q = (y * src.w + x) * 4;
          const xr = Math.min(src.w - 1, Math.max(0, Math.round(x - shift + jitter))), xb = Math.min(src.w - 1, Math.max(0, Math.round(x + shift + jitter)));
          out.data[q] = soft.data[(y * src.w + xr) * 4];
          out.data[q + 2] = soft.data[(y * src.w + xb) * 4 + 2];
          out.data[q + 1] = soft.data[(y * src.w + Math.min(src.w - 1, Math.max(0, Math.round(x + jitter)))) * 4 + 1];
          const n = (r() - 0.5) * p.noise * 0.6;
          for (let c = 0; c < 3; c++) out.data[q + c] += n;
          if (p.lines && y % 2 === 0) for (let c = 0; c < 3; c++) out.data[q + c] *= 0.88;
        }
      }
      return saturate(out, 1.15);
    },
  },
  {
    id: "crt",
    name: "CRT Screen",
    category: RP,
    description: "Old tube monitor: RGB phosphor stripes, scan lines, curved glow at the edges.",
    tags: ["monitor", "arcade", "scanlines", "tube"],
    params: [px("pitch", "Phosphor Size", 1, 8, 3), pct("scan", "Scan Lines", 50), pct("glow", "Glow", 30), pct("vignette", "Edge Darkening", 40)],
    pad: () => 10,
    run(src, p, env) {
      const pitch = Math.max(1, Math.round(p.pitch));
      let s = mapRGB(src, (r, g, b, i) => {
        const x = i % src.w, y = (i / src.w) | 0;
        const ch = Math.floor(x / pitch) % 3;
        const mask = [ch === 0 ? 1 : 0.55, ch === 1 ? 1 : 0.55, ch === 2 ? 1 : 0.55];
        const scan = 1 - (Math.floor(y / pitch) % 2 ? p.scan / 100 : 0) * 0.6;
        return [r * mask[0] * scan * 1.2, g * mask[1] * scan * 1.2, b * mask[2] * scan * 1.2];
      });
      if (p.glow > 0) {
        const bl = gaussianBlur(s, 3 * env.scale + 0.5);
        s = mapRGB(s, (r, g, b, i) => [B.screen(r, bl.data[i * 4] * (p.glow / 100)), B.screen(g, bl.data[i * 4 + 1] * (p.glow / 100)), B.screen(b, bl.data[i * 4 + 2] * (p.glow / 100))]);
      }
      return vignette(s, p.vignette / 100, 0.8, 0.8);
    },
  },
  {
    id: "newsprint",
    name: "Newsprint",
    category: RP,
    description: "Black-and-white halftone on yellowed newspaper.",
    tags: ["newspaper", "halftone", "print"],
    params: [px("dot", "Dot Size", 2, 20, 5), color("paper", "Paper", "#ece4cf"), pct("contrast", "Contrast", 30)],
    run(src, p) {
      const g = grayOf(contrast(src, p.contrast));
      const m = halftoneMask(g, src.w, src.h, p.dot, 45, "dot");
      const paper = hexRGB(p.paper);
      return mapRGB(src, (_r, _g, _b, i) => [paper[0] * (1 - m[i] * 0.88), paper[1] * (1 - m[i] * 0.88), paper[2] * (1 - m[i] * 0.88)]);
    },
  },
  {
    id: "pixelSort",
    name: "Pixel Sort",
    category: RP,
    description: "Sorts runs of pixels by brightness, for glitch-art streaks.",
    tags: ["glitch", "sort", "streaks"],
    params: [range("low", "Lower Threshold", 0, 255, 60), range("high", "Upper Threshold", 0, 255, 220), sel("dir", "Direction", [["h", "Horizontal"], ["v", "Vertical"]], "h"), check("reverse", "Reverse", false)],
    run(src, p) {
      const out = cloneImg(src);
      const { w, h } = src;
      const lines = p.dir === "h" ? h : w, len = p.dir === "h" ? w : h;
      const idx = (a: number, b: number) => (p.dir === "h" ? (a * w + b) * 4 : (b * w + a) * 4);
      for (let a = 0; a < lines; a++) {
        let start = -1;
        for (let b = 0; b <= len; b++) {
          const q = b < len ? idx(a, b) : -1;
          const l = q >= 0 ? luma(src.data[q], src.data[q + 1], src.data[q + 2]) : -1;
          const inRun = l >= p.low && l <= p.high;
          if (inRun && start < 0) start = b;
          if ((!inRun || b === len) && start >= 0) {
            const run: number[][] = [];
            for (let k = start; k < b; k++) {
              const qq = idx(a, k);
              run.push([src.data[qq], src.data[qq + 1], src.data[qq + 2], src.data[qq + 3]]);
            }
            run.sort((x, y) => (luma(x[0], x[1], x[2]) - luma(y[0], y[1], y[2])) * (p.reverse ? -1 : 1));
            run.forEach((c, k) => {
              const qq = idx(a, start + k);
              for (let ch = 0; ch < 4; ch++) out.data[qq + ch] = c[ch];
            });
            start = -1;
          }
        }
      }
      return out;
    },
  },
  {
    id: "anaglyph",
    name: "3D Anaglyph",
    category: RP,
    description: "Red-cyan 3D glasses effect.",
    tags: ["3d", "stereo", "red cyan"],
    params: [px("shift", "Separation", 1, 40, 6)],
    pad: (p) => p.shift,
    run(src, p) {
      const out = cloneImg(src);
      const s = Math.round(p.shift);
      for (let y = 0; y < src.h; y++)
        for (let x = 0; x < src.w; x++) {
          const q = (y * src.w + x) * 4;
          const l = (y * src.w + Math.max(0, x - s)) * 4, r = (y * src.w + Math.min(src.w - 1, x + s)) * 4;
          out.data[q] = luma(src.data[l], src.data[l + 1], src.data[l + 2]);
          out.data[q + 1] = src.data[r + 1];
          out.data[q + 2] = src.data[r + 2];
        }
      return out;
    },
  },

  // ---------------------------------------------------------- Color & Tone
  {
    id: "brightnessContrast",
    name: "Brightness/Contrast",
    category: T,
    description: "Simple brightness and contrast.",
    adjustment: true,
    params: [range("brightness", "Brightness", -150, 150, 0), range("contrast", "Contrast", -100, 100, 0)],
    run: (src, p) => contrast(mapRGB(src, (r, g, b) => [r + p.brightness * 0.6, g + p.brightness * 0.6, b + p.brightness * 0.6]), p.contrast),
  },
  {
    id: "hueSaturation",
    name: "Hue/Saturation",
    category: T,
    description: "Shift hues, change saturation and lightness, or colorize with one hue.",
    adjustment: true,
    tags: ["hue", "saturation", "colorize"],
    params: [angle("hue", "Hue", 0), range("sat", "Saturation", -100, 100, 0), range("light", "Lightness", -100, 100, 0), check("colorize", "Colorize", false)],
    run(src, p) {
      return mapRGB(src, (r, g, b) => {
        let [h, s, v] = rgbToHsv(r, g, b);
        if (p.colorize) {
          h = (p.hue + 360) % 360;
          s = clamp(0.25 + p.sat / 200, 0, 1);
        } else {
          h += p.hue;
          s = clamp(s * (1 + p.sat / 100), 0, 1);
        }
        let c = hsvToRgb(h, s, v);
        if (p.colorize) {
          const l = luma(r, g, b) / 255;
          const cl = luma(c[0], c[1], c[2]) / 255 || 1;
          c = c.map((x) => (x * l) / cl) as RGB;
        }
        const L = p.light / 100;
        return c.map((x) => (L >= 0 ? lerp(x, 255, L) : x * (1 + L)));
      });
    },
  },
  {
    id: "vibranceFx",
    name: "Vibrance",
    category: T,
    description: "Boosts muted colors more than colors that are already strong.",
    adjustment: true,
    params: [range("vibrance", "Vibrance", -100, 100, 40), range("sat", "Saturation", -100, 100, 0)],
    run: (src, p) => saturate(vibrance(src, p.vibrance / 100), 1 + p.sat / 100),
  },
  {
    id: "temperature",
    name: "White Balance",
    category: T,
    description: "Warms or cools the picture and corrects green or magenta casts.",
    adjustment: true,
    tags: ["warm", "cool", "temperature", "tint"],
    params: [range("temp", "Temperature", -100, 100, 20), range("tint", "Tint", -100, 100, 0)],
    run: (src, p) => mapRGB(src, (r, g, b) => [r + p.temp * 0.35, g - p.tint * 0.3, b - p.temp * 0.35]),
  },
  {
    id: "exposure",
    name: "Exposure",
    category: T,
    description: "Photographic exposure in stops, with offset and gamma.",
    adjustment: true,
    params: [range("stops", "Exposure", -5, 5, 0.5, "EV", 0.05), range("offset", "Offset", -0.5, 0.5, 0, "", 0.01), range("gamma", "Gamma", 0.2, 3, 1, "", 0.01)],
    run(src, p) {
      const k = Math.pow(2, p.stops);
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const lin = Math.pow(i / 255, 2.2) * k + p.offset;
        lut[i] = Math.pow(clamp(lin, 0, 1), 1 / 2.2 / p.gamma) * 255;
      }
      return mapRGB(src, (r, g, b) => [lut[r], lut[g], lut[b]]);
    },
  },
  {
    id: "shadowsHighlights",
    name: "Shadows/Highlights",
    category: T,
    description: "Opens up dark shadows and recovers bright highlights.",
    adjustment: true,
    tags: ["hdr", "recover", "fill light"],
    params: [pct("shadows", "Shadows", 35), pct("highlights", "Highlights", 0), px("radius", "Tonal Width Radius", 5, 300, 30)],
    pad: (p) => p.radius * 2,
    run(src, p) {
      const g = gauss1(grayOf(src), src.w, src.h, p.radius);
      return mapRGB(src, (r, gg, b, i) => {
        const l = g[i] / 255;
        const lift = (p.shadows / 100) * Math.pow(1 - l, 2) * 120;
        const drop = (p.highlights / 100) * Math.pow(l, 2) * 120;
        return [r + lift - drop, gg + lift - drop, b + lift - drop];
      });
    },
  },
  {
    id: "autoLevels",
    name: "Auto Levels",
    category: T,
    description: "Stretches each color channel so the darkest pixels are black and the lightest are white.",
    adjustment: true,
    params: [pct("clip", "Clip", 0.5, 0, 10)],
    run(src, p) {
      const h = histogram(src);
      const q = p.clip / 100;
      const ranges = [h.r, h.g, h.b].map((c) => [percentile(c, q), percentile(c, 1 - q)]);
      return mapRGB(src, (r, g, b) => [r, g, b].map((v, c) => ((v - ranges[c][0]) * 255) / Math.max(1, ranges[c][1] - ranges[c][0])));
    },
  },
  {
    id: "autoContrast",
    name: "Auto Contrast",
    category: T,
    description: "Stretches brightness so the picture uses the full range, without shifting colors.",
    adjustment: true,
    params: [pct("clip", "Clip", 0.5, 0, 10)],
    run(src, p) {
      const h = histogram(src);
      const lo = percentile(h.l, p.clip / 100), hi = percentile(h.l, 1 - p.clip / 100);
      const k = 255 / Math.max(1, hi - lo);
      return mapRGB(src, (r, g, b) => [(r - lo) * k, (g - lo) * k, (b - lo) * k]);
    },
  },
  {
    id: "equalize",
    name: "Equalize",
    category: T,
    description: "Spreads brightness values evenly across the whole range.",
    adjustment: true,
    params: [],
    run(src) {
      const h = histogram(src).l;
      let total = 0;
      for (const v of h) total += v;
      const cdf = new Float32Array(256);
      let acc = 0;
      for (let i = 0; i < 256; i++) {
        acc += h[i];
        cdf[i] = (acc / Math.max(1, total)) * 255;
      }
      return mapRGB(src, (r, g, b) => {
        const l = Math.round(luma(r, g, b));
        const k = l ? cdf[l] / l : 1;
        return [r * k, g * k, b * k];
      });
    },
  },
  {
    id: "posterizeFx",
    name: "Posterize",
    category: T,
    description: "Limits each channel to a number of levels.",
    adjustment: true,
    params: [range("levels", "Levels", 2, 255, 4)],
    run(src, p) {
      const n = Math.max(2, Math.round(p.levels));
      const step = 255 / (n - 1);
      return mapRGB(src, (r, g, b) => [Math.round(r / step) * step, Math.round(g / step) * step, Math.round(b / step) * step]);
    },
  },
  {
    id: "threshold",
    name: "Threshold",
    category: T,
    description: "Pure black and white, split at a brightness level.",
    adjustment: true,
    params: [range("level", "Threshold Level", 1, 255, 128)],
    run: (src, p) => mapRGB(src, (r, g, b) => (luma(r, g, b) >= p.level ? [255, 255, 255] : [0, 0, 0])),
  },
  {
    id: "gradientMap",
    name: "Gradient Map",
    category: T,
    description: "Replaces brightness with colors from a gradient.",
    adjustment: true,
    params: [sel("preset", "Gradient", [["fgbg", "Foreground to Background"], ["sunset", "Sunset"], ["ocean", "Ocean"], ["forest", "Forest"], ["fire", "Fire"], ["chrome", "Chrome"], ["spectrum", "Spectrum"]], "fgbg"), check("reverse", "Reverse", false), lookAmount],
    run(src, p, env) {
      const presets: Record<string, [number, RGB][]> = {
        fgbg: [[0, env.fg], [1, env.bg]],
        sunset: [[0, [30, 10, 60]], [0.4, [200, 50, 80]], [0.7, [250, 150, 60]], [1, [255, 240, 180]]],
        ocean: [[0, [0, 20, 40]], [0.5, [0, 120, 160]], [1, [200, 250, 255]]],
        forest: [[0, [10, 25, 10]], [0.5, [60, 120, 50]], [1, [230, 240, 180]]],
        fire: [[0, [0, 0, 0]], [0.35, [160, 20, 0]], [0.7, [255, 160, 0]], [1, [255, 255, 200]]],
        chrome: [[0, [20, 20, 30]], [0.3, [200, 200, 210]], [0.5, [60, 60, 70]], [0.75, [240, 240, 250]], [1, [120, 120, 130]]],
        spectrum: [[0, [255, 0, 0]], [0.2, [255, 255, 0]], [0.4, [0, 255, 0]], [0.6, [0, 255, 255]], [0.8, [0, 0, 255]], [1, [255, 0, 255]]],
      };
      let stops = presets[p.preset];
      if (p.reverse) stops = stops.map(([t, c]) => [1 - t, c] as [number, RGB]);
      return applyLUT3(src, gradientLUT(stops), p.amount / 100);
    },
  },
  {
    id: "channelMixer",
    name: "Channel Mixer",
    category: T,
    description: "Builds each output channel from a mix of the red, green and blue channels.",
    adjustment: true,
    params: [
      pct("rr", "Red from Red", 100, -200, 200), pct("rg", "Red from Green", 0, -200, 200), pct("rb", "Red from Blue", 0, -200, 200),
      pct("gr", "Green from Red", 0, -200, 200), pct("gg", "Green from Green", 100, -200, 200), pct("gb", "Green from Blue", 0, -200, 200),
      pct("br", "Blue from Red", 0, -200, 200), pct("bg", "Blue from Green", 0, -200, 200), pct("bb", "Blue from Blue", 100, -200, 200),
      check("mono", "Monochrome (use Red row)", false),
    ],
    run(src, p) {
      return mapRGB(src, (r, g, b) => {
        const R = (p.rr * r + p.rg * g + p.rb * b) / 100;
        if (p.mono) return [R, R, R];
        return [R, (p.gr * r + p.gg * g + p.gb * b) / 100, (p.br * r + p.bg * g + p.bb * b) / 100];
      });
    },
  },
  {
    id: "hueRotate",
    name: "Hue Rotate",
    category: T,
    description: "Spins every color around the color wheel.",
    params: [angle("angle", "Angle", 120)],
    run: (src, p) => hueShift(src, p.angle),
  },
  {
    id: "invertLuma",
    name: "Invert Brightness",
    category: T,
    description: "Inverts light and dark but keeps the colors' hues.",
    tags: ["negative", "invert"],
    params: [],
    run: (src) =>
      mapRGB(src, (r, g, b) => {
        const l = luma(r, g, b);
        const t = 255 - l;
        return [r + t - l, g + t - l, b + t - l];
      }),
  },
  {
    id: "noiseTint",
    name: "Random Color Wash",
    category: T,
    description: "A soft random wash of color over the picture, different with every seed.",
    tags: ["random", "wash", "light leak"],
    params: [pct("amount", "Amount", 35), seed(91)],
    run(src, p) {
      const c = hsvToRgb(hash2(p.seed, 3) * 360, 0.6, 1);
      const c2 = hsvToRgb(hash2(p.seed, 7) * 360, 0.7, 1);
      return mapRGB(src, (r, g, b, i) => {
        const x = (i % src.w) / src.w, y = ((i / src.w) | 0) / src.h;
        const t = clamp(x * 0.7 + y * 0.3, 0, 1);
        const k = p.amount / 100;
        return [B.screen(r, lerp(c[0], c2[0], t) * k), B.screen(g, lerp(c[1], c2[1], t) * k), B.screen(b, lerp(c[2], c2[2], t) * k)];
      });
    },
  },
];
