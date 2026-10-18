/**
 * Select > Subject and Select > People: selections made from the people
 * an AI model finds in the picture (see ai/people.ts).
 *
 * Finding people is slow and asynchronous, so it happens in prepare():
 * the UI supplies a provider that runs (and caches) the analysis of the
 * current pixels. run() then only builds the selection, so the commands
 * record into Actions and replay like any other.
 */

import { CommandContext, CommandDef, ValidationError } from "../commands";
import type { Document } from "../document";
import { Mask } from "../mask";
import { SELECT_MODES, SelectMode, applySelection } from "../selection";
import { boxBlur1 } from "../../filters/img";
import { PART_NAMES, matteToMask, peopleMatte, type PartName, type PeopleMap } from "../../ai/people";

export interface PeopleProvider {
  /** The analysis of the document's current pixels, if it is done. */
  get(doc: Document): PeopleMap | null;
  /** Run the analysis (fetching models first if needed). */
  prepare(doc: Document): Promise<void>;
}

let provider: PeopleProvider | null = null;
export function setPeopleProvider(p: PeopleProvider | null): void {
  provider = p;
}

const mode = { type: "string" as const, enum: SELECT_MODES, default: "replace", description: "replace, add to, subtract from or intersect with the current selection" };
const feather = { type: "number" as const, minimum: 0, maximum: 250, default: 0, description: "Feather radius in pixels" };

const prepare = (ctx: CommandContext): Promise<void> | null => {
  if (!provider) return null;
  return provider.get(ctx.doc) ? null : provider.prepare(ctx.doc);
};

function peopleOf(doc: Document): PeopleMap {
  const m = provider?.get(doc);
  if (!m) throw new ValidationError("people have not been detected in this image yet");
  return m;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Smooth, then move a soft matte's edge out (px > 0) or in, both in matte pixels. */
export function adjustMatte(m: Float32Array, w: number, h: number, smooth: number, shift: number): Float32Array {
  let out = m;
  if (smooth > 0) {
    const r = Math.max(1, Math.round(smooth / 2));
    const b = boxBlur1(boxBlur1(out, w, h, r), w, h, r);
    out = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = sstep(0.2, 0.8, b[i]);
  }
  if (shift) {
    const r = Math.max(1, Math.round(Math.abs(shift) / 2));
    const b = boxBlur1(boxBlur1(out, w, h, r), w, h, r);
    const o = new Float32Array(b.length);
    for (let i = 0; i < b.length; i++) o[i] = shift > 0 ? Math.max(out[i], sstep(0.02, 0.5, b[i])) : Math.min(out[i], sstep(0.5, 0.98, b[i]));
    out = o;
  }
  return out;
}

export interface PeopleSelectParams {
  people?: number[];
  parts?: PartName[];
  mode: SelectMode;
  feather: number;
  smooth: number;
  shiftEdge: number;
  refine: boolean;
}

/** The document-size mask for some people and parts. */
export function peopleMask(doc: Document, m: PeopleMap, p: Omit<PeopleSelectParams, "mode" | "feather">): Mask {
  if (p.people?.some((i) => i >= m.people.length)) throw new ValidationError(`there are only ${m.people.length} people in this image`);
  let matte = peopleMatte(m, { people: p.people?.length ? p.people : null, parts: p.parts?.length ? p.parts : null, refine: p.refine });
  const k = m.w / doc.width;
  if (p.smooth || p.shiftEdge) matte = adjustMatte(matte, m.w, m.h, p.smooth * k, p.shiftEdge * k);
  const W = doc.width, H = doc.height;
  const mask = new Mask(W, H, 0);
  mask.writeRegion({ x: 0, y: 0, w: W, h: H }, matteToMask(matte, m.w, m.h, W, H));
  mask.compact();
  return mask;
}

export const peopleCommands: CommandDef[] = [
  {
    name: "select.subject",
    label: "Select Subject",
    description: "Select every person in the picture (found by an on-device AI model), with soft, edge-refined borders.",
    params: { type: "object", properties: { mode, feather } },
    history: true,
    prepare,
    run({ doc }, p: { mode: SelectMode; feather: number }) {
      const m = peopleOf(doc);
      if (!m.people.length && !m.alpha.some((v) => v > 0.5)) throw new ValidationError("no people were found in this image");
      applySelection(doc, peopleMask(doc, m, { smooth: 0, shiftEdge: 0, refine: true }), p.mode, p.feather);
    },
  },
  {
    name: "select.people",
    label: "Select People",
    description:
      "Select some of the people in the picture, or parts of them (hair, faceSkin, bodySkin, clothes, accessories), found by an on-device AI model. People are numbered from 0, left to right; leave people out for everyone.",
    params: {
      type: "object",
      properties: {
        people: { type: "array", items: { type: "integer", minimum: 0 }, description: "Which people (0 = leftmost); empty or missing = all" },
        parts: { type: "array", items: { type: "string", enum: [...PART_NAMES] }, description: "Which parts; empty or missing = whole people" },
        mode,
        feather,
        smooth: { type: "number", minimum: 0, maximum: 100, default: 0, description: "Smooth the outline (pixels)" },
        shiftEdge: { type: "number", minimum: -100, maximum: 100, default: 0, description: "Move the edge out (+) or in (-), in pixels" },
        refine: { type: "boolean", default: true, description: "Snap the edge to the photo (hair, fine detail)" },
      },
    },
    history: true,
    prepare,
    run({ doc }, p: PeopleSelectParams) {
      const m = peopleOf(doc);
      if (!m.people.length) throw new ValidationError("no people were found in this image");
      applySelection(doc, peopleMask(doc, m, p), p.mode, p.feather);
    },
  },
];
