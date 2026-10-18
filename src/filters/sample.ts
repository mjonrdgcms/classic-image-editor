/** A small procedural scene, so filters can be browsed with no image open. */

import { fbm, makeImg, type Img } from "./img";

export function sampleScene(w = 240, h = 180): Img {
  const img = makeImg(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h;
      // Sky.
      let r = 90 + 120 * v, g = 140 + 80 * v, b = 230 - 40 * v;
      // Sun.
      const sd = Math.hypot(u - 0.72, v - 0.28);
      if (sd < 0.1) [r, g, b] = [255, 226, 140];
      else if (sd < 0.2) {
        const k = 1 - (sd - 0.1) / 0.1;
        r += (255 - r) * k * 0.5;
        g += (220 - g) * k * 0.4;
      }
      // Clouds.
      const c = fbm(u * 6, v * 10, 4, 3);
      if (v < 0.45 && c > 0.58) {
        const k = Math.min(1, (c - 0.58) * 5);
        r += (250 - r) * k;
        g += (250 - g) * k;
        b += (252 - b) * k;
      }
      // Hills.
      const hill1 = 0.62 + 0.06 * Math.sin(u * 7) + 0.03 * Math.sin(u * 19);
      const hill2 = 0.74 + 0.05 * Math.sin(u * 5 + 2);
      if (v > hill1) {
        const t = fbm(u * 20, v * 20, 3, 5);
        [r, g, b] = [60 + 40 * t, 120 + 50 * t, 60 + 20 * t];
      }
      if (v > hill2) {
        const t = fbm(u * 30, v * 30, 3, 9);
        [r, g, b] = [40 + 50 * t, 90 + 60 * t, 40];
      }
      // A red ball and a yellow box.
      if (Math.hypot(u - 0.3, v - 0.72) < 0.09) {
        const sh = 1 - Math.hypot(u - 0.27, v - 0.69) * 6;
        [r, g, b] = [200 + 55 * sh, 30 + 40 * sh, 40 + 30 * sh];
      }
      if (u > 0.5 && u < 0.62 && v > 0.66 && v < 0.84) [r, g, b] = u < 0.52 || v < 0.68 ? [255, 236, 120] : [235, 190, 40];
      const p = (y * w + x) * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  return img;
}
