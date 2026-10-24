/**
 * Edit > Content-Aware Fill: the selection is replaced with texture taken
 * from around it (see core/inpaint.ts).
 *
 * The fill is slow, so the UI runs it in a worker in prepare() and caches
 * the result; run() then only writes it. Without a runner (tests, scripts)
 * run() computes it itself. A seed makes every run repeatable, so Actions
 * replay to the same pixels.
 */

import type { HistoryState } from "../history";
import { needsLoading } from "../scratch";
import { CommandContext, CommandDef, ValidationError } from "../commands";
import type { Document, Layer } from "../document";
import { healBlend, inpaint, type InpaintInput, type InpaintOptions } from "../inpaint";
import { resampleGray, resampleRGBA } from "../resample";
import { Rect, rectIntersect } from "../tiles";
import { assertPixelsEditable, hasLayer, paintTarget, percent, targetLayer } from "./common";
import { ART_STYLES, RETOUCH_TOOLS, RetouchStroke, type ArtStyle, type RetouchOptions, type RetouchTool, type ToneRange } from "../retouch";
import { PATTERN_SCHEMA, patternFromJSON } from "../patterns";
import type { TileGrid } from "../tiles";
import { wandMask } from "../selection";

export interface InpaintJob {
  input: InpaintInput;
  opts: InpaintOptions;
}

/** Runs an inpaint job somewhere else (a worker); set by the UI. */
export type InpaintRunner = (job: InpaintJob) => Promise<Uint8ClampedArray>;

let runner: InpaintRunner | null = null;
export function setInpaintRunner(r: InpaintRunner | null): void {
  runner = r;
}

export interface ContentAwareParams {
  sampleAll: boolean;
  seed: number;
}

/** Most hole pixels worked on at full size; bigger holes are filled smaller and scaled up. */
const MAX_HOLE = 500_000;

interface Plan {
  layer: Layer;
  /** Region in layer coordinates. */
  rect: Rect;
  /** Selection coverage over the region (0..255). */
  cov: Uint8Array;
  /** The pixels the fill learns from, over the region. */
  data: Uint8ClampedArray;
  /** Working scale (1 = full size). */
  scale: number;
  job: InpaintJob;
  key: string;
}

function plan(ctx: CommandContext, p: ContentAwareParams): Plan {
  const doc = ctx.doc;
  const t = paintTarget(ctx);
  if (t.kind !== "pixels") throw new ValidationError("Content-Aware Fill works on layer pixels; leave Quick Mask or stop editing the mask first");
  const l = t.layer;
  const sel = doc.selection;
  const b = sel?.bounds();
  if (!sel || !b) throw new ValidationError("select the area to fill first");
  const full = { x: 0, y: 0, w: l.grid.width, h: l.grid.height };
  const hb = rectIntersect(full, { x: b.x - l.offsetX, y: b.y - l.offsetY, w: b.w, h: b.h });
  if (!hb) throw new ValidationError("the selection does not cover any of the layer");
  // Learn from a band around the hole about as wide as the hole itself.
  const m = Math.max(32, Math.round(Math.max(hb.w, hb.h)));
  const rect = rectIntersect(full, { x: hb.x - m, y: hb.y - m, w: hb.w + m * 2, h: hb.h + m * 2 })!;
  const cov = sel.readRegion({ x: rect.x + l.offsetX, y: rect.y + l.offsetY, w: rect.w, h: rect.h });
  let holeCount = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i]) holeCount++;
  if (!holeCount) throw new ValidationError("the selection does not cover any of the layer");
  if (holeCount > cov.length * 0.9) throw new ValidationError("the selection covers almost everything, so there is nothing to fill it from; select less");
  const data = p.sampleAll ? doc.composite({ x: rect.x + l.offsetX, y: rect.y + l.offsetY, w: rect.w, h: rect.h }) : l.grid.readRegion(rect);
  let any = false;
  for (let i = 0; i < cov.length && !any; i++) if (!cov[i] && data[i * 4 + 3]) any = true;
  if (!any) throw new ValidationError(p.sampleAll ? "there is nothing around the selection to fill it from" : `"${l.name}" is empty around the selection; try Sample All Layers`);
  const scale = holeCount > MAX_HOLE ? Math.sqrt(MAX_HOLE / holeCount) : 1;
  let w = rect.w, h = rect.h, src = data, hole = new Uint8Array(cov.length);
  for (let i = 0; i < cov.length; i++) hole[i] = cov[i] ? 1 : 0;
  if (scale < 1) {
    w = Math.max(8, Math.round(rect.w * scale));
    h = Math.max(8, Math.round(rect.h * scale));
    src = resampleRGBA(data, rect.w, rect.h, w, h, "bilinear");
    const g = resampleGray(cov, rect.w, rect.h, w, h, "bilinear");
    hole = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) hole[i] = g[i] ? 1 : 0;
  }
  const job: InpaintJob = { input: { w, h, data: src, hole }, opts: { seed: p.seed } };
  const key = `${doc.pixelRev}|${l.id}|${rect.x},${rect.y},${rect.w},${rect.h}|${p.sampleAll}|${p.seed}`;
  return { layer: l, rect, cov, data, scale, job, key };
}

const cache = new WeakMap<Document, { key: string; sel: unknown; result: Uint8ClampedArray }>();

function cached(doc: Document, key: string): Uint8ClampedArray | null {
  const c = cache.get(doc);
  return c && c.key === key && c.sel === doc.selection ? c.result : null;
}

/** Write a fill result (at plan scale) into the layer through the selection. */
function apply(doc: Document, pl: Plan, result: Uint8ClampedArray): void {
  const { rect, cov, layer: l } = pl;
  const fill = pl.scale < 1 ? resampleRGBA(result, pl.job.input.w, pl.job.input.h, rect.w, rect.h, "bicubic") : result;
  const cur = l.grid.readRegion(rect);
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i] / 255;
    if (!a) continue;
    const o = i * 4;
    // Mix premultiplied so soft selection edges don't pick up stray color.
    const fa = fill[o + 3] * a, ca = cur[o + 3] * (1 - a);
    const outA = fa + ca;
    if (outA <= 0) {
      cur[o] = cur[o + 1] = cur[o + 2] = cur[o + 3] = 0;
      continue;
    }
    if (l.locks.transparency && !cur[o + 3]) continue;
    for (let c = 0; c < 3; c++) cur[o + c] = (fill[o + c] * fa + cur[o + c] * ca) / outA;
    cur[o + 3] = l.isBackground ? 255 : l.locks.transparency ? cur[o + 3] : outA;
  }
  l.grid.writeRegion(rect, cur);
  doc.dirty({ x: rect.x + l.offsetX, y: rect.y + l.offsetY, w: rect.w, h: rect.h });
}

const caParams = {
  type: "object" as const,
  properties: {
    sampleAll: { type: "boolean" as const, default: false, description: "Learn from all visible layers instead of only the active one" },
    seed: { type: "integer" as const, minimum: 0, maximum: 2147483647, default: 1, description: "Different seeds give different fills" },
  },
};

/** The layer `id` as it was in a history state or snapshot, for the History Brush. */
/** The history state (or snapshot) the History Brush paints from. */
function historySourceState(ctx: CommandContext, state: number, snapshot?: number): HistoryState | undefined {
  const h = ctx.bus.history;
  return snapshot !== undefined ? h.snapshots[snapshot] : state === 0 ? (h.opened ?? h.states[0]) : h.states[Math.min(state, h.states.length - 1)];
}

export function historySource(ctx: CommandContext, layerId: number, state: number, snapshot?: number): { grid: TileGrid; offsetX: number; offsetY: number } {
  const st = historySourceState(ctx, state, snapshot);
  if (!st) throw new ValidationError(snapshot !== undefined ? `there is no snapshot ${snapshot + 1}` : "there is no history state to paint from");
  if (needsLoading(st.snapshot)) throw new ValidationError("that history state is on the scratch disk; go back to it in the History palette once to load it");
  for (const n of st.snapshot.stack) {
    const layers = n.kind === "layer" ? [n] : n.children;
    for (const l of layers) if (l.props.id === layerId) return { grid: l.grid, offsetX: l.props.offsetX, offsetY: l.props.offsetY };
  }
  throw new ValidationError("the active layer did not exist in the history state the History Brush paints from");
}

export interface RetouchParams {
  tool: RetouchTool;
  points: number[][];
  size: number;
  hardness: number;
  strength: number;
  offset?: number[];
  sampleAll: boolean;
  range: ToneRange;
  sponge: "saturate" | "desaturate";
  historyState: number;
  historySnapshot?: number;
  seed: number;
  pattern?: { name?: string; w: number; h: number; b64: string };
  tolerance: number;
  sampling: "once" | "continuous" | "background";
  limits: "contiguous" | "discontiguous";
  protectFg: boolean;
  replaceMode: "hue" | "saturation" | "color" | "luminosity";
  artStyle: ArtStyle;
  artArea: number;
}

const RETOUCH_LABELS: Record<RetouchTool, string> = {
  clone: "Clone Stamp",
  heal: "Healing Brush",
  spotHeal: "Spot Healing Brush",
  history: "History Brush",
  dodge: "Dodge Tool",
  burn: "Burn Tool",
  sponge: "Sponge Tool",
  blur: "Blur Tool",
  sharpen: "Sharpen Tool",
  smudge: "Smudge Tool",
  pattern: "Pattern Stamp",
  bgErase: "Background Eraser",
  colorReplace: "Color Replacement Tool",
  artHistory: "Art History Brush",
};

/** Build the options for a retouch stroke from command params. */
export function retouchOptions(ctx: CommandContext, layerId: number, p: RetouchParams): RetouchOptions {
  if ((p.tool === "clone" || p.tool === "heal") && !p.offset) throw new ValidationError("set a source first: Alt-click where to copy from");
  return {
    tool: p.tool,
    size: p.size,
    hardness: p.hardness,
    strength: p.strength / 100,
    offset: p.offset ? [p.offset[0], p.offset[1]] : undefined,
    sampleAll: p.sampleAll,
    range: p.range,
    sponge: p.sponge,
    historySource: p.tool === "history" || p.tool === "artHistory" ? historySource(ctx, layerId, p.historyState, p.historySnapshot) : null,
    seed: p.seed,
    pattern: p.tool === "pattern" ? (p.pattern ? patternFromJSON(p.pattern) : (() => { throw new ValidationError("choose a pattern for the Pattern Stamp"); })()) : null,
    tolerance: p.tolerance,
    sampling: p.sampling,
    limits: p.limits,
    protectFg: p.protectFg,
    fg: [ctx.doc.foreground[0], ctx.doc.foreground[1], ctx.doc.foreground[2]],
    bg: [ctx.doc.background[0], ctx.doc.background[1], ctx.doc.background[2]],
    replaceMode: p.replaceMode,
    artStyle: p.artStyle,
    artArea: p.artArea,
  };
}

/**
 * Red Eye: find the red pupil nearest (x, y) inside a search box and make
 * it a natural dark pupil, keeping its highlight. Returns the layer rect changed.
 */
export function fixRedEye(l: Layer, box: Rect, cx: number, cy: number, pupil: number, darken: number): Rect | null {
  const r = rectIntersect(box, { x: 0, y: 0, w: l.grid.width, h: l.grid.height });
  if (!r) return null;
  const px = l.grid.readRegion(r);
  const n = r.w * r.h;
  const red = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
    const m = Math.max(G, B);
    // How red: strong red over green and blue.
    red[i] = R > 50 && R > m * 1.35 ? Math.min(1, (R - m) / Math.max(40, R * 0.6)) : 0;
  }
  // The red blob connected to the reddest pixel near the click.
  const lx = cx - r.x, ly = cy - r.y;
  let seed = -1, best = 0;
  for (let i = 0; i < n; i++) {
    if (red[i] < 0.25) continue;
    const x = i % r.w, y = (i / r.w) | 0;
    const score = red[i] / (1 + Math.hypot(x - lx, y - ly) / (Math.max(r.w, r.h) * 0.25));
    if (score > best) (best = score), (seed = i);
  }
  if (seed < 0) return null;
  const inBlob = new Uint8Array(n);
  const queue = [seed];
  inBlob[seed] = 1;
  const thresh = 0.12 + (1 - pupil / 100) * 0.3;
  while (queue.length) {
    const i = queue.pop()!;
    const x = i % r.w, y = (i / r.w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < r.w - 1 ? i + 1 : -1, y > 0 ? i - r.w : -1, y < r.h - 1 ? i + r.w : -1])
      if (j >= 0 && !inBlob[j] && red[j] >= thresh) {
        inBlob[j] = 1;
        queue.push(j);
      }
  }
  // Soften the blob's edge, then darken it to a neutral pupil.
  const soft = new Float32Array(n);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= r.w || yy >= r.h) continue;
          s += inBlob[yy * r.w + xx];
          c++;
        }
      soft[y * r.w + x] = s / c;
    }
  const k = 1 - (darken / 100) * 0.85;
  let changed = false;
  for (let i = 0; i < n; i++) {
    const a = Math.max(soft[i], 0) * Math.min(1, red[i] * 2.5 + soft[i] * 0.3);
    if (a <= 0) continue;
    const p = i * 4;
    const R = px[p], G = px[p + 1], B = px[p + 2];
    const v = ((G + B) / 2) * k;
    px[p] = R + (v - R) * a;
    px[p + 1] = G + (Math.min(G, v + 4) - G) * a;
    px[p + 2] = B + (Math.min(B, v + 6) - B) * a;
    changed = true;
  }
  if (!changed) return null;
  l.grid.writeRegion(r, px);
  return r;
}

export const healCommands: CommandDef[] = [
  {
    name: "edit.patch",
    label: "Patch Tool",
    description:
      "Patch the selection: mode source replaces the selected area with what is at (dx, dy) from it, blended into its surroundings; mode destination copies the selected area to (dx, dy) away, blended in there.",
    params: {
      type: "object",
      properties: { dx: { type: "integer" }, dy: { type: "integer" }, mode: { type: "string", enum: ["source", "destination"], default: "source" } },
      required: ["dx", "dy"],
    },
    history: true,
    enabled: (ctx) => hasLayer(ctx) && !!ctx.doc.selection,
    run(ctx, p: { dx: number; dy: number; mode: "source" | "destination" }) {
      const doc = ctx.doc;
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      const b = doc.selection?.bounds();
      if (!b) throw new ValidationError("select the area to patch first");
      // Selection bounds in layer space, with a ring around it to match light and color.
      const m = 8;
      const sel = { x: b.x - l.offsetX - m, y: b.y - l.offsetY - m, w: b.w + m * 2, h: b.h + m * 2 };
      const shift = { x: sel.x + p.dx, y: sel.y + p.dy, w: sel.w, h: sel.h };
      const cov = doc.selection!.readRegion({ x: sel.x + l.offsetX, y: sel.y + l.offsetY, w: sel.w, h: sel.h });
      const mask = new Float32Array(cov.length);
      for (let i = 0; i < cov.length; i++) mask[i] = cov[i] / 255;
      const [dstR, srcR] = p.mode === "source" ? [sel, shift] : [shift, sel];
      const dst = l.grid.readRegion(dstR);
      const src = l.grid.readRegion(srcR);
      const out = healBlend(dst, src, mask, sel.w, sel.h);
      if (l.isBackground || l.locks.transparency) for (let i = 3; i < out.length; i += 4) out[i] = l.isBackground ? 255 : dst[i];
      l.grid.writeRegion(dstR, out);
      doc.dirty({ x: dstR.x + l.offsetX, y: dstR.y + l.offsetY, w: dstR.w, h: dstR.h });
    },
  },
  {
    name: "paint.redEye",
    label: "Red Eye Tool",
    description: "Turn a red-eye pupil near (x, y) dark again. Search a box of `radius` pixels around the point.",
    params: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        radius: { type: "number", minimum: 4, maximum: 1000, default: 40 },
        pupil: { ...percent("Pupil size: how far the fix spreads into less-red pixels"), default: 50 },
        darken: { ...percent("Darken amount"), default: 50 },
      },
      required: ["x", "y"],
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { x: number; y: number; radius: number; pupil: number; darken: number }) {
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      const cx = p.x - l.offsetX, cy = p.y - l.offsetY, R = Math.round(p.radius);
      const r = fixRedEye(l, { x: Math.round(cx) - R, y: Math.round(cy) - R, w: R * 2 + 1, h: R * 2 + 1 }, cx, cy, p.pupil, p.darken);
      if (!r) throw new ValidationError("no red eye was found there; click right on the red pupil");
      ctx.doc.dirty({ x: r.x + l.offsetX, y: r.y + l.offsetY, w: r.w, h: r.h });
    },
  },
  {
    name: "paint.magicErase",
    label: "Magic Eraser",
    description: "Erase pixels similar in color to the one at (x, y) to transparency (the Background layer becomes a normal layer first).",
    params: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        tolerance: { type: "integer", minimum: 0, maximum: 255, default: 32 },
        contiguous: { type: "boolean", default: true },
        antiAlias: { type: "boolean", default: true },
        sampleMerged: { type: "boolean", default: false, description: "Use All Layers" },
        opacity: { ...percent("Opacity in percent"), default: 100 },
      },
      required: ["x", "y"],
    },
    history: true,
    enabled: hasLayer,
    run(ctx, p: { x: number; y: number; tolerance: number; contiguous: boolean; antiAlias: boolean; sampleMerged: boolean; opacity: number }) {
      const doc = ctx.doc;
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      if (l.locks.transparency) throw new ValidationError(`"${l.name}" has its transparency locked`);
      const m = wandMask(doc, p.x, p.y, p);
      const b = m.bounds();
      if (!b) return;
      if (l.isBackground) {
        l.isBackground = false;
        l.name = "Layer 0";
        doc.emit({ type: "layers" });
      }
      const area = rectIntersect({ x: 0, y: 0, w: l.grid.width, h: l.grid.height }, { x: b.x - l.offsetX, y: b.y - l.offsetY, w: b.w, h: b.h });
      if (!area) return;
      const cr = { x: area.x + l.offsetX, y: area.y + l.offsetY, w: area.w, h: area.h };
      const cov = m.readRegion(cr);
      const sel = doc.selection?.readRegion(cr);
      const px = l.grid.readRegion(area);
      const op = p.opacity / 100;
      for (let i = 0; i < cov.length; i++) {
        let a = (cov[i] / 255) * op;
        if (sel) a *= sel[i] / 255;
        if (a > 0) px[i * 4 + 3] = Math.round(px[i * 4 + 3] * (1 - a));
      }
      l.grid.writeRegion(area, px);
      l.grid.compact();
      doc.dirty(cr);
    },
  },
  {
    name: "paint.retouch",
    label: (p: { tool: RetouchTool }) => RETOUCH_LABELS[p.tool] ?? "Retouch",
    description:
      "Retouch along a stroke through [x, y] canvas points: clone (copy from offset [dx, dy]), heal (clone, then blend into the surroundings), spotHeal (fill what the stroke covers from around it), history (paint back a history state), dodge/burn (lighten/darken a tone range), sponge (saturate/desaturate), blur, sharpen, smudge, pattern (paint a pattern), bgErase (erase colors like the one under the brush), colorReplace (recolor with the foreground color) or artHistory (stylized strokes from a history state). strength is opacity, exposure, flow or strength depending on the tool.",
    params: {
      type: "object",
      properties: {
        tool: { type: "string", enum: RETOUCH_TOOLS },
        points: { type: "array", minItems: 1, items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 } },
        size: { type: "number", minimum: 1, maximum: 2500, default: 30 },
        hardness: { ...percent("Brush hardness in percent"), default: 50 },
        strength: { ...percent("Opacity, exposure, flow or strength in percent"), default: 100 },
        offset: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "clone/heal: source minus destination, in canvas pixels" },
        sampleAll: { type: "boolean", default: false, description: "clone/heal: copy from all visible layers" },
        range: { type: "string", enum: ["shadows", "midtones", "highlights"], default: "midtones", description: "dodge/burn: which tones" },
        sponge: { type: "string", enum: ["saturate", "desaturate"], default: "desaturate" },
        historyState: { type: "integer", minimum: 0, default: 0, description: "history: the History palette state to paint from (0 = the image as opened)" },
        historySnapshot: { type: "integer", minimum: 0, description: "history: paint from this named snapshot instead" },
        seed: { type: "integer", minimum: 0, default: 1 },
        pattern: { ...PATTERN_SCHEMA, description: "pattern: what the Pattern Stamp paints" },
        tolerance: { ...percent("bgErase/colorReplace: how close a color must be"), default: 50 },
        sampling: { type: "string", enum: ["once", "continuous", "background"], default: "continuous", description: "bgErase/colorReplace: which color to act on" },
        limits: { type: "string", enum: ["contiguous", "discontiguous"], default: "contiguous" },
        protectFg: { type: "boolean", default: false, description: "bgErase: never erase the foreground color" },
        replaceMode: { type: "string", enum: ["hue", "saturation", "color", "luminosity"], default: "color", description: "colorReplace: what to take from the foreground color" },
        artStyle: { type: "string", enum: ART_STYLES, default: "tightShort", description: "artHistory: stroke style" },
        artArea: { type: "number", minimum: 1, maximum: 500, default: 50, description: "artHistory: area each dab covers, in pixels" },
      },
      required: ["tool", "points"],
    },
    history: true,
    enabled: hasLayer,
    // A History Brush source paged out to the scratch disk is loaded first.
    prepare(ctx, p: RetouchParams) {
      if (p.tool !== "history" && p.tool !== "artHistory") return null;
      const st = historySourceState(ctx, p.historyState ?? 0, p.historySnapshot);
      return st && needsLoading(st.snapshot) && ctx.bus.loadStates ? ctx.bus.loadStates([st]) : null;
    },
    run(ctx, p: RetouchParams) {
      const l = targetLayer(ctx);
      assertPixelsEditable(l);
      // Erasing to transparency needs a normal layer.
      if (p.tool === "bgErase" && l.isBackground) {
        l.isBackground = false;
        l.name = "Layer 0";
        ctx.doc.emit({ type: "layers" });
      }
      const s = new RetouchStroke(ctx.doc, l, retouchOptions(ctx, l.id, p));
      for (const pt of p.points) s.addPoint(pt[0], pt[1], pt[2] ?? 1);
      s.end();
    },
  },
  {
    name: "edit.contentAwareFill",
    label: "Content-Aware Fill",
    description: "Replace the selected area with texture from its surroundings, as if what was there had never been.",
    params: caParams,
    history: true,
    enabled: (ctx) => hasLayer(ctx) && !!ctx.doc.selection,
    prepare(ctx, p: ContentAwareParams) {
      if (!runner) return null;
      let pl: Plan;
      try {
        pl = plan(ctx, p);
      } catch {
        return null; // run() reports it
      }
      if (cached(ctx.doc, pl.key)) return null;
      const doc = ctx.doc, sel = doc.selection, key = pl.key;
      return runner(pl.job).then((result) => {
        cache.set(doc, { key, sel, result });
      });
    },
    run(ctx, p: ContentAwareParams) {
      const pl = plan(ctx, p);
      const result = cached(ctx.doc, pl.key) ?? inpaint(pl.job.input, pl.job.opts);
      cache.delete(ctx.doc);
      apply(ctx.doc, pl, result);
    },
  },
];
