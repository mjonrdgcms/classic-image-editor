/**
 * Face-Aware Liquify: turn slider settings for each face (eye size, smile,
 * jawline...) into a smooth backward displacement field, built from the
 * face's 478 landmarks. The field adds to the Liquify brush field.
 *
 * Primitives are local, softly falling-off warps in the face's own frame
 * (so a tilted head is handled): scale about a point, move a region, and
 * rotate a region. Each is written backwards (the output pixel at p takes
 * its color from p + d), the same convention as the Liquify mesh.
 */

export type FaceGroup = "Eyes" | "Nose" | "Mouth" | "Face Shape";

export interface FaceSlider {
  id: string;
  label: string;
  group: FaceGroup;
  /** One value per eye (linked by default). */
  perEye?: boolean;
}

export const FACE_SLIDERS: FaceSlider[] = [
  { id: "eyeSize", label: "Eye Size", group: "Eyes", perEye: true },
  { id: "eyeHeight", label: "Eye Height", group: "Eyes", perEye: true },
  { id: "eyeWidth", label: "Eye Width", group: "Eyes", perEye: true },
  { id: "eyeTilt", label: "Eye Tilt", group: "Eyes", perEye: true },
  { id: "eyeDistance", label: "Eye Distance", group: "Eyes" },
  { id: "noseHeight", label: "Nose Height", group: "Nose" },
  { id: "noseWidth", label: "Nose Width", group: "Nose" },
  { id: "smile", label: "Smile", group: "Mouth" },
  { id: "upperLip", label: "Upper Lip", group: "Mouth" },
  { id: "lowerLip", label: "Lower Lip", group: "Mouth" },
  { id: "mouthWidth", label: "Mouth Width", group: "Mouth" },
  { id: "mouthHeight", label: "Mouth Height", group: "Mouth" },
  { id: "forehead", label: "Forehead", group: "Face Shape" },
  { id: "chinHeight", label: "Chin Height", group: "Face Shape" },
  { id: "jawline", label: "Jawline", group: "Face Shape" },
  { id: "faceWidth", label: "Face Width", group: "Face Shape" },
];

/** Slider values, -100..100. Per-eye sliders use id + "L" / id + "R" (image left / right). */
export type FaceAdjust = Record<string, number>;

type V = [number, number];

export interface FaceGeo {
  /** Unit vectors of the face frame: right (image-left eye to image-right eye) and up (toward the forehead). */
  right: V;
  up: V;
  /** Distance between the eye centers: the unit for every size here. */
  F: number;
  eyeL: { c: V; w: number };
  eyeR: { c: V; w: number };
  nose: V;
  noseTip: V;
  mouth: V;
  mouthL: V;
  mouthR: V;
  upperLip: V;
  lowerLip: V;
  chin: V;
  forehead: V;
  jawL: V;
  jawR: V;
  cheekL: V;
  cheekR: V;
  center: V;
  /** Rough outline of the face (for drawing and hit tests). */
  outline: V[];
}

// MediaPipe face mesh indices.
export const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

const P = (pts: Float32Array, i: number): V => [pts[i * 2], pts[i * 2 + 1]];
const mid = (a: V, b: V): V => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: V, b: V) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function faceGeometry(pts: Float32Array): FaceGeo {
  // Eye centers from the corners (works with or without iris points).
  const eA = mid(P(pts, 33), P(pts, 133)), eB = mid(P(pts, 362), P(pts, 263));
  const wA = dist(P(pts, 33), P(pts, 133)), wB = dist(P(pts, 362), P(pts, 263));
  const [eyeL, eyeR] = eA[0] <= eB[0] ? [{ c: eA, w: wA }, { c: eB, w: wB }] : [{ c: eB, w: wB }, { c: eA, w: wA }];
  const F = Math.max(1, dist(eyeL.c, eyeR.c));
  const right: V = [(eyeR.c[0] - eyeL.c[0]) / F, (eyeR.c[1] - eyeL.c[1]) / F];
  const up: V = [right[1], -right[0]];
  const lr = (a: number, b: number): [V, V] => {
    const pa = P(pts, a), pb = P(pts, b);
    const da = (pa[0] - eyeL.c[0]) * right[0] + (pa[1] - eyeL.c[1]) * right[1];
    const db = (pb[0] - eyeL.c[0]) * right[0] + (pb[1] - eyeL.c[1]) * right[1];
    return da <= db ? [pa, pb] : [pb, pa];
  };
  const [mouthL, mouthR] = lr(61, 291);
  const [jawL, jawR] = lr(172, 397);
  const [cheekL, cheekR] = lr(234, 454);
  const upperLip = P(pts, 0), lowerLip = P(pts, 17);
  const mouth = mid(P(pts, 13), P(pts, 14));
  return {
    right,
    up,
    F,
    eyeL,
    eyeR,
    nose: mid(P(pts, 1), P(pts, 2)),
    noseTip: P(pts, 1),
    mouth,
    mouthL,
    mouthR,
    upperLip,
    lowerLip,
    chin: P(pts, 152),
    forehead: P(pts, 10),
    jawL,
    jawR,
    cheekL,
    cheekR,
    center: mid(mid(eyeL.c, eyeR.c), mouth),
    outline: OVAL.map((i) => P(pts, i)),
  };
}

/** Soft bump: 1 at the center, 0 at radius 1. */
const bump = (t: number) => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));

interface Ctx {
  dx: Float32Array;
  dy: Float32Array;
  w: number;
  h: number;
  g: FaceGeo;
}

function region(c: Ctx, at: V, R: number, fn: (px: number, py: number, lx: number, ly: number, wt: number) => void) {
  const { w, h, g } = c;
  const x0 = Math.max(0, Math.floor(at[0] - R)), x1 = Math.min(w - 1, Math.ceil(at[0] + R));
  const y0 = Math.max(0, Math.floor(at[1] - R)), y1 = Math.min(h - 1, Math.ceil(at[1] + R));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const ox = x - at[0], oy = y - at[1];
      const t = Math.hypot(ox, oy) / R;
      if (t >= 1) continue;
      // Local coordinates in the face frame (lx along "right", ly along "up").
      const lx = ox * g.right[0] + oy * g.right[1];
      const ly = ox * g.up[0] + oy * g.up[1];
      fn(x, y, lx, ly, bump(t));
    }
}

/** Scale about `at` by (sx, sy) in the face frame, fading out by radius R. */
function scale(c: Ctx, at: V, R: number, sx: number, sy: number) {
  if (sx === 1 && sy === 1) return;
  const { g } = c;
  region(c, at, R, (x, y, lx, ly, wt) => {
    // Backward: sample nearer the center to enlarge.
    const ex = 1 + (sx - 1) * wt, ey = 1 + (sy - 1) * wt;
    const qx = lx / ex - lx, qy = ly / ey - ly;
    const i = y * c.w + x;
    c.dx[i] += qx * g.right[0] + qy * g.up[0];
    c.dy[i] += qx * g.right[1] + qy * g.up[1];
  });
}

/** Move the area around `at` by (tx, ty) in the face frame. */
function move(c: Ctx, at: V, R: number, tx: number, ty: number) {
  if (!tx && !ty) return;
  const { g } = c;
  const vx = tx * g.right[0] + ty * g.up[0], vy = tx * g.right[1] + ty * g.up[1];
  // Sample where this point came from; centering the falloff on the destination keeps the feature whole.
  const dest: V = [at[0] + vx * 0.5, at[1] + vy * 0.5];
  region(c, dest, R, (x, y, _lx, _ly, wt) => {
    const i = y * c.w + x;
    c.dx[i] -= vx * wt;
    c.dy[i] -= vy * wt;
  });
}

/** Rotate the area around `at` by angle a (radians), fading out by radius R. */
function rotate(c: Ctx, at: V, R: number, a: number) {
  if (!a) return;
  region(c, at, R, (x, y, _lx, _ly, wt) => {
    const t = -a * wt;
    const ox = x - at[0], oy = y - at[1];
    const cs = Math.cos(t), sn = Math.sin(t);
    const i = y * c.w + x;
    c.dx[i] += ox * cs - oy * sn - ox;
    c.dy[i] += ox * sn + oy * cs - oy;
  });
}

const v = (a: FaceAdjust, k: string) => (a[k] ?? 0) / 100;

/** Add one face's adjustments to the field (w x h, displacement in pixels). */
export function addFaceWarp(dx: Float32Array, dy: Float32Array, w: number, h: number, g: FaceGeo, a: FaceAdjust): void {
  const c: Ctx = { dx, dy, w, h, g };
  const F = g.F;
  for (const [side, eye, out] of [["L", g.eyeL, -1], ["R", g.eyeR, 1]] as const) {
    const R = Math.max(eye.w * 1.25, F * 0.32);
    const size = v(a, "eyeSize" + side), ht = v(a, "eyeHeight" + side), wd = v(a, "eyeWidth" + side);
    scale(c, eye.c, R, 1 + size * 0.28 + wd * 0.25, 1 + size * 0.28 + ht * 0.35);
    // Tilt: positive lifts the outer corners (mirror image on the two eyes).
    rotate(c, eye.c, R, -out * v(a, "eyeTilt" + side) * 0.2);
    move(c, eye.c, R, out * v(a, "eyeDistance") * F * 0.07, 0);
  }
  move(c, g.nose, F * 0.42, 0, v(a, "noseHeight") * F * 0.08);
  scale(c, g.noseTip, F * 0.45, 1 + v(a, "noseWidth") * 0.3, 1);
  const smile = v(a, "smile");
  move(c, g.mouthL, F * 0.3, -smile * F * 0.02, smile * F * 0.07);
  move(c, g.mouthR, F * 0.3, smile * F * 0.02, smile * F * 0.07);
  move(c, g.upperLip, F * 0.22, 0, v(a, "upperLip") * F * 0.045);
  move(c, g.lowerLip, F * 0.24, 0, -v(a, "lowerLip") * F * 0.05);
  scale(c, g.mouth, F * 0.62, 1 + v(a, "mouthWidth") * 0.22, 1);
  scale(c, g.mouth, F * 0.48, 1, 1 + v(a, "mouthHeight") * 0.35);
  move(c, g.forehead, F * 0.8, 0, v(a, "forehead") * F * 0.12);
  move(c, g.chin, F * 0.62, 0, -v(a, "chinHeight") * F * 0.13);
  const jaw = v(a, "jawline");
  move(c, g.jawL, F * 0.55, -jaw * F * 0.09, 0);
  move(c, g.jawR, F * 0.55, jaw * F * 0.09, 0);
  const fw = v(a, "faceWidth");
  move(c, g.cheekL, F * 0.8, -fw * F * 0.11, 0);
  move(c, g.cheekR, F * 0.8, fw * F * 0.11, 0);
}

export const isNeutral = (a: FaceAdjust) => Object.values(a).every((x) => !x);

/** The field for every face (pts in field pixels). */
export function faceField(faces: { geo: FaceGeo; adj: FaceAdjust }[], w: number, h: number): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(w * h), dy = new Float32Array(w * h);
  for (const f of faces) if (!isNeutral(f.adj)) addFaceWarp(dx, dy, w, h, f.geo, f.adj);
  return { dx, dy };
}
