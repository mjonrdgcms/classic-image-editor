/**
 * Paint Bucket, Edit > Fill and Edit > Clear, honoring the selection's
 * soft edges, layer locks, and the layer-mask / Quick Mask edit targets.
 */

import type { Document, Layer, RGBA } from "./document";
import type { PaintTarget } from "./brush";
import { editArea, maskEditArea } from "./selection";
import type { Rect } from "./tiles";
import { Mask } from "./mask";
import { signedDistance } from "./edt";
import { patternRegion } from "./patterns";
import type { PatternImage } from "./retouch";
import { rectIntersect } from "./tiles";

const gray = (c: RGBA) => Math.round(0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]);

/** Blend a solid color over a layer region through a coverage mask (0..255, null = all). */
function paintThrough(layer: Layer, region: Rect, cov: Uint8Array | null, color: RGBA, opacity: number, preserve = false): void {
  const px = layer.grid.readRegion(region);
  const keepAlpha = layer.locks.transparency || preserve;
  for (let i = 0, p = 0; i < region.w * region.h; i++, p += 4) {
    const a = (color[3] / 255) * opacity * (cov ? cov[i] / 255 : 1);
    if (a <= 0) continue;
    const oA = px[p + 3] / 255;
    if (keepAlpha && oA === 0) continue;
    const outA = a + oA * (1 - a);
    px[p] = Math.round((color[0] * a + px[p] * oA * (1 - a)) / outA);
    px[p + 1] = Math.round((color[1] * a + px[p + 1] * oA * (1 - a)) / outA);
    px[p + 2] = Math.round((color[2] * a + px[p + 2] * oA * (1 - a)) / outA);
    px[p + 3] = keepAlpha ? px[p + 3] : layer.isBackground ? 255 : Math.round(outA * 255);
  }
  layer.grid.writeRegion(region, px);
}

/** Move mask values toward v through coverage. */
function fillMaskRegion(m: import("./mask").Mask, region: Rect, cov: Uint8Array | null, v: number, opacity: number): void {
  const d = m.readRegion(region, m.defaultValue);
  for (let i = 0; i < d.length; i++) {
    const a = opacity * (cov ? cov[i] / 255 : 1);
    if (a > 0) d[i] = Math.round(d[i] + (v - d[i]) * a);
  }
  m.writeRegion(region, d);
}

function canvasRect(l: Layer, r: Rect): Rect {
  return { x: r.x + l.offsetX, y: r.y + l.offsetY, w: r.w, h: r.h };
}

/** Edit > Fill. Returns the canvas rect changed. */
/** preserve: keep the layer's transparency (Shift+Alt+Backspace / Shift+Ctrl+Backspace). */
export function fillArea(doc: Document, target: PaintTarget, color: RGBA, opacity: number, preserve = false): Rect | null {
  if (target.kind === "selection") {
    // Quick Mask with nothing selected starts from an empty selection.
    const m = (doc.selection ??= new Mask(doc.width, doc.height, 0));
    fillMaskRegion(m, { x: 0, y: 0, w: m.width, h: m.height }, null, gray(color), opacity);
    doc.emit({ type: "selection" });
    return null;
  }
  if (target.kind === "mask") {
    const h = target.host;
    const ea = maskEditArea(doc, h);
    if (!ea) return null;
    fillMaskRegion(h.mask!, ea.area, ea.cov, gray(color), opacity);
    return { x: ea.area.x + h.offsetX, y: ea.area.y + h.offsetY, w: ea.area.w, h: ea.area.h };
  }
  const layer = target.layer;
  const ea = editArea(doc, layer);
  if (!ea) return null;
  paintThrough(layer, ea.area, ea.cov, color, opacity, preserve);
  return canvasRect(layer, ea.area);
}

/** Edit > Clear: transparency, or the background color on the Background layer / masks. */
export function clearArea(doc: Document, target: PaintTarget): Rect | null {
  if (target.kind !== "pixels" || target.layer.isBackground) return fillArea(doc, target, doc.background, 1);
  const layer = target.layer;
  const ea = editArea(doc, layer);
  if (!ea) return null;
  if (layer.locks.transparency) return null;
  const px = layer.grid.readRegion(ea.area);
  for (let i = 0, p = 3; i < ea.area.w * ea.area.h; i++, p += 4) px[p] = Math.round(px[p] * (1 - (ea.cov ? ea.cov[i] / 255 : 1)));
  layer.grid.writeRegion(ea.area, px);
  layer.grid.compact();
  return canvasRect(layer, ea.area);
}

export interface BucketOptions {
  tolerance: number; // 0..255, PS7 default 32
  contiguous: boolean;
  opacity: number; // 0..1
}

/**
 * Paint Bucket at a canvas point, matching pixels on the active layer whose
 * every channel is within `tolerance` of the clicked pixel.
 */
export function bucketFill(doc: Document, layer: Layer, cx: number, cy: number, color: RGBA, o: BucketOptions): Rect | null {
  const ea = editArea(doc, layer);
  if (!ea) return null;
  const area = ea.area;
  const sx = Math.floor(cx) - layer.offsetX;
  const sy = Math.floor(cy) - layer.offsetY;
  if (sx < area.x || sy < area.y || sx >= area.x + area.w || sy >= area.y + area.h) return null;
  const W = area.w;
  const H = area.h;
  const px = layer.grid.readRegion(area);
  const si = ((sy - area.y) * W + (sx - area.x)) * 4;
  const seed = [px[si], px[si + 1], px[si + 2], px[si + 3]];
  const tol = o.tolerance;
  const matches = (i: number) => {
    if (ea.cov && !ea.cov[i]) return false;
    const p = i * 4;
    if (seed[3] === 0 && px[p + 3] === 0) return true;
    return (
      Math.abs(px[p] - seed[0]) <= tol &&
      Math.abs(px[p + 1] - seed[1]) <= tol &&
      Math.abs(px[p + 2] - seed[2]) <= tol &&
      Math.abs(px[p + 3] - seed[3]) <= tol
    );
  };
  const mask = new Uint8Array(W * H);
  if (o.contiguous) {
    const stack: number[] = [sx - area.x, sy - area.y];
    while (stack.length) {
      const y = stack.pop()!;
      let x = stack.pop()!;
      while (x >= 0 && !mask[y * W + x] && matches(y * W + x)) x--;
      x++;
      let up = false, down = false;
      while (x < W && !mask[y * W + x] && matches(y * W + x)) {
        mask[y * W + x] = 255;
        if (y > 0) {
          const m = !mask[(y - 1) * W + x] && matches((y - 1) * W + x);
          if (m && !up) stack.push(x, y - 1);
          up = m;
        }
        if (y < H - 1) {
          const m = !mask[(y + 1) * W + x] && matches((y + 1) * W + x);
          if (m && !down) stack.push(x, y + 1);
          down = m;
        }
        x++;
      }
    }
  } else {
    for (let i = 0; i < W * H; i++) if (matches(i)) mask[i] = 255;
  }
  // Soft selection edges still apply inside the matched area.
  if (ea.cov) for (let i = 0; i < mask.length; i++) if (mask[i]) mask[i] = ea.cov[i];
  let any = false;
  for (let i = 0; i < mask.length && !any; i++) if (mask[i]) any = true;
  if (!any) return null;
  paintThrough(layer, area, mask, color, o.opacity);
  return canvasRect(layer, area);
}

export type StrokeLocation = "inside" | "center" | "outside";

/**
 * Edit > Stroke: a band `width` pixels wide along the selection's edge
 * (inside it, centered on it, or outside it), anti-aliased.
 */
export function strokeArea(doc: Document, target: PaintTarget, color: RGBA, opacity: number, width: number, location: StrokeLocation): Rect | null {
  const sel = doc.selection;
  const b = sel?.bounds();
  if (!sel || !b) return null;
  const pad = Math.ceil(width) + 2;
  // Beyond the canvas counts as unselected, so a selection touching the edge is stroked there too.
  const R = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  const sd = signedDistance(sel.readRegion(R), R.w, R.h);
  const [lo, hi] = location === "inside" ? [0, width] : location === "outside" ? [-width, 0] : [-width / 2, width / 2];
  const covAt = (i: number) => Math.max(0, Math.min(1, Math.min(sd[i] - lo, hi - sd[i]) + 0.5));
  const into = (ox: number, oy: number, w: number, h: number) => {
    const area = rectIntersect({ x: 0, y: 0, w, h }, { x: R.x - ox, y: R.y - oy, w: R.w, h: R.h });
    if (!area) return null;
    const cov = new Uint8Array(area.w * area.h);
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++) cov[y * area.w + x] = Math.round(covAt((y + area.y + oy - R.y) * R.w + (x + area.x + ox - R.x)) * 255);
    return { area, cov };
  };
  if (target.kind === "selection") return null;
  if (target.kind === "mask") {
    const h = target.host, m = h.mask!;
    const a = into(h.offsetX, h.offsetY, m.width, m.height);
    if (!a) return null;
    fillMaskRegion(m, a.area, a.cov, gray(color), opacity);
    return { x: a.area.x + h.offsetX, y: a.area.y + h.offsetY, w: a.area.w, h: a.area.h };
  }
  const l = target.layer;
  const a = into(l.offsetX, l.offsetY, l.grid.width, l.grid.height);
  if (!a) return null;
  paintThrough(l, a.area, a.cov, color, opacity);
  return canvasRect(l, a.area);
}

/** Edit > Fill with a pattern (tiled from the canvas origin). Masks and Quick Mask get its gray values. */
export function fillPatternArea(doc: Document, target: PaintTarget, pattern: PatternImage, opacity: number): Rect | null {
  if (target.kind === "selection" || target.kind === "mask") {
    const m = target.kind === "selection" ? (doc.selection ??= new Mask(doc.width, doc.height, 0)) : target.host.mask!;
    const ox = target.kind === "mask" ? target.host.offsetX : 0, oy = target.kind === "mask" ? target.host.offsetY : 0;
    const ea = target.kind === "mask" ? maskEditArea(doc, target.host) : { area: { x: 0, y: 0, w: m.width, h: m.height }, cov: null };
    if (!ea) return null;
    const pat = patternRegion(pattern, ea.area.x + ox, ea.area.y + oy, ea.area.w, ea.area.h);
    const d = m.readRegion(ea.area, m.defaultValue);
    for (let i = 0; i < d.length; i++) {
      const a = opacity * (ea.cov ? ea.cov[i] / 255 : 1) * (pat[i * 4 + 3] / 255);
      const g = 0.3 * pat[i * 4] + 0.59 * pat[i * 4 + 1] + 0.11 * pat[i * 4 + 2];
      if (a > 0) d[i] = Math.round(d[i] + (g - d[i]) * a);
    }
    m.writeRegion(ea.area, d);
    if (target.kind === "selection") {
      doc.emit({ type: "selection" });
      return null;
    }
    return { x: ea.area.x + ox, y: ea.area.y + oy, w: ea.area.w, h: ea.area.h };
  }
  const layer = target.layer;
  const ea = editArea(doc, layer);
  if (!ea) return null;
  const r = ea.area;
  const px = layer.grid.readRegion(r);
  const pat = patternRegion(pattern, r.x + layer.offsetX, r.y + layer.offsetY, r.w, r.h);
  const keepAlpha = layer.locks.transparency;
  for (let i = 0, p = 0; i < r.w * r.h; i++, p += 4) {
    const a = (pat[p + 3] / 255) * opacity * (ea.cov ? ea.cov[i] / 255 : 1);
    if (a <= 0) continue;
    const oA = px[p + 3] / 255;
    if (keepAlpha && oA === 0) continue;
    const outA = a + oA * (1 - a);
    for (let c = 0; c < 3; c++) px[p + c] = Math.round((pat[p + c] * a + px[p + c] * oA * (1 - a)) / outA);
    px[p + 3] = keepAlpha ? px[p + 3] : layer.isBackground ? 255 : Math.round(outA * 255);
  }
  layer.grid.writeRegion(r, px);
  return canvasRect(layer, r);
}
