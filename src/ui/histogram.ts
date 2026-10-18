/** Image > Histogram: the tonal distribution of the image (or the selection), with statistics. */

import type { App } from "../app";
import { el, modal } from "./dialogs";
import { settlePendingEdits } from "../core/history";

export async function histogramDialog(app: App): Promise<void> {
  settlePendingEdits();
  const doc = app.doc;
  if (!doc) return;
  const W = doc.width, H = doc.height;
  const px = app.compositor.readPixels({ x: 0, y: 0, w: W, h: H });
  const sel = doc.selection;
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let count = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let wt = px[i + 3] / 255;
      if (sel) wt *= sel.get(x, y) / 255;
      if (wt <= 0) continue;
      count += wt;
      hist[1][px[i]] += wt;
      hist[2][px[i + 1]] += wt;
      hist[3][px[i + 2]] += wt;
      hist[0][Math.round(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114)] += wt;
    }
  const S = 256, HH = 128;
  const cv = el("canvas", { class: "hg-canvas", width: S * 2, height: HH * 2 });
  const chSel = el("select", { "aria-label": "Channel" });
  for (const [v, t] of [["0", "Luminosity"], ["rgb", "RGB (overlaid)"], ["1", "Red"], ["2", "Green"], ["3", "Blue"]]) chSel.append(el("option", { value: v, text: t }));
  const stats = el("div", { class: "hg-stats" });
  const hover = el("div", { class: "hg-hover" });
  const COLORS = ["#d8dbe2", "#ff5e5e", "#4fd364", "#5f9dff"];
  const statsFor = (h: Float64Array) => {
    let n = 0, sum = 0;
    for (let i = 0; i < 256; i++) {
      n += h[i];
      sum += h[i] * i;
    }
    const mean = n ? sum / n : 0;
    let v = 0, acc = 0, median = 0;
    for (let i = 0; i < 256; i++) v += h[i] * (i - mean) ** 2;
    for (let i = 0; i < 256; i++) {
      acc += h[i];
      if (acc >= n / 2) {
        median = i;
        break;
      }
    }
    return { mean, std: n ? Math.sqrt(v / n) : 0, median, n };
  };
  const draw = () => {
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, S, HH);
    const chans = chSel.value === "rgb" ? [1, 2, 3] : [+chSel.value];
    let max = 0;
    for (const c of chans) {
      const sorted = Array.from(hist[c]).sort((a, b) => b - a);
      max = Math.max(max, sorted[2] || sorted[0] || 1);
    }
    ctx.globalCompositeOperation = chSel.value === "rgb" ? "lighter" : "source-over";
    for (const c of chans) {
      ctx.fillStyle = COLORS[c];
      ctx.globalAlpha = chSel.value === "rgb" ? 0.75 : 1;
      for (let i = 0; i < 256; i++) {
        const h = Math.min(1, hist[c][i] / max) * HH;
        ctx.fillRect(i, HH - h, 1, h);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const st = statsFor(hist[chSel.value === "rgb" ? 0 : +chSel.value]);
    stats.textContent = "";
    for (const [k, v] of [
      ["Mean", st.mean.toFixed(2)],
      ["Std Dev", st.std.toFixed(2)],
      ["Median", String(st.median)],
      ["Pixels", Math.round(count).toLocaleString()],
    ])
      stats.append(el("span", { class: "hg-k", text: k + ":" }), el("span", { text: v }));
  };
  cv.addEventListener("pointermove", (e) => {
    const r = cv.getBoundingClientRect();
    const lvl = Math.max(0, Math.min(255, Math.floor(((e.clientX - r.left) / r.width) * 256)));
    const h = hist[chSel.value === "rgb" ? 0 : +chSel.value];
    let below = 0, total = 0;
    for (let i = 0; i < 256; i++) {
      total += h[i];
      if (i <= lvl) below += h[i];
    }
    hover.textContent = `Level: ${lvl}   Count: ${Math.round(h[lvl]).toLocaleString()}   Percentile: ${total ? ((below / total) * 100).toFixed(2) : "0"}`;
  });
  cv.addEventListener("pointerleave", () => (hover.textContent = ""));
  chSel.addEventListener("change", draw);
  draw();
  const body = el(
    "div",
    { class: "form hg" },
    el("div", { class: "field-row" }, el("label", { text: "Channel:" }), el("span", {}, chSel)),
    cv,
    el("div", { class: "hg-ramp" }),
    hover,
    stats,
    el("p", { class: "is-note", text: sel ? "Showing the selected area." : "Showing the whole image as you see it." }),
  );
  await modal("Histogram", body, [{ label: "OK", value: "ok", default: true }], true);
}
