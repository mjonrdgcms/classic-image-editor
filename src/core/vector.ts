/**
 * Vector paths: the Pen tools, the Shape tools, shape layers and the Paths
 * palette all use this model.
 *
 * A path is a list of subpaths; each subpath is a list of anchors with
 * absolute in/out handle positions (a handle equal to its anchor means a
 * corner). Paths are plain JSON, so commands carry them as parameters and
 * Actions replay them.
 */

import { Mask } from "./mask";
import type { Rect } from "./tiles";

export interface Anchor {
  x: number;
  y: number;
  /** Incoming handle (from the previous anchor). */
  ix: number;
  iy: number;
  /** Outgoing handle (toward the next anchor). */
  ox: number;
  oy: number;
}

export interface Subpath {
  closed: boolean;
  pts: Anchor[];
}

export interface VecPath {
  subpaths: Subpath[];
}

export const corner = (x: number, y: number): Anchor => ({ x, y, ix: x, iy: y, ox: x, oy: y });
export const emptyPath = (): VecPath => ({ subpaths: [] });
export const clonePath = (p: VecPath): VecPath => JSON.parse(JSON.stringify(p));

/** JSON-Schema for a path parameter. */
export const PATH_SCHEMA = {
  type: "object" as const,
  description: "A vector path: subpaths of anchors {x, y, ix, iy, ox, oy} (in/out handle positions; equal to the anchor for corners)",
  properties: {
    subpaths: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          closed: { type: "boolean" as const },
          pts: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                x: { type: "number" as const },
                y: { type: "number" as const },
                ix: { type: "number" as const },
                iy: { type: "number" as const },
                ox: { type: "number" as const },
                oy: { type: "number" as const },
              },
              required: ["x", "y"],
            },
          },
        },
        required: ["pts"],
      },
    },
  },
  required: ["subpaths"],
};

/** Fill in missing handles (corners) after validation. */
export function normalizePath(p: { subpaths: { closed?: boolean; pts: Partial<Anchor>[] }[] }): VecPath {
  return {
    subpaths: p.subpaths
      .filter((s) => s.pts.length > 0)
      .map((s) => ({
        closed: !!s.closed,
        pts: s.pts.map((a) => ({ x: a.x!, y: a.y!, ix: a.ix ?? a.x!, iy: a.iy ?? a.y!, ox: a.ox ?? a.x!, oy: a.oy ?? a.y! })),
      })),
  };
}

// ------------------------------------------------------------------ geometry

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Each subpath as a polyline (closed ones without repeating the first point). */
export function flatten(p: VecPath, tolerance = 0.25): { closed: boolean; pts: [number, number][] }[] {
  const out: { closed: boolean; pts: [number, number][] }[] = [];
  for (const s of p.subpaths) {
    const pts: [number, number][] = [];
    const n = s.pts.length;
    if (!n) continue;
    pts.push([s.pts[0].x, s.pts[0].y]);
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n];
      const straight = a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y;
      if (straight) {
        pts.push([b.x, b.y]);
        continue;
      }
      // Enough steps that each chord is within the tolerance.
      const len = Math.hypot(a.ox - a.x, a.oy - a.y) + Math.hypot(b.ix - a.ox, b.iy - a.oy) + Math.hypot(b.x - b.ix, b.y - b.iy);
      const steps = Math.max(2, Math.min(200, Math.ceil(Math.sqrt(len / tolerance) * 0.8)));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        pts.push([cubic(a.x, a.ox, b.ix, b.x, t), cubic(a.y, a.oy, b.iy, b.y, t)]);
      }
    }
    if (s.closed && pts.length > 1) {
      const f = pts[0], l = pts[pts.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) pts.pop();
    }
    out.push({ closed: s.closed, pts });
  }
  return out;
}

export function pathBounds(p: VecPath): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of flatten(p, 1))
    for (const [x, y] of s.pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  if (x1 < x0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Move every point (anchors and handles) through f. */
export function mapPath(p: VecPath, f: (x: number, y: number) => [number, number]): VecPath {
  return {
    subpaths: p.subpaths.map((s) => ({
      closed: s.closed,
      pts: s.pts.map((a) => {
        const [x, y] = f(a.x, a.y), [ix, iy] = f(a.ix, a.iy), [ox, oy] = f(a.ox, a.oy);
        return { x, y, ix, iy, ox, oy };
      }),
    })),
  };
}

export const translatePath = (p: VecPath, dx: number, dy: number) => mapPath(p, (x, y) => [x + dx, y + dy]);

/** Split segment i of a subpath at t (de Casteljau). Returns the new subpath. */
export function splitSegment(s: Subpath, i: number, t: number): Subpath {
  const n = s.pts.length;
  const a = s.pts[i], b = s.pts[(i + 1) % n];
  const lerp = (p: number, q: number) => p + (q - p) * t;
  const p01x = lerp(a.x, a.ox), p01y = lerp(a.y, a.oy);
  const p12x = lerp(a.ox, b.ix), p12y = lerp(a.oy, b.iy);
  const p23x = lerp(b.ix, b.x), p23y = lerp(b.iy, b.y);
  const p012x = lerp(p01x, p12x), p012y = lerp(p01y, p12y);
  const p123x = lerp(p12x, p23x), p123y = lerp(p12y, p23y);
  const mx = lerp(p012x, p123x), my = lerp(p012y, p123y);
  const pts = s.pts.map((p) => ({ ...p }));
  pts[i] = { ...pts[i], ox: p01x, oy: p01y };
  const j = (i + 1) % n;
  pts[j] = { ...pts[j], ix: p23x, iy: p23y };
  pts.splice(i + 1, 0, { x: mx, y: my, ix: p012x, iy: p012y, ox: p123x, oy: p123y });
  return { closed: s.closed, pts };
}

/** The nearest point on the path to (x, y): subpath, segment, t and distance. */
export function nearestOnPath(p: VecPath, x: number, y: number): { sub: number; seg: number; t: number; d: number } | null {
  let best: { sub: number; seg: number; t: number; d: number } | null = null;
  p.subpaths.forEach((s, si) => {
    const n = s.pts.length;
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n];
      const steps = 40;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const d = Math.hypot(cubic(a.x, a.ox, b.ix, b.x, t) - x, cubic(a.y, a.oy, b.iy, b.y, t) - y);
        if (!best || d < best.d) best = { sub: si, seg: i, t, d };
      }
    }
  });
  return best;
}

// ------------------------------------------------------------------ rasterizing

/**
 * Coverage of closed rings (nonzero winding), anti-aliased with 4 subrows
 * and exact horizontal coverage, over the canvas w x h.
 */
export function ringsMask(w: number, h: number, rings: [number, number][][], antiAlias = true): Mask {
  const m = new Mask(w, h, 0);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const edges: [number, number, number, number, number][] = [];
  for (const r of rings) {
    if (r.length < 3) continue;
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length];
      x0 = Math.min(x0, ax);
      y0 = Math.min(y0, ay);
      x1 = Math.max(x1, ax);
      y1 = Math.max(y1, ay);
      if (ay !== by) edges.push(ay < by ? [ax, ay, bx, by, 1] : [bx, by, ax, ay, -1]);
    }
  }
  if (!edges.length) return m;
  const ax0 = Math.max(0, Math.floor(x0)), ay0 = Math.max(0, Math.floor(y0));
  const ax1 = Math.min(w, Math.ceil(x1) + 1), ay1 = Math.min(h, Math.ceil(y1) + 1);
  if (ax1 <= ax0 || ay1 <= ay0) return m;
  const area = { x: ax0, y: ay0, w: ax1 - ax0, h: ay1 - ay0 };
  const cov = new Float32Array(area.w * area.h);
  const S = antiAlias ? 4 : 1;
  const xs: [number, number][] = [];
  for (let y = 0; y < area.h; y++) {
    for (let s = 0; s < S; s++) {
      const sy = area.y + y + (s + 0.5) / S;
      xs.length = 0;
      for (const [ex0, ey0, ex1, ey1, dir] of edges) if (ey0 <= sy && ey1 > sy) xs.push([ex0 + ((sy - ey0) / (ey1 - ey0)) * (ex1 - ex0), dir]);
      xs.sort((p, q) => p[0] - q[0]);
      // Spans where the winding number is nonzero.
      let wind = 0, from = 0;
      const row = y * area.w;
      for (const [cx, dir] of xs) {
        const before = wind;
        wind += dir;
        if (before === 0 && wind !== 0) from = cx;
        else if (before !== 0 && wind === 0) addSpan(cov, row, area.w, from - area.x, cx - area.x, S, antiAlias);
      }
    }
  }
  const data = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) data[i] = Math.round(Math.min(1, cov[i]) * 255);
  m.writeRegion(area, data);
  return m;
}

function addSpan(cov: Float32Array, row: number, w: number, a: number, b: number, S: number, antiAlias: boolean): void {
  if (!antiAlias) {
    const ia = Math.max(0, Math.ceil(a - 0.5)), ib = Math.min(w, Math.floor(b - 0.5) + 1);
    for (let x = ia; x < ib; x++) cov[row + x] = 1;
    return;
  }
  a = Math.max(0, a);
  b = Math.min(w, b);
  if (b <= a) return;
  const ia = Math.floor(a), ib = Math.floor(b);
  if (ia === ib) cov[row + ia] += (b - a) / S;
  else {
    cov[row + ia] += (ia + 1 - a) / S;
    for (let x = ia + 1; x < ib; x++) cov[row + x] += 1 / S;
    if (ib < w) cov[row + ib] += (b - ib) / S;
  }
}

/** A path's filled area as a mask (open subpaths are closed with a straight line, as PS does). */
export function pathMask(p: VecPath, w: number, h: number, antiAlias = true): Mask {
  return ringsMask(
    w,
    h,
    flatten(p).map((s) => s.pts),
    antiAlias,
  );
}

// ------------------------------------------------------------------ selection -> path

/** Trace a mask's outline (50% level) into a path, simplified to `tolerance` pixels. */
export function pathFromMask(m: Mask, tolerance = 2): VecPath {
  const b = m.bounds();
  if (!b) return emptyPath();
  const r = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
  const d = m.readRegion(r);
  const W = r.w + 1;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < r.w && y < r.h && d[y * r.w + x] >= 128;
  // Directed boundary edges between pixel corners, inside on the right (clockwise rings).
  const next = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const list = next.get(k);
    if (list) list.push(y1 * W + x1);
    else next.set(k, [y1 * W + x1]);
  };
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
  const rings: [number, number][][] = [];
  while (next.size) {
    const startKey = next.keys().next().value as number;
    const ring: [number, number][] = [];
    let k = startKey;
    let prevDir = -1;
    for (let guard = 0; guard < 4 * r.w * r.h + 8; guard++) {
      const list = next.get(k);
      if (!list || !list.length) break;
      // At a pinch point, keep turning right so rings don't cross.
      let pick = 0;
      if (list.length > 1 && prevDir >= 0) {
        const dirs = list.map((n) => dirOf(k, n, W));
        const want = [(prevDir + 1) % 4, prevDir, (prevDir + 3) % 4];
        for (const wd of want) {
          const j = dirs.indexOf(wd);
          if (j >= 0) {
            pick = j;
            break;
          }
        }
      }
      const n = list.splice(pick, 1)[0];
      if (!list.length) next.delete(k);
      ring.push([(k % W) + r.x, Math.floor(k / W) + r.y]);
      prevDir = dirOf(k, n, W);
      k = n;
      if (k === startKey) break;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return {
    subpaths: rings.map((ring) => {
      const simple = simplifyRing(ring, Math.max(0.5, tolerance));
      return { closed: true, pts: smoothAnchors(simple) };
    }),
  };
}

function dirOf(a: number, b: number, W: number): number {
  const dx = (b % W) - (a % W), dy = Math.floor(b / W) - Math.floor(a / W);
  return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
}

/** Douglas-Peucker on a closed ring. */
function simplifyRing(ring: [number, number][], tol: number): [number, number][] {
  if (ring.length <= 4) return ring;
  // Split at the point farthest from the first so the ring has two open halves.
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > fd) (fd = d), (far = i);
  }
  const a = dp(ring.slice(0, far + 1), tol);
  const b = dp([...ring.slice(far), ring[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function dp(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let idx = 0, max = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
    if (d > max) (max = d), (idx = i);
  }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)];
}

/** A freehand stroke as a smooth subpath (Freeform Pen). */
export function subpathFromPolyline(pts: [number, number][], closed: boolean, tolerance: number): Subpath {
  const simple = closed ? simplifyRing(pts, tolerance) : dp(pts, tolerance);
  return { closed, pts: smoothAnchors(simple, closed) };
}

/** Anchors with smooth (Catmull-Rom) handles where the outline turns gently, corners where it turns sharply. */
function smoothAnchors(pts: [number, number][], closed = true): Anchor[] {
  const n = pts.length;
  return pts.map(([x, y], i) => {
    if (!closed && (i === 0 || i === n - 1)) return corner(x, y);
    const [px, py] = pts[(i - 1 + n) % n], [nx, ny] = pts[(i + 1) % n];
    const a1 = Math.atan2(y - py, x - px), a2 = Math.atan2(ny - y, nx - x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > Math.PI / 3) return corner(x, y);
    const tx = (nx - px) / 6, ty = (ny - py) / 6;
    return { x, y, ix: x - tx, iy: y - ty, ox: x + tx, oy: y + ty };
  });
}

// ------------------------------------------------------------------ shapes

/** Handle length that makes a cubic approximate a quarter circle. */
const K = 0.5522847498;

export function rectPath(x: number, y: number, w: number, h: number): Subpath {
  return { closed: true, pts: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] };
}

export function roundedRectPath(x: number, y: number, w: number, h: number, radius: number): Subpath {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) return rectPath(x, y, w, h);
  const k = r * K;
  const a = (ax: number, ay: number, ix: number, iy: number, ox: number, oy: number): Anchor => ({ x: ax, y: ay, ix, iy, ox, oy });
  return {
    closed: true,
    pts: [
      a(x + r, y, x + r - k, y, x + r, y),
      a(x + w - r, y, x + w - r, y, x + w - r + k, y),
      a(x + w, y + r, x + w, y + r - k, x + w, y + r),
      a(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k),
      a(x + w - r, y + h, x + w - r + k, y + h, x + w - r, y + h),
      a(x + r, y + h, x + r, y + h, x + r - k, y + h),
      a(x, y + h - r, x, y + h - r + k, x, y + h - r),
      a(x, y + r, x, y + r, x, y + r - k),
    ],
  };
}

export function ellipsePath(x: number, y: number, w: number, h: number): Subpath {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  return {
    closed: true,
    pts: [
      { x: cx, y: y, ix: cx - rx * K, iy: y, ox: cx + rx * K, oy: y },
      { x: x + w, y: cy, ix: x + w, iy: cy - ry * K, ox: x + w, oy: cy + ry * K },
      { x: cx, y: y + h, ix: cx + rx * K, iy: y + h, ox: cx - rx * K, oy: y + h },
      { x, y: cy, ix: x, iy: cy + ry * K, ox: x, oy: cy - ry * K },
    ],
  };
}

/** A regular polygon or star (indent 0..99 percent) inscribed in the box. */
export function polygonPath(x: number, y: number, w: number, h: number, sides: number, indent = 0): Subpath {
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  const pts: Anchor[] = [];
  const n = Math.max(3, Math.round(sides));
  const inner = 1 - Math.max(0, Math.min(99, indent)) / 100;
  for (let i = 0; i < n * (indent > 0 ? 2 : 1); i++) {
    const star = indent > 0;
    const a = -Math.PI / 2 + (i * Math.PI * 2) / (star ? n * 2 : n);
    const k = star && i % 2 ? inner : 1;
    pts.push(corner(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k));
  }
  return { closed: true, pts };
}

/** A line of the given weight from (x0, y0) to (x1, y1), with optional arrowheads. */
export function linePath(x0: number, y0: number, x1: number, y1: number, weight: number, arrowStart = false, arrowEnd = false): Subpath {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len, nx = -uy, ny = ux;
  const hw = Math.max(0.5, weight / 2);
  const aw = hw * 3, al = Math.min(len / 2, hw * 5);
  const pts: [number, number][] = [];
  const sx = arrowStart ? x0 + ux * al : x0, sy = arrowStart ? y0 + uy * al : y0;
  const ex = arrowEnd ? x1 - ux * al : x1, ey = arrowEnd ? y1 - uy * al : y1;
  pts.push([sx + nx * hw, sy + ny * hw], [ex + nx * hw, ey + ny * hw]);
  if (arrowEnd) pts.push([ex + nx * aw, ey + ny * aw], [x1, y1], [ex - nx * aw, ey - ny * aw]);
  pts.push([ex - nx * hw, ey - ny * hw], [sx - nx * hw, sy - ny * hw]);
  if (arrowStart) pts.push([sx - nx * aw, sy - ny * aw], [x0, y0], [sx + nx * aw, sy + ny * aw]);
  return { closed: true, pts: pts.map(([x, y]) => corner(x, y)) };
}

/** Custom shapes, drawn in a 100 x 100 box. */
const CUSTOM: Record<string, () => Subpath[]> = {
  heart: () => [
    {
      closed: true,
      pts: [
        { x: 50, y: 28, ix: 50, iy: 28, ox: 58, oy: 8 },
        { x: 96, y: 26, ix: 82, iy: 0, ox: 104, oy: 48 },
        { x: 50, y: 94, ix: 70, iy: 76, ox: 50, oy: 94 },
        { x: 4, y: 26, ix: -4, iy: 48, ox: 18, oy: 0 },
      ].map((a) => ({ ...a, ix: a.ix, iy: a.iy })),
    },
  ],
  star: () => [polygonPath(0, 0, 100, 100, 5, 55)],
  arrow: () => [
    { closed: true, pts: ([[0, 35], [60, 35], [60, 10], [100, 50], [60, 90], [60, 65], [0, 65]] as [number, number][]).map(([x, y]) => corner(x, y)) },
  ],
  check: () => [
    { closed: true, pts: ([[4, 52], [18, 38], [38, 58], [82, 12], [96, 26], [38, 86]] as [number, number][]).map(([x, y]) => corner(x, y)) },
  ],
  speech: () => [
    {
      closed: true,
      pts: [
        { x: 50, y: 4, ix: 22, iy: 4, ox: 78, oy: 4 },
        { x: 96, y: 40, ix: 96, iy: 18, ox: 96, oy: 62 },
        { x: 50, y: 76, ix: 72, iy: 76, ox: 50, oy: 76 },
        corner(24, 96),
        { x: 30, y: 72, ix: 30, iy: 72, ox: 10, oy: 64 },
        { x: 4, y: 40, ix: 4, iy: 56, ox: 4, oy: 18 },
      ],
    },
  ],
  lightning: () => [{ closed: true, pts: ([[58, 0], [16, 56], [44, 56], [34, 100], [84, 38], [54, 38]] as [number, number][]).map(([x, y]) => corner(x, y)) }],
  cross: () => [{ closed: true, pts: ([[35, 0], [65, 0], [65, 35], [100, 35], [100, 65], [65, 65], [65, 100], [35, 100], [35, 65], [0, 65], [0, 35], [35, 35]] as [number, number][]).map(([x, y]) => corner(x, y)) }],
  ring: () => [ellipsePath(0, 0, 100, 100), reverseSubpath(ellipsePath(25, 25, 50, 50))],
};
export const CUSTOM_SHAPES = Object.keys(CUSTOM);
export const CUSTOM_SHAPE_LABELS: Record<string, string> = {
  heart: "Heart",
  star: "Star",
  arrow: "Arrow",
  check: "Check Mark",
  speech: "Speech Bubble",
  lightning: "Lightning",
  cross: "Cross",
  ring: "Ring",
};

export function reverseSubpath(s: Subpath): Subpath {
  return { closed: s.closed, pts: [...s.pts].reverse().map((a) => ({ x: a.x, y: a.y, ix: a.ox, iy: a.oy, ox: a.ix, oy: a.iy })) };
}

export function customShapePath(name: string, x: number, y: number, w: number, h: number): Subpath[] {
  const make = CUSTOM[name] ?? CUSTOM.heart;
  const p = mapPath({ subpaths: make() }, (px, py) => [x + (px / 100) * w, y + (py / 100) * h]);
  return p.subpaths;
}
