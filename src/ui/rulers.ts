/**
 * Rulers along the top and left of the document window, in the units chosen
 * in Preferences (right-click a ruler to change them). Drag out
 * of a ruler to create a guide: the top ruler makes horizontal guides, the
 * left ruler vertical ones.
 */

import type { App, Session } from "../app";
import { UNIT_LABELS, pxPerUnit, type Units } from "../prefs";
import { showPopupMenu } from "./menus";

/** Major tick spacings, in ruler units. */
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000];

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
      // Preferences > Units & Rulers: one unit is k image pixels.
      const P = app.prefs;
      const k = pxPerUnit(P.rulerUnits, s.doc.resolution, P.pointsPerInch, horiz ? s.doc.width : s.doc.height);
      const major = STEPS.find((st) => st * k * zoom >= 50) ?? STEPS[STEPS.length - 1];
      const n = major >= 1 ? major : Math.round(major * 100);
      const minor = major / (n % 10 === 0 ? 10 : n % 5 === 0 ? 5 : 2);
      const label = (u: number) => String(Math.round(u * 100) / 100);
      const len = horiz ? w : h;
      const c0 = (horiz ? toCanvas(0, 0).x : toCanvas(0, 0).y) / k;
      const c1 = (horiz ? toCanvas(len, 0).x : toCanvas(0, len).y) / k;
      ctx.beginPath();
      for (let i = Math.floor(c0 / minor); i * minor <= c1; i++) {
        const u = i * minor;
        const s = Math.round(horiz ? toScreen(u * k, 0).x : toScreen(0, u * k).y) + 0.5;
        const isMajor = Math.abs(u / major - Math.round(u / major)) < 1e-6;
        const tick = isMajor ? 16 : Math.abs((u * 2) / major - Math.round((u * 2) / major)) < 1e-6 ? 7 : 4;
        if (horiz) {
          ctx.moveTo(s, h);
          ctx.lineTo(s, h - tick);
          if (isMajor) ctx.fillText(label(u), s + 2, 9);
        } else {
          ctx.moveTo(w, s);
          ctx.lineTo(w - tick, s);
          if (isMajor) {
            ctx.save();
            ctx.translate(9, s + 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label(u), -ctx.measureText(label(u)).width - 2, 0);
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
  for (const t of ["view", "pointer", "doc", "theme", "screen", "prefs"] as const) app.on(t, queue);
  // Right-click a ruler to change units (as in Photoshop).
  for (const r of [top, left])
    r.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showPopupMenu(
        (Object.keys(UNIT_LABELS) as Units[]).map((u) => ({ label: UNIT_LABELS[u][0].toUpperCase() + UNIT_LABELS[u].slice(1), checked: app.prefs.rulerUnits === u, run: () => app.setPrefs({ rulerUnits: u }) })),
        e.clientX,
        e.clientY,
      );
    });
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
