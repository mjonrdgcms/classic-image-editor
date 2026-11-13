/**
 * Arrow-key nudges: the Move tool's arrows, Ctrl+arrows with any tool, and
 * arrows with a selection tool (which move the selection outline).
 *
 * Nudges in a row, with nothing else done in between, make one "Nudge"
 * history state. Each press re-runs one move by the total distance from
 * where the run started, so pixels nudged across other pixels and back come
 * out intact (like a floating selection in Photoshop, or a drag), and a
 * mask or selection nudged past the edge of the canvas and back isn't cut
 * off.
 */

import type { App } from "../app";
import type { History } from "../core/history";
import { needsLoading } from "../core/scratch";

/** What the arrows move: the layer, its unlinked mask, the selected pixels, or the selection outline. */
export type NudgeKind = "layer" | "mask" | "pixels" | "outline";

const COMMAND: Record<NudgeKind, string> = {
  layer: "layer.offset",
  mask: "layer.offsetMask",
  pixels: "edit.moveSelection",
  outline: "select.translate",
};

const LABEL: Record<NudgeKind, string> = { layer: "Nudge", mask: "Nudge", pixels: "Nudge", outline: "Nudge Selection" };

/** A nudge that can't be done isn't reported again for this long (a held key repeats). */
const QUIET_MS = 1500;

interface Run {
  history: History;
  kind: NudgeKind;
  /** The layers being moved: a different selection starts a new run. */
  key: string;
  /** The history state the run started from (by id: indexes shift when old states are trimmed). */
  baseId: number;
  /** The state the run's last move made (anything else since then ends the run). */
  stateId: number;
  dx: number;
  dy: number;
}

export class Nudger {
  private run: Run | null = null;
  private pending: { kind: NudgeKind; dx: number; dy: number } | null = null;
  private frame = 0;
  /** A nudge that couldn't be done: a held key doesn't repeat the message. */
  private failed: { key: string; at: number } | null = null;

  constructor(private app: App) {}

  /** What the Move tool's arrows move right now. */
  static targetFor(app: App): NudgeKind {
    const doc = app.doc!;
    const n = doc.activeNode;
    if (doc.editMask && n?.mask && !n.maskLinked && !doc.quickMask) return "mask";
    if (doc.selection && doc.activeLayer && !doc.quickMask) return "pixels";
    return "layer";
  }

  /** Nudge by dx, dy. Several presses within one frame (key repeat) are applied together. */
  nudge(kind: NudgeKind, dx: number, dy: number): void {
    if (this.pending && this.pending.kind !== kind) this.flush();
    this.pending ??= { kind, dx: 0, dy: 0 };
    this.pending.dx += dx;
    this.pending.dy += dy;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  /** Apply the presses waiting for the next frame now. */
  flush(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const p = this.pending;
    this.pending = null;
    const app = this.app;
    const doc = app.doc;
    if (!p || (!p.dx && !p.dy) || !doc) return;
    const h = app.bus.history;
    const key = `${p.kind}:${doc.activeLayerId}:${[...doc.selectedIds].sort((a, b) => a - b).join(",")}`;
    const now = performance.now();
    if (this.failed?.key === key && now - this.failed.at < QUIET_MS) {
      this.failed.at = now;
      return;
    }
    const fail = (msg?: string) => {
      this.run = null;
      this.failed = { key, at: now };
      if (msg) app.toast(msg);
    };
    if (p.kind === "layer" && doc.activeLayer?.isBackground)
      return fail("Could not nudge because the Background layer is locked. Double-click it in the Layers palette to make it a normal layer.");
    const r = this.run;
    const baseIdx = r ? h.states.findIndex((st) => st.id === r.baseId) : -1;
    const continues =
      !!r &&
      baseIdx >= 0 &&
      r.history === h &&
      r.kind === p.kind &&
      r.key === key &&
      h.current?.id === r.stateId &&
      h.index === baseIdx + 1 &&
      !(app.pager && needsLoading(h.states[baseIdx].snapshot));
    let run: Run;
    if (continues) {
      run = r!;
      // Back to where the run started (the History keeps the selection and selected layers), then one move by the total.
      h.jump(baseIdx);
      run.dx += p.dx;
      run.dy += p.dy;
    } else run = { history: h, kind: p.kind, key, baseId: h.current?.id ?? -1, stateId: -1, dx: p.dx, dy: p.dy };
    const ok = app.run(COMMAND[p.kind], { dx: run.dx, dy: run.dy }, { label: LABEL[p.kind], replaces: continues });
    if (!ok) {
      // The run's last state is still there to go forward to: show it again rather than losing it.
      if (continues && h.canRedo()) h.redo();
      return fail();
    }
    this.failed = null;
    run.stateId = h.current!.id;
    this.run = run;
  }
}
