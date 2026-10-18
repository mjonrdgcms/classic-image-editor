/** v0.9: the .cie file format, document size commands, transforms, adjustments, retouching. */

import { describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { CommandBus } from "../src/core/commands";
import { Document } from "../src/core/document";
import { decodeProject, encodeProject, isProject } from "../src/io/project";

export function setup(w = 120, h = 80) {
  const doc = new Document(w, h);
  const bg = doc.addLayer("Background", 0);
  bg.isBackground = true;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([(x * 2) % 256, (y * 3) % 256, 90, 255], (y * w + x) * 4);
  bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus, bg };
}

const all = (doc: Document) => [...doc.composite()];

describe(".cie files", () => {
  it("round-trip layers, sets, masks, settings, guides and the selection", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new", { name: "paint" });
    bus.dispatch("select.ellipse", { x: 10, y: 10, w: 50, h: 40 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.setProperties", { opacity: 60, blendMode: "multiply" });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("layer.newSet", { name: "Set A" });
    bus.dispatch("guide.add", { orientation: "vertical", position: 33 });
    bus.dispatch("select.rect", { x: 5, y: 6, w: 20, h: 10 });
    const before = all(doc);
    const bytes = encodeProject(doc);
    expect(isProject(bytes)).toBe(true);
    const back = decodeProject(bytes, "copy.cie");
    expect(back.width).toBe(doc.width);
    expect(back.height).toBe(doc.height);
    expect(back.stack.map((n) => [n.kind, n.name])).toEqual(doc.stack.map((n) => [n.kind, n.name]));
    expect(all(back)).toEqual(before);
    const paint = back.layers.find((l) => l.name === "paint")!;
    expect(paint.opacity).toBeCloseTo(0.6);
    expect(paint.blendMode).toBe("multiply");
    expect(paint.mask!.get(35, 30)).toBe(255);
    expect(paint.mask!.get(100, 70)).toBe(0);
    expect(back.guides.v).toEqual([33]);
    expect(back.selection!.get(10, 10)).toBe(255);
    expect(back.selection!.get(50, 50)).toBe(0);
    expect(back.activeNode?.name).toBe("Set A");
    // Ids are fresh, so two copies can be open at once.
    expect(back.layers[0].id).not.toBe(doc.layers[0].id);
  });

  it("keeps empty layers small and refuses other files", () => {
    const { doc, bus } = setup(2000, 1500);
    bus.dispatch("layer.new", { name: "empty" });
    const bytes = encodeProject(doc);
    expect(bytes.length).toBeLessThan(2000 * 1500 * 4);
    expect(() => decodeProject(new Uint8Array([1, 2, 3, 4, 5]), "x.cie")).toThrow(/not a Classic Image Editor file/);
  });
});

describe("image size and canvas", () => {
  it("Image Size resamples every layer, mask and guide, and undoes", () => {
    const { doc, bus } = setup(120, 80);
    bus.dispatch("layer.new", { name: "dot" });
    bus.dispatch("select.rect", { x: 20, y: 20, w: 20, h: 20 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("guide.add", { orientation: "vertical", position: 60 });
    const before = all(doc);
    bus.dispatch("image.resize", { width: 60, height: 40, method: "bicubic" });
    expect([doc.width, doc.height]).toEqual([60, 40]);
    expect(doc.layers[0].grid.width).toBe(60);
    const dot = doc.layers[1];
    expect(dot.mask!.width).toBe(dot.grid.width);
    expect(doc.samplePixel(15, 15)[0]).toBeLessThan(30); // the black square, now at half size
    expect(doc.guides.v).toEqual([30]);
    expect(doc.selection!.get(15, 15)).toBeGreaterThan(200);
    bus.history.undo();
    expect([doc.width, doc.height]).toEqual([120, 80]);
    expect(all(doc)).toEqual(before);
  });

  it("downsizing averages instead of aliasing", () => {
    const { doc, bus, bg } = setup(64, 64);
    const d = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) d.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 64 + x) * 4);
    bg.grid.writeRegion({ x: 0, y: 0, w: 64, h: 64 }, d);
    bus.dispatch("image.resize", { width: 16, height: 16, method: "bicubic" });
    const v = doc.samplePixel(8, 8)[0];
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThan(155);
  });

  it("Canvas Size adds room around the anchor in the background color", () => {
    const { doc, bus } = setup(100, 50);
    doc.background = [10, 200, 30, 255];
    const tl = doc.samplePixel(0, 0);
    bus.dispatch("image.canvasSize", { width: 140, height: 70, anchor: "se" });
    expect([doc.width, doc.height]).toEqual([140, 70]);
    expect(doc.samplePixel(5, 5).slice(0, 3)).toEqual([10, 200, 30]);
    expect(doc.samplePixel(40, 20)).toEqual(tl);
    bus.dispatch("image.canvasSize", { width: 100, height: 50, anchor: "se" });
    expect(doc.samplePixel(0, 0)).toEqual(tl);
  });

  it("rotates and flips losslessly by right angles", () => {
    const { doc, bus } = setup(30, 20);
    bus.dispatch("layer.new", { name: "mark" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 3, h: 2 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    const before = all(doc);
    bus.dispatch("image.rotate", { angle: 90 });
    expect([doc.width, doc.height]).toEqual([20, 30]);
    // The top-left corner is now the top-right.
    expect(doc.samplePixel(19, 0)[2]).toBe(0);
    expect(doc.samplePixel(0, 0)[2]).toBe(90);
    bus.dispatch("image.rotate", { angle: -90 });
    expect(all(doc)).toEqual(before);
    bus.dispatch("image.flip", { direction: "horizontal" });
    expect(doc.samplePixel(29, 0)[2]).toBe(0);
    expect(doc.samplePixel(0, 0)[2]).toBe(90);
    bus.dispatch("image.flip", { direction: "horizontal" });
    bus.dispatch("image.rotate", { angle: 180 });
    bus.dispatch("image.rotate", { angle: 180 });
    expect(all(doc)).toEqual(before);
  });

  it("rotates by any angle onto a bigger canvas", () => {
    const { doc, bus } = setup(100, 50);
    doc.background = [255, 0, 255, 255];
    bus.dispatch("image.rotate", { angle: 30 });
    expect(doc.width).toBe(Math.ceil(100 * Math.cos(Math.PI / 6) + 50 * Math.sin(Math.PI / 6)));
    expect(doc.samplePixel(0, 0).slice(0, 3)).toEqual([255, 0, 255]);
    expect(doc.samplePixel(Math.floor(doc.width / 2), Math.floor(doc.height / 2))[2]).toBe(90);
  });

  it("Trim crops transparent or corner-colored borders", () => {
    const doc = new Document(50, 40);
    const l = doc.addLayer("Layer 0", 0);
    const bus = new CommandBus(doc);
    registerBuiltins(bus);
    bus.setDocument(doc, "New");
    l.grid.writeRegion({ x: 10, y: 5, w: 4, h: 3 }, new Uint8ClampedArray(4 * 3 * 4).fill(200));
    bus.dispatch("image.trim", { basis: "transparent" });
    expect([doc.width, doc.height]).toEqual([4, 3]);
    expect(() => {
      const empty = new Document(10, 10);
      empty.addLayer("x", 0);
      const b2 = new CommandBus(empty);
      registerBuiltins(b2);
      b2.setDocument(empty, "New");
      b2.dispatch("image.trim", {});
    }).toThrow(/nothing/);
  });
});

import { rectQuad } from "../src/core/transform";

describe("free transform", () => {
  it("scales and moves a whole layer, with its mask", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new", { name: "sq" });
    bus.dispatch("select.rect", { x: 10, y: 10, w: 20, h: 20 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    bus.dispatch("layer.addMask", { reveal: "all" });
    const l = doc.activeLayer!;
    // Map the whole layer (0,0)-(100,100) onto (50,50)-(100,100): half size, moved.
    bus.dispatch("layer.transform", { rect: { x: 0, y: 0, w: 100, h: 100 }, quad: [50, 50, 100, 50, 100, 100, 50, 100] });
    expect(l.offsetX).toBe(50);
    expect(l.grid.width).toBe(50);
    expect(l.mask!.width).toBe(50);
    expect(doc.samplePixel(60, 60)[2]).toBeLessThan(20); // the square at (10..30) is now at (55..65)
    expect(doc.samplePixel(20, 20)[2]).toBe(90);
    expect(bus.history.current!.label).toBe("Free Transform");
  });

  it("moves only the selected pixels and leaves a hole (background color on the Background)", () => {
    const { doc, bus } = setup(80, 60);
    doc.background = [255, 255, 255, 255];
    bus.dispatch("select.rect", { x: 0, y: 0, w: 10, h: 10 });
    const c = doc.samplePixel(5, 5);
    bus.dispatch("layer.transform", { rect: { x: 0, y: 0, w: 10, h: 10 }, quad: rectQuad({ x: 40, y: 30, w: 10, h: 10 }), selected: true, method: "nearest" });
    expect(doc.samplePixel(45, 35)).toEqual(c);
    expect(doc.samplePixel(5, 5).slice(0, 3)).toEqual([255, 255, 255]);
    expect(doc.selection!.get(45, 35)).toBe(255);
    expect(doc.selection!.get(5, 5)).toBe(0);
  });

  it("flips with a mirrored quad and refuses folded shapes", () => {
    const { doc, bus } = setup(40, 40);
    bus.dispatch("layer.new", { name: "l" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 5, h: 40 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    bus.dispatch("layer.transform", { rect: { x: 0, y: 0, w: 40, h: 40 }, quad: [40, 0, 0, 0, 0, 40, 40, 40], method: "nearest" });
    expect(doc.samplePixel(37, 20)[2]).toBe(0);
    expect(doc.samplePixel(2, 20)[2]).toBe(90);
    expect(() => bus.dispatch("layer.transform", { rect: { x: 0, y: 0, w: 40, h: 40 }, quad: [0, 0, 40, 40, 40, 0, 0, 40] })).toThrow(/folded/);
  });

  it("transforms the selection outline", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("select.rect", { x: 10, y: 10, w: 20, h: 20 });
    bus.dispatch("select.transform", { rect: { x: 10, y: 10, w: 20, h: 20 }, quad: rectQuad({ x: 50, y: 50, w: 40, h: 40 }) });
    expect(doc.selection!.get(85, 85)).toBe(255);
    expect(doc.selection!.get(15, 15)).toBe(0);
  });
});

import { CURVES_IDENTITY, LEVELS_IDENTITY, autoRange, curveLUTFrom, levelsLUT, parseCurves, parseLevels } from "../src/filters/defs/tone";
import { FILTER_MAP } from "../src/filters";
import { defaults, runFilter } from "../src/filters/types";

describe("levels and curves", () => {
  const img = () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) data.set([i, i, i, 255], i * 4);
    return { w: 256, h: 1, data };
  };
  const env = { fg: [0, 0, 0] as [number, number, number], bg: [255, 255, 255] as [number, number, number], scale: 1 };

  it("identity settings change nothing", () => {
    for (const id of ["levels", "curves", "colorBalance"]) {
      const out = runFilter(FILTER_MAP.get(id)!, img(), defaults(FILTER_MAP.get(id)!), env);
      expect([...out.data]).toEqual([...img().data]);
    }
    expect(parseLevels(LEVELS_IDENTITY)[0]).toEqual({ inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 });
    expect(parseCurves(CURVES_IDENTITY)[2]).toEqual([
      [0, 0],
      [255, 255],
    ]);
  });

  it("levels clips the black and white points and bends the midtones", () => {
    const lut = levelsLUT({ inBlack: 20, gamma: 1, inWhite: 235, outBlack: 0, outWhite: 255 });
    expect(lut[20]).toBe(0);
    expect(lut[235]).toBe(255);
    expect(lut[10]).toBe(0);
    const bright = levelsLUT({ inBlack: 0, gamma: 2, inWhite: 255, outBlack: 0, outWhite: 255 });
    expect(bright[128]).toBeGreaterThan(170);
    const out = runFilter(FILTER_MAP.get("levels")!, img(), { levels: "0,1,255,0,255|0,1,128,0,255|0,1,255,0,255|0,1,255,0,255" }, env);
    expect(out.data[100 * 4]).toBe(199); // red only
    expect(out.data[100 * 4 + 1]).toBe(100);
  });

  it("curves pass through their points smoothly and never overshoot", () => {
    const lut = curveLUTFrom([
      [0, 0],
      [64, 40],
      [192, 220],
      [255, 255],
    ]);
    expect(lut[64]).toBe(40);
    expect(lut[192]).toBe(220);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
    const neg = curveLUTFrom([
      [0, 255],
      [255, 0],
    ]);
    expect(neg[0]).toBe(255);
    expect(neg[255]).toBe(0);
  });

  it("auto range clips a little at each end", () => {
    const h = new Uint32Array(256);
    for (let i = 30; i <= 200; i++) h[i] = 100;
    h[0] = 1;
    h[255] = 1;
    expect(autoRange(h)).toEqual([30, 200]);
  });

  it("color balance warms shadows and keeps luminosity when asked", () => {
    const f = FILTER_MAP.get("colorBalance")!;
    const out = runFilter(f, img(), { ...defaults(f), sCR: 60, preserve: false }, env);
    expect(out.data[40 * 4]).toBeGreaterThan(40);
    const kept = runFilter(f, img(), { ...defaults(f), mYB: -80, preserve: true }, env);
    const p = 128 * 4;
    const lum = 0.299 * kept.data[p] + 0.587 * kept.data[p + 1] + 0.114 * kept.data[p + 2];
    expect(Math.abs(lum - 128)).toBeLessThan(2);
    expect(kept.data[p + 2]).toBeLessThan(kept.data[p]);
  });
});

describe("content-aware fill", () => {
  it("fills a hole in a regular pattern with the pattern, repeatably", () => {
    const w = 160, h = 120;
    const { doc, bus, bg } = setup(w, h);
    // Stripes, with a blob in the middle to remove.
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = (x >> 3) % 2 ? 210 : 50;
        d.set([v, 255 - v, 120, 255], (y * w + x) * 4);
      }
    const want = d.slice();
    for (let y = 50; y < 70; y++) for (let x = 70; x < 90; x++) d.set([255, 0, 255, 255], (y * w + x) * 4);
    bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
    bus.dispatch("select.rect", { x: 68, y: 48, w: 24, h: 24 });
    bus.dispatch("edit.contentAwareFill", { seed: 7 });
    const out = bg.grid.readRegion({ x: 0, y: 0, w, h });
    let err = 0, magenta = 0;
    for (let y = 48; y < 72; y++)
      for (let x = 68; x < 92; x++) {
        const i = (y * w + x) * 4;
        err += Math.abs(out[i] - want[i]);
        if (out[i] > 240 && out[i + 1] < 20) magenta++;
      }
    expect(magenta).toBe(0);
    expect(err / (24 * 24)).toBeLessThan(25);
    // Same seed, same pixels.
    bus.history.undo();
    bus.dispatch("edit.contentAwareFill", { seed: 7 });
    expect([...bg.grid.readRegion({ x: 0, y: 0, w, h })]).toEqual([...out]);
    expect(doc.selection).not.toBeNull();
  });

  it("refuses without a selection or when everything is selected", () => {
    const { bus } = setup();
    expect(() => bus.dispatch("edit.contentAwareFill", {})).toThrow(/not available|select/);
    bus.dispatch("select.all", {});
    expect(() => bus.dispatch("edit.contentAwareFill", {})).toThrow(/select less/);
  });
});

describe("stroke, grow and similar", () => {
  it("strokes inside, centered on, and outside a selection edge", () => {
    for (const [loc, inX, outX] of [
      ["inside", 21, 18],
      ["outside", 18, 21],
    ] as const) {
      const { doc, bus } = setup(60, 60);
      bus.dispatch("layer.new", { name: "s" });
      bus.dispatch("select.rect", { x: 20, y: 20, w: 20, h: 20 });
      bus.dispatch("edit.stroke", { width: 2, location: loc, use: "black" });
      const l = doc.activeLayer!;
      const a = (x: number, y: number) => l.grid.readRegion({ x, y, w: 1, h: 1 })[3];
      expect(a(inX, 30)).toBe(255);
      expect(a(outX, 30)).toBe(0);
      expect(a(30, 30)).toBe(0);
      expect(a(loc === "inside" ? 23 : 16, 30)).toBe(0);
    }
    const { doc, bus } = setup(60, 60);
    bus.dispatch("layer.new", { name: "s" });
    bus.dispatch("select.ellipse", { x: 10, y: 10, w: 40, h: 40 });
    bus.dispatch("edit.stroke", { width: 4, location: "center", use: "custom", color: [255, 0, 0] });
    const px = doc.activeLayer!.grid.readRegion({ x: 0, y: 0, w: 60, h: 60 });
    expect(px[(30 * 60 + 10) * 4 + 3]).toBe(255);
    expect(px[(30 * 60 + 10) * 4]).toBe(255);
    expect(px[(30 * 60 + 30) * 4 + 3]).toBe(0);
  });

  it("grow follows similar colors from the selection; similar finds them anywhere", () => {
    const w = 60, h = 20;
    const { doc, bus, bg } = setup(w, h);
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        // Red | blue wall | red again
        const v = x >= 25 && x < 30 ? [0, 0, 255] : [220 + (x % 5), 10, 10];
        d.set([...v, 255], (y * w + x) * 4);
      }
    bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
    bus.dispatch("select.rect", { x: 2, y: 2, w: 4, h: 4 });
    bus.dispatch("select.grow", { tolerance: 32 });
    const s = doc.selection!;
    expect(s.get(20, 15)).toBe(255);
    expect(s.get(27, 10)).toBe(0);
    expect(s.get(45, 10)).toBe(0);
    bus.dispatch("select.similar", { tolerance: 32 });
    expect(doc.selection!.get(45, 10)).toBe(255);
    expect(doc.selection!.get(27, 10)).toBe(0);
  });
});

describe("retouching tools", () => {
  const solid = (w: number, h: number, f: (x: number, y: number) => number[]) => {
    const s = setup(w, h);
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255], (y * w + x) * 4);
    s.bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
    return s;
  };
  const px = (l: { grid: { getPixel(x: number, y: number): number[] } }, x: number, y: number) => l.grid.getPixel(x, y);

  it("Clone Stamp copies from the offset; it needs a source", () => {
    const { bus, bg } = solid(80, 40, (x) => (x < 40 ? [200, 30, 30] : [30, 30, 200]));
    bus.dispatch("paint.retouch", { tool: "clone", points: [[55, 20], [65, 20]], size: 10, hardness: 100, offset: [-40, 0] });
    expect(px(bg, 60, 20)[0]).toBeGreaterThan(190);
    expect(px(bg, 60, 30)[2]).toBeGreaterThan(190);
    expect(() => bus.dispatch("paint.retouch", { tool: "clone", points: [[60, 20]], size: 10 })).toThrow(/source/);
  });

  it("Healing Brush keeps the source texture but takes the destination's tone", () => {
    // Left: dark with a stripe pattern; right: bright plain with a dark spot.
    const { bus, bg } = solid(120, 60, (x, y) => (x < 60 ? [40 + (x % 4 < 2 ? 20 : 0), 40, 40] : Math.hypot(x - 90, y - 30) < 4 ? [20, 20, 20] : [200, 200, 200]));
    bus.dispatch("paint.retouch", { tool: "heal", points: [[86, 30], [94, 30]], size: 14, hardness: 50, offset: [-60, 0] });
    const c = px(bg, 90, 30);
    // No dark spot, and not the dark source tone either.
    expect(c[1]).toBeGreaterThan(150);
    // Texture came along: neighbouring columns differ.
    expect(Math.abs(px(bg, 89, 30)[0] - px(bg, 91, 30)[0])).toBeGreaterThan(5);
  });

  it("Spot Healing removes a spot", () => {
    const { bus, bg } = solid(80, 80, (x, y) => (Math.hypot(x - 40, y - 40) < 5 ? [0, 0, 0] : [120 + ((x * 7 + y * 3) % 20), 140, 160]));
    bus.dispatch("paint.retouch", { tool: "spotHeal", points: [[40, 40]], size: 16, hardness: 80, seed: 3 });
    expect(px(bg, 40, 40)[0]).toBeGreaterThan(100);
  });

  it("History Brush paints back the opened image", () => {
    const { bus, bg } = solid(40, 40, () => [10, 200, 10]);
    bus.dispatch("select.all", {});
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    bus.dispatch("paint.retouch", { tool: "history", points: [[20, 20]], size: 10, hardness: 100 });
    // State 0 is the document as set up (green = y * 3).
    expect(px(bg, 20, 20)[1]).toBe(60);
    expect(px(bg, 2, 2)[1]).toBe(0);
  });

  it("Dodge lightens, Burn darkens, Sponge desaturates", () => {
    for (const [tool, test] of [
      ["dodge", (c: number[]) => c[0] > 110],
      ["burn", (c: number[]) => c[0] < 90],
      ["sponge", (c: number[]) => c[0] - c[2] < 60],
    ] as const) {
      const { bus, bg } = solid(40, 40, () => [100, 70, 30]);
      bus.dispatch("paint.retouch", { tool, points: [[10, 20], [30, 20]], size: 20, hardness: 50, strength: 80 });
      expect(test(px(bg, 20, 20))).toBe(true);
      expect(px(bg, 20, 2)).toEqual([100, 70, 30, 255]);
    }
  });

  it("Blur softens, Sharpen crisps, Smudge drags color", () => {
    const edge = (x: number) => (x < 20 ? [30, 30, 30] : [220, 220, 220]);
    let s = solid(40, 40, edge);
    s.bus.dispatch("paint.retouch", { tool: "blur", points: [[20, 20]], size: 20, hardness: 0, strength: 100 });
    expect(px(s.bg, 19, 20)[0]).toBeGreaterThan(40);
    s = solid(40, 40, (x) => (x < 20 ? [90, 90, 90] : [150, 150, 150]));
    s.bus.dispatch("paint.retouch", { tool: "sharpen", points: [[20, 20]], size: 20, hardness: 0, strength: 100 });
    expect(px(s.bg, 19, 20)[0]).toBeLessThan(90);
    s = solid(40, 40, edge);
    s.bus.dispatch("paint.retouch", { tool: "smudge", points: [[12, 20], [28, 20]], size: 8, hardness: 100, strength: 80 });
    expect(px(s.bg, 24, 20)[0]).toBeLessThan(200);
  });

  it("Red Eye darkens a red pupil; Magic Eraser clears a color", () => {
    const { bus, bg, doc } = solid(60, 60, (x, y) => (Math.hypot(x - 30, y - 30) < 6 ? [220, 40, 40] : Math.hypot(x - 30, y - 30) < 12 ? [240, 240, 240] : [120, 110, 100]));
    bus.dispatch("paint.redEye", { x: 30, y: 30, radius: 15 });
    const c = px(bg, 30, 30);
    expect(c[0]).toBeLessThan(80);
    expect(px(bg, 30, 20)).toEqual([240, 240, 240, 255]);
    expect(() => bus.dispatch("paint.redEye", { x: 5, y: 5, radius: 4 })).toThrow(/red eye/);
    bus.dispatch("paint.magicErase", { x: 2, y: 2, tolerance: 10 });
    const l = doc.activeLayer!;
    expect(px(l, 2, 2)[3]).toBe(0);
    expect(l.isBackground).toBe(false);
    expect(px(l, 30, 20)[3]).toBe(255);
  });
});

describe("layer styles", () => {
  const styled = () => {
    const s = setup(80, 80);
    s.bus.dispatch("select.all", {});
    s.bus.dispatch("edit.fill", { use: "white" });
    s.bus.dispatch("layer.new", { name: "shape" });
    s.bus.dispatch("select.rect", { x: 20, y: 20, w: 30, h: 30 });
    s.bus.dispatch("edit.fill", { use: "gray" });
    s.bus.dispatch("select.none", {});
    return s;
  };
  const at = (doc: Document, x: number, y: number) => [...doc.composite({ x, y, w: 1, h: 1 })];

  it("drop shadow falls down-right of the shape, and undoes", () => {
    const { doc, bus } = styled();
    expect(at(doc, 55, 55)).toEqual([255, 255, 255, 255]);
    bus.dispatch("layer.setStyle", { style: { dropShadow: { distance: 6, size: 2, opacity: 100 } } });
    expect(at(doc, 51, 53)[0]).toBeLessThan(120);
    // Light from the upper left: nothing up-left of the shape.
    expect(at(doc, 17, 17)).toEqual([255, 255, 255, 255]);
    bus.history.undo();
    expect(at(doc, 51, 53)).toEqual([255, 255, 255, 255]);
  });

  it("stroke, overlay, glow and bevel draw where they should", () => {
    const { doc, bus } = styled();
    bus.dispatch("layer.setStyle", { style: { stroke: { size: 3, color: [255, 0, 0] }, colorOverlay: { color: [0, 0, 255] } } });
    expect(at(doc, 18, 35)).toEqual([255, 0, 0, 255]);
    expect(at(doc, 35, 35)).toEqual([0, 0, 255, 255]);
    expect(at(doc, 10, 35)).toEqual([255, 255, 255, 255]);
    bus.dispatch("layer.setStyle", { style: { outerGlow: { color: [255, 0, 0], size: 8, opacity: 100, blendMode: "normal" }, bevel: { size: 6 } } });
    expect(at(doc, 17, 35)[1]).toBeLessThan(250);
    // Bevel: the upper-left edge is lighter than the lower-right edge.
    expect(at(doc, 22, 35)[0]).toBeGreaterThan(at(doc, 47, 35)[0]);
    expect(() => bus.dispatch("layer.setStyle", { style: { stroke: { size: 0 } } })).toThrow(/size/);
  });

  it("rasterize, merge down and .cie files keep the look", () => {
    const { doc, bus } = styled();
    bus.dispatch("layer.setStyle", { style: { dropShadow: { distance: 6, size: 2, opacity: 100 }, stroke: { size: 2, color: [0, 200, 0] } } });
    const look = [...doc.composite()];
    const back = decodeProject(encodeProject(doc), "s.cie");
    expect([...back.composite()]).toEqual(look);
    expect(back.activeLayer!.style?.stroke?.color).toEqual([0, 200, 0]);
    bus.dispatch("layer.rasterizeStyle", {});
    expect(doc.activeLayer!.style).toBeNull();
    const after = [...doc.composite()];
    let diff = 0;
    for (let i = 0; i < look.length; i++) diff = Math.max(diff, Math.abs(after[i] - look[i]));
    expect(diff).toBeLessThan(3);
    bus.history.undo();
    bus.dispatch("layer.mergeDown", {});
    const merged = [...doc.composite()];
    diff = 0;
    for (let i = 0; i < look.length; i++) diff = Math.max(diff, Math.abs(merged[i] - look[i]));
    expect(diff).toBeLessThan(3);
  });
});

describe("0.9 review fixes", () => {
  it("undoing a transform that resizes the layer repaints everything it touched", () => {
    const { doc, bus } = setup(600, 600);
    bus.dispatch("layer.fromBackground", {});
    bus.dispatch("layer.transform", { rect: { x: 0, y: 0, w: 600, h: 600 }, quad: [0, 0, 300, 0, 300, 300, 0, 300] });
    const seen: unknown[] = [];
    doc.on((e) => e.type === "pixels" && seen.push(e.rect));
    bus.history.undo();
    expect(seen).toContain(null);
  });

  it("Stroke Inside on Select All draws along the canvas edges", () => {
    const { doc, bus } = setup(40, 40);
    bus.dispatch("layer.new", { name: "s" });
    bus.dispatch("select.all", {});
    bus.dispatch("edit.stroke", { width: 3, location: "inside", use: "black" });
    const l = doc.activeLayer!;
    expect(l.grid.getPixel(0, 20)[3]).toBe(255);
    expect(l.grid.getPixel(20, 39)[3]).toBe(255);
    expect(l.grid.getPixel(20, 20)[3]).toBe(0);
  });

  it("History Brush paints from the opened image even after Clear History", () => {
    const { doc, bus } = setup(40, 40);
    bus.dispatch("select.all", {});
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    bus.history.clear();
    bus.dispatch("paint.retouch", { tool: "history", points: [[20, 20]], size: 10, hardness: 100 });
    expect(doc.activeLayer!.grid.getPixel(20, 20)[1]).toBe(60);
  });

  it("Rasterize Layer Style keeps a disabled mask", () => {
    const { doc, bus } = setup(60, 60);
    bus.dispatch("layer.new", { name: "s" });
    bus.dispatch("select.rect", { x: 20, y: 20, w: 20, h: 20 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none", {});
    bus.dispatch("layer.setMaskEnabled", { enabled: false });
    bus.dispatch("layer.setStyle", { style: { stroke: { size: 2 } } });
    bus.dispatch("layer.rasterizeStyle", {});
    const l = doc.activeLayer!;
    expect(l.mask).not.toBeNull();
    expect(l.mask!.get(30 - l.offsetX, 30 - l.offsetY)).toBe(255);
    expect(l.mask!.get(5 - l.offsetX, 5 - l.offsetY)).toBe(0);
  });

  it("a huge shadow distance is refused", () => {
    const { bus } = setup(40, 40);
    bus.dispatch("layer.new", { name: "s" });
    expect(() => bus.dispatch("layer.setStyle", { style: { dropShadow: { distance: 30000 } } })).toThrow(/1000/);
  });
});
