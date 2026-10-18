import { describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { defaultBrushes, presetFromJSON, presetToJSON } from "../src/core/brushes";
import { CommandBus } from "../src/core/commands";
import { Document } from "../src/core/document";
import { Mask } from "../src/core/mask";
import { ellipseMask, outlineSegments, polygonMask } from "../src/core/selection";

function setup(w = 400, h = 300, transparent = false) {
  const doc = new Document(w, h);
  if (transparent) doc.addLayer("Layer 0", 0);
  else {
    const bg = doc.addLayer("Background", 0);
    bg.isBackground = true;
    bg.grid.fill([255, 255, 255, 255]);
  }
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus };
}

const sel = (doc: Document, x: number, y: number) => doc.selection?.get(x, y) ?? 0;

describe("masks", () => {
  it("full masks are cheap and copy-on-write", () => {
    const m = Mask.full(5000, 5000);
    expect(new Set(m.tiles).size).toBe(1);
    const c = m.share();
    c.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([0]));
    expect(m.get(0, 0)).toBe(255);
    expect(c.get(0, 0)).toBe(0);
    expect(c.bounds()).toEqual({ x: 0, y: 0, w: 5000, h: 5000 });
  });

  it("combine add / subtract / intersect", () => {
    const a = new Mask(100, 100);
    a.writeRegion({ x: 0, y: 0, w: 50, h: 100 }, new Uint8Array(5000).fill(255));
    const b = new Mask(100, 100);
    b.writeRegion({ x: 25, y: 0, w: 50, h: 100 }, new Uint8Array(5000).fill(255));
    const add = a.share(); add.combine(b, "add");
    const sub = a.share(); sub.combine(b, "subtract");
    const int = a.share(); int.combine(b, "intersect");
    expect(add.bounds()).toEqual({ x: 0, y: 0, w: 75, h: 100 });
    expect(sub.bounds()).toEqual({ x: 0, y: 0, w: 25, h: 100 });
    expect(int.bounds()).toEqual({ x: 25, y: 0, w: 25, h: 100 });
  });

  it("ellipse and polygon are anti-aliased and the right size", () => {
    const e = ellipseMask(200, 200, { x: 50, y: 50, w: 100, h: 100 });
    expect(e.get(100, 100)).toBe(255);
    expect(e.get(10, 10)).toBe(0);
    const edge = e.get(64, 64);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    const p = polygonMask(200, 200, [[10, 10], [110, 10], [10, 110]]);
    expect(p.get(20, 20)).toBe(255);
    expect(p.get(100, 100)).toBe(0);
    // Area of the triangle is ~5000 px.
    const d = p.readRegion({ x: 0, y: 0, w: 200, h: 200 });
    const area = d.reduce((s, v) => s + v / 255, 0);
    expect(area).toBeGreaterThan(4950);
    expect(area).toBeLessThan(5050);
  });

  it("outline of a rectangle is its four sides", () => {
    const m = new Mask(50, 50);
    m.writeRegion({ x: 10, y: 10, w: 5, h: 5 }, new Uint8Array(25).fill(255));
    const s = outlineSegments(m);
    let len = 0;
    for (let i = 0; i < s.length; i += 4) len += Math.abs(s[i + 2] - s[i]) + Math.abs(s[i + 3] - s[i + 1]);
    expect(len).toBe(20);
  });
});

describe("selection commands", () => {
  it("modes: shift adds, alt subtracts, both intersect", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 0, y: 0, w: 100, h: 100 });
    bus.dispatch("select.rect", { x: 200, y: 0, w: 50, h: 50, mode: "add" });
    expect(sel(doc, 210, 10)).toBe(255);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 50, mode: "subtract" });
    expect(sel(doc, 10, 10)).toBe(0);
    expect(sel(doc, 60, 60)).toBe(255);
    bus.dispatch("select.ellipse", { x: 50, y: 50, w: 100, h: 100, mode: "intersect" });
    expect(sel(doc, 210, 10)).toBe(0);
    expect(sel(doc, 90, 90)).toBe(255);
  });

  it("inverse, feather, reselect", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 100, y: 100, w: 100, h: 100 });
    bus.dispatch("select.inverse");
    expect(sel(doc, 0, 0)).toBe(255);
    expect(sel(doc, 150, 150)).toBe(0);
    bus.dispatch("select.inverse");
    bus.dispatch("select.feather", { radius: 10 });
    const edge = sel(doc, 100, 150);
    expect(edge).toBeGreaterThan(60);
    expect(edge).toBeLessThan(200);
    expect(sel(doc, 150, 150)).toBe(255);
    bus.dispatch("select.none");
    expect(doc.selection).toBeNull();
    bus.dispatch("select.reselect");
    expect(sel(doc, 150, 150)).toBe(255);
  });

  it("modify expand / contract / border", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 100, y: 100, w: 50, h: 50 });
    bus.dispatch("select.modify", { op: "expand", amount: 5 });
    expect(doc.selection!.bounds()).toEqual({ x: 95, y: 95, w: 60, h: 60 });
    bus.dispatch("select.modify", { op: "contract", amount: 10 });
    expect(doc.selection!.bounds()).toEqual({ x: 105, y: 105, w: 40, h: 40 });
    bus.dispatch("select.modify", { op: "border", amount: 4 });
    expect(sel(doc, 125, 125)).toBe(0);
    expect(sel(doc, 105, 125)).toBeGreaterThan(100);
  });

  it("magic wand selects a contiguous color region", () => {
    const { doc, bus } = setup(200, 100);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 80, h: 100 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none");
    bus.dispatch("select.wand", { x: 10, y: 10, tolerance: 10, antiAlias: false });
    expect(doc.selection!.bounds()).toEqual({ x: 0, y: 0, w: 80, h: 100 });
    bus.dispatch("select.wand", { x: 150, y: 10, tolerance: 10, antiAlias: false, mode: "add" });
    expect(doc.selection!.bounds()).toEqual({ x: 0, y: 0, w: 200, h: 100 });
  });

  it("painting respects soft selection edges", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 0, y: 0, w: 200, h: 300, feather: 0 });
    bus.dispatch("select.feather", { radius: 20 });
    bus.dispatch("edit.fill", { use: "black" });
    const g = doc.layers[0].grid;
    expect(g.getPixel(50, 150)[0]).toBe(0);
    const edge = g.getPixel(200, 150)[0];
    expect(edge).toBeGreaterThan(40);
    expect(edge).toBeLessThan(215);
    expect(g.getPixel(300, 150)[0]).toBe(255);
  });

  it("Quick Mask: painting black removes from the selection", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.quickMask", { on: true });
    expect(doc.quickMask).toBe(true);
    bus.dispatch("paint.stroke", { points: [[100, 100]], size: 20, color: [0, 0, 0] });
    bus.dispatch("select.quickMask", { on: false });
    expect(sel(doc, 100, 100)).toBe(0);
    expect(sel(doc, 300, 200)).toBe(255);
    // The layer itself was not painted.
    expect(doc.layers[0].grid.getPixel(100, 100)).toEqual([255, 255, 255, 255]);
    bus.history.undo();
    bus.history.undo();
    expect(doc.quickMask).toBe(true);
  });

  it("moving the selection outline", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 10, y: 10, w: 20, h: 20 });
    bus.dispatch("select.translate", { dx: 100, dy: 50 });
    expect(doc.selection!.bounds()).toEqual({ x: 110, y: 60, w: 20, h: 20 });
  });
});

describe("layer masks, sets, clipping", () => {
  it("a layer mask hides pixels and can be applied", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none");
    expect(doc.samplePixel(10, 10)).toEqual([0, 0, 0, 255]);
    expect(doc.samplePixel(80, 10)).toEqual([255, 255, 255, 255]);
    // Painting while editing the mask reveals more.
    expect(doc.editMask).toBe(true);
    bus.dispatch("paint.stroke", { points: [[75, 50]], size: 10, color: [255, 255, 255] });
    expect(doc.samplePixel(75, 50)).toEqual([0, 0, 0, 255]);
    bus.dispatch("layer.setMaskEnabled", { enabled: false });
    expect(doc.samplePixel(80, 10)).toEqual([0, 0, 0, 255]);
    bus.dispatch("layer.setMaskEnabled", { enabled: true });
    bus.dispatch("layer.removeMask", { apply: true });
    expect(doc.activeLayer!.mask).toBeNull();
    expect(doc.activeLayer!.grid.getPixel(80, 10)[3]).toBe(0);
    expect(doc.activeLayer!.grid.getPixel(10, 10)[3]).toBe(255);
  });

  it("clipping group shows the upper layer only where the base has pixels", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new", { name: "base" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 40, h: 100 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none");
    bus.dispatch("layer.new", { name: "clipped" });
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    bus.dispatch("edit.fill");
    bus.dispatch("layer.clip", { clipped: true });
    expect(doc.samplePixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(doc.samplePixel(80, 10)).toEqual([255, 255, 255, 255]);
    // Hiding the base hides the clipped layer too.
    const base = doc.layers.find((l) => l.name === "base")!;
    bus.dispatch("layer.setProperties", { id: base.id, visible: false });
    expect(doc.samplePixel(10, 10)).toEqual([255, 255, 255, 255]);
  });

  it("layer sets: pass through vs isolated blending", () => {
    const { doc, bus } = setup(10, 10);
    bus.dispatch("layer.newSet", { name: "Set 1" });
    const set = doc.activeNode!;
    expect(set.kind).toBe("group");
    bus.dispatch("layer.new", { name: "inner" });
    expect(doc.parentOf(doc.activeLayerId)?.id).toBe(set.id);
    bus.dispatch("color.set", { r: 128, g: 128, b: 128 });
    bus.dispatch("edit.fill");
    bus.dispatch("layer.setProperties", { blendMode: "multiply" });
    // Pass through: multiply reaches the white background.
    expect(doc.samplePixel(1, 1).slice(0, 3)).toEqual([128, 128, 128]);
    bus.dispatch("layer.setProperties", { id: set.id, blendMode: "normal" });
    // Isolated: multiply over transparency is just the gray.
    expect(doc.samplePixel(1, 1).slice(0, 3)).toEqual([128, 128, 128]);
    bus.dispatch("layer.setProperties", { id: set.id, opacity: 50 });
    expect(doc.samplePixel(1, 1)[0]).toBe(192);
    bus.dispatch("layer.setProperties", { id: set.id, visible: false });
    expect(doc.samplePixel(1, 1)[0]).toBe(255);
  });

  it("merging a set and merge visible", () => {
    const { doc, bus } = setup(20, 20);
    bus.dispatch("layer.newSet");
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    const before = doc.samplePixel(5, 5);
    bus.dispatch("layer.select", { id: doc.groups[0].id });
    bus.dispatch("layer.mergeDown");
    expect(doc.groups).toHaveLength(0);
    expect(doc.layers).toHaveLength(2);
    expect(doc.samplePixel(5, 5)).toEqual(before);
    bus.dispatch("layer.new");
    bus.dispatch("layer.setProperties", { visible: false });
    bus.dispatch("layer.mergeVisible");
    expect(doc.layers).toHaveLength(2);
    expect(doc.layers[0].isBackground).toBe(true);
    expect(doc.layers[0].grid.getPixel(5, 5)).toEqual([0, 0, 0, 255]);
  });

  it("reorder into and out of sets, arrange", () => {
    const { doc, bus } = setup(10, 10);
    bus.dispatch("layer.new", { name: "A" });
    bus.dispatch("layer.new", { name: "B" });
    bus.dispatch("layer.newSet", { name: "S" });
    const s = doc.groups[0];
    const a = doc.layers.find((l) => l.name === "A")!;
    bus.dispatch("layer.reorder", { id: a.id, parent: s.id, index: 0 });
    expect(s.children.map((l) => l.name)).toEqual(["A"]);
    bus.dispatch("layer.reorder", { id: a.id, parent: 0, index: 0 });
    // Can't go under the Background.
    expect(doc.stack[0].name).toBe("Background");
    expect(doc.stack[1].name).toBe("A");
    bus.dispatch("layer.arrange", { id: a.id, to: "front" });
    expect(doc.stack[doc.stack.length - 1].name).toBe("A");
    expect(() => bus.dispatch("layer.reorder", { id: s.id, parent: s.id, index: 0 })).toThrow();
  });

  it("locks and links", () => {
    const { doc, bus } = setup(50, 50);
    bus.dispatch("layer.new", { name: "A" });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.setLocks", { pixels: true });
    expect(() => bus.dispatch("edit.fill", { use: "white" })).toThrow(/locked/);
    bus.dispatch("layer.setLocks", { pixels: false, transparency: true });
    bus.dispatch("edit.clear");
    expect(doc.activeLayer!.grid.getPixel(1, 1)[3]).toBe(255);
    bus.dispatch("layer.setLocks", { transparency: false });
    const a = doc.activeLayer!;
    bus.dispatch("layer.new", { name: "B" });
    const b = doc.activeLayer!;
    bus.dispatch("layer.link", { ids: [a.id, b.id] });
    bus.dispatch("layer.offset", { dx: 7, dy: 3 });
    expect([a.offsetX, a.offsetY, b.offsetX, b.offsetY]).toEqual([7, 3, 7, 3]);
    bus.dispatch("layer.setLocks", { id: a.id, position: true });
    expect(() => bus.dispatch("layer.offset", { dx: 1, dy: 0 })).toThrow(/position/);
  });
});

describe("brush engine", () => {
  it("replays a dynamic brush stroke identically", () => {
    const run = () => {
      const { doc, bus } = setup(200, 200);
      const brush = presetToJSON(defaultBrushes().find((b) => b.name.startsWith("Dune"))!);
      bus.dispatch("paint.stroke", { points: [[20, 100], [180, 100]], brush, seed: 42 });
      return Array.from(doc.layers[0].grid.readRegion({ x: 0, y: 0, w: 200, h: 200 }));
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a.some((v, i) => i % 4 !== 3 && v < 255)).toBe(true);
  });

  it("presets round-trip through JSON", () => {
    const b = defaultBrushes().find((x) => x.sampled)!;
    const back = presetFromJSON(JSON.parse(JSON.stringify(presetToJSON(b))));
    expect(back.sampled!.data).toEqual(b.sampled!.data);
  });

  it("pencil is aliased, flow builds up below opacity", () => {
    const { doc, bus } = setup(100, 100, true);
    bus.dispatch("paint.stroke", { tool: "pencil", points: [[50.3, 50.7]], size: 9, color: [0, 0, 0] });
    const g = doc.layers[0].grid;
    const alphas = new Set<number>();
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) alphas.add(g.getPixel(x, y)[3]);
    expect([...alphas].sort()).toEqual([0, 255]);
    bus.dispatch("edit.clear");
    bus.dispatch("paint.stroke", { points: [[10, 10]], size: 9, flow: 25, opacity: 100 });
    expect(g.getPixel(10, 10)[3]).toBeGreaterThan(55);
    expect(g.getPixel(10, 10)[3]).toBeLessThan(75);
  });

  it("multiply paint mode darkens", () => {
    const { doc, bus } = setup(50, 50);
    bus.dispatch("edit.fill", { use: "gray" });
    bus.dispatch("paint.stroke", { points: [[25, 25]], size: 10, mode: "multiply", color: [128, 128, 128] });
    expect(doc.layers[0].grid.getPixel(25, 25)[0]).toBe(64);
  });
});

describe("clipboard and crop", () => {
  it("copy / paste / paste into", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 20, h: 10 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("edit.copy");
    expect(bus.clipboard!.w).toBe(20);
    bus.dispatch("edit.paste");
    expect(doc.layers).toHaveLength(2);
    // Centered on the selection it was copied from... selection was cleared by paste? No: paste centers on the selection.
    expect(doc.activeLayer!.grid.getPixel(10, 5)[3]).toBe(255);
    bus.dispatch("select.rect", { x: 50, y: 50, w: 10, h: 10 });
    bus.dispatch("edit.paste", { into: true });
    const l = doc.activeLayer!;
    expect(l.mask).not.toBeNull();
    expect(doc.samplePixel(55, 55)).toEqual([0, 0, 0, 255]);
    expect(doc.samplePixel(48, 55)).toEqual([255, 255, 255, 255]);
  });

  it("crop resizes the canvas and shifts layers", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new");
    bus.dispatch("select.rect", { x: 40, y: 40, w: 10, h: 10 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("guide.add", { orientation: "vertical", position: 45 });
    bus.dispatch("image.crop", { x: 30, y: 30, w: 30, h: 30 });
    expect([doc.width, doc.height]).toEqual([30, 30]);
    expect(doc.samplePixel(15, 15)).toEqual([0, 0, 0, 255]);
    expect(doc.guides.v).toEqual([15]);
    bus.history.undo();
    expect([doc.width, doc.height]).toEqual([100, 100]);
  });

  it("crop beyond the canvas adds background", () => {
    const { doc, bus } = setup(10, 10);
    bus.dispatch("color.set", { which: "background", r: 0, g: 255, b: 0 });
    bus.dispatch("image.crop", { x: -5, y: 0, w: 20, h: 10 });
    expect(doc.samplePixel(2, 2)).toEqual([0, 255, 0, 255]);
    expect(doc.samplePixel(8, 2)).toEqual([255, 255, 255, 255]);
  });
});

describe("review regressions", () => {
  it("a new edit after undo is a different history state than the saved one", () => {
    const { bus } = setup(20, 20);
    bus.dispatch("layer.new");
    const saved = bus.history.current!.id;
    bus.history.undo();
    bus.dispatch("select.all");
    expect(bus.history.current!.id).not.toBe(saved);
    bus.history.clear();
    expect(bus.history.current!.id).not.toBe(saved);
  });

  it("merge visible keeps hidden layers, including ones inside a visible set", () => {
    const { doc, bus } = setup(20, 20);
    bus.dispatch("layer.newSet", { name: "S" });
    bus.dispatch("layer.new", { name: "A" });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.new", { name: "B" });
    bus.dispatch("layer.setProperties", { visible: false });
    bus.dispatch("layer.mergeVisible");
    expect(doc.layers.map((l) => l.name).sort()).toEqual(["B", "Background"]);
    expect(doc.samplePixel(3, 3)).toEqual([0, 0, 0, 255]);
  });

  it("merge visible keeps clipping where the base is hidden", () => {
    const { doc, bus } = setup(20, 20);
    bus.dispatch("layer.new", { name: "base" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 5, h: 20 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none");
    bus.dispatch("layer.setProperties", { visible: false });
    bus.dispatch("layer.new", { name: "clip" });
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    bus.dispatch("edit.fill");
    bus.dispatch("layer.clip", { clipped: true });
    const before = doc.samplePixel(10, 10);
    bus.dispatch("layer.mergeVisible");
    expect(doc.samplePixel(10, 10)).toEqual(before);
  });

  it("crop forgets the Reselect mask", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 50 });
    bus.dispatch("select.none");
    bus.dispatch("image.crop", { x: 0, y: 0, w: 40, h: 40 });
    expect(doc.lastSelection).toBeNull();
    expect(bus.isEnabled("select.reselect")).toBe(false);
  });

  it("a refused command keeps the active layer the user picked", () => {
    const { doc, bus } = setup(20, 20);
    bus.dispatch("layer.new", { name: "A" });
    const a = doc.activeLayerId;
    bus.dispatch("layer.new", { name: "B" });
    bus.dispatch("layer.setLocks", { position: true });
    bus.dispatch("layer.select", { id: a });
    bus.dispatch("layer.link", { ids: [a, doc.layers.find((l) => l.name === "B")!.id] });
    bus.dispatch("layer.select", { id: a });
    expect(() => bus.dispatch("layer.offset", { dx: 1, dy: 0 })).toThrow();
    expect(doc.activeLayerId).toBe(a);
  });

  it("deleting the last layer in a set selects the set", () => {
    const { doc, bus } = setup(20, 20);
    bus.dispatch("layer.newSet");
    const set = doc.activeLayerId;
    bus.dispatch("layer.new");
    bus.dispatch("layer.delete");
    expect(doc.activeLayerId).toBe(set);
  });
});
