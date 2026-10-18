/**
 * Brush previews: a dab thumbnail and a sample stroke, rendered with the
 * real stroke engine so they match what painting produces.
 */

import { Stroke } from "../core/brush";
import type { BrushPreset } from "../core/brushes";
import { Document } from "../core/document";

const cache = new Map<string, HTMLCanvasElement>();

function keyOf(b: BrushPreset, w: number, h: number, kind: string): string {
  return JSON.stringify([kind, w, h, b.size, b.hardness, b.spacing, b.angle, b.roundness, b.shape, b.scatter, b.other, b.noise, b.sampled ? b.sampled.w + "x" + b.sampled.h + ":" + b.sampled.data.length + ":" + b.sampled.data[(b.sampled.data.length / 2) | 0] : 0]);
}

function render(b: BrushPreset, w: number, h: number, points: [number, number, number][], scale: number): HTMLCanvasElement {
  const doc = new Document(w, h);
  const layer = doc.addLayer("p", 0);
  const brush: BrushPreset = { ...b, size: Math.max(1, b.size * scale), color: null };
  const s = new Stroke(doc, { kind: "pixels", layer }, { tool: "brush", brush, opacity: 1, flow: 1, mode: "normal", fg: [0, 0, 0, 255], bg: [255, 255, 255, 255], seed: 7 });
  for (const [x, y, p] of points) s.addPoint(x, y, p);
  s.end();
  const px = layer.grid.readRegion({ x: 0, y: 0, w, h });
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  // Draw as dark ink on transparent, so it works on any palette background.
  for (let i = 0; i < px.length; i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0;
    img.data[i + 3] = px[i + 3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** A single dab, scaled to fit the box. */
export function dabThumb(b: BrushPreset, w = 32, h = 32): HTMLCanvasElement {
  const k = keyOf(b, w, h, "dab");
  let c = cache.get(k);
  if (!c) {
    const scale = Math.min(1, (Math.min(w, h) - 4) / Math.max(1, b.size * (b.sampled ? 1.2 : 1)));
    c = render({ ...b, scatter: null, shape: b.shape ? { ...b.shape, sizeJitter: 0, angleJitter: 0, roundnessJitter: 0 } : null }, w, h, [[w / 2, h / 2, 1]], scale);
    cache.set(k, c);
  }
  return clone(c);
}

/** An S-curve sample stroke, with pressure tapering, like the Brushes palette preview. */
export function strokeThumb(b: BrushPreset, w = 200, h = 50): HTMLCanvasElement {
  const k = keyOf(b, w, h, "stroke");
  let c = cache.get(k);
  if (!c) {
    const pts: [number, number, number][] = [];
    const pad = Math.min(20, w * 0.1);
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push([pad + t * (w - 2 * pad), h / 2 + Math.sin(t * Math.PI * 2) * h * 0.22, Math.sin(t * Math.PI)]);
    }
    const scale = Math.min(1, (h * 0.5) / Math.max(1, b.size));
    c = render(b, w, h, pts, scale);
    cache.set(k, c);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return clone(c);
}

function clone(c: HTMLCanvasElement): HTMLCanvasElement {
  const d = document.createElement("canvas");
  d.width = c.width;
  d.height = c.height;
  d.getContext("2d")!.drawImage(c, 0, 0);
  return d;
}
