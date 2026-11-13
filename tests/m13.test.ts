/** v0.13: Merge Up, history labels and "replaces" for repeated nudges. */

import { describe, expect, it } from "vitest";
import { setup } from "./m9.test";

describe("Merge Up", () => {
  it("merges the active layer into the one above, keeping the upper layer's name, and looks the same", () => {
    const { doc, bus } = setup(120, 80);
    bus.dispatch("layer.new", { name: "Lower" });
    bus.dispatch("select.rect", { x: 10, y: 10, w: 50, h: 40 });
    bus.dispatch("color.set", { which: "foreground", r: 200, g: 30, b: 30 });
    bus.dispatch("edit.fill", { use: "foreground" });
    bus.dispatch("layer.new", { name: "Upper" });
    bus.dispatch("select.rect", { x: 40, y: 20, w: 60, h: 40 });
    bus.dispatch("color.set", { which: "foreground", r: 20, g: 40, b: 220 });
    bus.dispatch("edit.fill", { use: "foreground" });
    bus.dispatch("select.none", {});
    bus.dispatch("layer.setProperties", { opacity: 50 });
    const lower = doc.layers.find((l) => l.name === "Lower")!;
    bus.dispatch("layer.select", { id: lower.id });
    const before = Array.from(doc.composite());
    expect(bus.isEnabled("layer.mergeUp")).toBe(true);
    bus.dispatch("layer.mergeUp", {});
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "Upper"]);
    expect(doc.activeLayer!.name).toBe("Upper");
    expect(doc.activeLayer!.opacity).toBe(1);
    const after = Array.from(doc.composite());
    expect(after.every((v, i) => Math.abs(v - before[i]) <= 1)).toBe(true);
    expect(bus.history.current!.label).toBe("Merge Up");
    bus.history.undo();
    expect(doc.layers.map((l) => l.name)).toEqual(["Background", "Lower", "Upper"]);
  });

  it("isn't available for the top layer, a layer under a set, or several layers", () => {
    const { doc, bus } = setup(64, 64);
    bus.dispatch("layer.new", { name: "A" });
    expect(bus.isEnabled("layer.mergeUp")).toBe(false);
    bus.dispatch("layer.new", { name: "B" });
    bus.dispatch("layer.select", { id: doc.layers.find((l) => l.name === "A")!.id });
    expect(bus.isEnabled("layer.mergeUp")).toBe(true);
    bus.dispatch("layer.select", { id: doc.layers.find((l) => l.name === "B")!.id, mode: "toggle" });
    expect(bus.isEnabled("layer.mergeUp")).toBe(false);
  });

  it("merging up from the Background keeps the Background", () => {
    const { doc, bus } = setup(64, 64);
    bus.dispatch("layer.new", { name: "Paint" });
    bus.dispatch("edit.fill", { use: "black" });
    bus.dispatch("layer.select", { id: doc.layers[0].id });
    bus.dispatch("layer.mergeUp", {});
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].isBackground).toBe(true);
    expect(doc.layers[0].name).toBe("Background");
    expect(doc.layers[0].grid.getPixel(5, 5)).toEqual([0, 0, 0, 255]);
  });
});

describe("dispatch options", () => {
  it("a label replaces the command's own in the History, and replaces is passed to recorders", () => {
    const { doc, bus } = setup(64, 64);
    bus.dispatch("layer.new", { name: "L" });
    const seen: { label: string; replaces?: boolean }[] = [];
    bus.onCommand((r) => seen.push({ label: r.label, replaces: r.replaces }));
    bus.dispatch("layer.offset", { dx: 3, dy: 0 }, { label: "Nudge" });
    expect(bus.history.current!.label).toBe("Nudge");
    // A repeated nudge steps back and runs one move by the total.
    bus.history.jump(bus.history.index - 1);
    bus.dispatch("layer.offset", { dx: 5, dy: 0 }, { label: "Nudge", replaces: true });
    expect(doc.activeLayer!.offsetX).toBe(5);
    expect(bus.history.states.filter((s) => s.label === "Nudge")).toHaveLength(1);
    expect(seen).toEqual([{ label: "Nudge", replaces: undefined }, { label: "Nudge", replaces: true }]);
  });
});
