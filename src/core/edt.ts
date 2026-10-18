/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher): for
 * every pixel, the distance to the nearest pixel where `on` is set.
 */

const INF = 1e20;

function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

export function edt(on: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = on[y * w + x] ? 0 : INF;
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * Signed distance to a mask's 50% edge: positive inside, negative outside,
 * with sub-pixel accuracy from the mask's soft values along the edge.
 */
export function signedDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const inside = new Uint8Array(w * h), outside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] >= 128) inside[i] = 1;
    else outside[i] = 1;
  }
  const dIn = edt(outside, w, h), dOut = edt(inside, w, h);
  const s = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Hard edges sit half a pixel from the pixel centers next to them; a soft
    // edge pixel's coverage says how far it is in.
    const m = mask[i];
    s[i] = m > 0 && m < 255 ? m / 255 - 0.5 : inside[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
  }
  return s;
}
