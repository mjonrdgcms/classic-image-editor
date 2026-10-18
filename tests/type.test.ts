import { beforeAll, describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { NeedsRasterizeError } from "../src/core/cmd/common";
import { CommandBus } from "../src/core/commands";
import { Document } from "../src/core/document";
import { TextSpec, setTextRenderer } from "../src/core/text";
import catalog from "../src/text/fontcatalog.json";

const shipped = new Set(Object.keys(import.meta.glob("../public/fonts/**/*.{woff2,txt}")).map((k) => k.replace("../public/fonts/", "")));

/** Stand-in renderer (no canvas in Node): a solid block 10 px per character, anchor on its baseline. */
beforeAll(() => {
  setTextRenderer((t: TextSpec) => {
    const lines = t.content.split("\n");
    const w = t.box ? t.box.w : Math.max(1, Math.max(...lines.map((l) => l.length)) * 10);
    const h = t.box ? t.box.h : Math.round(t.size * lines.length);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([t.color[0], t.color[1], t.color[2], 255], i * 4);
    return { w, h, ox: 0, oy: t.box ? 0 : Math.round(t.size * 0.8), data };
  });
});

function setup(w = 300, h = 200) {
  const doc = new Document(w, h);
  const bg = doc.addLayer("Background", 0);
  bg.isBackground = true;
  bg.grid.fill([255, 255, 255, 255]);
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus };
}

describe("type layers", () => {
  it("creates an editable type layer anchored where you clicked", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hello", size: 20, color: [255, 0, 0] });
    const l = doc.activeLayer!;
    expect(l.text?.content).toBe("Hello");
    expect(l.name).toBe("Hello");
    // Baseline at y=50: the block starts 16 px above it.
    expect(l.bounds()).toEqual({ x: 20, y: 34, w: 50, h: 20 });
    expect(doc.samplePixel(25, 40)).toEqual([255, 0, 0, 255]);
    bus.history.undo();
    expect(doc.layers).toHaveLength(1);
  });

  it("uses the foreground color by default", () => {
    const { doc, bus } = setup();
    bus.dispatch("color.set", { r: 10, g: 20, b: 30 });
    bus.dispatch("type.create", { x: 0, y: 40, content: "a" });
    expect(doc.activeLayer!.text!.color).toEqual([10, 20, 30]);
  });

  it("editing keeps the anchor, renames an automatic name, keeps a custom one", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20 });
    bus.dispatch("type.edit", { content: "Hello there" });
    let l = doc.activeLayer!;
    expect(l.name).toBe("Hello there");
    expect(l.bounds()).toEqual({ x: 20, y: 34, w: 110, h: 20 });
    bus.dispatch("layer.setProperties", { name: "Title" });
    bus.dispatch("type.edit", { content: "Changed", size: 40 });
    l = doc.activeLayer!;
    expect(l.name).toBe("Title");
    expect(l.text!.size).toBe(40);
    expect(l.bounds().y).toBe(50 - 32);
    bus.history.undo();
    expect(doc.activeLayer!.text!.content).toBe("Hello there");
  });

  it("moving the layer moves the text; later edits stay where it was moved", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20 });
    bus.dispatch("layer.offset", { dx: 30, dy: 10 });
    bus.dispatch("type.edit", { content: "Hiya" });
    expect(doc.activeLayer!.bounds()).toEqual({ x: 50, y: 44, w: 40, h: 20 });
  });

  it("painting or filtering a type layer asks for rasterizing first", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20 });
    expect(() => bus.dispatch("paint.stroke", { points: [[25, 40]], size: 5 })).toThrow(NeedsRasterizeError);
    expect(() => bus.dispatch("filter.gaussianBlur", { radius: 2 })).toThrow(NeedsRasterizeError);
    expect(() => bus.dispatch("edit.fill", { use: "black" })).toThrow(NeedsRasterizeError);
    bus.dispatch("layer.rasterizeType");
    expect(doc.activeLayer!.text).toBeNull();
    expect(() => bus.dispatch("paint.stroke", { points: [[25, 40]], size: 5 })).not.toThrow();
  });

  it("a mask on a type layer stays on the canvas when the text changes", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hello", size: 20 });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 40, h: 200 });
    bus.dispatch("layer.addMask", { reveal: "selection" });
    bus.dispatch("select.none");
    expect(doc.samplePixel(30, 40)[0]).toBe(0);
    expect(doc.samplePixel(50, 40)[0]).toBe(255);
    bus.dispatch("type.edit", { content: "Hello world" });
    expect(doc.samplePixel(30, 40)[0]).toBe(0);
    expect(doc.samplePixel(100, 40)[0]).toBe(255);
  });

  it("crop keeps type editable and in place", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 120, y: 80, content: "Hi", size: 20 });
    bus.dispatch("image.crop", { x: 100, y: 50, w: 100, h: 100 });
    const l = doc.activeLayer!;
    expect(l.text).not.toBeNull();
    expect(l.bounds()).toEqual({ x: 20, y: 14, w: 20, h: 20 });
  });

  it("duplicate keeps the text; merging into a type layer needs rasterizing", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20 });
    bus.dispatch("layer.duplicate");
    expect(doc.activeLayer!.text?.content).toBe("Hi");
    expect(() => bus.dispatch("layer.mergeDown")).toThrow(NeedsRasterizeError);
  });

  it("paragraph text and converting to point text", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 10, y: 10, content: "Some words", box: { w: 80, h: 60 } });
    expect(doc.activeLayer!.bounds()).toEqual({ x: 10, y: 10, w: 80, h: 60 });
    bus.dispatch("type.edit", { pointText: true });
    expect(doc.activeLayer!.text!.box).toBeNull();
    bus.dispatch("type.edit", { box: { w: 50, h: 50 } });
    expect(doc.activeLayer!.text!.box).toEqual({ w: 50, h: 50 });
  });
});

describe("type layers (review fixes)", () => {
  it("converting point <-> paragraph text keeps the text in place", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20 });
    const b0 = doc.activeLayer!.bounds();
    bus.dispatch("type.edit", { box: { w: 100, h: 40 } });
    expect(doc.activeLayer!.bounds()).toMatchObject({ x: 20, y: b0.y });
    bus.dispatch("type.edit", { pointText: true });
    expect(doc.activeLayer!.bounds()).toEqual(b0);
  });

  it("editing text never crops what was painted on its mask", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hello world", size: 20 });
    bus.dispatch("layer.addMask", { reveal: "all" });
    bus.dispatch("select.rect", { x: 80, y: 0, w: 100, h: 200 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none");
    bus.dispatch("type.edit", { content: "Hello" });
    bus.dispatch("type.edit", { content: "Hello world" });
    expect(doc.samplePixel(100, 40)[0]).toBe(255);
    expect(doc.samplePixel(30, 40)[0]).toBe(0);
  });

  it("Black & White to a new layer works from a type layer, which stays editable", () => {
    const { doc, bus } = setup();
    bus.dispatch("type.create", { x: 20, y: 50, content: "Hi", size: 20, color: [255, 0, 0] });
    const id = doc.activeLayerId;
    bus.dispatch("image.blackWhite", { output: "newLayer" });
    expect(doc.activeLayer!.text).toBeNull();
    expect(doc.layerById(id)!.text).not.toBeNull();
  });
});

describe("font library", () => {
  it("bundles 100+ families and every file is present", () => {
    const cat = catalog as { families: { id: string; category: string; faces: { file: string }[] }[] };
    expect(cat.families.length).toBeGreaterThanOrEqual(100);
    const cats = new Set(cat.families.map((f) => f.category));
    for (const c of ["sans", "serif", "display", "comic", "script", "mono"]) expect(cats.has(c)).toBe(true);
    for (const f of cat.families) {
      expect(f.faces.length).toBeGreaterThan(0);
      for (const face of f.faces) expect(shipped.has(face.file)).toBe(true);
      expect(shipped.has(`licenses/${f.id}.txt`)).toBe(true);
    }
  });
});
