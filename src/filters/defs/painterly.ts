/**
 * The painterly, cartoon and drawing filters, built on the rendering engine
 * in ../paint.ts. These replace the earlier versions under the same ids
 * (so recorded Actions keep working) and add a few new styles.
 */

import { Img, RGB, clamp, gauss1, hexRGB, resizeBilinear } from "../img";
import * as P from "../paint";
import { check, color, pct, px, range, seed, sel } from "../p";
import type { FilterDef, FilterEnv } from "../types";

const CC = "Cartoon & Comic", ART = "Artistic", SK = "Sketch";

type Pl = P.Planes;

/** Pixel constants scale with previews (env.scale < 1). */
const kOf = (env: FilterEnv) => Math.max(0.05, env.scale);

/**
 * Run a stroke-based painter at no more than `maxPx` pixels: big photos are
 * painted smaller (with brush sizes scaled to match) and enlarged, which
 * keeps them from taking minutes; strokes are large enough not to suffer.
 */
function capped(src: Img, p: Record<string, any>, env: FilterEnv, pxKeys: string[], fn: (src: Img, p: Record<string, any>, env: FilterEnv) => Img, maxPx = 3_000_000): Img {
  const n = src.w * src.h;
  if (n <= maxPx) return fn(src, p, env);
  const f = Math.sqrt(maxPx / n);
  const small = resizeBilinear(src, Math.max(1, Math.round(src.w * f)), Math.max(1, Math.round(src.h * f)));
  const q = { ...p };
  for (const key of pxKeys) if (typeof q[key] === "number") q[key] *= f;
  const out = fn(small, q, { ...env, scale: env.scale * f });
  return resizeBilinear(out, src.w, src.h);
}

/** Edge-aware abstraction: flat color regions, sharp boundaries. strength 1..10. */
function abstraction(p: Pl, k: number, strength: number): Pl {
  let s = P.dtSmooth(p, (6 + strength * 4.5) * k, 0.18 + strength * 0.022, 3);
  if (strength > 3) s = P.dtSmooth(s, (3 + strength * 2) * k, 0.15, 2);
  return s;
}

/** Flow field of the image's forms (shared by lines, strokes and hatching). */
function formFlow(p: Pl, k: number, spread = 4): P.Flow {
  return P.flowField(P.dtSmooth(p, 10 * k, 0.3, 2), spread * k);
}

/** Clean ink lines: width in px, detail 0..1 (more lines), smooth 0..1 (longer, calmer lines). */
function inkLines(p: Pl, flow: P.Flow, k: number, width: number, detail: number, smooth = 0.5): Float32Array {
  const pre = P.lumaOf(P.dtSmooth(p, (4 + (1 - detail) * 14) * k, 0.12 + (1 - detail) * 0.1, 2));
  return P.flowInk(pre, flow, {
    sigma: Math.max(0.35, width * 0.55 * k),
    flowSigma: (2 + smooth * 4) * k,
    p: 20 + detail * 20,
    eps: 0.52 - detail * 0.22,
    phi: 4 + detail * 2,
  });
}

function relit(s: Pl, height: Float32Array, strength: number, highlight: number): void {
  const { w, h } = s;
  const L = P.shade(gauss1(height, w, h, 0.8), w, h, strength);
  for (const ch of s.c)
    for (let i = 0; i < ch.length; i++) ch[i] = ch[i] * (0.9 + 0.1 * L[i]) + Math.max(0, L[i] - 1.1) * highlight;
}

function onPaper(s: Pl, paper: Float32Array, relief: number, tint: RGB = [252, 249, 242]): void {
  const { w, h } = s;
  const L = P.shade(gauss1(paper, w, h, 0.7), w, h, relief);
  const t = tint.map((v) => v / 255);
  const [r, g, b] = s.c;
  for (let i = 0; i < r.length; i++) {
    const k = 0.94 + 0.06 * L[i];
    r[i] = r[i] * t[0] * k;
    g[i] = g[i] * t[1] * k;
    b[i] = b[i] * t[2] * k;
  }
}

const gray = (v: Float32Array, w: number, h: number, tint: RGB = [255, 255, 255]): Pl => {
  const t = tint.map((x) => x / 255);
  const c: Pl["c"] = [new Float32Array(v.length), new Float32Array(v.length), new Float32Array(v.length)];
  for (let i = 0; i < v.length; i++) {
    c[0][i] = v[i] * t[0];
    c[1][i] = v[i] * t[1];
    c[2][i] = v[i] * t[2];
  }
  return { w, h, c };
};

const done = (s: Pl, src: Img): Img => {
  P.clampPlanes(s);
  return P.fromPlanes(s, src);
};

/** Drawing darkness from luma: lights go to clean paper, darks build up. amount 0..1. */
function drawTone(l: Float32Array, amount: number): Float32Array {
  const out = new Float32Array(l.length);
  const lift = 1.02 + (1 - amount) * 0.3, g = 1.1 + amount * 0.9;
  for (let i = 0; i < l.length; i++) out[i] = 1 - Math.pow(clamp(l[i] * lift, 0, 1), g);
  return out;
}

/** Tone 0 (white) .. 1 (black) of the smoothed image, with a contrast curve. */
function darkness(l: Float32Array, contrast: number, bias: number): Float32Array {
  const out = new Float32Array(l.length);
  const c = 1 + contrast * 1.5;
  for (let i = 0; i < l.length; i++) out[i] = clamp((0.5 - l[i]) * c + 0.5 + bias, 0, 1);
  return out;
}

function hatchTone(dark: Float32Array, w: number, h: number, k: number, spacing: number, angle: number, seedV: number, layers: number, pap?: Float32Array): Float32Array {
  const sp = spacing * k;
  const hs = [P.hatchPlane(w, h, angle, sp, 16 * k, seedV)];
  if (layers > 1) hs.push(P.hatchPlane(w, h, angle - 90, sp * 1.1, 14 * k, seedV + 1));
  if (layers > 2) hs.push(P.hatchPlane(w, h, angle + 45, sp * 1.2, 12 * k, seedV + 2));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const d = dark[i];
    let v = hs[0][i] * P.sstep(0.06, 0.5, d);
    if (layers > 1) v = Math.max(v, hs[1][i] * P.sstep(0.4, 0.8, d)) + Math.min(v, hs[1][i]) * 0.3;
    if (layers > 2) v = Math.max(v, hs[2][i] * P.sstep(0.7, 0.95, d));
    v = Math.max(v, Math.pow(d, 2.2) * 0.3);
    out[i] = clamp(v, 0, 1) * (pap ? 0.75 + 0.25 * pap[i] : 1);
  }
  return out;
}

const PAPER_OPTS: [string, string][] = [
  ["cold", "Cold Press"],
  ["rough", "Rough"],
  ["hot", "Hot Press (smooth)"],
];

// ------------------------------------------------------------------ cartoon & comic

const cartoon: FilterDef = {
  id: "cartoon",
  name: "Cartoon",
  category: CC,
  description: "Flat color areas in a few soft tones with clean, flowing ink outlines, like a hand-inked cartoon.",
  tags: ["toon", "cel", "animation", "outline", "comic"],
  params: [range("smooth", "Simplify", 1, 10, 6), range("levels", "Tones", 3, 16, 8), px("lines", "Line Width", 0, 6, 1.6, 0.1), pct("detail", "Line Detail", 45), pct("lineStrength", "Line Strength", 95), range("sat", "Saturation", 0, 200, 125, "%")],
  pad: (p) => 20 + p.smooth * 10 + p.lines * 8,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const s = abstraction(pl, k, p.smooth);
    P.quantizeLuma(s, p.levels, 3 + p.levels * 0.6);
    P.saturatePlanes(s, p.sat / 100);
    if (p.lines > 0) P.inkOver(s, inkLines(pl, formFlow(pl, k), k, p.lines, p.detail / 100), [16, 13, 20], p.lineStrength / 100);
    return done(s, src);
  },
};

const comicBook: FilterDef = {
  id: "comicBook",
  name: "Comic Book",
  category: CC,
  description: "Punchy flat colors, bold ink, solid black shadows and halftone dots, like a printed comic page.",
  tags: ["halftone", "ben-day", "superhero", "ink", "marvel"],
  params: [px("dot", "Dot Size", 2, 24, 6, 0.5), pct("shadowDots", "Dots in Shadows", 60), px("lines", "Ink Width", 0, 6, 2, 0.1), pct("blacks", "Solid Blacks", 50), range("boost", "Color Boost", 0, 200, 150, "%"), range("levels", "Tones", 3, 12, 5)],
  pad: (p) => 60 + p.dot * 2 + p.lines * 8,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const s = abstraction(pl, k, 7);
    P.quantizeLuma(s, p.levels, 9);
    P.saturatePlanes(s, p.boost / 100);
    const lum = P.lumaOf(s);
    const cell = Math.max(1.5, p.dot), ang = Math.PI / 4, ca = Math.cos(ang), sa = Math.sin(ang);
    const amt = p.shadowDots / 100;
    const [r, g, b] = s.c;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const u = (x * ca + y * sa) / cell, v = (-x * sa + y * ca) / cell;
        const fu = u - Math.round(u), fv = v - Math.round(v);
        const cov = clamp((0.62 - lum[i]) * 1.7, 0, 1) * amt;
        const dot = clamp((Math.sqrt(cov / Math.PI) - Math.sqrt(fu * fu + fv * fv)) * cell * 1.2, 0, 1);
        const m = 1 - dot * 0.6;
        r[i] *= m;
        g[i] *= m;
        b[i] *= m;
      }
    let ink = p.lines > 0 ? inkLines(pl, formFlow(pl, k), k, p.lines, 0.5, 0.6) : new Float32Array(w * h);
    const bl = p.blacks / 100;
    if (bl > 0) {
      ink = ink === undefined ? new Float32Array(w * h) : ink;
      const t = 0.06 + bl * 0.16;
      for (let i = 0; i < ink.length; i++) ink[i] = Math.max(ink[i], P.sstep(t + 0.04, t - 0.02, lum[i]));
    }
    P.inkOver(s, ink, [12, 10, 18], 1);
    return done(s, src);
  },
};

const celShade: FilterDef = {
  id: "celShade",
  name: "Cel Shading",
  category: CC,
  description: "Lighting in a few hard bands, like toon-shaded 3D games, with colored outlines.",
  tags: ["toon", "bands", "anime", "game"],
  params: [range("bands", "Bands", 2, 8, 4), pct("softness", "Band Softness", 25), px("lines", "Outline", 0, 6, 1.4, 0.1), color("lineColor", "Outline Color", "#1a1420"), range("smooth", "Simplify", 1, 10, 7), range("sat", "Saturation", 0, 200, 120, "%")],
  pad: (p) => 20 + p.smooth * 10 + p.lines * 8,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const s = abstraction(pl, k, p.smooth);
    const s2 = P.dtSmooth(s, 24 * k, 0.12, 2);
    P.quantizeLuma(s2, p.bands + 1, 2 + (1 - p.softness / 100) * 30);
    s.c = s2.c;
    P.saturatePlanes(s, p.sat / 100);
    if (p.lines > 0) P.inkOver(s, inkLines(pl, formFlow(pl, k), k, p.lines, 0.35, 0.7), hexRGB(p.lineColor), 1);
    return done(s, src);
  },
};

const anime: FilterDef = {
  id: "anime",
  name: "Anime",
  category: CC,
  description: "Clean anime look: smooth skin and skies, crisp two-tone shading, vivid color, fine colored line art and a soft glow.",
  tags: ["manga", "cartoon", "japan", "ghibli", "cel"],
  params: [range("smooth", "Simplify", 1, 10, 7), px("lines", "Line Width", 0, 4, 1.1, 0.1), color("lineColor", "Line Color", "#3a2430"), range("sat", "Vividness", 0, 200, 135, "%"), pct("glow", "Glow", 30)],
  pad: (p) => 30 + p.smooth * 12,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    let s = abstraction(pl, k, p.smooth);
    s = P.dtSmooth(s, 20 * k, 0.12, 2);
    P.quantizeLuma(s, 5, 14);
    P.saturatePlanes(s, p.sat / 100);
    const [r, g, b] = s.c;
    for (let i = 0; i < r.length; i++) {
      r[i] = Math.pow(clamp(r[i], 0, 1), 0.85);
      g[i] = Math.pow(clamp(g[i], 0, 1), 0.85);
      b[i] = Math.pow(clamp(b[i], 0, 1), 0.8);
    }
    if (p.glow > 0) {
      const l = P.lumaOf(s);
      const hi = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) hi[i] = P.sstep(0.7, 1, l[i]);
      const bl = gauss1(hi, w, h, 18 * k);
      const a = p.glow / 100;
      for (const ch of s.c) for (let i = 0; i < ch.length; i++) ch[i] = 1 - (1 - ch[i]) * (1 - bl[i] * a * 0.6);
    }
    if (p.lines > 0) P.inkOver(s, inkLines(pl, formFlow(pl, k), k, p.lines, 0.4, 0.8), hexRGB(p.lineColor), 0.9);
    return done(s, src);
  },
};

const inkDrawing: FilterDef = {
  id: "inkDrawing",
  name: "Ink Drawing",
  category: CC,
  description: "Pen-and-ink: confident outlines that follow the forms, with hatched shading in the darks.",
  tags: ["pen", "lineart", "outline", "hatching"],
  params: [px("lines", "Line Width", 0.4, 5, 1.3, 0.1), pct("detail", "Detail", 50), pct("shading", "Hatching", 55), px("spacing", "Hatch Spacing", 2, 12, 4, 0.5), color("ink", "Ink", "#141218"), color("paper", "Paper", "#faf7f0")],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const flow = formFlow(pl, k);
    const ink = inkLines(pl, flow, k, p.lines, p.detail / 100, 0.6);
    if (p.shading > 0) {
      const dark = darkness(P.lumaOf(P.dtSmooth(pl, 12 * k, 0.2, 2)), 0.4, -0.2 + (p.shading / 100) * 0.25);
      const hatch = hatchTone(dark, w, h, 1, p.spacing, 45, 7, 2);
      for (let i = 0; i < ink.length; i++) ink[i] = Math.max(ink[i], P.sstep(0.35, 0.75, hatch[i]) * (p.shading / 100));
    }
    const paperC = hexRGB(p.paper);
    const s = gray(new Float32Array(w * h).fill(1), w, h, paperC);
    P.inkOver(s, ink, hexRGB(p.ink), 1);
    return done(s, src);
  },
};

const sketchToon: FilterDef = {
  id: "sketchToon",
  name: "Sketchy Toon",
  category: CC,
  description: "A loose pencil line drawing with a light wash of flat color, like a storyboard or concept sketch.",
  tags: ["storyboard", "concept", "pencil", "wash"],
  params: [px("lines", "Line Width", 0.4, 4, 1.1, 0.1), pct("color", "Color Wash", 70), range("smooth", "Simplify", 1, 10, 7), color("lineColor", "Pencil", "#3c3a44")],
  pad: (p) => 30 + p.smooth * 10,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const s = abstraction(pl, k, p.smooth);
    P.quantizeLuma(s, 4, 3);
    const a = p.color / 100;
    // Light, transparent wash over paper.
    for (const ch of s.c) for (let i = 0; i < ch.length; i++) ch[i] = 1 - (1 - ch[i]) * 0.75 * a;
    const pap = P.paper(w, h, "charcoal", k, 4);
    onPaper(s, pap, 1.5);
    const flow = formFlow(pl, k);
    const ink = inkLines(pl, flow, k, p.lines, 0.55, 0.3);
    const grain = P.stretch(P.lic(P.noisePlane(w, h, 3), flow, 5 * k));
    for (let i = 0; i < ink.length; i++) ink[i] *= 0.65 + 0.35 * grain[i];
    P.inkOver(s, ink, hexRGB(p.lineColor), 0.95);
    return done(s, src);
  },
};

const comicNoir: FilterDef = {
  id: "comicNoir",
  name: "Comic Noir",
  category: CC,
  description: "Stark black and white like a graphic novel: solid shadows, bold ink, an optional single accent color.",
  tags: ["sin city", "graphic novel", "black and white", "ink"],
  params: [pct("threshold", "Shadow Amount", 45), px("lines", "Ink Width", 0, 6, 1.8, 0.1), pct("accent", "Keep Reds", 0), color("paper", "Paper", "#f5f1e8")],
  pad: () => 50,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = abstraction(pl, k, 8);
    const l = P.lumaOf(P.dtSmooth(sm, 30 * k, 0.08, 2));
    const t = 0.15 + (p.threshold / 100) * 0.5;
    const ink = p.lines > 0 ? inkLines(pl, formFlow(pl, k), k, p.lines, 0.45, 0.7) : new Float32Array(w * h);
    const s = gray(new Float32Array(w * h).fill(1), w, h, hexRGB(p.paper));
    const [r, g, b] = s.c;
    const [sr, sg, sb] = sm.c;
    const acc = p.accent / 100;
    for (let i = 0; i < r.length; i++) {
      const black = Math.max(P.sstep(t + 0.008, t - 0.008, l[i]), ink[i]);
      // Optional accent: strongly red areas keep their color.
      const red = acc > 0 ? clamp((sr[i] - Math.max(sg[i], sb[i])) * 3 - 0.3, 0, 1) * acc : 0;
      r[i] = r[i] * (1 - black) * (1 - red) + red * Math.min(1, sr[i] * 1.2);
      g[i] = g[i] * (1 - black) * (1 - red) + red * sg[i] * 0.4;
      b[i] = b[i] * (1 - black) * (1 - red) + red * sb[i] * 0.4;
    }
    return done(s, src);
  },
};

// ------------------------------------------------------------------ painting

const oilPaint: FilterDef = {
  id: "oilPaint",
  name: "Oil Paint",
  category: ART,
  description: "Real brushwork: strokes that follow the forms, from broad to fine, with bristle streaks, raised paint and canvas weave.",
  tags: ["painting", "impasto", "canvas", "brush"],
  params: [px("brush", "Brush Size", 3, 60, 14, 0.5), pct("detail", "Detail", 55), pct("bristle", "Bristle Texture", 70), pct("impasto", "Impasto", 50), pct("canvas", "Canvas", 40), pct("variation", "Color Variation", 20), seed(3)],
  pad: (p) => p.brush * 6 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 5 * k, 0.3, 2);
    const flow = formFlow(pl, k, 5);
    const height = new Float32Array(w * h);
    const R = p.brush;
    const minR = Math.max(1, R * (0.5 - (p.detail / 100) * 0.38));
    const radii: number[] = [];
    for (let r = R; r > minR * 0.99; r /= 2) radii.push(r);
    if (radii[radii.length - 1] > minR * 1.4) radii.push(minR);
    const s = P.paintStrokes(base, { radii, length: 8, minLength: 2, colorStop: 0.1, threshold: 0.015, opacity: 0.95, bristle: p.bristle / 100, jitter: p.variation / 100, curve: 0.75, shape: "round", seed: p.seed, flow, height, blur: 0.6 });
    P.saturatePlanes(s, 1.1);
    const cv = P.paper(w, h, "canvas", k, 7);
    const hh = new Float32Array(w * h);
    for (let i = 0; i < hh.length; i++) hh[i] = height[i] * 1.2 * (p.impasto / 50) + cv[i] * 0.45 * (p.canvas / 100);
    relit(s, hh, 1.8, 0.18 * (p.impasto / 50));
    return done(s, src);
  }),
};

const impressionist: FilterDef = {
  id: "impressionist",
  name: "Impressionist",
  category: ART,
  description: "Short, broken strokes of varied color laid side by side, after Monet and Renoir.",
  tags: ["monet", "painting", "dabs", "broken color"],
  params: [px("dab", "Stroke Size", 2, 30, 10, 0.5), pct("broken", "Broken Color", 55), range("length", "Stroke Length", 1, 8, 4), pct("canvas", "Canvas", 35), seed(5)],
  pad: (p) => p.dab * 4 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["dab"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 8 * k, 0.4, 2);
    const flow = formFlow(pl, k, 6);
    const height = new Float32Array(w * h);
    const R = p.dab;
    const s = P.paintStrokes(base, { radii: [R, R * 0.6, R * 0.35], length: p.length, minLength: Math.min(2, p.length), colorStop: 0.18, threshold: 0, opacity: 0.95, bristle: 0.25, jitter: p.broken / 100, curve: 0.6, shape: "round", seed: p.seed, flow, height, spacing: 1.3, blur: 0.8 });
    P.saturatePlanes(s, 1.25);
    const cv = P.paper(w, h, "canvas", k, 7);
    const hh = new Float32Array(w * h);
    for (let i = 0; i < hh.length; i++) hh[i] = height[i] * 1.6 + cv[i] * 0.5 * (p.canvas / 100);
    relit(s, hh, 2.2, 0.1);
    return done(s, src);
  }),
};

const vanGogh: FilterDef = {
  id: "vanGogh",
  name: "Swirling Strokes",
  category: ART,
  description: "Thick, rhythmic strokes that swirl along every form, saturated color and heavy impasto, in the spirit of Van Gogh.",
  tags: ["van gogh", "starry night", "post-impressionism", "impasto"],
  params: [px("brush", "Stroke Width", 2, 20, 6, 0.5), range("length", "Stroke Length", 2, 20, 12), pct("swirl", "Swirl", 70), pct("impasto", "Impasto", 70), range("sat", "Saturation", 50, 200, 140, "%"), seed(9)],
  pad: (p) => p.brush * p.length * 2 + 30,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 10 * k, 0.35, 2);
    // Wide orientation spreading makes strokes curl into continuous swirls.
    const flow = P.flowField(P.dtSmooth(pl, 16 * k, 0.4, 2), (8 + (p.swirl / 100) * 26) * k);
    const height = new Float32Array(w * h);
    const R = p.brush;
    const s = P.paintStrokes(base, { radii: [R * 1.5, R], length: p.length, minLength: Math.ceil(p.length * 0.6), colorStop: 0.3, threshold: 0, opacity: 1, bristle: 0.55, jitter: 0.45, curve: 0.6 + (p.swirl / 100) * 0.38, shape: "round", seed: p.seed, flow, height, spacing: 1.7, blur: 1 });
    P.saturatePlanes(s, p.sat / 100);
    // Dark contours between strokes, as in thick wet paint.
    const ink = inkLines(pl, flow, k, 1.6, 0.35, 1);
    P.inkOver(s, ink, [30, 34, 60], 0.45);
    relit(s, height, 2.6 * (p.impasto / 70), 0.22);
    return done(s, src);
  }),
};

const watercolor: FilterDef = {
  id: "watercolor",
  name: "Watercolor",
  category: ART,
  description: "Transparent washes with darker pigment at their edges, wet blooms, paper granulation and a faint pencil underdrawing.",
  tags: ["wash", "aquarelle", "paint", "paper"],
  params: [range("smooth", "Simplify", 1, 10, 5), pct("edges", "Edge Darkening", 55), pct("granulation", "Granulation", 50), px("wobble", "Wobble", 0, 12, 3.5, 0.5), sel("paper", "Paper", PAPER_OPTS, "cold"), pct("pencil", "Pencil Underdrawing", 30), seed(5)],
  pad: (p) => 40 + p.smooth * 10 + p.wobble * 3,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    let a = P.dtSmooth(pl, (8 + p.smooth * 3) * k, 0.3 + p.smooth * 0.02, 3);
    a = P.dtSmooth(a, (5 + p.smooth * 1.5) * k, 0.22, 2);
    P.quantizeLuma(a, 16 - p.smooth, 1.2 + p.smooth * 0.12);
    P.saturatePlanes(a, 1.12);
    if (p.wobble > 0) {
      const nx = P.fbmPlane(w, h, 34 * k, 3, p.seed + 11), ny = P.fbmPlane(w, h, 34 * k, 3, p.seed + 12);
      const dx = new Float32Array(w * h), dy = new Float32Array(w * h);
      for (let i = 0; i < dx.length; i++) {
        dx[i] = (nx[i] - 0.5) * p.wobble * 2;
        dy[i] = (ny[i] - 0.5) * p.wobble * 2;
      }
      a = P.displace(a, dx, dy);
    }
    // Pigment density: darker rims where washes meet, turbulence, granulation in the paper's pits.
    const edges = P.edgeMap(a, 1.2 * k);
    const turb = P.fbmPlane(w, h, 70 * k, 4, p.seed + 21, 0.6);
    const pap = P.paper(w, h, p.paper, 1.2 * k, p.seed + 5);
    const lum = P.lumaOf(a);
    const dens = new Float32Array(w * h);
    const ek = (p.edges / 100) * 9 / Math.max(0.3, k), gk = (p.granulation / 100) * 0.9;
    for (let i = 0; i < dens.length; i++) dens[i] = 1 + clamp(edges[i] * ek, 0, 0.7) + (turb[i] - 0.5) * 0.45 + (pap[i] - 0.5) * gk * (0.35 + (1 - lum[i]));
    P.pigmentDensity(a, dens);
    // Transparent: lighter overall, paper white in the highlights.
    const [r, g, b] = a.c;
    for (let i = 0; i < r.length; i++) {
      const l = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
      const lift = P.sstep(0.78, 0.95, l) * 0.85;
      r[i] = 1 - (1 - (r[i] + (1 - r[i]) * lift)) * 0.92;
      g[i] = 1 - (1 - (g[i] + (1 - g[i]) * lift)) * 0.92;
      b[i] = 1 - (1 - (b[i] + (1 - b[i]) * lift)) * 0.92;
    }
    onPaper(a, pap, 2.2, [253, 251, 246]);
    if (p.pencil > 0) P.inkOver(a, inkLines(pl, formFlow(pl, k), k, 0.9, 0.45, 0.7), [80, 72, 68], (p.pencil / 100) * 0.7);
    return done(a, src);
  },
};

const dryBrush: FilterDef = {
  id: "dryBrush",
  name: "Dry Brush",
  category: ART,
  description: "A fairly dry brush dragged over textured paper: simplified tones, scratchy broken strokes with paper showing through.",
  tags: ["painting", "streaks", "scratchy"],
  params: [px("brush", "Brush Size", 2, 30, 8, 0.5), pct("dryness", "Dryness", 65), pct("detail", "Detail", 50), seed(4)],
  pad: (p) => p.brush * 6 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 10 * k, 0.3, 2);
    P.quantizeLuma(base, 6 + Math.round(p.detail / 12), 6);
    const flow = formFlow(pl, k, 6);
    const R = p.brush;
    const minR = Math.max(1.2, R * (0.45 - p.detail / 300));
    const s = P.paintStrokes(base, { radii: [R, minR], length: 10, minLength: 4, colorStop: 0.14, threshold: 0, opacity: 0.95, bristle: 0.5 + (p.dryness / 100) * 0.5, jitter: 0.05, curve: 0.85, shape: "round", seed: p.seed, flow, spacing: 1.35, ground: [244, 238, 226] });
    P.saturatePlanes(s, 1.15);
    onPaper(s, P.paper(w, h, "rough", k, p.seed + 3), 2.4);
    return done(s, src);
  }),
};

const paletteKnife: FilterDef = {
  id: "paletteKnife",
  name: "Palette Knife",
  category: ART,
  description: "Paint scraped on with a knife: broad flat planes of color with crisp edges and thick ridges.",
  tags: ["knife", "impasto", "painting"],
  params: [px("knife", "Knife Size", 3, 40, 12, 0.5), pct("detail", "Detail", 45), pct("impasto", "Ridges", 60), seed(6)],
  pad: (p) => p.knife * 5 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["knife"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = abstraction(pl, k, 4);
    const flow = formFlow(pl, k, 8);
    const height = new Float32Array(w * h);
    const R = p.knife;
    const minR = Math.max(1.5, R * (0.45 - p.detail / 300));
    const s = P.paintStrokes(base, { radii: [R, (R + minR) / 2, minR], length: 3, minLength: 1, colorStop: 0.12, threshold: 0.01, opacity: 1, bristle: 0.08, jitter: 0.08, curve: 0.3, shape: "flat", seed: p.seed, flow, height, blur: 0.7 });
    P.saturatePlanes(s, 1.12);
    relit(s, height, 1.6 * (p.impasto / 60), 0.06);
    return done(s, src);
  }),
};

const paintDaubs: FilterDef = {
  id: "paintDaubs",
  name: "Paint Daubs",
  category: ART,
  description: "Round dabs of paint of a few sizes, with a gentle sharpen so edges stay readable.",
  tags: ["dabs", "painting", "blobs"],
  params: [px("brush", "Brush Size", 2, 30, 9, 0.5), pct("sharpness", "Sharpness", 25), pct("variation", "Color Variation", 25), seed(2)],
  pad: (p) => p.brush * 3 + 10,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 6 * k, 0.3, 2);
    const height = new Float32Array(w * h);
    const R = p.brush;
    const s = P.paintStrokes(base, { radii: [R, R * 0.6, R * 0.38], length: 1, colorStop: 1, threshold: 0, opacity: 1, bristle: 0.3, jitter: p.variation / 100, curve: 1, shape: "dab", seed: p.seed, height, spacing: 1.1, blur: 0.8, flow: formFlow(pl, k) });
    relit(s, height, 1.6, 0.05);
    if (p.sharpness > 0) {
      const a = p.sharpness / 100;
      for (const ch of s.c) {
        const b = gauss1(ch, w, h, 1.5 * k);
        for (let i = 0; i < ch.length; i++) ch[i] += (ch[i] - b[i]) * a * 1.5;
      }
    }
    return done(s, src);
  }),
};

const smudgeStick: FilterDef = {
  id: "smudgeStick",
  name: "Smudge Stick",
  category: ART,
  description: "Colors smeared along the forms with a soft stick: streaky, with deeper shadows and brighter highlights.",
  tags: ["smear", "blend", "pastel"],
  params: [px("length", "Stroke Length", 2, 40, 12, 0.5), pct("highlight", "Highlight Area", 30), pct("intensity", "Intensity", 50)],
  pad: (p) => p.length * 2 + 20,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const flow = formFlow(pl, k, 6);
    const sm = P.dtSmooth(pl, 4 * k, 0.3, 2);
    const s: Pl = { w, h, c: sm.c.map((ch) => P.lic(ch, flow, p.length)) as Pl["c"] };
    const streak = P.stretch(P.lic(P.noisePlane(w, h, 1), flow, p.length));
    const l = P.lumaOf(s);
    const a = p.intensity / 100, hl = p.highlight / 100;
    for (const ch of s.c)
      for (let i = 0; i < ch.length; i++) {
        let v = ch[i] * (1 + (streak[i] - 0.5) * 0.25 * a);
        v = v - (1 - l[i]) * v * 0.35 * a + P.sstep(1 - hl * 0.6, 1, l[i]) * 0.3;
        ch[i] = v;
      }
    return done(s, src);
  },
};

const sponge: FilterDef = {
  id: "sponge",
  name: "Sponge",
  category: ART,
  description: "Color dabbed on with a natural sponge: soft-edged color areas with a porous, mottled texture.",
  tags: ["texture", "mottled", "dab"],
  params: [px("size", "Sponge Size", 2, 60, 18, 0.5), pct("definition", "Definition", 55), range("smooth", "Smoothness", 1, 10, 5), seed(7)],
  pad: (p) => p.size * 3 + 30,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const s = abstraction(pl, k, p.smooth);
    // Sponge prints: a lighter and a darker version of each color, mixed by a porous pattern.
    const a = P.fbmPlane(w, h, p.size * 0.8, 3, p.seed, 0.55), b = P.fbmPlane(w, h, p.size * 0.3, 2, p.seed + 9, 0.5);
    const def = p.definition / 100;
    const lo = 0.5 - 0.06 * def, hi = 0.5 + 0.06 * (1 - def) + 0.02;
    for (const ch of s.c)
      for (let i = 0; i < ch.length; i++) {
        const t = P.sstep(lo, hi, a[i] * 0.7 + b[i] * 0.3);
        const light = ch[i] + (1 - ch[i]) * 0.08, dark = ch[i] * 0.84;
        ch[i] = light + (dark - light) * t;
      }
    return done(s, src);
  },
};

const roughPastels: FilterDef = {
  id: "roughPastels",
  name: "Rough Pastels",
  category: ART,
  description: "Chalky pastel strokes on toothy paper: the color catches on the grain and the paper shows through in the valleys.",
  tags: ["pastel", "chalk", "texture"],
  params: [px("stroke", "Stroke Size", 2, 20, 6, 0.5), pct("detail", "Detail", 50), pct("texture", "Paper Texture", 40), color("paper", "Paper", "#ece4d2"), seed(8)],
  pad: (p) => p.stroke * 8 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["stroke"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 6 * k, 0.3, 2);
    const flow = formFlow(pl, k, 5);
    const R = p.stroke;
    const paperC = hexRGB(p.paper);
    const s = P.paintStrokes(base, { radii: [R * 1.6, R, R * (0.7 - p.detail / 250)], length: 6, minLength: 3, colorStop: 0.2, threshold: 0, opacity: 0.92, bristle: 0.45, jitter: 0.15, curve: 0.6, shape: "round", seed: p.seed, flow, spacing: 1.1, ground: paperC });
    const pap = P.paper(w, h, "charcoal", 1.6 * k, p.seed + 1);
    const t = p.texture / 100;
    const pc = paperC.map((v) => v / 255);
    s.c.forEach((ch, c) => {
      for (let i = 0; i < ch.length; i++) {
        // Pigment sits on the peaks of the paper.
        const catchK = P.sstep(0.2 * t, 0.2 * t + 0.45, pap[i]);
        ch[i] = pc[c] + (ch[i] - pc[c]) * (1 - t + t * catchK);
      }
    });
    onPaper(s, pap, 1.5, [255, 255, 255]);
    return done(s, src);
  }),
};

const coloredPencil: FilterDef = {
  id: "coloredPencil",
  name: "Colored Pencil",
  category: ART,
  description: "Colored pencil hatching on white paper, with darker hatching and cross-hatching where the image is darker.",
  tags: ["pencil", "drawing", "hatching", "crayon"],
  params: [px("spacing", "Stroke Spacing", 2, 10, 3.2, 0.2), pct("pressure", "Pressure", 60), pct("outline", "Outline", 50), pct("paper", "Paper Brightness", 90), range("angle", "Angle", -90, 90, 55, "°")],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = P.dtSmooth(pl, 6 * k, 0.2, 2);
    const lum = P.lumaOf(sm);
    const dark = drawTone(lum, p.pressure / 100);
    const pap = P.paper(w, h, "charcoal", 0.8 * k, 3);
    const hatch = hatchTone(dark, w, h, 1, p.spacing, p.angle, 9, 2, pap);
    const ink = p.outline > 0 ? inkLines(pl, formFlow(pl, k), k, 1, 0.45, 0.7) : null;
    const pb = 0.82 + (p.paper / 100) * 0.18;
    const out: Pl = { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
    const sat = P.clonePlanes(sm);
    P.saturatePlanes(sat, 1.35);
    for (let c = 0; c < 3; c++) {
      const o = out.c[c], col = sat.c[c];
      for (let i = 0; i < o.length; i++) {
        // Pigment of the area's color laid in hatch strokes over paper.
        const cov = clamp(hatch[i] * 1.35, 0, 1);
        const pig = clamp(col[i] * 0.9 - 0.05, 0, 1);
        o[i] = pb + (pig - pb) * cov;
        if (ink) o[i] -= ink[i] * (p.outline / 100) * 0.55;
      }
    }
    return done(out, src);
  },
};

const fresco: FilterDef = {
  id: "fresco",
  name: "Fresco",
  category: ART,
  description: "Earthy, slightly faded pigment in short strokes on rough plaster, with dark contours.",
  tags: ["mural", "plaster", "earthy"],
  params: [px("brush", "Brush Size", 2, 20, 6, 0.5), pct("detail", "Detail", 40), pct("texture", "Plaster", 60), seed(10)],
  pad: (p) => p.brush * 5 + 30,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = abstraction(pl, k, 4);
    const flow = formFlow(pl, k, 6);
    const R = p.brush;
    const s = P.paintStrokes(base, { radii: [R, R * 0.55], length: 4, minLength: 2, colorStop: 0.15, threshold: 0.01, opacity: 0.9, bristle: 0.4, jitter: 0.12, curve: 0.6, shape: "round", seed: p.seed, flow, blur: 0.7 });
    P.saturatePlanes(s, 0.75);
    const [r, g, b] = s.c;
    for (let i = 0; i < r.length; i++) {
      // Earth palette: warm, slightly faded.
      r[i] = r[i] * 0.88 + 0.08;
      g[i] = g[i] * 0.84 + 0.06;
      b[i] = b[i] * 0.72 + 0.04;
    }
    P.inkOver(s, inkLines(pl, flow, k, 1.6, p.detail / 100, 0.5), [60, 38, 28], 0.75);
    const plaster = P.paper(w, h, "rough", 1.6 * k, p.seed + 4);
    const t = p.texture / 100;
    for (const ch of s.c) for (let i = 0; i < ch.length; i++) ch[i] *= 1 - t * 0.18 * (1 - plaster[i]);
    onPaper(s, plaster, 3 * t, [250, 244, 232]);
    return done(s, src);
  }),
};

const plasticWrap: FilterDef = {
  id: "plasticWrap",
  name: "Plastic Wrap",
  category: ART,
  description: "The image as if shrink-wrapped in shiny plastic: glossy highlights follow its contours.",
  tags: ["gloss", "shiny", "specular"],
  params: [pct("highlight", "Highlight Strength", 60), range("detail", "Detail", 1, 20, 8), range("smooth", "Smoothness", 1, 15, 7)],
  pad: (p) => p.smooth * 6 + 20,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const l = gauss1(P.lumaOf(pl), w, h, (p.smooth * 0.9 + 1.5) * k);
    // Glossy film: Blinn-Phong highlights on the image's brightness as a height field.
    const amp = (p.detail * 6) / Math.max(0.3, k);
    const lx = -0.45, ly = -0.55, lz = 0.7;
    const hx0 = lx, hy0 = ly, hz0 = lz + 1;
    const hl = Math.hypot(hx0, hy0, hz0);
    const s = P.clonePlanes(pl);
    const a = p.highlight / 100;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = (l[y * w + Math.min(w - 1, x + 1)] - l[y * w + Math.max(0, x - 1)]) * amp;
        const gy = (l[Math.min(h - 1, y + 1) * w + x] - l[Math.max(0, y - 1) * w + x]) * amp;
        const nl = Math.hypot(gx, gy, 1);
        const nx = -gx / nl, ny = -gy / nl, nz = 1 / nl;
        const spec = Math.pow(Math.max(0, (nx * hx0 + ny * hy0 + nz * hz0) / hl), 60);
        const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
        for (const ch of s.c) ch[i] = ch[i] * (0.82 + 0.25 * diff) + spec * a * 0.9;
      }
    return done(s, src);
  },
};

const underpainting: FilterDef = {
  id: "underpainting",
  name: "Underpainting",
  category: ART,
  description: "The first loose layer of a painting: broad, muted strokes of the main colors on visible canvas.",
  tags: ["sketch", "canvas", "loose", "painting"],
  params: [px("brush", "Brush Size", 4, 60, 14, 0.5), pct("coverage", "Coverage", 75), pct("canvas", "Canvas", 55), seed(11)],
  pad: (p) => p.brush * 5 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = P.dtSmooth(pl, 16 * k, 0.45, 2);
    P.saturatePlanes(base, 0.8);
    const R = p.brush;
    const s = P.paintStrokes(base, { radii: [R, R * 0.6], length: 6, minLength: 3, colorStop: 0.2, threshold: 0, opacity: 0.55 + (p.coverage / 100) * 0.4, bristle: 0.75, jitter: 0.1, curve: 0.7, shape: "round", seed: p.seed, flow: formFlow(pl, k, 8), spacing: 1.4 - (p.coverage / 100) * 0.5, ground: [222, 210, 186], blur: 1 });
    onPaper(s, P.paper(w, h, "canvas", k, 7), 3 * (p.canvas / 100), [255, 255, 255]);
    return done(s, src);
  }),
};

const posterEdges: FilterDef = {
  id: "posterEdges",
  name: "Poster Edges",
  category: ART,
  description: "Fewer colors with fine black lines along the edges, like a screen-printed poster.",
  tags: ["poster", "posterize", "edges", "print"],
  params: [px("thickness", "Edge Thickness", 0.4, 5, 1.2, 0.1), pct("intensity", "Edge Intensity", 70), range("levels", "Posterization", 2, 10, 5)],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const s = abstraction(pl, k, 3);
    P.quantizeLuma(s, p.levels + 1, 12);
    for (const ch of s.c) for (let i = 0; i < ch.length; i++) ch[i] = (Math.round(ch[i] * (p.levels + 1)) / (p.levels + 1)) * 0.5 + ch[i] * 0.5;
    P.saturatePlanes(s, 1.15);
    P.inkOver(s, inkLines(pl, formFlow(pl, k), k, p.thickness, 0.6, 0.4), [10, 10, 10], p.intensity / 100);
    return done(s, src);
  },
};

const neonGlowArt: FilterDef = {
  id: "neonGlowArt",
  name: "Neon Glow",
  category: ART,
  description: "The image in deep shadow tones with its bright parts and edges lit by a soft neon glow.",
  tags: ["neon", "glow", "dark", "night"],
  params: [px("size", "Glow Size", 1, 40, 8, 0.5), pct("brightness", "Glow Brightness", 70), color("glow", "Glow Color", "#38d8ff"), color("dark", "Shadow Color", "#120a2a")],
  pad: (p) => p.size * 3 + 20,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const flow = formFlow(pl, k);
    const ink = inkLines(pl, flow, k, 1.1, 0.5, 0.6);
    const l = P.lumaOf(P.dtSmooth(pl, 6 * k, 0.25, 2));
    const src2 = new Float32Array(w * h);
    for (let i = 0; i < src2.length; i++) src2[i] = Math.max(ink[i], P.sstep(0.55, 0.95, l[i]) * 0.8);
    const halo = gauss1(src2, w, h, p.size);
    const g = hexRGB(p.glow).map((v) => v / 255), d = hexRGB(p.dark).map((v) => v / 255);
    const a = (p.brightness / 100) * 2;
    const s: Pl = { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < w * h; i++) {
        const base = d[c] + (pl.c[c][i] * 0.35 - d[c]) * l[i] * 0.6;
        const light = clamp(halo[i] * a + src2[i] * 0.9, 0, 1.5);
        s.c[c][i] = base + g[c] * light + Math.max(0, light - 1) * 0.6;
      }
    return done(s, src);
  },
};

const gouache: FilterDef = {
  id: "gouache",
  name: "Gouache",
  category: ART,
  description: "Opaque, matte paint in flat strokes with clean edges and bright, chalky color.",
  tags: ["opaque", "matte", "poster paint", "illustration"],
  params: [px("brush", "Brush Size", 2, 30, 7, 0.5), range("smooth", "Simplify", 1, 10, 5), pct("chalk", "Chalkiness", 40), seed(12)],
  pad: (p) => p.brush * 5 + p.smooth * 10 + 20,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["brush"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const base = abstraction(pl, k, p.smooth);
    P.quantizeLuma(base, 9, 6);
    const R = p.brush;
    const s = P.paintStrokes(base, { radii: [R, R * 0.55, R * 0.3], length: 5, minLength: 2, colorStop: 0.12, threshold: 0.01, opacity: 1, bristle: 0.2, jitter: 0.06, curve: 0.7, shape: "round", seed: p.seed, flow: formFlow(pl, k, 6), blur: 0.5 });
    P.saturatePlanes(s, 1.2);
    const ch = p.chalk / 100;
    for (const c of s.c) for (let i = 0; i < c.length; i++) c[i] = c[i] * (1 - ch * 0.18) + ch * 0.12;
    onPaper(s, P.paper(w, h, "hot", k, p.seed), 1.2, [255, 253, 248]);
    return done(s, src);
  }),
};

const pastelWash: FilterDef = {
  id: "pastelWash",
  name: "Pastel Wash",
  category: ART,
  description: "Soft, airy washes of pale color with gentle edges, like a light watercolor sketch.",
  tags: ["soft", "pale", "watercolor", "dreamy"],
  params: [range("smooth", "Simplify", 1, 10, 6), pct("lightness", "Lightness", 55), pct("lines", "Pencil", 25), seed(13)],
  pad: (p) => 40 + p.smooth * 10,
  run(src, p, env) {
    // A light watercolor, then lifted toward white.
    const out = watercolor.run(src, { smooth: p.smooth, edges: 30, granulation: 35, wobble: 3, paper: "hot", pencil: p.lines, seed: p.seed }, env);
    const a = (p.lightness / 100) * 0.55;
    const d = out.data;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (255 - d[i + c]) * a;
    return out;
  },
};

// ------------------------------------------------------------------ drawing

const pencilSketch: FilterDef = {
  id: "pencilSketch",
  name: "Pencil Sketch",
  category: SK,
  description: "A graphite drawing: outlines that follow the forms and hand-hatched shading, cross-hatched in the darks, on drawing paper.",
  tags: ["graphite", "drawing", "hatching", "sketch"],
  params: [pct("darkness", "Darkness", 55), px("spacing", "Hatch Spacing", 2, 10, 3, 0.2), pct("outline", "Outlines", 70), range("angle", "Hatch Angle", -90, 90, 55, "°"), pct("paper", "Paper Texture", 40), check("smooth", "Smooth Shading", false)],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = P.dtSmooth(pl, 6 * k, 0.2, 2);
    const dark = drawTone(P.lumaOf(sm), p.darkness / 100);
    const pap = P.paper(w, h, "charcoal", 0.8 * k, 3);
    let tone: Float32Array;
    if (p.smooth) {
      // Blended graphite: soft tone streaked along the forms.
      const streak = P.stretch(P.lic(P.noisePlane(w, h, 5), formFlow(pl, k), 6 * k));
      tone = new Float32Array(w * h);
      for (let i = 0; i < tone.length; i++) tone[i] = Math.pow(dark[i], 1.3) * (0.8 + 0.2 * streak[i]) * (0.8 + 0.2 * pap[i]);
    } else tone = hatchTone(dark, w, h, 1, p.spacing, p.angle, 9, 3, pap);
    const ink = p.outline > 0 ? inkLines(pl, formFlow(pl, k), k, 1, 0.5, 0.7) : null;
    const v = new Float32Array(w * h);
    const pt = p.paper / 100;
    for (let i = 0; i < v.length; i++) {
      let g = Math.max(tone[i] * 0.85, ink ? Math.min(1, ink[i] * 1.2 * (p.outline / 100)) * 0.92 : 0);
      g *= 1 - pt * 0.35 * (1 - pap[i]);
      v[i] = 1 - g;
    }
    return done(gray(v, w, h, [252, 250, 245]), src);
  },
};

const charcoal: FilterDef = {
  id: "charcoal",
  name: "Charcoal",
  category: SK,
  description: "Soft charcoal on laid paper: smudged tones that follow the forms, grainy where the charcoal skips over the paper, with bold dark lines.",
  tags: ["drawing", "smudge", "black", "grain"],
  params: [px("thickness", "Line Thickness", 0.5, 6, 1.6, 0.1), pct("detail", "Detail", 45), pct("balance", "Light/Dark Balance", 50), pct("grain", "Grain", 60)],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = P.dtSmooth(pl, 10 * k, 0.25, 2);
    const flow = formFlow(pl, k, 6);
    const smear = P.lic(P.lumaOf(sm), flow, 6 * k);
    const pap = P.paper(w, h, "charcoal", 1.3 * k, 4);
    const streak = P.stretch(P.lic(P.noisePlane(w, h, 4), flow, 7 * k));
    const ink = inkLines(pl, flow, k, p.thickness, p.detail / 100, 0.6);
    const bias = (p.balance / 100 - 0.5) * 0.5, gr = p.grain / 100;
    const v = new Float32Array(w * h);
    for (let i = 0; i < v.length; i++) {
      const tone = clamp((smear[i] - 0.12 - bias) * 1.35, 0, 1);
      let dark = Math.pow(1 - tone, 1.1);
      const grain = pap[i] * 0.6 + streak[i] * 0.4;
      dark = clamp(dark * 1.25 - (1 - grain) * 0.55 * gr * (1 - dark), 0, 1);
      dark = Math.max(dark, ink[i] * 0.9);
      v[i] = 1 - dark * 0.92;
    }
    return done(gray(v, w, h, [250, 246, 238]), src);
  },
};

const chalkCharcoal: FilterDef = {
  id: "chalkCharcoal",
  name: "Chalk & Charcoal",
  category: SK,
  description: "Charcoal for the shadows and white chalk for the lights on mid-tone paper.",
  tags: ["chalk", "charcoal", "toned paper"],
  params: [pct("charcoal", "Charcoal", 60), pct("chalk", "Chalk", 60), color("paper", "Paper", "#9a9488"), pct("grain", "Grain", 55)],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = P.dtSmooth(pl, 10 * k, 0.25, 2);
    const flow = formFlow(pl, k, 6);
    const l = P.lic(P.lumaOf(sm), flow, 6 * k);
    const pap = P.paper(w, h, "pastel", 1.2 * k, 6);
    const streak = P.stretch(P.lic(P.noisePlane(w, h, 6), flow, 8 * k));
    const ink = inkLines(pl, flow, k, 1.4, 0.4, 0.6);
    const pc = hexRGB(p.paper).map((v) => v / 255);
    const s: Pl = { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
    const ca = p.charcoal / 100, wa = p.chalk / 100, gr = p.grain / 100;
    for (let i = 0; i < w * h; i++) {
      const tex = 1 - gr + gr * (pap[i] * 0.6 + streak[i] * 0.4);
      const dark = clamp(Math.max(P.sstep(0.55, 0.12, l[i]) * ca * 1.3 * tex, ink[i] * 0.9), 0, 1);
      const light = clamp(P.sstep(0.55, 0.9, l[i]) * wa * 1.3 * tex, 0, 1);
      for (let c = 0; c < 3; c++) s.c[c][i] = (pc[c] + (0.97 - pc[c]) * light) * (1 - dark * 0.9);
    }
    return done(s, src);
  },
};

const graphicPen: FilterDef = {
  id: "graphicPen",
  name: "Graphic Pen",
  category: SK,
  description: "Fine ink strokes all in one direction, denser in the darks, like a technical pen illustration.",
  tags: ["ink", "strokes", "pen", "engraving"],
  params: [px("length", "Stroke Length", 2, 40, 14, 0.5), px("spacing", "Spacing", 1.5, 10, 3, 0.1), pct("balance", "Light/Dark Balance", 50), range("angle", "Direction", -90, 90, -45, "°"), color("ink", "Ink", "#121214")],
  pad: () => 30,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const dark = darkness(P.lumaOf(P.dtSmooth(pl, 5 * k, 0.2, 2)), 0.5, (p.balance / 100 - 0.5) * 0.6);
    const hp = P.hatchPlane(w, h, p.angle, p.spacing, p.length, 3);
    const ink = new Float32Array(w * h);
    for (let i = 0; i < ink.length; i++) ink[i] = P.sstep(0.95 - dark[i] * 0.9, 1.05 - dark[i] * 0.9, hp[i] + dark[i] * 0.55);
    const s = gray(new Float32Array(w * h).fill(1), w, h, [250, 249, 245]);
    P.inkOver(s, ink, hexRGB(p.ink), 1);
    return done(s, src);
  },
};

const conteCrayon: FilterDef = {
  id: "conteCrayon",
  name: "Conté Crayon",
  category: SK,
  description: "Sanguine and white Conté crayon on toned paper: warm strokes for the darks, chalky white for the lights.",
  tags: ["sanguine", "crayon", "toned paper", "drawing"],
  params: [color("dark", "Crayon", "#7a2e1c"), color("paper", "Paper", "#cdb79a"), pct("light", "White Chalk", 55), px("spacing", "Stroke Spacing", 2, 10, 3.5, 0.2), pct("texture", "Texture", 55)],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const l = P.lumaOf(P.dtSmooth(pl, 6 * k, 0.2, 2));
    const pap = P.paper(w, h, "pastel", k, 2);
    const dark = drawTone(l, 0.3);
    const hd = hatchTone(dark, w, h, 1, p.spacing, 50, 4, 2, pap);
    const lightT = new Float32Array(w * h);
    for (let i = 0; i < lightT.length; i++) lightT[i] = clamp((l[i] - 0.62) * 2.6, 0, 1);
    const hl = hatchTone(lightT, w, h, 1, p.spacing * 1.2, -40, 5, 1, pap);
    const ink = inkLines(pl, formFlow(pl, k), k, 1.1, 0.45, 0.7);
    const dc = hexRGB(p.dark).map((v) => v / 255), pc = hexRGB(p.paper).map((v) => v / 255);
    const t = p.texture / 100, wa = p.light / 100;
    const s: Pl = { w, h, c: [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)] };
    for (let i = 0; i < w * h; i++) {
      const tex = 1 - t + t * pap[i];
      const a = clamp(Math.max(hd[i] * 1.1, ink[i] * 0.8) * tex, 0, 1);
      const wch = clamp(hl[i] * wa * 1.4 * tex, 0, 1);
      for (let c = 0; c < 3; c++) s.c[c][i] = (pc[c] + (0.98 - pc[c]) * wch) * (1 - a) + dc[c] * a;
    }
    return done(s, src);
  },
};

const crosshatch: FilterDef = {
  id: "crosshatch",
  name: "Crosshatch",
  category: SK,
  description: "Pen crosshatching: up to three layers of parallel ink lines build the tones, with outlines on top.",
  tags: ["hatching", "ink", "pen", "etching"],
  params: [px("spacing", "Line Spacing", 2, 14, 4, 0.2), range("angle", "Angle", -90, 90, 45, "°"), pct("density", "Density", 55), pct("outline", "Outlines", 60), color("ink", "Ink", "#18161c")],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const dark = darkness(P.lumaOf(P.dtSmooth(pl, 8 * k, 0.2, 2)), 0.45, -0.25 + (p.density / 100) * 0.45);
    const t = hatchTone(dark, w, h, 1, p.spacing, p.angle, 2, 3);
    const ink = new Float32Array(w * h);
    const lines = p.outline > 0 ? inkLines(pl, formFlow(pl, k), k, 1.1, 0.45, 0.7) : null;
    for (let i = 0; i < ink.length; i++) ink[i] = Math.max(P.sstep(0.3, 0.6, t[i]), lines ? lines[i] * (p.outline / 100) : 0);
    const s = gray(new Float32Array(w * h).fill(1), w, h, [251, 249, 243]);
    P.inkOver(s, ink, hexRGB(p.ink), 1);
    return done(s, src);
  },
};

const waterPaper: FilterDef = {
  id: "waterPaper",
  name: "Water Paper",
  category: SK,
  description: "Color soaked into fibrous wet paper: blotchy, feathered color that bleeds along the fibers.",
  tags: ["fiber", "bleed", "wet", "paper"],
  params: [px("fiber", "Fiber Length", 2, 40, 12, 0.5), pct("brightness", "Brightness", 60), pct("contrast", "Contrast", 60), seed(14)],
  pad: (p) => p.fiber * 2 + 20,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    // Fibers: a random orientation field; color bleeds along it.
    const fib = P.fbmPlane(w, h, 18 * k, 3, p.seed);
    const tx = new Float32Array(w * h), ty = new Float32Array(w * h);
    for (let i = 0; i < fib.length; i++) {
      const a = fib[i] * Math.PI * 4;
      tx[i] = Math.cos(a);
      ty[i] = Math.sin(a);
    }
    const flow: P.Flow = { w, h, tx, ty, coh: new Float32Array(w * h).fill(1), mag: new Float32Array(w * h) };
    const s: Pl = { w, h, c: pl.c.map((ch) => P.lic(ch, flow, p.fiber)) as Pl["c"] };
    const pap = P.paper(w, h, "rough", 1.4 * k, p.seed + 2);
    const br = (p.brightness / 100 - 0.5) * 0.4, ct = 0.6 + (p.contrast / 100) * 0.9;
    for (const ch of s.c) for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] - 0.5) * ct + 0.5 + br + (pap[i] - 0.5) * 0.08;
    onPaper(s, pap, 2, [255, 253, 248]);
    return done(s, src);
  },
};

// ------------------------------------------------------------------ new styles

const engraving: FilterDef = {
  id: "engraving",
  name: "Engraving",
  category: SK,
  description: "A banknote-style line engraving: parallel lines that curve with the forms and swell to make the darks.",
  tags: ["etching", "banknote", "woodcut", "lines"],
  params: [px("spacing", "Line Spacing", 2, 14, 4, 0.2), pct("contrast", "Contrast", 55), pct("curve", "Follow Forms", 60), color("ink", "Ink", "#1b1a2a"), color("paper", "Paper", "#f4efe2")],
  pad: () => 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const l = P.lumaOf(P.dtSmooth(pl, 6 * k, 0.2, 2));
    const dark = darkness(l, p.contrast / 100, 0.05);
    // A "phase" field: smooth noise bent by the image tone gives lines that wrap around forms.
    const base = gauss1(l, w, h, 40 * k);
    const sp = Math.max(1.5, p.spacing);
    const cv = p.curve / 100;
    const ink = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const phase = (y + x * 0.08 + base[i] * cv * 10 * k) / sp;
        const f = phase - Math.floor(phase);
        // Line width follows darkness (thin in lights, merging in the darks).
        const width = dark[i] * 0.95;
        const d = Math.abs(f - 0.5) * 2;
        ink[i] = P.sstep(width + 0.08, width - 0.08, 1 - d);
      }
    const s = gray(new Float32Array(w * h).fill(1), w, h, hexRGB(p.paper));
    P.inkOver(s, ink, hexRGB(p.ink), 1);
    return done(s, src);
  },
};

const sumiE: FilterDef = {
  id: "sumiE",
  name: "Ink Wash (Sumi-e)",
  category: ART,
  description: "East Asian ink painting: bold, tapering brush lines and soft gray washes on rice paper, with lots of empty space.",
  tags: ["ink wash", "japanese", "chinese", "brush", "minimal"],
  params: [px("brush", "Brush Width", 0.5, 6, 2.2, 0.1), pct("wash", "Wash", 50), pct("empty", "Empty Space", 45), seed(15)],
  pad: () => 50,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const sm = abstraction(pl, k, 7);
    const flow = formFlow(pl, k, 6);
    const ink = inkLines(pl, flow, k, p.brush, 0.35, 0.9);
    const streak = P.stretch(P.lic(P.noisePlane(w, h, p.seed), flow, 10 * k));
    const l = P.lumaOf(sm);
    const turb = P.fbmPlane(w, h, 50 * k, 3, p.seed + 1);
    const pap = P.paper(w, h, "hot", 1.2 * k, p.seed + 2);
    const em = 0.35 + (p.empty / 100) * 0.4, wa = p.wash / 100;
    const v = new Float32Array(w * h);
    for (let i = 0; i < v.length; i++) {
      let wash = P.sstep(em, em - 0.35, l[i]) * wa * (0.75 + 0.5 * (turb[i] - 0.5));
      wash = Math.round(wash * 4) / 4 * 0.7 + wash * 0.3;
      const line = ink[i] * (0.7 + 0.3 * streak[i]);
      v[i] = 1 - clamp(Math.max(line, wash * 0.75), 0, 1) * (0.92 + 0.08 * pap[i]);
    }
    const s = gray(v, w, h, [246, 240, 226]);
    onPaper(s, pap, 1.4, [255, 255, 255]);
    return done(s, src);
  },
};

const marker: FilterDef = {
  id: "markerDrawing",
  name: "Marker Drawing",
  category: CC,
  description: "Felt-tip markers: bold outlines, flat color in streaky parallel marker passes with darker overlaps.",
  tags: ["copic", "illustration", "felt tip", "design sketch"],
  params: [px("width", "Marker Width", 4, 40, 12, 0.5), range("angle", "Stroke Angle", -90, 90, 30, "°"), px("lines", "Outline", 0, 5, 1.5, 0.1), range("smooth", "Simplify", 1, 10, 6)],
  pad: (p) => p.width * 2 + 40,
  run(src, p, env) {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const { w, h } = pl;
    const s = abstraction(pl, k, p.smooth);
    P.quantizeLuma(s, 5, 8);
    P.saturatePlanes(s, 1.25);
    // Marker passes: bands across the stroke direction, a little darker where passes overlap.
    const bands = P.hatchPlane(w, h, p.angle, p.width, p.width * 6, 4);
    const [r, g, b] = s.c;
    for (let i = 0; i < r.length; i++) {
      const m = 1 - 0.1 * clamp(bands[i] * 1.5, 0, 1);
      // Markers are transparent: lights stay light, darks deepen.
      r[i] = 1 - (1 - r[i]) * 1.05 * m - 0.02;
      g[i] = 1 - (1 - g[i]) * 1.05 * m - 0.02;
      b[i] = 1 - (1 - b[i]) * 1.05 * m - 0.02;
      r[i] *= m;
      g[i] *= m;
      b[i] *= m;
    }
    if (p.lines > 0) P.inkOver(s, inkLines(pl, formFlow(pl, k), k, p.lines, 0.45, 0.8), [20, 20, 26], 1);
    return done(s, src);
  },
};

const pointillism: FilterDef = {
  id: "pointillism",
  name: "Pointillism",
  category: ART,
  description: "Seurat's technique: the image built from small dots of pure, varied color on a light ground.",
  tags: ["seurat", "dots", "neo-impressionism"],
  params: [px("dot", "Dot Size", 1.5, 16, 5, 0.5), pct("purity", "Color Purity", 60), pct("density", "Density", 65), seed(16)],
  pad: (p) => p.dot * 3,
  run: (src0, p0, env0) => capped(src0, p0, env0, ["dot"], (src, p, env) => {
    const k = kOf(env);
    const pl = P.toPlanes(src);
    const base = P.dtSmooth(pl, 4 * k, 0.3, 2);
    P.saturatePlanes(base, 1 + (p.purity / 100) * 0.8);
    const R = p.dot;
    return done(P.paintStrokes(base, { radii: [R, R * 0.75], length: 1, colorStop: 1, threshold: 0, opacity: 1, bristle: 0, jitter: 0.25 + (p.purity / 100) * 0.5, curve: 1, shape: "dab", seed: p.seed, spacing: 1.5 - (p.density / 100) * 0.8, ground: [246, 242, 230], blur: 0.6, flow: formFlow(pl, k) }), src);
  }),
};

export const painterlyFilters: FilterDef[] = [
  cartoon, comicBook, celShade, anime, inkDrawing, sketchToon, comicNoir, marker,
  oilPaint, impressionist, vanGogh, watercolor, dryBrush, paletteKnife, paintDaubs, smudgeStick, sponge, roughPastels, coloredPencil, fresco, plasticWrap, underpainting, posterEdges, neonGlowArt, gouache, pastelWash, sumiE, pointillism,
  pencilSketch, charcoal, chalkCharcoal, graphicPen, conteCrayon, crosshatch, waterPaper, engraving,
];
