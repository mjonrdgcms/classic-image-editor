/**
 * The 2D overlay above the GPU canvas: marching ants, selection and crop
 * previews, guides, the grid, and the brush cursor.
 */

import type { App, Session } from "../app";
import { outlineSegments } from "../core/selection";
import { fromUnits } from "../prefs";

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private phase = 0;
  private outline: { key: string; path: Path2D } | null = null;
  private queued = false;
  private drew = false;

  private canvas: HTMLCanvasElement;

  constructor(
    private app: App,
    private s: Session,
  ) {
    this.canvas = s.win.overlay;
    this.ctx = this.canvas.getContext("2d")!;
    // Note whether a frame drew anything: a frame that only clears hides the
    // canvas, because some Chromium GPU canvases kept presenting the old
    // contents (stale marching ants after Deselect) when nothing new was drawn.
    const ctx = this.ctx as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of ["stroke", "fill", "fillRect", "strokeRect", "fillText", "strokeText", "drawImage", "putImageData"]) {
      const orig = ctx[k].bind(this.ctx);
      ctx[k] = (...a: unknown[]) => {
        this.drew = true;
        return orig(...a);
      };
    }
    s.compositor.frameListeners.add(() => this.draw());
    app.on("overlay", () => this.queue());
    app.on("view", () => this.queue());
    // March the ants.
    setInterval(() => {
      if (!this.s.win.root.isConnected) return;
      const d = this.s.doc;
      const active = app.active === s;
      if ((d.selection && !d.quickMask) || (active && (app.preview.rect || app.preview.lasso || app.preview.crop))) {
        this.phase = (this.phase + 1) % 8;
        this.draw();
      }
    }, 120);
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  private selectionPath(): Path2D | null {
    const sel = this.s.doc.selection;
    if (!sel) return null;
    const key = sel.key() + (sel.rectHint ? JSON.stringify(sel.rectHint) : "");
    if (this.outline?.key !== key) {
      const segs = outlineSegments(sel);
      const p = new Path2D();
      for (let i = 0; i < segs.length; i += 4) {
        p.moveTo(segs[i], segs[i + 1]);
        p.lineTo(segs[i + 2], segs[i + 3]);
      }
      this.outline = { key, path: p };
    }
    return this.outline.path;
  }

  /** Stroke a canvas-space path as marching ants. */
  private ants(path: Path2D, dx = 0, dy = 0): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const v = this.s.compositor.view;
    ctx.save();
    ctx.setTransform(v.zoom * dpr, 0, 0, v.zoom * dpr, (v.x + dx * v.zoom) * dpr, (v.y + dy * v.zoom) * dpr);
    ctx.lineWidth = 1 / v.zoom;
    ctx.setLineDash([]);
    ctx.strokeStyle = "#fff";
    ctx.stroke(path);
    ctx.setLineDash([4 / v.zoom, 4 / v.zoom]);
    ctx.lineDashOffset = -this.phase / v.zoom;
    ctx.strokeStyle = "#000";
    ctx.stroke(path);
    ctx.restore();
  }

  draw(): void {
    this.drew = false;
    try {
      this.paint();
    } finally {
      const vis = this.drew ? "" : "hidden";
      if (this.canvas.style.visibility !== vis) this.canvas.style.visibility = vis;
    }
  }

  private paint(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const app = this.app;
    const doc = this.s.doc;
    const active = app.active === this.s;
    const v = this.s.compositor.view;
    const toScreen = (x: number, y: number) => ({ x: x * v.zoom + v.x, y: y * v.zoom + v.y });
    const toCanvas = (x: number, y: number) => ({ x: (x - v.x) / v.zoom, y: (y - v.y) / v.zoom });
    const extras = app.view.extras;
    const cw = c.clientWidth, ch = c.clientHeight;
    const docA = toScreen(0, 0), docB = toScreen(doc.width, doc.height);

    // Pixel grid, when zoomed in far enough to see single pixels (Preferences > Display).
    if (app.prefs.pixelGrid && v.zoom >= 6) {
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor(toCanvas(0, 0).x)), x1 = Math.min(doc.width, Math.ceil(toCanvas(cw, 0).x));
      const y0 = Math.max(0, Math.floor(toCanvas(0, 0).y)), y1 = Math.min(doc.height, Math.ceil(toCanvas(0, ch).y));
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(toScreen(x, 0).x) + 0.5;
        ctx.moveTo(sx, Math.max(0, docA.y));
        ctx.lineTo(sx, Math.min(ch, docB.y));
      }
      for (let y = y0; y <= y1; y++) {
        const sy = Math.round(toScreen(0, y).y) + 0.5;
        ctx.moveTo(Math.max(0, docA.x), sy);
        ctx.lineTo(Math.min(cw, docB.x), sy);
      }
      ctx.strokeStyle = "rgba(128,128,128,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Grid (spacing in Preferences > Guides, Grid & Slices units; percent is of the image's size).
    if (extras && app.view.grid) {
      const P = app.prefs;
      const spX = Math.max(0.5, fromUnits(P.gridSpacing, P.gridUnits, doc.resolution, P.pointsPerInch, doc.width));
      const spY = Math.max(0.5, fromUnits(P.gridSpacing, P.gridUnits, doc.resolution, P.pointsPerInch, doc.height));
      const sub = Math.max(1, P.gridSubdivisions);
      if ((spX / sub) * v.zoom >= 5 || Math.min(spX, spY) * v.zoom >= 8) {
        const fine = (spX / sub) * v.zoom >= 5;
        const style = P.gridStyle;
        const lines = (major: boolean) => {
          ctx.beginPath();
          const sx_ = major ? spX : spX / sub, sy_ = major ? spY : spY / sub;
          const isMajor = (v: number, sp: number) => Math.abs(v / sp - Math.round(v / sp)) < 1e-6;
          const i0 = Math.max(0, Math.floor(toCanvas(0, 0).x / sx_));
          const x1 = Math.min(doc.width, toCanvas(cw, 0).x);
          const xs: number[] = [];
          for (let i = i0; i * sx_ <= x1 + 1e-6; i++) if (major || !isMajor(i * sx_, spX)) xs.push(i * sx_);
          const j0 = Math.max(0, Math.floor(toCanvas(0, 0).y / sy_));
          const y1 = Math.min(doc.height, toCanvas(0, ch).y);
          const ys: number[] = [];
          for (let j = j0; j * sy_ <= y1 + 1e-6; j++) if (major || !isMajor(j * sy_, spY)) ys.push(j * sy_);
          if (style === "dots") {
            // Dots where lines cross.
            ctx.fillStyle = P.gridColor;
            ctx.globalAlpha = major ? 0.95 : 0.5;
            const allX = major ? xs : [...xs];
            for (const x of allX)
              for (const y of ys) {
                const p = toScreen(x, y);
                ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
              }
            ctx.globalAlpha = 1;
            return;
          }
          for (const x of xs) {
            const sx = Math.round(toScreen(x, 0).x) + 0.5;
            ctx.moveTo(sx, Math.max(0, docA.y));
            ctx.lineTo(sx, Math.min(ch, docB.y));
          }
          for (const y of ys) {
            const sy = Math.round(toScreen(0, y).y) + 0.5;
            ctx.moveTo(Math.max(0, docA.x), sy);
            ctx.lineTo(Math.min(cw, docB.x), sy);
          }
          ctx.strokeStyle = P.gridColor;
          ctx.globalAlpha = major ? 0.9 : 0.45;
          ctx.setLineDash(style === "dashed" ? [4, 3] : major ? [] : [2, 2]);
          ctx.lineWidth = 1;
          ctx.stroke();
        };
        if (fine) lines(false);
        lines(true);
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
      }
    }

    // Guides.
    if (extras && app.view.guides && (doc.guides.h.length || doc.guides.v.length)) {
      ctx.strokeStyle = app.prefs.guideColor;
      ctx.lineWidth = 1;
      ctx.setLineDash(app.prefs.guideStyle === "dashed" ? [5, 4] : []);
      ctx.beginPath();
      for (const y of doc.guides.h) {
        const sy = Math.round(toScreen(0, y).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(cw, sy);
      }
      for (const x of doc.guides.v) {
        const sx = Math.round(toScreen(x, 0).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, ch);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const g = active ? app.preview.guide : null;
    if (g) {
      ctx.strokeStyle = app.prefs.guideColor;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (g.orientation === "horizontal") {
        const sy = Math.round(toScreen(0, g.position).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(cw, sy);
      } else {
        const sx = Math.round(toScreen(g.position, 0).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, ch);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Selection outline (hidden in Quick Mask, where the red overlay shows it).
    if (doc.selection && !doc.quickMask && extras && app.view.selectionEdges) {
      const p = this.selectionPath();
      if (p) this.ants(p, active ? (app.selectionOffset?.dx ?? 0) : 0, active ? (app.selectionOffset?.dy ?? 0) : 0);
    }
    for (const p of app.overlayPainters) {
      ctx.save();
      p(ctx, this.s, v);
      ctx.restore();
    }

    // Previews, crop box and the brush cursor only belong to the active window.
    if (!active) return;

    // Marquee being dragged.
    const r = app.preview.rect;
    if (r) {
      const p = new Path2D();
      if (r.shape === "ellipse") p.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, r.w / 2), Math.max(0.1, r.h / 2), 0, 0, Math.PI * 2);
      else p.rect(r.x, r.y, r.w, r.h);
      this.ants(p);
    }

    // Lasso in progress.
    const lp = app.preview.lasso;
    if (lp && lp.length) {
      const p = new Path2D();
      p.moveTo(lp[0][0], lp[0][1]);
      for (const [x, y] of lp) p.lineTo(x, y);
      const cur = app.preview.lassoCursor;
      if (cur) p.lineTo(cur[0], cur[1]);
      this.ants(p);
    }

    // Crop box with shield and handles.
    const cr = app.preview.crop;
    if (cr) {
      const a = toScreen(cr.x, cr.y), b = toScreen(cr.x + cr.w, cr.y + cr.h);
      if (app.settings.cropShield) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.beginPath();
        ctx.rect(docA.x, docA.y, docB.x - docA.x, docB.y - docA.y);
        ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
        ctx.fill("evenodd");
      }
      const p = new Path2D();
      p.rect(cr.x, cr.y, cr.w, cr.h);
      this.ants(p);
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#000";
      for (const [hx, hy] of [
        [a.x, a.y], [(a.x + b.x) / 2, a.y], [b.x, a.y], [b.x, (a.y + b.y) / 2],
        [b.x, b.y], [(a.x + b.x) / 2, b.y], [a.x, b.y], [a.x, (a.y + b.y) / 2],
      ]) {
        ctx.fillRect(Math.round(hx) - 3, Math.round(hy) - 3, 7, 7);
        ctx.strokeRect(Math.round(hx) - 2.5, Math.round(hy) - 2.5, 6, 6);
      }
    }

    // Gradient line being dragged.
    const gl = app.preview.gradient;
    if (gl) {
      const a = toScreen(gl[0], gl[1]), b = toScreen(gl[2], gl[3]);
      ctx.save();
      ctx.lineCap = "round";
      for (const [w, c] of [[3, "rgba(0,0,0,0.75)"], [1, "#fff"]] as const) {
        ctx.lineWidth = w;
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (const p of [a, b]) {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Brush outline cursor.
    const brush = app.activeBrush;
    if (brush && app.pointer) {
      if (app.paintingCursor === "brushSize" && app.pointer) {
        const p = toScreen(app.pointer.x, app.pointer.y);
        const eraserBlock = app.tool.id === "eraser" && app.settings.eraserMode === "block";
        const size = eraserBlock ? 16 : brush.size;
        const rad = Math.max(1, (size / 2) * v.zoom);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((-brush.angle * Math.PI) / 180);
        const draw = () => {
          ctx.beginPath();
          if (eraserBlock || brush.sampled) {
            const sw = brush.sampled && !eraserBlock ? (brush.sampled.w / Math.max(brush.sampled.w, brush.sampled.h)) * rad : rad;
            const sh = (brush.sampled && !eraserBlock ? (brush.sampled.h / Math.max(brush.sampled.w, brush.sampled.h)) * rad : rad) * (brush.roundness / 100);
            ctx.rect(-sw, -sh, sw * 2, sh * 2);
          } else ctx.ellipse(0, 0, rad, Math.max(0.5, rad * (brush.roundness / 100)), 0, 0, Math.PI * 2);
        };
        ctx.lineWidth = 1;
        draw();
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.stroke();
        ctx.scale((rad + 1) / rad, (rad + 1) / rad);
        draw();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.stroke();
        ctx.restore();
        if (rad < 4 || app.prefs.brushCrosshair) {
          ctx.beginPath();
          ctx.moveTo(p.x - 5, p.y);
          ctx.lineTo(p.x + 5, p.y);
          ctx.moveTo(p.x, p.y - 5);
          ctx.lineTo(p.x, p.y + 5);
          ctx.strokeStyle = "#000";
          ctx.stroke();
        }
      }
    }
  }
}
