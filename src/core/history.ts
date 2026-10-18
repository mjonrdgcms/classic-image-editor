/**
 * The History palette's model: a list of document states.
 *
 * Each state is a full DocSnapshot, but snapshots share unchanged tiles, so
 * a brush stroke costs only the tiles it touched. Like PS7, stepping back
 * and then doing something new discards the states after the current one.
 */

import type { Document, DocSnapshot } from "./document";

export interface HistoryState {
  label: string;
  snapshot: DocSnapshot;
  /** Unique per state, so "is this the saved state?" survives trimming and clearing. */
  id: number;
}

let nextStateId = 1;

/**
 * Live edits that hold the document in a temporary state (Free Transform
 * hides the pixels it is moving) register a function here that puts the
 * document back. It runs before history moves and before saving or reading
 * the whole document.
 */
export const pendingEdits = new Set<() => void>();
export function settlePendingEdits(): void {
  for (const f of [...pendingEdits]) f();
}

type Listener = () => void;

export class History {
  states: HistoryState[] = [];
  /** Named snapshots shown above the history states. */
  snapshots: HistoryState[] = [];
  index = -1;
  /** The document as opened (or created), kept even when older states are trimmed or cleared. */
  opened: HistoryState | null = null;
  /** PS7's default is 20; memory is cheap enough now to keep more. */
  maxStates = 50;
  /** Whether the last history move was an undo (for PS7's Ctrl+Z toggle). */
  lastWasUndo = false;
  private listeners = new Set<Listener>();

  constructor(private doc: Document) {}

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  reset(doc: Document, label: string): void {
    this.doc = doc;
    this.states = [{ label, snapshot: doc.snapshot(), id: nextStateId++ }];
    this.opened = this.states[0];
    this.snapshots = [];
    this.index = 0;
    this.lastWasUndo = false;
    this.changed();
  }

  push(label: string): void {
    this.states.length = this.index + 1;
    this.states.push({ label, snapshot: this.doc.snapshot(), id: nextStateId++ });
    while (this.states.length > this.maxStates) this.states.shift();
    this.index = this.states.length - 1;
    this.lastWasUndo = false;
    this.changed();
  }

  get current(): HistoryState | undefined {
    return this.states[this.index];
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.states.length - 1;
  }

  undo(): void {
    if (!this.canUndo()) return;
    this.jump(this.index - 1);
    this.lastWasUndo = true;
  }

  redo(): void {
    if (!this.canRedo()) return;
    this.jump(this.index + 1);
    this.lastWasUndo = false;
  }

  /** PS7 Ctrl+Z: undo, or redo if the last move was an undo. */
  toggle(): void {
    if (this.lastWasUndo && this.canRedo()) this.redo();
    else this.undo();
  }

  jump(i: number): void {
    if (i < 0 || i >= this.states.length || i === this.index) return;
    settlePendingEdits();
    this.index = i;
    this.doc.restore(this.states[i].snapshot);
    this.changed();
  }

  /** History palette: "Create new snapshot". */
  addSnapshot(name?: string): string {
    settlePendingEdits();
    const n = name ?? `Snapshot ${this.snapshots.length + 1}`;
    this.snapshots.push({ label: n, snapshot: this.doc.snapshot(), id: nextStateId++ });
    this.changed();
    return n;
  }

  /** Go back to a snapshot; recorded as a new history state so it can be undone. */
  restoreSnapshot(i: number): void {
    const s = this.snapshots[i];
    if (!s) return;
    settlePendingEdits();
    this.doc.restore(s.snapshot);
    this.push(s.label);
  }

  deleteSnapshot(i: number): void {
    this.snapshots.splice(i, 1);
    this.changed();
  }

  /** Clear History: keep only the current state. */
  clear(): void {
    const cur = this.current;
    if (!cur) return;
    this.states = [cur];
    this.index = 0;
    this.lastWasUndo = false;
    this.changed();
  }

  /** Re-sync the document with the current state (used to roll back failures). */
  revert(): void {
    settlePendingEdits();
    const s = this.current;
    if (s) this.doc.restore(s.snapshot);
  }
}
