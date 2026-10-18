import { describe, expect, it } from "vitest";
import { CATEGORIES, FILTERS, FILTER_MAP } from "../src/filters";
import { defaults, runFilter } from "../src/filters/types";
import type { Img } from "../src/filters/img";

function testImage(w = 96, h = 72): Img {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const inCircle = (x - 40) ** 2 + (y - 36) ** 2 < 400;
      d[p] = inCircle ? 220 : (x * 255) / w;
      d[p + 1] = inCircle ? 40 : (y * 255) / h;
      d[p + 2] = inCircle ? 60 : 128 + 60 * Math.sin(x / 7);
      d[p + 3] = 255;
    }
  return { w, h, data: d };
}

const env = { fg: [0, 0, 0] as [number, number, number], bg: [255, 255, 255] as [number, number, number], scale: 1 };

describe("filter library", () => {
  it("has a lot of filters, unique ids, known categories", () => {
    expect(FILTERS.length).toBeGreaterThanOrEqual(110);
    expect(FILTER_MAP.size).toBe(FILTERS.length);
    for (const f of FILTERS) expect(CATEGORIES as readonly string[]).toContain(f.category);
  });
  for (const f of FILTERS) {
    it(`${f.category} > ${f.name} runs and changes the image`, () => {
      const src = testImage();
      const before = src.data.slice();
      const t = performance.now();
      const out = runFilter(f, src, defaults(f), env);
      const ms = performance.now() - t;
      expect(out.w).toBe(src.w);
      expect(out.h).toBe(src.h);
      expect(out.data.length).toBe(src.data.length);
      expect(src.data).toEqual(before); // never mutates the input
      let diff = 0;
      for (let i = 0; i < out.data.length; i++) {
        expect(Number.isNaN(out.data[i])).toBe(false);
        diff += Math.abs(out.data[i] - before[i]);
      }
      if (!["offset", "custom", "dustScratches", "outline", "brightnessContrast", "hueSaturation", "channelMixer", "levels", "curves", "colorBalance"].includes(f.id)) expect(diff, "no visible change").toBeGreaterThan(0);
      expect(ms, "too slow").toBeLessThan(1500);
    });
  }
});
