/**
 * The Face-Aware Liquify part of the Liquify dialog: finds faces, shows
 * their outlines, and turns the per-face sliders (and drags on the face
 * with the Face tool) into a displacement field added to the brush mesh.
 */

import type { App } from "../app";
import { FACE_SLIDERS, faceField, faceGeometry, isNeutral, type FaceAdjust, type FaceGeo, type FaceGroup } from "../ai/faceaware";
import { detectFaces } from "../ai/vision";
import { el } from "./dialogs";
import { ensureModels, FACE_MODELS } from "./aimodels";
import { cachedPeople, findPeople } from "./peopleui";

interface FaceEntry {
  geo: FaceGeo;
  adj: FaceAdjust;
}

/** Which slider a drag on each part of the face drives (vertical drag; up = more). */
const DRAG_TARGETS: { at: (g: FaceGeo) => [number, number]; r: (g: FaceGeo) => number; slider: string; label: string; horizontal?: boolean; sign?: (g: FaceGeo, x: number) => number }[] = [
  { at: (g) => g.eyeL.c, r: (g) => g.eyeL.w * 0.75, slider: "eyeSizeL", label: "Eye Size" },
  { at: (g) => g.eyeR.c, r: (g) => g.eyeR.w * 0.75, slider: "eyeSizeR", label: "Eye Size" },
  { at: (g) => g.mouthL, r: (g) => g.F * 0.13, slider: "smile", label: "Smile" },
  { at: (g) => g.mouthR, r: (g) => g.F * 0.13, slider: "smile", label: "Smile" },
  { at: (g) => g.upperLip, r: (g) => g.F * 0.1, slider: "upperLip", label: "Upper Lip" },
  { at: (g) => g.lowerLip, r: (g) => g.F * 0.1, slider: "lowerLip", label: "Lower Lip" },
  { at: (g) => g.mouth, r: (g) => g.F * 0.2, slider: "mouthWidth", label: "Mouth Width", horizontal: true },
  { at: (g) => g.noseTip, r: (g) => g.F * 0.18, slider: "noseHeight", label: "Nose Height" },
  { at: (g) => g.chin, r: (g) => g.F * 0.2, slider: "chinHeight", label: "Chin Height", sign: () => -1 },
  { at: (g) => g.forehead, r: (g) => g.F * 0.3, slider: "forehead", label: "Forehead" },
  { at: (g) => g.jawL, r: (g) => g.F * 0.22, slider: "jawline", label: "Jawline", horizontal: true, sign: () => -1 },
  { at: (g) => g.jawR, r: (g) => g.F * 0.22, slider: "jawline", label: "Jawline", horizontal: true },
  { at: (g) => g.cheekL, r: (g) => g.F * 0.22, slider: "faceWidth", label: "Face Width", horizontal: true, sign: () => -1 },
  { at: (g) => g.cheekR, r: (g) => g.F * 0.22, slider: "faceWidth", label: "Face Width", horizontal: true },
];

export class FacePanel {
  private faces: FaceEntry[] = [];
  private current = 0;
  private linkEyes = true;
  private detected = false;
  private busy = false;
  private disposed = false;
  private cache: { dx: Float32Array; dy: Float32Array } | null = null;
  private hot: { face: number; target: number } | null = null;
  private drag: { face: number; target: number; x: number; y: number; start: number } | null = null;
  private root = el("details", { class: "lq-sec lq-face", open: true });
  private status = el("div", { class: "lq-face-status" });

  constructor(
    private app: App,
    private src: Uint8ClampedArray,
    private fw: number,
    private fh: number,
    private changed: () => void,
    /** Field pixels per document pixel, and the layer's position. */
    private map: { scale: number; ox: number; oy: number } = { scale: 1, ox: 0, oy: 0 },
  ) {}

  /** True when any face has been adjusted. */
  get active(): boolean {
    return this.faces.some((f) => !isNeutral(f.adj));
  }

  field(): { dx: Float32Array; dy: Float32Array } {
    return (this.cache ??= faceField(this.faces, this.fw, this.fh));
  }

  private touched(): void {
    this.cache = null;
    this.changed();
  }

  async detect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status.textContent = "Looking for faces...";
    try {
      if (!(await ensureModels(this.app, FACE_MODELS, "Face-Aware Liquify"))) {
        this.status.textContent = "Face-Aware Liquify needs the AI models.";
        return;
      }
      const img = { w: this.fw, h: this.fh, data: this.src };
      const doc = this.app.doc;
      let found = await detectFaces(img);
      if (this.disposed) return;
      if (!found.length && doc && this.app.doc === doc) {
        // Small faces: look again around the heads that people detection finds.
        this.status.textContent = "Looking for small faces...";
        const e = cachedPeople(doc) ?? (await findPeople(this.app, doc));
        if (this.disposed) return;
        const k = e.w / e.map.w;
        const heads = e.map.people.flatMap((p) => (p.head ? [p.head] : [])).map((b) => ({ x: (b.x * k - this.map.ox) * this.map.scale, y: (b.y * k - this.map.oy) * this.map.scale, w: b.w * k * this.map.scale, h: b.h * k * this.map.scale }));
        found = await detectFaces(img, heads);
        if (this.disposed) return;
      }
      this.faces = found.map((f) => ({ geo: faceGeometry(f.pts), adj: {} }));
      this.detected = true;
      this.current = 0;
      this.status.textContent = this.faces.length ? "" : "No faces were found in this layer.";
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.status.textContent = `Could not look for faces: ${(e as Error).message}`;
    } finally {
      this.busy = false;
      if (!this.disposed) {
        this.render();
        this.changed();
      }
    }
  }

  setToolActive(on: boolean): void {
    if (on && !this.detected && !this.busy) void this.detect();
  }

  section(): HTMLElement {
    this.render();
    return this.root;
  }

  private value(f: FaceEntry, id: string): number {
    return f.adj[id] ?? 0;
  }

  private set(f: FaceEntry, id: string, v: number): void {
    v = Math.max(-100, Math.min(100, Math.round(v)));
    const base = id.replace(/[LR]$/, "");
    const slider = FACE_SLIDERS.find((s) => s.id === base);
    if (slider?.perEye && this.linkEyes) {
      f.adj[base + "L"] = v;
      f.adj[base + "R"] = v;
    } else f.adj[id] = v;
    this.touched();
  }

  private render(): void {
    const r = this.root;
    r.textContent = "";
    r.append(el("summary", { text: "Face-Aware Liquify" }));
    if (!this.detected) {
      const b = el("button", { type: "button", class: "btn small", text: this.busy ? "Looking..." : "Find Faces" });
      b.disabled = this.busy;
      b.addEventListener("click", () => void this.detect());
      r.append(el("p", { class: "lq-hint", text: "Reshape eyes, nose, mouth and face with sliders, or drag them with the Face tool (A)." }), b, this.status);
      return;
    }
    if (!this.faces.length) {
      const b = el("button", { type: "button", class: "btn small", text: "Look Again" });
      b.addEventListener("click", () => void this.detect());
      r.append(this.status, b);
      return;
    }
    const sel = el("select", { "aria-label": "Select Face" });
    this.faces.forEach((_, i) => sel.append(el("option", { value: i, text: `Face #${i + 1}` })));
    sel.value = String(this.current);
    sel.addEventListener("change", () => {
      this.current = +sel.value;
      this.render();
      this.changed();
    });
    const reset = el("button", { type: "button", class: "btn small", text: "Reset" });
    reset.addEventListener("click", () => {
      this.faces[this.current].adj = {};
      this.touched();
      this.render();
    });
    const all = el("button", { type: "button", class: "btn small", text: "Reset All" });
    all.addEventListener("click", () => {
      for (const f of this.faces) f.adj = {};
      this.touched();
      this.render();
    });
    r.append(el("div", { class: "lq-row" }, el("label", { text: "Select Face" }), sel), el("div", { class: "lq-btns" }, reset, all));
    const f = this.faces[this.current];
    const groups: FaceGroup[] = ["Eyes", "Nose", "Mouth", "Face Shape"];
    for (const g of groups) {
      const box = el("div", { class: "lq-face-group" }, el("h4", { text: g }));
      if (g === "Eyes") {
        const link = el("input", { type: "checkbox", checked: this.linkEyes });
        link.addEventListener("change", () => {
          this.linkEyes = link.checked;
          this.render();
        });
        box.append(el("label", { class: "lq-check" }, link, "Link left and right eyes"));
      }
      for (const s of FACE_SLIDERS.filter((x) => x.group === g)) {
        if (s.perEye && !this.linkEyes) {
          box.append(this.slider(f, s.id + "L", `${s.label} (Left)`), this.slider(f, s.id + "R", `${s.label} (Right)`));
        } else box.append(this.slider(f, s.perEye ? s.id + "L" : s.id, s.label));
      }
      r.append(box);
    }
  }

  private slider(f: FaceEntry, id: string, label: string): HTMLElement {
    const rng = el("input", { type: "range", min: -100, max: 100, value: this.value(f, id), "aria-label": label });
    const num = el("input", { type: "number", min: -100, max: 100, value: this.value(f, id), "aria-label": label + " value" });
    rng.addEventListener("input", () => {
      this.set(f, id, +rng.value);
      num.value = rng.value;
    });
    num.addEventListener("change", () => {
      this.set(f, id, +num.value);
      rng.value = num.value;
    });
    rng.addEventListener("dblclick", () => {
      this.set(f, id, 0);
      rng.value = num.value = "0";
    });
    return el("div", { class: "lq-row" }, el("label", { text: label }), rng, num);
  }

  // ---------- on-canvas face tool

  private hit(x: number, y: number): { face: number; target: number } | null {
    let best: { face: number; target: number; d: number } | null = null;
    this.faces.forEach((f, fi) => {
      DRAG_TARGETS.forEach((t, ti) => {
        const [ax, ay] = t.at(f.geo);
        const d = Math.hypot(x - ax, y - ay) / t.r(f.geo);
        if (d < 1 && (!best || d < best.d)) best = { face: fi, target: ti, d };
      });
    });
    return best ? { face: (best as { face: number }).face, target: (best as { target: number }).target } : null;
  }

  hover(x: number, y: number, stage: HTMLElement): void {
    this.hot = this.hit(x, y);
    stage.title = this.hot ? `${DRAG_TARGETS[this.hot.target].label}: drag to change` : "";
    stage.style.cursor = this.hot ? (DRAG_TARGETS[this.hot.target].horizontal ? "ew-resize" : "ns-resize") : "default";
  }

  pointerDown(x: number, y: number, _e: PointerEvent): void {
    const h = this.hit(x, y);
    if (!h) {
      // Clicking inside another face picks it.
      const fi = this.faces.findIndex((f) => inside(f.geo.outline, x, y));
      if (fi >= 0 && fi !== this.current) {
        this.current = fi;
        this.render();
        this.changed();
      }
      return;
    }
    if (h.face !== this.current) {
      this.current = h.face;
      this.render();
    }
    const t = DRAG_TARGETS[h.target];
    this.drag = { ...h, x, y, start: this.value(this.faces[h.face], t.slider) };
  }

  pointerMove(x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    const f = this.faces[d.face];
    const t = DRAG_TARGETS[d.target];
    const g = f.geo;
    // Distance along the face's own axes, in units of a tenth of the eye distance.
    const ox = x - d.x, oy = y - d.y;
    const along = t.horizontal ? ox * g.right[0] + oy * g.right[1] : ox * g.up[0] + oy * g.up[1];
    const sign = t.sign ? t.sign(g, x) : 1;
    this.set(f, t.slider, d.start + ((sign * along) / (g.F * 0.25)) * 100);
  }

  pointerUp(): void {
    if (this.drag) this.render();
    this.drag = null;
  }

  drawOverlay(ctx: CanvasRenderingContext2D, view: { zoom: number; x: number; y: number }, toolOn: boolean): void {
    if (!toolOn || !this.faces.length) return;
    const S = (p: [number, number]): [number, number] => [view.x + p[0] * view.zoom, view.y + p[1] * view.zoom];
    this.faces.forEach((f, i) => {
      const cur = i === this.current;
      ctx.lineWidth = cur ? 1.5 : 1;
      ctx.strokeStyle = cur ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.45)";
      ctx.setLineDash(cur ? [] : [4, 3]);
      ctx.beginPath();
      f.geo.outline.forEach((p, k) => {
        const [sx, sy] = S(p);
        if (k) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      if (!cur) return;
      DRAG_TARGETS.forEach((t, ti) => {
        const [sx, sy] = S(t.at(f.geo));
        const hot = this.hot?.face === i && this.hot.target === ti;
        ctx.beginPath();
        ctx.arc(sx, sy, hot ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = hot ? "#ffd84a" : "rgba(255,255,255,0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.stroke();
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.faces = [];
    this.cache = null;
  }
}

function inside(poly: [number, number][], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
