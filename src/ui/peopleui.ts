/**
 * Select > Subject and Select > People...: finding people (cached per
 * image until its pixels change) and the People dialog, where you pick
 * people and parts of them, refine the edge, and choose where the result
 * goes (a selection, a layer mask, a new layer).
 */

import type { App } from "../app";
import type { Document } from "../core/document";
import { setPeopleProvider, adjustMatte, type PeopleSelectParams } from "../core/cmd/people";
import { PART_LABELS, PART_NAMES, analyzePeople, fitImg, peopleMatte, ANALYSIS_MAX, type PartName, type PeopleMap } from "../ai/people";
import { loadSegmenter } from "../ai/vision";
import type { Img } from "../filters/img";
import { busyPill, el, sheet } from "./dialogs";
import { ensureModels, PEOPLE_MODELS } from "./aimodels";
import * as storage from "./storage";

interface Entry {
  rev: number;
  w: number;
  h: number;
  map: PeopleMap;
  /** The picture at analysis size, for previews. */
  img: Img;
}

const cache = new WeakMap<Document, Entry>();
const running = new WeakMap<Document, Promise<Entry>>();

export function cachedPeople(doc: Document): Entry | null {
  const e = cache.get(doc);
  return e && e.rev === doc.pixelRev && e.w === doc.width && e.h === doc.height ? e : null;
}

/** Find the people in doc's merged image (fetching the models first if needed). */
export function findPeople(app: App, doc: Document): Promise<Entry> {
  const hit = cachedPeople(doc);
  if (hit) return Promise.resolve(hit);
  const inflight = running.get(doc);
  if (inflight) return inflight;
  const p = (async () => {
    if (!(await ensureModels(app, PEOPLE_MODELS, "Finding people"))) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
    const pill = busyPill("Loading the people model...");
    try {
      await new Promise((r) => setTimeout(r, 30));
      const seg = await loadSegmenter();
      const rev = doc.pixelRev;
      const W = doc.width, H = doc.height;
      const px = doc === app.doc ? app.compositor.readPixels({ x: 0, y: 0, w: W, h: H }) : doc.composite({ x: 0, y: 0, w: W, h: H });
      const full: Img = { w: W, h: H, data: px instanceof Uint8ClampedArray ? px : new Uint8ClampedArray(px.buffer, px.byteOffset, px.length) };
      const map = await analyzePeople(full, seg, async (done, label) => {
        pill.set(`${label}... ${Math.round(done * 100)}%`);
        await new Promise((r) => setTimeout(r, 0));
      });
      const e: Entry = { rev, w: W, h: H, map, img: fitImg(full, ANALYSIS_MAX) };
      cache.set(doc, e);
      return e;
    } finally {
      pill.done();
    }
  })();
  running.set(doc, p);
  void p.finally(() => running.delete(doc)).catch(() => {});
  return p;
}

export function installPeople(app: App): void {
  setPeopleProvider({
    get: (doc) => cachedPeople(doc)?.map ?? null,
    prepare: async (doc) => {
      await findPeople(app, doc);
    },
  });
}

// ------------------------------------------------------------------ dialog

type View = "overlay" | "black" | "white" | "matte" | "original";
type Output = "selection" | "mask" | "layer" | "layerMask";

interface DlgState {
  parts: PartName[] | null;
  refine: boolean;
  smooth: number;
  shiftEdge: number;
  feather: number;
  view: View;
  output: Output;
  mode: PeopleSelectParams["mode"];
  overlay: string;
}

const COLORS = ["#ff5050", "#40c860", "#4a86ff", "#ffc800", "#d04aff", "#00d0d0", "#ff8a00", "#a0a0a0"];

export async function peopleDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  let entry: Entry;
  try {
    entry = await findPeople(app, doc);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.name !== "AbortError") app.toast(`Could not find people: ${err.message}`);
    return;
  }
  if (app.doc !== doc) return;
  const { map, img } = entry;
  if (!map.people.length) {
    app.toast("No people were found in this image.");
    return;
  }

  const s: DlgState = {
    parts: null,
    refine: true,
    smooth: 0,
    shiftEdge: 0,
    feather: 0,
    view: "overlay",
    output: "selection",
    mode: "replace",
    overlay: "#ff3030",
    ...storage.load<Partial<DlgState>>("people", {}),
  };
  const picked = new Set<number>(map.people.map((_, i) => i));
  const save = () => storage.saveSoon("people", () => ({ ...s }));

  // ---------- preview
  const cv = el("canvas", { class: "pp-canvas", width: img.w, height: img.h, title: "Click a person to add or remove them" });
  const ctx = cv.getContext("2d")!;
  const marks = el("canvas", { class: "pp-marks" });
  const stage = el("div", { class: "pp-stage" }, cv, marks);
  let matte: Float32Array = new Float32Array(img.w * img.h);
  const render = () => {
    const out = ctx.createImageData(img.w, img.h);
    const d = out.data, src = img.data;
    const oc = [1, 3, 5].map((k) => parseInt(s.overlay.slice(k, k + 2), 16));
    for (let i = 0, p = 0; i < matte.length; i++, p += 4) {
      const a = matte[i];
      if (s.view === "matte") {
        d[p] = d[p + 1] = d[p + 2] = a * 255;
      } else if (s.view === "original") {
        d[p] = src[p];
        d[p + 1] = src[p + 1];
        d[p + 2] = src[p + 2];
      } else if (s.view === "overlay") {
        const k = (1 - a) * 0.55;
        d[p] = src[p] * (1 - k) + oc[0] * k;
        d[p + 1] = src[p + 1] * (1 - k) + oc[1] * k;
        d[p + 2] = src[p + 2] * (1 - k) + oc[2] * k;
      } else {
        const bg = s.view === "black" ? 0 : 255;
        d[p] = src[p] * a + bg * (1 - a);
        d[p + 1] = src[p + 1] * a + bg * (1 - a);
        d[p + 2] = src[p + 2] * a + bg * (1 - a);
      }
      d[p + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    drawMarks();
  };
  const drawMarks = () => {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    marks.width = Math.round(r.width * dpr);
    marks.height = Math.round(r.height * dpr);
    marks.style.width = r.width + "px";
    marks.style.height = r.height + "px";
    marks.style.left = cv.offsetLeft + "px";
    marks.style.top = cv.offsetTop + "px";
    const m = marks.getContext("2d")!;
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = r.width / img.w;
    map.people.forEach((p, i) => {
      const x = (p.head ?? p.box).x * k, y = (p.head ?? p.box).y * k, w = (p.head ?? p.box).w * k;
      const cx = x + w / 2, cy = Math.max(12, y - 12);
      m.beginPath();
      m.arc(cx, cy, 10, 0, Math.PI * 2);
      m.fillStyle = picked.has(i) ? COLORS[i % COLORS.length] : "rgba(30,30,30,0.75)";
      m.fill();
      m.lineWidth = 1.5;
      m.strokeStyle = "#fff";
      m.stroke();
      m.fillStyle = "#fff";
      m.font = "600 11px system-ui, sans-serif";
      m.textAlign = "center";
      m.textBaseline = "middle";
      m.fillText(String(i + 1), cx, cy + 0.5);
    });
  };
  let timer = 0;
  const recompute = (now = false) => {
    clearTimeout(timer);
    const go = () => {
      const people = picked.size === map.people.length ? null : [...picked];
      if (!picked.size) matte = new Float32Array(img.w * img.h);
      else {
        matte = peopleMatte(map, { people, parts: s.parts, refine: s.refine });
        const k = img.w / doc.width;
        if (s.smooth || s.shiftEdge) matte = adjustMatte(matte, img.w, img.h, s.smooth * k, s.shiftEdge * k);
        if (s.feather > 0) matte = featherPreview(matte, img.w, img.h, s.feather * k);
      }
      render();
      syncList();
    };
    if (now) go();
    else timer = window.setTimeout(go, 60);
  };

  cv.addEventListener("pointerdown", (e) => {
    const r = cv.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * img.w, y = ((e.clientY - r.top) / r.height) * img.h;
    const gx = Math.min(map.gw - 1, Math.floor((x / img.w) * map.gw)), gy = Math.min(map.gh - 1, Math.floor((y / img.h) * map.gh));
    const o = map.owner[gy * map.gw + gx];
    if (!o) return;
    const i = o - 1;
    if (e.altKey) {
      picked.clear();
      picked.add(i);
    } else if (picked.has(i)) picked.delete(i);
    else picked.add(i);
    recompute(true);
  });

  // ---------- people list
  const list = el("div", { class: "pp-list", role: "group", "aria-label": "People" });
  const tmp = el("canvas", { width: img.w, height: img.h });
  tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  const cards: HTMLElement[] = [];
  map.people.forEach((p, i) => {
    const t = el("canvas", { class: "pp-thumb" });
    const b = p.box;
    const th = 72, tw = Math.max(24, Math.min(110, Math.round((b.w / b.h) * th)));
    t.width = tw;
    t.height = th;
    const tc = t.getContext("2d")!;
    const k = Math.min(tw / b.w, th / b.h);
    tc.drawImage(tmp, b.x, b.y, b.w, b.h, (tw - b.w * k) / 2, (th - b.h * k) / 2, b.w * k, b.h * k);
    const cb = el("input", { type: "checkbox", checked: true, "aria-label": `Person ${i + 1}` });
    cb.addEventListener("change", () => {
      if (cb.checked) picked.add(i);
      else picked.delete(i);
      recompute(true);
    });
    const card = el("label", { class: "pp-card", style: `--pc:${COLORS[i % COLORS.length]}` }, t, el("span", { class: "pp-num" }, cb, `Person ${i + 1}`));
    cards.push(card);
    list.append(card);
  });
  const syncList = () => {
    cards.forEach((c, i) => {
      const cb = c.querySelector("input")!;
      cb.checked = picked.has(i);
      c.classList.toggle("on", picked.has(i));
    });
    ok.disabled = picked.size === 0;
    count.textContent = `${picked.size} of ${map.people.length} selected`;
  };
  const count = el("span", { class: "pp-count" });
  const allBtn = el("button", { type: "button", class: "btn small", text: "All" });
  const noneBtn = el("button", { type: "button", class: "btn small", text: "None" });
  const invBtn = el("button", { type: "button", class: "btn small", text: "Invert" });
  allBtn.addEventListener("click", () => {
    map.people.forEach((_, i) => picked.add(i));
    recompute(true);
  });
  noneBtn.addEventListener("click", () => {
    picked.clear();
    recompute(true);
  });
  invBtn.addEventListener("click", () => {
    map.people.forEach((_, i) => (picked.has(i) ? picked.delete(i) : picked.add(i)));
    recompute(true);
  });

  // ---------- parts
  const whole = el("input", { type: "checkbox", checked: !s.parts });
  const partBoxes = PART_NAMES.map((n) => {
    const c = el("input", { type: "checkbox", checked: !s.parts || s.parts.includes(n), "aria-label": PART_LABELS[n] });
    c.addEventListener("change", () => {
      const on = partBoxes.filter((x) => x.c.checked).map((x) => x.n);
      s.parts = on.length === PART_NAMES.length ? null : on;
      whole.checked = !s.parts;
      save();
      recompute();
    });
    return { n, c, row: el("label", { class: "pp-part" }, c, PART_LABELS[n]) };
  });
  whole.addEventListener("change", () => {
    s.parts = whole.checked ? null : [];
    partBoxes.forEach((x) => (x.c.checked = whole.checked));
    save();
    recompute();
  });

  // ---------- edge
  const slider = (label: string, key: "smooth" | "shiftEdge" | "feather", min: number, max: number, unit: string) => {
    const r = el("input", { type: "range", min, max, value: s[key], "aria-label": label });
    const n = el("input", { type: "number", min, max, value: s[key], "aria-label": label + " value" });
    const set = (v: number) => {
      s[key] = Math.max(min, Math.min(max, Math.round(v)));
      r.value = n.value = String(s[key]);
      save();
      recompute();
    };
    r.addEventListener("input", () => set(+r.value));
    n.addEventListener("change", () => set(+n.value));
    return el("div", { class: "pp-row" }, el("label", { text: label }), r, n, el("span", { class: "pp-unit", text: unit }));
  };
  const refine = el("input", { type: "checkbox", checked: s.refine });
  refine.addEventListener("change", () => {
    s.refine = refine.checked;
    save();
    recompute();
  });

  // ---------- view & output
  const viewSel = el("select", { "aria-label": "View" });
  for (const [v, t] of [["overlay", "Overlay"], ["black", "On Black"], ["white", "On White"], ["matte", "Black & White"], ["original", "Original"]]) viewSel.append(el("option", { value: v, text: t }));
  viewSel.value = s.view;
  viewSel.addEventListener("change", () => {
    s.view = viewSel.value as View;
    save();
    render();
  });
  const colorIn = el("input", { type: "color", value: s.overlay, "aria-label": "Overlay color" });
  colorIn.addEventListener("input", () => {
    s.overlay = colorIn.value;
    save();
    render();
  });
  const outSel = el("select", { "aria-label": "Output to" });
  for (const [v, t] of [["selection", "Selection"], ["mask", "Layer Mask"], ["layer", "New Layer"], ["layerMask", "New Layer with Layer Mask"]]) outSel.append(el("option", { value: v, text: t }));
  outSel.value = s.output;
  const modeSel = el("select", { "aria-label": "Selection mode" });
  for (const [v, t] of [["replace", "New Selection"], ["add", "Add to Selection"], ["subtract", "Subtract from Selection"], ["intersect", "Intersect with Selection"]]) modeSel.append(el("option", { value: v, text: t }));
  modeSel.value = s.mode;
  const modeRow = el("div", { class: "pp-row" }, el("label", { text: "Mode" }), modeSel);
  const syncOut = () => (modeRow.style.display = s.output === "selection" ? "" : "none");
  outSel.addEventListener("change", () => {
    s.output = outSel.value as Output;
    save();
    syncOut();
  });
  modeSel.addEventListener("change", () => {
    s.mode = modeSel.value as DlgState["mode"];
    save();
  });
  syncOut();

  const sec = (title: string, ...kids: (Node | string | null)[]) => el("section", { class: "pp-sec" }, el("h3", { text: title }), ...kids);
  const side = el(
    "div",
    { class: "pp-side" },
    sec("People", el("div", { class: "pp-tools" }, allBtn, noneBtn, invBtn, count), list, el("p", { class: "pp-hint", text: "Click people in the picture to add or remove them; Alt-click to select only that person." })),
    sec("Parts", el("label", { class: "pp-part pp-whole" }, whole, "Whole Person"), el("div", { class: "pp-parts" }, ...partBoxes.map((x) => x.row))),
    sec(
      "Edge",
      el("label", { class: "pp-part" }, refine, "Refine Edge (hair and fine detail)"),
      slider("Smooth", "smooth", 0, 50, "px"),
      slider("Shift Edge", "shiftEdge", -50, 50, "px"),
      slider("Feather", "feather", 0, 100, "px"),
    ),
    sec("View", el("div", { class: "pp-row" }, el("label", { text: "Show" }), viewSel, colorIn)),
    sec("Output", el("div", { class: "pp-row" }, el("label", { text: "Output To" }), outSel), modeRow),
  );
  const ok = el("button", { type: "button", class: "btn default", text: "OK" });
  const cancel = el("button", { type: "button", class: "btn", text: "Cancel" });
  const footer = el("div", { class: "pp-footer" }, el("span", { class: "pp-note", text: `${map.people.length} ${map.people.length === 1 ? "person" : "people"} found` }), el("span", { style: "flex:1" }), cancel, ok);
  const dlg = sheet("Select People", el("div", { class: "pp" }, el("div", { class: "pp-body" }, stage, side), footer), {
    className: "pp-dialog",
    onKey: (e) => {
      if (e.type === "keydown" && e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        ok.click();
        return true;
      }
      return false;
    },
  });
  ok.addEventListener("click", () => dlg.close("ok"));
  cancel.addEventListener("click", () => dlg.close("cancel"));
  const ro = new ResizeObserver(() => drawMarks());
  ro.observe(stage);
  recompute(true);
  const r = await dlg.done;
  ro.disconnect();
  clearTimeout(timer);
  if (r !== "ok" || app.doc !== doc) return;

  const params: Record<string, unknown> = {
    people: picked.size === map.people.length ? [] : [...picked].sort((a, b) => a - b),
    parts: s.parts ?? [],
    smooth: s.smooth,
    shiftEdge: s.shiftEdge,
    feather: s.feather,
    refine: s.refine,
  };
  applyPeopleOutput(app, params, s.output, s.mode);
}

/** Send a People selection to its output: a selection, a layer mask, or a new layer. */
export function applyPeopleOutput(app: App, params: Record<string, unknown>, output: Output, mode: PeopleSelectParams["mode"]): boolean {
  const doc = app.doc!;
  if (output === "selection") return app.run("select.people", { ...params, mode });
  const bus = app.bus;
  try {
    bus.group(output === "mask" ? "Layer Mask from People" : "New Layer from People", () => {
      bus.dispatch("select.people", { ...params, mode: "replace" });
      const l = doc.activeLayer;
      if (output === "mask") {
        if (l?.isBackground) bus.dispatch("layer.fromBackground", {});
        if (doc.activeNode?.mask) bus.dispatch("layer.removeMask", { apply: false });
        bus.dispatch("layer.addMask", { reveal: "selection" });
      } else if (output === "layer") {
        bus.dispatch("layer.newViaCopy", {});
      } else {
        bus.dispatch("layer.duplicate", { name: `${l?.name ?? "Layer"} (people)` });
        if (doc.activeNode?.mask) bus.dispatch("layer.removeMask", { apply: false });
        bus.dispatch("layer.addMask", { reveal: "selection" });
      }
      bus.dispatch("select.none", {});
    });
    return true;
  } catch (e) {
    app.toast(`Could not complete Select People: ${(e as Error).message}.`);
    return false;
  }
}

/** A quick Gaussian-ish feather of the preview matte (three box passes). */
function featherPreview(m: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(1, Math.round(radius / 2));
  let a = m;
  for (let i = 0; i < 3; i++) a = boxBlurF(a, w, h, r);
  return a;
}

function boxBlurF(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(a.length);
  const tmp = new Float32Array(a.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += a[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc * inv;
      acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
