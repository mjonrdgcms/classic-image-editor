/**
 * The Levels and Curves editors used in the filter dialog: a histogram with
 * draggable black, gray and white points, and a curve you click to add
 * points to and drag.
 */

import { CURVE_PRESETS, autoRange, curveLUTFrom, formatCurves, formatLevels, levelsLUT, parseCurves, parseLevels, type CurvePoints } from "../filters/defs/tone";
import { el } from "./dialogs";

const CHANNELS: [string, string][] = [
  ["0", "RGB"],
  ["1", "Red"],
  ["2", "Green"],
  ["3", "Blue"],
];
const CH_COLOR = ["#cfd2d8", "#ff6b6b", "#5fd16f", "#6aa5ff"];

function drawHist(ctx: CanvasRenderingContext2D, hist: Uint32Array | undefined, w: number, h: number, colorStr: string, alpha = 1): void {
  if (!hist) return;
  let max = 0;
  // Ignore the very top bin height spikes (pure black/white) when scaling.
  const sorted = Array.from(hist).sort((a, b) => b - a);
  max = sorted[2] || sorted[0] || 1;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colorStr;
  for (let i = 0; i < 256; i++) {
    const v = Math.min(1, hist[i] / max);
    const x = (i / 256) * w, bw = Math.max(1, w / 256);
    ctx.fillRect(x, h - v * h, bw, v * h);
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ Levels

export function levelsEditor(value: string, hist: Uint32Array[] | null, onChange: (v: string) => void): HTMLElement {
  const ch = parseLevels(value);
  let c = 0;
  const W = 256, HH = 100;
  const chSel = el("select", { "aria-label": "Channel" });
  for (const [v, l] of CHANNELS) chSel.append(el("option", { value: v, text: l }));
  const hcv = el("canvas", { class: "lv-hist", width: W, height: HH });
  const track = el("div", { class: "lv-track" });
  const outTrack = el("div", { class: "lv-track lv-out" });
  const mk = (cls: string, title: string) => {
    const k = el("div", { class: "lv-knob " + cls, title, role: "slider", tabindex: "0" });
    return k;
  };
  const kb = mk("b", "Shadow input level"), kg = mk("g", "Midtone (gamma)"), kw = mk("w", "Highlight input level");
  const ob = mk("b", "Output black"), ow = mk("w", "Output white");
  track.append(kb, kg, kw);
  outTrack.append(ob, ow);
  const num = (label: string, min: number, max: number, step: number) => el("input", { type: "number", min, max, step, "aria-label": label });
  const nb = num("Input black", 0, 253, 1), ng = num("Gamma", 0.1, 9.99, 0.01), nw = num("Input white", 2, 255, 1);
  const nob = num("Output black", 0, 255, 1), now = num("Output white", 0, 255, 1);
  const curvePrev = el("canvas", { class: "lv-ramp", width: W, height: 10 });
  const emit = () => onChange(formatLevels(ch));
  const draw = () => {
    const ctx = hcv.getContext("2d")!;
    ctx.clearRect(0, 0, W, HH);
    drawHist(ctx, hist?.[c], W, HH, CH_COLOR[c]);
    const L = ch[c];
    const pos = (v: number) => `${(v / 255) * 100}%`;
    kb.style.left = pos(L.inBlack);
    kw.style.left = pos(L.inWhite);
    // The gray knob sits where input maps to mid-gray.
    const mid = L.inBlack + (L.inWhite - L.inBlack) * Math.pow(0.5, L.gamma);
    kg.style.left = pos(mid);
    ob.style.left = pos(L.outBlack);
    ow.style.left = pos(L.outWhite);
    for (const [input, v] of [
      [nb, L.inBlack],
      [ng, L.gamma],
      [nw, L.inWhite],
      [nob, L.outBlack],
      [now, L.outWhite],
    ] as [HTMLInputElement, number][])
      if (document.activeElement !== input) input.value = String(v);
    // A ramp showing the result.
    const r = curvePrev.getContext("2d")!;
    const lut = levelsLUT(L);
    for (let x = 0; x < W; x++) {
      const v = lut[x];
      r.fillStyle = c === 0 ? `rgb(${v},${v},${v})` : c === 1 ? `rgb(${v},0,0)` : c === 2 ? `rgb(0,${v},0)` : `rgb(0,0,${v})`;
      r.fillRect(x, 0, 1, 10);
    }
  };
  const dragKnob = (k: HTMLElement, trackEl: HTMLElement, apply: (v: number) => void) => {
    k.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      k.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = trackEl.getBoundingClientRect();
        apply(Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 255));
        draw();
        emit();
      };
      const up = () => {
        k.removeEventListener("pointermove", move);
        k.removeEventListener("pointerup", up);
      };
      k.addEventListener("pointermove", move);
      k.addEventListener("pointerup", up);
    });
    k.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
      if (!d) return;
      e.preventDefault();
      const left = parseFloat(k.style.left) / 100;
      apply(Math.round(left * 255) + d * (e.shiftKey ? 10 : 1));
      draw();
      emit();
    });
  };
  dragKnob(kb, track, (v) => (ch[c].inBlack = Math.min(v, ch[c].inWhite - 2)));
  dragKnob(kw, track, (v) => (ch[c].inWhite = Math.max(v, ch[c].inBlack + 2)));
  dragKnob(kg, track, (v) => {
    const L = ch[c];
    const t = Math.max(0.01, Math.min(0.99, (v - L.inBlack) / (L.inWhite - L.inBlack)));
    // mid = black + range * 0.5^gamma  ->  gamma = log(t) / log(0.5)
    L.gamma = Math.round(Math.max(0.1, Math.min(9.99, Math.log(t) / Math.log(0.5))) * 100) / 100;
  });
  dragKnob(ob, outTrack, (v) => (ch[c].outBlack = v));
  dragKnob(ow, outTrack, (v) => (ch[c].outWhite = v));
  const bindNum = (input: HTMLInputElement, apply: (v: number) => void) =>
    input.addEventListener("change", () => {
      if (!Number.isFinite(+input.value)) return;
      apply(+input.value);
      // Re-validate through the parser.
      const fixed = parseLevels(formatLevels(ch));
      ch.splice(0, 4, ...fixed);
      draw();
      emit();
    });
  bindNum(nb, (v) => (ch[c].inBlack = Math.round(v)));
  bindNum(ng, (v) => (ch[c].gamma = v));
  bindNum(nw, (v) => (ch[c].inWhite = Math.round(v)));
  bindNum(nob, (v) => (ch[c].outBlack = Math.round(v)));
  bindNum(now, (v) => (ch[c].outWhite = Math.round(v)));
  chSel.addEventListener("change", () => {
    c = +chSel.value;
    draw();
  });
  const auto = el("button", { type: "button", class: "btn small", text: "Auto", title: "Set black and white points for each channel automatically" });
  auto.addEventListener("click", () => {
    if (!hist) return;
    ch[0] = { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 };
    for (let k = 1; k < 4; k++) {
      const [lo, hi] = autoRange(hist[k]);
      ch[k] = { inBlack: lo, gamma: 1, inWhite: Math.max(lo + 2, hi), outBlack: 0, outWhite: 255 };
    }
    draw();
    emit();
  });
  const reset = el("button", { type: "button", class: "btn small", text: "Reset" });
  reset.addEventListener("click", () => {
    for (let k = 0; k < 4; k++) ch[k] = { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 };
    draw();
    emit();
  });
  draw();
  return el(
    "div",
    { class: "lv" },
    el("div", { class: "lv-row" }, el("label", { text: "Channel:" }), chSel, el("span", { style: "flex:1" }), auto, reset),
    el("div", { class: "lv-box" }, hcv, track),
    el("div", { class: "lv-nums" }, el("label", { text: "Input:" }), nb, ng, nw),
    el("div", { class: "lv-box" }, curvePrev, outTrack),
    el("div", { class: "lv-nums" }, el("label", { text: "Output:" }), nob, now),
  );
}

// ------------------------------------------------------------------ Curves

export function curvesEditor(value: string, hist: Uint32Array[] | null, onChange: (v: string) => void): HTMLElement {
  let curves = parseCurves(value);
  let c = 0;
  const S = 256;
  const chSel = el("select", { "aria-label": "Channel" });
  for (const [v, l] of CHANNELS) chSel.append(el("option", { value: v, text: l }));
  const presetSel = el("select", { "aria-label": "Preset" });
  presetSel.append(el("option", { value: "", text: "Preset..." }));
  for (const [name] of CURVE_PRESETS) presetSel.append(el("option", { value: name, text: name }));
  const cv = el("canvas", { class: "cv-canvas", width: S * 2, height: S * 2, tabindex: "0", "aria-label": "Curve: click to add points, drag them, Delete removes" });
  const readout = el("span", { class: "cv-readout" });
  let active = -1;
  const emit = () => onChange(formatCurves(curves));
  const draw = () => {
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, S, S);
    drawHist(ctx, hist?.[c], S, S, CH_COLOR[c], 0.18);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 1; k < 4; k++) {
      ctx.moveTo((k * S) / 4 + 0.5, 0);
      ctx.lineTo((k * S) / 4 + 0.5, S);
      ctx.moveTo(0, (k * S) / 4 + 0.5);
      ctx.lineTo(S, (k * S) / 4 + 0.5);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(0, S);
    ctx.lineTo(S, 0);
    ctx.stroke();
    // Other channels faintly, then this one.
    const plot = (pts: CurvePoints, col: string, width: number) => {
      const lut = curveLUTFrom(pts);
      ctx.strokeStyle = col;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) x ? ctx.lineTo(x + 0.5, S - lut[x] - 0.5) : ctx.moveTo(0.5, S - lut[0] - 0.5);
      ctx.stroke();
    };
    if (c === 0) for (let k = 1; k < 4; k++) if (curves[k].length > 2 || curves[k][0].join() !== "0,0" || curves[k][1].join() !== "255,255") plot(curves[k], CH_COLOR[k] + "66", 1);
    plot(curves[c], CH_COLOR[c], 1.6);
    curves[c].forEach(([x, y], i) => {
      ctx.fillStyle = i === active ? CH_COLOR[c] : "#111";
      ctx.strokeStyle = CH_COLOR[c];
      ctx.lineWidth = 1.2;
      ctx.fillRect(x - 3.5, S - y - 3.5, 7, 7);
      ctx.strokeRect(x - 3.5, S - y - 3.5, 7, 7);
    });
    const p = curves[c][active];
    readout.textContent = p ? `Input: ${p[0]}   Output: ${p[1]}` : "Click the curve to add a point; drag to adjust.";
  };
  const toCurve = (e: PointerEvent | MouseEvent) => {
    const r = cv.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * 255), Math.round((1 - (e.clientY - r.top) / r.height) * 255)];
  };
  let dragging = false;
  cv.addEventListener("pointerdown", (e) => {
    cv.focus();
    const [x, y] = toCurve(e);
    const pts = curves[c];
    let hit = pts.findIndex(([px, py]) => Math.abs(px - x) <= 8 && Math.abs(py - y) <= 8);
    if (hit < 0) {
      // Add a point on the click (snapped onto the curve if near it).
      const lut = curveLUTFrom(pts);
      const yy = Math.abs(lut[Math.max(0, Math.min(255, x))] - y) < 12 ? lut[Math.max(0, Math.min(255, x))] : y;
      if (pts.some((p) => p[0] === x)) return;
      pts.push([Math.max(0, Math.min(255, x)), Math.max(0, Math.min(255, yy))]);
      pts.sort((a, b) => a[0] - b[0]);
      hit = pts.findIndex((p) => p[0] === Math.max(0, Math.min(255, x)));
      emit();
    }
    active = hit;
    dragging = true;
    cv.setPointerCapture(e.pointerId);
    draw();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragging || active < 0) return;
    const [x, y] = toCurve(e);
    const pts = curves[c];
    // Dragging an inner point far outside removes it.
    const out = x < -24 || x > 279 || y < -24 || y > 279;
    if (out && active > 0 && active < pts.length - 1) {
      pts.splice(active, 1);
      active = -1;
      dragging = false;
      draw();
      emit();
      return;
    }
    const lo = active > 0 ? pts[active - 1][0] + 1 : 0, hi = active < pts.length - 1 ? pts[active + 1][0] - 1 : 255;
    pts[active] = [Math.max(lo, Math.min(hi, x)), Math.max(0, Math.min(255, y))];
    draw();
    emit();
  });
  cv.addEventListener("pointerup", () => (dragging = false));
  cv.addEventListener("keydown", (e) => {
    const pts = curves[c];
    if ((e.key === "Delete" || e.key === "Backspace") && active > 0 && active < pts.length - 1) {
      pts.splice(active, 1);
      active = -1;
    } else if (e.key.startsWith("Arrow") && active >= 0) {
      const d = e.shiftKey ? 10 : 1;
      const [x, y] = pts[active];
      pts[active] = [x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0), Math.max(0, Math.min(255, y + (e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0)))];
      curves = parseCurves(formatCurves(curves));
    } else return;
    e.preventDefault();
    e.stopPropagation();
    draw();
    emit();
  });
  chSel.addEventListener("change", () => {
    c = +chSel.value;
    active = -1;
    draw();
  });
  presetSel.addEventListener("change", () => {
    const p = CURVE_PRESETS.find(([n]) => n === presetSel.value);
    if (!p) return;
    curves = parseCurves(p[1]);
    active = -1;
    presetSel.value = "";
    draw();
    emit();
  });
  const reset = el("button", { type: "button", class: "btn small", text: "Reset" });
  reset.addEventListener("click", () => {
    curves[c] = [
      [0, 0],
      [255, 255],
    ];
    active = -1;
    draw();
    emit();
  });
  draw();
  return el("div", { class: "cv" }, el("div", { class: "lv-row" }, el("label", { text: "Channel:" }), chSel, presetSel, el("span", { style: "flex:1" }), reset), cv, readout);
}
