/** v0.10: several selected layers, and the remaining toolbox tools. */

import { describe, expect, it } from "vitest";
import { setup } from "./m9.test";

const box = (bus: ReturnType<typeof setup>["bus"], name: string, x: number, y: number, w: number, h: number) => {
  bus.dispatch("layer.new", { name });
  bus.dispatch("select.rect", { x, y, w, h });
  bus.dispatch("edit.fill", { use: "black" });
  bus.dispatch("select.none", {});
};

describe("several selected layers", () => {
  it("Ctrl-click toggles, Shift-click selects a range, and moves go together", () => {
    const { doc, bus } = setup(100, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 20, 0, 10, 10);
    box(bus, "C", 40, 0, 10, 10);
    const [, a, b, c] = doc.layers;
    bus.dispatch("layer.select", { id: a.id });
    bus.dispatch("layer.select", { id: c.id, mode: "toggle" });
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["A", "C"]);
    expect(doc.activeLayerId).toBe(c.id);
    bus.dispatch("layer.select", { id: c.id, mode: "toggle" });
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["A"]);
    bus.dispatch("layer.select", { id: c.id, mode: "range" });
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["A", "B", "C"]);
    bus.dispatch("layer.offset", { dx: 5, dy: 7 });
    expect([a, b, c].map((l) => [doc.layerById(l.id)!.offsetX, doc.layerById(l.id)!.offsetY])).toEqual([[5, 7], [5, 7], [5, 7]]);
    bus.history.undo();
    expect(doc.layers.slice(1).map((l) => l.offsetX)).toEqual([0, 0, 0]);
    // Plain select goes back to one.
    bus.dispatch("layer.select", { id: b.id });
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["B"]);
  });

  it("opacity, duplicate, delete and merge act on every selected layer", () => {
    const { doc, bus } = setup(100, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 20, 0, 10, 10);
    bus.dispatch("layer.selectAll", {});
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["A", "B"]);
    bus.dispatch("layer.setProperties", { opacity: 50 });
    expect(doc.layers.slice(1).map((l) => l.opacity)).toEqual([0.5, 0.5]);
    bus.dispatch("layer.duplicate", {});
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "A", "A copy", "B", "B copy"]);
    expect(doc.selectedNodes.map((n) => n.name)).toEqual(["A copy", "B copy"]);
    bus.dispatch("layer.delete", {});
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "A", "B"]);
    bus.dispatch("layer.selectAll", {});
    const before = [...doc.composite()];
    bus.dispatch("layer.mergeDown", {});
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "B"]);
    expect(bus.history.current!.label).toBe("Merge Layers");
    const after = [...doc.composite()];
    expect(Math.max(...after.map((v, i) => Math.abs(v - before[i])))).toBeLessThanOrEqual(1);
  });

  it("a shared Free Transform scales several layers about their joint bounds", () => {
    const { doc, bus } = setup(100, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 30, 0, 10, 10);
    const [, a, b] = doc.layers;
    const rect = { x: 0, y: 0, w: 40, h: 10 };
    bus.group("Free Transform", () => {
      for (const l of [a, b]) bus.dispatch("layer.transform", { id: l.id, rect, quad: [0, 0, 80, 0, 80, 20, 0, 20], method: "nearest" });
    });
    const alphaAt = (id: number, x: number, y: number) => {
      const l = doc.layerById(id)!;
      return l.grid.readRegion({ x: x - l.offsetX, y: y - l.offsetY, w: 1, h: 1 })[3];
    };
    expect(alphaAt(a.id, 15, 15)).toBe(255);
    expect(alphaAt(a.id, 25, 5)).toBe(0);
    expect(alphaAt(b.id, 65, 15)).toBe(255);
    expect(alphaAt(b.id, 50, 5)).toBe(0);
    expect(bus.history.current!.label).toBe("Free Transform");
    bus.history.undo();
    expect(alphaAt(b.id, 35, 5)).toBe(255);
    expect(alphaAt(b.id, 65, 15)).toBe(0);
  });

  it("align and distribute line layers up", () => {
    const { doc, bus } = setup(200, 100);
    box(bus, "A", 0, 10, 10, 10);
    box(bus, "B", 50, 40, 20, 20);
    box(bus, "C", 150, 70, 10, 10);
    bus.dispatch("layer.selectAll", {});
    bus.dispatch("layer.align", { edge: "top" });
    const tops = () => doc.layers.slice(1).map((l) => l.offsetY + [10, 40, 70][doc.layers.indexOf(l) - 1]);
    expect(tops()).toEqual([10, 10, 10]);
    bus.dispatch("layer.distribute", { edge: "hcenter" });
    const centers = doc.layers.slice(1).map((l, i) => l.offsetX + [5, 60, 155][i]);
    expect(centers).toEqual([5, 80, 155]);
    // To the selection, one layer is enough.
    bus.dispatch("layer.select", { id: doc.layers[1].id });
    bus.dispatch("select.rect", { x: 100, y: 0, w: 50, h: 50 });
    bus.dispatch("layer.align", { edge: "right" });
    expect(doc.layers[1].offsetX + 10).toBe(150);
  });
});

import { ellipsePath, pathFromMask, pathMask, polygonPath, rectPath, ringsMask, reverseSubpath, splitSegment } from "../src/core/vector";
import { Mask } from "../src/core/mask";

describe("paths and shape layers", () => {
  it("rasterizes shapes with holes and traces selections back into paths", () => {
    const m = ringsMask(100, 100, [
      [[10, 10], [90, 10], [90, 90], [10, 90]],
      [[30, 30], [30, 70], [70, 70], [70, 30]],
    ]);
    expect(m.get(20, 20)).toBe(255);
    expect(m.get(50, 50)).toBe(0);
    const e = pathMask({ subpaths: [ellipsePath(0, 0, 100, 60)] }, 100, 60);
    expect(e.get(50, 30)).toBe(255);
    expect(e.get(2, 2)).toBe(0);
    // Selection -> path -> selection is nearly the same area.
    const sel = new Mask(120, 80, 0);
    const disk = pathMask({ subpaths: [ellipsePath(20, 10, 70, 50)] }, 120, 80);
    sel.writeRegion({ x: 0, y: 0, w: 120, h: 80 }, disk.readRegion({ x: 0, y: 0, w: 120, h: 80 }));
    const back = pathMask(pathFromMask(sel, 1), 120, 80);
    let diff = 0;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 120; x++) diff += Math.abs((back.get(x, y) >= 128 ? 1 : 0) - (sel.get(x, y) >= 128 ? 1 : 0));
    expect(diff).toBeLessThan(200); // only boundary pixels flip
    // Splitting a segment keeps the shape.
    const s = splitSegment(ellipsePath(0, 0, 100, 100), 0, 0.5);
    expect(s.pts.length).toBe(5);
    expect(Math.hypot(s.pts[1].x - 50 - 50 * Math.SQRT1_2, s.pts[1].y - 50 + 50 * Math.SQRT1_2)).toBeLessThan(1);
    expect(polygonPath(0, 0, 100, 100, 5, 50).pts.length).toBe(10);
    expect(reverseSubpath(rectPath(0, 0, 10, 10)).pts[0]).toEqual({ x: 0, y: 10, ix: 0, iy: 10, ox: 0, oy: 10 });
  });

  it("work paths fill, stroke and load as selections", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("path.set", { path: { subpaths: [{ closed: true, pts: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }] }] } });
    expect(doc.paths.map((p) => p.name)).toEqual(["Work Path"]);
    bus.dispatch("path.toSelection", {});
    expect(doc.selection!.get(30, 30)).toBe(255);
    bus.dispatch("select.none", {});
    bus.dispatch("layer.new", { name: "p" });
    bus.dispatch("path.fill", { color: [255, 0, 0] });
    expect(doc.activeLayer!.grid.getPixel(30, 30)).toEqual([255, 0, 0, 255]);
    bus.dispatch("path.stroke", { size: 4, color: [0, 0, 255] });
    expect(doc.activeLayer!.grid.getPixel(30, 10)[2]).toBe(255);
    bus.dispatch("path.save", { name: "Box" });
    expect(doc.paths[0]).toMatchObject({ name: "Box", work: false });
    bus.history.undo();
    expect(doc.paths[0].work).toBe(true);
    bus.dispatch("select.ellipse", { x: 60, y: 60, w: 30, h: 30 });
    bus.dispatch("path.fromSelection", { tolerance: 1 });
    expect(doc.paths.find((p) => p.work)!.path.subpaths.length).toBe(1);
  });

  it("shape layers stay vectors through moves, transforms, resizing and saving", async () => {
    const { decodeProject, encodeProject } = await import("../src/io/project");
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.newShape", { path: { subpaths: [rectPath(20, 20, 40, 20)] }, color: [0, 128, 0] });
    const l = () => doc.activeLayer!;
    expect(l().shape).not.toBeNull();
    expect(doc.composite({ x: 30, y: 30, w: 1, h: 1 })[1]).toBe(128);
    bus.dispatch("layer.setShape", { color: [200, 0, 0] });
    expect(doc.composite({ x: 30, y: 30, w: 1, h: 1 })[0]).toBe(200);
    // Scale 2x horizontally as a vector.
    bus.dispatch("layer.transform", { rect: { x: 20, y: 20, w: 40, h: 20 }, quad: [20, 20, 100, 20, 100, 40, 20, 40] });
    expect(doc.composite({ x: 90, y: 30, w: 1, h: 1 })[0]).toBe(200);
    expect(l().shape).not.toBeNull();
    // Painting on it asks to rasterize.
    expect(() => bus.dispatch("edit.fill", { use: "black" })).toThrow(/shape layer/);
    bus.dispatch("image.resize", { width: 50, height: 50, method: "bicubic" });
    expect(doc.composite({ x: 45, y: 15, w: 1, h: 1 })[0]).toBe(200);
    const back = decodeProject(encodeProject(doc), "s.cie");
    expect(back.layers[1].shape?.color).toEqual([200, 0, 0]);
    bus.dispatch("layer.rasterizeShape", {});
    expect(l().shape).toBeNull();
  });
});

import { defaultPatterns, patternToJSON } from "../src/core/patterns";

describe("more painting tools", () => {
  const solid = (w: number, h: number, f: (x: number, y: number) => number[]) => {
    const s = setup(w, h);
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...f(x, y), 255], (y * w + x) * 4);
    s.bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
    return s;
  };
  const checker = patternToJSON(defaultPatterns()[0]);

  it("fills with a pattern and paints one with the Pattern Stamp", () => {
    const { doc, bus } = solid(64, 64, () => [255, 0, 0]);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 32, h: 32 });
    bus.dispatch("edit.fill", { use: "pattern", pattern: checker });
    const l = doc.activeLayer!;
    expect(l.grid.getPixel(2, 2)).toEqual([220, 220, 220, 255]);
    expect(l.grid.getPixel(18, 2)).toEqual([60, 60, 60, 255]);
    expect(l.grid.getPixel(40, 40)).toEqual([255, 0, 0, 255]);
    bus.dispatch("select.none", {});
    bus.dispatch("paint.retouch", { tool: "pattern", points: [[48, 48]], size: 10, hardness: 100, pattern: checker });
    expect(l.grid.getPixel(48, 48)[1]).toBeGreaterThan(50);
    expect(() => bus.dispatch("paint.retouch", { tool: "pattern", points: [[10, 10]], size: 10 })).toThrow(/pattern/);
  });

  it("Background Eraser erases the sampled color only; Color Replacement recolors keeping shading", () => {
    const { doc, bus } = solid(60, 40, (x) => (x < 30 ? [40, 200, 40] : [200, 40, 40]));
    bus.dispatch("paint.retouch", { tool: "bgErase", points: [[25, 20], [26, 20]], size: 20, hardness: 100, tolerance: 30, limits: "discontiguous" });
    const l = doc.activeLayer!;
    expect(l.isBackground).toBe(false);
    expect(l.grid.getPixel(25, 20)[3]).toBe(0);
    expect(l.grid.getPixel(33, 20)[3]).toBe(255);
    doc.foreground = [0, 0, 255, 255];
    bus.dispatch("paint.retouch", { tool: "colorReplace", points: [[40, 20]], size: 10, hardness: 100, tolerance: 40 });
    const c = l.grid.getPixel(40, 20);
    expect(c[2]).toBeGreaterThan(c[0]);
  });

  it("Art History paints strokes from the opened image; Patch heals from elsewhere", () => {
    const { doc, bus } = solid(80, 80, (x, y) => (Math.hypot(x - 20, y - 20) < 6 ? [0, 0, 0] : [150 + (x % 7) * 3, 140, 130]));
    bus.dispatch("select.all", {});
    bus.dispatch("edit.fill", { use: "white" });
    bus.dispatch("select.none", {});
    bus.dispatch("paint.retouch", { tool: "artHistory", points: [[60, 60], [62, 62]], size: 3, artArea: 20, seed: 4 });
    let painted = 0;
    const px = doc.activeLayer!.grid.readRegion({ x: 45, y: 45, w: 30, h: 30 });
    for (let i = 0; i < px.length; i += 4) if (px[i + 2] < 250) painted++;
    expect(painted).toBeGreaterThan(30);
    bus.history.undo();
    bus.history.undo();
    bus.history.undo();
    bus.dispatch("select.ellipse", { x: 12, y: 12, w: 16, h: 16 });
    bus.dispatch("edit.patch", { dx: 30, dy: 30 });
    expect(doc.activeLayer!.grid.getPixel(20, 20)[0]).toBeGreaterThan(100);
  });

  it("notes and slices are recorded, cropped and saved", async () => {
    const { decodeProject, encodeProject } = await import("../src/io/project");
    const { doc, bus } = setup(100, 100);
    bus.dispatch("note.add", { x: 50, y: 50, text: "hello" });
    bus.dispatch("slice.add", { x: 10, y: 10, w: 50, h: 50 });
    bus.dispatch("note.update", { id: 1, text: "changed" });
    expect(doc.notes[0].text).toBe("changed");
    bus.history.undo();
    expect(doc.notes[0].text).toBe("hello");
    bus.dispatch("image.crop", { x: 20, y: 20, w: 60, h: 60 });
    expect(doc.notes[0]).toMatchObject({ x: 30, y: 30 });
    expect(doc.slices[0]).toMatchObject({ x: 0, y: 0, w: 40, h: 40 });
    const back = decodeProject(encodeProject(doc), "n.cie");
    expect(back.notes[0].text).toBe("hello");
    expect(back.slices.length).toBe(1);
    bus.dispatch("note.remove", {});
    expect(doc.notes.length).toBe(0);
  });
});

describe("review fixes", () => {
  it("paths are saved in .cie files and follow crops and resizes", async () => {
    const { decodeProject, encodeProject } = await import("../src/io/project");
    const { doc, bus } = setup(100, 100);
    bus.dispatch("path.set", { path: { subpaths: [rectPath(10, 10, 20, 20)] } });
    bus.dispatch("path.save", { name: "Box" });
    const back = decodeProject(encodeProject(doc), "p.cie");
    expect(back.paths.map((p) => [p.name, p.work, p.path.subpaths[0].pts[0].x])).toEqual([["Box", false, 10]]);
    bus.dispatch("image.crop", { x: 5, y: 5, w: 80, h: 80 });
    expect(doc.paths[0].path.subpaths[0].pts[0]).toMatchObject({ x: 5, y: 5 });
    bus.dispatch("image.resize", { width: 160, height: 160, method: "bicubic" });
    expect(doc.paths[0].path.subpaths[0].pts[0]).toMatchObject({ x: 10, y: 10 });
    bus.history.undo();
    expect(doc.paths[0].path.subpaths[0].pts[0]).toMatchObject({ x: 5, y: 5 });
  });

  it("a shape layer's mask follows transforms and resizing", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.newShape", { path: { subpaths: [rectPath(20, 20, 40, 20)] }, color: [200, 0, 0] });
    bus.dispatch("select.rect", { x: 40, y: 0, w: 60, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "hideSelection" });
    bus.dispatch("select.none", {});
    // Green is 0 where the red shape shows, 255 where the white Background does.
    const red = (x: number, y: number) => (doc.composite({ x, y, w: 1, h: 1 })[1] === 0 ? 1 : 0);
    expect([red(30, 30), red(50, 30)]).toEqual([1, 0]);
    // Move it right 10 px as a transform: the hidden half stays hidden.
    bus.dispatch("layer.transform", { rect: { x: 20, y: 20, w: 40, h: 20 }, quad: [30, 20, 70, 20, 70, 40, 30, 40] });
    expect(doc.activeLayer!.mask).not.toBeNull();
    expect([red(40, 30), red(60, 30)]).toEqual([1, 0]);
    bus.dispatch("image.resize", { width: 50, height: 50, method: "bicubic" });
    expect([red(20, 15), red(30, 15)]).toEqual([1, 0]);
  });

  it("painting tools refuse shape layers until rasterized", async () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.newShape", { path: { subpaths: [rectPath(20, 20, 40, 20)] }, color: [200, 0, 0] });
    expect(() => bus.dispatch("paint.stroke", { points: [[25, 25], [50, 30]], size: 5, color: [0, 0, 255] })).toThrow(/shape layer/);
    expect(doc.activeLayer!.shape).not.toBeNull();
  });

  it("align moves linked layers once", () => {
    const { doc, bus } = setup(200, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 20, 0, 10, 10);
    box(bus, "C", 50, 0, 10, 10);
    const [, a, b] = doc.layers;
    bus.dispatch("layer.link", { ids: [a.id, b.id] });
    bus.dispatch("layer.selectAll", {});
    bus.dispatch("layer.align", { edge: "right" });
    expect(doc.layers.slice(1).map((l) => l.offsetX)).toEqual([30, 30, 0]);
  });

  it("deleting several layers can keep a set's contents, and duplicate with a name copies one layer", () => {
    const { doc, bus } = setup(100, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 20, 0, 10, 10);
    box(bus, "C", 40, 0, 10, 10);
    const [, a, b, c] = doc.layers;
    bus.dispatch("layer.newSetFrom", { ids: [a.id, b.id] });
    const set = doc.groups[0];
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("layer.select", { id: c.id, mode: "add" });
    bus.dispatch("layer.delete", { contents: false });
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "A", "B"]);
    expect(doc.groups.length).toBe(0);
    bus.dispatch("layer.selectAll", {});
    bus.dispatch("layer.duplicate", { name: "Soft Glow" });
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "A", "B", "Soft Glow"]);
  });

  it("merging keeps a whole set's opacity, refuses part of a faded set, and drops emptied sets", () => {
    const { doc, bus } = setup(100, 100);
    box(bus, "A", 0, 0, 10, 10);
    box(bus, "B", 20, 0, 10, 10);
    box(bus, "C", 40, 0, 10, 10);
    const [, a, b, c] = doc.layers;
    bus.dispatch("layer.newSetFrom", { ids: [a.id, b.id] });
    const set = doc.groups[0];
    bus.dispatch("layer.setProperties", { id: set.id, opacity: 20 });
    const before = [...doc.composite()];
    bus.dispatch("layer.select", { id: a.id });
    bus.dispatch("layer.select", { id: c.id, mode: "add" });
    expect(() => bus.dispatch("layer.mergeDown", {})).toThrow(/whole set/);
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("layer.select", { id: c.id, mode: "add" });
    bus.dispatch("layer.mergeDown", {});
    expect(doc.groups.length).toBe(0);
    expect(doc.layers.length).toBe(2);
    const after = [...doc.composite()];
    expect(Math.max(...after.map((v, i) => Math.abs(v - before[i])))).toBeLessThanOrEqual(1);
  });
});
