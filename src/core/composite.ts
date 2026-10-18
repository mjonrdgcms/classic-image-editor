/**
 * CPU reference compositing: layer masks, clipping groups and layer sets
 * (Pass Through or isolated with their own blend mode).
 *
 * The GPU compositor follows exactly the same steps, including where values
 * are rounded to 8 bits (assembled layer sources and set buffers), so the
 * e2e suite can compare them pixel for pixel.
 */

import { compositePixel } from "./blend";
import type { Document, Group, Layer, Node } from "./document";
import type { Rect } from "./tiles";
import { layerEffects, type FxLayer } from "./styles";

/**
 * A layer's pixels in a canvas region with its mask (and its Pass Through
 * set's mask, `gm`, in canvas space) applied; alpha rounded to 8 bits once.
 */
export function layerSource(l: Pick<Layer, "grid" | "offsetX" | "offsetY" | "activeMask">, r: Rect, gm?: Uint8Array | null): Uint8ClampedArray {
  const lr = { x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h };
  const px = l.grid.readRegion(lr);
  const m = l.activeMask;
  const mv = m ? m.readRegion(lr, m.defaultValue) : null;
  if (mv && gm) {
    for (let i = 0, p = 3; i < mv.length; i++, p += 4) if (px[p]) px[p] = Math.round((px[p] * mv[i] * gm[i]) / 65025);
  } else if (mv || gm) {
    const k = (mv ?? gm)!;
    for (let i = 0, p = 3; i < k.length; i++, p += 4) if (px[p]) px[p] = Math.round((px[p] * k[i]) / 255);
  }
  return px;
}

/** A set's active mask over a canvas region, or null. */
function groupMaskRegion(g: Group, r: Rect): Uint8Array | null {
  const m = g.activeMask;
  return m ? m.readRegion(r, m.defaultValue) : null;
}

/** Composite a list of sibling layers (one container) onto `target`. */
function drawLayers(list: Layer[], target: Uint8ClampedArray, r: Rect, gm: Uint8Array | null = null): void {
  // Alpha of the current clipping base (null when the base is hidden).
  let base: Uint8ClampedArray | null = null;
  let hasBase = false;
  for (const l of list) {
    const clipped = l.clipped && hasBase;
    if (!clipped) {
      hasBase = true;
      base = null;
    }
    if (!l.visible || l.opacity <= 0) {
      if (!clipped) base = null;
      continue;
    }
    if (clipped && !base) continue;
    const fx = l.style ? layerEffects(l) : null;
    const clipFor = () => (clipped ? base : null);
    if (fx) for (const f of fx.below) blendSource(layerSource(f, r, gm), target, r, f.blendMode, f.opacity * l.opacity, clipFor());
    const src = layerSource(l, r, gm);
    if (!clipped) base = src;
    blendSource(src, target, r, l.blendMode, l.opacity, clipped ? base : null);
    if (fx) for (const f of fx.above) blendSource(layerSource(f, r, gm), target, r, f.blendMode, f.opacity * l.opacity, clipFor());
    if (!clipped && !l.visible) base = null;
  }
}

/** Blend a source over the target with a mode and opacity (optionally clipped to a base's alpha). */
function blendSource(src: Uint8ClampedArray, target: Uint8ClampedArray, r: Rect, mode: Layer["blendMode"], opacity: number, clipA: Uint8ClampedArray | null): void {
  const tmp = [0, 0, 0, 0];
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const o = (y * r.w + x) * 4;
      let a = src[o + 3];
      if (!a) continue;
      if (clipA) {
        a = (a * clipA[o + 3]) / 255;
        if (!a) continue;
      }
      tmp[0] = src[o];
      tmp[1] = src[o + 1];
      tmp[2] = src[o + 2];
      tmp[3] = a;
      const p = compositePixel(mode, target.subarray(o, o + 4), tmp, opacity, r.x + x, r.y + y);
      target[o] = p[0];
      target[o + 1] = p[1];
      target[o + 2] = p[2];
      target[o + 3] = p[3];
    }
}

export type { FxLayer };

function drawGroup(g: Group, out: Uint8ClampedArray, r: Rect): void {
  if (!g.visible || g.opacity <= 0) return;
  const gm = groupMaskRegion(g, r);
  if (g.blendMode === "passThrough") {
    // Pass Through: the set's opacity and mask fade its combined effect
    // (mix between the backdrop before and after its layers), like Isolated.
    const saved = g.opacity < 1 || gm ? out.slice() : null;
    drawLayers(g.children, out, r);
    if (saved) {
      for (let o = 0; o < out.length; o += 4) {
        const t = gm ? (g.opacity * gm[o >> 2]) / 255 : g.opacity;
        const sa = saved[o + 3] / 255, oa = out[o + 3] / 255;
        const a = sa * (1 - t) + oa * t;
        if (a <= 0) {
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
          continue;
        }
        for (let c = 0; c < 3; c++) out[o + c] = (saved[o + c] * sa * (1 - t) + out[o + c] * oa * t) / a;
        out[o + 3] = a * 255;
      }
    }
    return;
  }
  const buf = new Uint8ClampedArray(out.length);
  drawLayers(g.children, buf, r);
  // Isolated set: the mask applies to the set's flattened result.
  if (gm) for (let i = 0, p = 3; i < gm.length; i++, p += 4) if (buf[p]) buf[p] = Math.round((buf[p] * gm[i]) / 255);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const o = (y * r.w + x) * 4;
      if (!buf[o + 3]) continue;
      const p = compositePixel(g.blendMode, out.subarray(o, o + 4), buf.subarray(o, o + 4), g.opacity, r.x + x, r.y + y);
      out[o] = p[0];
      out[o + 1] = p[1];
      out[o + 2] = p[2];
      out[o + 3] = p[3];
    }
}

/** Composite nodes (a whole stack, or one set's contents) over transparency. */
export function compositeNodes(nodes: Node[], r: Rect): Uint8ClampedArray {
  const out = new Uint8ClampedArray(r.w * r.h * 4);
  // Consecutive top-level layers form one container for clipping purposes.
  let run: Layer[] = [];
  const flush = () => {
    if (run.length) drawLayers(run, out, r);
    run = [];
  };
  for (const n of nodes) {
    if (n.kind === "layer") run.push(n);
    else {
      flush();
      drawGroup(n, out, r);
    }
  }
  flush();
  return out;
}

export function compositeRegion(doc: Document, r: Rect): Uint8ClampedArray {
  return compositeNodes(doc.stack, r);
}
