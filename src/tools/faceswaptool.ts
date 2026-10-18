/**
 * The Face Swap tool (J).
 *
 *   1. Brush over the face you want to replace.
 *   2. Click the window with the face you want to use (it can be the same
 *      picture) and brush over that face.
 *   3. Click Swap.
 *
 * Each stroke finds the face under it (MediaPipe face landmarks); the
 * options bar shows both faces and the Swap button. The new face lands on
 * a new layer with a mask, so it can be refined with a brush. Alt-stroke
 * marks the face to use directly; clicking a face's slot in the options
 * bar chooses which one the next stroke marks.
 */

import type { App, Session } from "../app";
import { OVAL } from "../ai/faceaware";
import { DEFAULT_SWAP, faceBox, swapFace, type FaceParts, type SwapOptions } from "../ai/faceswap";
import { fitImg } from "../ai/people";
import { detectFaces, loadSegmenter } from "../ai/vision";
import { b64 } from "../core/cmd/faceswap";
import { resizeBilinear, type Img } from "../filters/img";
import { ensureModels, FACE_MODELS } from "../ui/aimodels";
import { busyPill, el } from "../ui/dialogs";
import * as storage from "../ui/storage";
import type { Tool, ToolEvent } from "./tools";

type Slot = "target" | "source";

interface Mark {
  session: Session;
  points: [number, number][];
  /** Brush radius in canvas pixels. */
  radius: number;
  status: "drawing" | "finding" | "found" | "none";
  note: string;
  /** 478 landmarks (x, y) in canvas pixels. */
  face: Float32Array | null;
  thumb: HTMLCanvasElement | null;
  /** The document's size when marked (landmarks are in its pixels). */
  size: [number, number];
  /** The layer the last swap onto this face made (replaced when swapping again). */
  result?: number;
}

interface Settings extends SwapOptions {
  /** Brush radius in screen pixels. */
  size: number;
}

const COLORS: Record<Slot, string> = { target: "#4a86ff", source: "#ff9a3c" };
const LABELS: Record<Slot, string> = { target: "Face to replace", source: "New face" };

export interface FaceSwapState {
  target: Mark | null;
  source: Mark | null;
  next: Slot;
  busy: boolean;
  settings: Settings;
  message: string;
}

let state: FaceSwapState | null = null;
const listeners = new Set<() => void>();

export function faceSwapState(): FaceSwapState {
  return (state ??= {
    target: null,
    source: null,
    next: "target",
    busy: false,
    settings: { ...DEFAULT_SWAP, size: 22, ...storage.load<Partial<Settings>>("faceSwap", {}) },
    message: "",
  });
}

function changed(app: App): void {
  for (const fn of listeners) fn();
  app.emit("overlay");
}

/** Drop marks whose image window was closed or whose image changed size. Returns true if any went. */
function prune(app: App): boolean {
  const st = faceSwapState();
  let gone = false;
  for (const k of ["target", "source"] as const) {
    const m = st[k];
    if (m && (!app.sessions.includes(m.session) || m.session.doc.width !== m.size[0] || m.session.doc.height !== m.size[1])) {
      st[k] = null;
      gone = true;
    }
  }
  if (gone && !st.target) st.next = "target";
  return gone;
}

// ------------------------------------------------------------------ finding the face under a stroke

function strokeBounds(m: Mark) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of m.points) {
    x0 = Math.min(x0, x - m.radius);
    y0 = Math.min(y0, y - m.radius);
    x1 = Math.max(x1, x + m.radius);
    y1 = Math.max(y1, y + m.radius);
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function readCrop(doc: Session["doc"], r: { x: number; y: number; w: number; h: number }): Img {
  return { w: r.w, h: r.h, data: doc.composite(r) };
}

function clipRect(doc: Session["doc"], x: number, y: number, w: number, h: number) {
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(doc.width, Math.ceil(x + w)), y1 = Math.min(doc.height, Math.ceil(y + h));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

async function findFace(app: App, m: Mark): Promise<void> {
  m.status = "finding";
  m.note = "Finding the face...";
  changed(app);
  try {
    if (!(await ensureModels(app, FACE_MODELS, "Face Swap"))) {
      m.status = "none";
      m.note = "Face Swap needs the AI models";
      return;
    }
    const doc = m.session.doc;
    const b = strokeBounds(m);
    // The stroke itself, without the brush's width, says how big the face is.
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (const [x, y] of m.points) {
      px0 = Math.min(px0, x);
      py0 = Math.min(py0, y);
      px1 = Math.max(px1, x);
      py1 = Math.max(py1, y);
    }
    const side0 = Math.max(96, Math.max(px1 - px0, py1 - py0, m.radius) * 2.5);
    // Look close around the stroke first (small faces need it), then wider, then everywhere.
    const tries = [1, 2, 4].map((k) => clipRect(doc, b.cx - (side0 * k) / 2, b.cy - (side0 * k) / 2, side0 * k, side0 * k));
    tries.push({ x: 0, y: 0, w: doc.width, h: doc.height });
    for (const r of tries) {
      const img = fitImg(readCrop(doc, r), r.w === doc.width && r.h === doc.height ? 1024 : 720);
      const k = img.w / r.w;
      // Hint where the face is, so a small face gets a close-up look too.
      const hint = { x: (Math.max(r.x, px0 - m.radius) - r.x) * k, y: (Math.max(r.y, py0 - m.radius) - r.y) * k, w: (px1 - px0 + m.radius * 2) * k, h: (py1 - py0 + m.radius * 2) * k };
      const faces = await detectFaces(img, [hint]);
      if (!app.sessions.includes(m.session)) return;
      if (!faces.length) continue;
      const sx = r.w / img.w, sy = r.h / img.h;
      // The face the stroke is on: nearest center to the stroke's middle.
      let best: Float32Array | null = null, bestD = Infinity;
      for (const f of faces) {
        const pts = new Float32Array(f.pts.length);
        for (let i = 0; i < pts.length; i += 2) {
          pts[i] = r.x + f.pts[i] * sx;
          pts[i + 1] = r.y + f.pts[i + 1] * sy;
        }
        const fb = faceBox(pts);
        // A face cut off by the crop's edge is a guess from part of a face: look wider instead.
        const pad = Math.min(r.w, r.h) * 0.02;
        const cut =
          (fb.x < r.x + pad && r.x > 0) || (fb.y < r.y + pad && r.y > 0) || (fb.x + fb.w > r.x + r.w - pad && r.x + r.w < doc.width) || (fb.y + fb.h > r.y + r.h - pad && r.y + r.h < doc.height);
        if (cut) continue;
        const d = Math.hypot(fb.x + fb.w / 2 - b.cx, fb.y + fb.h / 2 - b.cy) / Math.max(fb.w, fb.h);
        if (d < bestD) {
          bestD = d;
          best = pts;
        }
      }
      if (best && bestD < 1.2) {
        m.face = best;
        m.status = "found";
        m.note = "";
        m.thumb = thumbOf(doc, best);
        const st = faceSwapState();
        const other = st.target === m ? st.source : st.source === m ? st.target : null;
        if (other?.face && other.session === m.session && overlap(faceBox(other.face), faceBox(best)) > 0.5) {
          m.status = "none";
          m.note = "That is the same face. Brush over a different face.";
          if (st.source === m) st.next = "source";
        }
        return;
      }
    }
    m.status = "none";
    m.note = "No face under that stroke. Brush right over the face.";
    // Let the next stroke try this slot again.
    const st = faceSwapState();
    if (st.target === m) st.next = "target";
    else if (st.source === m) st.next = "source";
  } catch (e) {
    m.status = "none";
    m.note = `Could not look for a face: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    changed(app);
  }
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

function thumbOf(doc: Session["doc"], pts: Float32Array): HTMLCanvasElement {
  const fb = faceBox(pts);
  const s = Math.max(fb.w, fb.h) * 1.15;
  const r = clipRect(doc, fb.x + fb.w / 2 - s / 2, fb.y + fb.h / 2 - s / 2, s, s);
  const img = fitImg(readCrop(doc, r), 96);
  const c = el("canvas", { width: img.w, height: img.h, class: "fs-thumb-img" });
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
  return c;
}

// ------------------------------------------------------------------ swapping

const partsOf = (conf: Float32Array[]): FaceParts => ({ background: conf[0], hair: conf[1], other: conf[5] });

/** Is this mark ready to swap? */
const ready = (m: Mark | null): m is Mark & { face: Float32Array } => !!m && m.status === "found" && !!m.face;

/** The biggest face (in pixels) the blend works at; bigger faces are done smaller and scaled up. */
const WORK_FACE = 1024;

/** Scale an image down by k (in halving steps first, so it doesn't alias). */
function shrinkImg(img: Img, k: number): Img {
  if (k >= 1) return img;
  const tw = Math.max(1, Math.round(img.w * k)), th = Math.max(1, Math.round(img.h * k));
  let out = img;
  while (out.w / 2 > tw) out = resizeBilinear(out, Math.round(out.w / 2), Math.round(out.h / 2));
  return resizeBilinear(out, tw, th);
}

/** Body-part maps for a crop, from a segmentation of a copy at most 512 px. */
function partsFor(seg: (img: Img) => { conf: Float32Array[] }, img: Img): FaceParts {
  const small = fitImg(img, 512);
  const conf = seg(small).conf;
  if (small.w === img.w && small.h === img.h) return partsOf(conf);
  const up = (m: Float32Array) => {
    const o = new Float32Array(img.w * img.h);
    for (let y = 0; y < img.h; y++) {
      const fy = Math.max(0, Math.min(small.h - 1, ((y + 0.5) * small.h) / img.h - 0.5));
      const y0 = fy | 0, y1 = Math.min(small.h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < img.w; x++) {
        const fx = Math.max(0, Math.min(small.w - 1, ((x + 0.5) * small.w) / img.w - 0.5));
        const x0 = fx | 0, x1 = Math.min(small.w - 1, x0 + 1), tx = fx - x0;
        o[y * img.w + x] = (m[y0 * small.w + x0] * (1 - tx) + m[y0 * small.w + x1] * tx) * (1 - ty) + (m[y1 * small.w + x0] * (1 - tx) + m[y1 * small.w + x1] * tx) * ty;
      }
    }
    return o;
  };
  return { background: up(conf[0]), hair: up(conf[1]), other: up(conf[5]) };
}

export async function runSwap(app: App): Promise<boolean> {
  const st = faceSwapState();
  prune(app);
  const t = st.target, s = st.source;
  const fail = (msg: string) => {
    st.message = msg;
    changed(app);
    return false;
  };
  if (st.busy) return false;
  if (!ready(t) || !ready(s)) return fail(!t || !s ? "Mark both faces first." : "Wait until both faces are found.");
  st.busy = true;
  changed(app);
  const pill = busyPill("Swapping faces...");
  try {
    await new Promise((r) => setTimeout(r, 20));
    const tDoc = t.session.doc, sDoc = s.session.doc;
    const tb = faceBox(t.face), sb = faceBox(s.face);
    const tm = Math.max(tb.w, tb.h) * 0.25, sm = Math.max(sb.w, sb.h) * 0.25;
    const tr = clipRect(tDoc, tb.x - tm, tb.y - tm, tb.w + tm * 2, tb.h + tm * 2);
    const sr = clipRect(sDoc, sb.x - sm, sb.y - sm, sb.w + sm * 2, sb.h + sm * 2);
    // Swapping again: read the picture without the earlier result.
    const prev = t.result !== undefined ? tDoc.layerById(t.result) : undefined;
    const prevShown = prev?.visible;
    if (prev) prev.visible = false;
    let T: Img, S: Img;
    try {
      T = readCrop(tDoc, tr);
      S = readCrop(sDoc, sr);
    } finally {
      if (prev) prev.visible = prevShown!;
    }
    // Work at a size where the face is at most WORK_FACE px; the source at most 1.5 times the target face.
    const kt = Math.min(1, WORK_FACE / Math.max(tb.w, tb.h));
    T = shrinkImg(T, kt);
    const kts = T.w / tr.w;
    const tpts = t.face.map((v, i) => (i % 2 ? (v - tr.y) * (T.h / tr.h) : (v - tr.x) * kts));
    const ks = Math.min(1, (1.5 * Math.max(tb.w, tb.h) * kt) / Math.max(1, Math.max(sb.w, sb.h)));
    S = shrinkImg(S, ks);
    const spts = s.face.map((v, i) => (i % 2 ? (v - sr.y) * (S.h / sr.h) : (v - sr.x) * (S.w / sr.w)));
    // Hair, glasses and background on both sides (the swap still works without them).
    let tParts: FaceParts | null = null, sParts: FaceParts | null = null;
    {
      try {
        const seg = await loadSegmenter();
        tParts = partsFor(seg, T);
        sParts = partsFor(seg, S);
      } catch (e) {
        console.warn("Face Swap: body-part maps unavailable", e);
      }
    }
    pill.set("Blending the new face...");
    await new Promise((r) => setTimeout(r, 0));
    const r = swapFace({ img: T, pts: tpts, parts: tParts }, { img: S, pts: spts, parts: sParts }, st.settings);
    if (!app.sessions.includes(t.session)) return fail("The picture with the face to replace was closed.");
    if (app.active !== t.session) app.activate(t.session);
    if (app.active !== t.session) return fail("Could not switch to the picture with the face to replace; try Swap again.");
    const params: Record<string, unknown> = { rect: tr, width: T.w, height: T.h, pixels: b64(new Uint8Array(r.pixels.buffer)), mask: b64(r.mask) };
    if (prev && tDoc.layerById(prev.id)) params.replace = prev.id;
    const ok = app.run("layer.faceSwap", params);
    if (ok) {
      t.result = tDoc.activeLayerId;
      const turned = r.mirrored > 0.2;
      st.message = turned ? "Done. The new face was turned away, so part of it was filled from its other side." : "Done. Change the options and Swap again, or brush another face.";
      if (turned) app.toast("The new face is turned away from the camera, so part of it was filled from its other side. A photo facing the camera works best.");
      if (!tParts) app.toast("Hair and glasses could not be kept (the body-part model didn't load).");
    }
    return ok;
  } catch (e) {
    return fail(`Could not swap the faces: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pill.done();
    st.busy = false;
    changed(app);
  }
}

// ------------------------------------------------------------------ the tool

export function makeFaceSwapTool(app: App): Tool {
  const st = faceSwapState();
  let drawing: { mark: Mark; slot: Slot } | null = null;

  // Draw both marks (in whichever windows they are) and the brush ring.
  app.overlayPainters.add((ctx, s, v) => {
    if (prune(app)) queueMicrotask(() => changed(app));
    const toolOn = app.tool.id === "faceSwap";
    const list: [Slot, Mark | null][] = [["target", st.target], ["source", st.source]];
    if (drawing) list.push([drawing.slot, drawing.mark]);
    for (const [slot, m] of list) {
      if (!m || m.session !== s) continue;
      if (!toolOn && m.status !== "drawing") continue;
      const col = COLORS[slot];
      // The stroke.
      if (m.points.length && (m.status !== "found" || m === drawing?.mark)) {
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.38;
        ctx.lineWidth = m.radius * 2 * v.zoom;
        ctx.beginPath();
        m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * v.zoom + v.x, y * v.zoom + v.y) : ctx.moveTo(x * v.zoom + v.x, y * v.zoom + v.y)));
        if (m.points.length === 1) ctx.lineTo(m.points[0][0] * v.zoom + v.x + 0.01, m.points[0][1] * v.zoom + v.y);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // The face it found.
      let lx = 0, ly = 0;
      if (m.face) {
        ctx.beginPath();
        OVAL.forEach((i, k) => {
          const x = m.face![i * 2] * v.zoom + v.x, y = m.face![i * 2 + 1] * v.zoom + v.y;
          if (k) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = col + "22";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        const fb = faceBox(m.face);
        lx = (fb.x + fb.w / 2) * v.zoom + v.x;
        ly = fb.y * v.zoom + v.y - 10;
      } else if (m.points.length) {
        const b = strokeBounds(m);
        lx = b.cx * v.zoom + v.x;
        ly = b.y0 * v.zoom + v.y - 10;
      }
      if (m.status === "drawing") continue;
      // Label.
      const text = `${slot === "target" ? "1" : "2"}  ${LABELS[slot]}${m.status === "finding" ? " (finding...)" : m.status === "none" ? ": no face found" : ""}`;
      ctx.font = "600 12px system-ui, sans-serif";
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = m.status === "none" ? "#c33" : col;
      ctx.beginPath();
      ctx.roundRect(lx - w / 2, ly - 20, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, lx, ly - 10);
    }
    // Brush ring.
    if (toolOn && app.active === s && app.pointer) {
      const r = st.settings.size;
      const x = app.pointer.x * v.zoom + v.x, y = app.pointer.y * v.zoom + v.y;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = COLORS[st.next];
      ctx.beginPath();
      ctx.arc(x, y, r + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  });

  return {
    id: "faceSwap",
    label: "Face Swap Tool",
    shortcut: "J",
    icon: "faceSwap",
    cursor: "crosshair",
    hint: "Brush over the face to replace, then over the face to use (in this or another open image), then click Swap. Alt-brush marks the face to use.",
    down(e: ToolEvent) {
      const s = app.active;
      if (!s || st.busy) return;
      const slot: Slot = e.alt ? "source" : st.next;
      drawing = {
        slot,
        mark: { session: s, points: [[e.x, e.y]], radius: st.settings.size / s.compositor.view.zoom, status: "drawing", note: "", face: null, thumb: null, size: [s.doc.width, s.doc.height] },
      };
      app.emit("overlay");
    },
    move(e: ToolEvent) {
      if (!drawing) return;
      const p = drawing.mark.points;
      const [lx, ly] = p[p.length - 1];
      if (Math.hypot(e.x - lx, e.y - ly) > drawing.mark.radius * 0.3) p.push([e.x, e.y]);
    },
    up() {
      const d = drawing;
      drawing = null;
      if (!d) return;
      st[d.slot] = d.mark;
      st.message = "";
      // After the face to replace, the next stroke picks the face to use.
      st.next = d.slot === "target" || st.target ? "source" : "target";
      void findFace(app, d.mark);
      changed(app);
    },
    hover() {
      app.emit("overlay");
    },
    onKey(e: KeyboardEvent) {
      if (e.type !== "keydown" || e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "[" || e.key === "]") {
        st.settings.size = Math.max(4, Math.min(200, Math.round(st.settings.size * (e.key === "]" ? 1.2 : 1 / 1.2))));
        storage.saveSoon("faceSwap", () => st.settings);
        changed(app);
        return true;
      }
      if (e.key === "Enter" && ready(st.target) && ready(st.source)) {
        void runSwap(app);
        return true;
      }
      return false;
    },
  };
}

// ------------------------------------------------------------------ options bar

type Part = { node: HTMLElement; sync(): void };

export function faceSwapOptionParts(app: App): Part[] {
  const st = faceSwapState();
  const save = () => storage.saveSoon("faceSwap", () => st.settings);

  const slot = (k: Slot): Part => {
    const thumb = el("span", { class: "fs-thumb" });
    const title = el("span", { class: "fs-title", text: `${k === "target" ? "1" : "2"}. ${LABELS[k]}` });
    const sub = el("span", { class: "fs-sub" });
    const b = el("button", { type: "button", class: `fs-slot fs-${k}`, title: `Click, then brush over the ${k === "target" ? "face to replace" : "face to use"}` }, thumb, el("span", { class: "fs-text" }, title, sub));
    b.style.setProperty("--fsc", COLORS[k]);
    b.addEventListener("click", () => {
      st.next = k;
      changed(app);
    });
    return {
      node: b,
      sync: () => {
        prune(app);
        const m = st[k];
        b.classList.toggle("next", st.next === k);
        b.classList.toggle("ok", ready(m));
        thumb.textContent = "";
        if (m?.thumb) thumb.append(m.thumb);
        else thumb.textContent = k === "target" ? "1" : "2";
        sub.textContent = !m
          ? st.next === k
            ? "Brush over it now"
            : k === "source"
              ? "Any open image"
              : "Not marked"
          : m.status === "found"
            ? m.session === app.active
              ? "This image"
              : m.session.doc.name
            : m.status === "finding"
              ? "Finding..."
              : "No face found";
      },
    };
  };

  const flip = el("button", { type: "button", class: "btn small fs-flip", title: "Swap the roles of the two faces", text: "⇄" });
  flip.addEventListener("click", () => {
    [st.target, st.source] = [st.source, st.target];
    changed(app);
  });

  const range = (label: string, key: "lighting" | "softness", title: string): Part => {
    const r = el("input", { type: "range", min: 0, max: 100, value: Math.round(st.settings[key] * 100), "aria-label": label, title });
    r.addEventListener("input", () => {
      st.settings[key] = +r.value / 100;
      save();
    });
    return { node: el("label", { title }, label + ":", r), sync: () => (r.value = String(Math.round(st.settings[key] * 100))) };
  };
  const check = (label: string, key: "fillHidden" | "keepHair", title: string): Part => {
    const c = el("input", { type: "checkbox", checked: st.settings[key] });
    c.addEventListener("change", () => {
      st.settings[key] = c.checked;
      save();
    });
    return { node: el("label", { title }, c, label), sync: () => (c.checked = st.settings[key]) };
  };
  const swap = el("button", { type: "button", class: "btn default fs-swap", text: "Swap" });
  swap.addEventListener("click", () => void runSwap(app));
  const clear = el("button", { type: "button", class: "btn small", text: "Clear", title: "Forget both faces" });
  clear.addEventListener("click", () => {
    st.target = st.source = null;
    st.next = "target";
    st.message = "";
    changed(app);
  });
  const msg = el("span", { class: "note fs-msg" });

  const parts: Part[] = [
    slot("target"),
    { node: flip, sync: () => (flip.disabled = !st.target && !st.source) },
    slot("source"),
    {
      node: el("span", { class: "fs-actions" }, swap, clear),
      sync: () => {
        swap.disabled = !ready(st.target) || !ready(st.source) || st.busy;
        swap.textContent = st.busy ? "Swapping..." : "Swap";
        swap.title = st.busy ? "Swapping the faces..." : swap.disabled ? "Mark both faces first" : "Put the new face on the face to replace (Enter)";
      },
    },
    { node: el("span", { class: "sep" }), sync: () => {} },
    range("Match Lighting", "lighting", "How much of the original photo's light and skin tone the new face takes on"),
    range("Soft Edge", "softness", "How gradually the new face blends into the old one at its edge"),
    check("Fill Hidden Side", "fillHidden", "When the new face is turned away, fill the side the camera can't see from its other side"),
    check("Keep Hair & Glasses", "keepHair", "Keep the original's hair, glasses and anything in front of the face on top"),
    {
      node: msg,
      sync: () => {
        const n = st.target?.status === "none" ? st.target.note : st.source?.status === "none" ? st.source.note : st.message;
        msg.textContent = n;
      },
    },
  ];
  const sync = () => parts.forEach((p) => p.sync());
  listeners.clear();
  listeners.add(sync);
  return parts;
}
