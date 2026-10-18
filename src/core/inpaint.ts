/**
 * Filling holes from the rest of the picture (Content-Aware Fill, the Spot
 * Healing Brush) and seamless blending (the Healing Brush).
 *
 * inpaint() is PatchMatch-based image completion (Barnes et al. 2009, with
 * Wexler-style voting): on a pyramid from coarse to fine, every patch that
 * touches the hole finds the most similar patch elsewhere, and each hole
 * pixel becomes the weighted vote of the patches covering it. Repeating
 * that converges on texture that continues the surroundings.
 *
 * healBlend() keeps the detail of a source and takes its light and color
 * from the destination: the difference between them along the area's edge
 * is spread smoothly over the inside (a membrane / Poisson-style blend).
 */

export interface InpaintInput {
  w: number;
  h: number;
  /** Straight RGBA. Hole pixels are ignored. */
  data: Uint8ClampedArray;
  /** 1 where to fill. */
  hole: Uint8Array;
  /** 1 where pixels may be copied from (default: everything outside the hole). */
  allowed?: Uint8Array;
}

export interface InpaintOptions {
  /** Patch size (odd). */
  patch?: number;
  /** EM iterations at the finest level (coarser levels get more). */
  iterations?: number;
  seed?: number;
  /** How much matching cares about texture versus color (0 = color only, default 2). */
  texture?: number;
}

type Level = { w: number; h: number; img: Float32Array; hole: Uint8Array; allowed: Uint8Array };

/** Channels per pixel: premultiplied RGB, alpha, and two texture features. */
const CH = 6;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function toFloat(data: Uint8ClampedArray, n: number): Float32Array {
  const f = new Float32Array(n * CH);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    // Premultiply so transparent areas don't carry stray color; alpha weighs as a channel.
    f[i * CH] = (data[i * 4] * a) / 255;
    f[i * CH + 1] = (data[i * 4 + 1] * a) / 255;
    f[i * CH + 2] = (data[i * 4 + 2] * a) / 255;
    f[i * CH + 3] = a;
  }
  return f;
}

/**
 * Texture features (after Newson et al.): local average of the absolute
 * gradient in x and y. Matching on these keeps fills from washing out into
 * flat color, because a smooth patch no longer looks like a textured one.
 * Hole pixels get theirs by voting, like color.
 */
function addFeatures(L: Level, weight: number): void {
  const { w, h, img, hole } = L;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = img[i * CH] * 0.3 + img[i * CH + 1] * 0.59 + img[i * CH + 2] * 0.11;
  const gx = new Float32Array(n), gy = new Float32Array(n), ok = new Uint8Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      const l = x > 0 && !hole[i - 1] ? i - 1 : i, r = x < w - 1 && !hole[i + 1] ? i + 1 : i;
      const u = y > 0 && !hole[i - w] ? i - w : i, d = y < h - 1 && !hole[i + w] ? i + w : i;
      gx[i] = Math.abs(lum[r] - lum[l]) / Math.max(1, r - l);
      gy[i] = Math.abs(lum[d] - lum[u]) / Math.max(1, (d - u) / w);
      ok[i] = 1;
    }
  // Box average (radius 2) over known pixels.
  const R = 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      let sx = 0, sy = 0, m = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!ok[j]) continue;
          sx += gx[j];
          sy += gy[j];
          m++;
        }
      }
      img[i * CH + 4] = m ? (sx / m) * weight : 0;
      img[i * CH + 5] = m ? (sy / m) * weight : 0;
    }
}

function downLevel(L: Level): Level {
  const w = Math.max(1, L.w >> 1), h = Math.max(1, L.h >> 1);
  const img = new Float32Array(w * h * CH), hole = new Uint8Array(w * h), allowed = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0, anyHole = 0, allAllowed = 1;
      const acc = new Float64Array(CH);
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(L.w - 1, x * 2 + dx), sy = Math.min(L.h - 1, y * 2 + dy);
          const i = sy * L.w + sx;
          if (L.hole[i]) anyHole = 1;
          if (!L.allowed[i]) allAllowed = 0;
          if (!L.hole[i]) {
            for (let c = 0; c < CH; c++) acc[c] += L.img[i * CH + c];
            n++;
          }
        }
      const o = y * w + x;
      hole[o] = anyHole;
      allowed[o] = allAllowed && !anyHole ? 1 : 0;
      if (n) for (let c = 0; c < CH; c++) img[o * CH + c] = acc[c] / n;
    }
  return { w, h, img, hole, allowed };
}

/** Fill hole pixels by repeatedly averaging their known neighbors (onion peel). */
function diffuseFill(L: Level): void {
  const { w, h, img } = L;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = L.hole[i] ? 0 : 1;
  let remaining = 0;
  for (let i = 0; i < w * h; i++) if (!known[i]) remaining++;
  let guard = w + h + 4;
  while (remaining > 0 && guard-- > 0) {
    const next: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let n = 0;
        const acc = new Float64Array(CH);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            for (let c = 0; c < CH; c++) acc[c] += img[j * CH + c];
            n++;
          }
        if (n) {
          for (let c = 0; c < CH; c++) img[i * CH + c] = acc[c] / n;
          next.push(i);
        }
      }
    if (!next.length) break;
    for (const i of next) known[i] = 1;
    remaining -= next.length;
  }
}

/** Centers whose whole patch is allowed (and inside the image). */
function validCenters(L: Level, r: number): Uint8Array {
  const { w, h } = L;
  // Summed-area table of NOT allowed.
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += L.allowed[y * w + x] ? 0 : 1;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const v = new Uint8Array(w * h);
  for (let y = r; y < h - r; y++)
    for (let x = r; x < w - r; x++) {
      const x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
      const bad = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      if (!bad) v[y * w + x] = 1;
    }
  return v;
}

/**
 * Fill the hole. Returns the region's RGBA with the hole replaced. If there
 * is nothing usable to copy from, the hole is filled by smooth diffusion.
 */
export function inpaint(input: InpaintInput, opts: InpaintOptions = {}): Uint8ClampedArray {
  const { w, h } = input;
  const n = w * h;
  const P = Math.max(3, (opts.patch ?? 7) | 1);
  const r = P >> 1;
  const rand = rng(opts.seed ?? 12345);
  const allowed0 = input.allowed ?? (() => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = input.hole[i] ? 0 : 1;
    return a;
  })();
  const base: Level = { w, h, img: toFloat(input.data, n), hole: input.hole.slice(), allowed: allowed0.slice() };
  for (let i = 0; i < n; i++) if (base.hole[i]) base.allowed[i] = 0;
  // Pyramid: shrink while the hole stays more than a patch wide and there is
  // still room for plenty of source patches.
  let hx0 = w, hy0 = h, hx1 = -1, hy1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (input.hole[y * w + x]) {
        if (x < hx0) hx0 = x;
        if (x > hx1) hx1 = x;
        if (y < hy0) hy0 = y;
        if (y > hy1) hy1 = y;
      }
  let holeSize = Math.max(hx1 - hx0 + 1, hy1 - hy0 + 1, 1);
  const levels: Level[] = [base];
  while (levels.length < 8) {
    const L = levels[levels.length - 1];
    if (holeSize / 2 < 2 || Math.min(L.w, L.h) / 2 < P * 2) break;
    levels.push(downLevel(L));
    holeSize /= 2;
  }
  for (const L of levels) addFeatures(L, opts.texture ?? 2);
  // Start at the coarsest level with a smooth guess.
  let nnf: Int32Array | null = null;
  let prev: Level | null = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const { w: lw, h: lh, img, hole } = L;
    if (prev) {
      // Hole pixels start from the coarser result, scaled up.
      for (let y = 0; y < lh; y++)
        for (let x = 0; x < lw; x++) {
          const i = y * lw + x;
          if (!hole[i]) continue;
          const px = Math.min(prev.w - 1, x >> 1), py = Math.min(prev.h - 1, y >> 1);
          for (let c = 0; c < CH; c++) img[i * CH + c] = prev.img[(py * prev.w + px) * CH + c];
        }
    } else diffuseFill(L);
    const valid = validCenters(L, r);
    const validList: number[] = [];
    for (let i = 0; i < lw * lh; i++) if (valid[i]) validList.push(i);
    if (!validList.length) {
      // Nothing to copy from at this size: keep the smooth fill.
      if (!prev) diffuseFill(L);
      prev = L;
      nnf = null;
      continue;
    }
    // Targets: every center whose patch touches the hole.
    const target = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        if (!hole[y * lw + x]) continue;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < lw && yy < lh) target[yy * lw + xx] = 1;
          }
      }
    const tlist: number[] = [];
    for (let i = 0; i < lw * lh; i++) if (target[i]) tlist.push(i);
    // NNF: source center for each target center.
    const nf = new Int32Array(lw * lh).fill(-1);
    const nd = new Float32Array(lw * lh).fill(Infinity);
    const dist = (t: number, s: number, cap: number): number => {
      const tx = t % lw, ty = (t / lw) | 0, sx = s % lw, sy = (s / lw) | 0;
      let d = 0, cnt = 0;
      const capAll = cap * P * P;
      for (let dy = -r; dy <= r; dy++) {
        const yy = ty + dy;
        if (yy < 0 || yy >= lh) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx;
          if (xx < 0 || xx >= lw) continue;
          const a = (yy * lw + xx) * CH, b = ((sy + dy) * lw + sx + dx) * CH;
          for (let c = 0; c < CH; c++) {
            const e = img[a + c] - img[b + c];
            d += e * e;
          }
          cnt++;
        }
        // Early out: the mean can't come back under the cap.
        if (d > capAll) return Infinity;
      }
      return d / Math.max(1, cnt);
    };
    const tryS = (t: number, s: number) => {
      if (s < 0 || !valid[s] || s === nf[t]) return;
      const d = dist(t, s, nd[t]);
      if (d < nd[t]) {
        nd[t] = d;
        nf[t] = s;
      }
    };
    for (const t of tlist) {
      let s = -1;
      if (nnf && prev) {
        // From the coarser level: same offset, doubled.
        const tx = t % lw, ty = (t / lw) | 0;
        const ct = Math.min(prev.h - 1, ty >> 1) * prev.w + Math.min(prev.w - 1, tx >> 1);
        const cs = nnf[ct];
        if (cs >= 0) {
          const sx = (cs % prev.w) * 2 + (tx & 1), sy = ((cs / prev.w) | 0) * 2 + (ty & 1);
          if (sx < lw && sy < lh && valid[sy * lw + sx]) s = sy * lw + sx;
        }
      }
      if (s < 0) s = validList[(rand() * validList.length) | 0];
      nf[t] = s;
      nd[t] = dist(t, s, Infinity);
    }
    // Vote: each hole pixel becomes the weighted average of what the patches covering it suggest.
    const vote = (sharpness: number) => {
      const sorted = Float32Array.from(tlist.map((t) => nd[t])).sort();
      const sigma = Math.max(1, sorted[Math.floor(sorted.length * 0.75)] || 1) / sharpness;
      const acc = new Float32Array(lw * lh * CH), wsum = new Float32Array(lw * lh);
      for (const t of tlist) {
        const s = nf[t];
        if (s < 0) continue;
        const wgt = Math.exp(-nd[t] / (2 * sigma)) + 1e-12;
        const tx = t % lw, ty = (t / lw) | 0, sx = s % lw, sy = (s / lw) | 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = ty + dy;
          if (yy < 0 || yy >= lh) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = tx + dx;
            if (xx < 0 || xx >= lw) continue;
            const i = yy * lw + xx;
            if (!hole[i]) continue;
            const b = ((sy + dy) * lw + sx + dx) * CH;
            for (let c = 0; c < CH; c++) acc[i * CH + c] += img[b + c] * wgt;
            wsum[i] += wgt;
          }
        }
      }
      for (let i = 0; i < lw * lh; i++) if (hole[i] && wsum[i] > 0) for (let c = 0; c < CH; c++) img[i * CH + c] = acc[i * CH + c] / wsum[i];
      // Distances change with the new pixels.
      for (const t of tlist) if (nf[t] >= 0) nd[t] = dist(t, nf[t], Infinity);
    };
    // Rebuild this level's hole from the coarser matches at full detail.
    if (nnf) vote(1);
    // Big holes at full size get fewer rounds; the coarse levels already settled the layout.
    const base = (opts.iterations ?? 4) + Math.min(6, li * 2);
    const iters = tlist.length > 150000 ? 1 : tlist.length > 60000 ? Math.min(base, 2) : base;
    const maxR = Math.max(lw, lh);
    for (let it = 0; it < iters; it++) {
      // PatchMatch: propagate good offsets from neighbors, then search randomly.
      for (let pass = 0; pass < 2; pass++) {
        const fwd = (it + pass) % 2 === 0;
        for (let k = 0; k < tlist.length; k++) {
          const t = tlist[fwd ? k : tlist.length - 1 - k];
          const tx = t % lw, ty = (t / lw) | 0;
          const st = fwd ? -1 : 1;
          for (const [nx, ny] of [
            [tx + st, ty],
            [tx, ty + st],
          ]) {
            if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
            const ns = nf[ny * lw + nx];
            if (ns < 0) continue;
            // The neighbor's source, shifted back by the neighbor offset.
            const cx = (ns % lw) + (tx - nx), cy = ((ns / lw) | 0) + (ty - ny);
            if (cx >= 0 && cy >= 0 && cx < lw && cy < lh) tryS(t, cy * lw + cx);
          }
          let rad = maxR;
          const bx = nf[t] % lw, by = (nf[t] / lw) | 0;
          while (rad >= 1) {
            const cx = Math.round(bx + (rand() * 2 - 1) * rad), cy = Math.round(by + (rand() * 2 - 1) * rad);
            if (cx >= 0 && cy >= 0 && cx < lw && cy < lh) tryS(t, cy * lw + cx);
            rad *= 0.5;
          }
        }
      }
      // The last pass at full size favors the best matches, which keeps detail crisp.
      vote(li === 0 && it === iters - 1 ? 4 : 1);
    }
    nnf = nf;
    prev = L;
  }
  // Back to straight RGBA.
  const out = new Uint8ClampedArray(input.data);
  const img = base.img;
  for (let i = 0; i < n; i++) {
    if (!input.hole[i]) continue;
    const a = img[i * CH + 3];
    out[i * 4 + 3] = a;
    if (a > 0.5) for (let c = 0; c < 3; c++) out[i * 4 + c] = (img[i * CH + c] * 255) / a;
  }
  return out;
}

// ------------------------------------------------------------------ seamless blend

/**
 * Put `src` into `dst` where `mask` (0..1) says, keeping src's detail but
 * matching dst's light and color: the difference dst - src along the edge
 * of the mask is spread smoothly inside. Both RGBA straight, same size.
 */
export function healBlend(dst: Uint8ClampedArray, src: Uint8ClampedArray, mask: Float32Array, w: number, h: number): Uint8ClampedArray {
  const n = w * h;
  // Inside = clearly in the mask; the boundary = known pixels next to it.
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = mask[i] > 0.01 ? 1 : 0;
  // Solve on a coarse grid (the membrane is smooth), then scale up.
  const k = Math.min(1, 96 / Math.max(w, h));
  const cw = Math.max(2, Math.round(w * k)), chh = Math.max(2, Math.round(h * k));
  const cIn = new Uint8Array(cw * chh);
  const diff = new Float32Array(cw * chh * 4);
  const fixed = new Uint8Array(cw * chh);
  const cnt = new Float32Array(cw * chh);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cw - 1, Math.floor(x * k)), cy = Math.min(chh - 1, Math.floor(y * k));
      const ci = cy * cw + cx, i = y * w + x;
      if (inside[i]) cIn[ci] = 1;
    }
  // Boundary values: average of dst - src over fine pixels outside the mask in each coarse cell.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inside[i]) continue;
      const cx = Math.min(cw - 1, Math.floor(x * k)), cy = Math.min(chh - 1, Math.floor(y * k));
      const ci = cy * cw + cx;
      for (let c = 0; c < 4; c++) diff[ci * 4 + c] += dst[i * 4 + c] - src[i * 4 + c];
      cnt[ci]++;
    }
  for (let ci = 0; ci < cw * chh; ci++) {
    if (cnt[ci] && !cIn[ci]) {
      fixed[ci] = 1;
      for (let c = 0; c < 4; c++) diff[ci * 4 + c] /= cnt[ci];
    } else if (cnt[ci] && cIn[ci]) {
      // Mixed cells at the edge still pin the membrane.
      fixed[ci] = 1;
      for (let c = 0; c < 4; c++) diff[ci * 4 + c] /= cnt[ci];
    }
  }
  const iters = Math.max(80, (cw + chh) * 3);
  for (let it = 0; it < iters; it++)
    for (let y = 0; y < chh; y++)
      for (let x = 0; x < cw; x++) {
        const ci = y * cw + x;
        if (fixed[ci]) continue;
        for (let c = 0; c < 4; c++) {
          let s = 0, m = 0;
          if (x > 0) (s += diff[(ci - 1) * 4 + c]), m++;
          if (x < cw - 1) (s += diff[(ci + 1) * 4 + c]), m++;
          if (y > 0) (s += diff[(ci - cw) * 4 + c]), m++;
          if (y < chh - 1) (s += diff[(ci + cw) * 4 + c]), m++;
          const v = s / m;
          diff[ci * 4 + c] += (v - diff[ci * 4 + c]) * 1.8;
        }
      }
  const out = new Uint8ClampedArray(dst);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(chh - 1, (y + 0.5) * k - 0.5));
    const y0 = fy | 0, y1 = Math.min(chh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mask[i];
      if (m <= 0) continue;
      const fx = Math.max(0, Math.min(cw - 1, (x + 0.5) * k - 0.5));
      const x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const d =
          (diff[(y0 * cw + x0) * 4 + c] * (1 - tx) + diff[(y0 * cw + x1) * 4 + c] * tx) * (1 - ty) + (diff[(y1 * cw + x0) * 4 + c] * (1 - tx) + diff[(y1 * cw + x1) * 4 + c] * tx) * ty;
        const healed = src[i * 4 + c] + d;
        out[i * 4 + c] = dst[i * 4 + c] + (healed - dst[i * 4 + c]) * Math.min(1, m);
      }
    }
  }
  return out;
}
