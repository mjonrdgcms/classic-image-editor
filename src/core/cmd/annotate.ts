/** Notes (sticky notes on the canvas) and web slices. */

import { CommandDef, ValidationError } from "../commands";
import type { Document } from "../document";

const nextId = (list: { id: number }[]) => Math.max(0, ...list.map((n) => n.id)) + 1;
const changed = (doc: Document) => doc.emit({ type: "guides" });

export const annotateCommands: CommandDef[] = [
  {
    name: "note.add",
    label: "New Note",
    description: "Put a sticky note on the canvas at (x, y). Notes are saved with the image but never printed or exported.",
    params: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, text: { type: "string", default: "" }, author: { type: "string", default: "" }, color: { type: "string", default: "#ffe066" } },
      required: ["x", "y"],
    },
    history: true,
    run({ doc }, p: { x: number; y: number; text: string; author: string; color: string }) {
      doc.notes.push({ id: nextId(doc.notes), x: Math.round(p.x), y: Math.round(p.y), text: p.text, author: p.author, color: p.color });
      changed(doc);
    },
  },
  {
    name: "note.update",
    label: (p: { x?: number }) => (p.x !== undefined ? "Move Note" : "Edit Note"),
    description: "Change a note's text, color, author or position.",
    params: {
      type: "object",
      properties: { id: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, text: { type: "string" }, author: { type: "string" }, color: { type: "string" } },
      required: ["id"],
    },
    history: true,
    run({ doc }, p: { id: number; x?: number; y?: number; text?: string; author?: string; color?: string }) {
      const i = doc.notes.findIndex((n) => n.id === p.id);
      if (i < 0) throw new ValidationError(`there is no note ${p.id}`);
      const n = { ...doc.notes[i] };
      if (p.x !== undefined) n.x = Math.round(p.x);
      if (p.y !== undefined) n.y = Math.round(p.y);
      if (p.text !== undefined) n.text = p.text;
      if (p.author !== undefined) n.author = p.author;
      if (p.color !== undefined) n.color = p.color;
      doc.notes = doc.notes.map((x, j) => (j === i ? n : x));
      changed(doc);
    },
  },
  {
    name: "note.remove",
    label: (p: { id?: number }) => (p.id === undefined ? "Delete All Notes" : "Delete Note"),
    description: "Delete a note, or every note when no id is given.",
    params: { type: "object", properties: { id: { type: "integer" } } },
    history: true,
    enabled: (ctx) => ctx.doc.notes.length > 0,
    run({ doc }, p: { id?: number }) {
      if (p.id !== undefined && !doc.notes.some((n) => n.id === p.id)) throw new ValidationError(`there is no note ${p.id}`);
      doc.notes = p.id === undefined ? [] : doc.notes.filter((n) => n.id !== p.id);
      changed(doc);
    },
  },
  {
    name: "slice.add",
    label: "Slice",
    description: "Make a web slice: an area of the image File > Export > Slices saves as its own picture.",
    params: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number", minimum: 1 }, h: { type: "number", minimum: 1 }, name: { type: "string" } },
      required: ["x", "y", "w", "h"],
    },
    history: true,
    run({ doc }, p: { x: number; y: number; w: number; h: number; name?: string }) {
      const x = Math.max(0, Math.round(p.x)), y = Math.max(0, Math.round(p.y));
      const w = Math.min(doc.width - x, Math.round(p.w)), h = Math.min(doc.height - y, Math.round(p.h));
      if (w < 1 || h < 1) throw new ValidationError("the slice is outside the image");
      const id = nextId(doc.slices);
      doc.slices.push({ id, x, y, w, h, name: p.name ?? `${doc.name.replace(/\.[^.]+$/, "")}_${String(id).padStart(2, "0")}` });
      changed(doc);
    },
  },
  {
    name: "slice.update",
    label: "Edit Slice",
    description: "Move, resize or rename a slice.",
    params: {
      type: "object",
      properties: { id: { type: "integer" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number", minimum: 1 }, h: { type: "number", minimum: 1 }, name: { type: "string" } },
      required: ["id"],
    },
    history: true,
    run({ doc }, p: { id: number; x?: number; y?: number; w?: number; h?: number; name?: string }) {
      const i = doc.slices.findIndex((s) => s.id === p.id);
      if (i < 0) throw new ValidationError(`there is no slice ${p.id}`);
      const s = { ...doc.slices[i] };
      if (p.x !== undefined) s.x = Math.max(0, Math.round(p.x));
      if (p.y !== undefined) s.y = Math.max(0, Math.round(p.y));
      if (p.w !== undefined) s.w = Math.round(p.w);
      if (p.h !== undefined) s.h = Math.round(p.h);
      s.w = Math.max(1, Math.min(doc.width - s.x, s.w));
      s.h = Math.max(1, Math.min(doc.height - s.y, s.h));
      if (p.name !== undefined) s.name = p.name;
      doc.slices = doc.slices.map((x, j) => (j === i ? s : x));
      changed(doc);
    },
  },
  {
    name: "slice.remove",
    label: (p: { id?: number }) => (p.id === undefined ? "Delete All Slices" : "Delete Slice"),
    description: "Delete a slice, or all of them when no id is given.",
    params: { type: "object", properties: { id: { type: "integer" } } },
    history: true,
    enabled: (ctx) => ctx.doc.slices.length > 0,
    run({ doc }, p: { id?: number }) {
      doc.slices = p.id === undefined ? [] : doc.slices.filter((s) => s.id !== p.id);
      changed(doc);
    },
  },
];
