/**
 * Rulers along the top and left of the document window (pixels). Drag out
 * of a ruler to create a guide: the top ruler makes horizontal guides, the
 * left ruler vertical ones.
 */

import type { App, Session } from "../app";

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];

export function mountRulers(app: App, s: Session): void {
  const grid = s.win.grid, top = s.win.rulerTop, left = s.win.rulerLeft;
  const css = getComputedStyle(document.documentElement);
  const v = () => s.compositor.view;
  const toCanvas = (x: number, y: number) => ({ x: (x - v().x) / v().zoom, y: (y - v().y) / v().zoom });
  const toScreen = (x: number, y: number) => ({ x: x * v().zoom + v().x, y: y * v().zoom + v().y });
  const draw = () => {
    if (!s.win.root.isConnected) return;
    const show = app.view.rulers && app.screenMode !== "full";
    grid.classList.toggle("with-rulers", show);
    if (!show) return;
    const dpr = window.devicePixelRatio || 1;
    const fg = css.getPropertyValue("--text-dim").trim() || "#888";
    const bgc = css.getPropertyValue("--bg").trim() || "#ddd";
    const line = css.getPropertyValue("--divider").trim() || fg;
    const mark = css.getPropertyValue("--accent").trim() || "#d00";
    for (const [cv, horiz] of [
      [top, true],
      [left, false],
    ] as const) {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) continue;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = bgc;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = fg;
      ctx.fillStyle = fg;
      ctx.lineWidth = 1;
      ctx.font = '500 9px "IBM Plex Sans", system-ui, sans-serif';
      const zoom = v().zoom;
      const major = STEPS.find((s) => s * zoom >= 50) ?? STEPS[STEPS.length - 1];
      const minor = major / (major % 10 === 0 ? 10 : major % 5 === 0 ? 5 : 2);
      const len = horiz ? w : h;
      const c0 = horiz ? toCanvas(0, 0).x : toCanvas(0, 0).y;
      const c1 = horiz ? toCanvas(len, 0).x : toCanvas(0, len).y;
      ctx.beginPath();
      for (let v = Math.floor(c0 / minor) * minor; v <= c1; v += minor) {
        const s = Math.round(horiz ? toScreen(v, 0).x : toScreen(0, v).y) + 0.5;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const tick = isMajor ? 16 : Math.abs((v * 2) / major - Math.round((v * 2) / major)) < 1e-6 ? 7 : 4;
        if (horiz) {
          ctx.moveTo(s, h);
          ctx.lineTo(s, h - tick);
          if (isMajor) ctx.fillText(String(Math.round(v)), s + 2, 9);
        } else {
          ctx.moveTo(w, s);
          ctx.lineTo(w - tick, s);
          if (isMajor) {
            ctx.save();
            ctx.translate(9, s + 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(String(Math.round(v)), -ctx.measureText(String(Math.round(v))).width - 2, 0);
            ctx.restore();
          }
        }
      }
      ctx.stroke();
      ctx.strokeStyle = line;
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(0, h - 0.5);
        ctx.lineTo(w, h - 0.5);
      } else {
        ctx.moveTo(w - 0.5, 0);
        ctx.lineTo(w - 0.5, h);
      }
      ctx.stroke();
      // Pointer position marker.
      if (app.pointer && app.active === s) {
        const p = toScreen(app.pointer.x, app.pointer.y);
        ctx.strokeStyle = mark;
        ctx.beginPath();
        if (horiz) {
          ctx.moveTo(Math.round(p.x) + 0.5, 0);
          ctx.lineTo(Math.round(p.x) + 0.5, h);
        } else {
          ctx.moveTo(0, Math.round(p.y) + 0.5);
          ctx.lineTo(w, Math.round(p.y) + 0.5);
        }
        ctx.stroke();
      }
    }
  };
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  };
  for (const t of ["view", "pointer", "doc", "theme", "screen"] as const) app.on(t, queue);
  new ResizeObserver(queue).observe(grid);

  // Drag a guide out of a ruler.
  const startGuide = (orientation: "horizontal" | "vertical") => (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (app.active !== s) app.activate(s);
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const vp = s.win.viewport.getBoundingClientRect();
    const update = (ev: PointerEvent) => {
      const c = toCanvas(ev.clientX - vp.left, ev.clientY - vp.top);
      const s = app.snap(c.x, c.y);
      app.preview.guide = { orientation, position: Math.round(orientation === "horizontal" ? s.y : s.x) };
      app.emit("overlay");
    };
    const target = e.currentTarget as HTMLElement;
    const move = (ev: PointerEvent) => update(ev);
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      const g = app.preview.guide;
      app.preview.guide = null;
      app.emit("overlay");
      const inside = ev.clientX >= vp.left && ev.clientX <= vp.right && ev.clientY >= vp.top && ev.clientY <= vp.bottom;
      if (g && inside) app.run("guide.add", g);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    update(e);
  };
  top.addEventListener("pointerdown", startGuide("horizontal"));
  left.addEventListener("pointerdown", startGuide("vertical"));
  draw();
}
