/**
 * Actions: recorded lists of commands, grouped in sets, each with an
 * optional function key. Saved automatically; sets can be saved to and
 * loaded from files.
 */

import * as storage from "./storage";

export interface Step {
  command: string;
  params: Record<string, unknown>;
  label: string;
  enabled: boolean;
  /** Show the command's dialog during playback, starting from these settings. */
  dialog: boolean;
}

export const ACTION_COLORS = ["none", "red", "orange", "yellow", "green", "blue", "violet", "gray"] as const;
export type ActionColor = (typeof ACTION_COLORS)[number];

export interface Action {
  id: string;
  name: string;
  /** Function key combo like "F2", "Shift+F3", "Ctrl+F11", or "". */
  key: string;
  color: ActionColor;
  enabled: boolean;
  steps: Step[];
}

export interface ActionSet {
  id: string;
  name: string;
  open: boolean;
  actions: Action[];
}

let n = 0;
export const uid = (p: string) => `${p}-${Date.now().toString(36)}${(n++).toString(36)}`;

const step = (command: string, label: string, params: Record<string, unknown> = {}, dialog = false): Step => ({ command, label, params, enabled: true, dialog });
const act = (name: string, key: string, color: ActionColor, steps: Step[]): Action => ({ id: uid("a"), name, key, color, enabled: true, steps });

export function defaultSets(): ActionSet[] {
  return [
    {
      id: uid("s"),
      name: "Default Actions",
      open: true,
      actions: [
        act("Cartoonize", "F2", "orange", [step("layer.duplicate", "Duplicate Layer", { name: "Cartoon" }), step("filter.cartoon", "Cartoon", { smooth: 5, levels: 7, lines: 2, lineStrength: 90, detail: 50, sat: 125 })]),
        act("Tri-X Black & White", "F3", "gray", [
          step("image.blackWhite", "Black & White", { reds: 50, yellows: 75, greens: 40, cyans: 50, blues: 15, magentas: 70, contrast: 28, blacks: -10, grain: 38, grainSize: 1.6, grainRough: 60, seed: 4, output: "newLayer" }, true),
        ]),
        act("Sharpen for Web", "F4", "blue", [step("filter.unsharpMask", "Unsharp Mask", { amount: 80, radius: 0.6, threshold: 2 })]),
        act("Soft Glow Portrait", "F6", "violet", [
          step("layer.duplicate", "Duplicate Layer", { name: "Soft Glow" }),
          step("filter.surfaceBlur", "Surface Blur", { radius: 6, threshold: 18 }),
          step("filter.dreamyGlow", "Soft Focus", { radius: 14, amount: 40, brightness: 15 }),
          step("layer.setProperties", "Layer Properties", { opacity: 75 }),
        ]),
        act("Comic Page", "F7", "red", [step("filter.comicBook", "Comic Book", {}, true), step("filter.frame", "Picture Frame", { style: "black", size: 3 })]),
        act("Vintage Postcard", "F8", "yellow", [step("filter.vintage", "Vintage Film", { amount: 100, fade: 45, grain: 25, vignette: 35, seed: 71 }), step("filter.frame", "Picture Frame", { style: "polaroid", size: 5 })]),
        act("Pop Art Quad", "F9", "green", [step("filter.popArtGrid", "Pop Art Grid", { smooth: 2, gap: 8 })]),
        act("Pencil Drawing", "Shift+F2", "none", [step("layer.duplicate", "Duplicate Layer", { name: "Sketch" }), step("filter.pencilSketch", "Pencil Sketch", {}, true)]),
      ],
    },
  ];
}

export class ActionStore {
  sets: ActionSet[];
  recording: { setId: string; actionId: string } | null = null;
  /** Which menu command already uses a key combo (set by the app). */
  shortcutOwner: ((combo: string) => string | null) | null = null;
  playing = false;
  private listeners = new Set<() => void>();

  constructor() {
    this.sets = storage.load<ActionSet[]>("actions", defaultSets());
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    storage.saveSoon("actions", () => this.sets, 200);
    for (const fn of this.listeners) fn();
  }

  findSet(id: string): ActionSet | undefined {
    return this.sets.find((s) => s.id === id);
  }

  findAction(id: string): { set: ActionSet; action: Action } | null {
    for (const set of this.sets) {
      const action = set.actions.find((a) => a.id === id);
      if (action) return { set, action };
    }
    return null;
  }

  byKey(combo: string): Action | null {
    if (!combo) return null;
    for (const s of this.sets) for (const a of s.actions) if (a.key === combo) return a;
    return null;
  }

  newSet(name: string): ActionSet {
    const s = { id: uid("s"), name, open: true, actions: [] };
    this.sets.push(s);
    this.changed();
    return s;
  }

  newAction(setId: string, name: string, key = "", color: ActionColor = "none", index?: number): Action {
    const set = this.findSet(setId) ?? this.sets[0] ?? this.newSet("Set 1");
    const a: Action = { id: uid("a"), name, key, color, enabled: true, steps: [] };
    if (key) this.clearKey(key);
    if (index === undefined) set.actions.push(a);
    else set.actions.splice(index, 0, a);
    set.open = true;
    this.changed();
    return a;
  }

  /** Function keys are unique: taking one frees it elsewhere. */
  clearKey(key: string, except?: string): void {
    for (const s of this.sets) for (const a of s.actions) if (a.key === key && a.id !== except) a.key = "";
  }

  duplicateAction(id: string): Action | null {
    const f = this.findAction(id);
    if (!f) return null;
    const copy: Action = { ...structuredClone(f.action), id: uid("a"), name: `${f.action.name} copy`, key: "" };
    f.set.actions.splice(f.set.actions.indexOf(f.action) + 1, 0, copy);
    this.changed();
    return copy;
  }

  deleteSet(id: string): void {
    this.sets = this.sets.filter((s) => s.id !== id);
    this.changed();
  }

  deleteAction(id: string): void {
    for (const s of this.sets) s.actions = s.actions.filter((a) => a.id !== id);
    if (this.recording?.actionId === id) this.recording = null;
    this.changed();
  }

  moveAction(id: string, toSet: string, index: number): void {
    const f = this.findAction(id);
    const dest = this.findSet(toSet);
    if (!f || !dest) return;
    const from = f.set.actions.indexOf(f.action);
    f.set.actions.splice(from, 1);
    if (f.set === dest && from < index) index--;
    dest.actions.splice(Math.max(0, Math.min(dest.actions.length, index)), 0, f.action);
    this.changed();
  }

  moveStep(actionId: string, from: number, to: number, toAction?: string): void {
    const src = this.findAction(actionId)?.action;
    const dst = toAction ? this.findAction(toAction)?.action : src;
    if (!src || !dst) return;
    const [s] = src.steps.splice(from, 1);
    if (src === dst && from < to) to--;
    dst.steps.splice(Math.max(0, Math.min(dst.steps.length, to)), 0, s);
    this.changed();
  }

  exportSet(id: string): string {
    const s = this.findSet(id);
    return JSON.stringify({ format: "classic-image-editor-actions", version: 1, set: s }, null, 2);
  }

  importSet(text: string): ActionSet {
    const d = JSON.parse(text);
    if (d.format !== "classic-image-editor-actions" || !d.set?.actions) throw new Error("This is not an actions file.");
    const set: ActionSet = { ...d.set, id: uid("s"), open: true };
    for (const a of set.actions) {
      a.id = uid("a");
      if (a.key && this.byKey(a.key)) a.key = "";
      a.steps = (a.steps ?? []).filter((s: Step) => typeof s.command === "string");
    }
    this.sets.push(set);
    this.changed();
    return set;
  }

  reset(): void {
    this.sets = defaultSets();
    this.recording = null;
    this.changed();
  }
}

/** "F2", "Shift+F2", "Ctrl+F2", "Ctrl+Shift+F2". */
export function keyCombo(fkey: string, shift: boolean, ctrl: boolean): string {
  if (!fkey) return "";
  return [ctrl ? "Ctrl" : "", shift ? "Shift" : "", fkey].filter(Boolean).join("+");
}
