/**
 * More toolbox tools: Patch (J), Magnetic Lasso (L), Color Sampler and
 * Measure (I), Notes (N), Slice and Slice Select (K).
 */

import type { App } from "../app";
import type { Document, Note, Slice } from "../core/document";
import type { Rect } from "../core/tiles";
import { el } from "../ui/dialogs";
import type { Tool, ToolEvent } from "./tools";

type Part = { node: HTMLElement; sync(): void };

const CROSSHAIR = "crosshair";

// ------------------------------------------------------------------ shared state for the options bar

/** The Measure tool's line, per document. */
const measures = new WeakMap<Document, [number, number, number, number]>();
const measureListeners = new Set<() => void>();
/** The selected slice (Slice Select tool), per document. */
const selectedSlice = new WeakMap<Document, number>();

export function measureOf(doc: Document | null | undefined): [number, number, number, number] | null {
  return (doc && measures.get(doc)) ?? null;
}

/** Angle (degrees, counter-clockwise positive) and length of a line. */
export function lineStats(m: [number, number, number, number]): { angle: number; length: number; w: number; h: number } {
  const w = m[2] - m[0], h = m[3] - m[1];
  return { angle: (Math.atan2(-h, w) * 180) / Math.PI, length: Math.hypot(w, h), w, h };
}

/** The rotation (clockwise degrees) that makes a measured line level, or plumb if it's closer to vertical. */
export function straightenAngle(m: [number, number, number, number]): number {
  let a = lineStats(m).angle;
  if (a > 90) a -= 180;
  if (a < -90) a += 180;
  if (Math.abs(a) > 45) a -= Math.sign(a) * 90;
  return a;
}

// ------------------------------------------------------------------ magnetic lasso: live-wire edge snapping

class EdgeMap {
  readonly w: number;
  readonly h: number;
  /** Cost of passing through each pixel: low along strong edges. */
  readonly cost: Float32Array;

  constructor(px: Uint8ClampedArray, w: number, h: number) {
    this.w = w;
    this.h = h;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) * (px[i * 4 + 3] / 255);
    const g = new Float32Array(w * h);
    let max = 1;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
        const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
        const v = Math.hypot(gx, gy);
        g[i] = v;
        if (v > max) max = v;
      }
    // Normalize against a strong edge (not the very strongest) so ordinary edges still attract.
    const sorted = Float32Array.from(g).sort();
    const ref = Math.max(8, sorted[Math.floor(sorted.length * 0.995)] || max);
    this.cost = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) this.cost[i] = 0.03 + Math.max(0, 1 - g[i] / ref);
  }

  /** Cheapest 8-connected path from a to b, searching only a band around them. */
  path(ax: number, ay: number, bx: number, by: number, band: number): [number, number][] {
    const W = this.w, H = this.h;
    ax = Math.max(0, Math.min(W - 1, Math.round(ax)));
    ay = Math.max(0, Math.min(H - 1, Math.round(ay)));
    bx = Math.max(0, Math.min(W - 1, Math.round(bx)));
    by = Math.max(0, Math.min(H - 1, Math.round(by)));
    const x0 = Math.max(0, Math.min(ax, bx) - band), y0 = Math.max(0, Math.min(ay, by) - band);
    const x1 = Math.min(W - 1, Math.max(ax, bx) + band), y1 = Math.min(H - 1, Math.max(ay, by) + band);
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw * bh > 400_000) return [[ax, ay], [bx, by]];
    const dist = new Float32Array(bw * bh).fill(Infinity);
    const prev = new Int32Array(bw * bh).fill(-1);
    const done = new Uint8Array(bw * bh);
    // Binary heap of [cost, index].
    const hc: number[] = [], hi: number[] = [];
    const push = (c: number, i: number) => {
      let k = hc.length;
      hc.push(c);
      hi.push(i);
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (hc[p] <= c) break;
        hc[k] = hc[p];
        hi[k] = hi[p];
        k = p;
      }
      hc[k] = c;
      hi[k] = i;
    };
    const pop = (): number => {
      const top = hi[0];
      const lc = hc.pop()!, li = hi.pop()!;
      if (hc.length) {
        let k = 0;
        for (;;) {
          let c = 2 * k + 1;
          if (c >= hc.length) break;
          if (c + 1 < hc.length && hc[c + 1] < hc[c]) c++;
          if (hc[c] >= lc) break;
          hc[k] = hc[c];
          hi[k] = hi[c];
          k = c;
        }
        hc[k] = lc;
        hi[k] = li;
      }
      return top;
    };
    const start = (ay - y0) * bw + (ax - x0), goal = (by - y0) * bw + (bx - x0);
    dist[start] = 0;
    push(0, start);
    while (hc.length) {
      const i = pop();
      if (done[i]) continue;
      done[i] = 1;
      if (i === goal) break;
      const x = i % bw, y = (i / bw) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const j = ny * bw + nx;
          if (done[j]) continue;
          const c = dist[i] + this.cost[(ny + y0) * W + nx + x0] * (dx && dy ? 1.414 : 1);
          if (c < dist[j]) {
            dist[j] = c;
            prev[j] = i;
            push(c, j);
          }
        }
    }
    const out: [number, number][] = [];
    for (let i = goal; i >= 0; i = prev[i]) {
      out.push([(i % bw) + x0 + 0.5, ((i / bw) | 0) + y0 + 0.5]);
      if (i === start) break;
    }
    return out.reverse();
  }
}

export function makeMoreTools(app: App): Record<"patch" | "magneticLasso" | "colorSampler" | "measure" | "notes" | "slice" | "sliceSelect", Tool> {
  const view = () => app.compositor.view;

  // ---------------- overlays ----------------
  app.overlayPainters.add((ctx, s, v) => {
    const doc = s.doc;
    const toS = (x: number, y: number): [number, number] => [x * v.zoom + v.x, y * v.zoom + v.y];
    const extras = app.view.extras;
    // Slices: always visible while a slice tool is active, otherwise with Extras.
    const sliceTool = app.tool.id === "slice" || app.tool.id === "sliceSelect";
    if (doc.slices.length && (extras || sliceTool)) {
      const sel = selectedSlice.get(doc);
      ctx.font = "600 11px system-ui, sans-serif";
      doc.slices.forEach((sl, i) => {
        const [x, y] = toS(sl.x, sl.y);
        const w = sl.w * v.zoom, h = sl.h * v.zoom;
        // Preferences > Guides, Grid & Slices: line color and numbers.
        const c = sl.id === sel ? "#ffb000" : app.prefs.sliceColor;
        ctx.lineWidth = sl.id === sel ? 2 : 1;
        ctx.strokeStyle = c;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
        if (app.prefs.showSliceNumbers || sl.id === sel) {
          const label = String(i + 1).padStart(2, "0");
          ctx.fillStyle = c;
          ctx.fillRect(Math.round(x) + 1, Math.round(y) + 1, 22, 15);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, Math.round(x) + 5, Math.round(y) + 12);
        }
      });
    }
    // Notes.
    if (doc.notes.length && extras) {
      for (const n of doc.notes) {
        const [x, y] = toS(n.x, n.y);
        ctx.fillStyle = n.color;
        ctx.strokeStyle = "rgba(0,0,0,.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 14, y);
        ctx.lineTo(x + 18, y + 4);
        ctx.lineTo(x + 18, y + 16);
        ctx.lineTo(x, y + 16);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        for (const ly of [5, 9, 13]) {
          ctx.moveTo(x + 3, y + ly + 0.5);
          ctx.lineTo(x + 14, y + ly + 0.5);
        }
        ctx.strokeStyle = "rgba(0,0,0,.35)";
        ctx.stroke();
      }
    }
    // Color samplers.
    if (doc.samplers.length && (extras || app.tool.id === "colorSampler")) {
      ctx.font = "600 10px system-ui, sans-serif";
      doc.samplers.forEach((p, i) => {
        const [x, y] = toS(p.x + 0.5, p.y + 0.5);
        for (const [c, w] of [
          ["rgba(0,0,0,.8)", 3],
          ["#fff", 1],
        ] as const) {
          ctx.strokeStyle = c;
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.moveTo(x - 9, y);
          ctx.lineTo(x - 3, y);
          ctx.moveTo(x + 3, y);
          ctx.lineTo(x + 9, y);
          ctx.moveTo(x, y - 9);
          ctx.lineTo(x, y - 3);
          ctx.moveTo(x, y + 3);
          ctx.lineTo(x, y + 9);
          ctx.stroke();
        }
        ctx.fillStyle = "#000";
        ctx.fillText(String(i + 1), x + 7, y + 13);
        ctx.fillStyle = "#fff";
        ctx.fillText(String(i + 1), x + 6, y + 12);
      });
    }
    // Measure line.
    const m = measures.get(doc);
    if (m && app.tool.id === "measure") {
      const a = toS(m[0], m[1]), b = toS(m[2], m[3]);
      for (const [c, w] of [
        ["rgba(0,0,0,.8)", 3],
        ["#fff", 1],
      ] as const) {
        ctx.strokeStyle = c;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        for (const p of [a, b]) {
          ctx.moveTo(p[0] - 5, p[1]);
          ctx.lineTo(p[0] + 5, p[1]);
          ctx.moveTo(p[0], p[1] - 5);
          ctx.lineTo(p[0], p[1] + 5);
        }
        ctx.stroke();
      }
    }
    // Patch: the selection outline being dragged.
    if (patchDrag && s === app.active) {
      const sel = doc.selection?.bounds();
      if (sel) {
        const [x, y] = toS(sel.x + patchDrag.dx, sel.y + patchDrag.dy);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(sel.w * v.zoom), Math.round(sel.h * v.zoom));
        ctx.setLineDash([]);
      }
    }
  });

  // ---------------- Patch ----------------
  let patchDrag: { sx: number; sy: number; dx: number; dy: number } | null = null;
  let patchLasso = false;
  const patch: Tool = {
    id: "patch",
    label: "Patch Tool",
    shortcut: "J",
    icon: "patch",
    cursor: CROSSHAIR,
    hint: "Draw around the area to fix, then drag it onto a clean area (Source); or switch to Destination and drag a clean area over the flaw.",
    down(e) {
      const doc = app.doc!;
      const inside = doc.selection && !doc.quickMask && doc.selection.get(Math.floor(e.x), Math.floor(e.y)) >= 128;
      if (inside && !e.shift && !e.alt) {
        patchDrag = { sx: e.x, sy: e.y, dx: 0, dy: 0 };
        return;
      }
      patchLasso = true;
      app.preview.lasso = [[e.x, e.y]];
    },
    move(e) {
      if (patchDrag) {
        patchDrag.dx = Math.round(e.x - patchDrag.sx);
        patchDrag.dy = Math.round(e.y - patchDrag.sy);
        app.emit("overlay");
        return;
      }
      const pts = app.preview.lasso;
      if (!pts) return;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(e.x - lx, e.y - ly) * view().zoom >= 1.5) pts.push([e.x, e.y]);
    },
    up(e) {
      if (patchDrag) {
        const d = patchDrag;
        patchDrag = null;
        app.emit("overlay");
        if (d.dx || d.dy) app.run("edit.patch", { dx: d.dx, dy: d.dy, mode: app.settings.patchMode });
        return;
      }
      if (!patchLasso) return;
      patchLasso = false;
      const pts = app.preview.lasso;
      app.preview.lasso = undefined;
      if (!pts || pts.length < 3) return;
      app.run("select.polygon", {
        points: pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        tool: "lasso",
        mode: e.shift && e.alt ? "intersect" : e.shift ? "add" : e.alt ? "subtract" : "replace",
      });
    },
  };

  // ---------------- Magnetic Lasso ----------------
  let mag: { edges: EdgeMap; fixed: [number, number][]; anchors: number[]; live: [number, number][]; mode: string } | null = null;
  const magBand = () => Math.max(2, app.settings.magneticWidth);
  const magSpacing = () => 10 + (100 - app.settings.magneticFrequency) * 0.9;
  const magShow = () => {
    if (!mag) return;
    app.preview.lasso = [...mag.fixed, ...mag.live.slice(1)];
    app.emit("overlay");
  };
  const magClose = () => {
    if (!mag) return;
    const m = mag;
    mag = null;
    const last = m.fixed[m.fixed.length - 1], first = m.fixed[0];
    const back = m.edges.path(last[0], last[1], first[0], first[1], magBand());
    const pts = [...m.fixed, ...back.slice(1)];
    app.preview.lasso = undefined;
    app.emit("overlay");
    if (pts.length < 3) return;
    // Thin the path: every pixel step isn't needed in the command.
    const thin: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) if (i % 2 === 0 || i === pts.length - 1) thin.push([Math.round(pts[i][0] * 10) / 10, Math.round(pts[i][1] * 10) / 10]);
    app.run("select.polygon", { points: thin, tool: "magneticLasso", mode: m.mode, feather: app.settings.lassoFeather, antiAlias: app.settings.lassoAntiAlias });
  };
  const magCancel = () => {
    mag = null;
    app.preview.lasso = undefined;
    app.emit("overlay");
  };
  const magTrack = (e: ToolEvent) => {
    if (!mag) return;
    const a = mag.fixed[mag.fixed.length - 1];
    mag.live = mag.edges.path(a[0], a[1], e.x, e.y, magBand());
    // Drop anchors automatically as the path grows.
    const spacing = magSpacing();
    let len = 0;
    for (let i = 1; i < mag.live.length; i++) {
      len += Math.hypot(mag.live[i][0] - mag.live[i - 1][0], mag.live[i][1] - mag.live[i - 1][1]);
      if (len >= spacing && i < mag.live.length - 3) {
        mag.fixed.push(...mag.live.slice(1, i + 1));
        mag.anchors.push(mag.fixed.length - 1);
        const b = mag.fixed[mag.fixed.length - 1];
        mag.live = mag.edges.path(b[0], b[1], e.x, e.y, magBand());
        len = 0;
        i = 0;
      }
    }
    magShow();
  };
  const magneticLasso: Tool = {
    id: "magneticLasso",
    label: "Magnetic Lasso Tool",
    shortcut: "L",
    icon: "magneticLasso",
    cursor: CROSSHAIR,
    hint: "Click on an edge, then move along it: the outline snaps to the edge. Click to add a point, double-click or Enter to close, Backspace removes a point, Esc cancels.",
    down(e) {
      const doc = app.doc!;
      if (!mag) {
        const W = doc.width, H = doc.height;
        mag = {
          edges: new EdgeMap(new Uint8ClampedArray(app.compositor.readPixels({ x: 0, y: 0, w: W, h: H })), W, H),
          fixed: [[e.x, e.y]],
          anchors: [0],
          live: [[e.x, e.y]],
          mode: e.shift && e.alt ? "intersect" : e.shift ? "add" : e.alt ? "subtract" : app.settings.selectMode,
        };
        magShow();
        return;
      }
      // Closing: a double-click, or a click back on the start.
      const first = mag.fixed[0];
      if (e.detail > 1 || (mag.fixed.length > 2 && Math.hypot(e.x - first[0], e.y - first[1]) * view().zoom < 8)) return magClose();
      magTrack(e);
      mag.fixed.push(...mag.live.slice(1));
      mag.anchors.push(mag.fixed.length - 1);
      mag.live = [mag.fixed[mag.fixed.length - 1]];
      magShow();
    },
    move: magTrack,
    hover: magTrack,
    up() {},
    dblclick() {
      if (mag) magClose();
    },
    onKey(ev) {
      if (!mag) return false;
      if (ev.key === "Enter") {
        magClose();
        return true;
      }
      if (ev.key === "Escape") {
        magCancel();
        return true;
      }
      if (ev.key === "Backspace" || ev.key === "Delete") {
        if (mag.anchors.length <= 1) magCancel();
        else {
          mag.anchors.pop();
          mag.fixed.length = mag.anchors[mag.anchors.length - 1] + 1;
          mag.live = [mag.fixed[mag.fixed.length - 1]];
          magShow();
        }
        return true;
      }
      return false;
    },
    deactivate: magCancel,
  };

  // ---------------- Color Sampler ----------------
  let samplerDrag: number | null = null;
  const samplerAt = (doc: Document, e: ToolEvent) => doc.samplers.findIndex((p) => Math.hypot(p.x + 0.5 - e.x, p.y + 0.5 - e.y) * view().zoom < 8);
  const colorSampler: Tool = {
    id: "colorSampler",
    label: "Color Sampler Tool",
    shortcut: "I",
    icon: "colorSampler",
    cursor: CROSSHAIR,
    hint: "Click to place up to four color samplers (read them in the Info palette). Drag one to move it, Alt-click to delete it.",
    down(e) {
      const doc = app.doc!;
      const i = samplerAt(doc, e);
      if (i >= 0 && e.alt) {
        doc.samplers.splice(i, 1);
      } else if (i >= 0) samplerDrag = i;
      else if (doc.samplers.length < 4 && e.x >= 0 && e.y >= 0 && e.x < doc.width && e.y < doc.height) {
        doc.samplers.push({ x: Math.floor(e.x), y: Math.floor(e.y) });
        samplerDrag = doc.samplers.length - 1;
      } else if (doc.samplers.length >= 4) app.toast("There can be four color samplers; Alt-click one to delete it.");
      app.emit("overlay");
      app.emit("doc");
    },
    move(e) {
      const doc = app.doc!;
      if (samplerDrag === null) return;
      doc.samplers[samplerDrag] = { x: Math.max(0, Math.min(doc.width - 1, Math.floor(e.x))), y: Math.max(0, Math.min(doc.height - 1, Math.floor(e.y))) };
      app.emit("overlay");
      app.emit("doc");
    },
    up() {
      samplerDrag = null;
    },
  };

  // ---------------- Measure ----------------
  let measureDrag: { end: 0 | 1 | null } | null = null;
  const measureChanged = () => {
    for (const f of measureListeners) f();
    app.emit("overlay");
  };
  const measure: Tool = {
    id: "measure",
    label: "Measure Tool",
    shortcut: "I",
    icon: "measure",
    cursor: CROSSHAIR,
    hint: "Drag to measure a distance and angle (Shift: 45° steps). Drag an end to adjust it. Straighten turns the image so the line is level.",
    down(e) {
      const doc = app.doc!;
      const m = measures.get(doc);
      const near = (x: number, y: number) => Math.hypot(e.x - x, e.y - y) * view().zoom < 7;
      if (m && near(m[2], m[3])) measureDrag = { end: 1 };
      else if (m && near(m[0], m[1])) measureDrag = { end: 0 };
      else {
        measures.set(doc, [e.x, e.y, e.x, e.y]);
        measureDrag = { end: 1 };
      }
      measureChanged();
    },
    move(e) {
      const doc = app.doc!;
      const m = measures.get(doc);
      if (!m || !measureDrag || measureDrag.end === null) return;
      const [ax, ay] = measureDrag.end === 1 ? [m[0], m[1]] : [m[2], m[3]];
      let x = e.x, y = e.y;
      if (e.shift) {
        const a = Math.round(Math.atan2(y - ay, x - ax) / (Math.PI / 4)) * (Math.PI / 4), d = Math.hypot(x - ax, y - ay);
        x = ax + Math.cos(a) * d;
        y = ay + Math.sin(a) * d;
      }
      measures.set(doc, measureDrag.end === 1 ? [m[0], m[1], x, y] : [x, y, m[2], m[3]]);
      measureChanged();
    },
    up() {
      measureDrag = null;
    },
  };

  // ---------------- Notes ----------------
  let editor: HTMLElement | null = null;
  let noteDrag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null = null;
  const noteAt = (doc: Document, e: ToolEvent) => {
    const z = view().zoom;
    for (let i = doc.notes.length - 1; i >= 0; i--) {
      const n = doc.notes[i];
      if (e.x >= n.x && e.y >= n.y && (e.x - n.x) * z <= 18 && (e.y - n.y) * z <= 16) return n;
    }
    return null;
  };
  let saveEditor: (() => void) | null = null;
  /** Close the open note, keeping what was typed (unless discard). */
  const closeEditor = (discard = false) => {
    const s = saveEditor;
    saveEditor = null;
    editor?.remove();
    editor = null;
    if (s && !discard) s();
  };
  /** A new note (isNew) is only added once it has some text. */
  const openEditor = (n: Note, isNew = false) => {
    closeEditor();
    const doc = app.doc!;
    const v = view();
    const r = app.viewport.getBoundingClientRect();
    const text = el("textarea", { class: "note-text", rows: 6, "aria-label": "Note text" });
    text.value = n.text;
    const author = el("input", { type: "text", value: n.author, placeholder: "Author", "aria-label": "Author" });
    const color = el("input", { type: "color", value: n.color, "aria-label": "Note color" });
    const del = el("button", { type: "button", class: "btn small", text: "Delete" });
    const done = el("button", { type: "button", class: "btn small default", text: "Close" });
    const box = el("div", { class: "note-editor", style: `background:${n.color}` }, el("div", { class: "note-head" }, author, color), text, el("div", { class: "note-foot" }, del, done));
    box.style.left = `${Math.min(window.innerWidth - 240, r.left + n.x * v.zoom + v.x + 22)}px`;
    box.style.top = `${Math.min(window.innerHeight - 200, r.top + n.y * v.zoom + v.y)}px`;
    const save = () => {
      if (app.doc !== doc) return;
      if (author.value) app.settings.noteAuthor = author.value;
      if (isNew) {
        if (text.value.trim()) app.run("note.add", { x: n.x, y: n.y, text: text.value, author: author.value, color: color.value });
        return;
      }
      const cur = doc.notes.find((x) => x.id === n.id);
      if (!cur) return;
      const patch: Record<string, unknown> = {};
      if (text.value !== cur.text) patch.text = text.value;
      if (author.value !== cur.author) patch.author = author.value;
      if (color.value !== cur.color) patch.color = color.value;
      if (Object.keys(patch).length && app.doc === doc) app.run("note.update", { id: n.id, ...patch });
      if (author.value) app.settings.noteAuthor = author.value;
    };
    color.addEventListener("input", () => (box.style.background = color.value));
    done.addEventListener("click", () => closeEditor());
    del.addEventListener("click", () => {
      closeEditor(true);
      if (!isNew) app.run("note.remove", { id: n.id });
    });
    box.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") closeEditor();
    });
    document.body.append(box);
    editor = box;
    saveEditor = save;
    text.focus();
  };
  const notes: Tool = {
    id: "notes",
    label: "Notes Tool",
    shortcut: "N",
    icon: "notes",
    cursor: CROSSHAIR,
    hint: "Click to add a note; click a note to read or edit it, drag it to move it. Notes are saved with the image but never printed.",
    down(e) {
      const doc = app.doc!;
      if (!app.view.extras) app.toast("Notes are hidden while View > Extras is off.");
      const n = noteAt(doc, e);
      if (n) {
        noteDrag = { id: n.id, sx: e.x, sy: e.y, ox: n.x, oy: n.y, moved: false };
        return;
      }
      closeEditor();
      const x = Math.max(0, Math.min(doc.width - 1, Math.round(e.x))), y = Math.max(0, Math.min(doc.height - 1, Math.round(e.y)));
      openEditor({ id: 0, x, y, text: "", author: app.settings.noteAuthor, color: app.settings.noteColor }, true);
    },
    move(e) {
      const doc = app.doc!;
      if (!noteDrag) return;
      const n = doc.notes.find((x) => x.id === noteDrag!.id);
      if (!n) return;
      const dx = e.x - noteDrag.sx, dy = e.y - noteDrag.sy;
      if (Math.hypot(dx, dy) * view().zoom > 3) noteDrag.moved = true;
      if (!noteDrag.moved) return;
      // Live move (plain object swap; the command records it on release).
      n.x = Math.round(noteDrag.ox + dx);
      n.y = Math.round(noteDrag.oy + dy);
      app.emit("overlay");
    },
    up() {
      const doc = app.doc!;
      const d = noteDrag;
      noteDrag = null;
      if (!d) return;
      const n = doc.notes.find((x) => x.id === d.id);
      if (!n) return;
      if (d.moved) {
        const x = n.x, y = n.y;
        n.x = d.ox;
        n.y = d.oy;
        app.run("note.update", { id: d.id, x, y });
      } else openEditor(n);
    },
    deactivate: () => closeEditor(),
  };

  // ---------------- Slice / Slice Select ----------------
  let sliceDrag: { x0: number; y0: number } | null = null;
  const slice: Tool = {
    id: "slice",
    label: "Slice Tool",
    shortcut: "K",
    icon: "slice",
    cursor: CROSSHAIR,
    hint: "Drag to mark an area as a slice; File > Export > Slices saves each one as a PNG.",
    down(e) {
      sliceDrag = { x0: e.x, y0: e.y };
    },
    move(e) {
      if (!sliceDrag) return;
      app.preview.rect = { ...normRect(sliceDrag.x0, sliceDrag.y0, e.x, e.y), shape: "rect" };
      app.emit("overlay");
    },
    up(e) {
      if (!sliceDrag) return;
      const r = normRect(sliceDrag.x0, sliceDrag.y0, e.x, e.y);
      sliceDrag = null;
      app.preview.rect = undefined;
      app.emit("overlay");
      if (r.w >= 2 && r.h >= 2) app.run("slice.add", { ...r });
    },
  };
  let sliceEdit: { id: number; sx: number; sy: number; start: Slice; part: "move" | "e" | "s" | "se" } | null = null;
  const sliceAt = (doc: Document, e: ToolEvent): { s: Slice; part: "move" | "e" | "s" | "se" } | null => {
    const tol = 5 / view().zoom;
    for (let i = doc.slices.length - 1; i >= 0; i--) {
      const s = doc.slices[i];
      if (e.x < s.x - tol || e.y < s.y - tol || e.x > s.x + s.w + tol || e.y > s.y + s.h + tol) continue;
      const nearR = Math.abs(e.x - (s.x + s.w)) < tol, nearB = Math.abs(e.y - (s.y + s.h)) < tol;
      return { s, part: nearR && nearB ? "se" : nearR ? "e" : nearB ? "s" : "move" };
    }
    return null;
  };
  const sliceSelect: Tool = {
    id: "sliceSelect",
    label: "Slice Select Tool",
    shortcut: "K",
    icon: "sliceSelect",
    cursor: "default",
    hint: "Click a slice to select it; drag to move it or its right / bottom edge to resize. Delete removes it, double-click renames it.",
    hover(e) {
      const hit = app.doc && sliceAt(app.doc, e);
      app.viewport.style.cursor = !hit ? "default" : hit.part === "se" ? "nwse-resize" : hit.part === "e" ? "ew-resize" : hit.part === "s" ? "ns-resize" : "move";
    },
    down(e) {
      const doc = app.doc!;
      const hit = sliceAt(doc, e);
      if (!hit) {
        selectedSlice.delete(doc);
        app.emit("overlay");
        return;
      }
      selectedSlice.set(doc, hit.s.id);
      sliceEdit = { id: hit.s.id, sx: e.x, sy: e.y, start: { ...hit.s }, part: hit.part };
      app.emit("overlay");
    },
    move(e) {
      const doc = app.doc!;
      if (!sliceEdit) return;
      const s = doc.slices.find((x) => x.id === sliceEdit!.id);
      if (!s) return;
      const dx = Math.round(e.x - sliceEdit.sx), dy = Math.round(e.y - sliceEdit.sy), st = sliceEdit.start;
      if (sliceEdit.part === "move") {
        s.x = Math.max(0, Math.min(doc.width - st.w, st.x + dx));
        s.y = Math.max(0, Math.min(doc.height - st.h, st.y + dy));
      } else {
        if (sliceEdit.part !== "s") s.w = Math.max(1, Math.min(doc.width - st.x, st.w + dx));
        if (sliceEdit.part !== "e") s.h = Math.max(1, Math.min(doc.height - st.y, st.h + dy));
      }
      app.emit("overlay");
    },
    up() {
      const doc = app.doc!;
      const d = sliceEdit;
      sliceEdit = null;
      if (!d) return;
      const s = doc.slices.find((x) => x.id === d.id);
      if (!s) return;
      const now = { x: s.x, y: s.y, w: s.w, h: s.h };
      Object.assign(s, { x: d.start.x, y: d.start.y, w: d.start.w, h: d.start.h });
      if (now.x !== d.start.x || now.y !== d.start.y || now.w !== d.start.w || now.h !== d.start.h) app.run("slice.update", { id: d.id, ...now });
    },
    dblclick(e) {
      const doc = app.doc!;
      const hit = sliceAt(doc, e);
      if (!hit) return;
      void import("../ui/dialogs").then(async ({ formDialog }) => {
        const r = await formDialog("Slice Options", [{ key: "name", label: "Name", type: "text", value: hit.s.name }]);
        if (r?.name) app.run("slice.update", { id: hit.s.id, name: String(r.name) });
      });
    },
    onKey(ev) {
      const doc = app.doc;
      const id = doc && selectedSlice.get(doc);
      if (!doc || id === undefined || (ev.key !== "Delete" && ev.key !== "Backspace")) return false;
      selectedSlice.delete(doc);
      app.run("slice.remove", { id });
      return true;
    },
  };

  return { patch, magneticLasso, colorSampler, measure, notes, slice, sliceSelect };
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const x = Math.round(Math.min(x0, x1)), y = Math.round(Math.min(y0, y1));
  return { x, y, w: Math.round(Math.max(x0, x1)) - x, h: Math.round(Math.max(y0, y1)) - y };
}

/** Options bar for the Measure tool: the numbers, Straighten and Clear. */
export function measureOptionParts(app: App): Part[] {
  const out = el("span", { class: "measure-read" });
  const straighten = el("button", { type: "button", class: "btn small", text: "Straighten", title: "Rotate the image so the measured line is level (or plumb)" });
  const clear = el("button", { type: "button", class: "btn small", text: "Clear" });
  const sync = () => {
    const m = measureOf(app.doc);
    straighten.disabled = clear.disabled = !m;
    if (!m) {
      out.textContent = "Drag to measure.";
      return;
    }
    const st = lineStats(m);
    out.textContent = `X: ${m[0].toFixed(0)}  Y: ${m[1].toFixed(0)}   W: ${st.w.toFixed(1)}  H: ${(-st.h).toFixed(1)}   A: ${st.angle.toFixed(1)}°   L1: ${st.length.toFixed(1)} px`;
  };
  straighten.addEventListener("click", () => {
    const m = measureOf(app.doc);
    if (!m || !app.doc) return;
    const a = Math.round(straightenAngle(m) * 100) / 100;
    if (Math.abs(a) < 0.01) return app.toast("The line is already straight.");
    measures.delete(app.doc);
    if (app.run("image.rotate", { angle: a })) app.status(`Rotated ${a}°. Crop to remove the corners.`);
    sync();
    app.emit("overlay");
  });
  clear.addEventListener("click", () => {
    if (app.doc) measures.delete(app.doc);
    sync();
    app.emit("overlay");
  });
  measureListeners.clear();
  measureListeners.add(sync);
  return [
    { node: out, sync },
    { node: el("span", { class: "tf-btns" }, straighten, clear), sync: () => {} },
  ];
}

/** Values for the Info palette's color sampler rows. */
export function samplerValues(app: App): { i: number; rgb: [number, number, number] }[] {
  const doc = app.doc;
  if (!doc) return [];
  return doc.samplers.map((p, i) => {
    const px = app.compositor.readPixels({ x: p.x, y: p.y, w: 1, h: 1 });
    return { i, rgb: [px[0], px[1], px[2]] };
  });
}
