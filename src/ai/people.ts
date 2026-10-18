/**
 * Finding people in a photo: which pixels are people, which person each
 * pixel belongs to, and which part of them it is (hair, face, skin,
 * clothes, accessories).
 *
 * A body-part segmenter (MediaPipe's selfie_multiclass model, passed in as
 * a function) runs once over the whole picture to find everyone. Each
 * head (a blob of hair and face skin) seeds one person, and a geodesic
 * flood that is cheap downwards and expensive across color edges splits
 * touching people. Then every person is segmented again from a close
 * crop, which recovers detail the whole-picture pass is too coarse for,
 * and a guided filter snaps the matte to the photo's real edges.
 *
 * Everything here is plain typed-array code with no browser APIs, so it
 * is unit-tested with a fake segmenter.
 */

import { boxBlur1, resizeBilinear, type Img } from "../filters/img";

/** Classes of the selfie_multiclass model. */
export const CLASS = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, accessories: 5 } as const;
export const PART_NAMES = ["hair", "faceSkin", "bodySkin", "clothes", "accessories"] as const;
export type PartName = (typeof PART_NAMES)[number];
export const PART_LABELS: Record<PartName, string> = { hair: "Hair", faceSkin: "Face", bodySkin: "Skin (Body)", clothes: "Clothes", accessories: "Accessories" };

/** Per-class confidence maps (6, each w*h) for an image. */
export interface SegOut {
  conf: Float32Array[];
}
export type Segmenter = (img: Img) => SegOut;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Person {
  /** Bounding box in analysis pixels. */
  box: Box;
  /** The head's box, when one was found. */
  head: Box | null;
  /** Share of the picture this person covers (0..1). */
  area: number;
}

export interface PeopleMap {
  /** Analysis size (the image scaled to at most ANALYSIS_MAX). */
  w: number;
  h: number;
  /** Coarse size of the ownership map. */
  gw: number;
  gh: number;
  /** Which person owns each coarse pixel (index + 1; 0 = nobody), grown a little past each body. */
  owner: Uint8Array;
  /** Soft person coverage at analysis size, 0..1, before edge refinement. */
  alpha: Float32Array;
  /** Each part's share of a person pixel, 0..255, at analysis size (PART_NAMES order). */
  parts: Uint8Array[];
  /** Guide statistics for the edge refinement (gray image, its local mean and variance). */
  guide: { I: Float32Array; mean: Float32Array; v: Float32Array; r: number };
  people: Person[];
}

export const ANALYSIS_MAX = 2048;
const GLOBAL_MAX = 1024;
const CROP_MAX = 640;

// ------------------------------------------------------------------ helpers

/** 8-connected components of a 0/1 mask. */
export function components(mask: Uint8Array, w: number, h: number): { label: Int32Array; comps: { area: number; box: Box; cx: number; cy: number }[] } {
  const label = new Int32Array(w * h);
  const comps: { area: number; box: Box; cx: number; cy: number }[] = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue;
    const id = comps.length + 1;
    let n = 0, sp = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack[sp++] = s;
    label[s] = id;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i / w) | 0;
      n++;
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !label[j]) {
            label[j] = id;
            stack[sp++] = j;
          }
        }
      }
    }
    comps.push({ area: n, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, cx: sx / n, cy: sy / n });
  }
  return { label, comps };
}

/**
 * Heads of people standing cheek to cheek merge into one wide blob. Cut
 * such blobs at the narrow necks of their column profile.
 */
export function splitWideHeads(hc: ReturnType<typeof components>, w: number): void {
  const n0 = hc.comps.length;
  for (let k = 0; k < n0; k++) {
    const c = hc.comps[k];
    const { box } = c;
    if (box.w < box.h * 1.3 || c.area < 60) continue;
    const id = k + 1;
    const col = new Float32Array(box.w);
    for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (hc.label[y * w + x] === id) col[x - box.x]++;
    // Smooth the profile over about a sixth of a head.
    const r = Math.max(1, Math.round(box.h * 0.08));
    const sm = new Float32Array(box.w);
    for (let x = 0; x < box.w; x++) {
      let s = 0, n = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < box.w) (s += col[xx]), n++;
      }
      sm[x] = s / n;
    }
    const cuts: number[] = [];
    const minW = Math.max(3, Math.round(box.h * 0.45));
    let last = 0;
    for (let x = minW; x < box.w - minW; x++) {
      if (x - last < minW) continue;
      if (!(sm[x] <= sm[x - 1] && sm[x] <= sm[x + 1])) continue;
      let lp = 0, rp = 0;
      for (let xx = last; xx < x; xx++) lp = Math.max(lp, sm[xx]);
      for (let xx = x + 1; xx < Math.min(box.w, x + box.h * 1.2); xx++) rp = Math.max(rp, sm[xx]);
      if (sm[x] < Math.min(lp, rp) * 0.6) {
        cuts.push(x);
        last = x;
      }
    }
    if (!cuts.length) continue;
    const edges = [0, ...cuts, box.w];
    for (let s = 1; s < edges.length - 1; s++) {
      const nid = hc.comps.length + 1;
      let area = 0, x0 = w, x1 = -1, y0 = Infinity, y1 = -1, sx = 0, sy = 0;
      for (let y = box.y; y < box.y + box.h; y++)
        for (let x = box.x + edges[s]; x < box.x + edges[s + 1]; x++) {
          const i = y * w + x;
          if (hc.label[i] !== id) continue;
          hc.label[i] = nid;
          area++;
          sx += x;
          sy += y;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      if (area) hc.comps.push({ area, box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, cx: sx / area, cy: sy / area });
      else hc.comps.push({ area: 0, box: { x: 0, y: 0, w: 0, h: 0 }, cx: 0, cy: 0 });
    }
    // What is left of the original blob.
    let area = 0, x0 = w, x1 = -1, y0 = Infinity, y1 = -1;
    for (let y = box.y; y < box.y + box.h; y++)
      for (let x = box.x; x < box.x + edges[1]; x++)
        if (hc.label[y * w + x] === id) {
          area++;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
    c.area = area;
    if (area) c.box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
}

const boxGap = (a: Box, b: Box) => {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
};
const unionBox = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/**
 * Grow seed labels through allowed pixels along the cheapest paths
 * (Dial's algorithm). Steps down are cheap, sideways dearer and up
 * dearest, so a body hangs below its own head; crossing a color edge
 * costs extra, so touching people part where their clothes change.
 */
export function geodesic(seeds: Int32Array, allowed: Uint8Array, rgb: Uint8ClampedArray, w: number, h: number, cols?: { cx: number; half: number }[]): Int32Array {
  const lab = new Int32Array(seeds);
  const dist = new Int32Array(w * h).fill(0x7fffffff);
  const NB = 512;
  const buckets: number[][] = Array.from({ length: NB }, () => []);
  let pending = 0;
  for (let i = 0; i < w * h; i++)
    if (lab[i]) {
      dist[i] = 0;
      buckets[0].push(i);
      pending++;
    }
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = rgb[i * 4] * 0.3 + rgb[i * 4 + 1] * 0.59 + rgb[i * 4 + 2] * 0.11;
  // [dx, dy, base cost]
  const steps: [number, number, number][] = [[0, 1, 6], [0, -1, 14], [1, 0, 10], [-1, 0, 10], [1, 1, 12], [-1, 1, 12], [1, -1, 17], [-1, -1, 17]];
  let d = 0;
  while (pending) {
    const b = buckets[d % NB];
    if (!b.length) {
      d++;
      continue;
    }
    const i = b.pop()!;
    pending--;
    if (dist[i] !== d) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [sx, sy, base] of steps) {
      const xx = x + sx, yy = y + sy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!allowed[j]) continue;
      const p = i * 4, q = j * 4;
      const cd = (Math.abs(rgb[p] - rgb[q]) + Math.abs(rgb[p + 1] - rgb[q + 1]) + Math.abs(rgb[p + 2] - rgb[q + 2])) / 3;
      let extra = 0;
      // Straying sideways far from one's own head is dear: a body hangs under its head.
      const col = cols?.[lab[i] - 1];
      if (col && sx && Math.abs(xx - col.cx) > col.half && Math.abs(xx - col.cx) > Math.abs(x - col.cx)) extra = 12;
      const nd = d + base + extra + Math.min(NB - 60, Math.round(cd * 1.2 + Math.abs(lum[i] - lum[j]) * 0.3));
      if (nd < dist[j]) {
        dist[j] = nd;
        lab[j] = lab[i];
        buckets[nd % NB].push(j);
        pending++;
      }
    }
  }
  return lab;
}

/** Spread labels into unlabeled pixels by up to r steps (multi-source BFS), so edges of a body have an owner. */
export function growLabels(lab: Int32Array, w: number, h: number, r: number): Int32Array {
  const out = new Int32Array(lab);
  let front: number[] = [];
  for (let i = 0; i < w * h; i++) if (out[i]) front.push(i);
  for (let s = 0; s < r && front.length; s++) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % w, y = (i / w) | 0;
      const v = out[i];
      if (x > 0 && !out[i - 1]) (out[i - 1] = v), next.push(i - 1);
      if (x < w - 1 && !out[i + 1]) (out[i + 1] = v), next.push(i + 1);
      if (y > 0 && !out[i - w]) (out[i - w] = v), next.push(i - w);
      if (y < h - 1 && !out[i + w]) (out[i + w] = v), next.push(i + w);
    }
    front = next;
  }
  return out;
}

/** Bilinear sample of a w*h float map at (x, y). */
function sampleF(a: Float32Array, w: number, h: number, x: number, y: number): number {
  x = Math.max(0, Math.min(w - 1, x));
  y = Math.max(0, Math.min(h - 1, y));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  return (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
}

function crop(img: Img, b: Box): Img {
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) out.set(img.data.subarray(((b.y + y) * img.w + b.x) * 4, ((b.y + y) * img.w + b.x + b.w) * 4), y * b.w * 4);
  return { w: b.w, h: b.h, data: out };
}

function grayOf(img: Img): Float32Array {
  const g = new Float32Array(img.w * img.h);
  for (let i = 0; i < g.length; i++) g[i] = (img.data[i * 4] * 0.299 + img.data[i * 4 + 1] * 0.587 + img.data[i * 4 + 2] * 0.114) / 255;
  return g;
}

/** Box mean of a float map with a radius r (two box passes along each axis). */
const boxMean = (a: Float32Array, w: number, h: number, r: number) => boxBlur1(a, w, h, r);

/** Scale an image so its long side is at most max. */
export function fitImg(img: Img, max: number): Img {
  const k = Math.min(1, max / Math.max(img.w, img.h));
  if (k >= 1) return img;
  return resizeBilinear(img, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k)));
}

// ------------------------------------------------------------------ analysis

/** Find the people in img (any size; it is scaled to ANALYSIS_MAX first). */
export async function analyzePeople(full: Img, segment: Segmenter, step: (done: number, label: string) => unknown = () => {}): Promise<PeopleMap> {
  await step(0, "Looking for people");
  const A = fitImg(full, ANALYSIS_MAX);
  const G = fitImg(A, GLOBAL_MAX);
  const gw = G.w, gh = G.h, gn = gw * gh;
  const sg = segment(G);
  await step(0.25, "Telling people apart");
  const prob = new Float32Array(gn);
  const cat = new Uint8Array(gn);
  for (let i = 0; i < gn; i++) {
    prob[i] = 1 - sg.conf[0][i];
    let best = 0, bv = -1;
    for (let c = 0; c < 6; c++)
      if (sg.conf[c][i] > bv) {
        bv = sg.conf[c][i];
        best = c;
      }
    cat[i] = best;
  }

  // ---- heads: blobs of hair and face skin
  const headMask = new Uint8Array(gn);
  // Person blobs.
  const allowed = new Uint8Array(gn);
  for (let i = 0; i < gn; i++) allowed[i] = prob[i] > 0.4 ? 1 : 0;
  const pc = components(allowed, gw, gh);
  // Hats and glasses count as head too, when they touch hair or face (a bag on its own does not).
  for (let i = 0; i < gn; i++) headMask[i] = (cat[i] === CLASS.hair || cat[i] === CLASS.faceSkin || cat[i] === CLASS.accessories) && prob[i] > 0.5 ? 1 : 0;
  const hc = components(headMask, gw, gh);
  {
    const hf = new Int32Array(hc.comps.length + 1);
    for (let i = 0; i < gn; i++) if (hc.label[i] && cat[i] !== CLASS.accessories) hf[hc.label[i]]++;
    hc.comps.forEach((c, k) => {
      if (hf[k + 1] >= c.area * 0.25) return;
      // Mostly hat: keep it only if it is on top of someone (open background above it).
      const { box } = c;
      const reach = Math.max(2, Math.round(box.h * 0.5));
      let cols = 0, open = 0;
      for (let x = box.x; x < box.x + box.w; x++) {
        let top = -1;
        for (let y = box.y; y < box.y + box.h; y++)
          if (hc.label[y * gw + x] === k + 1) {
            top = y;
            break;
          }
        if (top < 0) continue;
        cols++;
        let bg = 0, n = 0;
        for (let y = Math.max(0, top - reach); y < top; y++) {
          n++;
          if (prob[y * gw + x] < 0.4) bg++;
        }
        if (top === 0 || (n && bg >= n * 0.7)) open++;
      }
      // ...and in the upper part of that person's blob (shoes are open above too).
      const pb = pc.comps[pc.label[Math.round(c.cy) * gw + Math.round(c.cx)] - 1]?.box;
      const high = !pb || c.box.y <= pb.y + pb.h * 0.4;
      if (!cols || open < cols * 0.4 || !high) c.area = 0;
    });
  }
  const minHead = Math.max(10, gn * 0.00002);
  splitWideHeads(hc, gw);
  type Head = { ids: number[]; area: number; box: Box; face: number };
  let heads: Head[] = [];
  const faceCount = new Int32Array(hc.comps.length + 1);
  for (let i = 0; i < gn; i++) if (hc.label[i] && cat[i] === CLASS.faceSkin) faceCount[hc.label[i]]++;
  hc.comps.forEach((c, k) => {
    if (c.area >= minHead) heads.push({ ids: [k + 1], area: c.area, box: c.box, face: faceCount[k + 1] });
  });
  // Fold fragments (a hand labeled as face, hair split by glasses) into a much larger head nearby.
  heads.sort((a, b) => b.area - a.area);
  const kept: Head[] = [];
  for (const hd of heads) {
    const host = kept.find((k) => k.area >= hd.area * 3 && boxGap(k.box, hd.box) <= Math.sqrt(k.area) * 0.6);
    if (host) {
      host.ids.push(...hd.ids);
      host.area += hd.area;
      host.face += hd.face;
      host.box = unionBox(host.box, hd.box);
      continue;
    }
    // People near each other have heads of about the same size, so a much smaller
    // blob among big heads is a hand or a patterned shirt, not a head.
    if (kept.some((k) => k.area >= hd.area * 8 && boxGap(k.box, hd.box) <= Math.sqrt(k.area) * 2)) continue;
    kept.push(hd);
  }
  heads = kept;

  // ---- people: grow each head through the person mask
  const seeds = new Int32Array(gn);
  const headOf = new Int32Array(hc.comps.length + 1);
  heads.forEach((hd, k) => hd.ids.forEach((id) => (headOf[id] = k + 1)));
  for (let i = 0; i < gn; i++) if (hc.label[i] && headOf[hc.label[i]]) seeds[i] = headOf[hc.label[i]];
  // Person blobs with no head: a separate person if big enough, else a piece of the nearest one.
  const seeded = new Uint8Array(pc.comps.length + 1);
  for (let i = 0; i < gn; i++) if (seeds[i] && pc.label[i]) seeded[pc.label[i]] = 1;
  const minPerson = Math.max(40, gn * 0.0008);
  let next = heads.length;
  const extra: { comp: number; label: number }[] = [];
  pc.comps.forEach((c, k) => {
    if (seeded[k + 1]) return;
    if (c.area >= minPerson && (heads.length === 0 || c.area >= minPerson * 4)) extra.push({ comp: k + 1, label: ++next });
  });
  for (let i = 0; i < gn; i++) {
    const c = pc.label[i];
    if (!c || seeded[c]) continue;
    const e = extra.find((x) => x.comp === c);
    if (e) seeds[i] = e.label;
  }
  // Small headless blobs stay unowned (they still count when everyone is picked).
  const cols = heads.map((hd) => ({ cx: hd.box.x + hd.box.w / 2, half: Math.max(3, hd.box.w * 1.3) }));
  for (let k = heads.length; k < next; k++) cols.push({ cx: 0, half: Infinity });
  const lab = geodesic(seeds, allowed, G.data, gw, gh, cols);
  const hasPixels = new Int32Array(next + 1);
  for (let i = 0; i < gn; i++) if (lab[i]) hasPixels[lab[i]]++;

  // ---- order people left to right and drop empties
  const boxes: (Box | null)[] = new Array(next + 1).fill(null);
  for (let i = 0; i < gn; i++) {
    const l = lab[i];
    if (!l) continue;
    const x = i % gw, y = (i / gw) | 0;
    const b = boxes[l];
    boxes[l] = b ? unionBox(b, { x, y, w: 1, h: 1 }) : { x, y, w: 1, h: 1 };
  }
  const order: number[] = [];
  for (let l = 1; l <= next; l++) if (hasPixels[l] >= Math.max(12, minPerson * 0.25) && boxes[l]) order.push(l);
  order.sort((a, b) => boxes[a]!.x + boxes[a]!.w / 2 - (boxes[b]!.x + boxes[b]!.w / 2));
  const remap = new Uint8Array(next + 1);
  order.slice(0, 250).forEach((l, k) => (remap[l] = k + 1));
  const owned = new Int32Array(gn);
  for (let i = 0; i < gn; i++) owned[i] = remap[lab[i]];
  const R = Math.max(2, Math.round(Math.max(gw, gh) * 0.02));
  const ownerI = growLabels(owned, gw, gh, R);
  const owner = new Uint8Array(gn);
  for (let i = 0; i < gn; i++) owner[i] = ownerI[i];

  const sx = A.w / gw, sy = A.h / gh;
  const scaleBox = (b: Box): Box => ({ x: Math.floor(b.x * sx), y: Math.floor(b.y * sy), w: Math.ceil(b.w * sx), h: Math.ceil(b.h * sy) });
  const people: Person[] = order.slice(0, 250).map((l) => ({
    box: scaleBox(boxes[l]!),
    head: l <= heads.length ? scaleBox(heads[l - 1].box) : null,
    area: hasPixels[l] / gn,
  }));

  // ---- coverage and parts at analysis size, from the whole-picture pass
  const aw = A.w, ah = A.h, an = aw * ah;
  const alpha = new Float32Array(an);
  const parts = PART_NAMES.map(() => new Uint8Array(an));
  const partIdx = PART_NAMES.map((n) => CLASS[n]);
  const fill = (dst: number, conf: Float32Array[], cw: number, ch: number, fx: number, fy: number, setAlpha: boolean) => {
    const bg = sampleF(conf[0], cw, ch, fx, fy);
    if (setAlpha) alpha[dst] = 1 - bg;
    const tot = Math.max(1e-4, 1 - bg);
    for (let k = 0; k < 5; k++) parts[k][dst] = Math.min(255, Math.round((sampleF(conf[partIdx[k]], cw, ch, fx, fy) / tot) * 255));
  };
  for (let y = 0; y < ah; y++)
    for (let x = 0; x < aw; x++) fill(y * aw + x, sg.conf, gw, gh, (x + 0.5) / sx - 0.5, (y + 0.5) / sy - 0.5, true);

  // ---- close-up pass per person
  const acc = new Float32Array(an);
  const wsum = new Float32Array(an);
  for (let k = 0; k < people.length; k++) {
    const p = people[k];
    await step(0.3 + (0.6 * k) / people.length, `Refining person ${k + 1} of ${people.length}`);
    if (p.box.h < 40 && p.box.w < 40) continue;
    const pad = Math.round(Math.max(p.box.w, p.box.h) * 0.12) + 6;
    const bx = Math.max(0, p.box.x - pad), by = Math.max(0, p.box.y - pad);
    const b: Box = { x: bx, y: by, w: Math.min(aw, p.box.x + p.box.w + pad) - bx, h: Math.min(ah, p.box.y + p.box.h + pad) - by };
    const c = fitImg(crop(A, b), CROP_MAX);
    const so = segment(c);
    const kx = c.w / b.w, ky = c.h / b.h;
    const id = k + 1;
    const edge = Math.max(4, Math.min(b.w, b.h) * 0.06);
    for (let y = 0; y < b.h; y++) {
      const gy = (b.y + y + 0.5) / sy - 0.5;
      for (let x = 0; x < b.w; x++) {
        const gx = (b.x + x + 0.5) / sx - 0.5;
        // Ownership: bilinear share of coarse pixels that belong to this person.
        const x0 = Math.max(0, Math.min(gw - 1, Math.floor(gx))), y0 = Math.max(0, Math.min(gh - 1, Math.floor(gy)));
        const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
        const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
        const o =
          ((owner[y0 * gw + x0] === id ? 1 - fx : 0) + (owner[y0 * gw + x1] === id ? fx : 0)) * (1 - fy) +
          ((owner[y1 * gw + x0] === id ? 1 - fx : 0) + (owner[y1 * gw + x1] === id ? fx : 0)) * fy;
        if (o <= 0) continue;
        // Trust the close-up less near its own border, where it lacks context (unless that is the picture's edge).
        const ex = Math.min(b.x === 0 ? edge : x, b.x + b.w === aw ? edge : b.w - 1 - x);
        const ey = Math.min(b.y === 0 ? edge : y, b.y + b.h === ah ? edge : b.h - 1 - y);
        const we = Math.min(1, Math.min(ex, ey) / edge);
        const wt = o * we;
        if (wt <= 0) continue;
        const i = (b.y + y) * aw + b.x + x;
        const cx = (x + 0.5) * kx - 0.5, cy = (y + 0.5) * ky - 0.5;
        acc[i] += wt * (1 - sampleF(so.conf[0], c.w, c.h, cx, cy));
        wsum[i] += wt;
        if (o > 0.5 && we > 0.3) fill(i, so.conf, c.w, c.h, cx, cy, false);
      }
    }
  }
  // Faint, unowned responses (a pole, a cable car) are noise, not people.
  for (let y = 0; y < ah; y++) {
    const gy = Math.min(gh - 1, Math.floor((y + 0.5) / sy));
    for (let x = 0; x < aw; x++) {
      const i = y * aw + x;
      const a = alpha[i];
      if (a >= 0.5 || owner[gy * gw + Math.min(gw - 1, Math.floor((x + 0.5) / sx))]) continue;
      const t = Math.max(0, Math.min(1, (a - 0.25) / 0.25));
      alpha[i] = a * t * t * (3 - 2 * t);
    }
  }
  await step(0.92, "Finding edges");
  for (let i = 0; i < an; i++) {
    const ws = wsum[i];
    if (ws > 0) alpha[i] = alpha[i] + (acc[i] / ws - alpha[i]) * Math.min(1, ws);
  }

  // ---- guide statistics for edge refinement
  const r = Math.max(2, Math.round(Math.max(aw, ah) / 400));
  const I = grayOf(A);
  const mean = boxMean(I, aw, ah, r);
  const II = new Float32Array(an);
  for (let i = 0; i < an; i++) II[i] = I[i] * I[i];
  const mII = boxMean(II, aw, ah, r);
  const v = new Float32Array(an);
  for (let i = 0; i < an; i++) v[i] = Math.max(0, mII[i] - mean[i] * mean[i]);
  return { w: aw, h: ah, gw, gh, owner, alpha, parts, guide: { I, mean, v, r }, people };
}

// ------------------------------------------------------------------ selections

export interface PeoplePick {
  /** Person indices (0-based); null = everyone. */
  people: number[] | null;
  /** Parts to include; null = whole person. */
  parts: PartName[] | null;
  /** Edge refinement on (default) or off. */
  refine?: boolean;
}

/** Soft ownership (0..1) of the picked people at analysis pixel (x, y). */
function ownership(m: PeopleMap, picked: Uint8Array, x: number, y: number): number {
  const gx = ((x + 0.5) * m.gw) / m.w - 0.5, gy = ((y + 0.5) * m.gh) / m.h - 0.5;
  const x0 = Math.max(0, Math.min(m.gw - 1, Math.floor(gx))), y0 = Math.max(0, Math.min(m.gh - 1, Math.floor(gy)));
  const x1 = Math.min(m.gw - 1, x0 + 1), y1 = Math.min(m.gh - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
  const o = m.owner, w = m.gw;
  return (picked[o[y0 * w + x0]] * (1 - fx) + picked[o[y0 * w + x1]] * fx) * (1 - fy) + (picked[o[y1 * w + x0]] * (1 - fx) + picked[o[y1 * w + x1]] * fx) * fy;
}

/** The matte (0..1, analysis size) for some people and parts. */
export function peopleMatte(m: PeopleMap, pick: PeoplePick): Float32Array {
  const n = m.w * m.h;
  const picked = new Uint8Array(256);
  if (pick.people) for (const i of pick.people) picked[i + 1] = 1;
  else picked.fill(1, 1);
  const whole = !pick.parts || pick.parts.length >= PART_NAMES.length;
  const pk = whole ? [] : pick.parts!.map((p) => PART_NAMES.indexOf(p)).filter((k) => k >= 0);
  const p = new Float32Array(n);
  const allPeople = !pick.people;
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      let a = m.alpha[i];
      if (a <= 0.003) continue;
      if (!allPeople) {
        a *= ownership(m, picked, x, y);
        if (a <= 0) continue;
      }
      if (!whole) {
        let s = 0;
        for (const k of pk) s += m.parts[k][i];
        a *= Math.min(1, s / 255);
      }
      p[i] = a;
    }
  if (pick.refine === false) return p;
  return refineMatte(m, p);
}

/** Guided filter (He et al.) of a matte against the photo, then a gentle contrast so edges stay crisp. */
export function refineMatte(m: PeopleMap, p: Float32Array): Float32Array {
  const { w, h } = m;
  const { I, mean, v, r } = m.guide;
  const n = w * h;
  const eps = 0.0008;
  const mp = boxMean(p, w, h, r);
  const ip = new Float32Array(n);
  for (let i = 0; i < n; i++) ip[i] = I[i] * p[i];
  const mip = boxMean(ip, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ai = (mip[i] - mean[i] * mp[i]) / (v[i] + eps);
    a[i] = ai;
    b[i] = mp[i] - ai * mean[i];
  }
  const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let t = ma[i] * I[i] + mb[i];
    // Where the raw matte is sure, keep it; the filter only reshapes the uncertain edge.
    const raw = p[i];
    const sure = Math.abs(raw - 0.5) * 2;
    t = t + (raw - t) * sure * sure * 0.5;
    t = (t - 0.08) / 0.84;
    q[i] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  }
  return q;
}

/** Scale a matte (analysis size) to W x H bytes. */
export function matteToMask(matte: Float32Array, mw: number, mh: number, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const kx = mw / W, ky = mh / H;
  for (let y = 0; y < H; y++) {
    const sy = (y + 0.5) * ky - 0.5;
    for (let x = 0; x < W; x++) out[y * W + x] = Math.round(sampleF(matte, mw, mh, (x + 0.5) * kx - 0.5, sy) * 255);
  }
  return out;
}
