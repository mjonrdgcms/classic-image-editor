/**
 * Image > Adjustments > Black & White Lab.
 *
 * A darkroom for monochrome: lens-filter color sliders (drag on the picture
 * to change the one under the cursor), film stocks, tone, clarity, grain,
 * halation, vignette and toning, with a before/after split, a histogram
 * and Ansel Adams' zones under the preview.
 */

import type { App } from "../app";
import { filterRegion } from "../core/cmd/filters";
import { BW_DEFAULTS, BW_PRESETS, COLOR_HUES, COLOR_KEYS, TONINGS, autoWeights, blackWhite, dominantColor, toneLUT, type BWPreset, type BWSettings, type ColorKey } from "../filters/bw";
import { downscale, hsvToRgb, luma, type Img } from "../filters/img";
import { busyPill, el, formDialog, sheet } from "./dialogs";
import * as storage from "./storage";

const LABELS: Record<ColorKey, string> = { reds: "Reds", yellows: "Yellows", greens: "Greens", cyans: "Cyans", blues: "Blues", magentas: "Magentas" };
const ZONES = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

interface Slider {
  key: keyof BWSettings;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  track?: string;
}

const TONE: Slider[] = [
  { key: "brightness", label: "Brightness", min: -100, max: 100 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "blacks", label: "Blacks", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "whites", label: "Whites", min: -100, max: 100 },
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
];
const GRAIN: Slider[] = [
  { key: "grain", label: "Amount", min: 0, max: 100 },
  { key: "grainSize", label: "Size", min: 0.5, max: 5, step: 0.1 },
  { key: "grainRough", label: "Roughness", min: 0, max: 100 },
];
const FX: Slider[] = [
  { key: "glow", label: "Halation Glow", min: 0, max: 100 },
  { key: "vignette", label: "Vignette", min: -100, max: 100 },
  { key: "vignetteSize", label: "Vignette Size", min: 0, max: 100 },
];
const SPLIT: Slider[] = [
  { key: "shadowHue", label: "Shadow Hue", min: 0, max: 360, unit: "°" },
  { key: "shadowSat", label: "Shadow Saturation", min: 0, max: 100 },
  { key: "highlightHue", label: "Highlight Hue", min: 0, max: 360, unit: "°" },
  { key: "highlightSat", label: "Highlight Saturation", min: 0, max: 100 },
  { key: "toneBalance", label: "Balance", min: -100, max: 100 },
];

const hex = (c: number[]) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

export async function blackWhiteLab(app: App, init?: Partial<BWSettings> & { output?: string }, onApply?: (params: Record<string, unknown>) => boolean): Promise<boolean> {
  const doc = app.doc;
  if (!doc) return false;
  // ---------------------------------------------------------------- source
  let full: Img;
  try {
    full = filterRegion({ doc, bus: app.bus }, { pad: () => 0 }, {}).img;
  } catch (e) {
    app.toast(`Black & White Lab: ${(e as Error).message}`);
    return false;
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const src = downscale(full, Math.round(760 * dpr));
  const scale = src.w / full.w;
  const tiny = downscale(full, 132);

  const { output: initOut, ...initS } = init ?? {};
  let s: BWSettings = { ...BW_DEFAULTS, ...(init ? initS : storage.load<Partial<BWSettings>>("bwLast", {})) };
  const userPresets = (): BWPreset[] => storage.load<BWPreset[]>("bwPresets", []);
  let output = initOut ?? storage.load<string>("bwOutput", "newLayer");
  let view: "split" | "after" | "before" = "split";
  let splitAt = 0.5;
  let activeColor: ColorKey | null = null;

  // ---------------------------------------------------------------- preview
  const pv = el("canvas", { class: "bw-preview", width: src.w, height: src.h });
  const pctx = pv.getContext("2d")!;
  const before = new ImageData(new Uint8ClampedArray(src.data), src.w, src.h);
  let after: ImageData = before;
  const divider = el("div", { class: "bw-divider", "aria-hidden": "true" }, el("span", { class: "bw-knob" }));
  const tag = el("div", { class: "bw-tag" });
  const pvWrap = el("div", { class: "bw-pvwrap" }, pv, divider, tag);
  const hist = el("canvas", { class: "bw-hist", width: 512, height: 70 });
  const zoneStrip = el("div", { class: "bw-zones" });
  const zoneEls = ZONES.map((z, i) => {
    const v = Math.round((i / 10) * 255);
    const e = el("div", { class: "bw-zone", style: `background:rgb(${v},${v},${v});color:${v > 140 ? "#111" : "#eee"}`, text: z, title: `Zone ${z}` });
    zoneStrip.append(e);
    return e;
  });
  const viewSeg = el("div", { class: "seg" });
  for (const [v, l] of [["split", "Split"], ["before", "Before"], ["after", "After"]] as const) {
    const b = el("button", { type: "button", text: l, "data-v": v });
    b.addEventListener("click", () => {
      view = v;
      draw();
    });
    viewSeg.append(b);
  }
  const hint = el("span", { class: "bw-hint", text: "Drag left or right on the picture to darken or lighten the color under the cursor." });
  const center = el("div", { class: "bw-center" }, el("div", { class: "bw-viewbar" }, viewSeg, hint), pvWrap, el("div", { class: "bw-histbox" }, hist, zoneStrip));

  // ---------------------------------------------------------------- controls
  const controls = new Map<string, { range: HTMLInputElement; num: HTMLInputElement; row: HTMLElement }>();
  const slider = (d: Slider) => {
    const range = el("input", { type: "range", min: d.min, max: d.max, step: d.step ?? 1, value: s[d.key] as number, "aria-label": d.label });
    const num = el("input", { type: "number", min: d.min, max: d.max, step: d.step ?? 1, value: s[d.key] as number, "aria-label": d.label + " value" });
    const set = (v: number) => {
      v = Math.max(d.min, Math.min(d.max, v));
      (s as unknown as Record<string, number>)[d.key] = v;
      range.value = num.value = String(v);
      schedule();
    };
    range.addEventListener("input", () => set(+range.value));
    num.addEventListener("change", () => set(+num.value));
    const row = el("div", { class: "bw-row" }, el("label", { text: d.label }), num, range);
    if (d.track) range.style.setProperty("--track", d.track);
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).tagName === "LABEL") set(BW_DEFAULTS[d.key] as number);
    });
    controls.set(d.key, { range, num, row });
    return row;
  };
  const section = (title: string, ...kids: (HTMLElement | null)[]) => {
    const head = el("button", { type: "button", class: "bw-sechead", text: title });
    const body = el("div", { class: "bw-secbody" }, ...kids);
    const sec = el("section", { class: "bw-sec" }, head, body);
    head.addEventListener("click", () => sec.classList.toggle("closed"));
    return sec;
  };
  const colorRows = COLOR_KEYS.map((k) => {
    const c = hsvToRgb(COLOR_HUES[k], 0.85, 0.95);
    return slider({ key: k, label: LABELS[k], min: -200, max: 300, unit: "%", track: `linear-gradient(90deg, #000, ${hex(c)} 45%, #fff)` });
  });
  const autoBtn = el("button", { type: "button", class: "btn small", text: "Auto" });
  autoBtn.addEventListener("click", () => {
    Object.assign(s, autoWeights(downscale(full, 256)));
    syncControls();
    schedule();
  });
  const toningSel = el("select", { "aria-label": "Toning" });
  for (const [k, t] of Object.entries(TONINGS)) toningSel.append(el("option", { value: k, text: t.label }));
  const splitBox = el("div", { class: "bw-split" }, ...SPLIT.map((d) => slider({ ...d, track: d.key.endsWith("Hue") ? "linear-gradient(90deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)" : undefined })));
  toningSel.addEventListener("change", () => {
    s.toning = toningSel.value;
    splitBox.style.display = s.toning === "split" ? "" : "none";
    schedule();
  });
  const swatches = el("div", { class: "bw-toneswatches" });
  for (const [k, t] of Object.entries(TONINGS)) {
    if (!t.tone && k !== "none") continue;
    const ts: BWSettings = { ...BW_DEFAULTS, toning: k, toneAmount: 70 };
    const lo = blackWhite({ w: 1, h: 1, data: new Uint8ClampedArray([70, 70, 70, 255]) }, ts), hi = blackWhite({ w: 1, h: 1, data: new Uint8ClampedArray([200, 200, 200, 255]) }, ts);
    const b = el("button", { type: "button", class: "bw-tsw", title: t.label, style: `background:linear-gradient(135deg, ${hex([...lo.data.slice(0, 3)])}, ${hex([...hi.data.slice(0, 3)])})` });
    b.addEventListener("click", () => {
      s.toning = k;
      toningSel.value = k;
      splitBox.style.display = "none";
      schedule();
    });
    swatches.append(b);
  }
  const seedBtn = el("button", { type: "button", class: "btn small", text: "New Grain Pattern" });
  seedBtn.addEventListener("click", () => {
    s.seed = Math.floor(Math.random() * 1e6);
    schedule();
  });
  const right = el(
    "div",
    { class: "bw-right" },
    section("Color Filters", el("div", { class: "bw-sub" }, el("span", { text: "How bright each color becomes in gray" }), autoBtn), ...colorRows),
    section("Tone", ...TONE.map(slider)),
    section("Film Grain", ...GRAIN.map(slider), el("div", { class: "bw-sub" }, seedBtn)),
    section("Glow & Vignette", ...FX.map(slider)),
    section("Toning", swatches, el("div", { class: "bw-row" }, el("label", { text: "Toning" }), toningSel), slider({ key: "toneAmount", label: "Amount", min: 0, max: 100 }), splitBox),
  );

  // ---------------------------------------------------------------- presets
  const presetPane = el("div", { class: "bw-presets" });
  const thumbFor = (p: Partial<BWSettings>) => {
    const out = blackWhite(tiny, { ...BW_DEFAULTS, ...p }, tiny.w / full.w, { w: full.w, h: full.h });
    const cv = el("canvas", { width: out.w, height: out.h });
    cv.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(out.data), out.w, out.h), 0, 0);
    return cv;
  };
  const renderPresets = () => {
    presetPane.textContent = "";
    const groups = new Map<string, BWPreset[]>();
    for (const p of [...BW_PRESETS, ...userPresets().map((u) => ({ ...u, group: "Yours" }))]) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group)!.push(p);
    }
    for (const [g, list] of groups) {
      presetPane.append(el("div", { class: "bw-pgroup", text: g === "Filters" ? "Lens Filters" : g === "Film" ? "Film Stocks" : g === "Looks" ? "Looks" : "Your Presets" }));
      const wrap = el("div", { class: "bw-pgrid" });
      for (const p of list) {
        const b = el("button", { type: "button", class: "bw-preset", title: p.name }, thumbFor(p.s), el("span", { text: p.name }));
        b.addEventListener("click", () => {
          s = { ...BW_DEFAULTS, ...p.s, seed: p.s.seed ?? s.seed };
          syncControls();
          schedule();
          presetPane.querySelectorAll(".bw-preset").forEach((x) => x.classList.toggle("on", x === b));
        });
        if (g === "Yours")
          b.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            storage.save("bwPresets", userPresets().filter((u) => u.name !== p.name));
            renderPresets();
          });
        wrap.append(b);
      }
      presetPane.append(wrap);
    }
  };

  // ---------------------------------------------------------------- footer
  const outSel = el("select", { "aria-label": "Output" });
  outSel.append(el("option", { value: "newLayer", text: "As a New Layer" }), el("option", { value: "current", text: "On This Layer" }));
  outSel.value = output;
  outSel.addEventListener("change", () => (output = outSel.value));
  const saveBtn = el("button", { type: "button", class: "btn", text: "Save Preset..." });
  const resetBtn = el("button", { type: "button", class: "btn", text: "Reset" });
  const cancelBtn = el("button", { type: "button", class: "btn", text: "Cancel" });
  const okBtn = el("button", { type: "button", class: "btn default", text: "Apply" });
  const footer = el("div", { class: "bw-footer" }, el("label", { class: "bw-out" }, "Output ", outSel), saveBtn, resetBtn, el("span", { style: "flex:1" }), cancelBtn, okBtn);
  saveBtn.addEventListener("click", async () => {
    const r = await formDialog("Save Black & White Preset", [{ key: "name", label: "Name", type: "text", value: "My Look" }]);
    if (!r || !String(r.name).trim()) return;
    const name = String(r.name).trim();
    storage.save("bwPresets", [...userPresets().filter((u) => u.name !== name), { name, group: "Yours", s: { ...s } }]);
    renderPresets();
  });
  resetBtn.addEventListener("click", () => {
    s = { ...BW_DEFAULTS };
    syncControls();
    schedule();
  });

  const body = el("div", { class: "bw-body" }, presetPane, center, right);
  const dlg = sheet("Black & White Lab", el("div", { class: "bw-lab" }, body, footer), {
    className: "bw-dialog",
    onKey: (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        okBtn.click();
        return true;
      }
      if (e.key === "\\" && !(e.target as HTMLElement).closest("input, select")) {
        view = view === "before" ? "split" : "before";
        draw();
        return true;
      }
      return false;
    },
  });
  cancelBtn.addEventListener("click", () => dlg.close("cancel"));
  okBtn.addEventListener("click", () => dlg.close("ok"));

  // ---------------------------------------------------------------- render
  function syncControls() {
    for (const [k, c] of controls) c.range.value = c.num.value = String((s as unknown as Record<string, number>)[k]);
    toningSel.value = s.toning;
    splitBox.style.display = s.toning === "split" ? "" : "none";
  }
  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const out = blackWhite(src, s, scale, { w: full.w, h: full.h });
      after = new ImageData(new Uint8ClampedArray(out.data), out.w, out.h);
      draw();
      drawHist(out);
    });
  }
  function draw() {
    viewSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === view));
    if (view === "before") pctx.putImageData(before, 0, 0);
    else pctx.putImageData(after, 0, 0);
    if (view === "split") {
      const x = Math.round(src.w * splitAt);
      pctx.putImageData(before, 0, 0, 0, 0, x, src.h);
    }
    divider.style.display = view === "split" ? "" : "none";
    divider.style.left = `calc(var(--box-left, 0px) + var(--box-w, 100%) * ${splitAt})`;
  }
  const hctx = hist.getContext("2d")!;
  function drawHist(out: Img) {
    const h = new Uint32Array(256);
    for (let p = 0; p < out.data.length; p += 4) if (out.data[p + 3] > 8) h[Math.round(luma(out.data[p], out.data[p + 1], out.data[p + 2]))]++;
    let mx = 1;
    for (let i = 2; i < 254; i++) mx = Math.max(mx, h[i]);
    const W = hist.width, H = hist.height;
    hctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    hctx.fillStyle = css.getPropertyValue("--text-dim").trim() || "#999";
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, h[i] / mx);
      hctx.fillRect((i / 256) * W, H - v * H, W / 256 + 0.5, v * H);
    }
    // The tone curve over it.
    const lut = toneLUT(s);
    hctx.strokeStyle = css.getPropertyValue("--accent").trim() || "#69f";
    hctx.lineWidth = 2;
    hctx.beginPath();
    for (let i = 0; i < 256; i += 3) {
      const x = (i / 255) * W, y = H - (lut[i] / 255) * H;
      if (i) hctx.lineTo(x, y);
      else hctx.moveTo(x, y);
    }
    hctx.stroke();
  }

  // ---------------------------------------------------------------- interaction
  const posOf = (e: PointerEvent) => {
    const r = pv.getBoundingClientRect();
    // object-fit: contain; work out the drawn image box.
    const k = Math.min(r.width / src.w, r.height / src.h);
    const w = src.w * k, h = src.h * k;
    const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    return { x: (e.clientX - ox) / w, y: (e.clientY - oy) / h, box: { ox: ox - r.left, oy: oy - r.top, w, h } };
  };
  const highlight = (k: ColorKey | null) => {
    for (const ck of COLOR_KEYS) controls.get(ck)!.row.classList.toggle("target", ck === k);
  };
  let drag: { mode: "split" | "color"; key?: ColorKey; start: number; x0: number } | null = null;
  pv.addEventListener("pointermove", (e) => {
    const p = posOf(e);
    if (drag) {
      if (drag.mode === "split") {
        splitAt = Math.max(0, Math.min(1, p.x));
        draw();
      } else if (drag.key) {
        const v = Math.max(-200, Math.min(300, Math.round(drag.start + (e.clientX - drag.x0) * 0.8)));
        s[drag.key] = v;
        const c = controls.get(drag.key)!;
        c.range.value = c.num.value = String(v);
        tag.textContent = `${LABELS[drag.key]} ${v}%`;
        schedule();
      }
      return;
    }
    if (p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1) {
      tag.style.display = "none";
      return;
    }
    const ix = Math.min(src.w - 1, Math.floor(p.x * src.w)), iy = Math.min(src.h - 1, Math.floor(p.y * src.h));
    const q = (iy * src.w + ix) * 4;
    activeColor = dominantColor(src.data[q], src.data[q + 1], src.data[q + 2]);
    const gv = after.data[q];
    const zone = Math.round((gv / 255) * 10);
    zoneEls.forEach((z, i) => z.classList.toggle("on", i === zone));
    highlight(activeColor);
    tag.style.display = "";
    tag.style.left = `${p.box.ox + p.x * p.box.w + 14}px`;
    tag.style.top = `${p.box.oy + p.y * p.box.h + 10}px`;
    tag.textContent = `${LABELS[activeColor]} ${s[activeColor]}% · Zone ${ZONES[zone]}`;
  });
  pv.addEventListener("pointerleave", () => {
    if (!drag) {
      tag.style.display = "none";
      highlight(null);
      zoneEls.forEach((z) => z.classList.remove("on"));
    }
  });
  pv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const p = posOf(e);
    pv.setPointerCapture(e.pointerId);
    const nearDivider = view === "split" && Math.abs(p.x - splitAt) * p.box.w < 10;
    if (nearDivider) drag = { mode: "split", start: splitAt, x0: e.clientX };
    else if (activeColor) drag = { mode: "color", key: activeColor, start: s[activeColor], x0: e.clientX };
  });
  pv.addEventListener("pointerup", () => (drag = null));
  divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = pv.getBoundingClientRect();
      const k = Math.min(r.width / src.w, r.height / src.h);
      const w = src.w * k, ox = r.left + (r.width - w) / 2;
      splitAt = Math.max(0, Math.min(1, (ev.clientX - ox) / w));
      draw();
    };
    const up = () => {
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", up);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", up);
  });
  const placeDivider = () => {
    const r = pv.getBoundingClientRect(), wr = pvWrap.getBoundingClientRect();
    const k = Math.min(r.width / src.w, r.height / src.h);
    const w = src.w * k, h = src.h * k;
    divider.style.setProperty("--box-left", `${r.left - wr.left + (r.width - w) / 2}px`);
    divider.style.setProperty("--box-w", `${w}px`);
    divider.style.top = `${r.top - wr.top + (r.height - h) / 2}px`;
    divider.style.height = `${h}px`;
  };
  const ro = new ResizeObserver(placeDivider);
  ro.observe(pvWrap);

  renderPresets();
  syncControls();
  schedule();
  requestAnimationFrame(placeDivider);

  const r = await dlg.done;
  ro.disconnect();
  if (raf) cancelAnimationFrame(raf);
  if (r !== "ok") return false;
  if (onApply) return onApply({ ...s, output });
  storage.save("bwLast", s);
  storage.save("bwOutput", output);
  const big = full.w * full.h > 300_000;
  const pill = big ? busyPill("Converting to black & white...") : null;
  await new Promise((res) => requestAnimationFrame(() => setTimeout(res, 0)));
  try {
    return app.run("image.blackWhite", { ...s, output });
  } finally {
    pill?.done();
  }
}
