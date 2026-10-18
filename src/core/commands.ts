/**
 * The CommandBus: the single way anything changes a document.
 *
 * Menus, keyboard shortcuts, tools, Actions, scripts and (from M2) the
 * Ollama assistant all dispatch named commands with JSON parameters. Each
 * command declares a JSON-Schema for its parameters, so the same registry
 * doubles as the tool list we hand to an LLM, and every dispatch is
 * validated before it runs.
 */

import type { ClipboardImage } from "./cmd/edit";
import type { Document } from "./document";
import { History } from "./history";

// ---------- a small JSON-Schema subset ----------

export type ParamSchema =
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number; default?: number }
  | { type: "string"; description?: string; enum?: readonly string[]; default?: string }
  | { type: "boolean"; description?: string; default?: boolean }
  | { type: "array"; description?: string; items: ParamSchema; minItems?: number; maxItems?: number }
  | ObjectSchema;

export interface ObjectSchema {
  type: "object";
  description?: string;
  properties: Record<string, ParamSchema>;
  required?: readonly string[];
}

export class ValidationError extends Error {}

export function validate(schema: ParamSchema, value: unknown, path = "params"): unknown {
  switch (schema.type) {
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(`${path} must be a number`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new ValidationError(`${path} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum)
        throw new ValidationError(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum)
        throw new ValidationError(`${path} must be <= ${schema.maximum}`);
      return value;
    }
    case "string":
      if (typeof value !== "string") throw new ValidationError(`${path} must be a string`);
      if (schema.enum && !schema.enum.includes(value))
        throw new ValidationError(`${path} must be one of: ${schema.enum.join(", ")}`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ValidationError(`${path} must be true or false`);
      return value;
    case "array":
      if (!Array.isArray(value)) throw new ValidationError(`${path} must be an array`);
      if (schema.minItems !== undefined && value.length < schema.minItems)
        throw new ValidationError(`${path} needs at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        throw new ValidationError(`${path} allows at most ${schema.maxItems} items`);
      return value.map((v, i) => validate(schema.items, v, `${path}[${i}]`));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new ValidationError(`${path} must be an object`);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const req of schema.required ?? [])
        if (obj[req] === undefined) throw new ValidationError(`${path}.${req} is required`);
      for (const [k, v] of Object.entries(obj)) {
        const sub = schema.properties[k];
        if (!sub) throw new ValidationError(`${path}.${k} is not a known parameter`);
        // null means "not set" (JSON from presets uses it for disabled sections).
        if (v !== undefined && v !== null) out[k] = validate(sub, v, `${path}.${k}`);
      }
      for (const [k, sub] of Object.entries(schema.properties))
        if (out[k] === undefined && "default" in sub && sub.default !== undefined) out[k] = sub.default;
      return out;
    }
  }
}

// ---------- commands ----------

export interface CommandContext {
  doc: Document;
  bus: CommandBus;
}

export interface CommandDef<P = any> {
  /** Dotted name, e.g. "layer.new". Stable: Actions and the AI refer to it. */
  name: string;
  /** History palette / menu label. */
  label: string | ((p: P, ctx: CommandContext) => string);
  /** One line for the AI and the command palette. */
  description: string;
  params: ObjectSchema;
  /** False for commands PS7 doesn't record (selecting a layer, picking a color). */
  history: boolean;
  /** Compute a function label before running (it depends on what the command removes or replaces). */
  labelBefore?: boolean;
  /** Throw to refuse; the bus rolls the document back. */
  run(ctx: CommandContext, p: P): void;
  /** Optional: whether the command can run right now (greys out menus). */
  enabled?(ctx: CommandContext): boolean;
  /**
   * Optional: slow work the command needs first (e.g. finding people with
   * an AI model). Returns null when it is ready, or a promise to await
   * before dispatching. run() itself stays synchronous.
   */
  prepare?(ctx: CommandContext, p: P): Promise<void> | null;
}

export interface DispatchOptions {
  /** The caller already applied the change live (e.g. a brush stroke). */
  applied?: boolean;
}

export interface CommandRecord {
  name: string;
  params: Record<string, unknown>;
  label: string;
}

type CommandListener = (rec: CommandRecord) => void;

export class CommandBus {
  private defs = new Map<string, CommandDef>();
  private listeners = new Set<CommandListener>();
  private groupDepth = 0;
  private groupDirty = false;
  doc: Document;
  history: History;
  /** Internal clipboard (pixels). The UI mirrors it to the system clipboard. */
  clipboard: ClipboardImage | null = null;
  private clipListeners = new Set<(c: ClipboardImage) => void>();

  constructor(doc: Document) {
    this.doc = doc;
    this.history = new History(doc);
  }

  register(def: CommandDef): void {
    if (this.defs.has(def.name)) throw new Error(`command ${def.name} registered twice`);
    this.defs.set(def.name, def);
  }

  get(name: string): CommandDef | undefined {
    return this.defs.get(name);
  }

  list(): CommandDef[] {
    return [...this.defs.values()];
  }

  /** Commands as Ollama / OpenAI-style tool definitions. */
  toolSchemas(): { type: "function"; function: { name: string; description: string; parameters: ObjectSchema } }[] {
    return this.list()
      .filter((d) => !d.name.startsWith("app."))
      .map((d) => ({
        type: "function" as const,
        function: { name: d.name.replace(/\./g, "_"), description: d.description, parameters: d.params },
      }));
  }

  setClipboard(c: ClipboardImage, fromSystem = false): void {
    this.clipboard = c;
    if (!fromSystem) for (const fn of this.clipListeners) fn(c);
  }

  onClipboard(fn: (c: ClipboardImage) => void): () => void {
    this.clipListeners.add(fn);
    return () => this.clipListeners.delete(fn);
  }

  private beforeListeners = new Set<(name: string) => void>();

  /** Called before any command runs (e.g. to commit text being typed). */
  onBeforeCommand(fn: (name: string) => void): () => void {
    this.beforeListeners.add(fn);
    return () => this.beforeListeners.delete(fn);
  }

  onCommand(fn: CommandListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Point the bus at an open image and its own history (switching windows). */
  attach(doc: Document, history: History): void {
    this.doc = doc;
    this.history = history;
  }

  /** Swap in a new document (File > New / Open) and reset history. */
  setDocument(doc: Document, label: string): void {
    this.doc = doc;
    this.history.reset(doc, label);
  }

  isEnabled(name: string): boolean {
    const d = this.defs.get(name);
    if (!d) return false;
    return d.enabled ? d.enabled(this.ctx()) : true;
  }

  /** Await this (when not null) before dispatching name; see CommandDef.prepare. */
  prepare(name: string, params: Record<string, unknown> = {}): Promise<void> | null {
    const d = this.defs.get(name);
    return d?.prepare ? d.prepare(this.ctx(), params) : null;
  }

  private ctx(): CommandContext {
    return { doc: this.doc, bus: this };
  }

  dispatch(name: string, params: Record<string, unknown> = {}, opts: DispatchOptions = {}): void {
    for (const fn of this.beforeListeners) fn(name);
    const def = this.defs.get(name);
    if (!def) throw new ValidationError(`unknown command "${name}"`);
    const p = validate(def.params, params) as Record<string, unknown>;
    const ctx = this.ctx();
    // Labels normally read the document after the command; some describe what was there before.
    let label = typeof def.label === "function" ? null : def.label;
    if (!opts.applied) {
      if (def.enabled && !def.enabled(ctx)) throw new ValidationError(`${name} is not available right now`);
      if (label === null && def.labelBefore) label = (def.label as (p: unknown, c: CommandContext) => string)(p, ctx);
      try {
        def.run(ctx, p);
      } catch (e) {
        if (this.groupDepth === 0) this.rollback();
        throw e;
      }
    }
    if (label === null) label = (def.label as (p: unknown, c: CommandContext) => string)(p, ctx);
    if (def.history) {
      if (this.groupDepth > 0) this.groupDirty = true;
      else this.history.push(label);
    }
    for (const fn of this.listeners) fn({ name, params: p, label });
  }

  /** Undo a failed command, keeping state History doesn't record (active layer, mask editing). */
  private rollback(): void {
    const doc = this.doc;
    const active = doc.activeLayerId;
    const selected = [...doc.selectedIds];
    const editMask = doc.editMask;
    this.history.revert();
    if (doc.nodeById(active)) {
      doc.selectNodes(active, selected);
      doc.editMask = editMask && !!doc.activeNode?.mask;
      doc.emit({ type: "layers" });
    }
  }

  /**
   * Run several commands as one history step (AI plans, Actions). If any
   * command throws, the whole group is rolled back.
   */
  group(label: string, fn: () => void): void {
    this.groupDepth++;
    try {
      fn();
    } catch (e) {
      this.groupDepth--;
      if (this.groupDepth === 0) {
        this.groupDirty = false;
        this.rollback();
      }
      throw e;
    }
    this.groupDepth--;
    if (this.groupDepth === 0 && this.groupDirty) {
      this.groupDirty = false;
      this.history.push(label);
    }
  }
}
