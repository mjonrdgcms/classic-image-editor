/** Filter > Liquify: apply a warp mesh to the active layer. */

import { CommandDef, ValidationError } from "../commands";
import { decodeMesh, warpPixels, type EncodedMesh } from "../liquify";
import { editArea } from "../selection";
import { assertPixelsEditable, hasLayer, nodeId, targetLayer } from "./common";

export const liquifyCommands: CommandDef[] = [
  {
    name: "image.liquify",
    label: "Liquify",
    description:
      "Warp the active layer with a Liquify mesh: {w, h, tiles:[{x, y, d}]}, a backward displacement field over the whole layer (d = base64 Int16 dx,dy pairs per 32x32 tile, in 1/16 mesh pixels). Made by the Liquify dialog; inside a selection only the selected part changes.",
    params: {
      type: "object",
      properties: {
        id: nodeId,
        mesh: {
          type: "object",
          properties: {
            w: { type: "integer", minimum: 1 },
            h: { type: "integer", minimum: 1 },
            tiles: { type: "array", items: { type: "object", properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, d: { type: "string" } }, required: ["x", "y", "d"] } },
          },
          required: ["w", "h", "tiles"],
        },
      },
      required: ["mesh"],
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { id?: number; mesh: EncodedMesh }) {
      const doc = ctx.doc;
      const l = targetLayer(ctx, p.id);
      assertPixelsEditable(l);
      if (p.mesh.w * p.mesh.h > 4_194_304) throw new ValidationError("the mesh is too large (at most 4 million points)");
      const w = l.grid.width, h = l.grid.height;
      const r = { x: 0, y: 0, w, h };
      const src = l.grid.readRegion(r);
      const { dx, dy } = decodeMesh(p.mesh);
      let out = warpPixels(src, w, h, dx, dy, p.mesh.w, p.mesh.h);
      // Inside a selection, blend by its coverage.
      const ea = editArea(doc, l);
      if (!ea) return;
      if (ea.cov) {
        const a = ea.area;
        const mixed = new Uint8ClampedArray(src);
        for (let y = 0; y < a.h; y++)
          for (let x = 0; x < a.w; x++) {
            const k = ea.cov[y * a.w + x] / 255;
            if (!k) continue;
            const o = ((y + a.y) * w + x + a.x) * 4;
            for (let c = 0; c < 4; c++) mixed[o + c] = src[o + c] + (out[o + c] - src[o + c]) * k;
          }
        out = mixed;
      }
      if (l.isBackground || l.locks.transparency) for (let i = 3; i < out.length; i += 4) out[i] = src[i];
      l.grid.writeRegion(r, out);
      l.grid.compact();
      doc.dirty(l.bounds());
    },
  },
];
