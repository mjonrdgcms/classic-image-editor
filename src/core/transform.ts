/**
 * Free Transform math: the projective map from a rectangle to any
 * four-cornered shape (which covers scale, rotate, skew, distort and
 * perspective), and warping pixels and masks through it.
 */

import { resampleGray, resampleRGBA } from "./resample";
import type { Rect } from "./tiles";

/** Four corners, clockwise from top-left: x0, y0, x1, y1, x2, y2, x3, y3. */
export type Quad = [number, number, number, number, number, number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const rectQuad = (r: Rect): Quad => [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h];

/** The map from the unit square (corners 00, 10, 11, 01) to a quad (Heckbert). */
export function squareToQuad(q: Quad): Mat3 {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const det = dx1 * dy2 - dx2 * dy1 || 1e-12;
  const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function invert3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function apply3(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Bounding box of a quad, in whole pixels. */
export function quadBounds(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const x0 = Math.floor(Math.min(...xs)), y0 = Math.floor(Math.min(...ys));
  return { x: x0, y: y0, w: Math.max(1, Math.ceil(Math.max(...xs)) - x0), h: Math.max(1, Math.ceil(Math.max(...ys)) - y0) };
}

const area = (q: Quad) => Math.abs((q[0] * q[3] - q[2] * q[1] + (q[2] * q[5] - q[4] * q[3]) + (q[4] * q[7] - q[6] * q[5]) + (q[6] * q[1] - q[0] * q[7])) / 2);

/** True when the quad is a usable shape (not folded over itself or collapsed). */
export function quadOk(q: Quad): boolean {
  if (area(q) < 1) return false;
  // Convex with a consistent winding.
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[k * 2], ay = q[k * 2 + 1], bx = q[((k + 1) % 4) * 2], by = q[((k + 1) % 4) * 2 + 1], cx = q[((k + 2) % 4) * 2], cy = q[((k + 2) % 4) * 2 + 1];
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cr) < 1e-9) continue;
    const s = Math.sign(cr);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export type WarpMethod = "bilinear" | "bicubic" | "nearest";

function cubic(t: number): [number, number, number, number] {
  const a = -0.5, t2 = t * t, t3 = t2 * t;
  return [a * t3 - 2 * a * t2 + a * t, (a + 2) * t3 - (a + 3) * t2 + 1, -(a + 2) * t3 + (2 * a + 3) * t2 - a * t, -a * t3 + a * t2];
}

/**
 * Warp pixels (sw x sh, covering the unit square) onto the quad, producing
 * the dest rect's pixels (straight RGBA). Outside the shape is transparent;
 * its edges are antialiased.
 */
export function warpRGBA(src: Uint8ClampedArray, sw: number, sh: number, quad: Quad, dest: Rect, method: WarpMethod = "bicubic"): Uint8ClampedArray {
  // Shrinking a lot: start from a smaller copy so the result doesn't alias.
  const shrink = Math.sqrt(area(quad) / (sw * sh));
  let s = src, w = sw, h = sh;
  if (shrink < 0.5 && method !== "nearest") {
    const k = Math.max(shrink * 1.4, 1 / Math.max(sw, sh));
    w = Math.max(1, Math.round(sw * k));
    h = Math.max(1, Math.round(sh * k));
    s = resampleRGBA(src, sw, sh, w, h, "bilinear");
  }
  const inv = invert3(squareToQuad(quad));
  const out = new Uint8ClampedArray(dest.w * dest.h * 4);
  const acc = [0, 0, 0, 0];
  const tap = (xx: number, yy: number, wt: number) => {
    if (xx < 0 || yy < 0 || xx >= w || yy >= h || !wt) return;
    // Premultiplied on the fly (no float copy of a big layer).
    const p = (yy * w + xx) * 4;
    const aw = (s[p + 3] / 255) * wt;
    acc[0] += s[p] * aw;
    acc[1] += s[p + 1] * aw;
    acc[2] += s[p + 2] * aw;
    acc[3] += aw;
  };
  for (let y = 0; y < dest.h; y++)
    for (let x = 0; x < dest.w; x++) {
      const [u, v] = apply3(inv, dest.x + x + 0.5, dest.y + y + 0.5);
      if (u < -0.01 || v < -0.01 || u > 1.01 || v > 1.01) continue;
      const fx = u * w - 0.5, fy = v * h - 0.5;
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      if (method === "nearest") tap(Math.floor(u * w), Math.floor(v * h), 1);
      else {
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        if (method === "bicubic") {
          const wx = cubic(tx), wy = cubic(ty);
          for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) tap(x0 - 1 + i, y0 - 1 + j, wx[i] * wy[j]);
        } else {
          tap(x0, y0, (1 - tx) * (1 - ty));
          tap(x0 + 1, y0, tx * (1 - ty));
          tap(x0, y0 + 1, (1 - tx) * ty);
          tap(x0 + 1, y0 + 1, tx * ty);
        }
      }
      const a = Math.max(0, Math.min(1, acc[3]));
      if (a <= 0.5 / 255) continue;
      const o = (y * dest.w + x) * 4;
      out[o] = acc[0] / acc[3];
      out[o + 1] = acc[1] / acc[3];
      out[o + 2] = acc[2] / acc[3];
      out[o + 3] = Math.round(a * 255);
    }
  return out;
}

/** Warp one 8-bit channel (a mask); outside the shape gets `outside`. */
export function warpGray(src: Uint8Array, sw: number, sh: number, quad: Quad, dest: Rect, outside: number): Uint8Array {
  const shrink = Math.sqrt(area(quad) / (sw * sh));
  let s = src, w = sw, h = sh;
  if (shrink < 0.5) {
    const k = Math.max(shrink * 1.4, 1 / Math.max(sw, sh));
    w = Math.max(1, Math.round(sw * k));
    h = Math.max(1, Math.round(sh * k));
    s = resampleGray(src, sw, sh, w, h, "bilinear");
  }
  const inv = invert3(squareToQuad(quad));
  const out = new Uint8Array(dest.w * dest.h).fill(outside);
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? outside : s[yy * w + xx]);
  for (let y = 0; y < dest.h; y++)
    for (let x = 0; x < dest.w; x++) {
      const [u, v] = apply3(inv, dest.x + x + 0.5, dest.y + y + 0.5);
      if (u < -0.01 || v < -0.01 || u > 1.01 || v > 1.01) continue;
      const fx = u * w - 0.5, fy = v * h - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      out[y * dest.w + x] = Math.round((at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty);
    }
  return out;
}
