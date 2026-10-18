import { describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { CommandBus, ValidationError } from "../src/core/commands";
import { Document } from "../src/core/document";
import { compositePixel, dissolveHash, BLEND_MODES } from "../src/core/blend";
import { TILE, TileGrid } from "../src/core/tiles";

function setup(w = 600, h = 400) {
  const doc = new Document(w, h);
  const bg = doc.addLayer("Background", 0);
  bg.isBackground = true;
  bg.grid.fill([255, 255, 255, 255]);
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus };
}

describe("tiles", () => {
  it("copy-on-write: writes after a snapshot leave the snapshot untouched", () => {
    const g = new TileGrid(600, 300);
    g.writeRegion({ x: 10, y: 10, w: 1, h: 1 }, new Uint8ClampedArray([1, 2, 3, 255]));
    const snap = g.share();
    g.writeRegion({ x: 10, y: 10, w: 1, h: 1 }, new Uint8ClampedArray([9, 9, 9, 255]));
    expect(snap.getPixel(10, 10)).toEqual([1, 2, 3, 255]);
    expect(g.getPixel(10, 10)).toEqual([9, 9, 9, 255]);
    // Only the touched tile was copied.
    expect(TileGrid.diff(g, snap)).toHaveLength(1);
  });

  it("does not allocate tiles for transparent writes", () => {
    const g = new TileGrid(1000, 1000);
    g.writeRegion({ x: 0, y: 0, w: 1000, h: 1000 }, new Uint8ClampedArray(1000 * 1000 * 4));
    expect(g.tiles.every((t) => t === null)).toBe(true);
  });

  it("reads regions across tile boundaries", () => {
    const g = new TileGrid(600, 600);
    const data = new Uint8ClampedArray(4 * 4 * 4).map((_, i) => i % 256);
    g.writeRegion({ x: TILE - 2, y: TILE - 2, w: 4, h: 4 }, data);
    expect(Array.from(g.readRegion({ x: TILE - 2, y: TILE - 2, w: 4, h: 4 }))).toEqual(Array.from(data));
  });
});

describe("blend modes", () => {
  it("normal at 50% over white gives mid color", () => {
    const p = compositePixel("normal", [255, 255, 255, 255], [0, 0, 0, 255], 0.5, 0, 0);
    expect(p.map(Math.round)).toEqual([128, 128, 128, 255]);
  });
  it("multiply by white is identity, screen with black is identity", () => {
    expect(compositePixel("multiply", [100, 150, 200, 255], [255, 255, 255, 255], 1, 0, 0).map(Math.round)).toEqual([100, 150, 200, 255]);
    expect(compositePixel("screen", [100, 150, 200, 255], [0, 0, 0, 255], 1, 0, 0).map(Math.round)).toEqual([100, 150, 200, 255]);
  });
  it("difference of identical colors is black", () => {
    expect(compositePixel("difference", [90, 40, 200, 255], [90, 40, 200, 255], 1, 0, 0).map(Math.round)).toEqual([0, 0, 0, 255]);
  });
  it("every mode over an empty backdrop shows the source", () => {
    for (const m of BLEND_MODES) {
      if (m === "dissolve") continue;
      expect(compositePixel(m, [0, 0, 0, 0], [10, 20, 30, 255], 1, 0, 0).map(Math.round)).toEqual([10, 20, 30, 255]);
    }
  });
  it("luminosity keeps backdrop hue", () => {
    const p = compositePixel("luminosity", [255, 0, 0, 255], [128, 128, 128, 255], 1, 0, 0);
    expect(p[0]).toBeGreaterThan(p[1]);
  });
  it("dissolve hash is uniform-ish", () => {
    let n = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (dissolveHash(x, y) < 0.3) n++;
    expect(n / 10000).toBeGreaterThan(0.27);
    expect(n / 10000).toBeLessThan(0.33);
  });
});

describe("command bus and history", () => {
  it("validates parameters before running", () => {
    const { bus } = setup();
    expect(() => bus.dispatch("layer.setProperties", { opacity: 150 })).toThrow(ValidationError);
    expect(() => bus.dispatch("layer.setProperties", { blendMode: "plaid" })).toThrow(ValidationError);
    expect(() => bus.dispatch("nope.nothing")).toThrow(ValidationError);
    expect(() => bus.dispatch("select.rect", { x: 0, y: 0, w: 10 })).toThrow(/h is required/);
  });

  it("records history and undoes/redoes", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    expect(doc.layers).toHaveLength(2);
    expect(bus.history.states.map((s) => s.label)).toEqual(["New", "New Layer", "Fill"]);
    bus.history.undo();
    expect(doc.activeLayer!.grid.getPixel(5, 5)[3]).toBe(0);
    bus.history.undo();
    expect(doc.layers).toHaveLength(1);
    bus.history.redo();
    bus.history.redo();
    expect(doc.activeLayer!.grid.getPixel(5, 5)).toEqual([0, 0, 0, 255]);
  });

  it("PS7 Ctrl+Z toggles between undo and redo", () => {
    const { bus } = setup();
    bus.dispatch("layer.new");
    bus.history.toggle();
    expect(bus.history.index).toBe(0);
    bus.history.toggle();
    expect(bus.history.index).toBe(1);
  });

  it("new actions after undo discard the redo branch", () => {
    const { bus } = setup();
    bus.dispatch("layer.new");
    bus.dispatch("layer.new");
    bus.history.undo();
    bus.dispatch("select.all");
    expect(bus.history.states.map((s) => s.label)).toEqual(["New", "New Layer", "Select All"]);
  });

  it("does not record non-history commands", () => {
    const { bus } = setup();
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    expect(bus.history.states).toHaveLength(1);
    expect(bus.doc.foreground).toEqual([255, 0, 0, 255]);
  });

  it("groups several commands into one undo step and rolls back on failure", () => {
    const { doc, bus } = setup();
    bus.group("AI: darken", () => {
      bus.dispatch("layer.new", { name: "shade" });
      bus.dispatch("edit.fill", { use: "black" });
      bus.dispatch("layer.setProperties", { opacity: 40, blendMode: "multiply" });
    });
    expect(bus.history.states.map((s) => s.label)).toEqual(["New", "AI: darken"]);
    expect(doc.layers).toHaveLength(2);
    expect(() =>
      bus.group("AI: broken", () => {
        bus.dispatch("layer.new");
        bus.dispatch("layer.setProperties", { opacity: 999 });
      }),
    ).toThrow();
    expect(doc.layers).toHaveLength(2);
    expect(bus.history.states).toHaveLength(2);
  });

  it("exposes commands as LLM tool schemas", () => {
    const { bus } = setup();
    const tools = bus.toolSchemas();
    const fill = tools.find((t) => t.function.name === "edit_fill")!;
    expect(fill.function.parameters.properties.use).toBeDefined();
  });

  it("protects the Background layer", () => {
    const { bus } = setup();
    expect(() => bus.dispatch("layer.offset", { dx: 5, dy: 0 })).toThrow();
    bus.dispatch("layer.fromBackground");
    bus.dispatch("layer.offset", { dx: 5, dy: 0 });
    expect(bus.doc.layers[0].offsetX).toBe(5);
  });
});

describe("painting", () => {
  it("a stroke never exceeds its opacity even where dabs overlap", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new");
    bus.dispatch("paint.stroke", {
      points: [
        [50, 50],
        [60, 50],
        [50, 50],
        [55, 52],
      ],
      size: 20,
      hardness: 100,
      opacity: 50,
      color: [0, 0, 255],
    });
    const a = doc.activeLayer!.grid.getPixel(55, 50);
    expect(a[2]).toBe(255);
    expect(a[3]).toBe(128);
  });

  it("the eraser on the Background paints the background color", () => {
    const { doc, bus } = setup();
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("paint.stroke", { tool: "eraser", points: [[100, 100]], size: 10 });
    expect(doc.layers[0].grid.getPixel(100, 100)).toEqual([255, 255, 255, 255]);
  });

  it("painting is clipped to the selection", () => {
    const { doc, bus } = setup();
    bus.dispatch("select.rect", { x: 0, y: 0, w: 100, h: 400 });
    bus.dispatch("paint.stroke", { points: [[100, 100]], size: 40, color: [255, 0, 0] });
    expect(doc.layers[0].grid.getPixel(95, 100)).toEqual([255, 0, 0, 255]);
    expect(doc.layers[0].grid.getPixel(105, 100)).toEqual([255, 255, 255, 255]);
  });

  it("paint bucket fills a contiguous region only", () => {
    const { doc, bus } = setup(300, 300);
    bus.dispatch("color.set", { r: 0, g: 0, b: 0 });
    // A vertical black wall at x = 150.
    bus.dispatch("paint.stroke", { points: [[150, 0], [150, 300]], size: 4 });
    bus.dispatch("color.set", { r: 255, g: 0, b: 0 });
    bus.dispatch("paint.bucket", { x: 10, y: 10, tolerance: 10 });
    const g = doc.layers[0].grid;
    expect(g.getPixel(10, 10)).toEqual([255, 0, 0, 255]);
    expect(g.getPixel(140, 290)).toEqual([255, 0, 0, 255]);
    expect(g.getPixel(200, 10)).toEqual([255, 255, 255, 255]);
  });

  it("merge down bakes blend mode and opacity", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new");
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.setProperties", { opacity: 50 });
    const before = doc.samplePixel(10, 10);
    bus.dispatch("layer.mergeDown");
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].grid.getPixel(10, 10)).toEqual(before);
  });

  it("flatten turns transparency white", () => {
    const { doc, bus } = setup(64, 64);
    bus.dispatch("layer.fromBackground");
    bus.dispatch("edit.clear");
    bus.dispatch("image.flatten");
    expect(doc.layers[0].isBackground).toBe(true);
    expect(doc.layers[0].grid.getPixel(1, 1)).toEqual([255, 255, 255, 255]);
  });

  it("undo after a stroke restores the exact pixels", () => {
    const { doc, bus } = setup();
    const before = Array.from(doc.layers[0].grid.readRegion({ x: 0, y: 0, w: 600, h: 400 }));
    bus.dispatch("paint.stroke", { points: [[10, 10], [500, 300]], size: 30, hardness: 0 });
    bus.history.undo();
    expect(Array.from(doc.layers[0].grid.readRegion({ x: 0, y: 0, w: 600, h: 400 }))).toEqual(before);
  });
});
