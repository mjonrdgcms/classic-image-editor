import { describe, expect, it } from "vitest";
import { BW_DEFAULTS, BW_PRESETS, autoWeights, blackWhite, grayFor, toneLUT } from "../src/filters/bw";
import { ActionStore, keyCombo } from "../src/ui/actionstore";
import { CommandBus } from "../src/core/commands";
import { registerBuiltins } from "../src/core/builtins";
import { Document } from "../src/core/document";
import { FILTERS } from "../src/filters";

const W = [0.4, 0.6, 0.4, 0.6, 0.2, 0.8];

describe("Black & White conversion", () => {
  it("matches the classic default mix", () => {
    expect(grayFor(255, 0, 0, W)).toBeCloseTo(102);
    expect(grayFor(255, 255, 0, W)).toBeCloseTo(153);
    expect(grayFor(0, 0, 255, W)).toBeCloseTo(51);
    expect(grayFor(255, 255, 255, W)).toBe(255);
    expect(grayFor(90, 90, 90, W)).toBe(90);
  });
  it("leaves tones alone with a neutral curve", () => {
    const lut = toneLUT(BW_DEFAULTS);
    for (const v of [0, 64, 128, 200, 255]) expect(Math.abs(lut[v] - v)).toBeLessThanOrEqual(1);
  });
  it("a red filter darkens blue sky and lightens red", () => {
    const red = BW_PRESETS.find((p) => p.name === "Red Filter")!.s;
    const sky = { w: 1, h: 1, data: new Uint8ClampedArray([90, 140, 230, 255]) };
    const neutral = blackWhite(sky, BW_DEFAULTS).data[0];
    const filtered = blackWhite(sky, { ...BW_DEFAULTS, ...red }).data[0];
    expect(filtered).toBeLessThan(neutral);
  });
  it("produces gray (or toned) pixels and keeps alpha", () => {
    const img = { w: 2, h: 1, data: new Uint8ClampedArray([200, 30, 40, 255, 20, 200, 90, 128]) };
    const out = blackWhite(img, BW_DEFAULTS);
    expect(out.data[0]).toBe(out.data[1]);
    expect(out.data[7]).toBe(128);
    const toned = blackWhite(img, { ...BW_DEFAULTS, toning: "sepia", toneAmount: 80 });
    expect(toned.data[0]).toBeGreaterThan(toned.data[2]);
  });
  it("Auto picks weights that separate tones", () => {
    const img = { w: 2, h: 1, data: new Uint8ClampedArray([220, 40, 40, 255, 40, 160, 40, 255]) };
    const a = autoWeights(img);
    const w = ["reds", "yellows", "greens", "cyans", "blues", "magentas"].map((k) => (a as Record<string, number>)[k] / 100);
    expect(Math.abs(grayFor(220, 40, 40, w) - grayFor(40, 160, 40, w))).toBeGreaterThan(Math.abs(grayFor(220, 40, 40, W) - grayFor(40, 160, 40, W)));
  });
});

describe("filter commands", () => {
  const setup = () => {
    const doc = new Document(64, 48);
    const l = doc.addLayer("Background", 0);
    l.isBackground = true;
    const px = new Uint8ClampedArray(64 * 48 * 4);
    for (let i = 0; i < 64 * 48; i++) px.set([(i * 5) % 256, (i * 3) % 256, 120, 255], i * 4);
    l.grid.writeRegion({ x: 0, y: 0, w: 64, h: 48 }, px);
    const bus = new CommandBus(doc);
    registerBuiltins(bus);
    bus.setDocument(doc, "Open");
    return { doc, bus, l };
  };
  it("every filter is a command with a schema the AI can use", () => {
    const { bus } = setup();
    for (const f of FILTERS) expect(bus.get(`filter.${f.id}`)?.params.type).toBe("object");
    expect(bus.toolSchemas().some((t) => t.function.name === "filter_cartoon")).toBe(true);
  });
  it("applies inside the selection only, records history, and fades", () => {
    const { doc, bus, l } = setup();
    bus.dispatch("select.rect", { x: 0, y: 0, w: 32, h: 48 });
    const before = l.grid.readRegion({ x: 0, y: 0, w: 64, h: 48 });
    bus.dispatch("filter.posterizeFx", { levels: 2 });
    const after = l.grid.readRegion({ x: 0, y: 0, w: 64, h: 48 });
    expect(bus.history.current!.label).toBe("Posterize");
    const outside = (40 * 64 + 50) * 4, inside = (40 * 64 + 10) * 4;
    expect(after[outside]).toBe(before[outside]);
    expect([0, 255]).toContain(after[inside]);
    bus.dispatch("filter.fade", { opacity: 0, mode: "normal" });
    expect(bus.history.current!.label).toBe("Fade Posterize");
    expect(l.grid.readRegion({ x: 10, y: 40, w: 1, h: 1 })[0]).toBe(before[inside]);
    expect(bus.isEnabled("filter.fade")).toBe(false);
    void doc;
  });
  it("Fade is only offered right after the filter", () => {
    const { bus } = setup();
    bus.dispatch("filter.gaussianBlur", { radius: 3 });
    expect(bus.isEnabled("filter.fade")).toBe(true);
    bus.history.undo();
    expect(bus.isEnabled("filter.fade")).toBe(false);
    bus.history.redo();
    expect(bus.isEnabled("filter.fade")).toBe(true);
    bus.dispatch("layer.new");
    expect(bus.isEnabled("filter.fade")).toBe(false);
  });
  it("Black & White to a new layer", () => {
    const { doc, bus } = setup();
    bus.dispatch("image.blackWhite", { output: "newLayer", contrast: 20 });
    expect(doc.layers.length).toBe(2);
    expect(doc.activeLayer!.name).toBe("Black & White");
    const p = doc.activeLayer!.grid.readRegion({ x: 5, y: 5, w: 1, h: 1 });
    expect(p[0]).toBe(p[1]);
    expect(p[1]).toBe(p[2]);
  });
});

describe("action store", () => {
  it("keeps function keys unique and round-trips sets", () => {
    const st = new ActionStore();
    const set = st.newSet("Mine");
    const a = st.newAction(set.id, "One", "F10");
    const b = st.newAction(set.id, "Two", "F10");
    expect(st.byKey("F10")!.id).toBe(b.id);
    expect(a.key).toBe("");
    a.steps.push({ command: "image.invert", params: {}, label: "Invert", enabled: true, dialog: false });
    const copy = st.importSet(st.exportSet(set.id));
    expect(copy.actions[0].steps[0].command).toBe("image.invert");
    expect(copy.actions.find((x) => x.name === "Two")!.key).toBe("");
    expect(keyCombo("F3", true, true)).toBe("Ctrl+Shift+F3");
  });
});
