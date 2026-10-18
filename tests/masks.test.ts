import { describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { CommandBus } from "../src/core/commands";
import { Document, Group, Layer } from "../src/core/document";
import { Mask } from "../src/core/mask";
import { effectiveMask, refineMask, shiftMask } from "../src/core/maskfx";
import { gradientLUT, gradientT, presetStops } from "../src/core/gradient";
import { TileGrid } from "../src/core/tiles";

function setup(w = 100, h = 100) {
  const doc = new Document(w, h);
  const bg = doc.addLayer("Background", 0);
  bg.isBackground = true;
  bg.grid.fill([255, 255, 255, 255]);
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus };
}

/** A black layer over the white background, so mask values show as grays. */
function blackLayer(bus: CommandBus, doc: Document): Layer {
  bus.dispatch("layer.new", { name: "black" });
  bus.dispatch("edit.fill", { use: "black" });
  return doc.activeLayer!;
}

const red = (doc: Document, x: number, y: number) => doc.samplePixel(x, y)[0];

describe("mask effects", () => {
  it("effective mask is the painted mask at 100% density and no feather", () => {
    const m = new Mask(50, 50, 255);
    expect(effectiveMask(m, 1, 0)).toBe(m);
  });

  it("density lifts the mask toward white", () => {
    const m = new Mask(50, 50, 0);
    const e = effectiveMask(m, 0.25, 0);
    expect(e.get(10, 10)).toBe(191);
    expect(effectiveMask(m, 0, 0).get(10, 10)).toBe(255);
  });

  it("feather blurs an edge and updates incrementally after painting", () => {
    const m = new Mask(600, 100, 0);
    m.writeRegion({ x: 0, y: 0, w: 50, h: 100 }, new Uint8Array(5000).fill(255));
    const e = effectiveMask(m, 1, 10);
    expect(e.get(10, 50)).toBe(255);
    expect(e.get(49, 50)).toBeGreaterThan(100);
    expect(e.get(49, 50)).toBeLessThan(200);
    expect(e.get(80, 50)).toBe(0);
    // Paint far away; the cached effective mask follows.
    m.writeRegion({ x: 500, y: 0, w: 100, h: 100 }, new Uint8Array(10000).fill(255));
    const e2 = effectiveMask(m, 1, 10);
    expect(e2.get(580, 50)).toBe(255);
    expect(e2.get(10, 50)).toBe(255);
  });

  it("shiftMask moves contents, fills with the default and can resize", () => {
    const m = new Mask(20, 20, 0);
    m.writeRegion({ x: 0, y: 0, w: 1, h: 1 }, new Uint8Array([255]));
    const s = shiftMask(m, 5, 3);
    expect(s.get(5, 3)).toBe(255);
    expect(s.get(0, 0)).toBe(0);
    const r = shiftMask(m, 2, 2, 40, 10);
    expect([r.width, r.height]).toEqual([40, 10]);
    expect(r.get(2, 2)).toBe(255);
  });

  it("refine: feather softens, contrast hardens, shift grows the edge", () => {
    const m = new Mask(100, 20, 0);
    m.writeRegion({ x: 0, y: 0, w: 50, h: 20 }, new Uint8Array(1000).fill(255));
    const soft = refineMask(m, { smooth: 0, feather: 10, contrast: 0, shift: 0 });
    expect(soft.get(52, 10)).toBeGreaterThan(0);
    expect(soft.get(52, 10)).toBeLessThan(255);
    const hard = refineMask(soft, { smooth: 0, feather: 0, contrast: 100, shift: 0 });
    expect(hard.get(45, 10)).toBe(255);
    expect(hard.get(55, 10)).toBe(0);
    const grown = refineMask(m, { smooth: 0, feather: 10, contrast: 100, shift: 60 });
    expect(grown.get(53, 10)).toBe(255);
  });
});

describe("layer mask commands", () => {
  it("density and feather are non-destructive and undoable", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "none" });
    expect(red(doc, 50, 50)).toBe(255);
    bus.dispatch("layer.setMaskProperties", { density: 50 });
    expect(red(doc, 50, 50)).toBe(127);
    expect(l.mask!.get(50, 50)).toBe(0);
    bus.history.undo();
    expect(doc.activeLayer!.maskDensity).toBe(1);
    expect(red(doc, 50, 50)).toBe(255);
  });

  it("apply uses the effective mask (density included)", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "none" });
    bus.dispatch("layer.setMaskProperties", { density: 40 });
    bus.dispatch("layer.removeMask", { apply: true });
    expect(l.mask).toBeNull();
    // 40% density: black hides 40%, so 60% of the layer shows.
    expect(l.grid.getPixel(5, 5)[3]).toBe(153);
  });

  it("a linked mask moves with its layer, an unlinked one stays on the canvas", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none");
    bus.dispatch("layer.offset", { dx: 10, dy: 0 });
    // Linked: the visible black now spans 10..60.
    expect(red(doc, 55, 50)).toBe(0);
    expect(red(doc, 5, 50)).toBe(255);
    bus.dispatch("layer.setMaskProperties", { linked: false });
    expect(l.maskLinked).toBe(false);
    bus.dispatch("layer.offset", { dx: 10, dy: 0 });
    // Unlinked: the mask edge stays at 60 on the canvas.
    expect(red(doc, 59, 50)).toBe(0);
    expect(red(doc, 61, 50)).toBe(255);
    expect(red(doc, 15, 50)).toBe(255);
    // Moving just the mask.
    bus.dispatch("layer.offsetMask", { dx: 20, dy: 0 });
    expect(red(doc, 75, 50)).toBe(0);
  });

  it("masks on layer sets: pass-through and isolated", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.newSet", { name: "Set" });
    const set = doc.activeNode as Group;
    bus.dispatch("layer.new", { name: "inner" });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none");
    expect(set.mask).not.toBeNull();
    expect(doc.editMask).toBe(true);
    expect(set.blendMode).toBe("passThrough");
    expect(red(doc, 10, 50)).toBe(0);
    expect(red(doc, 80, 50)).toBe(255);
    bus.dispatch("layer.setProperties", { id: set.id, blendMode: "normal" });
    expect(red(doc, 10, 50)).toBe(0);
    expect(red(doc, 80, 50)).toBe(255);
    // Painting on the set mask (gray) reveals partially.
    bus.dispatch("paint.stroke", { points: [[80, 50]], size: 9, color: [128, 128, 128] });
    expect(red(doc, 80, 50)).toBeGreaterThan(100);
    expect(red(doc, 80, 50)).toBeLessThan(160);
    // Set masks can be deleted but not applied.
    expect(() => bus.dispatch("layer.removeMask", { apply: true })).toThrow();
    // (A failed command rolls the document back, so look the set up again.)
    bus.dispatch("layer.removeMask", { apply: false });
    expect(doc.groups[0].mask).toBeNull();
    expect(red(doc, 80, 50)).toBe(0);
  });

  it("merging a set keeps what its mask showed", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.newSet");
    const set = doc.activeNode as Group;
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "hideSelection" });
    bus.dispatch("select.none");
    const before = [red(doc, 10, 10), red(doc, 90, 10)];
    expect(before).toEqual([255, 0]);
    bus.dispatch("layer.mergeDown");
    expect(doc.groups).toHaveLength(0);
    expect([red(doc, 10, 10), red(doc, 90, 10)]).toEqual(before);
  });

  it("move and copy a mask to another layer", () => {
    const { doc, bus } = setup();
    const a = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "none" });
    const b = blackLayer(bus, doc);
    bus.dispatch("layer.moveMask", { from: a.id, to: b.id, copy: true });
    expect(a.mask).not.toBeNull();
    expect(b.mask).not.toBeNull();
    expect(doc.activeLayerId).toBe(b.id);
    expect(red(doc, 50, 50)).toBe(255);
    bus.dispatch("layer.removeMask", { id: b.id });
    bus.dispatch("layer.moveMask", { from: a.id, to: b.id });
    expect(a.mask).toBeNull();
    expect(b.mask!.get(1, 1)).toBe(0);
    // a is now unmasked black on top of b.
    expect(red(doc, 50, 50)).toBe(0);
  });

  it("invert, mask from selection and load selection from mask", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("layer.invertMask");
    expect(l.mask!.get(5, 5)).toBe(0);
    bus.dispatch("select.rect", { x: 10, y: 10, w: 20, h: 20 });
    bus.dispatch("layer.maskFromSelection", { mode: "add" });
    expect(l.mask!.get(15, 15)).toBe(255);
    expect(l.mask!.get(50, 50)).toBe(0);
    bus.dispatch("select.none");
    bus.dispatch("select.fromMask", { mode: "replace" });
    expect(doc.selection!.bounds()).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    bus.dispatch("select.fromMask", { mode: "replace", invert: true });
    expect(doc.selection!.get(15, 15)).toBe(0);
    expect(doc.selection!.get(50, 50)).toBe(255);
  });

  it("mask from transparency and selection from transparency", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new");
    bus.dispatch("select.rect", { x: 20, y: 20, w: 10, h: 10 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none");
    bus.dispatch("select.fromTransparency", {});
    expect(doc.selection!.bounds()).toEqual({ x: 20, y: 20, w: 10, h: 10 });
    bus.dispatch("select.none");
    bus.dispatch("layer.addMask", { reveal: "transparency" });
    expect(doc.activeLayer!.mask!.get(25, 25)).toBe(255);
    expect(doc.activeLayer!.mask!.get(5, 5)).toBe(0);
  });

  it("editing a mask makes the colors gray; D gives white over black", () => {
    const { doc, bus } = setup();
    blackLayer(bus, doc);
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    bus.dispatch("layer.addMask", { reveal: "all" });
    expect(doc.foreground.slice(0, 3)).toEqual([77, 77, 77]);
    bus.dispatch("color.reset");
    expect(doc.foreground.slice(0, 3)).toEqual([255, 255, 255]);
    expect(doc.background.slice(0, 3)).toEqual([0, 0, 0]);
  });

  it("copy and paste work on the mask while editing it", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "none" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 10, h: 10 });
    bus.dispatch("edit.fill", { use: "white" });
    bus.dispatch("edit.copy");
    expect(bus.clipboard!.w).toBe(10);
    bus.dispatch("select.none");
    bus.dispatch("edit.paste");
    // Pasting into a mask doesn't create a layer.
    expect(doc.layers).toHaveLength(2);
    expect(l.mask!.get(50, 50)).toBe(255);
  });

  it("filters run on the mask being edited", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none");
    bus.dispatch("filter.gaussianBlur", { radius: 4 });
    const v = l.mask!.get(50, 50);
    expect(v).toBeGreaterThan(30);
    expect(v).toBeLessThan(230);
    expect(l.grid.getPixel(50, 50)).toEqual([0, 0, 0, 255]);
  });
});

describe("gradient", () => {
  it("shapes", () => {
    expect(gradientT("linear", 50, 0, 0, 0, 100, 0)).toBeCloseTo(0.5);
    expect(gradientT("linear", -10, 0, 0, 0, 100, 0)).toBe(0);
    expect(gradientT("reflected", -50, 0, 0, 0, 100, 0)).toBeCloseTo(0.5);
    expect(gradientT("radial", 0, 30, 0, 0, 60, 0)).toBeCloseTo(0.5);
    expect(gradientT("diamond", 30, 30, 0, 0, 60, 0)).toBeCloseTo(1);
    expect(gradientT("angle", 0, -10, 0, 0, 10, 0)).toBeCloseTo(0.25);
    expect(gradientT("angle", 0, 10, 0, 0, 10, 0)).toBeCloseTo(0.75);
  });

  it("transparent stops don't darken the color", () => {
    const lut = gradientLUT(presetStops("fgToTransparent", [255, 0, 0, 255], [0, 0, 0, 255]), false, true);
    const mid = 512 * 4;
    expect(lut[mid]).toBeCloseTo(255);
    expect(lut[mid + 3]).toBeGreaterThan(120);
    expect(lut[mid + 3]).toBeLessThan(135);
  });

  it("paints pixels, reversed, inside the selection", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new");
    bus.dispatch("color.reset");
    bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 100, y1: 0, dither: false });
    expect(red(doc, 0, 5)).toBeLessThan(5);
    expect(red(doc, 99, 5)).toBeGreaterThan(250);
    expect(Math.abs(red(doc, 50, 5) - 128)).toBeLessThan(4);
    bus.dispatch("select.rect", { x: 0, y: 0, w: 20, h: 20 });
    bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 100, y1: 0, reverse: true, dither: false });
    expect(red(doc, 0, 5)).toBeGreaterThan(250);
    expect(red(doc, 0, 50)).toBeLessThan(5);
  });

  it("on a mask it fades the layer; in Quick Mask it makes a soft selection", () => {
    const { doc, bus } = setup();
    const l = blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("color.reset");
    bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 100, y1: 0, preset: "whiteBlack", dither: false });
    expect(l.mask!.get(2, 50)).toBeGreaterThan(245);
    expect(l.mask!.get(97, 50)).toBeLessThan(10);
    expect(red(doc, 97, 50)).toBeGreaterThan(245);
    bus.dispatch("layer.editMask", { edit: false });
    bus.dispatch("select.quickMask", { on: true });
    bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 0, y1: 100, preset: "whiteBlack", dither: false });
    bus.dispatch("select.quickMask", { on: false });
    expect(doc.selection!.get(5, 2)).toBeGreaterThan(245);
    expect(doc.selection!.get(5, 97)).toBeLessThan(10);
  });
});

describe("mask edge cases (review fixes)", () => {
  it("crop crops layer-set masks too", () => {
    const { doc, bus } = setup(200, 100);
    bus.dispatch("layer.newSet");
    const set = doc.activeNode!;
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 100, h: 100 });
    bus.dispatch("layer.addMask", { reveal: "hideSelection" });
    bus.dispatch("select.none");
    bus.dispatch("image.crop", { x: 100, y: 0, w: 100, h: 100 });
    expect(doc.groups[0].mask!.width).toBe(100);
    expect(red(doc, 10, 10)).toBe(0);
  });

  it("gradient and fill in Quick Mask work with nothing selected", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.quickMask", { on: true });
    bus.dispatch("select.none");
    expect(() => bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 100, y1: 0, preset: "whiteBlack" })).not.toThrow();
    bus.dispatch("edit.fill", { use: "white" });
    bus.dispatch("select.quickMask", { on: false });
    expect(doc.selection!.get(50, 50)).toBe(255);
  });

  it("transparency mask covers a layer's pixels off the canvas", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new");
    const l = doc.activeLayer!;
    l.grid = new TileGrid(300, 100);
    l.grid.fill([0, 0, 0, 255]);
    l.offsetX = -100;
    bus.dispatch("layer.addMask", { reveal: "transparency" });
    const m = doc.activeLayer!.mask!;
    expect(m.width).toBe(300);
    expect(m.get(10, 10)).toBe(255);
  });

  it("a clipped layer in a pass-through set gets the set mask once", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.newSet");
    const set = doc.activeNode!;
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.new");
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    bus.dispatch("edit.fill");
    bus.dispatch("layer.clip", { clipped: true });
    bus.dispatch("layer.select", { id: set.id });
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("edit.fill", { use: "gray" });
    const pass = doc.samplePixel(50, 50);
    bus.dispatch("layer.setProperties", { id: set.id, blendMode: "normal" });
    const iso = doc.samplePixel(50, 50);
    for (let i = 0; i < 3; i++) expect(Math.abs(pass[i] - iso[i])).toBeLessThanOrEqual(1);
  });

  it("Image > Invert on a whole mask also flips what moving it uncovers", () => {
    const { doc, bus } = setup();
    blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("image.invert");
    expect(doc.activeLayer!.mask!.defaultValue).toBe(0);
  });

  it("feathered masks dirty a wider area", () => {
    const { doc, bus } = setup(600, 100);
    blackLayer(bus, doc);
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("layer.setMaskProperties", { feather: 60 });
    const rects: { x: number; w: number }[] = [];
    doc.on((e) => e.type === "pixels" && e.rect && rects.push(e.rect));
    bus.dispatch("paint.stroke", { points: [[220, 50]], size: 20, color: [0, 0, 0] });
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    expect(maxX).toBeGreaterThan(300);
  });
});
