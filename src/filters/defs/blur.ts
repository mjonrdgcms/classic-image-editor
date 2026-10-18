/** Blur, Sharpen and Noise. */

import { contrast, grain } from "../fx";
import { Img, atScale, boxBlur, clamp, cloneImg, convolve, gauss1, gaussianBlur, gaussRand, grayOf, guidedSmooth, lerp, luma, mapRGB, median, pathBlur, planes, rng, smoothstep } from "../img";
import { angle, check, pct, px, range, seed, sel } from "../p";
import type { FilterDef } from "../types";

function unsharp(src: Img, radius: number, amount: number, threshold: number): Img {
  const bl = gaussianBlur(src, radius);
  const out = cloneImg(src);
  const d = out.data, s = src.data, b = bl.data;
  for (let p = 0; p < d.length; p += 4) {
    const diff = luma(s[p], s[p + 1], s[p + 2]) - luma(b[p], b[p + 1], b[p + 2]);
    if (Math.abs(diff) < threshold) continue;
    for (let c = 0; c < 3; c++) d[p + c] = s[p + c] + (s[p + c] - b[p + c]) * amount;
  }
  return out;
}

/** Disk ("lens") blur with highlight boost, via many offset samples. */
function lensBlur(src: Img, radius: number, bright: number, threshold: number, blades: number): Img {
  const { w, h } = src;
  const pts: [number, number][] = [];
  const rings = Math.max(2, Math.min(4, Math.round(radius / 2)));
  for (let r = 1; r <= rings; r++) {
    const n = Math.max(6, Math.round(r * 6));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      let rr = (r / rings) * radius;
      if (blades >= 3) {
        const seg = (Math.PI * 2) / blades;
        const t = ((a % seg) + seg) % seg - seg / 2;
        rr *= Math.cos(seg / 2) / Math.cos(t);
      }
      pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
    }
  }
  pts.push([0, 0]);
  const boost = new Float32Array(w * h * 3);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const l = luma(src.data[p], src.data[p + 1], src.data[p + 2]);
    const k = l > threshold ? 1 + (bright / 100) * 4 * ((l - threshold) / Math.max(1, 255 - threshold)) : 1;
    for (let c = 0; c < 3; c++) boost[i * 3 + c] = src.data[p + c] * k;
  }
  const out = cloneImg(src);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of pts) {
        const xx = Math.min(w - 1, Math.max(0, Math.round(x + dx))), yy = Math.min(h - 1, Math.max(0, Math.round(y + dy)));
        const i = (yy * w + xx) * 3;
        r += boost[i];
        g += boost[i + 1];
        b += boost[i + 2];
      }
      const p = (y * w + x) * 4;
      out.data[p] = r / pts.length;
      out.data[p + 1] = g / pts.length;
      out.data[p + 2] = b / pts.length;
    }
  return out;
}

export const blurFilters: FilterDef[] = [
  // ---------------------------------------------------------- Blur
  { id: "blur", name: "Blur", category: "Blur", description: "Smooths the image slightly.", params: [], pad: () => 2, ownAlpha: true, run: (s) => gaussianBlur(s, 0.8) },
  { id: "blurMore", name: "Blur More", category: "Blur", description: "Smooths three or four times more than Blur.", params: [], pad: () => 5, ownAlpha: true, run: (s) => gaussianBlur(s, 2) },
  {
    id: "gaussianBlur",
    name: "Gaussian Blur",
    category: "Blur",
    description: "Blurs by a radius you choose, with a smooth bell-shaped falloff.",
    tags: ["soften", "smooth"],
    params: [px("radius", "Radius", 0.1, 250, 4, 0.1)],
    pad: (p) => p.radius * 3,
    ownAlpha: true,
    run: (s, p) => gaussianBlur(s, p.radius),
  },
  {
    id: "boxBlur",
    name: "Box Blur",
    category: "Blur",
    description: "Averages each pixel with a square of neighbors.",
    params: [px("radius", "Radius", 1, 200, 6)],
    pad: (p) => p.radius,
    ownAlpha: true,
    run: (s, p) => boxBlur(s, p.radius),
  },
  {
    id: "motionBlur",
    name: "Motion Blur",
    category: "Blur",
    description: "Blurs in one direction, like a moving subject or a moving camera.",
    tags: ["speed", "streak", "movement"],
    params: [angle("angle", "Angle", 0, -90, 90), px("distance", "Distance", 1, 999, 20)],
    pad: (p) => p.distance,
    ownAlpha: true,
    run(src, p) {
      const a = (p.angle * Math.PI) / 180;
      const dx = Math.cos(a) * p.distance, dy = -Math.sin(a) * p.distance;
      return pathBlur(src, (x, y, t, o) => {
        o[0] = x + dx * t;
        o[1] = y + dy * t;
      }, Math.min(96, Math.max(3, p.distance)));
    },
  },
  {
    id: "radialBlur",
    name: "Radial Blur",
    category: "Blur",
    description: "Spins around a center like a turning wheel, or zooms toward it.",
    tags: ["spin", "zoom", "rotate"],
    params: [range("amount", "Amount", 1, 100, 10), sel("method", "Blur Method", [["spin", "Spin"], ["zoom", "Zoom"]], "zoom"), pct("cx", "Center X", 50), pct("cy", "Center Y", 50), sel("quality", "Quality", [["draft", "Draft"], ["good", "Good"], ["best", "Best"]], "good")],
    ownAlpha: true,
    run(src, p) {
      const cx = (p.cx / 100) * src.w, cy = (p.cy / 100) * src.h;
      const n = p.quality === "draft" ? 8 : p.quality === "good" ? 24 : 48;
      if (p.method === "spin") {
        const ang = (p.amount / 100) * 0.6;
        return pathBlur(src, (x, y, t, o) => {
          const dx = x - cx, dy = y - cy, a = t * ang, c = Math.cos(a), s = Math.sin(a);
          o[0] = cx + dx * c - dy * s;
          o[1] = cy + dx * s + dy * c;
        }, n);
      }
      const k = p.amount / 140;
      return pathBlur(src, (x, y, t, o) => {
        const f = 1 + (t + 0.5) * -k;
        o[0] = cx + (x - cx) * f;
        o[1] = cy + (y - cy) * f;
      }, n);
    },
  },
  {
    id: "smartBlur",
    name: "Smart Blur",
    category: "Blur",
    description: "Blurs inside areas of similar color but keeps edges sharp.",
    tags: ["edge preserving", "skin", "smooth"],
    params: [px("radius", "Radius", 1, 100, 5), range("threshold", "Threshold", 1, 100, 25), sel("mode", "Mode", [["normal", "Normal"], ["edge", "Edge Only"], ["overlay", "Overlay Edge"]], "normal")],
    pad: (p) => p.radius * 2,
    run(src, p) {
      const s = guidedSmooth(src, Math.max(1, Math.round(p.radius)), p.threshold);
      if (p.mode === "normal") return s;
      const g = grayOf(s);
      const gs = gauss1(g, src.w, src.h, 1);
      return mapRGB(s, (r, gg, b, i) => {
        const e = Math.abs(g[i] - gs[i]) > 3 ? 1 : 0;
        if (p.mode === "edge") return e ? [255, 255, 255] : [0, 0, 0];
        return e ? [255, 255, 255] : [r, gg, b];
      });
    },
  },
  {
    id: "surfaceBlur",
    name: "Surface Blur",
    category: "Blur",
    description: "Smooths surfaces and skin while leaving edges and detail lines alone.",
    tags: ["skin", "beauty", "denoise", "bilateral"],
    params: [px("radius", "Radius", 1, 100, 6), range("threshold", "Threshold", 2, 255, 20)],
    pad: (p) => p.radius * 2,
    run: (src, p) => guidedSmooth(src, Math.max(1, Math.round(p.radius)), p.threshold),
  },
  {
    id: "lensBlur",
    name: "Lens Blur",
    category: "Blur",
    description: "Out-of-focus blur with bright, shaped bokeh highlights.",
    tags: ["bokeh", "depth of field", "defocus"],
    params: [px("radius", "Radius", 1, 60, 10), pct("bright", "Specular Brightness", 40), range("threshold", "Specular Threshold", 120, 255, 220), range("blades", "Iris Blades", 0, 8, 6)],
    pad: (p) => p.radius + 2,
    run: (src, p) => (p.radius > 8 ? atScale(src, 6 / p.radius, (s, k) => lensBlur(s, Math.max(1, p.radius * k), p.bright, p.threshold, Math.round(p.blades))) : lensBlur(src, Math.max(1, p.radius), p.bright, p.threshold, Math.round(p.blades))),
  },
  {
    id: "tiltShift",
    name: "Tilt-Shift",
    category: "Blur",
    description: "Keeps a horizontal band sharp and blurs above and below, so scenes look like miniatures.",
    tags: ["miniature", "toy", "focus"],
    params: [pct("center", "Focus Position", 55), pct("band", "Focus Band", 20), px("blur", "Blur", 1, 60, 10), range("sat", "Saturation", 0, 200, 135, "%")],
    ownAlpha: true,
    run(src, p) {
      const bl = gaussianBlur(src, p.blur);
      const c = (p.center / 100) * src.h, band = (p.band / 100) * src.h * 0.5;
      const sat = p.sat / 100;
      const out = cloneImg(src);
      for (let y = 0; y < src.h; y++) {
        const k = smoothstep(band, band + src.h * 0.25, Math.abs(y - c));
        for (let x = 0; x < src.w; x++) {
          const q = (y * src.w + x) * 4;
          for (let ch = 0; ch < 4; ch++) out.data[q + ch] = lerp(src.data[q + ch], bl.data[q + ch], k);
          const l = luma(out.data[q], out.data[q + 1], out.data[q + 2]);
          for (let ch = 0; ch < 3; ch++) out.data[q + ch] = l + (out.data[q + ch] - l) * sat;
        }
      }
      return out;
    },
  },
  {
    id: "average",
    name: "Average",
    category: "Blur",
    description: "Fills the selection (or layer) with its average color.",
    params: [],
    run(src) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let p = 0; p < src.data.length; p += 4) {
        const al = src.data[p + 3];
        r += src.data[p] * al;
        g += src.data[p + 1] * al;
        b += src.data[p + 2] * al;
        a += al;
      }
      return a ? mapRGB(src, () => [r / a, g / a, b / a]) : cloneImg(src);
    },
  },
  {
    id: "dreamyGlow",
    name: "Soft Focus",
    category: "Blur",
    description: "A soft, dreamy glow over a still-sharp picture, like a diffusion filter.",
    tags: ["orton", "glow", "dreamy", "diffusion"],
    params: [px("radius", "Glow Radius", 2, 80, 14), pct("amount", "Amount", 45), pct("brightness", "Brightness", 20)],
    pad: (p) => p.radius * 3,
    run(src, p) {
      const bl = gaussianBlur(src, p.radius);
      const k = p.amount / 100, br = p.brightness;
      return mapRGB(src, (r, g, b, i) => {
        const q = i * 4;
        return [r, g, b].map((v, c) => {
          const s = 255 - ((255 - v) * (255 - bl.data[q + c])) / 255;
          return lerp(v, s, k) + br * 0.3;
        });
      });
    },
  },

  // ---------------------------------------------------------- Sharpen
  { id: "sharpen", name: "Sharpen", category: "Sharpen", description: "Sharpens slightly.", params: [], pad: () => 2, run: (s) => convolve(s, [0, -1, 0, -1, 8, -1, 0, -1, 0], 3, 4) },
  { id: "sharpenMore", name: "Sharpen More", category: "Sharpen", description: "Sharpens more strongly than Sharpen.", params: [], pad: () => 2, run: (s) => convolve(s, [-1, -1, -1, -1, 12, -1, -1, -1, -1], 3, 4) },
  {
    id: "sharpenEdges",
    name: "Sharpen Edges",
    category: "Sharpen",
    description: "Sharpens only the edges, leaving smooth areas alone.",
    params: [],
    pad: () => 4,
    run: (s) => unsharp(s, 1, 1, 8),
  },
  {
    id: "unsharpMask",
    name: "Unsharp Mask",
    category: "Sharpen",
    description: "Classic darkroom sharpening: amount, radius and a threshold to protect smooth areas.",
    tags: ["usm", "sharpen", "crisp"],
    params: [pct("amount", "Amount", 100, 1, 500), px("radius", "Radius", 0.1, 250, 1, 0.1), range("threshold", "Threshold", 0, 255, 0, "levels")],
    pad: (p) => p.radius * 3,
    run: (s, p) => unsharp(s, p.radius, p.amount / 100, p.threshold),
  },
  {
    id: "clarity",
    name: "Clarity",
    category: "Sharpen",
    description: "Adds midtone punch and local contrast without hard sharpening halos.",
    tags: ["local contrast", "punch", "structure", "hdr"],
    params: [pct("amount", "Amount", 40, -100, 100), px("radius", "Radius", 5, 200, 40)],
    pad: (p) => p.radius * 2,
    run(src, p) {
      const g = grayOf(src);
      const bl = gauss1(g, src.w, src.h, p.radius);
      const k = p.amount / 60;
      return mapRGB(src, (r, gg, b, i) => {
        const l = g[i] / 255;
        const mid = 1 - Math.pow(2 * l - 1, 2);
        const d = (g[i] - bl[i]) * k * mid;
        return [r + d, gg + d, b + d];
      });
    },
  },
  {
    id: "highPassSharpen",
    name: "High Pass Sharpen",
    category: "Sharpen",
    description: "Overlays the fine detail back onto the image for crisp, natural sharpening.",
    params: [px("radius", "Radius", 0.5, 30, 3, 0.1), pct("amount", "Amount", 80, 0, 300)],
    pad: (p) => p.radius * 3,
    run(src, p) {
      const bl = gaussianBlur(src, p.radius);
      const k = p.amount / 100;
      return mapRGB(src, (r, g, b, i) => {
        const q = i * 4;
        return [r, g, b].map((v, c) => {
          const hp = clamp(128 + (v - bl.data[q + c]));
          const ov = v < 128 ? (2 * v * hp) / 255 : 255 - (2 * (255 - v) * (255 - hp)) / 255;
          return lerp(v, ov, k);
        });
      });
    },
  },

  // ---------------------------------------------------------- Noise
  {
    id: "addNoise",
    name: "Add Noise",
    category: "Noise",
    description: "Adds random pixels, evenly or in a bell curve, in color or gray.",
    tags: ["noise", "grain"],
    params: [pct("amount", "Amount", 12, 0.1, 400), sel("dist", "Distribution", [["uniform", "Uniform"], ["gaussian", "Gaussian"]], "gaussian"), check("mono", "Monochromatic", false), seed(21)],
    run(src, p) {
      const r = rng(p.seed);
      const a = (p.amount / 100) * 255;
      return mapRGB(src, (rr, g, b) => {
        const n = () => (p.dist === "uniform" ? (r() - 0.5) * 2 * a : gaussRand(r) * a * 0.5);
        if (p.mono) {
          const v = n();
          return [rr + v, g + v, b + v];
        }
        return [rr + n(), g + n(), b + n()];
      });
    },
  },
  {
    id: "filmGrain",
    name: "Film Grain",
    category: "Noise",
    description: "Organic film grain, strongest in the midtones, in a size you choose.",
    tags: ["grain", "film", "analog"],
    params: [pct("amount", "Amount", 30), px("size", "Grain Size", 0.5, 6, 1.4, 0.1), check("mono", "Monochrome Grain", true), seed(22)],
    run: (src, p) => grain(src, p.amount / 100 * 60, p.size, p.mono, p.seed),
  },
  {
    id: "despeckle",
    name: "Despeckle",
    category: "Noise",
    description: "Removes noise from smooth areas while keeping edges.",
    params: [],
    pad: () => 3,
    run: (s) => guidedSmooth(s, 2, 12),
  },
  {
    id: "median",
    name: "Median",
    category: "Noise",
    description: "Replaces each pixel with the median of its neighbors; removes specks.",
    params: [px("radius", "Radius", 1, 30, 2)],
    pad: (p) => p.radius,
    run: (s, p) => median(s, Math.max(1, p.radius)),
  },
  {
    id: "dustScratches",
    name: "Dust & Scratches",
    category: "Noise",
    description: "Removes small defects that stand out from their surroundings.",
    tags: ["restore", "retouch", "dust"],
    params: [px("radius", "Radius", 1, 20, 2), range("threshold", "Threshold", 0, 255, 10, "levels")],
    pad: (p) => p.radius,
    run(src, p) {
      const m = median(src, Math.max(1, p.radius));
      return mapRGB(src, (r, g, b, i) => {
        const q = i * 4;
        const d = Math.abs(luma(r, g, b) - luma(m.data[q], m.data[q + 1], m.data[q + 2]));
        return d > p.threshold ? [m.data[q], m.data[q + 1], m.data[q + 2]] : [r, g, b];
      });
    },
  },
  {
    id: "reduceNoise",
    name: "Reduce Noise",
    category: "Noise",
    description: "Smooths luminance and color noise separately, keeping detail.",
    tags: ["denoise", "clean"],
    params: [pct("strength", "Strength", 50), pct("color", "Color Noise", 60), pct("detail", "Preserve Details", 50)],
    pad: () => 12,
    run(src, p) {
      const lumS = guidedSmooth(src, 2 + Math.round(p.strength / 25), 4 + (100 - p.detail) * 0.4);
      // Color noise: blur the chroma only.
      const pl = planes(lumS);
      const n = src.w * src.h;
      const Y = new Float32Array(n), U = new Float32Array(n), V = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const q = i * 4;
        const r = lumS.data[q], g = lumS.data[q + 1], b = lumS.data[q + 2];
        Y[i] = luma(r, g, b);
        U[i] = b - Y[i];
        V[i] = r - Y[i];
      }
      void pl;
      const cr = 1 + (p.color / 100) * 6;
      const Ub = gauss1(U, src.w, src.h, cr), Vb = gauss1(V, src.w, src.h, cr);
      const out = cloneImg(lumS);
      for (let i = 0; i < n; i++) {
        const r = Y[i] + Vb[i], b = Y[i] + Ub[i];
        const g = (Y[i] - 0.299 * r - 0.114 * b) / 0.587;
        out.data[i * 4] = r;
        out.data[i * 4 + 1] = g;
        out.data[i * 4 + 2] = b;
      }
      return out;
    },
  },
  {
    id: "jpegCrush",
    name: "Deep Fried",
    category: "Noise",
    description: "Over-sharpened, over-saturated and crunchy, like a meme saved a hundred times.",
    tags: ["meme", "crunchy", "glitch"],
    params: [pct("amount", "Amount", 60)],
    pad: () => 6,
    run(src, p) {
      const k = p.amount / 100;
      let s = contrast(src, 40 * k);
      s = mapRGB(s, (r, g, b) => {
        const l = luma(r, g, b);
        return [l + (r - l) * (1 + 1.5 * k) + 25 * k, l + (g - l) * (1 + 1.5 * k), l + (b - l) * (1 + 1.5 * k) - 20 * k];
      });
      s = unsharp(s, 1.5, 3 * k, 0);
      // Block artifacts: quantize 8x8 block averages slightly.
      const out = cloneImg(s);
      for (let by = 0; by < s.h; by += 8)
        for (let bx = 0; bx < s.w; bx += 8) {
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = by; y < Math.min(s.h, by + 8); y++)
            for (let x = bx; x < Math.min(s.w, bx + 8); x++) {
              const q = (y * s.w + x) * 4;
              r += s.data[q];
              g += s.data[q + 1];
              b += s.data[q + 2];
              n++;
            }
          for (let y = by; y < Math.min(s.h, by + 8); y++)
            for (let x = bx; x < Math.min(s.w, bx + 8); x++) {
              const q = (y * s.w + x) * 4;
              out.data[q] = lerp(s.data[q], r / n, 0.35 * k);
              out.data[q + 1] = lerp(s.data[q + 1], g / n, 0.35 * k);
              out.data[q + 2] = lerp(s.data[q + 2], b / n, 0.35 * k);
            }
        }
      return out;
    },
  },
];

