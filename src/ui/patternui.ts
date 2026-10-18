/** Edit > Define Pattern, and pattern swatches for pickers. */

import type { App } from "../app";
import { MAX_PATTERN, type NamedPattern } from "../core/patterns";
import { alertDialog, el, formDialog } from "./dialogs";

/** A small canvas showing a pattern tiled. */
export function patternThumb(p: NamedPattern, size: number): HTMLCanvasElement {
  const c = el("canvas", { width: size, height: size, class: "pattern-thumb" });
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const img = ctx.createImageData(size, size);
  // Scale big patterns down so a thumbnail shows more than one corner.
  const k = Math.max(1, Math.max(p.w, p.h) / (size * 1.5));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.floor(x * k) % p.w, sy = Math.floor(y * k) % p.h;
      img.data.set(p.data.subarray((sy * p.w + sx) * 4, (sy * p.w + sx) * 4 + 4), (y * size + x) * 4);
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function definePatternDialog(app: App): Promise<void> {
  const doc = app.doc;
  if (!doc) return;
  const b = doc.selection?.bounds() ?? { x: 0, y: 0, w: doc.width, h: doc.height };
  if (b.w > MAX_PATTERN || b.h > MAX_PATTERN)
    return alertDialog("Define Pattern", `The pattern can be at most ${MAX_PATTERN} x ${MAX_PATTERN} pixels. Select a smaller area with the Rectangular Marquee.`);
  const r = await formDialog("Pattern Name", [{ key: "name", label: "Name", type: "text", value: `Pattern ${app.patterns.length + 1}` }]);
  if (!r) return;
  // What you see, inside the selection's bounding box.
  const data = new Uint8ClampedArray(doc.composite(b));
  app.patterns.push({ name: String(r.name || `Pattern ${app.patterns.length + 1}`), w: b.w, h: b.h, data });
  app.settings.patternIndex = app.patterns.length - 1;
  app.savePatterns();
  app.emit("settings");
  app.status(`Pattern "${r.name}" defined (${b.w} x ${b.h}).`);
}
