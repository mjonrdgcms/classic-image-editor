/**
 * The Actions palette: record what you do, play it back with a click or a
 * function key, turn individual steps (and their dialogs) on and off,
 * reorder by dragging, and switch to Button Mode for a grid of big
 * colored buttons.
 */

import type { App } from "../app";
import { alertDialog, confirmDialog, el, formDialog } from "./dialogs";
import { ICONS } from "./icons";
import type { MenuItem } from "./menus";
import { ACTION_COLORS, keyCombo, type Action, type ActionColor, type ActionSet, type ActionStore, type Step } from "./actionstore";
import { pickText, saveText } from "../io/files";
import * as storage from "./storage";

const PLAY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const STOP = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor"/></svg>';
const REC = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="currentColor"/></svg>';
const DLG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="9" rx="1" fill="none" stroke="currentColor"/><path d="M2.5 6h11" stroke="currentColor"/></svg>';
const FKEYS = ["", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];
const COLOR_LABELS: Record<ActionColor, string> = { none: "None", red: "Red", orange: "Orange", yellow: "Yellow", green: "Green", blue: "Blue", violet: "Violet", gray: "Gray" };

/** Commands that are never worth recording. */
// Face Swap carries pixels from another image, so it can't replay.
const SKIP = new Set(["layer.select", "app.noop", "layer.faceSwap"]);
const ALWAYS = new Set(["color.set", "color.swap", "color.reset"]);

export interface DialogHooks {
  filter(id: string, params: Record<string, unknown>): Promise<boolean>;
  blackWhite(params: Record<string, unknown>): Promise<boolean>;
}

export class ActionPlayer {
  private stop = false;
  /** Pause between steps when playing step by step (ms). */
  delay = storage.load<number>("actionsDelay", 0);

  constructor(
    private app: App,
    readonly store: ActionStore,
    private dialogs: DialogHooks,
  ) {
    // The recorder: every recorded command becomes a step.
    app.bus.onCommand((rec) => {
      const r = store.recording;
      if (!r || store.playing) return;
      const def = app.bus.get(rec.name);
      if (!def || SKIP.has(rec.name) || (!def.history && !ALWAYS.has(rec.name))) return;
      const a = store.findAction(r.actionId)?.action;
      if (!a) return;
      const params = { ...rec.params };
      // Ids belong to one document; drop the ones that just mean "the active layer".
      if ("id" in params && params.id === app.doc?.activeLayerId) delete params.id;
      // A drag with the eyedropper sets the color many times: keep the last.
      const prev = a.steps[a.steps.length - 1];
      if (rec.name === "color.set" && prev?.command === "color.set") {
        prev.params = params;
        store.changed();
        return;
      }
      a.steps.push({ command: rec.name, params, label: rec.label, enabled: true, dialog: false });
      store.changed();
    });
  }

  hasDialog(command: string): boolean {
    return (command.startsWith("filter.") && command !== "filter.fade") || command === "image.blackWhite";
  }

  requestStop(): void {
    this.stop = true;
  }

  /** Play an action. Resolves with an error message if a step failed. */
  async play(a: Action, opts: { fromStep?: number; suppressDialogs?: boolean; onlyStep?: number } = {}): Promise<string | null> {
    const app = this.app;
    if (this.store.playing) return "An action is already playing.";
    if (!app.doc) return "Open an image first.";
    this.store.playing = true;
    this.stop = false;
    this.store.changed();
    try {
      const steps = a.steps.map((s, i) => [s, i] as const).filter(([s, i]) => (opts.onlyStep !== undefined ? i === opts.onlyStep : i >= (opts.fromStep ?? 0) && s.enabled));
      for (const [s, i] of steps) {
        if (this.stop) return "Stopped.";
        if (!app.doc) return `Step ${i + 1} (${s.label}) needs an open image.`;
        try {
          if (s.dialog && !opts.suppressDialogs && this.hasDialog(s.command)) {
            const ok = s.command === "image.blackWhite" ? await this.dialogs.blackWhite(s.params) : await this.dialogs.filter(s.command.slice(7), s.params);
            if (!ok) return "Stopped.";
          } else {
            const before: unknown = app.doc;
            const pending = app.bus.prepare(s.command, s.params);
            if (pending) await pending;
            if (app.doc !== before) return `Step ${i + 1} (${s.label}): the image changed while it was getting ready.`;
            app.bus.dispatch(s.command, s.params);
          }
        } catch (e) {
          return `Step ${i + 1} (${s.label}) could not run: ${(e as Error).message}.`;
        }
        if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
        else await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      return null;
    } finally {
      this.store.playing = false;
      this.store.changed();
    }
  }

  async playWithMessage(a: Action, opts: { fromStep?: number; onlyStep?: number } = {}): Promise<void> {
    const err = await this.play(a, opts);
    if (err && err !== "Stopped.") await alertDialog("Action Stopped", `"${a.name}": ${err}`);
  }

  startRecording(actionId: string): void {
    this.store.recording = { setId: this.store.findAction(actionId)?.set.id ?? "", actionId };
    this.store.changed();
  }

  stopRecording(): void {
    this.store.recording = null;
    this.store.changed();
  }
}

/** New Action / Action Options dialog. */
export async function actionOptions(store: ActionStore, a: Action | null, setId?: string): Promise<{ name: string; set: string; key: string; color: ActionColor } | null> {
  const parts = (a?.key ?? "").split("+");
  const fk = parts.pop() ?? "";
  const r = await formDialog(a ? "Action Options" : "New Action", [
    { key: "name", label: "Name", type: "text", value: a?.name ?? `Action ${store.sets.reduce((n, s) => n + s.actions.length, 0) + 1}` },
    { key: "set", label: "Set", type: "select", value: setId ?? store.findAction(a?.id ?? "")?.set.id ?? store.sets[0]?.id ?? "", options: store.sets.map((s) => [s.id, s.name]) },
    { key: "fkey", label: "Function Key", type: "select", value: fk, options: FKEYS.map((k) => [k, k || "None"]) },
    { key: "shift", label: "Shift", type: "checkbox", value: parts.includes("Shift") },
    { key: "ctrl", label: "Control", type: "checkbox", value: parts.includes("Ctrl") },
    { key: "color", label: "Color", type: "select", value: a?.color ?? "none", options: ACTION_COLORS.map((c) => [c, COLOR_LABELS[c]]) },
  ]);
  if (!r || !String(r.name).trim()) return null;
  const key = keyCombo(r.fkey, !!r.shift, !!r.ctrl);
  const used = key ? store.shortcutOwner?.(key) : null;
  if (used && !(await confirmDialog("Shortcut in Use", `${key} is the shortcut for ${used}. The action will take it over while it has this key. Use it anyway?`, "Use It"))) return null;
  const taken = key ? store.byKey(key) : null;
  if (taken && taken.id !== a?.id && !(await confirmDialog("Function Key in Use", `${key} already plays "${taken.name}". Use it for this action instead?`, "Use It"))) return null;
  return { name: String(r.name).trim(), set: r.set, key, color: r.color };
}

export function actionsPalette(app: App, player: ActionPlayer, extra: { batch(): void }) {
  const store = player.store;
  let buttonMode = storage.load<boolean>("actionsButtons", false);
  let selected: { kind: "set" | "action" | "step"; set: string; action?: string; step?: number } | null = null;
  const open = new Set<string>();
  const list = el("div", { class: "act-list", role: "tree", "aria-label": "Actions" });

  const sel = () => {
    if (!selected) return { set: store.sets[0] ?? null, action: null as Action | null };
    const set = store.findSet(selected.set) ?? null;
    const action = selected.action ? (store.findAction(selected.action)?.action ?? null) : null;
    return { set, action };
  };

  const summary = (s: Step) => {
    const keys = Object.entries(s.params).filter(([, v]) => v !== undefined && typeof v !== "object");
    return keys.map(([k, v]) => `${k}: ${v}`).join(", ");
  };

  // ---------------------------------------------------------------- drag & drop
  let dragging: { kind: "action"; id: string } | { kind: "step"; action: string; index: number } | null = null;
  const dropZone = (row: HTMLElement, onDrop: (after: boolean) => void, accept: () => boolean) => {
    row.addEventListener("dragover", (e) => {
      if (!accept()) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      row.classList.toggle("drop-above", !after);
      row.classList.toggle("drop-below", after);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-above", "drop-below"));
    row.addEventListener("drop", (e) => {
      if (!accept()) return;
      e.preventDefault();
      const after = row.classList.contains("drop-below");
      row.classList.remove("drop-above", "drop-below");
      onDrop(after);
      dragging = null;
    });
  };

  // ---------------------------------------------------------------- render
  const toggleBox = (on: boolean, title: string, fn: () => void, partial = false) => {
    const b = el("button", { type: "button", class: "act-toggle" + (on ? " on" : "") + (partial ? " partial" : ""), title, "aria-pressed": on, text: on ? "✓" : "" });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const dlgBox = (on: boolean | null, title: string, fn: () => void) => {
    const b = el("button", { type: "button", class: "act-dlg" + (on ? " on" : "") + (on === null ? " none" : ""), title, "aria-pressed": !!on, disabled: on === null });
    if (on !== null) b.innerHTML = DLG;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const tri = (isOpen: boolean, fn: () => void) => {
    const b = el("button", { type: "button", class: "act-tri", "aria-label": isOpen ? "Collapse" : "Expand" });
    b.innerHTML = isOpen ? ICONS.setOpen : ICONS.setClosed;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const isSel = (k: string, set: string, action?: string, step?: number) => selected?.kind === k && selected.set === set && selected.action === action && selected.step === step;

  function renderList() {
    list.textContent = "";
    list.classList.toggle("buttons", buttonMode);
    if (buttonMode) {
      for (const set of store.sets)
        for (const a of set.actions) {
          const b = el("button", { type: "button", class: `act-button c-${a.color}`, title: a.steps.map((s) => s.label).join(" → ") }, el("span", { class: "nm", text: a.name }), a.key ? el("kbd", { text: a.key }) : null);
          b.addEventListener("click", () => void player.playWithMessage(a));
          list.append(b);
        }
      if (!list.children.length) list.append(el("p", { class: "fl-empty", text: "No actions yet. Turn off Button Mode to record one." }));
      return;
    }
    for (const set of store.sets) {
      const setRow = el(
        "div",
        { class: "act-row act-set" + (isSel("set", set.id) ? " sel" : ""), role: "treeitem", "aria-expanded": set.open },
        toggleBox(set.actions.every((a) => a.enabled), "Turn the set's actions on or off", () => {
          const v = !set.actions.every((a) => a.enabled);
          set.actions.forEach((a) => (a.enabled = v));
          store.changed();
        }, set.actions.some((a) => a.enabled) && !set.actions.every((a) => a.enabled)),
        dlgBox(null, "", () => {}),
        tri(set.open, () => {
          set.open = !set.open;
          store.changed();
        }),
        el("span", { class: "act-icon" }, (() => {
          const s = el("span");
          s.innerHTML = ICONS.folder;
          return s;
        })()),
        el("span", { class: "act-name", text: set.name }),
      );
      setRow.addEventListener("click", () => {
        selected = { kind: "set", set: set.id };
        renderList();
      });
      setRow.addEventListener("dblclick", async () => {
        const r = await formDialog("Set Options", [{ key: "name", label: "Name", type: "text", value: set.name }]);
        if (r && String(r.name).trim()) {
          set.name = String(r.name).trim();
          store.changed();
        }
      });
      dropZone(setRow, () => dragging?.kind === "action" && store.moveAction(dragging.id, set.id, set.actions.length), () => dragging?.kind === "action");
      list.append(setRow);
      if (!set.open) continue;
      set.actions.forEach((a, ai) => {
        const rec = store.recording?.actionId === a.id;
        const anyDlg = a.steps.some((s) => player.hasDialog(s.command));
        const allDlg = a.steps.filter((s) => player.hasDialog(s.command)).every((s) => s.dialog);
        const aRow = el(
          "div",
          { class: "act-row act-action" + (isSel("action", set.id, a.id) ? " sel" : "") + (rec ? " recording" : "") + (a.enabled ? "" : " off"), role: "treeitem", draggable: "true", "aria-expanded": open.has(a.id) },
          toggleBox(a.enabled, "Include this action (turn off to skip it)", () => {
            a.enabled = !a.enabled;
            store.changed();
          }),
          dlgBox(anyDlg ? allDlg && anyDlg : null, "Show dialogs when playing", () => {
            const v = !allDlg;
            a.steps.forEach((s) => player.hasDialog(s.command) && (s.dialog = v));
            store.changed();
          }),
          tri(open.has(a.id), () => {
            open.has(a.id) ? open.delete(a.id) : open.add(a.id);
            renderList();
          }),
          el("span", { class: `act-chip c-${a.color}` }),
          el("span", { class: "act-name", text: a.name }),
          rec ? el("span", { class: "act-rec", text: "REC" }) : null,
          a.key ? el("kbd", { class: "act-key", text: a.key }) : null,
        );
        aRow.addEventListener("click", () => {
          selected = { kind: "action", set: set.id, action: a.id };
          renderList();
        });
        aRow.addEventListener("dblclick", () => void editOptions(a));
        aRow.addEventListener("dragstart", (e) => {
          dragging = { kind: "action", id: a.id };
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("text/plain", a.name);
        });
        dropZone(
          aRow,
          (after) => {
            if (dragging?.kind === "action") store.moveAction(dragging.id, set.id, ai + (after ? 1 : 0));
            else if (dragging?.kind === "step") store.moveStep(dragging.action, dragging.index, after ? a.steps.length : 0, a.id);
          },
          () => !!dragging,
        );
        list.append(aRow);
        if (!open.has(a.id)) return;
        if (!a.steps.length) list.append(el("div", { class: "act-row act-step act-emptystep", text: rec ? "Recording: do something to add steps." : "No steps. Select this action and press Record." }));
        a.steps.forEach((s, si) => {
          const sRow = el(
            "div",
            { class: "act-row act-step" + (isSel("step", set.id, a.id, si) ? " sel" : "") + (s.enabled ? "" : " off"), role: "treeitem", draggable: "true", title: summary(s) || s.label },
            toggleBox(s.enabled, "Include this step", () => {
              s.enabled = !s.enabled;
              store.changed();
            }),
            dlgBox(player.hasDialog(s.command) ? s.dialog : null, "Show this step's dialog when playing", () => {
              s.dialog = !s.dialog;
              store.changed();
            }),
            el("span", { class: "act-name" }, el("span", { text: s.label }), summary(s) ? el("span", { class: "act-params", text: summary(s) }) : null),
          );
          sRow.addEventListener("click", () => {
            selected = { kind: "step", set: set.id, action: a.id, step: si };
            renderList();
          });
          sRow.addEventListener("dblclick", () => void rerecordStep(a, si));
          sRow.addEventListener("dragstart", (e) => {
            dragging = { kind: "step", action: a.id, index: si };
            e.dataTransfer!.effectAllowed = "move";
            e.dataTransfer!.setData("text/plain", s.label);
          });
          dropZone(sRow, (after) => dragging?.kind === "step" && store.moveStep(dragging.action, dragging.index, si + (after ? 1 : 0), a.id), () => dragging?.kind === "step");
          list.append(sRow);
        });
      });
    }
    if (!store.sets.length) list.append(el("p", { class: "fl-empty", text: "No action sets. Use the New Set button below." }));
  }

  // ---------------------------------------------------------------- commands
  async function editOptions(a: Action) {
    const r = await actionOptions(store, a);
    if (!r) return;
    if (r.key) store.clearKey(r.key, a.id);
    Object.assign(a, { name: r.name, key: r.key, color: r.color });
    const cur = store.findAction(a.id)!;
    if (cur.set.id !== r.set) store.moveAction(a.id, r.set, store.findSet(r.set)!.actions.length);
    store.changed();
  }

  async function rerecordStep(a: Action, i: number) {
    const s = a.steps[i];
    if (!player.hasDialog(s.command) || !app.doc) return;
    // Open the dialog with the recorded settings; keep what is chosen, without applying.
    const done = async (_id: string, params: Record<string, unknown>) => {
      s.params = params;
      store.changed();
      return true;
    };
    if (s.command === "image.blackWhite") {
      const { blackWhiteLab } = await import("./bwlab");
      await blackWhiteLab(app, s.params as never, (params) => {
        s.params = params;
        store.changed();
        return true;
      });
      return;
    }
    const { filterLibrary } = await import("./filterlib");
    await filterLibrary(app, filterRunnerRef!, { filter: s.command.slice(7), compact: true, params: s.params, onApply: done });
  }

  async function newAction() {
    const r = await actionOptions(store, null, sel().set?.id);
    if (!r) return;
    const a = store.newAction(r.set, r.name, r.key, r.color);
    open.add(a.id);
    selected = { kind: "action", set: r.set, action: a.id };
    player.startRecording(a.id);
  }
  async function newSet() {
    const r = await formDialog("New Set", [{ key: "name", label: "Name", type: "text", value: `Set ${store.sets.length + 1}` }]);
    if (r && String(r.name).trim()) {
      const s = store.newSet(String(r.name).trim());
      selected = { kind: "set", set: s.id };
      renderList();
    }
  }
  async function deleteSelected() {
    if (!selected) return;
    if (selected.kind === "step" && selected.action !== undefined) {
      const a = store.findAction(selected.action)?.action;
      if (a && selected.step !== undefined) {
        a.steps.splice(selected.step, 1);
        selected = { kind: "action", set: selected.set, action: a.id };
        store.changed();
      }
      return;
    }
    if (selected.kind === "action" && selected.action) {
      const a = store.findAction(selected.action)?.action;
      if (a && (await confirmDialog("Delete Action", `Delete the action "${a.name}"?`, "Delete"))) {
        store.deleteAction(a.id);
        selected = null;
      }
      return;
    }
    const set = store.findSet(selected.set);
    if (set && (await confirmDialog("Delete Set", `Delete the set "${set.name}" and its ${set.actions.length} actions?`, "Delete"))) {
      store.deleteSet(set.id);
      selected = null;
    }
  }
  function play() {
    if (!selected) return;
    const a = selected.action ? store.findAction(selected.action)?.action : null;
    if (!a) return app.toast("Select an action to play.");
    if (selected.kind === "step") void player.playWithMessage(a, { fromStep: selected.step });
    else void player.playWithMessage(a);
  }
  function record() {
    if (store.recording) return;
    const a = selected?.action ? store.findAction(selected.action)?.action : null;
    if (!a) return void newAction();
    open.add(a.id);
    player.startRecording(a.id);
  }

  // ---------------------------------------------------------------- footer & menu
  const btn = (svg: string, title: string, fn: () => void, cls = "") => {
    const b = el("button", { type: "button", class: "icon-btn " + cls, title, "aria-label": title });
    b.innerHTML = svg;
    b.addEventListener("click", fn);
    return b;
  };
  const stopB = btn(STOP, "Stop playing/recording", () => {
    if (store.recording) player.stopRecording();
    else player.requestStop();
  });
  const recB = btn(REC, "Begin recording", record, "act-recbtn");
  const playB = btn(PLAY, "Play selection", play);
  const footer = el(
    "div",
    { style: "display:contents" },
    stopB,
    recB,
    playB,
    btn(ICONS.folder, "Create new set", () => void newSet()),
    btn(ICONS.newLayer, "Create new action", () => void newAction()),
    btn(ICONS.trash, "Delete", () => void deleteSelected()),
  );

  const menu = (): MenuItem[] => {
    const { set, action } = sel();
    return [
      {
        label: "Button Mode",
        checked: buttonMode,
        run: () => {
          buttonMode = !buttonMode;
          storage.save("actionsButtons", buttonMode);
          renderList();
        },
      },
      "-",
      { label: "New Action...", run: () => void newAction() },
      { label: "New Set...", run: () => void newSet() },
      { label: "Duplicate", enabled: !!action, run: () => action && store.duplicateAction(action.id) },
      { label: "Delete", enabled: !!selected, run: () => void deleteSelected() },
      { label: "Play", enabled: !!action && !!app.doc, run: play },
      "-",
      { label: "Start Recording", enabled: !store.recording, run: record },
      {
        label: "Record Again...",
        enabled: selected?.kind === "step",
        run: () => {
          const a = selected?.action ? store.findAction(selected.action)?.action : null;
          if (a && selected?.step !== undefined) void rerecordStep(a, selected.step);
        },
      },
      "-",
      { label: "Action Options...", enabled: !!action, run: () => action && void editOptions(action) },
      {
        label: "Playback Options...",
        run: async () => {
          const r = await formDialog("Playback Options", [
            { key: "mode", label: "Performance", type: "select", value: player.delay ? (player.delay >= 1000 ? "pause" : "step") : "fast", options: [["fast", "Accelerated"], ["step", "Step by Step"], ["pause", "Pause For 1 Second"]] },
          ]);
          if (!r) return;
          player.delay = r.mode === "fast" ? 0 : r.mode === "step" ? 250 : 1000;
          storage.save("actionsDelay", player.delay);
        },
      },
      "-",
      { label: "Batch...", run: () => extra.batch() },
      "-",
      {
        label: "Save Actions...",
        enabled: !!set,
        run: async () => {
          if (set) await saveText(store.exportSet(set.id), `${set.name}.actions.json`);
        },
      },
      {
        label: "Load Actions...",
        run: async () => {
          const t = await pickText([".json"]);
          if (!t) return;
          try {
            store.importSet(t);
          } catch (e) {
            app.toast((e as Error).message);
          }
        },
      },
      {
        label: "Reset Actions",
        run: async () => {
          if (await confirmDialog("Reset Actions", "Replace all actions with the default set?", "Reset")) store.reset();
        },
      },
      {
        label: "Clear All Actions",
        run: async () => {
          if (await confirmDialog("Clear All Actions", "Delete every action set?", "Delete All")) {
            store.sets = [];
            store.changed();
          }
        },
      },
    ];
  };

  const syncButtons = () => {
    recB.classList.toggle("active", !!store.recording);
    playB.disabled = store.playing || !!store.recording;
    stopB.disabled = !store.playing && !store.recording;
  };
  store.on(() => {
    renderList();
    syncButtons();
  });
  renderList();
  syncButtons();
  return { body: list, footer, menu, newAction, play: (a: Action) => player.playWithMessage(a) };
}

/** Set by main.ts so the palette can open filter dialogs for re-recording. */
export let filterRunnerRef: import("./filterrun").FilterRunner | null = null;
export function setFilterRunner(r: import("./filterrun").FilterRunner): void {
  filterRunnerRef = r;
}

export type { ActionSet };
