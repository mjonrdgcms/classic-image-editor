/** Color Range and Preferences dialogs. */

import type { App } from "../app";
import { el, modal } from "./dialogs";
import { hex } from "./toolbox";
import type { UIHooks } from "./actions";

/**
 * Select > Color Range: click the preview (or the image) to sample a color,
 * set Fuzziness, and see the resulting selection live as a grayscale mask.
 */
export async function colorRangeDialog(app: App): Promise<void> {
  const doc = app.doc!;
  const W = 260, H = 200;
  const s = Math.min(W / doc.width, H / doc.height, 1);
  const pw = Math.max(1, Math.round(doc.width * s)), ph = Math.max(1, Math.round(doc.height * s));
  // Downsampled copy of the merged image for the live preview.
  const full = app.compositor.readPixels({ x: 0, y: 0, w: doc.width, h: doc.height });
  const small = new Uint8ClampedArray(pw * ph * 4);
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(doc.width - 1, Math.floor((x + 0.5) / s)), sy = Math.min(doc.height - 1, Math.floor((y + 0.5) / s));
      small.set(full.subarray((sy * doc.width + sx) * 4, (sy * doc.width + sx) * 4 + 4), (y * pw + x) * 4);
    }
  let color: [number, number, number] = [doc.foreground[0], doc.foreground[1], doc.foreground[2]];
  let fuzz = 40;
  let showImage = false;
  const cv = el("canvas", { width: pw, height: ph, class: "range-preview", title: "Click to sample a color" });
  const ctx = cv.getContext("2d")!;
  const swatch = el("span", { class: "range-swatch" });
  const slider = el("input", { type: "range", min: 0, max: 200, value: fuzz, "aria-label": "Fuzziness", style: "flex:1" });
  const num = el("input", { type: "number", min: 0, max: 200, value: fuzz, "aria-label": "Fuzziness value" });
  const draw = () => {
    const img = ctx.createImageData(pw, ph);
    for (let i = 0, p = 0; i < pw * ph; i++, p += 4) {
      if (showImage) {
        img.data.set(small.subarray(p, p + 4), p);
        img.data[p + 3] = 255;
        continue;
      }
      const d = Math.max(Math.abs(small[p] - color[0]), Math.abs(small[p + 1] - color[1]), Math.abs(small[p + 2] - color[2]));
      const v = Math.max(0, Math.min(1, (1 - d / Math.max(1, fuzz)) * 2)) * (small[p + 3] / 255) * 255;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    swatch.style.background = hex(color);
  };
  cv.addEventListener("pointerdown", (e) => {
    const r = cv.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * pw), y = Math.floor(((e.clientY - r.top) / r.height) * ph);
    const o = (y * pw + x) * 4;
    color = [small[o], small[o + 1], small[o + 2]];
    draw();
  });
  const sync = (v: number) => {
    fuzz = Math.max(0, Math.min(200, Math.round(v)));
    slider.value = String(fuzz);
    num.value = String(fuzz);
    draw();
  };
  slider.addEventListener("input", () => sync(+slider.value));
  num.addEventListener("change", () => sync(+num.value));
  const radio = (label: string, v: boolean) => {
    const r = el("input", { type: "radio", name: "crview", checked: v === showImage });
    r.addEventListener("change", () => {
      showImage = v;
      draw();
    });
    return el("label", {}, r, " " + label);
  };
  const mode = el("select", { "aria-label": "Selection mode" });
  for (const [v, l] of [["replace", "New Selection"], ["add", "Add to Selection"], ["subtract", "Subtract from Selection"], ["intersect", "Intersect with Selection"]])
    mode.append(el("option", { value: v, text: l }));
  draw();
  const body = el(
    "div",
    { class: "form" },
    el("div", { class: "field-row" }, el("label", { text: "Select:" }), el("span", {}, "Sampled Colors ", swatch)),
    el("div", { style: "display:flex;gap:6px;align-items:center" }, el("span", { text: "Fuzziness:" }), slider, num),
    cv,
    el("div", { style: "display:flex;gap:12px" }, radio("Selection", false), radio("Image", true)),
    el("div", { class: "field-row" }, el("label", { text: "Mode:" }), mode),
  );
  const r = await modal("Color Range", body, [
    { label: "OK", value: "ok", default: true },
    { label: "Cancel", value: "cancel" },
  ]);
  if (r === "ok") app.run("select.colorRange", { r: color[0], g: color[1], b: color[2], fuzziness: fuzz, mode: mode.value });
}

/** Edit > Preferences (see prefsdialog.ts). */
export async function preferencesDialog(app: App, ui: UIHooks, section?: string): Promise<void> {
  return (await import("./prefsdialog")).preferencesDialog(app, ui, section);
}
