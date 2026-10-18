/** Type layers: create, edit and rasterize text. */

import { CommandDef, ObjectSchema, ParamSchema, ValidationError } from "../commands";
import { Layer } from "../document";
import { ANTI_ALIAS, DEFAULT_TEXT, TEXT_ALIGN, TextSpec, TextStyle, convertAnchor, renderTextLayer, textAnchor, textLayerName } from "../text";
import { nodeId, targetLayer } from "./common";

const rgb = { type: "array" as const, items: { type: "integer" as const, minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 };

/** JSON-Schema for the character and paragraph settings. */
const styleProps: Record<keyof TextStyle, ParamSchema> = {
  font: { type: "string", description: "Font family, e.g. \"Inter\", \"Bangers\", \"Playfair Display\" or an installed font" },
  weight: { type: "integer", minimum: 100, maximum: 900, description: "100 thin ... 400 regular ... 700 bold ... 900 black" },
  italic: { type: "boolean" },
  size: { type: "number", minimum: 1, maximum: 5000, description: "Pixels" },
  color: { ...rgb, description: "RGB; default the foreground color" },
  leading: { type: "number", minimum: 0, maximum: 10000, description: "Line spacing in px; 0 = auto" },
  tracking: { type: "number", minimum: -1000, maximum: 10000, description: "Letter spacing in 1/1000 em" },
  hScale: { type: "number", minimum: 1, maximum: 1000, description: "Horizontal scale, percent" },
  vScale: { type: "number", minimum: 1, maximum: 1000, description: "Vertical scale, percent" },
  baselineShift: { type: "number", minimum: -5000, maximum: 5000, description: "Pixels, up is positive" },
  align: { type: "string", enum: TEXT_ALIGN },
  antiAlias: { type: "string", enum: ANTI_ALIAS },
  fauxBold: { type: "boolean" },
  fauxItalic: { type: "boolean" },
  underline: { type: "boolean" },
  strikethrough: { type: "boolean" },
  allCaps: { type: "boolean" },
};

const box = { type: "object" as const, properties: { w: { type: "number" as const, minimum: 1 }, h: { type: "number" as const, minimum: 1 } }, required: ["w", "h"], description: "Paragraph text box size; omit for point text" };

const pickStyle = (p: Record<string, unknown>): Partial<TextStyle> => {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(styleProps)) if (p[k] !== undefined) out[k] = p[k];
  return out as Partial<TextStyle>;
};

function typeLayer(l: Layer): TextSpec {
  if (!l.text) throw new ValidationError(`"${l.name}" is not a type layer`);
  return l.text;
}

export const typeCommands: CommandDef[] = [
  {
    name: "type.create",
    label: "Type Tool",
    description:
      "Create a type layer. Point text: x, y is the start of the first baseline. Paragraph text: pass box {w, h}; x, y is its top-left corner and lines wrap inside it. Newlines (\\n) start new lines.",
    params: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, content: { type: "string" }, box, ...styleProps },
      required: ["x", "y", "content"],
    } as ObjectSchema,
    history: true,
    run({ doc }, p: { x: number; y: number; content: string; box?: { w: number; h: number } } & Partial<TextStyle>) {
      const style = { ...DEFAULT_TEXT, color: [doc.foreground[0], doc.foreground[1], doc.foreground[2]] as [number, number, number], ...pickStyle(p) };
      const l = doc.addLayer(textLayerName(p.content));
      l.text = { ...style, content: p.content, box: p.box ? { w: p.box.w, h: p.box.h } : null, ax: 0, ay: 0 };
      doc.editMask = false;
      const r = renderTextLayer(l, { x: p.x, y: p.y });
      doc.emit({ type: "layers" });
      doc.dirty(r);
    },
  },
  {
    name: "type.edit",
    label: "Edit Type Layer",
    description: "Change a type layer's text, box, or character / paragraph settings (only what you pass changes).",
    params: { type: "object", properties: { id: nodeId, content: { type: "string" }, box: { ...box, description: "Make it paragraph text in this box" }, pointText: { type: "boolean", description: "true turns paragraph text into point text" }, ...styleProps } } as ObjectSchema,
    history: true,
    enabled: (ctx) => !!ctx.doc.activeLayer?.text,
    run(ctx, p: { id?: number; content?: string; box?: { w: number; h: number }; pointText?: boolean } & Partial<TextStyle>) {
      const doc = ctx.doc;
      const l = targetLayer(ctx, p.id);
      const t = typeLayer(l);
      if (l.locks.pixels) throw new ValidationError(`"${l.name}" has its image pixels locked`);
      const anchor = textAnchor(l);
      const next: TextSpec = { ...t, ...pickStyle(p) };
      if (p.content !== undefined) {
        // Keep an automatic name in step with the text.
        if (l.name === textLayerName(t.content)) l.name = textLayerName(p.content);
        next.content = p.content;
      }
      if (p.box) next.box = { w: p.box.w, h: p.box.h };
      if (p.pointText) next.box = null;
      l.text = next;
      const r = renderTextLayer(l, convertAnchor(t, next, anchor));
      doc.emit({ type: "layers" });
      doc.dirty(r);
    },
  },
  {
    name: "layer.rasterizeType",
    label: "Rasterize Type",
    description: "Turn a type layer into an ordinary pixel layer (the text is no longer editable).",
    params: { type: "object", properties: { id: nodeId } },
    history: true,
    enabled: (ctx) => !!ctx.doc.activeLayer?.text,
    run(ctx, p: { id?: number }) {
      const l = targetLayer(ctx, p.id);
      typeLayer(l);
      l.text = null;
      ctx.doc.emit({ type: "layers" });
    },
  },
];
