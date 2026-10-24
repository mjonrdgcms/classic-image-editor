/**
 * The Color Picker (Preferences > General > Color Picker: Classic Image
 * Editor), laid out like Photoshop 7's: a saturation / brightness field for
 * the hue chosen on the strip beside it, new and current swatches, and
 * HSB, RGB, Lab, CMYK and hex values that all stay in step.
 */

import { el, modal } from "./dialogs";

type RGB = [number, number, number];

export function rgbToHsb([r, g, b]: RGB): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, max ? (d / max) * 100 : 0, max * 100];
}

export function hsbToRgb(h: number, s: number, v: number): RGB {
  s /= 100;
  v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const WHITE = [0.95047, 1, 1.08883];

/** sRGB to CIE L*a*b* (D65). */
export function rgbToLab([r, g, b]: RGB): [number, number, number] {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const xyz = [R * 0.4124 + G * 0.3576 + B * 0.1805, R * 0.2126 + G * 0.7152 + B * 0.0722, R * 0.0193 + G * 0.1192 + B * 0.9505];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = xyz.map((v, i) => f(v / WHITE[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const [X, Y, Z] = [inv(fx), inv(fy), inv(fz)].map((v, i) => v * WHITE[i]);
  const R = X * 3.2406 - Y * 1.5372 - Z * 0.4986, G = -X * 0.9689 + Y * 1.8758 + Z * 0.0415, B = X * 0.0557 - Y * 0.204 + Z * 1.057;
  return [R, G, B].map((v) => Math.round(Math.max(0, Math.min(1, gam(v))) * 255)) as RGB;
}

/** Simple (uncalibrated) CMYK, in percent. */
export function rgbToCmyk([r, g, b]: RGB): [number, number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255, k = 1 - Math.max(R, G, B);
  if (k >= 1) return [0, 0, 0, 100];
  return [((1 - R - k) / (1 - k)) * 100, ((1 - G - k) / (1 - k)) * 100, ((1 - B - k) / (1 - k)) * 100, k * 100];
}

export function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const K = k / 100;
  return [c, m, y].map((v) => Math.round(255 * (1 - v / 100) * (1 - K))) as RGB;
}

const hex = (c: RGB) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
/** Snap to the 216 web-safe colors. */
const webSafe = (c: RGB): RGB => c.map((v) => Math.round(v / 51) * 51) as RGB;

/** Pick a color. Resolves with the new color, or null if cancelled. */
export async function colorPickerDialog(title: string, initial: RGB): Promise<RGB | null> {
  let [h, s, v] = rgbToHsb(initial);
  let rgb: RGB = [...initial];
  const field = el("canvas", { width: 256, height: 256, class: "cp-field", "aria-label": "Saturation and brightness" });
  const strip = el("canvas", { width: 20, height: 256, class: "cp-strip", "aria-label": "Hue" });
  const now = el("div", { class: "cp-new", title: "New color" });
  const was = el("div", { class: "cp-current", title: "Current color (click to go back to it)", style: `background:${hex(initial)}` });
  was.addEventListener("click", () => setRGB([...initial]));
  const webOnly = el("input", { type: "checkbox" });
  const num = (label: string, min: number, max: number, unit = "") => {
    const i = el("input", { type: "number", min, max, step: 1, "aria-label": label }) as HTMLInputElement;
    return { i, row: el("label", { class: "cp-row" }, el("span", { text: label + ":" }), i, el("span", { class: "cp-unit", text: unit })) };
  };
  const H = num("H", 0, 360, "°"), S = num("S", 0, 100, "%"), B = num("B", 0, 100, "%");
  const R = num("R", 0, 255), G = num("G", 0, 255), Bl = num("B", 0, 255);
  const L = num("L", 0, 100), A = num("a", -128, 127), Bb = num("b", -128, 127);
  const C = num("C", 0, 100, "%"), M = num("M", 0, 100, "%"), Y = num("Y", 0, 100, "%"), K = num("K", 0, 100, "%");
  const hexIn = el("input", { type: "text", "aria-label": "Hex", style: "width:72px" }) as HTMLInputElement;

  const drawField = () => {
    const ctx = field.getContext("2d")!;
    const img = ctx.createImageData(256, 256);
    for (let y = 0; y < 256; y++)
      for (let x = 0; x < 256; x++) {
        const c = hsbToRgb(h, (x / 255) * 100, 100 - (y / 255) * 100);
        img.data.set([c[0], c[1], c[2], 255], (y * 256 + x) * 4);
      }
    ctx.putImageData(img, 0, 0);
    const px = (s / 100) * 255, py = (1 - v / 100) * 255;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = v > 55 ? "#000" : "#fff";
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.stroke();
  };
  const drawStrip = () => {
    const ctx = strip.getContext("2d")!;
    for (let y = 0; y < 256; y++) {
      ctx.fillStyle = hex(hsbToRgb(360 - (y / 255) * 360, 100, 100));
      ctx.fillRect(0, y, 20, 1);
    }
    const y = (1 - h / 360) * 255;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, Math.round(y) - 1, 20, 3);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, Math.round(y), 20, 1);
  };
  const sync = (skip?: HTMLInputElement) => {
    const set = (i: HTMLInputElement, n: number) => {
      if (i !== skip) i.value = String(Math.round(n));
    };
    set(H.i, h);
    set(S.i, s);
    set(B.i, v);
    set(R.i, rgb[0]);
    set(G.i, rgb[1]);
    set(Bl.i, rgb[2]);
    const lab = rgbToLab(rgb);
    set(L.i, lab[0]);
    set(A.i, lab[1]);
    set(Bb.i, lab[2]);
    const cmyk = rgbToCmyk(rgb);
    set(C.i, cmyk[0]);
    set(M.i, cmyk[1]);
    set(Y.i, cmyk[2]);
    set(K.i, cmyk[3]);
    if (hexIn !== skip) hexIn.value = hex(rgb).slice(1);
    now.style.background = hex(rgb);
    drawField();
    drawStrip();
  };
  const setRGB = (c: RGB, skip?: HTMLInputElement, keepHue = false) => {
    rgb = webOnly.checked ? webSafe(c) : c;
    const hsb = rgbToHsb(rgb);
    // Grays have no hue: keep the one on the strip.
    if (!keepHue && hsb[1] > 0) h = hsb[0];
    s = hsb[1];
    v = hsb[2];
    sync(skip);
  };
  const setHSB = (nh: number, ns: number, nv: number, skip?: HTMLInputElement) => {
    h = Math.max(0, Math.min(360, nh));
    s = Math.max(0, Math.min(100, ns));
    v = Math.max(0, Math.min(100, nv));
    rgb = hsbToRgb(h % 360, s, v);
    if (webOnly.checked) return setRGB(rgb, skip, true);
    sync(skip);
  };
  const drag = (c: HTMLCanvasElement, f: (x: number, y: number) => void) => {
    const at = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      f(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
    };
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      at(e);
    });
    c.addEventListener("pointermove", (e) => {
      if (e.buttons & 1) at(e);
    });
  };
  drag(field, (x, y) => setHSB(h, x * 100, (1 - y) * 100));
  drag(strip, (_x, y) => setHSB((1 - y) * 360, s, v));
  const val = (i: HTMLInputElement) => +i.value || 0;
  for (const f of [H, S, B]) f.i.addEventListener("input", () => setHSB(val(H.i), val(S.i), val(B.i), f.i));
  for (const f of [R, G, Bl]) f.i.addEventListener("input", () => setRGB([R, G, Bl].map((x) => Math.max(0, Math.min(255, Math.round(val(x.i))))) as RGB, f.i));
  for (const f of [L, A, Bb]) f.i.addEventListener("input", () => setRGB(labToRgb(val(L.i), val(A.i), val(Bb.i)), f.i));
  for (const f of [C, M, Y, K]) f.i.addEventListener("input", () => setRGB(cmykToRgb(val(C.i), val(M.i), val(Y.i), val(K.i)), f.i));
  hexIn.addEventListener("input", () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hexIn.value.trim());
    if (!m) return;
    const n = parseInt(m[1], 16);
    setRGB([(n >> 16) & 255, (n >> 8) & 255, n & 255], hexIn);
  });
  webOnly.addEventListener("change", () => setRGB(rgb));
  sync();
  const body = el(
    "div",
    { class: "cp" },
    field,
    strip,
    el(
      "div",
      { class: "cp-side" },
      el("div", { class: "cp-swatches" }, el("span", { class: "cp-cap", text: "new" }), now, was, el("span", { class: "cp-cap", text: "current" })),
      el("div", { class: "cp-cols" }, el("div", {}, H.row, S.row, B.row, el("div", { class: "cp-gap" }), R.row, G.row, Bl.row), el("div", {}, L.row, A.row, Bb.row, el("div", { class: "cp-gap" }), C.row, M.row, Y.row, K.row)),
      el("label", { class: "cp-row" }, el("span", { text: "#" }), hexIn),
      el("label", { class: "cp-web" }, webOnly, "Only Web Colors"),
    ),
  );
  const r = await modal(title, body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ], 720);
  return r === "ok" ? rgb : null;
}

/** Choose the foreground or background color with the picker Preferences ask for. */
export async function pickDocColor(app: import("../app").App, which: "foreground" | "background"): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const c = which === "foreground" ? doc.foreground : doc.background;
  if (app.prefs.colorPicker === "system") {
    const input = el("input", { type: "color", value: hex([c[0], c[1], c[2]]) });
    input.style.cssText = "position:fixed;left:-100px;opacity:0";
    document.body.append(input);
    input.addEventListener("input", () => {
      const v = input.value;
      app.run("color.set", { which, r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) });
    });
    input.addEventListener("change", () => input.remove());
    input.click();
    return;
  }
  const r = await colorPickerDialog(which === "foreground" ? "Color Picker (Foreground Color)" : "Color Picker (Background Color)", [c[0], c[1], c[2]]);
  if (r && app.doc === doc) app.run("color.set", { which, r: r[0], g: r[1], b: r[2] });
}
