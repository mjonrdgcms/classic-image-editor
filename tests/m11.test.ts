/** v0.11: scratch disk paging, Move tool auto-select, new commands. */

import { describe, expect, it } from "vitest";
import { setup } from "./m9.test";
import { MemoryStore, TilePager, needsLoading } from "../src/core/scratch";
import { EvictedTileError } from "../src/core/tiles";

const TILE_BYTES = 256 * 256 * 4;

/** A quick fingerprint of the composite (comparing megabyte arrays element by element is slow). */
const look = (doc: { composite(): Uint8ClampedArray }) => {
  const c = doc.composite();
  let a = 1, b = 0;
  for (let i = 0; i < c.length; i++) {
    a = (a + c[i]) % 65521;
    b = (b + a) % 65521;
  }
  return b * 65536 + a;
};

/** A 1024x512 image (8x2... tiles) with n fill steps, each touching a different tile column. */
function busyImage(steps: number) {
  const s = setup(1024, 512);
  const { bus } = s;
  bus.dispatch("layer.new", { name: "paint" });
  for (let i = 0; i < steps; i++) {
    bus.dispatch("select.rect", { x: (i % 4) * 256 + 10, y: (i % 2) * 256 + 10, w: 200, h: 200 });
    bus.dispatch("color.set", { which: "foreground", r: (i * 40) % 256, g: (i * 90) % 256, b: (i * 15) % 256 });
    bus.dispatch("edit.fill", { use: "foreground" });
  }
  bus.dispatch("select.none", {});
  return s;
}

describe("scratch disk paging", () => {
  it("moves old history to the scratch disk when over budget and brings it back on undo", { timeout: 30000 }, async () => {
    const { doc, bus } = busyImage(12);
    const h = bus.history;
    // Remember what every state looks like.
    const looks: number[] = [];
    for (let i = 0; i < h.states.length; i++) {
      h.jump(i);
      looks.push(look(doc));
    }
    h.jump(h.states.length - 1);
    const store = new MemoryStore();
    let budget = Infinity;
    const pager = new TilePager(store, () => [{ doc, history: h }], () => budget);
    const before = pager.measure();
    expect(before.onDisk).toBe(0);
    budget = before.inMemory * 0.6;
    const after = await pager.enforce();
    expect(after.onDisk).toBeGreaterThan(0);
    expect(after.inMemory).toBeLessThan(before.inMemory);
    expect(store.files.size).toBe(1);
    // The live document and the current state never leave memory.
    expect(look(doc)).toBe(looks[looks.length - 1]);
    // An old state can't be used until it is loaded.
    const old = h.states.findIndex((s) => needsLoading(s.snapshot));
    expect(old).toBeGreaterThanOrEqual(0);
    expect(() => h.jump(old)).toThrow(EvictedTileError);
    // Walking back through every state, loading as needed, shows each exactly as it was.
    for (let i = h.states.length - 1; i >= 0; i--) {
      await pager.ensure([h.states[i]]);
      h.jump(i);
      expect(look(doc)).toBe(looks[i]);
    }
  });

  it("evicting a tile again reuses its scratch copy, and unused scratch files are deleted", async () => {
    const { doc, bus } = busyImage(10);
    const h = bus.history;
    const store = new MemoryStore();
    let budget = 1;
    const pager = new TilePager(store, () => [{ doc, history: h }], () => budget);
    await pager.enforce();
    const files = store.files.size;
    const bytes = [...store.files.values()].reduce((n, f) => n + f.length, 0);
    // Load everything back (budget lifted), then page out again: nothing new is written.
    budget = Infinity;
    await pager.ensure(h.states);
    expect(pager.measure().onDisk).toBe(0);
    budget = 1;
    await pager.enforce();
    expect(store.files.size).toBe(files);
    expect([...store.files.values()].reduce((n, f) => n + f.length, 0)).toBe(bytes);
    // Clearing the history makes the scratch files garbage.
    await pager.ensure(h.states);
    h.clear();
    budget = Infinity;
    await pager.enforce();
    expect(store.files.size).toBe(0);
  });

  it("keeps the opened state, snapshots and pinned states in memory", async () => {
    const { doc, bus } = busyImage(8);
    const h = bus.history;
    h.addSnapshot("Mid");
    const pinned = h.states[3];
    const pager = new TilePager(new MemoryStore(), () => [{ doc, history: h, pinned: [pinned] }], () => 1);
    await pager.enforce();
    expect(needsLoading(h.opened!.snapshot)).toBe(false);
    expect(needsLoading(h.snapshots[0].snapshot)).toBe(false);
    expect(needsLoading(pinned.snapshot)).toBe(false);
    expect(needsLoading(h.states[h.index - 1].snapshot)).toBe(false);
    // Commands keep working on top of paged-out history.
    bus.dispatch("layer.new", { name: "more" });
    bus.dispatch("edit.fill", { use: "background" });
    expect(h.current!.label).toBe("Fill");
  });

  it("stops paging and reports when the scratch disk fails", async () => {
    const { doc, bus } = busyImage(6);
    const store = new MemoryStore();
    store.write = async () => {
      throw new Error("disk full");
    };
    const errors: unknown[] = [];
    const pager = new TilePager(store, () => [{ doc, history: bus.history }], () => 1);
    pager.onError = (e) => errors.push(e);
    const st = await pager.enforce();
    expect(errors.length).toBe(1);
    expect(st.onDisk).toBe(0);
    // Nothing was dropped: every state still works.
    for (let i = 0; i < bus.history.states.length; i++) bus.history.jump(i);
  });

  it("counts tiles once however many states share them", () => {
    const { doc, bus } = busyImage(4);
    const pager = new TilePager(new MemoryStore(), () => [{ doc, history: bus.history }], () => Infinity);
    const st = pager.measure();
    // 1024x512 = 8 tiles of Background, plus the painted tiles (one per step) and their edits.
    expect(st.inMemory % TILE_BYTES).toBe(0);
    expect(st.inMemory / TILE_BYTES).toBeLessThan(8 + 4 * 2 + 2);
  });
});

import { autoSelectMode, layerUnder } from "../src/tools/tools";
import { readDensity, writeDensity } from "../src/io/density";
import { fromUnits, loadPrefs, toUnits, formatLength, DEFAULT_PREFS } from "../src/prefs";
import { FILTER_MAP } from "../src/filters";
import { defaults, runFilter } from "../src/filters/types";
import { cmykToRgb, hsbToRgb, labToRgb, rgbToCmyk, rgbToHsb, rgbToLab } from "../src/ui/colorpicker";

describe("Move tool auto-select", () => {
  it("is off unless asked for; old true / false settings map to Layer / Off", () => {
    expect(autoSelectMode(undefined)).toBe("off");
    expect(autoSelectMode(false)).toBe("off");
    expect(autoSelectMode(true)).toBe("layer");
    expect(autoSelectMode("set")).toBe("set");
  });
  it("finds the topmost visible pixel, respecting masks and hidden sets", () => {
    const { doc, bus } = setup(100, 100);
    bus.dispatch("layer.new", { name: "A" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 50, h: 50 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.new", { name: "B" });
    bus.dispatch("edit.fill", { use: "white" });
    bus.dispatch("select.none", {});
    expect(layerUnder(doc, 10, 10)!.name).toBe("B");
    expect(layerUnder(doc, 80, 80)!.name).toBe("Background");
    // Hide B's pixels with a mask: A shows through.
    bus.dispatch("select.rect", { x: 0, y: 0, w: 20, h: 20 });
    bus.dispatch("layer.addMask", { reveal: "hideSelection" });
    bus.dispatch("select.none", {});
    expect(layerUnder(doc, 10, 10)!.name).toBe("A");
    expect(layerUnder(doc, 30, 30)!.name).toBe("B");
  });
});

describe("0.11 commands", () => {
  it("Merge Visible to New Layer keeps the layers and adds a merged copy", () => {
    const { doc, bus } = setup(60, 40);
    bus.dispatch("layer.new", { name: "top" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 10, h: 10 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    const before = [...doc.composite()];
    bus.dispatch("layer.stampVisible", {});
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "top", "Layer 1"]);
    expect([...doc.activeLayer!.grid.readRegion({ x: 0, y: 0, w: 60, h: 40 })]).toEqual(before);
    expect(bus.history.current!.label).toBe("Merge Visible to New Layer");
  });

  it("Fill can keep the layer's transparency", () => {
    const { doc, bus } = setup(40, 40);
    bus.dispatch("layer.new", { name: "L" });
    bus.dispatch("select.rect", { x: 0, y: 0, w: 10, h: 10 });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("select.none", {});
    bus.dispatch("color.set", { which: "foreground", r: 255, g: 0, b: 0 });
    bus.dispatch("edit.fill", { use: "foreground", preserveTransparency: true });
    const l = doc.activeLayer!;
    expect(l.grid.getPixel(5, 5)).toEqual([255, 0, 0, 255]);
    expect(l.grid.getPixel(20, 20)[3]).toBe(0);
  });

  it("Image Size sets the resolution (undoably) and .cie files keep it", async () => {
    const { decodeProject, encodeProject } = await import("../src/io/project");
    const { doc, bus } = setup(60, 40);
    expect(doc.resolution).toBe(72);
    bus.dispatch("image.resize", { width: 60, height: 40, resolution: 300 });
    expect(doc.resolution).toBe(300);
    expect(decodeProject(encodeProject(doc), "r.cie").resolution).toBe(300);
    bus.history.undo();
    expect(doc.resolution).toBe(72);
  });

  it("Auto Color removes a color cast", () => {
    const f = FILTER_MAP.get("autoColor")!;
    // A gray ramp with a strong blue cast.
    const w = 64, h = 16;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = 40 + x * 2.5;
        data.set([v * 0.8, v * 0.85, Math.min(255, v * 1.15 + 20), 255], (y * w + x) * 4);
      }
    const out = runFilter(f, { w, h, data }, defaults(f), { fg: [0, 0, 0], bg: [255, 255, 255], scale: 1 });
    // Midtones end up near gray.
    const o = (8 * w + 32) * 4;
    const [r, g, b] = [out.data[o], out.data[o + 1], out.data[o + 2]];
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
  });
});

describe("units, resolution and colors", () => {
  it("converts lengths between units at a resolution", () => {
    expect(toUnits(300, "inches", 300, 72)).toBe(1);
    expect(fromUnits(2.54, "cm", 300, 72)).toBeCloseTo(300);
    expect(toUnits(300, "points", 300, 72)).toBeCloseTo(72);
    expect(toUnits(300, "picas", 300, 72)).toBeCloseTo(6);
    expect(toUnits(50, "percent", 300, 72, 200)).toBe(25);
    expect(formatLength(150, "inches", 300, 72)).toBe("0.5");
  });

  it("reads and writes resolution in PNG and JPEG headers", () => {
    // A minimal PNG signature + IHDR + IEND (enough for the chunk walk).
    const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0, 0, 0, 0];
    const iend = [0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0];
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...ihdr, ...iend]);
    expect(readDensity(png)).toBeNull();
    const with300 = writeDensity(png, 300);
    expect(readDensity(with300)).toBe(300);
    expect(readDensity(writeDensity(with300, 150))).toBe(150);
    for (const ppi of [72, 96, 240]) expect(readDensity(writeDensity(png, ppi))).toBe(ppi);
    // JPEG with a JFIF header at 72 dpi.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1, 0, 72, 0, 72, 0, 0, 0xff, 0xda, 0, 2]);
    expect(readDensity(jpg)).toBe(72);
    expect(readDensity(writeDensity(jpg, 240))).toBe(240);
  });

  it("loads preferences over the defaults, ignoring mistyped values", () => {
    const p = loadPrefs({ memoryPercent: 30, rulerUnits: "cm", historyStates: "lots" as unknown as number, nonsense: 1 } as never);
    expect(p.memoryPercent).toBe(30);
    expect(p.rulerUnits).toBe("cm");
    expect(p.historyStates).toBe(DEFAULT_PREFS.historyStates);
    expect("nonsense" in p).toBe(false);
  });

  it("Color Picker conversions round-trip", () => {
    for (const c of [[0, 0, 0], [255, 255, 255], [200, 30, 90], [12, 180, 240], [128, 128, 128]] as [number, number, number][]) {
      const [h, s, v] = rgbToHsb(c);
      expect(hsbToRgb(h, s, v)).toEqual(c);
      const lab = rgbToLab(c);
      labToRgb(...lab).forEach((x, i) => expect(Math.abs(x - c[i])).toBeLessThanOrEqual(1));
      const k = rgbToCmyk(c);
      cmykToRgb(...k).forEach((x, i) => expect(Math.abs(x - c[i])).toBeLessThanOrEqual(1));
    }
    expect(rgbToLab([255, 255, 255])[0]).toBeCloseTo(100, 0);
  });
});

describe("scratch paging (review fixes)", () => {
  it("switching stores loads snapshot tiles back and forgets every old copy", async () => {
    const { doc, bus } = busyImage(10);
    const h = bus.history;
    const store1 = new MemoryStore();
    let budget = 1;
    const pager = new TilePager(store1, () => [{ doc, history: h }], () => budget);
    await pager.enforce();
    // Go back to a paged-out state, snapshot it, return.
    const i = h.states.findIndex((s) => needsLoading(s.snapshot));
    await pager.ensure([h.states[i]]);
    h.jump(i);
    h.addSnapshot("Back then");
    h.jump(h.states.length - 1);
    // Trim history so the snapshot is the only holder of some tiles, then switch stores.
    h.clear();
    const store2 = new MemoryStore();
    await pager.setStore(store2);
    expect(store1.files.size).toBe(0);
    // Restore the snapshot, delete it, and page again: everything still loads.
    h.restoreSnapshot(0);
    h.deleteSnapshot(0);
    bus.dispatch("layer.new", { name: "x" });
    await pager.enforce();
    for (let k = h.states.length - 1; k >= 0; k--) {
      await pager.ensure([h.states[k]]);
      h.jump(k);
      doc.composite();
    }
    budget = Infinity;
  });

  it("a History Brush source on the scratch disk is loaded first (or refused clearly)", async () => {
    const { doc, bus } = busyImage(8);
    const h = bus.history;
    const pager = new TilePager(new MemoryStore(), () => [{ doc, history: h }], () => 1);
    await pager.enforce();
    const i = h.states.findIndex((s) => needsLoading(s.snapshot));
    expect(i).toBeGreaterThan(0);
    const params = { tool: "history", points: [[20, 20], [60, 60]], size: 20, historyState: i };
    expect(() => bus.dispatch("paint.retouch", params)).toThrow(/scratch disk/);
    bus.loadStates = (st) => pager.ensure(st);
    const pending = bus.prepare("paint.retouch", params);
    expect(pending).not.toBeNull();
    await pending;
    bus.dispatch("paint.retouch", params);
    expect(h.current!.label).toBe("History Brush");
  });
});
