// End-to-end checks in headless Chromium (software WebGL2), or WebKit (the
// engine of the macOS and Linux apps) with E2E_BROWSER=webkit.
//   npm run build && npm run e2e
// Screenshots go to e2e/out/ (e2e/out-webkit/ for WebKit).
import { chromium, webkit } from "playwright";
import { preview } from "vite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const engine = process.env.E2E_BROWSER === "webkit" ? "webkit" : "chromium";
const out = new URL(engine === "webkit" ? "./out-webkit/" : "./out/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const server = await preview({ preview: { port: 4173, strictPort: true } });
const url = "http://localhost:4173/";
const browser =
  engine === "webkit"
    ? await webkit.launch()
    : await chromium.launch({
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      });
console.log(`(${engine})`);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// MediaPipe's WebAssembly prints its INFO/WARNING logs to stderr, which shows up as console errors.
page.on("console", (m) => m.type() === "error" && !/^(INFO|WARNING):|^[IW]\d{4} /.test(m.text()) && errors.push(m.text()));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};
const ev = (fn, arg) => page.evaluate(fn, arg);
// Wait for palettes that re-render on the next animation frame (WebKit returns from clicks before it).
const settle = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const labels = () => ev(() => window.editor.app.bus.history.states.map((s) => s.label));
const lastLabel = async () => (await labels()).at(-1);

await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.editor);
await page.screenshot({ path: out + "01-empty.png" });

// ======================================================= GPU vs CPU parity
const parity = await ev(() => {
  const { app } = window.editor;
  app.newDocument({ name: "parity", width: 600, height: 400, contents: "transparent" });
  const doc = app.doc;
  const bus = app.bus;
  const fillPattern = (layer, seed) => {
    const w = doc.width, h = doc.height;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        d[o] = (x * 3 + seed * 40) % 256;
        d[o + 1] = (y * 2 + seed * 90) % 256;
        d[o + 2] = ((x ^ y) + seed * 17) % 256;
        d[o + 3] = ((x >> 4) + (y >> 4) + seed) % 4 === 0 ? 0 : 128 + ((x + y + seed * 31) % 128);
      }
    layer.grid.writeRegion({ x: 0, y: 0, w, h }, d);
  };
  const compare = () => {
    const r = { x: 0, y: 0, w: doc.width, h: doc.height };
    const gpu = app.compositor.readPixels(r);
    const cpu = doc.composite(r);
    let max = 0, bad = 0;
    for (let i = 0; i < gpu.length; i += 4) {
      const n = cpu[i + 3] === 0 && gpu[i + 3] === 0 ? 0 : Math.max(Math.abs(gpu[i] - cpu[i]), Math.abs(gpu[i + 1] - cpu[i + 1]), Math.abs(gpu[i + 2] - cpu[i + 2]), Math.abs(gpu[i + 3] - cpu[i + 3]));
      if (n > max) max = n;
      if (n > 2) bad++;
    }
    return { max, bad };
  };
  fillPattern(doc.layers[0], 1);
  bus.dispatch("layer.new");
  fillPattern(doc.activeLayer, 2);
  bus.dispatch("layer.offset", { dx: 37, dy: -13 });
  const results = [];
  for (const m of ["normal", "dissolve", "multiply", "colorBurn", "screen", "overlay", "softLight", "vividLight", "difference", "hue", "luminosity"]) {
    bus.dispatch("layer.setProperties", { blendMode: m, opacity: 73 });
    results.push({ name: `blend ${m}`, ...compare() });
  }
  // Layer mask (soft, painted), on an offset layer.
  bus.dispatch("select.ellipse", { x: 120, y: 60, w: 300, h: 260 });
  bus.dispatch("select.feather", { radius: 12 });
  bus.dispatch("layer.addMask", { reveal: "selection" });
  bus.dispatch("select.none");
  bus.dispatch("paint.stroke", { points: [[100, 300], [500, 120]], size: 40, hardness: 0, color: [0, 0, 0] });
  bus.dispatch("layer.setProperties", { blendMode: "overlay", opacity: 90 });
  results.push({ name: "layer mask", ...compare() });
  bus.dispatch("layer.setMaskEnabled", { enabled: false });
  results.push({ name: "disabled mask", ...compare() });
  bus.dispatch("layer.setMaskEnabled", { enabled: true });
  // Clipping group.
  bus.dispatch("layer.new", { name: "clip1" });
  fillPattern(doc.activeLayer, 3);
  bus.dispatch("layer.clip", { clipped: true });
  bus.dispatch("layer.setProperties", { blendMode: "multiply", opacity: 80 });
  bus.dispatch("layer.new", { name: "clip2" });
  fillPattern(doc.activeLayer, 4);
  bus.dispatch("layer.offset", { dx: -70, dy: 40 });
  bus.dispatch("layer.clip", { clipped: true });
  results.push({ name: "clipping group", ...compare() });
  // Layer sets: pass through at 60%, then isolated multiply.
  bus.dispatch("layer.newSet", { name: "S" });
  const set = doc.activeNode;
  bus.dispatch("layer.new", { name: "in1" });
  fillPattern(doc.activeLayer, 5);
  bus.dispatch("layer.setProperties", { blendMode: "screen" });
  bus.dispatch("layer.new", { name: "in2" });
  fillPattern(doc.activeLayer, 6);
  bus.dispatch("layer.offset", { dx: 300, dy: 250 });
  bus.dispatch("layer.setProperties", { id: set.id, opacity: 60 });
  results.push({ name: "pass-through set at 60%", ...compare() });
  bus.dispatch("layer.setProperties", { id: set.id, blendMode: "multiply", opacity: 85 });
  results.push({ name: "isolated multiply set", ...compare() });
  bus.dispatch("layer.clip", { clipped: true });
  results.push({ name: "clipping inside a set", ...compare() });
  bus.dispatch("layer.clip", { clipped: false });
  // Set masks: isolated, then pass-through, with feather and density.
  bus.dispatch("layer.select", { id: set.id });
  bus.dispatch("select.ellipse", { x: 60, y: 40, w: 420, h: 300 });
  bus.dispatch("layer.addMask", { reveal: "selection" });
  bus.dispatch("select.none");
  bus.dispatch("paint.stroke", { points: [[50, 350], [560, 60]], size: 60, hardness: 20, color: [90, 90, 90] });
  results.push({ name: "isolated set with a mask", ...compare() });
  bus.dispatch("layer.setProperties", { id: set.id, blendMode: "passThrough", opacity: 70 });
  results.push({ name: "pass-through set with a mask", ...compare() });
  bus.dispatch("layer.setMaskProperties", { id: set.id, feather: 9, density: 70 });
  results.push({ name: "set mask feather + density", ...compare() });
  // Layer mask feather / density, and an unlinked mask after a move.
  const masked = doc.layers.find((l) => l.mask && l.name !== "S");
  bus.dispatch("layer.select", { id: masked.id });
  bus.dispatch("layer.setMaskProperties", { feather: 14, density: 55 });
  results.push({ name: "layer mask feather + density", ...compare() });
  bus.dispatch("layer.setMaskProperties", { linked: false });
  bus.dispatch("layer.offset", { dx: -25, dy: 18 });
  bus.dispatch("layer.offsetMask", { dx: 40, dy: 0 });
  results.push({ name: "unlinked mask after moves", ...compare() });
  // Gradient on a set mask.
  bus.dispatch("layer.select", { id: set.id });
  bus.dispatch("layer.editMask", { edit: true });
  bus.dispatch("paint.gradient", { x0: 100, y0: 0, x1: 500, y1: 0, preset: "whiteBlack", type: "reflected", mode: "multiply" });
  results.push({ name: "gradient on a set mask", ...compare() });
  // Layer styles: every effect, on an offset, masked layer; then on a clipped layer inside a set.
  bus.dispatch("layer.select", { id: masked.id });
  bus.dispatch("layer.setStyle", {
    style: {
      dropShadow: { distance: 12, size: 9, opacity: 80 },
      outerGlow: { size: 14, opacity: 60 },
      innerShadow: { distance: 5, size: 6 },
      innerGlow: { size: 8, source: "center" },
      bevel: { size: 10, depth: 250 },
      colorOverlay: { color: [40, 160, 90], opacity: 35, blendMode: "overlay" },
      stroke: { size: 4, position: "center", color: [250, 20, 120] },
    },
  });
  results.push({ name: "layer with every effect", ...compare() });
  const inSet = doc.layers.find((l) => l.name === "in2");
  bus.dispatch("layer.select", { id: inSet.id });
  bus.dispatch("layer.clip", { clipped: true });
  bus.dispatch("layer.setStyle", { style: { dropShadow: { distance: 20, size: 4 }, stroke: { size: 6, position: "outside" } } });
  results.push({ name: "styled clipped layer in a set", ...compare() });
  return results;
});
for (const r of parity) check(`GPU matches CPU: ${r.name}`, r.bad === 0, `max diff ${r.max}${r.bad ? `, ${r.bad} px > 2` : ""}`);

// ======================================================= tools through the real UI
await ev(() => window.editor.app.newDocument({ name: "Untitled-1", width: 800, height: 600, contents: "white" }));
const vp = await page.locator(".docwin.active .viewport").boundingBox();
const toScreen = async (x, y) => {
  const p = await ev(([x, y]) => window.editor.app.toScreen(x, y), [x, y]);
  return { x: vp.x + p.x, y: vp.y + p.y };
};
const drag = async (a, b, steps = 8) => {
  const s = await toScreen(...a);
  const e = await toScreen(...b);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(e.x, e.y, { steps });
  await page.mouse.up();
};
const click = async (x, y, opts) => {
  const s = await toScreen(x, y);
  await page.mouse.click(s.x, s.y, opts);
};

// Elliptical marquee via Shift+M cycling.
await page.keyboard.press("m");
await page.keyboard.press("Shift+m");
check("Shift+M cycles to the Elliptical Marquee", (await ev(() => window.editor.app.tool.id)) === "ellipse");
await drag([100, 100], [300, 250]);
check("elliptical marquee recorded", (await lastLabel()) === "Elliptical Marquee");
// Shift-drag a second ellipse adds to it.
await page.keyboard.down("Shift");
await drag([400, 300], [500, 400]);
await page.keyboard.up("Shift");
const selAdd = await ev(() => [window.editor.app.doc.selection.get(200, 175), window.editor.app.doc.selection.get(450, 350), window.editor.app.doc.selection.get(350, 280)]);
check("Shift adds to the selection", selAdd[0] === 255 && selAdd[1] === 255 && selAdd[2] === 0, JSON.stringify(selAdd));

// Drag inside the selection moves its outline.
await drag([200, 175], [230, 195]);
const moved = await ev(() => window.editor.app.doc.selection.bounds());
check("dragging inside a selection moves the outline", (await lastLabel()) === "Move Selection" && moved.x === 130, JSON.stringify(moved));

// Fill it red, deselect.
await ev(() => window.editor.app.run("color.set", { r: 200, g: 30, b: 30 }));
await page.keyboard.press("Alt+Backspace");
await page.keyboard.press("Control+d");

// Lasso.
await page.keyboard.press("l");
await drag([50, 450], [250, 550], 12);
check("lasso recorded", (await lastLabel()) === "Lasso");
// Polygonal lasso: click corners, Enter to close.
await page.keyboard.press("Shift+l");
check("Shift+L cycles to the Polygonal Lasso", (await ev(() => window.editor.app.tool.id)) === "polyLasso");
for (const [x, y] of [[600, 50], [750, 60], [740, 200], [610, 180]]) await click(x, y);
await page.keyboard.press("Enter");
const poly = await ev(() => [window.editor.app.doc.selection?.get(680, 120) ?? -1, window.editor.app.doc.selection?.get(100, 500) ?? -1]);
check("polygonal lasso replaces the selection", (await lastLabel()) === "Polygonal Lasso" && poly[0] === 255 && poly[1] === 0, JSON.stringify(poly));

// Magic wand on the red blob.
await page.keyboard.press("w");
await click(220, 190);
const wand = await ev(() => {
  const s = window.editor.app.doc.selection;
  return [s.get(220, 190), s.get(20, 20)];
});
check("magic wand selects the red area", (await lastLabel()) === "Magic Wand" && wand[0] > 200 && wand[1] === 0, JSON.stringify(wand));

// Move tool with a selection moves the pixels.
await page.keyboard.press("v");
await drag([220, 190], [220, 290]);
const movedPx = await ev(() => {
  const g = window.editor.app.doc.layers[0].grid;
  return [g.getPixel(220, 290), g.getPixel(220, 175)];
});
check("Move tool moves selected pixels", (await lastLabel()) === "Move" && movedPx[0][0] === 200 && movedPx[1][0] === 255, JSON.stringify(movedPx));
await page.keyboard.press("Control+d");

// Brush with a dynamic preset picked from the options bar picker.
await page.keyboard.press("b");
await page.locator(".brush-pick").click();
await page.locator(".menu-item", { hasText: "Dune Grass" }).click();
await ev(() => window.editor.app.run("color.set", { r: 30, g: 120, b: 40 }));
await drag([100, 560], [700, 560], 20);
const grass = await ev(() => {
  const g = window.editor.app.doc.layers[0].grid;
  let painted = 0;
  for (let x = 100; x < 700; x += 3) for (let y = 520; y < 590; y += 3) if (g.getPixel(x, y)[0] !== 255) painted++;
  return { painted, brush: window.editor.app.toolBrush.brush.name };
});
check("dynamic brush preset paints", (await lastLabel()) === "Brush Tool" && grass.painted > 50, JSON.stringify(grass));

// Quick Mask: Q, paint, Q.
await page.keyboard.press("Control+a");
await page.keyboard.press("q");
await ev(() => window.editor.app.run("color.reset"));
await page.keyboard.press("b");
await ev(() => {
  const { app } = window.editor;
  app.toolBrush.brush = { ...app.brushes.find((b) => b.name === "Hard Round 19 pixels"), size: 60 };
});
await drag([400, 100], [500, 100]);
const qmRender = await ev(() => {
  const { app } = window.editor;
  app.compositor.render();
  const gl = app.compositor.gl;
  const p = app.toScreen(450, 100);
  const dpr = window.devicePixelRatio || 1;
  const px = new Uint8Array(4);
  gl.readPixels(Math.round(p.x * dpr), Math.round(gl.drawingBufferHeight - p.y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return Array.from(px);
});
await page.screenshot({ path: out + "02-quickmask.png" });
check("Quick Mask shows masked areas in red", qmRender[0] > qmRender[1] + 60, JSON.stringify(qmRender));
await page.keyboard.press("q");
const qm = await ev(() => [window.editor.app.doc.quickMask, window.editor.app.doc.selection.get(450, 100), window.editor.app.doc.selection.get(100, 400)]);
check("leaving Quick Mask turns paint into a selection", qm[0] === false && qm[1] === 0 && qm[2] === 255, JSON.stringify(qm));
await page.keyboard.press("Control+d");

// Copy / paste through the keyboard.
await ev(() => window.editor.app.run("select.rect", { x: 100, y: 500, w: 200, h: 80 }));
await page.keyboard.press("Control+c");
await page.keyboard.press("Control+v");
await page.waitForTimeout(200);
const pasted = await ev(() => ({ n: window.editor.app.doc.layers.length, label: window.editor.app.bus.history.current.label }));
check("Ctrl+C / Ctrl+V pastes a new layer", pasted.n === 2 && pasted.label === "Paste", JSON.stringify(pasted));

// Layers palette: new set, drag the pasted layer into it, add a mask, Alt-click to clip.
await page.locator('[data-drop="new"]').locator("xpath=..").locator('button[title="Create a new set"]').click();
const setId = await ev(() => window.editor.app.doc.activeLayerId);
await page.waitForTimeout(200);
const pastedRow = page.locator(".layer-row", { hasText: "Layer 1" });
const setRow = page.locator(`.layer-row[data-id="${setId}"]`);
await pastedRow.waitFor();
const a = await pastedRow.boundingBox();
const b = await setRow.boundingBox();
await page.mouse.move(a.x + a.width - 30, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width - 30, b.y + b.height / 2, { steps: 6 });
await page.mouse.up();
const inSet = await ev((id) => window.editor.app.doc.nodeById(id).children.map((c) => c.name), setId);
check("drag a layer into a set in the Layers palette", JSON.stringify(inSet) === '["Layer 1"]', JSON.stringify(inSet));
await page.locator(".layer-row", { hasText: "Layer 1" }).click();
await page.locator('button[title^="Add layer mask"]').click();
check("mask button adds a layer mask", !!(await ev(() => window.editor.app.doc.activeLayer.mask)));
await ev(() => window.editor.app.run("layer.new", { name: "Shade" }));
await page.locator(".layer-row", { hasText: "Shade" }).click({ modifiers: ["Alt"] });
check("Alt-click clips a layer to the one below", await ev(() => window.editor.app.doc.activeLayer.clipped));
await page.waitForTimeout(300);
await page.screenshot({ path: out + "03-layers.png" });

// Crop tool: drag, Enter.
await page.keyboard.press("c");
await drag([50, 50], [650, 450]);
await page.keyboard.press("Enter");
const size = await ev(() => [window.editor.app.doc.width, window.editor.app.doc.height]);
check("crop tool crops", JSON.stringify(size) === "[600,400]", JSON.stringify(size));

// Rulers and a guide dragged from the top ruler.
await page.keyboard.press("Control+r");
await page.waitForTimeout(100);
const ruler = await page.locator(".docwin.active .ruler-top").boundingBox();
const vp2 = await page.locator(".docwin.active .viewport").boundingBox();
await page.mouse.move(ruler.x + 200, ruler.y + 8);
await page.mouse.down();
await page.mouse.move(ruler.x + 200, vp2.y + 150, { steps: 5 });
await page.mouse.up();
const guides = await ev(() => window.editor.app.doc.guides.h.length);
check("dragging from the ruler adds a guide", guides === 1);

// ======================================================= workspace
const layout = () => ev(() => JSON.parse(JSON.stringify(window.editor.workspace.layout)));
const tab = (id) => page.locator(`#palettes .tab[data-palette="${id}"], #floats .tab[data-palette="${id}"]`);

// Drag the Layers tab out into the workspace: it floats.
let t = await tab("layers").boundingBox();
await page.mouse.move(t.x + 10, t.y + 6);
await page.mouse.down();
await page.mouse.move(500, 300, { steps: 8 });
await page.mouse.up();
let L = await layout();
let g = L.groups.find((g) => g.tabs.includes("layers"));
check("dragging a tab out makes a floating palette", g?.dock === "float" && g.tabs.length === 1, JSON.stringify(g));

// Drag the Color tab into the History group.
t = await tab("color").boundingBox();
const hist = await tab("history").boundingBox();
await page.mouse.move(t.x + 10, t.y + 6);
await page.mouse.down();
await page.mouse.move(hist.x + hist.width + 20, hist.y + 6, { steps: 8 });
await page.mouse.up();
L = await layout();
g = L.groups.find((g) => g.tabs.includes("history"));
check("dragging a tab onto another group's tabs moves it there", g?.tabs.includes("color"), JSON.stringify(g?.tabs));

// Drag the Brushes tab from the palette well onto the dock.
t = await page.locator('.well-tab[data-palette="brushes"]').boundingBox();
const dock = await page.locator("#palettes").boundingBox();
await page.mouse.move(t.x + 10, t.y + 6);
await page.mouse.down();
await page.mouse.move(dock.x + 100, dock.y + dock.height - 20, { steps: 8 });
await page.mouse.up();
L = await layout();
g = L.groups.find((g) => g.tabs.includes("brushes"));
check("dragging from the palette well to the dock docks it", g?.dock === "right" && !L.well.includes("brushes"), JSON.stringify(g));

// Drag the floating Layers palette by its title bar back onto the dock.
const floatTitle = await page.locator('#floats .palette .titlebar').first().boundingBox();
await page.mouse.move(floatTitle.x + 30, floatTitle.y + 4);
await page.mouse.down();
await page.mouse.move(dock.x + 120, dock.y + 40, { steps: 10 });
await page.mouse.up();
L = await layout();
g = L.groups.find((g) => g.tabs.includes("layers"));
check("dragging a floating palette onto the dock docks it", g?.dock === "right", JSON.stringify(g?.dock));

// Float the toolbox by dragging its header.
const logo = await page.locator(".toolbox-logo").boundingBox();
await page.mouse.move(logo.x + 20, logo.y + 10);
await page.mouse.down();
await page.mouse.move(300, 200, { steps: 6 });
await page.mouse.up();
check("toolbox can float", (await layout()).toolbox.dock === "float");
await page.waitForTimeout(300);
await page.screenshot({ path: out + "04-custom-workspace.png" });

// Save it, reset, load it back.
const custom = await layout();
await ev(() => window.editor.shortcuts.setOverrides({ invert: "Ctrl+Alt+I" }));
await ev(() => window.editor.workspace.saveAs("My Setup", true));
await ev(() => window.editor.shortcuts.setOverrides({}));
await ev(() => window.editor.workspace.reset());
const afterReset = await layout();
check("Reset Palette Locations restores the default layout", afterReset.toolbox.dock === "left" && afterReset.well.includes("brushes"));
await ev(() => window.editor.workspace.loadNamed("My Setup"));
const loaded = await layout();
const same = JSON.stringify(loaded.groups.map((g) => [g.tabs, g.dock])) === JSON.stringify(custom.groups.map((g) => [g.tabs, g.dock])) && loaded.toolbox.dock === "float";
check("a saved workspace loads back exactly", same);
check("the workspace brought its keyboard shortcuts", (await ev(() => window.editor.shortcuts.effective("invert"))) === "Ctrl+Alt+I");
const before = await ev(() => window.editor.app.doc.layers[0].grid.getPixel(300, 300));
await page.keyboard.press("Control+Alt+i");
const inv = await ev(() => window.editor.app.bus.history.current.label);
check("a remapped shortcut runs its command", inv === "Invert", inv + " " + JSON.stringify(before));

// Window menu: hide and show a palette.
await ev(() => window.editor.workspace.show("navigator"));
await page.locator(".menu-title", { hasText: "Window" }).dispatchEvent("mousedown");
await page.locator(".menu-item", { hasText: /^.?Navigator/ }).click();
check("Window menu hides a palette", !(await ev(() => window.editor.workspace.isOpen("navigator"))));
await page.locator(".menu-title", { hasText: "Window" }).dispatchEvent("mousedown");
await page.locator(".menu-item", { hasText: /^.?Navigator/ }).click();
check("Window menu shows it again", await ev(() => window.editor.workspace.isOpen("navigator")));

// The layout survives a restart.
await page.waitForTimeout(600);
const saved = await layout();
await page.reload();
await page.waitForFunction(() => window.editor);
const restored = await layout();
check(
  "the workspace is restored after restarting",
  JSON.stringify(restored.groups.map((g) => [g.tabs, g.dock, g.x, g.y])) === JSON.stringify(saved.groups.map((g) => [g.tabs, g.dock, g.x, g.y])) && restored.toolbox.dock === saved.toolbox.dock,
);
check("saved workspaces are still listed after restarting", (await ev(() => window.editor.workspace.names())).includes("My Setup"));
await ev(() => window.editor.workspace.reset());

// Brushes palette open from the well.
await ev(() => window.editor.app.newDocument({ name: "Untitled-2", width: 800, height: 600, contents: "white" }));
await page.keyboard.press("b");
await page.locator('.well-tab[data-palette="brushes"]').click();
await page.locator(".br-sec", { hasText: "Shape Dynamics" }).locator("input").check();
await page.locator(".br-sec", { hasText: "Shape Dynamics" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: out + "05-brushes.png" });
check("Brushes palette edits the brush", await ev(() => !!window.editor.app.toolBrush.brush.shape));
await page.keyboard.press("Escape");

// Shortcut editor opens and lists commands.
await page.keyboard.press("Control+Alt+Shift+k");
const rows = await page.locator(".sc-row").count();
check("Keyboard Shortcuts editor lists the commands", rows > 80, String(rows));
await page.locator(".sc-field").first().click();
await page.keyboard.press("Escape");
check("Esc cancels a key capture without closing the editor", (await page.locator(".sc-editor").count()) === 1);
await page.screenshot({ path: out + "06-shortcuts.png" });
await page.keyboard.press("Escape");
check("Esc then closes the editor", (await page.locator(".sc-editor").count()) === 0);

// Palette well: "Remove from Palette Well" floats the palette.
await ev(() => window.editor.workspace.openWell("toolPresets"));
await page.locator(".well-pop .pal-menu").click();
await page.locator(".menu-item", { hasText: "Remove from Palette Well" }).click();
const tp = await ev(() => ({ inWell: window.editor.workspace.layout.well.includes("toolPresets"), open: window.editor.workspace.isOpen("toolPresets"), pops: document.querySelectorAll(".well-pop").length }));
check("Remove from Palette Well floats the palette", !tp.inWell && tp.open && tp.pops === 0, JSON.stringify(tp));
await ev(() => window.editor.workspace.reset());

// Shortcuts are ignored mid-stroke (no Ctrl+Z while painting).
const s0 = await toScreen(100, 100);
await page.mouse.move(s0.x, s0.y);
await page.mouse.down();
await page.mouse.move(s0.x + 50, s0.y + 20, { steps: 3 });
await page.keyboard.press("Control+z");
await page.mouse.up();
check("Ctrl+Z is ignored in the middle of a stroke", (await lastLabel()) === "Brush Tool");

// ======================================================= appearance
{
  const panel = () => ev(() => getComputedStyle(document.documentElement).getPropertyValue("--panel").trim());
  check("Graphite is the default theme", (await ev(() => window.editor.themes.appearance.theme)) === "graphite" && (await panel()) === "#25262a");
  // Window > Appearance > Studio.
  await page.locator(".menu-title", { hasText: "Window" }).click();
  await page.locator(".menu-item", { hasText: "Appearance" }).hover();
  await page.locator(".menu-item", { hasText: "Studio" }).click();
  check("Window > Appearance switches the theme", (await panel()) === "#f5f6f8" && (await ev(() => document.documentElement.dataset.tone)) === "light");
  const pb = await ev(() => window.editor.app.compositor.readPixels ? getComputedStyle(document.documentElement).getPropertyValue("--workspace").trim() : "");
  check("the image area follows the theme", pb === "#c6cad1", pb);
  await page.waitForTimeout(150);
  await page.screenshot({ path: out + "07-studio.png" });

  // Customize: pick a theme and an accent; Cancel reverts.
  await ev(() => { window.editor.actions.appearance.run(); });
  await page.locator(".theme-card", { hasText: "Darkroom" }).click();
  check("theme cards preview live", (await panel()) === "#231e1b");
  await page.locator(".dialog button", { hasText: "Cancel" }).click();
  check("Cancel puts the previous theme back", (await panel()) === "#f5f6f8");

  // Change one color, save as a theme of your own.
  await ev(() => { window.editor.actions.appearance.run(); });
  await page.locator(".theme-card", { hasText: "Moss" }).click();
  await page.locator('.color-field input[aria-label="Accent"]').evaluate((i) => {
    i.value = "#ff5a8a";
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  check("editing a color previews it", (await ev(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())) === "#ff5a8a");
  await page.locator(".seg button", { hasText: "Round" }).click();
  await page.locator('input[aria-label="New theme name"]').fill("Moss Pink");
  await page.locator(".dialog button", { hasText: "Save as Theme" }).click();
  check("the saved theme appears in the gallery", (await page.locator(".theme-card", { hasText: "Moss Pink" }).count()) === 1);
  await page.waitForTimeout(150);
  await page.screenshot({ path: out + "07-appearance.png" });
  await page.locator(".dialog button", { hasText: "OK" }).click();
  await page.reload();
  await page.waitForFunction(() => window.editor);
  const after = await ev(() => ({
    name: window.editor.themes.find(window.editor.themes.appearance.theme)?.name,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    radius: getComputedStyle(document.documentElement).getPropertyValue("--r-lg").trim(),
  }));
  check("your theme and corner style are restored after restarting", after.name === "Moss Pink" && after.accent === "#ff5a8a" && after.radius === "13px", JSON.stringify(after));
  await ev(() => window.editor.themes.set({ theme: "graphite", custom: {}, corners: "soft" }));
}

// ======================================================= document windows
{
  // Start from no open images.
  await ev(() => { const { app } = window.editor; for (const s of [...app.sessions]) app.closeSession(s); });
  check("closing every image shows the welcome screen", await ev(() => getComputedStyle(document.getElementById("welcome")).display !== "none" && window.editor.app.sessions.length === 0));
  check("image windows float by default", await ev(() => window.editor.app.prefs.docMode === "floating" && window.editor.app.windows.mode === "floating"));
  await ev(() => {
    const { app } = window.editor;
    app.newDocument({ name: "Alpha", width: 400, height: 300, contents: "white" });
    app.bus.dispatch("layer.new");
    app.newDocument({ name: "Beta", width: 300, height: 200, contents: "white" });
  });
  const wins = await page.locator(".docwin").count();
  check("two images open in two floating windows", wins === 2 && (await page.locator("#docarea.maximized").count()) === 0, String(wins));
  const beta = page.locator(".docwin.active");
  check("the newest window is active", (await beta.locator(".title").textContent()).startsWith("Beta"));
  // Drag the caption.
  const b0 = await beta.boundingBox();
  const cap = await beta.locator(".caption .title").boundingBox();
  await page.mouse.move(cap.x + 20, cap.y + 8);
  await page.mouse.down();
  await page.mouse.move(cap.x + 140, cap.y + 98, { steps: 6 });
  await page.mouse.up();
  const b1 = await beta.boundingBox();
  check("dragging the title bar moves the window", Math.abs(b1.x - b0.x - 120) < 3 && Math.abs(b1.y - b0.y - 90) < 3, `${b1.x - b0.x},${b1.y - b0.y}`);
  // Resize from the bottom-right corner.
  const se = await beta.locator(".edge-se").boundingBox();
  await page.mouse.move(se.x + 5, se.y + 5);
  await page.mouse.down();
  await page.mouse.move(se.x + 85, se.y + 45, { steps: 5 });
  await page.mouse.up();
  const b2 = await beta.boundingBox();
  check("dragging a corner resizes the window", Math.abs(b2.width - b1.width - 80) < 3 && Math.abs(b2.height - b1.height - 40) < 3, `${b2.width - b1.width}x${b2.height - b1.height}`);
  // Per-document history: paint in Beta, Alpha's history is unaffected.
  await ev(() => window.editor.app.bus.dispatch("edit.fill", { use: "foreground" }));
  const alphaWin = page.locator(".docwin", { hasText: "Alpha" });
  const ab = await alphaWin.locator(".caption").boundingBox();
  await page.mouse.click(ab.x + 30, ab.y + 8);
  const alpha = await ev(() => ({ name: window.editor.app.doc.name, layers: window.editor.app.doc.layers.length, last: window.editor.app.bus.history.states.at(-1).label, lp: document.querySelectorAll("#palettes .layer-row, .layer-row").length }));
  check("clicking a background window activates it (Layers palette follows)", alpha.name === "Alpha" && alpha.layers === 2, JSON.stringify(alpha));
  check("each image keeps its own history", alpha.last !== "Fill", alpha.last);
  await page.keyboard.press("Control+z");
  await ev(() => window.editor.app.activate(window.editor.app.sessions.find((s) => s.doc.name === "Beta")));
  check("undo in one image leaves the other alone", (await ev(() => window.editor.app.bus.history.states.at(-1).label)) === "Fill");
  await page.screenshot({ path: out + "07-floating-windows.png" });

  // Tile and cascade.
  await ev(() => window.editor.actions.tile.run());
  const tiled = await page.locator(".docwin").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.x), Math.round(r.y)]));
  check("Tile places windows side by side", tiled[0][1] === tiled[1][1] && tiled[0][0] !== tiled[1][0], JSON.stringify(tiled));
  await ev(() => window.editor.actions.cascade.run());
  const casc = await page.locator(".docwin").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.x), Math.round(r.y)]));
  check("Cascade staggers windows", casc[1][0] - casc[0][0] === 24 && casc[1][1] - casc[0][1] === 24, JSON.stringify(casc));

  // Maximized (tabbed) mode, remembered as a preference.
  await beta.locator(".win-btn[title=Maximize]").click();
  check("the maximize button switches to tabbed windows", (await page.locator("#docarea.maximized").count()) === 1 && (await page.locator(".doc-tab").count()) === 2);
  check("only the active image shows when maximized", (await page.locator(".docwin:visible").count()) === 1);
  await page.locator(".doc-tab", { hasText: "Alpha" }).click();
  check("clicking a tab switches images", (await ev(() => window.editor.app.doc.name)) === "Alpha");
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + "08-tabbed-windows.png" });
  const navPx = await ev(() => { const c = document.querySelector(".nav-view canvas"); if (!c) return null; const x = c.getContext("2d"); return [...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data]; });
  check("the Navigator follows the active image", !navPx || navPx[0] > 200, JSON.stringify(navPx));
  check("the window mode is saved as a preference", await ev(() => window.editor.app.prefs.docMode === "maximized"));
  await ev(() => window.editor.actions.nextDoc.run());
  check("Next Image cycles documents", (await ev(() => window.editor.app.doc.name)) === "Beta");

  // Ctrl+W on an unsaved image asks first.
  await page.keyboard.press("Control+w");
  await page.waitForSelector(".dialog");
  check("closing an unsaved image asks first", (await page.locator(".dialog").textContent()).includes("Beta"));
  await page.locator(".dialog button", { hasText: "Cancel" }).click();
  check("Cancel keeps it open", (await ev(() => window.editor.app.sessions.length)) === 2);
  await page.keyboard.press("Control+w");
  await page.locator(".dialog button", { hasText: "Don't Save" }).click();
  await page.waitForTimeout(50);
  check("Don't Save closes it and activates the next image", await ev(() => window.editor.app.sessions.length === 1 && window.editor.app.doc.name === "Alpha"));

  await page.reload();
  await page.waitForFunction(() => window.editor);
  check("tabbed mode is restored after restarting", await ev(() => window.editor.app.windows.mode === "maximized"));
  await ev(() => window.editor.actions.docFloating.run());
  check("switching back to floating windows", await ev(() => window.editor.app.prefs.docMode === "floating"));
}

// ======================================================= filters, B&W Lab, Actions, Batch
{
  await ev(() => { const { app } = window.editor; for (const s of [...app.sessions]) app.closeSession(s); });
  const openTest = (name) =>
    ev((name) => {
      const { app } = window.editor;
      const w = 480, h = 320;
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#6fa8dc");
      g.addColorStop(1, "#f6d7a7");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      x.fillStyle = "#d33";
      x.beginPath();
      x.arc(160, 200, 70, 0, 7);
      x.fill();
      x.fillStyle = "#ffd23f";
      x.fillRect(300, 150, 120, 120);
      app.openImage({ name, width: w, height: h, data: x.getImageData(0, 0, w, h).data });
    }, name);
  await openTest("filters.png");
  const px = (x, y) => ev(([x, y]) => [...window.editor.app.doc.activeLayer.grid.readRegion({ x, y, w: 1, h: 1 })], [x, y]);

  // Filter Library: browse, preview, apply.
  check("the library has over 150 filters in 15 categories", await ev(() => window.editor.app.bus.list().filter((c) => c.name.startsWith("filter.")).length > 150));
  await ev(() => { window.editor.actions.filterLibrary.run(); });
  await page.waitForSelector(".fl-dialog .fl-card");
  await page.locator(".fl-navitem", { hasText: "Blur" }).first().click();
  await page.locator(".fl-card", { hasText: "Gaussian Blur" }).click();
  await page.waitForFunction(() => document.querySelector(".fl-thumb.ready"));
  check("filter cards render thumbnails of the picture", (await page.locator(".fl-thumb.ready").count()) > 0);
  await page.locator('.fl-param input[type=number][aria-label="Radius value"]').fill("12");
  await page.locator('.fl-param input[type=number][aria-label="Radius value"]').press("Tab");
  await page.waitForTimeout(400);
  await page.screenshot({ path: out + "09-filter-library.png" });
  const edgeBefore = await px(229, 200);
  await page.locator(".fl-actions .btn.default").click();
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Gaussian Blur", null, { timeout: 15000 });
  const edgeAfter = await px(229, 200);
  check("Apply runs the filter (in a worker) and adds a history state", edgeAfter[0] !== edgeBefore[0], `${edgeBefore} -> ${edgeAfter}`);

  // Fade the filter.
  await page.keyboard.press("Control+Shift+f");
  await page.waitForSelector(".dialog");
  await page.locator('.dialog input[type="number"]').first().fill("0");
  await page.locator(".dialog .btn.default").click();
  check("Fade (Ctrl+Shift+F) blends the filter away", JSON.stringify(await px(229, 200)) === JSON.stringify(edgeBefore) && (await lastLabel()) === "Fade Gaussian Blur");

  // Last Filter (Ctrl+F).
  await page.keyboard.press("Control+f");
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Gaussian Blur", null, { timeout: 15000 });
  check("Ctrl+F repeats the last filter", true);

  // Filter menu: categories, favorites; open one filter's dialog.
  await page.locator(".menu-title", { hasText: "Filter" }).click();
  await page.locator(".menu-item", { hasText: "Cartoon & Comic" }).hover();
  await page.locator(".menu-item", { hasText: /^Comic Book/ }).click();
  await page.waitForSelector(".fl-dialog.compact");
  check("a filter from the menu opens its own dialog", (await page.locator(".fl-dialog.compact .fl-dtitle").textContent()).startsWith("Comic Book"));
  await page.locator(".fl-actions .btn.default").click();
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Comic Book", null, { timeout: 20000 });
  await page.screenshot({ path: out + "10-comic-book.png" });

  // Organize: star, collection, hide.
  await ev(() => { window.editor.actions.filterLibrary.run(); });
  await page.waitForSelector(".fl-dialog .fl-card");
  await page.locator(".fl-search").fill("crosshatch");
  await page.locator(".fl-card", { hasText: "Crosshatch" }).locator(".fl-star").click();
  check("starring a filter adds it to Favorites", await ev(() => window.editor.filterOrg.isFavorite("crosshatch")));
  await page.locator(".fl-card", { hasText: "Crosshatch" }).click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Add to Collection" }).hover();
  await page.locator(".menu-item", { hasText: "New Collection..." }).click();
  await page.locator('.dialog:not(.sheet) input[type="text"]').fill("Ink Work");
  await page.locator(".dialog:not(.sheet) .btn.default").click();
  check("a new collection holds the filter", await ev(() => window.editor.filterOrg.data.collections.some((c) => c.name === "Ink Work" && c.filters.includes("crosshatch"))));
  await page.locator(".fl-search").fill("");
  await page.locator(".fl-navitem", { hasText: "All Filters" }).click();
  // Drag a card onto the collection.
  await page.locator(".fl-card", { hasText: "Ink Drawing" }).dragTo(page.locator(".fl-navitem", { hasText: "Ink Work" }));
  check("dragging a filter onto a collection adds it", await ev(() => window.editor.filterOrg.data.collections.find((c) => c.name === "Ink Work").filters.includes("inkDrawing")));
  await page.locator(".fl-card", { hasText: "Plastic Wrap" }).click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Hide from Menus" }).click();
  await page.keyboard.press("Escape");
  await page.locator(".menu-title", { hasText: "Filter" }).click();
  const menuText = await page.locator(".menu-pop").first().textContent();
  check("Favorites and collections appear in the Filter menu", menuText.includes("Favorites") && menuText.includes("Ink Work"));
  await page.locator(".menu-item", { hasText: "Artistic" }).hover();
  check("hidden filters leave the menus", !(await page.locator(".menu-pop").last().textContent()).includes("Plastic Wrap"));
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 860);

  // Black & White Lab.
  await ev(() => { window.editor.actions.bwLab.run(); });
  await page.waitForSelector(".bw-dialog");
  await page.locator(".bw-preset", { hasText: "Red Filter" }).click();
  const box = await page.locator(".bw-preview").boundingBox();
  // Drag right on the red ball: reds get lighter.
  const redsBefore = await page.locator('.bw-row input[aria-label="Reds value"]').inputValue();
  const bx = box.x + box.width * (160 / 480), by = box.y + box.height * (200 / 320);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx + 60, by, { steps: 6 });
  await page.mouse.up();
  const redsAfter = await page.locator('.bw-row input[aria-label="Reds value"]').inputValue();
  check("dragging on the picture changes the color slider under the cursor", +redsAfter > +redsBefore, `${redsBefore} -> ${redsAfter}`);
  await page.locator(".bw-tsw").nth(1).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out + "11-bw-lab.png" });
  await page.locator(".bw-footer .btn.default").click();
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Black & White", null, { timeout: 15000 });
  const bw = await ev(() => ({ name: window.editor.app.doc.activeLayer.name, layers: window.editor.app.doc.layers.length, p: [...window.editor.app.doc.activeLayer.grid.readRegion({ x: 20, y: 20, w: 1, h: 1 })] }));
  check("the lab converts on a new layer, toned", bw.name === "Black & White" && bw.p[0] !== bw.p[2], JSON.stringify(bw));

  // Actions: record with a function key, play it back.
  await ev(() => window.editor.workspace.show("actions"));
  await page.locator('.icon-btn[title="Create new action"]').click();
  await page.locator('.dialog input[type="text"]').fill("Invert Twice Test");
  await page.locator(".dialog select").nth(1).selectOption("F10");
  await page.locator(".dialog .btn.default").click();
  check("New Action starts recording", await ev(() => !!window.editor.actionStore.recording));
  // (Earlier checks remapped Invert's shortcut, so use the menu action.)
  await ev(() => window.editor.actions.invert.run());
  await ev(() => window.editor.app.bus.dispatch("filter.posterizeFx", { levels: 3 }));
  await page.locator('.icon-btn[title="Stop playing/recording"]').click();
  const rec = await ev(() => window.editor.actionStore.byKey("F10")?.steps.map((s) => s.command));
  check("the recorded action holds the steps", JSON.stringify(rec) === JSON.stringify(["image.invert", "filter.posterizeFx"]), JSON.stringify(rec));
  await openTest("played.png");
  await page.mouse.click(700, 500);
  await page.keyboard.press("F10");
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Posterize", null, { timeout: 10000 });
  check("its function key plays it on another image", (await labels()).slice(-2).join() === "Invert,Posterize");
  await page.waitForFunction(() => !window.editor.actionStore.playing);
  await page.keyboard.press("F2");
  await page.waitForFunction(() => window.editor.app.bus.history.current.label === "Cartoon", null, { timeout: 20000 });
  check("default actions have keys too (F2 Cartoonize)", (await ev(() => window.editor.app.doc.activeLayer.name)) === "Cartoon");
  await page.locator(".palette .pal-menu").filter({ has: page.locator("xpath=..") }).first();
  await page.screenshot({ path: out + "12-actions.png" });

  // Batch: three images through the recorded action, out as a zip.
  await ev(() => { window.editor.actions.batch.run(); });
  await page.waitForSelector(".bt-dialog");
  const setId = await ev(() => window.editor.actionStore.findAction(window.editor.actionStore.byKey("F10").id).set.id);
  await page.locator('.bt-dialog select[aria-label="Action set"]').selectOption(setId);
  await page.locator('.bt-dialog select[aria-label="Action"]').selectOption({ label: "Invert Twice Test  (F10)" });
  const mk = (n, color) => ({ name: n, mimeType: "image/png", buffer: Buffer.from(readFileSync(new URL("./out/01-empty.png", import.meta.url))) });
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".bt-dialog .btn", { hasText: "Choose Images..." }).click();
  await (await chooser).setFiles([mk("one.png"), mk("two.png"), mk("three.png")]);
  await page.locator('.bt-dialog select[aria-label="Format"]').selectOption("png");
  const download = page.waitForEvent("download", { timeout: 60000 });
  await page.locator(".bt-dialog .btn.default", { hasText: "Run Batch" }).click();
  const dl = await download;
  const zipPath = out + "batch.zip";
  await dl.saveAs(zipPath);
  const { unzipSync } = await import("fflate");
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(zipPath))));
  check("Batch runs the action on every image and saves the results", names.length === 3 && names.includes("one-edited.png"), names.join(", "));
  await page.waitForSelector(".bt-status:has-text('Finished')");
  check("Batch reports what it did", (await page.locator(".bt-line.ok").count()) === 3);
  await page.screenshot({ path: out + "13-batch.png" });
  await page.locator(".bt-dialog .btn.default", { hasText: "Close" }).click();
  check("batch images were closed after saving", (await ev(() => window.editor.app.sessions.map((s) => s.doc.name))).every((n) => !["one.png", "two.png", "three.png"].includes(n)));
}

// ======================================================= layer masks through the UI
{
  await ev(() => window.editor.app.newDocument({ name: "Masks", width: 640, height: 420, contents: "white" }));
  await ev(() => {
    const { app } = window.editor;
    app.bus.dispatch("layer.new", { name: "Photo" });
    app.bus.dispatch("color.set", { r: 40, g: 110, b: 200 });
    app.bus.dispatch("edit.fill");
    app.bus.dispatch("select.ellipse", { x: 120, y: 60, w: 400, h: 300 });
    app.bus.dispatch("layer.addMask", { reveal: "selection" });
    app.bus.dispatch("select.none");
  });
  await settle();
  const maskThumb = page.locator(".layer-row.active .mask-thumb");
  check("masked layer shows a mask thumbnail", (await maskThumb.count()) === 1);

  // Alt-click: view the mask alone; Alt+Shift: rubylith overlay.
  await maskThumb.click({ modifiers: ["Alt"] });
  check("Alt-click on the mask thumbnail shows the mask", (await ev(() => window.editor.app.maskView)) === "gray");
  await page.screenshot({ path: out + "14-mask-gray.png" });
  await page.locator(".layer-row.active .mask-thumb").click({ modifiers: ["Alt", "Shift"] });
  check("Alt+Shift-click shows the mask as an overlay", (await ev(() => window.editor.app.maskView)) === "overlay");
  await page.screenshot({ path: out + "15-mask-overlay.png" });
  await page.keyboard.press("Backslash");
  check("\\ toggles the overlay off", (await ev(() => window.editor.app.maskView)) === "off");

  // Ctrl-click loads the mask as a selection.
  await page.locator(".layer-row.active .mask-thumb").click({ modifiers: ["Control"] });
  const sb = await ev(() => window.editor.app.doc.selection?.bounds());
  check("Ctrl-click on the mask thumbnail loads it as a selection", !!sb && Math.abs(sb.x - 120) <= 1 && Math.abs(sb.w - 400) <= 2, JSON.stringify(sb));
  await ev(() => window.editor.app.bus.dispatch("select.none"));

  // Shift-click disables.
  await page.locator(".layer-row.active .mask-thumb").click({ modifiers: ["Shift"] });
  check("Shift-click disables the mask", (await ev(() => window.editor.app.doc.activeLayer.maskEnabled)) === false);
  await page.locator(".layer-row.active .mask-thumb").click({ modifiers: ["Shift"] });

  // Masks palette: Density and Feather sliders.
  await ev(() => window.editor.actions.showMasks.run());
  await page.waitForSelector(".mk-body:not(.none)");
  const featherNum = page.locator('.mk-row input[type="number"][aria-label="Feather value"]');
  await featherNum.fill("20");
  await featherNum.press("Enter");
  check("Masks palette feather sets the mask feather", (await ev(() => window.editor.app.doc.activeLayer.maskFeather)) === 20);
  check("feather is one undoable step", (await lastLabel()) === "Mask Properties");
  // The palette redraws after each change; let it settle before typing again.
  await page.waitForTimeout(150);
  const densityNum = page.locator('.mk-row input[type="number"][aria-label="Density value"]');
  await densityNum.fill("60");
  await densityNum.press("Enter");
  check("Masks palette density", (await ev(() => window.editor.app.doc.activeLayer.maskDensity)) === 0.6);
  const px = await ev(() => window.editor.app.doc.samplePixel(10, 10));
  check("density lets 40% of the hidden area through", Math.abs(px[0] - Math.round(255 - 0.4 * (255 - 40))) <= 2, px.join(","));
  await page.screenshot({ path: out + "16-masks-palette.png" });

  // Unlink, then the Move tool moves only the mask while editing it.
  await page.locator(".layer-row.active .mask-link").click();
  check("chain button unlinks the mask", (await ev(() => window.editor.app.doc.activeLayer.maskLinked)) === false);
  await ev(() => window.editor.app.bus.dispatch("layer.editMask", { edit: true }));
  await ev(() => window.editor.app.setTool("move"));
  const box = await page.locator(".docwin.active .viewport").boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 4 });
  await page.mouse.move(cx + 60, cy, { steps: 4 });
  await page.mouse.up();
  const st = await ev(() => {
    const l = window.editor.app.doc.activeLayer;
    return { ox: l.offsetX, label: window.editor.app.bus.history.current.label };
  });
  check("dragging an unlinked mask moves only the mask", st.ox === 0 && st.label === "Move Layer Mask", JSON.stringify(st));

  // Gradient tool on the mask.
  await ev(() => window.editor.app.setTool("gradient"));
  check("gradient tool has options", (await page.locator(".grad-pick").count()) === 1 && (await page.locator(".grad-type").count()) === 5);
  await page.mouse.move(box.x + 40, cy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, cy, { steps: 5 });
  await page.screenshot({ path: out + "17-gradient-drag.png" });
  await page.mouse.move(box.x + box.width - 40, cy, { steps: 5 });
  await page.mouse.up();
  check("gradient tool draws on the mask", (await lastLabel()) === "Gradient");
  check("the layer's pixels are untouched", (await ev(() => window.editor.app.doc.activeLayer.grid.getPixel(5, 5).join(","))) === "40,110,200,255");

  // Drag the mask thumbnail to the trash: Apply / Discard / Cancel.
  await page.locator('[data-drop="trash"]').scrollIntoViewIfNeeded();
  await settle();
  const thumbBox = await page.locator(".layer-row.active .mask-thumb").boundingBox();
  const trash = await page.locator('[data-drop="trash"]').boundingBox();
  await page.mouse.move(thumbBox.x + 5, thumbBox.y + 5);
  await page.mouse.down();
  await page.mouse.move(thumbBox.x + 30, thumbBox.y + 30, { steps: 3 });
  await page.mouse.move(trash.x + trash.width / 2, trash.y + trash.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector(".modal-backdrop .dialog");
  await page.screenshot({ path: out + "18-remove-mask.png" });
  await page.locator(".modal-backdrop .dialog button", { hasText: "Apply" }).click();
  check("dragging the mask to the trash applies it", (await ev(() => window.editor.app.doc.activeLayer.mask)) === null && (await lastLabel()) === "Apply Layer Mask");

  // Masks on a layer set.
  await ev(() => {
    const { app } = window.editor;
    app.bus.dispatch("layer.newSet", { name: "Group" });
    app.bus.dispatch("layer.addMask", { reveal: "all" });
    app.bus.dispatch("paint.gradient", { x0: 0, y0: 0, x1: 0, y1: 420, preset: "whiteBlack" });
  });
  await settle();
  check("a layer set gets a mask thumbnail", (await page.locator(".layer-row.active .mask-thumb").count()) === 1);
  await page.screenshot({ path: out + "19-set-mask.png" });
}

// ======================================================= type and fonts
{
  await ev(() => window.editor.app.newDocument({ name: "Type", width: 800, height: 500, contents: "white" }));
  await ev(() => window.editor.app.setTool("type"));
  const tb = await page.locator(".docwin.active .viewport").boundingBox();
  const tv = await ev(() => window.editor.app.compositor.view);
  const at = (x, y) => [tb.x + tv.x + x * tv.zoom, tb.y + tv.y + y * tv.zoom];
  await page.mouse.click(...at(60, 120));
  await page.waitForSelector(".type-editor");
  await page.keyboard.type("Hello type!");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(200);
  const t1 = await ev(() => ({ name: window.editor.app.doc.activeLayer.name, text: window.editor.app.doc.activeLayer.text?.content, label: window.editor.app.bus.history.current.label }));
  check("Type tool: click, type and commit makes a type layer", t1.text === "Hello type!" && t1.name === "Hello type!" && t1.label === "Type Tool", JSON.stringify(t1));
  const inked = await ev(() => {
    const l = window.editor.app.doc.activeLayer;
    const d = l.grid.readRegion({ x: 0, y: 0, w: l.grid.width, h: l.grid.height });
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
    return n;
  });
  check("the text is drawn", inked > 500, `${inked} px`);
  check("Layers palette shows a T thumbnail", (await page.locator(".layer-row.active .type-thumb").count()) === 1);

  await page.locator("#optionsbar .font-pick").click();
  await page.waitForSelector(".font-menu");
  const famCount = await page.locator(".font-menu .fm-row").count();
  check("font menu lists 100+ fonts", famCount >= 100, `${famCount}`);
  await page.locator('.font-menu .fm-cat[data-cat="comic"]').click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out + "20-font-menu.png" });
  await page.locator(".font-menu input[type=search]").fill("bangers");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.editor.app.doc.activeLayer.text.font === "Bangers");
  check("picking a font changes the type layer (one undo step)", (await lastLabel()) === "Edit Type Layer");

  // Paragraph text: drag a box.
  await page.mouse.move(...at(300, 200));
  await page.mouse.down();
  await page.mouse.move(...at(600, 420), { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector(".type-editor.box");
  await page.keyboard.type("The quick brown fox jumps over the lazy dog, again and again.");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(200);
  const para = await ev(() => window.editor.app.doc.activeLayer.text);
  check("dragging a box makes wrapping paragraph text", !!para?.box && para.box.w === 300, JSON.stringify(para?.box));

  // Click existing text to edit it.
  await page.mouse.click(...at(120, 100));
  await page.waitForSelector(".type-editor");
  await page.keyboard.press("End");
  await page.keyboard.type(" Again");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(200);
  check("clicking text edits it", (await ev(() => window.editor.app.doc.activeLayer.text.content)) === "Hello type! Again");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  const un = await ev(() => window.editor.app.doc.layers.find((l) => l.text?.content.startsWith("Hello"))?.text.content);
  check("undo restores the old text", un === "Hello type!", un);
  await ev(() => window.editor.app.run("layer.select", { id: window.editor.app.doc.layers.find((l) => l.text?.content.startsWith("Hello")).id }));

  // Character palette.
  await ev(() => window.editor.actions.showCharacter.run());
  await page.waitForSelector(".char-pal");
  const tr = page.locator('.char-pal input[aria-label^="Tracking"]');
  await tr.fill("150");
  await tr.press("Enter");
  await page.locator('.char-pal button[aria-label="Faux Italic"]').click();
  await page.waitForTimeout(200);
  const st = await ev(() => window.editor.app.doc.activeLayer.text);
  check("Character palette edits tracking and faux italic", st.tracking === 150 && st.fauxItalic === true, JSON.stringify({ t: st.tracking, i: st.fauxItalic }));
  await page.screenshot({ path: out + "21-type.png" });

  // Painting on type asks to rasterize.
  await ev(() => window.editor.app.setTool("brush"));
  await page.mouse.click(...at(700, 60));
  await page.waitForSelector(".modal-backdrop .dialog");
  await page.locator(".modal-backdrop .dialog button", { hasText: "Rasterize" }).click();
  await page.waitForTimeout(200);
  check("painting a type layer offers to rasterize it", (await ev(() => window.editor.app.doc.activeLayer.text)) === null);
  await page.keyboard.press("Escape");

  // A showcase of bundled fonts.
  await ev(async () => {
    const { app } = window.editor;
    app.newDocument({ name: "Fonts", width: 1000, height: 640, contents: "white" });
    const picks = [
      ["Playfair Display", 700, "serif"], ["Bebas Neue", 400, "display"], ["Pacifico", 400, "script"], ["Bangers", 400, "comic"],
      ["Montserrat", 800, "sans"], ["Press Start 2P", 400, "pixel"], ["Cinzel", 700, "display"], ["Permanent Marker", 400, "marker"],
      ["Lobster", 400, "display"], ["UnifrakturMaguntia", 400, "blackletter"], ["Monoton", 400, "neon"], ["JetBrains Mono", 500, "mono"],
      ["Great Vibes", 400, "script"], ["Luckiest Guy", 400, "comic"], ["Rye", 400, "western"], ["Special Elite", 400, "typewriter"],
    ];
    const colors = [[30, 30, 30], [200, 40, 60], [40, 90, 200], [230, 120, 20], [30, 140, 90], [120, 40, 160]];
    await Promise.all(picks.map(([f, w]) => document.fonts.load(`${w} 40px "${f}"`, f)));
    picks.forEach(([font, weight], i) => {
      const x = 30 + (i % 2) * 500, y = 70 + Math.floor(i / 2) * 75;
      app.bus.dispatch("type.create", { x, y, content: font, font, weight, size: 40, color: colors[i % colors.length] });
    });
  });
  await page.waitForTimeout(500);
  await ev(() => {
    window.editor.workspace.hide("character");
    window.editor.workspace.hide("paragraph");
    window.editor.app.fitOnScreen();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: out + "22-font-showcase.png" });
  check("16 bundled fonts render in the showcase", (await ev(() => window.editor.app.doc.layers.filter((l) => l.text).length)) === 16);
}

// ======================================================= big document performance
const perf = await ev(async () => {
  const { app } = window.editor;
  app.newDocument({ name: "big", width: 6000, height: 4000, contents: "white" });
  const doc = app.doc;
  const block = new Uint8ClampedArray(1500 * 1000 * 4);
  for (let i = 0; i < block.length; i += 4) {
    block[i] = (i / 4) % 255;
    block[i + 1] = 120;
    block[i + 2] = 200;
    block[i + 3] = 180;
  }
  app.bus.dispatch("layer.newSet");
  for (let i = 0; i < 30; i++) {
    app.bus.dispatch("layer.new");
    doc.activeLayer.grid.writeRegion({ x: (i * 150) % 4500, y: (i * 97) % 3000, w: 1500, h: 1000 }, block);
    doc.activeLayer.blendMode = ["normal", "multiply", "screen", "overlay"][i % 4];
    if (i % 5 === 0) app.bus.dispatch("layer.addMask", { reveal: "all" });
    if (i % 7 === 3) doc.activeLayer.clipped = true;
  }
  doc.dirty(null);
  const t1 = performance.now();
  app.compositor.render();
  app.compositor.gl.finish();
  const full = performance.now() - t1;
  const t2 = performance.now();
  for (let i = 0; i < 20; i++) {
    app.panBy(7, 3);
    app.compositor.render();
  }
  app.compositor.gl.finish();
  const pan = (performance.now() - t2) / 20;
  const t3 = performance.now();
  app.bus.dispatch("paint.stroke", { points: [[3000, 2000]], size: 40 });
  app.compositor.render();
  app.compositor.gl.finish();
  const dab = performance.now() - t3;
  return { full, pan, dab, tiles: app.compositor.stats.lastTiles, layers: doc.layers.length };
});
console.log(
  `PERF  6000x4000, ${perf.layers} layers in a set, masks + clipping (software GPU): full composite ${perf.full.toFixed(0)} ms, ` +
    `pan frame ${perf.pan.toFixed(1)} ms, brush dab ${perf.dab.toFixed(1)} ms (${perf.tiles} tiles)`,
);
check("pan never re-blends layers", perf.pan < perf.full / 5);


// ======================================================= Liquify
{
  await ev(() => {
    const { app } = window.editor;
    const w = 480, h = 360;
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext("2d");
    for (let i = 0; i < 12; i++) {
      x.fillStyle = i % 2 ? "#2c5aa0" : "#f2c14e";
      x.fillRect(i * 40, 0, 40, h);
    }
    x.fillStyle = "#c33";
    x.beginPath();
    x.arc(240, 180, 60, 0, 7);
    x.fill();
    app.openImage({ name: "liquify.png", width: w, height: h, data: x.getImageData(0, 0, w, h).data });
  });
  const before = await ev(() => [...window.editor.app.doc.activeLayer.grid.readRegion({ x: 0, y: 0, w: 480, h: 360 })]);
  await page.keyboard.press("Control+Shift+X");
  await page.waitForSelector(".lq-dialog");
  check("Liquify opens full-window with all tools", (await page.locator(".lq-tool").count()) === 15);
  const st = await page.locator(".lq-stage").boundingBox();
  const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 8, cy);
  await page.mouse.up();
  await page.keyboard.press("t"); // turbulence
  check("tool keys switch tools", await page.locator(".lq-tool.on").getAttribute("aria-label") === "Turbulence Tool");
  await page.keyboard.press("c");
  await page.mouse.move(cx + 80, cy - 60);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  check("each stroke is an undo step", (await page.locator(".lq-status").textContent()).includes("2 steps"));
  await page.keyboard.press("Control+z");
  check("Ctrl+Z undoes inside Liquify", (await page.locator(".lq-status").textContent()).includes("1 step"));
  await page.locator(".lq-check", { hasText: "Show Mesh" }).locator("input").check();
  await page.screenshot({ path: out + "40-liquify.png" });
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForSelector(".lq-dialog", { state: "detached" });
  const after = await ev(() => [...window.editor.app.doc.activeLayer.grid.readRegion({ x: 0, y: 0, w: 480, h: 360 })]);
  let changed = 0;
  for (let i = 0; i < after.length; i += 4) if (after[i] !== before[i]) changed++;
  check("OK warps the layer", changed > 500, `${changed} px changed`);
  check("Liquify is one history step", (await lastLabel()) === "Liquify");
  check("far pixels are untouched", after[(10 * 480 + 5) * 4] === before[(10 * 480 + 5) * 4]);
  // Cancel leaves the image alone.
  await page.keyboard.press("Control+Shift+X");
  await page.waitForSelector(".lq-dialog");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".lq-dialog", { state: "detached" });
  check("Cancel leaves history alone", (await labels()).filter((l) => l === "Liquify").length === 1);
}


// ======================================================= 0.9: files, size, transform, adjustments, retouching, styles
{
  await ev(() => {
    const { app } = window.editor;
    const w = 480, h = 320;
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#3b6ea8");
    g.addColorStop(1, "#d8c27a");
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) {
      x.fillStyle = `rgba(255,255,255,${(i % 7) / 30})`;
      x.fillRect((i * 97) % w, (i * 61) % h, 3, 3);
    }
    x.fillStyle = "#111";
    x.beginPath();
    x.arc(150, 160, 14, 0, 7);
    x.fill();
    app.openImage({ name: "v09.png", width: w, height: h, data: x.getImageData(0, 0, w, h).data });
    // Smaller than the window, so the transform handles aren't on its resize border.
    app.setZoom(0.5);
  });
  const box = async () => ev(() => {
    const s = window.editor.app.active;
    const v = s.compositor.view;
    const r = s.win.viewport.getBoundingClientRect();
    return { x0: r.left + v.x, y0: r.top + v.y, z: v.zoom };
  });
  const at = (b, x, y) => [b.x0 + (x + 0.5) * b.z, b.y0 + (y + 0.5) * b.z];
  let b = await box();
  // Content-Aware Fill: lasso around the dark dot, Shift+Backspace.
  await page.keyboard.press("l");
  await page.mouse.move(...at(b, 128, 138));
  await page.mouse.down();
  for (const [x, y] of [[172, 138], [172, 182], [128, 182], [128, 138]]) await page.mouse.move(...at(b, x, y), { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press("Shift+Backspace");
  await page.waitForFunction(() => window.editor.app.bus.history.states.at(-1)?.label === "Content-Aware Fill", null, { timeout: 60000 });
  const dot = await ev(() => window.editor.app.doc.activeLayer.grid.getPixel(150, 160));
  check("Content-Aware Fill removes the dot", dot[0] > 60, JSON.stringify(dot));
  await page.keyboard.press("Control+d");
  // Spot Healing Brush: paint a dark mark, then heal it.
  await ev(() => window.editor.app.bus.dispatch("paint.stroke", { points: [[300, 100], [330, 110]], size: 8, color: [0, 0, 0] }));
  await page.keyboard.press("j");
  check("J picks the Spot Healing Brush", (await ev(() => window.editor.app.tool.id)) === "spotHeal");
  await ev(() => (window.editor.app.toolBrush.spotHeal.size = 20));
  b = await box();
  await page.mouse.move(...at(b, 296, 99));
  await page.mouse.down();
  await page.mouse.move(...at(b, 334, 111), { steps: 6 });
  await page.mouse.up();
  await page.waitForFunction(() => window.editor.app.bus.history.states.at(-1)?.label === "Spot Healing Brush");
  const healed = await ev(() => window.editor.app.doc.activeLayer.grid.getPixel(315, 105));
  check("Spot Healing removes a painted mark", healed[0] > 60, JSON.stringify(healed));
  // Clone Stamp needs a source; Alt-click sets it.
  await page.keyboard.press("s");
  await page.mouse.move(...at(b, 60, 60));
  await page.mouse.down();
  await page.mouse.up();
  check("Clone Stamp asks for a source first", (await lastLabel()) === "Spot Healing Brush");
  await page.keyboard.down("Alt");
  await page.mouse.click(...at(b, 400, 260));
  await page.keyboard.up("Alt");
  await page.mouse.move(...at(b, 60, 60));
  await page.mouse.down();
  await page.mouse.move(...at(b, 90, 70), { steps: 4 });
  await page.mouse.up();
  check("Clone Stamp paints after Alt-click", (await lastLabel()) === "Clone Stamp");
  // Free Transform: scale down and commit.
  await ev(() => window.editor.app.bus.dispatch("layer.duplicate", {}));
  await page.keyboard.press("Control+t");
  check("Ctrl+T starts Free Transform", (await ev(() => window.editor.app.tool.id)) === "transform");
  b = await box();
  // The top-left corner handle (always in view), dragged in.
  await page.mouse.move(...at(b, 1 / b.z, 1 / b.z));
  await page.mouse.down();
  await page.mouse.move(...at(b, 120, 80), { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const tb = await ev(() => { const l = window.editor.app.doc.activeLayer; return { w: l.grid.width, h: l.grid.height, label: window.editor.app.bus.history.states.at(-1).label }; });
  check("Free Transform scales the layer", tb.label === "Free Transform" && tb.w < 400 && tb.w > 300, JSON.stringify(tb));
  // Layer Style dialog: drop shadow + stroke, then GPU vs CPU.
  await page.locator('button[title="Add a layer style"]').click();
  await page.getByText("Drop Shadow...").click();
  await page.waitForSelector(".ls");
  await page.locator(".ls-row", { hasText: "Stroke" }).locator("input").check();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForSelector(".ls", { state: "detached" });
  const st = await ev(() => {
    const a = window.editor.app;
    const l = a.doc.activeLayer;
    const r = { x: 0, y: 0, w: a.doc.width, h: a.doc.height };
    a.compositor.render();
    const gpu = a.compositor.readPixels(r), cpu = a.doc.composite(r);
    let max = 0;
    for (let i = 0; i < gpu.length; i++) max = Math.max(max, Math.abs(gpu[i] - cpu[i]));
    return { fx: Object.keys(l.style ?? {}), max, label: a.bus.history.states.at(-1).label, badge: !!document.querySelector(".layer-row.active .fx-badge") };
  });
  check("Layer Style dialog applies effects", st.label === "Layer Style" && st.fx.includes("dropShadow") && st.fx.includes("stroke") && st.badge, JSON.stringify(st));
  check("styled layer: GPU matches CPU", st.max <= 2, `max diff ${st.max}`);
  await page.screenshot({ path: out + "50-v09.png" });
  // Levels: Auto, Apply.
  await page.keyboard.press("Control+l");
  await page.waitForSelector(".lv-hist");
  await page.getByRole("button", { name: "Auto" }).click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.waitForFunction(() => window.editor.app.bus.history.states.at(-1)?.label === "Levels", null, { timeout: 20000 });
  check("Levels applies as one step", true);
  // Save as .cie (download in the browser), reopen it through File > Open.
  const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const path = out + "v09.cie";
  await dl.saveAs(path);
  check("Ctrl+S saves a layered .cie file", dl.suggestedFilename().endsWith(".cie"), dl.suggestedFilename());
  await page.waitForTimeout(300);
  // Saving renamed this window to v09.cie; wait for a second one.
  let fc = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), page.keyboard.press("Control+o")]).then(([f]) => f, () => null);
  if (!fc) {
    console.log("NOTE  Ctrl+O showed no file chooser the first time; opening through the File menu action");
    [fc] = await Promise.all([page.waitForEvent("filechooser"), ev(() => void window.editor.actions.open.run())]);
  }
  await fc.setFiles(path);
  await page.waitForFunction(() => window.editor.app.sessions.filter((s) => s.doc.name.endsWith(".cie")).length === 2, null, { timeout: 20000 });
  const re = await ev(() => { const d = window.editor.app.doc; return { layers: d.layers.length, styled: d.layers.some((l) => l.style?.stroke) }; });
  check("the .cie file opens with its layers and styles", re.layers === 2 && re.styled, JSON.stringify(re));
  // Close both windows again: browsers allow only so many WebGL contexts.
  await ev(async () => {
    const a = window.editor.app;
    for (const s of [...a.sessions]) if (s.doc.name.startsWith("v09")) await a.closeSession(s);
  });
}

// ======================================================= 0.10: several layers, Ctrl for Move, shapes, paths, notes, slices
{
  await ev(() => {
    const { app } = window.editor;
    const w = 480, h = 320;
    const c = new OffscreenCanvas(w, h);
    const x = c.getContext("2d");
    x.fillStyle = "#cfd8e3";
    x.fillRect(0, 0, w, h);
    app.openImage({ name: "v10.png", width: w, height: h, data: x.getImageData(0, 0, w, h).data });
    app.setZoom(0.5);
    for (const [n, bx, by] of [["A", 40, 40], ["B", 200, 90]]) {
      app.run("layer.new", { name: n });
      app.run("select.rect", { x: bx, y: by, w: 60, h: 60 });
      app.run("edit.fill", { use: "black" });
      app.run("select.none", {});
    }
  });
  const box = async () => ev(() => {
    const s = window.editor.app.active;
    const v = s.compositor.view;
    const r = s.win.viewport.getBoundingClientRect();
    return { x0: r.left + v.x, y0: r.top + v.y, z: v.zoom };
  });
  const at = (b, x, y) => [b.x0 + (x + 0.5) * b.z, b.y0 + (y + 0.5) * b.z];
  const drag = async (b, pts) => {
    await page.mouse.move(...at(b, ...pts[0]));
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...at(b, ...p), { steps: 5 });
    await page.mouse.up();
  };
  let b = await box();
  // Holding Ctrl borrows the Move tool; letting go gives the brush back.
  await page.keyboard.press("b");
  await page.keyboard.down("Control");
  const held = await ev(() => window.editor.app.tool.id);
  await page.keyboard.up("Control");
  check("holding Ctrl switches to the Move tool until it's released", held === "move" && (await ev(() => window.editor.app.tool.id)) === "brush", held);
  // Ctrl-drag with the brush moves the layer.
  await page.keyboard.down("Control");
  await drag(b, [[220, 110], [240, 120]]);
  await page.keyboard.up("Control");
  const mv = await ev(() => { const l = window.editor.app.doc.activeLayer; return { name: l.name, x: l.offsetX, y: l.offsetY, tool: window.editor.app.tool.id }; });
  check("Ctrl-drag moves the layer and keeps the brush", mv.name === "B" && mv.x === 20 && mv.y === 10 && mv.tool === "brush", JSON.stringify(mv));
  // Layers palette: click B, Ctrl-click A.
  const rows = page.locator(".layer-row");
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ["Control"] });
  await settle();
  const ms = await ev(() => ({ sel: window.editor.app.doc.selectedNodes.map((n) => n.name), rows: document.querySelectorAll(".layer-row.selected, .layer-row.active").length }));
  check("Ctrl-click selects several layers", ms.sel.join() === "A,B" && ms.rows === 2, JSON.stringify(ms));
  await rows.nth(0).click();
  await rows.nth(2).click({ modifiers: ["Shift"] });
  check("Shift-click selects a range", (await ev(() => window.editor.app.doc.selectedNodes.length)) === 3);
  await rows.nth(1).click();
  await rows.nth(0).click({ modifiers: ["Shift"] });
  // Move them together.
  await page.keyboard.press("v");
  await drag(b, [[70, 70], [70, 100]]);
  const both = await ev(() => window.editor.app.doc.layers.slice(1).map((l) => l.offsetY));
  check("the Move tool drags every selected layer", both[0] === 30 && both[1] === 40, JSON.stringify(both));
  // Align their top edges from the options bar.
  await page.locator('button[title="Align top edges"]').click();
  const tops = await ev(() => window.editor.app.doc.layers.slice(1).map((l) => { let y = 1e9; for (let yy = 0; yy < 320 && y === 1e9; yy++) if (l.grid.readRegion({ x: 0, y: yy - l.offsetY, w: 480, h: 1 }).some((v, i) => i % 4 === 3 && v > 0)) y = yy; return y; }));
  check("Align Top Edges lines the layers up", tops[0] === tops[1], JSON.stringify(tops));
  // Free Transform transforms both, proportionally without Shift.
  const joint = () => ev(() => {
    let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0, n = 0;
    for (const l of window.editor.app.doc.layers.slice(1)) {
      const r = l.grid.readRegion({ x: -l.offsetX, y: -l.offsetY, w: 480, h: 320 });
      for (let i = 3; i < r.length; i += 4) if (r[i] > 127) {
        const p = (i - 3) / 4, x = p % 480, y = Math.floor(p / 480);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); n++;
      }
    }
    return { x0, y0, x1, y1, n };
  });
  const j0 = await joint();
  await page.keyboard.press("Control+t");
  check("Ctrl+T with several layers starts Free Transform", (await ev(() => window.editor.app.tool.id)) === "transform");
  await page.keyboard.press("Escape");
  check("Esc cancels it and gives the pixels back", JSON.stringify(await joint()) === JSON.stringify(j0), JSON.stringify(j0));
  await page.keyboard.press("Control+t");
  b = await box();
  // Drag the bottom-right handle 40px right and only 5px down: proportional scaling keeps the shape.
  await drag(b, [[j0.x1, j0.y1], [j0.x1 + 40, j0.y1 + 5]]);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const j1 = await joint();
  const r0 = (j0.x1 - j0.x0) / (j0.y1 - j0.y0), r1 = (j1.x1 - j1.x0) / (j1.y1 - j1.y0);
  check("Free Transform scales the selected layers together, in proportion", (await lastLabel()) === "Free Transform" && j1.x1 > j0.x1 + 20 && Math.abs(r1 - r0) < 0.05, JSON.stringify({ j0, j1 }));
  // Rectangle tool (U) makes a shape layer.
  await page.keyboard.press("u");
  check("U picks the Rectangle tool", (await ev(() => window.editor.app.tool.id)) === "rectShape");
  b = await box();
  await drag(b, [[300, 200], [420, 280]]);
  const sh = await ev(() => { const l = window.editor.app.doc.activeLayer; return { shape: !!l.shape, label: window.editor.app.bus.history.states.at(-1).label, a: l.grid.getPixel(360 - l.offsetX, 240 - l.offsetY)[3] }; });
  check("dragging the Rectangle tool makes a filled shape layer", sh.shape && sh.a === 255, JSON.stringify(sh));
  // Pen (P), Paths mode: click three points and close; the path shows in the Paths palette.
  await ev(() => { window.editor.app.settings.penMode = "path"; window.editor.app.run("layer.select", { id: window.editor.app.doc.layers[0].id }); });
  await page.keyboard.press("p");
  for (const [x, y] of [[40, 220], [140, 180], [200, 280], [40, 220]]) await page.mouse.click(...at(b, x, y));
  const pp = await ev(() => { const p = window.editor.app.doc.paths[0]?.path; return { paths: window.editor.app.doc.paths.length, n: p?.subpaths[0]?.pts.length, closed: !!p?.subpaths[0]?.closed }; });
  check("the Pen draws a closed work path", pp.paths === 1 && pp.closed && pp.n === 3, JSON.stringify(pp));
  await ev(() => window.editor.workspace.show("paths"));
  await page.waitForTimeout(100);
  check("the Paths palette lists it", (await page.locator(".paths-list .path-row").count()) >= 1);
  await ev(() => window.editor.app.run("path.toSelection", {}));
  check("the path loads as a selection", await ev(() => !!window.editor.app.doc.selection), await lastLabel());
  await ev(() => window.editor.app.run("select.none", {}));
  // Notes (N): click, type, close.
  await page.keyboard.press("n");
  await page.mouse.click(...at(b, 440, 30));
  await page.waitForSelector(".note-editor");
  await page.keyboard.type("Check the edge");
  await page.locator(".note-editor button", { hasText: "Close" }).click();
  const nt = await ev(() => window.editor.app.doc.notes.map((n) => n.text));
  check("the Notes tool leaves a note", nt.length === 1 && nt[0].includes("Check the edge"), JSON.stringify(nt));
  // Slice (K) and Measure (Shift+I cycling).
  await page.keyboard.press("k");
  await drag(b, [[0, 0], [240, 160]]);
  check("the Slice tool adds a slice", (await ev(() => window.editor.app.doc.slices.length)) === 1);
  await page.keyboard.press("i");
  for (let k = 0; k < 4 && (await ev(() => window.editor.app.tool.id)) !== "measure"; k++) await page.keyboard.press("Shift+I");
  await drag(b, [[20, 300], [220, 300]]);
  const ms2 = await page.locator(".measure-read").textContent().catch(() => "");
  check("the Measure tool reads out a distance", /200/.test(ms2 ?? ""), ms2 ?? "");
  // Pattern Stamp paints the chosen pattern.
  await ev(() => window.editor.app.run("layer.select", { id: window.editor.app.doc.layers[0].id }));
  await page.keyboard.press("s");
  for (let k = 0; k < 3 && (await ev(() => window.editor.app.tool.id)) !== "patternStamp"; k++) await page.keyboard.press("Shift+S");
  await drag(b, [[260, 30], [400, 40]]);
  check("Shift+S cycles to the Pattern Stamp, which paints", (await lastLabel()) === "Pattern Stamp", await lastLabel());
  await page.screenshot({ path: out + "55-v10.png" });
  // The toolbox has no "coming soon" entries left.
  check("every toolbox slot holds a working tool", (await page.locator(".toolbox .soon, .toolbox [data-soon]").count()) === 0);
  await ev(async () => {
    const a = window.editor.app;
    for (const s of [...a.sessions]) if (s.doc.name.startsWith("v10")) await a.closeSession(s);
  });
}

// ======================================================= 0.11: Move tool, temporary tools, shortcuts, preferences, scratch disk
{
  await ev(() => {
    const { app } = window.editor;
    app.newDocument({ name: "v11", width: 480, height: 320, contents: "white" });
    app.setZoom(0.5);
    for (const [n, x] of [["A", 40], ["B", 200]]) {
      app.run("layer.new", { name: n });
      app.run("select.rect", { x, y: 40, w: 80, h: 80 });
      app.run("edit.fill", { use: "black" });
      app.run("select.none", {});
    }
  });
  const box = async () => ev(() => {
    const s = window.editor.app.active;
    const v = s.compositor.view;
    const r = s.win.viewport.getBoundingClientRect();
    return { x0: r.left + v.x, y0: r.top + v.y, z: v.zoom };
  });
  const at = (b, x, y) => [b.x0 + (x + 0.5) * b.z, b.y0 + (y + 0.5) * b.z];
  const drag = async (b, pts) => {
    await page.mouse.move(...at(b, ...pts[0]));
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...at(b, ...p), { steps: 5 });
    await page.mouse.up();
  };
  let b = await box();
  const offsets = () => ev(() => window.editor.app.doc.layers.slice(1).map((l) => `${l.name}:${l.offsetX},${l.offsetY}`).join(" "));
  // (The 0.10 checks left the Paths tab in front.)
  await ev(() => window.editor.workspace.show("layers"));
  // The Move tool moves the layer chosen in the Layers palette, even when clicking another layer's pixels.
  await page.locator(".layer-row").nth(0).click();
  await page.keyboard.press("v");
  check("Auto-Select is Off by default", (await page.locator('select[aria-label="Auto-Select"]').inputValue()) === "off");
  await drag(b, [[80, 80], [90, 90]]);
  check("the Move tool moves the selected layer, not the one clicked", (await offsets()) === "A:0,0 B:10,10", await offsets());
  await page.keyboard.down("Control");
  await drag(b, [[80, 80], [90, 90]]);
  await page.keyboard.up("Control");
  check("Ctrl-dragging with the Move tool doesn't switch layers either", (await offsets()) === "A:0,0 B:20,20", await offsets());
  await page.locator('select[aria-label="Auto-Select"]').selectOption("layer");
  await drag(b, [[80, 80], [82, 80]]);
  check("Auto-Select: Layer picks the layer clicked", (await ev(() => window.editor.app.doc.activeLayer.name)) === "A");
  await page.locator('select[aria-label="Auto-Select"]').selectOption("off");
  // Holding Alt with the Brush: the Eyedropper, then the Brush again.
  await page.keyboard.press("b");
  await page.keyboard.down("Alt");
  const altTool = await ev(() => window.editor.app.tool.id);
  await page.mouse.click(...at(b, 60, 60));
  await page.keyboard.up("Alt");
  const afterAlt = await ev(() => [window.editor.app.tool.id, window.editor.app.doc.foreground.slice(0, 3).join(",")]);
  check("holding Alt with the Brush borrows the Eyedropper", altTool === "eyedropper" && afterAlt[0] === "brush" && afterAlt[1] === "0,0,0", JSON.stringify([altTool, afterAlt]));
  // Ctrl+Space: zoom in.
  const z0 = await ev(() => window.editor.app.compositor.view.zoom);
  await page.keyboard.down("Control");
  await page.keyboard.down("Space");
  await page.mouse.click(...at(b, 240, 160));
  await page.keyboard.up("Space");
  await page.keyboard.up("Control");
  const z1 = await ev(() => [window.editor.app.compositor.view.zoom, window.editor.app.tool.id]);
  check("Ctrl+Space clicks zoom in, then the tool comes back", z1[0] > z0 && z1[1] === "brush", JSON.stringify(z1));
  await ev(() => window.editor.app.setZoom(0.66));
  b = await box();
  // Layer stepping and blend mode keys.
  await page.keyboard.press("v");
  await page.keyboard.press("Alt+]");
  check("Alt+] selects the layer above", (await ev(() => window.editor.app.doc.activeLayer.name)) === "B");
  await page.keyboard.press("Alt+Shift+M");
  check("Alt+Shift+M sets Multiply", (await ev(() => window.editor.app.doc.activeLayer.blendMode)) === "multiply");
  await page.keyboard.press("Shift+=");
  check("Shift+= steps to the next blend mode", (await ev(() => window.editor.app.doc.activeLayer.blendMode)) === "colorBurn");
  await page.keyboard.press("Alt+Shift+N");
  // Number keys: two quick digits.
  await page.keyboard.press("b");
  await page.keyboard.press("3");
  await page.keyboard.press("5");
  check("typing 3 then 5 sets 35% opacity", (await ev(() => window.editor.app.settings.brushOpacity)) === 35);
  await page.keyboard.press("0");
  // Transform Again.
  await page.keyboard.press("v");
  await ev(() => window.editor.actions.tFlipH.run());
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+Shift+t");
  await page.waitForTimeout(300);
  check("Ctrl+Shift+T repeats the last transform", (await lastLabel()) === "Transform Again", await lastLabel());
  // Preferences: change the ruler units; the Info palette and rulers follow.
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".pf");
  check("Ctrl+K opens Preferences at General", (await page.locator(".pf-title").textContent()) === "General");
  await page.locator(".pf-item", { hasText: "Units & Rulers" }).click();
  await page.locator('select[aria-label="Rulers"]').selectOption("inches");
  await page.locator(".pf-item", { hasText: "Memory" }).click();
  check("the Memory section shows the limit", /GB|MB/.test((await page.locator(".pf-panel").textContent()) ?? ""));
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForSelector(".pf", { state: "detached" });
  check("Preferences apply on OK", (await ev(() => window.editor.app.prefs.rulerUnits)) === "inches");
  await ev(() => window.editor.app.setPrefs({ rulerUnits: "pixels" }));
  // The built-in Color Picker.
  await page.locator("#toolbox .chip.fg").click();
  await page.waitForSelector(".cp");
  await page.locator(".cp-row", { hasText: "#" }).locator("input").fill("3366cc");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  check("the Color Picker sets the foreground color", (await ev(() => window.editor.app.doc.foreground.slice(0, 3).join(","))) === "51,102,204");
  // Scratch disk: squeeze the memory budget and make history; older steps page out and come back on undo.
  const paged = await ev(async () => {
    const a = window.editor.app;
    // No writable browser storage here (some WebKit builds): paging is off.
    if (!a.pager) return null;
    a.newDocument({ name: "v11-big", width: 1600, height: 1600, contents: "white" });
    for (let i = 0; i < 10; i++) {
      a.run("select.rect", { x: (i * 113) % 900, y: (i * 71) % 900, w: 600, h: 600 });
      a.run("color.set", { which: "foreground", r: i * 20, g: 255 - i * 20, b: 90 });
      a.run("edit.fill", { use: "foreground" });
    }
    a.run("select.none", {});
    const sum = () => {
      const c = a.doc.composite();
      let s = 0;
      for (let k = 0; k < c.length; k += 499) s += c[k];
      return s;
    };
    const h = a.bus.history;
    const looks = [];
    for (let i = h.states.length - 1; i >= Math.max(0, h.states.length - 8); i--) {
      h.jump(i);
      looks.push(sum());
    }
    h.jump(h.states.length - 1);
    const total = a.memoryTotal, pct = a.prefs.memoryPercent;
    a.memoryTotal = 100 * 1024 * 1024;
    a.setPrefs({ memoryPercent: 10 });
    const st = await a.pager.enforce();
    const back = [];
    for (let k = 0; k < 8; k++) {
      back.push(sum());
      await a.historyMove("back");
    }
    a.memoryTotal = total;
    a.setPrefs({ memoryPercent: pct });
    return { onDisk: st.onDisk, inMemory: st.inMemory, same: JSON.stringify(looks) === JSON.stringify(back.slice(0, looks.length)) };
  });
  if (paged) {
    check("over the memory limit, older history goes to the scratch disk", paged.onDisk > 0, JSON.stringify(paged));
    check("undo brings paged-out steps back exactly", paged.same, JSON.stringify(paged));
  } else console.log("SKIP  scratch paging (no writable storage in this browser)");
  await page.locator(".status-pick").click();
  await page.getByText("Scratch Sizes", { exact: true }).click();
  check("the status bar can show Scratch Sizes", /^Scratch: /.test((await page.locator(".doc-info span").first().textContent()) ?? ""));
  await page.locator(".status-pick").click();
  await page.getByText("Document Sizes", { exact: true }).click();
  await page.screenshot({ path: out + "60-v11.png" });
  await ev(async () => {
    const a = window.editor.app;
    for (const s of [...a.sessions]) if (s.doc.name.startsWith("v11")) await a.closeSession(s);
  });
}

// ======================================================= People (needs model files in e2e/models)
const md = new URL("./models/", import.meta.url).pathname;
if (existsSync(md + "selfie_multiclass_256x256.tflite") && existsSync(md + "face_landmarker.task") && existsSync(md + "group.jpg")) {
  const local = {
    "selfie_multiclass_256x256.tflite": md + "selfie_multiclass_256x256.tflite",
    "face_landmarker.task": md + "face_landmarker.task",
    "vision_wasm_internal.js": "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js",
    "vision_wasm_internal.wasm": "node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm",
  };
  let fetched = 0;
  await context.route(/storage\.googleapis\.com|cdn\.jsdelivr\.net/, (route) => {
    fetched++;
    route.fulfill({ status: 200, body: readFileSync(local[route.request().url().split("/").pop()]), headers: { "access-control-allow-origin": "*" } });
  });
  await context.route(/\/e2e-photo\//, (route) => route.fulfill({ status: 200, body: readFileSync(md + route.request().url().split("/").pop()), headers: { "content-type": "image/jpeg" } }));
  const openPhoto = (name) =>
    ev(async (name) => {
      const img = new Image();
      img.src = "/e2e-photo/" + name;
      await img.decode();
      const k = Math.min(1, 1200 / Math.max(img.width, img.height));
      const w = Math.round(img.width * k), h = Math.round(img.height * k);
      const c = new OffscreenCanvas(w, h);
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      window.editor.app.openImage({ name, width: w, height: h, data: c.getContext("2d").getImageData(0, 0, w, h).data });
    }, name);
  await openPhoto("group.jpg");
  await page.locator(".menu-title", { hasText: "Select" }).click();
  await page.locator(".menu-pop >> text=People...").click();
  await page.waitForSelector(".ai-dialog");
  check("first use offers the one-time model download", (await page.locator(".ai-files li").count()) === 3);
  await page.getByRole("button", { name: "Download" }).click();
  await page.waitForSelector(".pp-dialog", { timeout: 180000 });
  check("models came from the download", fetched === 3, `${fetched} files`);
  const n = await page.locator(".pp-card").count();
  check("finds everyone in a group photo", n === 8, `${n} people`);
  await page.getByRole("button", { name: "None", exact: true }).click();
  await page.getByLabel("Person 2", { exact: true }).check();
  await page.screenshot({ path: out + "41-people.png" });
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForTimeout(300);
  check("People makes a selection", (await lastLabel()) === "Select People");
  const steps = await ev(() => window.editor.app.bus.history.states.length);
  const subj = await ev(() => window.editor.app.run("select.subject", {}));
  check("Select Subject reuses the cached analysis", subj === true && (await ev(() => window.editor.app.bus.history.states.length)) === steps + 1);
  const cover = await ev(() => {
    const s = window.editor.app.doc.selection;
    const b = s.bounds();
    return { b, w: window.editor.app.doc.width, h: window.editor.app.doc.height };
  });
  check("subject selection spans the group", cover.b.w > cover.w * 0.8 && cover.b.y > cover.h * 0.2, JSON.stringify(cover.b));

  // Face-Aware Liquify on a portrait.
  await openPhoto("face.jpg");
  await page.keyboard.press("Control+Shift+X");
  await page.waitForSelector(".lq-dialog");
  await page.keyboard.press("a");
  await page.waitForSelector(".ai-dialog");
  check("Face-Aware Liquify asks only for the face model", (await page.locator(".ai-files li:not(.ok)").count()) === 1);
  await page.getByRole("button", { name: "Download" }).click();
  await page.waitForSelector("text=Select Face", { timeout: 120000 });
  check("Face-Aware Liquify finds the face", (await page.locator(".lq-face select option").count()) === 1);
  const eye = page.getByLabel("Eye Size value", { exact: true });
  await eye.fill("60");
  await eye.press("Tab");
  const smile = page.getByLabel("Smile value", { exact: true });
  await smile.fill("70");
  await smile.press("Tab");
  await page.waitForTimeout(300);
  await page.screenshot({ path: out + "42-face-aware.png" });
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.waitForSelector(".lq-dialog", { state: "detached" });
  check("face sliders apply as a Liquify step", (await lastLabel()) === "Liquify");

  // Face Swap: brush the face to replace, then the face to use in another window, then Swap.
  if (existsSync(md + "face2.jpg")) {
    await openPhoto("face2.jpg");
    await ev(() => window.editor.app.windows.tile());
    await page.waitForTimeout(200);
    const faceOn = (name) =>
      ev((name) => {
        const s = window.editor.app.sessions.find((x) => x.doc.name === name);
        const v = s.compositor.view;
        const r = s.win.viewport.getBoundingClientRect();
        return { x: r.left + v.x + s.doc.width * 0.5 * v.zoom, y: r.top + v.y + s.doc.height * 0.42 * v.zoom };
      }, name);
    const brushFace = async (name) => {
      await ev((name) => {
        const app = window.editor.app;
        app.activate(app.sessions.find((x) => x.doc.name === name));
        app.fitOnScreen();
      }, name);
      await page.waitForTimeout(100);
      const p = await faceOn(name);
      await page.mouse.move(p.x - 25, p.y);
      await page.mouse.down();
      for (let k = 0; k <= 8; k++) await page.mouse.move(p.x - 25 + k * 6, p.y + (k % 2) * 16);
      await page.mouse.up();
    };
    await page.keyboard.press("j");
    for (let k = 0; k < 8 && (await ev(() => window.editor.app.tool.id)) !== "faceSwap"; k++) await page.keyboard.press("Shift+J");
    check("Shift+J cycles to the Face Swap tool", (await ev(() => window.editor.app.tool.id)) === "faceSwap");
    check("Swap waits for both faces", await page.locator(".fs-swap").isDisabled());
    await brushFace("face.jpg");
    await page.waitForFunction(() => document.querySelector(".fs-target")?.classList.contains("ok"), null, { timeout: 120000 });
    check("the first stroke marks the face to replace", true);
    await brushFace("face2.jpg");
    await page.waitForFunction(() => document.querySelector(".fs-source")?.classList.contains("ok"), null, { timeout: 120000 });
    check("the next stroke, in another window, marks the new face", await page.locator(".fs-swap").isEnabled());
    await page.screenshot({ path: out + "43-face-swap-marked.png" });
    await page.locator(".fs-swap").click();
    await page.waitForFunction(() => window.editor.app.bus.history.states.at(-1)?.label === "Face Swap", null, { timeout: 120000 });
    const fs = await ev(() => {
      const a = window.editor.app;
      const l = a.doc.activeLayer;
      return { doc: a.doc.name, name: l.name, mask: !!l.mask, center: l.mask ? l.mask.get(Math.round(a.doc.width / 2), Math.round(a.doc.height * 0.42)) : -1, corner: l.mask ? l.mask.get(3, 3) : -1 };
    });
    check("Swap puts the new face on a masked layer in the first image", fs.doc === "face.jpg" && fs.name === "Face Swap" && fs.mask && fs.center > 200 && fs.corner === 0, JSON.stringify(fs));
    await page.screenshot({ path: out + "44-face-swap.png" });
  }
} else console.log("SKIP  people / face checks (put selfie_multiclass_256x256.tflite, face_landmarker.task, group.jpg, face.jpg and face2.jpg in e2e/models)");

check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
await server.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
