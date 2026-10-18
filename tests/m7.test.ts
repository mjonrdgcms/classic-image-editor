/** v0.7: Liquify, people detection (with a stand-in segmenter), Face-Aware Liquify, Face Swap, AI model files. */

import { describe, expect, it } from "vitest";
import { registerBuiltins } from "../src/core/builtins";
import { NeedsRasterizeError } from "../src/core/cmd/common";
import { adjustMatte, setPeopleProvider } from "../src/core/cmd/people";
import { CommandBus } from "../src/core/commands";
import { Document } from "../src/core/document";
import { LiquifyField, applyDab, decodeMesh, encodeMesh, reconstructAll, warpPixels, type Brush } from "../src/core/liquify";
import { CLASS, analyzePeople, components, geodesic, matteToMask, peopleMatte, splitWideHeads, type SegOut } from "../src/ai/people";
import { FACE_SLIDERS, faceField, faceGeometry } from "../src/ai/faceaware";
import { MODEL_FILES, TASKS_VISION_VERSION } from "../src/ai/models";
import type { Img } from "../src/filters/img";
import { CANON } from "../src/ai/facemesh";
import { MIRROR_TRI, faceBox, mouthOpen, swapFace, visibility } from "../src/ai/faceswap";
import { b64 } from "../src/core/cmd/faceswap";
import tasksVisionPkg from "../node_modules/@mediapipe/tasks-vision/package.json";

const brush = (o: Partial<Brush> = {}): Brush => ({ radius: 20, density: 0.5, pressure: 1, rate: 0.8, jitter: 0.5, mode: "revert", ...o });

function setup(w = 64, h = 64) {
  const doc = new Document(w, h);
  const bg = doc.addLayer("Background", 0);
  bg.isBackground = true;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x * 4, y * 4, 128, 255], (y * w + x) * 4);
  bg.grid.writeRegion({ x: 0, y: 0, w, h }, d);
  const bus = new CommandBus(doc);
  registerBuiltins(bus);
  bus.setDocument(doc, "New");
  return { doc, bus, bg };
}

// ------------------------------------------------------------------ Liquify

describe("liquify field", () => {
  it("starts as the identity and a warp dab pushes pixels along the drag", () => {
    const f = new LiquifyField(100, 100);
    expect(f.dx.every((v) => v === 0)).toBe(true);
    applyDab(f, "warp", 50, 50, [6, 0], brush());
    // Backward map: the output at the center now shows what was to its left.
    expect(f.dx[50 * 100 + 50]).toBeLessThan(-1);
    expect(f.dx[50 * 100 + 5]).toBe(0);
    expect(f.takeDirty()).not.toBeNull();
    expect(f.takeDirty()).toBeNull();
  });

  it("bloat samples nearer the center, pucker farther out, twirl turns", () => {
    const b = new LiquifyField(80, 80), p = new LiquifyField(80, 80), t = new LiquifyField(80, 80);
    applyDab(b, "bloat", 40, 40, [0, 0], brush());
    applyDab(p, "pucker", 40, 40, [0, 0], brush());
    applyDab(t, "twirlCW", 40, 40, [0, 0], brush());
    const i = 40 * 80 + 50; // right of the center
    expect(b.dx[i]).toBeLessThan(0);
    expect(p.dx[i]).toBeGreaterThan(0);
    expect(Math.abs(t.dy[i])).toBeGreaterThan(Math.abs(t.dx[i]));
  });

  it("frozen areas don't move, and Reconstruct (revert) restores the rest", () => {
    const f = new LiquifyField(100, 100);
    applyDab(f, "freeze", 30, 50, [0, 0], brush({ radius: 12, density: 1 }));
    expect(f.freeze[50 * 100 + 30]).toBeGreaterThan(0.9);
    for (let k = 0; k < 5; k++) applyDab(f, "warp", 30 + k * 4, 50, [4, 0], brush({ radius: 25 }));
    expect(Math.abs(f.dx[50 * 100 + 30])).toBeLessThan(0.2);
    expect(Math.abs(f.dx[50 * 100 + 47])).toBeGreaterThan(0.5);
    reconstructAll(f, "revert", 1);
    expect(Math.abs(f.dx[50 * 100 + 47])).toBeLessThan(1e-6);
  });

  it("partial reconstruct moves part way back", () => {
    const f = new LiquifyField(60, 60);
    applyDab(f, "warp", 30, 30, [5, 0], brush());
    const before = f.dx[30 * 60 + 30];
    reconstructAll(f, "revert", 0.5);
    expect(f.dx[30 * 60 + 30]).toBeCloseTo(before / 2, 4);
  });

  it("Push Left moves content to the left of the stroke (Alt: right)", () => {
    const f = new LiquifyField(80, 80), g = new LiquifyField(80, 80);
    applyDab(f, "push", 40, 40, [0, -4], brush()); // dragging up
    applyDab(g, "push", 40, 40, [0, -4], brush(), true);
    // Backward map: content moved left means the center samples from its right.
    expect(f.dx[40 * 80 + 40]).toBeGreaterThan(0.5);
    expect(g.dx[40 * 80 + 40]).toBeLessThan(-0.5);
  });

  it("Rigid reconstruct stays continuous with a frozen band and is quick on a big field", () => {
    const w = 1600, h = 1000;
    const f = new LiquifyField(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        f.dx[i] = 10;
        if (x >= 700 && x < 730) f.freeze[i] = 1;
      }
    const t = performance.now();
    reconstructAll(f, "rigid", 1);
    expect(performance.now() - t).toBeLessThan(1500);
    const row = 500 * w;
    expect(f.dx[row + 715]).toBe(10);
    // Just outside the band the field is still close to the frozen value, and it falls smoothly.
    expect(f.dx[row + 735]).toBeGreaterThan(7);
    let jump = 0;
    for (let x = 600; x < 900; x++) jump = Math.max(jump, Math.abs(f.dx[row + x + 1] - f.dx[row + x]));
    expect(jump).toBeLessThan(0.5);
    expect(Math.abs(f.dx[row + 2])).toBeLessThan(0.5);
  });

  it("other reconstruct modes keep the image edge pinned", () => {
    for (const mode of ["rigid", "stiff", "smooth", "loose"] as const) {
      const f = new LiquifyField(64, 64);
      applyDab(f, "warp", 32, 32, [5, 3], brush({ radius: 30 }));
      reconstructAll(f, mode, 1);
      expect(Math.abs(f.dx[0])).toBeLessThan(0.05);
      expect(f.dx.every(Number.isFinite)).toBe(true);
    }
  });

  it("encodes sparsely and round-trips to 1/16 px", () => {
    const f = new LiquifyField(200, 150);
    applyDab(f, "warp", 40, 40, [7, -3], brush());
    const m = encodeMesh(f.dx, f.dy, f.w, f.h);
    expect(m.tiles.length).toBeGreaterThan(0);
    expect(m.tiles.length).toBeLessThan(Math.ceil(200 / 32) * Math.ceil(150 / 32));
    const back = decodeMesh(JSON.parse(JSON.stringify(m)));
    let err = 0;
    for (let i = 0; i < f.dx.length; i++) err = Math.max(err, Math.abs(back.dx[i] - f.dx[i]), Math.abs(back.dy[i] - f.dy[i]));
    expect(err).toBeLessThanOrEqual(1 / 32 + 1e-6);
  });

  it("warpPixels with an empty field is the identity; a field at another size scales", () => {
    const w = 20, h = 10;
    const src = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 7) % 256);
    for (let i = 3; i < src.length; i += 4) src[i] = 255;
    expect([...warpPixels(src, w, h, new Float32Array(10 * 5), new Float32Array(10 * 5), 10, 5)]).toEqual([...src]);
    // A half-size field shifting 1 field px = 2 image px.
    const dx = new Float32Array(10 * 5).fill(1);
    const out = warpPixels(src, w, h, dx, new Float32Array(50), 10, 5);
    expect(out[(3 * w + 4) * 4]).toBe(src[(3 * w + 6) * 4]);
  });
});

describe("image.liquify command", () => {
  const shift = (w: number, h: number, by: number) => encodeMesh(new Float32Array(w * h).fill(by), new Float32Array(w * h), w, h);

  it("warps the layer and undoes in one step", () => {
    const { doc, bus, bg } = setup();
    const before = bg.grid.readRegion({ x: 0, y: 0, w: 64, h: 64 });
    bus.dispatch("image.liquify", { mesh: shift(32, 32, 2) });
    const px = bg.grid.readRegion({ x: 10, y: 10, w: 1, h: 1 });
    expect(px[0]).toBe(14 * 4); // shows the pixel 4 image px to the right
    expect(bus.history.current!.label).toBe("Liquify");
    bus.history.undo();
    expect([...doc.layers[0].grid.readRegion({ x: 0, y: 0, w: 64, h: 64 })]).toEqual([...before]);
  });

  it("only changes the selected part", () => {
    const { bus, bg } = setup();
    bus.dispatch("select.rect", { x: 0, y: 0, w: 32, h: 64 });
    bus.dispatch("image.liquify", { mesh: shift(64, 64, 3) });
    expect(bg.grid.readRegion({ x: 10, y: 5, w: 1, h: 1 })[0]).toBe(13 * 4);
    expect(bg.grid.readRegion({ x: 50, y: 5, w: 1, h: 1 })[0]).toBe(50 * 4);
  });

  it("asks to rasterize type layers", () => {
    const { doc, bus } = setup();
    bus.dispatch("layer.new", { name: "t" });
    doc.activeLayer!.text = { content: "x" } as never;
    expect(() => bus.dispatch("image.liquify", { mesh: shift(8, 8, 1) })).toThrow(NeedsRasterizeError);
  });
});

// ------------------------------------------------------------------ people

/**
 * A synthetic scene: two "people" side by side whose bodies touch. Colors
 * stand for classes, and the stand-in segmenter reads them back.
 */
const COLORS: Record<number, [number, number, number]> = {
  [CLASS.background]: [120, 200, 120],
  [CLASS.hair]: [40, 20, 10],
  [CLASS.faceSkin]: [230, 180, 150],
  [CLASS.clothes]: [200, 0, 0],
};
function scene(): Img {
  const w = 400, h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (x: number, y: number, c: [number, number, number]) => data.set([...c, 255], (y * w + x) * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = COLORS[CLASS.background];
      for (const [hx, body] of [
        [120, [200, 0, 0]],
        [270, [0, 60, 220]],
      ] as const) {
        const d = Math.hypot(x - hx, y - 80);
        if (d < 26) c = y < 72 ? COLORS[CLASS.hair] : COLORS[CLASS.faceSkin];
        else if (y >= 104 && y < 295 && Math.abs(x - hx) < 75) c = body as unknown as [number, number, number];
      }
      put(x, y, c);
    }
  return { w, h, data };
}
const fakeSegment = (img: Img): SegOut => {
  const n = img.w * img.h;
  const conf = Array.from({ length: 6 }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    const near = (c: [number, number, number]) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < 60;
    let k: number = CLASS.clothes;
    if (near(COLORS[CLASS.background])) k = CLASS.background;
    else if (near(COLORS[CLASS.hair])) k = CLASS.hair;
    else if (near(COLORS[CLASS.faceSkin])) k = CLASS.faceSkin;
    for (let c = 0; c < 6; c++) conf[c][i] = c === k ? 0.96 : 0.008;
  }
  return { conf };
};

describe("people", () => {
  it("labels connected blobs", () => {
    const m = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const c = components(m, 4, 3);
    expect(c.comps.length).toBe(2);
    expect(c.comps.map((x) => x.area).sort()).toEqual([2, 2]);
  });

  it("splits a wide blob of two heads at the neck between them", () => {
    const w = 60, h = 20;
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - 15, y - 10) < 10 || Math.hypot(x - 44, y - 10) < 10 || (y === 10 && x > 20 && x < 40)) m[y * w + x] = 1;
    const c = components(m, w, h);
    expect(c.comps.length).toBe(1);
    splitWideHeads(c, w);
    expect(c.comps.filter((x) => x.area > 0).length).toBe(2);
  });

  it("grows seeds through allowed pixels and stops at color edges", () => {
    const w = 20, h = 5;
    const rgb = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) rgb.set(i % w < 10 ? [200, 0, 0, 255] : [0, 0, 200, 255], i * 4);
    const seeds = new Int32Array(w * h);
    seeds[2 * w + 1] = 1;
    seeds[2 * w + 15] = 2;
    const lab = geodesic(seeds, new Uint8Array(w * h).fill(1), rgb, w, h);
    expect(lab[2 * w + 8]).toBe(1);
    expect(lab[2 * w + 11]).toBe(2);
    expect(lab.every((v) => v > 0)).toBe(true);
  });

  it("finds two touching people and tells them apart", async () => {
    const m = await analyzePeople(scene(), fakeSegment);
    expect(m.people.length).toBe(2);
    expect(m.people[0].box.x).toBeLessThan(m.people[1].box.x);
    expect(m.people[0].head).not.toBeNull();
    const at = (a: Float32Array, x: number, y: number) => a[y * m.w + x];
    const left = peopleMatte(m, { people: [0], parts: null });
    const right = peopleMatte(m, { people: [1], parts: null });
    expect(at(left, 120, 200)).toBeGreaterThan(0.9);
    expect(at(left, 270, 200)).toBeLessThan(0.1);
    expect(at(right, 270, 200)).toBeGreaterThan(0.9);
    expect(at(left, 20, 20)).toBeLessThan(0.05);
    const hair = peopleMatte(m, { people: null, parts: ["hair"] });
    expect(at(hair, 120, 62)).toBeGreaterThan(0.8);
    expect(at(hair, 120, 200)).toBeLessThan(0.1);
    const mask = matteToMask(left, m.w, m.h, 800, 600);
    expect(mask[400 * 800 + 240]).toBeGreaterThan(230);
  });

  it("shift edge grows or shrinks a matte", () => {
    const w = 40, h = 40;
    const m = new Float32Array(w * h);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) m[y * w + x] = 1;
    const grown = adjustMatte(m, w, h, 0, 6), shrunk = adjustMatte(m, w, h, 0, -6);
    expect(grown[20 * w + 8]).toBeGreaterThan(0.5);
    expect(shrunk[20 * w + 11]).toBeLessThan(0.5);
    expect(shrunk[20 * w + 20]).toBeGreaterThan(0.99);
  });

  it("select.people uses the prepared analysis and records like any command", async () => {
    const img = scene();
    const doc = new Document(img.w, img.h);
    const l = doc.addLayer("Background", 0);
    l.grid.writeRegion({ x: 0, y: 0, w: img.w, h: img.h }, img.data);
    const bus = new CommandBus(doc);
    registerBuiltins(bus);
    bus.setDocument(doc, "New");
    let ready: Awaited<ReturnType<typeof analyzePeople>> | null = null;
    setPeopleProvider({
      get: () => ready,
      prepare: async () => {
        ready = await analyzePeople(img, fakeSegment);
      },
    });
    try {
      expect(() => bus.dispatch("select.people", { people: [1] })).toThrow(/not been detected/);
      const p = bus.prepare("select.people", { people: [1] });
      expect(p).not.toBeNull();
      await p;
      expect(bus.prepare("select.people", { people: [1] })).toBeNull();
      bus.dispatch("select.people", { people: [1], mode: "replace" });
      expect(doc.selection!.get(270, 200)).toBeGreaterThan(200);
      expect(doc.selection!.get(120, 200)).toBeLessThan(30);
      bus.dispatch("select.subject", { mode: "replace" });
      expect(doc.selection!.get(120, 200)).toBeGreaterThan(200);
      expect(() => bus.dispatch("select.people", { people: [5] })).toThrow(/only 2 people/);
    } finally {
      setPeopleProvider(null);
    }
  });
});

// ------------------------------------------------------------------ Face-Aware Liquify

/** Landmarks for a level face: eyes at y=100, x=80/120 (corners 70..90, 110..130). */
function fakeFace(): Float32Array {
  const pts = new Float32Array(478 * 2).fill(100);
  const set = (i: number, x: number, y: number) => {
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
  };
  set(33, 70, 100), set(133, 90, 100), set(362, 110, 100), set(263, 130, 100);
  set(1, 100, 125), set(2, 100, 130), set(61, 85, 145), set(291, 115, 145), set(0, 100, 140), set(17, 100, 152), set(13, 100, 144), set(14, 100, 147);
  set(152, 100, 175), set(10, 100, 55), set(172, 70, 160), set(397, 130, 160), set(234, 60, 110), set(454, 140, 110);
  return pts;
}

describe("face-aware liquify", () => {
  it("reads the face frame from the landmarks", () => {
    const g = faceGeometry(fakeFace());
    expect(g.F).toBeCloseTo(40);
    expect(g.right[0]).toBeCloseTo(1);
    expect(g.up[1]).toBeCloseTo(-1);
    expect(g.mouthL[0]).toBeLessThan(g.mouthR[0]);
  });

  it("neutral sliders give no displacement", () => {
    const f = faceField([{ geo: faceGeometry(fakeFace()), adj: {} }], 200, 200);
    expect(f.dx.every((v) => v === 0) && f.dy.every((v) => v === 0)).toBe(true);
  });

  it("each slider moves something, and bigger eyes sample toward the eye center", () => {
    const geo = faceGeometry(fakeFace());
    for (const s of FACE_SLIDERS) {
      const adj = s.perEye ? { [s.id + "L"]: 60, [s.id + "R"]: 60 } : { [s.id]: 60 };
      const f = faceField([{ geo, adj }], 200, 200);
      expect(f.dx.some((v) => v !== 0) || f.dy.some((v) => v !== 0)).toBe(true);
    }
    const f = faceField([{ geo, adj: { eyeSizeL: 80, eyeSizeR: 80 } }], 200, 200);
    expect(f.dx[100 * 200 + 86]).toBeLessThan(0); // right of the left eye's center
    expect(f.dx[100 * 200 + 74]).toBeGreaterThan(0);
    const smile = faceField([{ geo, adj: { smile: 80 } }], 200, 200);
    expect(smile.dy[140 * 200 + 85]).toBeGreaterThan(0); // corners lift: sample from below
  });
});

// ------------------------------------------------------------------ model files

describe("AI model files", () => {
  it("fetch the runtime that matches the bundled tasks-vision version", async () => {
    // Node's fs, without needing Node's type definitions in the app's tsconfig.
    const { statSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as { statSync(p: string): { size: number } };
    expect(tasksVisionPkg.version).toBe(TASKS_VISION_VERSION);
    expect(statSync("node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js").size).toBe(MODEL_FILES.runtimeJs.size);
    expect(statSync("node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm").size).toBe(MODEL_FILES.runtimeWasm.size);
    for (const f of Object.values(MODEL_FILES)) expect(f.url.startsWith("https://")).toBe(true);
  });

  it("the native side downloads exactly the same pinned files", async () => {
    const { readFileSync } = (await import(/* @vite-ignore */ ["node", "fs"].join(":"))) as { readFileSync(p: string, e: string): string };
    const rust = readFileSync("src-tauri/src/lib.rs", "utf8");
    const table = rust.slice(rust.indexOf("const MODELS"), rust.indexOf("];", rust.indexOf("const MODELS")));
    for (const f of Object.values(MODEL_FILES)) {
      const at = table.indexOf(`"${f.name}"`);
      expect(at).toBeGreaterThan(0);
      // The URL is the next string after the name.
      expect(table.slice(at).match(/"(https:[^"]+)"/)![1]).toBe(f.url);
    }
  });
});

// ------------------------------------------------------------------ Face Swap


/** Landmarks of the canonical face seen from a yaw angle (degrees), centered at (cx, cy), scale px per cm. */
function project(cx: number, cy: number, scale: number, yaw = 0): Float32Array {
  const pts = new Float32Array(478 * 2);
  const c = Math.cos((yaw * Math.PI) / 180), s = Math.sin((yaw * Math.PI) / 180);
  for (let i = 0; i < 468; i++) {
    const x = CANON[i * 3], y = CANON[i * 3 + 1], z = CANON[i * 3 + 2];
    pts[i * 2] = cx + (x * c + z * s) * scale;
    pts[i * 2 + 1] = cy - y * scale;
  }
  for (let i = 468; i < 478; i++) {
    pts[i * 2] = cx;
    pts[i * 2 + 1] = cy;
  }
  return pts;
}

function solid(w: number, h: number, rgb: [number, number, number]): Img {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { w, h, data };
}

describe("face swap", () => {
  it("knows which triangle mirrors which", () => {
    const missing = [...MIRROR_TRI].filter((t) => t < 0).length;
    expect(missing).toBeLessThan(MIRROR_TRI.length * 0.05);
    // Mirroring twice gives back the same triangle.
    for (let t = 0; t < MIRROR_TRI.length; t++) if (MIRROR_TRI[t] >= 0) expect(MIRROR_TRI[MIRROR_TRI[t]]).toBe(t);
  });

  it("measures how much of a turned face the camera sees", () => {
    const front = visibility(project(200, 200, 10));
    const turned = visibility(project(200, 200, 10, 60));
    const fm = [...front].sort()[Math.floor(front.length / 2)];
    expect(fm).toBeGreaterThan(0.6);
    const low = (v: Float32Array) => [...v].filter((x) => x < 0.3).length;
    expect(low(turned)).toBeGreaterThan(low(front) + 100);
    expect(mouthOpen(project(200, 200, 10))).toBeLessThan(0.01);
  });

  it("moves the source's features onto the target's landmarks", () => {
    // Source: a gray face with a red nose tip; target: a blue picture with the face elsewhere and bigger.
    const sp = project(150, 160, 8);
    const src = solid(300, 320, [128, 128, 128]);
    const nx = Math.round(sp[1 * 2]), ny = Math.round(sp[1 * 2 + 1]);
    for (let y = ny - 3; y <= ny + 3; y++) for (let x = nx - 3; x <= nx + 3; x++) src.data.set([230, 20, 20, 255], (y * 300 + x) * 4);
    const tp = project(220, 230, 11);
    const tgt = solid(440, 460, [40, 60, 200]);
    const r = swapFace({ img: tgt, pts: tp }, { img: src, pts: sp }, { lighting: 0, softness: 0.3, fillHidden: true, keepHair: true });
    const tx = Math.round(tp[1 * 2]), ty = Math.round(tp[1 * 2 + 1]);
    const p = (ty * 440 + tx) * 4;
    expect(r.pixels[p]).toBeGreaterThan(180);
    expect(r.pixels[p + 2]).toBeLessThan(80);
    // The mask covers the middle of the face and nothing far outside it.
    const fb = faceBox(tp);
    expect(r.mask[Math.round(fb.y + fb.h / 2) * 440 + Math.round(fb.x + fb.w / 2)]).toBe(255);
    expect(r.mask[5 * 440 + 5]).toBe(0);
    expect(r.mirrored).toBeLessThan(0.02);
  });

  it("takes on the target's light and skin tone", () => {
    const sp = project(150, 160, 8), tp = project(150, 160, 8);
    const r = swapFace({ img: solid(300, 320, [200, 150, 120]), pts: tp }, { img: solid(300, 320, [90, 60, 50]), pts: sp }, { lighting: 1, softness: 0.5, fillHidden: true, keepHair: true });
    const p = (160 * 300 + 150) * 4;
    expect(Math.abs(r.pixels[p] - 200)).toBeLessThan(12);
    expect(Math.abs(r.pixels[p + 1] - 150)).toBeLessThan(12);
  });

  it("fills the side a turned source face hides from its other side", () => {
    const sp = project(150, 160, 8, 65), tp = project(150, 160, 8);
    const src = solid(300, 320, [128, 128, 128]);
    const on = swapFace({ img: solid(300, 320, [128, 128, 128]), pts: tp }, { img: src, pts: sp }, { lighting: 0, softness: 0.5, fillHidden: true, keepHair: true });
    const off = swapFace({ img: solid(300, 320, [128, 128, 128]), pts: tp }, { img: src, pts: sp }, { lighting: 0, softness: 0.5, fillHidden: false, keepHair: true });
    expect(on.mirrored).toBeGreaterThan(0.1);
    expect(off.mirrored).toBe(0);
  });

  it("keeps the target's hair over the face", () => {
    const sp = project(150, 160, 8), tp = project(150, 160, 8);
    const n = 300 * 320;
    const hair = new Float32Array(n);
    for (let y = 100; y < 140; y++) for (let x = 100; x < 200; x++) hair[y * 300 + x] = 1;
    const parts = { hair, other: new Float32Array(n), background: new Float32Array(n) };
    const r = swapFace({ img: solid(300, 320, [10, 10, 10]), pts: tp, parts }, { img: solid(300, 320, [200, 200, 200]), pts: sp }, { lighting: 0, softness: 0.3, fillHidden: true, keepHair: true });
    expect(r.mask[120 * 300 + 150]).toBe(0);
    expect(r.mask[180 * 300 + 150]).toBeGreaterThan(200);
  });

  it("layer.faceSwap adds the face as a masked layer in one step", () => {
    const { doc, bus } = setup(64, 64);
    const rect = { x: 10, y: 12, w: 20, h: 16 };
    const px = new Uint8Array(rect.w * rect.h * 4).fill(200);
    const m = new Uint8Array(rect.w * rect.h).fill(255);
    bus.dispatch("layer.faceSwap", { rect, pixels: b64(px), mask: b64(m) });
    const l = doc.activeLayer!;
    expect(l.name).toBe("Face Swap");
    expect(l.mask!.get(15, 15)).toBe(255);
    expect(l.mask!.get(2, 2)).toBe(0);
    expect(l.grid.readRegion({ x: 15, y: 15, w: 1, h: 1 })[0]).toBe(200);
    expect(bus.history.current!.label).toBe("Face Swap");
    expect(() => bus.dispatch("layer.faceSwap", { rect, pixels: b64(px.subarray(4)), mask: b64(m) })).toThrow(/does not match/);
    expect(() => bus.dispatch("layer.faceSwap", { rect: { ...rect, x: 60 }, pixels: b64(px), mask: b64(m) })).toThrow(/outside/);
    // Swapping again replaces the earlier result; data at half size is scaled up to the rect.
    const first = l.id;
    bus.dispatch("layer.faceSwap", { rect, width: 10, height: 8, pixels: b64(new Uint8Array(10 * 8 * 4).fill(90)), mask: b64(new Uint8Array(80).fill(255)), replace: first });
    expect(doc.layerById(first)).toBeUndefined();
    expect(doc.layers.filter((x) => x.name === "Face Swap").length).toBe(1);
    expect(doc.activeLayer!.grid.readRegion({ x: 20, y: 20, w: 1, h: 1 })[0]).toBe(90);
    expect(doc.stack[doc.stack.length - 1]).toBe(doc.activeLayer);
  });
});
