/**
 * Face swap: put the face from one photo (the source) onto a face in
 * another (the target), following the target's pose, expression and light.
 *
 * 1. Both faces come with MediaPipe's 478 landmarks. The canonical face
 *    mesh (898 triangles over the first 468) is laid over each, and every
 *    target triangle takes its pixels from the matching source triangle (a
 *    piecewise-affine warp), so the new face bends to the target's angle.
 * 2. When the source face is turned away, triangles on its far side are
 *    squashed or hidden. Those are filled from the mirror-image triangle on
 *    the side the camera does see.
 * 3. The target's own lighting and skin tone are carried over: the warped
 *    face is scaled, channel by channel, by the ratio of the two faces'
 *    heavily blurred colors.
 * 4. The edge is feathered inside the face outline, and (when body-part
 *    maps are given) the target's hair, glasses and anything in front of
 *    the face stay on top, while the source's own hair is left behind.
 *
 * Pure typed-array code: no browser APIs.
 */

import { boxBlur1, type Img } from "../filters/img";
import { CANON, MIRROR, TRIS } from "./facemesh";

/** Soft maps (0..1, same size as the face's crop) used to keep things that aren't face. */
export interface FaceParts {
  hair: Float32Array;
  /** Glasses, hats and other accessories. */
  other: Float32Array;
  background: Float32Array;
}

export interface SwapFace {
  /** The picture around the face. */
  img: Img;
  /** 478 (or at least 468) landmarks as x, y pairs in img's pixels. */
  pts: Float32Array;
  parts?: FaceParts | null;
}

export interface SwapOptions {
  /** 0..1: how much of the target's light and skin tone to carry over. */
  lighting: number;
  /** 0..1: how soft the blended edge is. */
  softness: number;
  /** Fill the side of the face the source photo doesn't show from its other side. */
  fillHidden: boolean;
  /** Keep the target's hair, glasses and anything in front of the face. */
  keepHair: boolean;
}

export const DEFAULT_SWAP: SwapOptions = { lighting: 1, softness: 0.5, fillHidden: true, keepHair: true };

const NT = TRIS.length / 3;
const NV = 468;

/** For each triangle, the triangle made of the mirrored landmarks (-1 if the mesh has none). */
export const MIRROR_TRI: Int32Array = (() => {
  const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(",");
  const at = new Map<string, number>();
  for (let t = 0; t < NT; t++) at.set(key(TRIS[t * 3], TRIS[t * 3 + 1], TRIS[t * 3 + 2]), t);
  const out = new Int32Array(NT).fill(-1);
  for (let t = 0; t < NT; t++) out[t] = at.get(key(MIRROR[TRIS[t * 3]], MIRROR[TRIS[t * 3 + 1]], MIRROR[TRIS[t * 3 + 2]])) ?? -1;
  return out;
})();

/** The canonical (frontal) area of each triangle, in image orientation (y down). */
const CANON_AREA: Float32Array = (() => {
  const a = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    const i = TRIS[t * 3], j = TRIS[t * 3 + 1], k = TRIS[t * 3 + 2];
    const ax = CANON[i * 3], ay = -CANON[i * 3 + 1];
    const bx = CANON[j * 3], by = -CANON[j * 3 + 1];
    const cx = CANON[k * 3], cy = -CANON[k * 3 + 1];
    a[t] = ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
  }
  return a;
})();

const CANON_LEN = Math.hypot(CANON[10 * 3] - CANON[152 * 3], CANON[10 * 3 + 1] - CANON[152 * 3 + 1]);

/**
 * How squarely the camera sees each triangle: its area in the photo over
 * its frontal area, normalized so the most frontal part of the face is
 * about 1. Near 0 (or negative) means turned away or hidden.
 */
export function visibility(pts: Float32Array): Float32Array {
  const v = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    const i = TRIS[t * 3], j = TRIS[t * 3 + 1], k = TRIS[t * 3 + 2];
    const ax = pts[i * 2], ay = pts[i * 2 + 1];
    const area = ((pts[j * 2] - ax) * (pts[k * 2 + 1] - ay) - (pts[k * 2] - ax) * (pts[j * 2 + 1] - ay)) / 2;
    const ca = CANON_AREA[t];
    v[t] = Math.abs(ca) > 1e-6 ? area / ca : 0;
  }
  // Scale by the forehead-to-chin length, which turning the head left or
  // right doesn't change, so a frontal triangle comes out near 1 at any yaw.
  const len = Math.hypot(pts[10 * 2] - pts[152 * 2], pts[10 * 2 + 1] - pts[152 * 2 + 1]);
  const s2 = (len / CANON_LEN) ** 2 || 1;
  for (let t = 0; t < NT; t++) v[t] /= s2;
  return v;
}

/** Bounding box of the 468 mesh landmarks. */
export function faceBox(pts: Float32Array): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < NV; i++) {
    x0 = Math.min(x0, pts[i * 2]);
    y0 = Math.min(y0, pts[i * 2 + 1]);
    x1 = Math.max(x1, pts[i * 2]);
    y1 = Math.max(y1, pts[i * 2 + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function sample(img: Img, x: number, y: number, out: Float32Array, o: number): void {
  const { w, h, data } = img;
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  for (let ch = 0; ch < 3; ch++) out[o + ch] = (data[a + ch] * (1 - fx) + data[b + ch] * fx) * (1 - fy) + (data[c + ch] * (1 - fx) + data[d + ch] * fx) * fy;
}

function sampleMap(m: Float32Array, w: number, h: number, x: number, y: number): number {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  return (m[y0 * w + x0] * (1 - fx) + m[y0 * w + x1] * fx) * (1 - fy) + (m[y1 * w + x0] * (1 - fx) + m[y1 * w + x1] * fx) * fy;
}

/** Three box passes: close to a Gaussian with sigma about r. */
function blur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const k = Math.max(1, Math.round(r * 0.8));
  return boxBlur1(boxBlur1(boxBlur1(a, w, h, k), w, h, k), w, h, k);
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The inner edge of the lips, in order around the mouth opening. */
const OUTER_LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const INNER_MOUTH = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];

function polyArea(pts: Float32Array, idx: number[]): number {
  let a = 0;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], j = idx[(k + 1) % idx.length];
    a += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** How open the mouth is: the opening's area over the face's area. */
export function mouthOpen(pts: Float32Array): number {
  const b = faceBox(pts);
  return polyArea(pts, INNER_MOUTH) / Math.max(1, b.w * b.h);
}

function polygonMask(pts: Float32Array, idx: number[], w: number, h: number): Float32Array {
  const m = new Float32Array(w * h);
  let y0 = h, y1 = 0;
  for (const i of idx) {
    y0 = Math.min(y0, Math.floor(pts[i * 2 + 1]));
    y1 = Math.max(y1, Math.ceil(pts[i * 2 + 1]));
  }
  for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
    const py = y + 0.5;
    const xs: number[] = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k], j = idx[(k + 1) % idx.length];
      const ay = pts[i * 2 + 1], by = pts[j * 2 + 1];
      if (ay > py !== by > py) xs.push(pts[i * 2] + ((py - ay) / (by - ay)) * (pts[j * 2] - pts[i * 2]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * w + x] = 1;
  }
  return m;
}

export interface SwapResult {
  /** The new face over the target picture, same size as target.img (opaque). */
  pixels: Uint8ClampedArray;
  /** Where the new face shows, 0..255. */
  mask: Uint8Array;
  /** How much of the face came from the mirrored side (0..1), for the UI. */
  mirrored: number;
}

export function swapFace(target: SwapFace, source: SwapFace, o: SwapOptions = DEFAULT_SWAP): SwapResult {
  const { w, h } = target.img;
  const n = w * h;
  const tp = target.pts, sp = source.pts;
  const fb = faceBox(tp);
  const faceW = Math.max(8, Math.max(fb.w, fb.h));

  const visS = visibility(sp);
  // Per triangle: how much to take from the mirrored triangle instead.
  const useMirror = new Float32Array(NT);
  if (o.fillHidden)
    for (let t = 0; t < NT; t++) {
      const m = MIRROR_TRI[t];
      if (m < 0) continue;
      const vs = visS[t], vm = visS[m];
      useMirror[t] = Math.max(0, Math.min(1, (0.32 - vs) / 0.25)) * Math.max(0, Math.min(1, (vm - vs) / 0.3));
    }

  // ---- warp: every target triangle samples its source triangle (and its mirror)
  const warp = new Float32Array(n * 3);
  const warpM = new Float32Array(n * 3);
  const mixW = new Float32Array(n);
  const cov = new Float32Array(n);
  const srcKeep = new Float32Array(n).fill(1);
  const anyMirror = useMirror.some((v) => v > 0);
  const keepM = anyMirror ? new Float32Array(n).fill(1) : null;
  const sParts = source.parts;
  const sw = source.img.w, sh = source.img.h;
  let mirroredArea = 0, totalArea = 0;
  // Draw the triangles facing the camera first: on a turned head the far
  // side folds behind the near side, and the near side must win.
  const visT = visibility(tp);
  const order = Array.from({ length: NT }, (_, t) => t).filter((t) => visT[t] > 0.02).sort((p, q) => visT[q] - visT[p]);
  for (const t of order) {
    const a = TRIS[t * 3], b = TRIS[t * 3 + 1], c = TRIS[t * 3 + 2];
    const x0 = tp[a * 2], y0 = tp[a * 2 + 1], x1 = tp[b * 2], y1 = tp[b * 2 + 1], x2 = tp[c * 2], y2 = tp[c * 2 + 1];
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-6) continue;
    const mt = useMirror[t];
    const ma = MIRROR[a], mb = MIRROR[b], mc = MIRROR[c];
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), bx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), by1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
        const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
        const i = y * w + x;
        if (cov[i]) continue; // triangles share edges: first one wins
        cov[i] = 1;
        totalArea++;
        const sx = l0 * sp[a * 2] + l1 * sp[b * 2] + l2 * sp[c * 2];
        const sy = l0 * sp[a * 2 + 1] + l1 * sp[b * 2 + 1] + l2 * sp[c * 2 + 1];
        sample(source.img, sx - 0.5, sy - 0.5, warp, i * 3);
        if (sParts) srcKeep[i] = 1 - Math.min(1, sampleMap(sParts.hair, sw, sh, sx - 0.5, sy - 0.5) + sampleMap(sParts.background, sw, sh, sx - 0.5, sy - 0.5));
        // The mirrored sample is taken everywhere once any part needs it: the
        // blurred blend weight reaches into neighboring triangles too.
        if (anyMirror) {
          const mx = l0 * sp[ma * 2] + l1 * sp[mb * 2] + l2 * sp[mc * 2];
          const my = l0 * sp[ma * 2 + 1] + l1 * sp[mb * 2 + 1] + l2 * sp[mc * 2 + 1];
          sample(source.img, mx - 0.5, my - 0.5, warpM, i * 3);
          mixW[i] = mt;
          mirroredArea += mt;
          // Mirrored glasses look wrong, so the mirrored side leaves accessories out too.
          if (sParts && keepM) keepM[i] = 1 - Math.min(1, sampleMap(sParts.hair, sw, sh, mx - 0.5, my - 0.5) + sampleMap(sParts.background, sw, sh, mx - 0.5, my - 0.5) + sampleMap(sParts.other, sw, sh, mx - 0.5, my - 0.5));
        }
      }
  }
  // Soften the switch between the photo's side and the mirrored side.
  const mix = mirroredArea > 0 ? blur(mixW, w, h, faceW * 0.03) : mixW;
  const face = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const m = cov[i] ? mix[i] : 0;
    for (let ch = 0; ch < 3; ch++) face[i * 3 + ch] = warp[i * 3 + ch] * (1 - m) + warpM[i * 3 + ch] * m;
    if (keepM && m > 0) srcKeep[i] = srcKeep[i] * (1 - m) + keepM[i] * m;
  }

  // ---- lighting and skin tone from the target
  const soft = blur(cov, w, h, faceW * 0.03);
  const core = new Float32Array(n);
  // Compare skin with skin only: leave out hair, glasses and background on either side.
  const tp2 = target.parts;
  for (let i = 0; i < n; i++) {
    let c = soft[i] > 0.92 ? srcKeep[i] : 0;
    if (c && tp2) c *= 1 - Math.min(1, tp2.hair[i] + tp2.other[i] + tp2.background[i]);
    core[i] = c > 0.5 ? 1 : 0;
  }
  const sig = faceW * 0.09;
  const den = blur(core, w, h, sig);
  const out = new Float32Array(n * 3);
  for (let ch = 0; ch < 3; ch++) {
    const tc = new Float32Array(n), fc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      tc[i] = target.img.data[i * 4 + ch] * core[i];
      fc[i] = face[i * 3 + ch] * core[i];
    }
    const tb = blur(tc, w, h, sig), fbl = blur(fc, w, h, sig);
    for (let i = 0; i < n; i++) {
      if (!cov[i]) continue;
      const d = den[i];
      let r = 1;
      if (d > 1e-3) r = (tb[i] / d + 1) / (fbl[i] / d + 1);
      r = Math.max(0.35, Math.min(2.8, r));
      out[i * 3 + ch] = face[i * 3 + ch] * Math.pow(r, o.lighting);
    }
  }

  // ---- the mask: inside the face outline, feathered inward
  const fr = faceW * (0.012 + 0.05 * o.softness);
  const fe = blur(cov, w, h, fr);
  // A mouth open in one face and closed in the other can't be warped into
  // each other (lips would smear over teeth), so the target keeps its own
  // mouth: all of it when the target's is open, mostly when only the
  // source's is.
  const tOpen = mouthOpen(tp), sOpen = mouthOpen(sp);
  const mouthKeep = tOpen > Math.max(0.004, sOpen * 2) ? 1 : sOpen > Math.max(0.004, tOpen * 2) ? 0.65 : 0;
  let keepMouth: Float32Array | null = null;
  if (mouthKeep) {
    keepMouth = blur(polygonMask(tp, OUTER_LIPS, w, h), w, h, faceW * 0.02);
    for (let i = 0; i < keepMouth.length; i++) keepMouth[i] = sstep(0.05, 0.5, keepMouth[i]) * mouthKeep;
  }
  const tParts = target.parts;
  const mask = new Uint8Array(n);
  const pixels = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let m = sstep(0.5, 0.98, fe[i]) * srcKeep[i];
    if (keepMouth) m *= 1 - keepMouth[i];
    if (o.keepHair && tParts) m *= 1 - Math.min(1, tParts.hair[i] + tParts.other[i] + tParts.background[i]);
    mask[i] = Math.round(Math.max(0, Math.min(1, m)) * 255);
    const p = i * 4;
    if (cov[i]) {
      pixels[p] = out[i * 3];
      pixels[p + 1] = out[i * 3 + 1];
      pixels[p + 2] = out[i * 3 + 2];
    } else {
      pixels[p] = target.img.data[p];
      pixels[p + 1] = target.img.data[p + 1];
      pixels[p + 2] = target.img.data[p + 2];
    }
    pixels[p + 3] = 255;
  }
  return { pixels, mask, mirrored: totalArea ? mirroredArea / totalArea : 0 };
}
