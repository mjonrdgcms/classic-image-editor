/**
 * The result of a Face Swap as a new layer: the new face's pixels with a
 * layer mask that shows only the face, so its edge can be painted later.
 * The pixels are computed by the Face Swap tool (ai/faceswap.ts).
 */

import { b64, unb64 } from "../b64";
export { b64, unb64 };
import { CommandDef, ValidationError } from "../commands";
import { Mask } from "../mask";


/** Bilinear resize of interleaved byte data (ch channels). */
function resample(src: Uint8Array, w: number, h: number, nw: number, nh: number, ch: number): Uint8Array {
  const out = new Uint8Array(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const fy = Math.max(0, Math.min(h - 1, ((y + 0.5) * h) / nh - 0.5));
    const y0 = fy | 0, y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.max(0, Math.min(w - 1, ((x + 0.5) * w) / nw - 0.5));
      const x0 = fx | 0, x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < ch; c++) {
        const a = src[(y0 * w + x0) * ch + c], b = src[(y0 * w + x1) * ch + c], d = src[(y1 * w + x0) * ch + c], e = src[(y1 * w + x1) * ch + c];
        out[(y * nw + x) * ch + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
      }
    }
  }
  return out;
}


export const faceSwapCommands: CommandDef[] = [
  {
    name: "layer.faceSwap",
    label: "Face Swap",
    description:
      "Add a Face Swap result as a new layer at the top: rect {x,y,w,h} in the canvas, pixels (base64 RGBA) and mask (base64, one byte per pixel), either at the rect's size or at size {width,height}, which is scaled to fill the rect. replace: id of an earlier Face Swap layer to take out. Made by the Face Swap tool.",
    params: {
      type: "object",
      properties: {
        rect: {
          type: "object",
          properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer", minimum: 1 }, h: { type: "integer", minimum: 1 } },
          required: ["x", "y", "w", "h"],
        },
        pixels: { type: "string" },
        mask: { type: "string" },
        name: { type: "string" },
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        replace: { type: "integer", minimum: 1 },
      },
      required: ["rect", "pixels", "mask"],
    },
    history: true,
    run({ doc }, p: { rect: { x: number; y: number; w: number; h: number }; pixels: string; mask: string; name?: string; width?: number; height?: number; replace?: number }) {
      const r = p.rect;
      if (r.x < 0 || r.y < 0 || r.x + r.w > doc.width || r.y + r.h > doc.height) throw new ValidationError("the face is outside the image");
      const dw = p.width ?? r.w, dh = p.height ?? r.h;
      if (dw * dh > 16_777_216) throw new ValidationError("the face data is too large");
      let px = unb64(p.pixels), m = unb64(p.mask);
      if (px.length !== dw * dh * 4 || m.length !== dw * dh) throw new ValidationError("the face data does not match its size");
      if (dw !== r.w || dh !== r.h) {
        px = resample(px, dw, dh, r.w, r.h, 4);
        m = resample(m, dw, dh, r.w, r.h, 1);
      }
      // Swapping again replaces the earlier result instead of stacking on it.
      const old = p.replace !== undefined ? doc.layerById(p.replace) : undefined;
      if (old && old.mask && doc.layers.length > 1) doc.remove(old.id);
      // At the top: the face was made from everything visible.
      const l = doc.addLayer(p.name ?? "Face Swap", doc.stack.length);
      l.grid.writeRegion(r, new Uint8ClampedArray(px.buffer, px.byteOffset, px.length));
      l.grid.compact();
      const mask = new Mask(l.grid.width, l.grid.height, 0);
      mask.writeRegion({ x: r.x - l.offsetX, y: r.y - l.offsetY, w: r.w, h: r.h }, m);
      mask.compact();
      Object.assign(l, { mask, maskEnabled: true, maskDensity: 1, maskFeather: 0, maskLinked: true });
      doc.editMask = false;
      doc.emit({ type: "layers" });
      doc.dirty(old ? null : r);
    },
  },
];
