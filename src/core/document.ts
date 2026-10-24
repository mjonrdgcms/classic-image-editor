/**
 * The document model: canvas, layer stack, selection, colors, guides.
 *
 * The stack is a list of nodes, bottom to top. A node is a Layer or a layer
 * set (Group) holding layers; as in PS7, sets don't nest. `doc.layers` gives
 * the flattened list of pixel layers for code that doesn't care about sets.
 *
 * Every layer owns a TileGrid the size of the canvas plus an integer offset,
 * and optionally a layer mask in the same (layer) space so it moves with the
 * layer. Snapshots share tiles copy-on-write, so History costs memory only
 * for tiles that actually changed.
 */

import type { LayerStyle } from "./styles";
import type { ShapeSpec } from "./shapes";
import type { VecPath } from "./vector";
import { effectiveMask } from "./maskfx";
import type { TextSpec } from "./text";
import type { BlendMode } from "./blend";
import { compositeRegion } from "./composite";
import { Mask } from "./mask";
import { Rect, TILE, TileGrid, rectIntersect } from "./tiles";

export type RGBA = [number, number, number, number];
export type GroupBlend = BlendMode | "passThrough";

let nextNodeId = 1;
const claimId = (id?: number) => {
  const v = id ?? nextNodeId++;
  if (v >= nextNodeId) nextNodeId = v + 1;
  return v;
};

export interface Locks {
  /** Painting keeps existing alpha. */
  transparency: boolean;
  /** No painting or pixel edits. */
  pixels: boolean;
  /** No moving. */
  position: boolean;
}

export interface LayerProps {
  id: number;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  offsetX: number;
  offsetY: number;
  /** The Background layer: opaque, locked in place, always at the bottom. */
  isBackground: boolean;
  /** Clipped to the layer below (PS7 "Group with Previous"). */
  clipped: boolean;
  maskEnabled: boolean;
  /** Non-destructive mask density 0..1 (1 = as painted). */
  maskDensity: number;
  /** Non-destructive mask feather radius in px. */
  maskFeather: number;
  /** The mask moves with the layer (the chain icon). */
  maskLinked: boolean;
  locks: Locks;
  /** Layers sharing a link id move together. */
  linkId: number | null;
  /** Type layer settings (editable text), or null for a pixel layer. Never mutated; replaced. */
  text: TextSpec | null;
  /** Layer effects (drop shadow, stroke...), or null. Never mutated; replaced. */
  style: LayerStyle | null;
  /** Shape layer: its vector path and fill color, or null. Never mutated; replaced. */
  shape: ShapeSpec | null;
}

/**
 * Anything that can carry a layer mask: a layer, or a layer set (whose
 * mask is in canvas space). Mask coordinates are host space.
 */
export interface MaskHost {
  readonly kind: "layer" | "group";
  id: number;
  name: string;
  mask: Mask | null;
  maskEnabled: boolean;
  maskDensity: number;
  maskFeather: number;
  maskLinked: boolean;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly activeMask: Mask | null;
}

export class Layer implements LayerProps {
  readonly kind = "layer" as const;
  id: number;
  name: string;
  visible = true;
  opacity = 1;
  blendMode: BlendMode = "normal";
  offsetX = 0;
  offsetY = 0;
  isBackground = false;
  clipped = false;
  maskEnabled = true;
  maskDensity = 1;
  maskFeather = 0;
  maskLinked = true;
  locks: Locks = { transparency: false, pixels: false, position: false };
  linkId: number | null = null;
  text: TextSpec | null = null;
  style: LayerStyle | null = null;
  shape: ShapeSpec | null = null;
  grid: TileGrid;
  /** Layer mask in layer space (same size as grid), or null. */
  mask: Mask | null = null;

  constructor(width: number, height: number, name: string, id?: number) {
    this.id = claimId(id);
    this.name = name;
    this.grid = new TileGrid(width, height);
  }

  props(): LayerProps {
    const { id, name, visible, opacity, blendMode, offsetX, offsetY, isBackground, clipped, maskEnabled, maskDensity, maskFeather, maskLinked, linkId, text, style, shape } = this;
    return { id, name, visible, opacity, blendMode, offsetX, offsetY, isBackground, clipped, maskEnabled, maskDensity, maskFeather, maskLinked, locks: { ...this.locks }, linkId, text, style, shape };
  }

  bounds(): Rect {
    return { x: this.offsetX, y: this.offsetY, w: this.grid.width, h: this.grid.height };
  }

  /** The mask as compositing sees it (with Density and Feather), or null when off. */
  get activeMask(): Mask | null {
    return this.mask && this.maskEnabled ? effectiveMask(this.mask, this.maskDensity, this.maskFeather) : null;
  }
}

export interface GroupProps {
  id: number;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: GroupBlend;
  /** Palette disclosure state. */
  expanded: boolean;
  maskEnabled: boolean;
  maskDensity: number;
  maskFeather: number;
  maskLinked: boolean;
}

export class Group implements GroupProps {
  readonly kind = "group" as const;
  id: number;
  name: string;
  visible = true;
  opacity = 1;
  blendMode: GroupBlend = "passThrough";
  expanded = true;
  /** Bottom to top. */
  children: Layer[] = [];
  /** A set's mask covers everything in it (canvas space). */
  mask: Mask | null = null;
  maskEnabled = true;
  maskDensity = 1;
  maskFeather = 0;
  maskLinked = true;
  readonly offsetX = 0;
  readonly offsetY = 0;

  get activeMask(): Mask | null {
    return this.mask && this.maskEnabled ? effectiveMask(this.mask, this.maskDensity, this.maskFeather) : null;
  }

  constructor(name: string, id?: number) {
    this.id = claimId(id);
    this.name = name;
  }

  props(): GroupProps {
    const { id, name, visible, opacity, blendMode, expanded, maskEnabled, maskDensity, maskFeather, maskLinked } = this;
    return { id, name, visible, opacity, blendMode, expanded, maskEnabled, maskDensity, maskFeather, maskLinked };
  }
}

export type Node = Layer | Group;

interface LayerSnap {
  kind: "layer";
  props: LayerProps;
  grid: TileGrid;
  mask: Mask | null;
}
interface GroupSnap {
  kind: "group";
  props: GroupProps;
  children: LayerSnap[];
  mask: Mask | null;
}
type NodeSnap = LayerSnap | GroupSnap;

export interface Guides {
  /** y positions of horizontal guides. */
  h: number[];
  /** x positions of vertical guides. */
  v: number[];
}

/** A sticky note on the canvas (Notes tool). Not printed or exported. */
export interface Note {
  id: number;
  x: number;
  y: number;
  text: string;
  author: string;
  color: string;
}

/** A saved path in the Paths palette (the Work Path is the scratch one). */
export interface DocPath {
  id: number;
  name: string;
  path: VecPath;
  work: boolean;
}

/** A web slice (Slice tool): an area exported as its own picture. */
export interface Slice {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

export interface DocSnapshot {
  width: number;
  height: number;
  resolution?: number;
  stack: NodeSnap[];
  activeId: number;
  /** Other selected layers and sets. */
  selected?: number[];
  notes?: Note[];
  slices?: Slice[];
  paths?: DocPath[];
  selection: Mask | null;
  lastSelection: Mask | null;
  guides: Guides;
  quickMask: boolean;
}

type Listener = (ev: DocEvent) => void;

export type DocEvent =
  /** Pixels changed in a canvas region (or everywhere when rect is null). */
  | { type: "pixels"; rect: Rect | null }
  /** Layer list, order or properties changed. */
  | { type: "layers" }
  | { type: "selection" }
  | { type: "colors" }
  | { type: "guides" }
  | { type: "size" };

export class Document {
  width: number;
  height: number;
  /** Pixels per inch: only changes print size (and rulers in inches, cm...), never the pixels. */
  resolution = 72;
  stack: Node[] = [];
  private active = 0;
  /**
   * Other layers and sets selected along with the active one (Ctrl- or
   * Shift-click in the Layers palette). Changing the active layer any other
   * way leaves just that one selected.
   */
  readonly selectedIds = new Set<number>();

  /** Active layer or set id. */
  get activeLayerId(): number {
    return this.active;
  }
  set activeLayerId(id: number) {
    this.active = id;
    this.selectedIds.clear();
  }

  /** Make `id` active with `others` selected too. */
  selectNodes(id: number, others: Iterable<number>): void {
    this.active = id;
    this.selectedIds.clear();
    for (const o of others) if (o !== id && this.nodeById(o)) this.selectedIds.add(o);
  }

  isSelected(id: number): boolean {
    return id === this.active || this.selectedIds.has(id);
  }

  /** Every node in palette order from the bottom: each set, then its contents. */
  get flatNodes(): Node[] {
    const out: Node[] = [];
    for (const n of this.stack) {
      out.push(n);
      if (n.kind === "group") out.push(...n.children);
    }
    return out;
  }

  /** The selected layers and sets (the active one included), bottom to top. */
  get selectedNodes(): Node[] {
    return this.flatNodes.filter((n) => this.isSelected(n.id));
  }

  /** The pixel layers the selection covers (sets count as their contents), bottom to top, no repeats. */
  get selectedLayers(): Layer[] {
    const ids = new Set<number>();
    for (const n of this.selectedNodes) for (const l of n.kind === "group" ? n.children : [n]) ids.add(l.id);
    return this.layers.filter((l) => ids.has(l.id));
  }
  selection: Mask | null = null;
  /** For Select > Reselect. */
  lastSelection: Mask | null = null;
  guides: Guides = { h: [], v: [] };
  notes: Note[] = [];
  slices: Slice[] = [];
  /** Paths palette contents. Entries are never mutated; replaced. */
  paths: DocPath[] = [];
  /** Color Sampler tool points (up to four), shown in the Info palette. Not recorded. */
  samplers: { x: number; y: number }[] = [];
  /** Quick Mask mode: painting edits the selection, shown as a red overlay. */
  quickMask = false;
  /** Painting targets the active layer's mask instead of its pixels (not recorded). */
  editMask = false;
  foreground: RGBA = [0, 0, 0, 255];
  background: RGBA = [255, 255, 255, 255];
  name: string;
  sourceName: string | null = null;
  /** Where the document was last saved as (or opened from) a .cie file, on the desktop. */
  filePath: string | null = null;
  private listeners = new Set<Listener>();

  constructor(width: number, height: number, name = "Untitled-1") {
    this.width = width;
    this.height = height;
    this.name = name;
  }

  // ---------- events ----------

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev: DocEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  /** Bumped whenever any pixels may have changed (caches of the composite key on it). */
  pixelRev = 0;

  dirty(rect: Rect | null): void {
    this.pixelRev++;
    if (rect) {
      // A feathered mask spreads an edit (to the mask or under it) by about 3 sigma.
      let f = 0;
      for (const n of this.stack) {
        if (n.mask && n.maskEnabled) f = Math.max(f, n.maskFeather);
        if (n.kind === "group") for (const c of n.children) if (c.mask && c.maskEnabled) f = Math.max(f, c.maskFeather);
      }
      if (f > 0) {
        const pad = Math.ceil(f * 1.5) + 2;
        rect = { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
      }
      const clip = rectIntersect(rect, { x: 0, y: 0, w: this.width, h: this.height });
      if (!clip) return;
      rect = clip;
    }
    this.emit({ type: "pixels", rect });
  }

  // ---------- nodes ----------

  /** All pixel layers, bottom to top, flattening sets. */
  get layers(): Layer[] {
    const out: Layer[] = [];
    for (const n of this.stack) {
      if (n.kind === "layer") out.push(n);
      else out.push(...n.children);
    }
    return out;
  }

  get groups(): Group[] {
    return this.stack.filter((n): n is Group => n.kind === "group");
  }

  get activeNode(): Node | undefined {
    return this.nodeById(this.activeLayerId);
  }

  /** The active pixel layer (undefined when a set is selected). */
  get activeLayer(): Layer | undefined {
    const n = this.activeNode;
    return n?.kind === "layer" ? n : undefined;
  }

  nodeById(id: number): Node | undefined {
    for (const n of this.stack) {
      if (n.id === id) return n;
      if (n.kind === "group") for (const c of n.children) if (c.id === id) return c;
    }
    return undefined;
  }

  layerById(id: number): Layer | undefined {
    const n = this.nodeById(id);
    return n?.kind === "layer" ? n : undefined;
  }

  /** Flat index among pixel layers (0 = bottom). */
  indexOf(id: number): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  /** Where a node lives: its list, index in it, and parent set. */
  locate(id: number): { list: Node[]; index: number; group: Group | null } | null {
    const i = this.stack.findIndex((n) => n.id === id);
    if (i >= 0) return { list: this.stack, index: i, group: null };
    for (const g of this.groups) {
      const j = g.children.findIndex((c) => c.id === id);
      if (j >= 0) return { list: g.children, index: j, group: g };
    }
    return null;
  }

  parentOf(id: number): Group | null {
    return this.locate(id)?.group ?? null;
  }

  remove(id: number): Node | undefined {
    const at = this.locate(id);
    if (!at) return undefined;
    return at.list.splice(at.index, 1)[0];
  }

  /**
   * Add a new layer. By default it goes directly above the active node: inside
   * the active layer's set, or at the top of the active set.
   */
  addLayer(name: string, index?: number): Layer {
    const l = new Layer(this.width, this.height, name);
    if (index !== undefined) {
      // Flat placement at the top level (used for Background and tests).
      this.stack.splice(Math.max(0, Math.min(index, this.stack.length)), 0, l);
    } else this.insertAboveActive(l);
    this.activeLayerId = l.id;
    return l;
  }

  insertAboveActive(n: Node): void {
    const active = this.activeNode;
    if (!active) {
      this.stack.push(n);
      return;
    }
    if (active.kind === "group" && n.kind === "layer") {
      active.children.push(n);
      return;
    }
    const at = this.locate(active.id)!;
    if (n.kind === "group" && at.group) {
      // Sets can't nest: put the new set above the parent set.
      const gi = this.stack.indexOf(at.group);
      this.stack.splice(gi + 1, 0, n);
      return;
    }
    (at.list as Node[]).splice(at.index + 1, 0, n);
  }

  /** Next "Layer N" name, like PS7. */
  nextLayerName(): string {
    return this.nextName("Layer");
  }

  nextName(prefix: string): string {
    let n = 1;
    const names = new Set<string>();
    for (const l of this.layers) names.add(l.name);
    for (const g of this.groups) names.add(g.name);
    while (names.has(`${prefix} ${n}`)) n++;
    return `${prefix} ${n}`;
  }

  /** The layer a clipped layer is clipped to, or null. */
  clipBase(l: Layer): Layer | null {
    if (!l.clipped) return null;
    const at = this.locate(l.id);
    if (!at) return null;
    for (let i = at.index - 1; i >= 0; i--) {
      const n = at.list[i];
      if (n.kind !== "layer") return null;
      if (!n.clipped) return n;
    }
    return null;
  }

  /** Layers linked with l (including l). */
  linked(l: Layer): Layer[] {
    if (l.linkId === null) return [l];
    return this.layers.filter((x) => x.linkId === l.linkId);
  }

  // ---------- selection ----------

  setSelection(m: Mask | null): void {
    if (this.selection && !m) this.lastSelection = this.selection;
    this.selection = m;
    this.emit({ type: "selection" });
  }

  // ---------- snapshots ----------

  snapshot(): DocSnapshot {
    const snapLayer = (l: Layer): LayerSnap => ({ kind: "layer", props: l.props(), grid: l.grid.share(), mask: l.mask ? l.mask.share() : null });
    return {
      width: this.width,
      height: this.height,
      resolution: this.resolution,
      stack: this.stack.map((n) =>
        n.kind === "layer" ? snapLayer(n) : { kind: "group", props: n.props(), children: n.children.map(snapLayer), mask: n.mask ? n.mask.share() : null },
      ),
      activeId: this.activeLayerId,
      selected: [...this.selectedIds],
      notes: this.notes.map((n) => ({ ...n })),
      slices: this.slices.map((n) => ({ ...n })),
      paths: [...this.paths],
      selection: this.selection ? this.selection.share() : null,
      lastSelection: this.lastSelection ? this.lastSelection.share() : null,
      guides: { h: [...this.guides.h], v: [...this.guides.v] },
      quickMask: this.quickMask,
    };
  }

  private structureKey(stack: NodeSnap[] | Node[]): string {
    // A set's palette disclosure state doesn't affect pixels.
    const gp = (p: GroupProps) => ({ ...p, expanded: undefined });
    // Grid and mask sizes matter too: tile indices only line up between grids of one size.
    const md = (m: Mask | null) => (m ? [m.defaultValue, m.width, m.height] : -1);
    const ofSnap = (n: NodeSnap): unknown =>
      n.kind === "group" ? ["g", gp(n.props), md(n.mask), n.children.map(ofSnap)] : ["l", n.props, md(n.mask), n.grid.width, n.grid.height];
    const ofNode = (n: Node): unknown =>
      n.kind === "group" ? ["g", gp(n.props()), md(n.mask), n.children.map(ofNode)] : ["l", n.props(), md(n.mask), n.grid.width, n.grid.height];
    return JSON.stringify(
      (stack as (NodeSnap | Node)[]).map((n) => (n instanceof Layer || n instanceof Group ? ofNode(n) : ofSnap(n as NodeSnap))),
    );
  }

  /** Restore a snapshot, emitting the minimal dirty regions. */
  restore(s: DocSnapshot): void {
    const sizeChanged = s.width !== this.width || s.height !== this.height;
    const structural = sizeChanged || this.structureKey(s.stack) !== this.structureKey(this.stack);
    const dirty: Rect[] = [];
    if (!structural) {
      // Set masks (canvas space).
      const curGroups = this.stack.filter((n): n is Group => n.kind === "group");
      const snapGroups = s.stack.filter((n): n is GroupSnap => n.kind === "group");
      snapGroups.forEach((gs, i) => {
        const g = curGroups[i];
        if (g?.mask && gs.mask)
          g.mask.tiles.forEach((t, ti) => {
            if (t !== gs.mask!.tiles[ti]) dirty.push({ x: (ti % g.mask!.cols) * TILE, y: ((ti / g.mask!.cols) | 0) * TILE, w: TILE, h: TILE });
          });
      });
      const cur = this.layers;
      const snaps: LayerSnap[] = [];
      for (const n of s.stack) n.kind === "layer" ? snaps.push(n) : snaps.push(...n.children);
      snaps.forEach((ls, i) => {
        const l = cur[i];
        for (const r of TileGrid.diff(l.grid, ls.grid)) dirty.push({ x: r.x + l.offsetX, y: r.y + l.offsetY, w: r.w, h: r.h });
        if (l.mask && ls.mask)
          l.mask.tiles.forEach((t, ti) => {
            if (t !== ls.mask!.tiles[ti])
              dirty.push({ x: (ti % l.mask!.cols) * TILE + l.offsetX, y: ((ti / l.mask!.cols) | 0) * TILE + l.offsetY, w: TILE, h: TILE });
          });
      });
    }
    const makeLayer = (ls: LayerSnap) => {
      const l = new Layer(ls.grid.width, ls.grid.height, ls.props.name, ls.props.id);
      Object.assign(l, ls.props, { locks: { ...ls.props.locks } });
      l.grid = ls.grid.share();
      l.mask = ls.mask ? ls.mask.share() : null;
      return l;
    };
    this.width = s.width;
    this.height = s.height;
    this.stack = s.stack.map((n) => {
      if (n.kind === "layer") return makeLayer(n);
      const g = new Group(n.props.name, n.props.id);
      Object.assign(g, n.props);
      g.children = n.children.map(makeLayer);
      g.mask = n.mask ? n.mask.share() : null;
      return g;
    });
    this.selectNodes(s.activeId, s.selected ?? []);
    const annotChanged = JSON.stringify([this.notes, this.slices]) !== JSON.stringify([s.notes ?? [], s.slices ?? []]);
    this.notes = (s.notes ?? []).map((n) => ({ ...n }));
    this.slices = (s.slices ?? []).map((n) => ({ ...n }));
    const pathsChanged = this.paths.length !== (s.paths ?? []).length || this.paths.some((p, i) => p !== s.paths![i]);
    this.paths = [...(s.paths ?? [])];
    if (s.resolution) this.resolution = s.resolution;
    if (annotChanged || pathsChanged) this.emit({ type: "guides" });
    const selChanged = (this.selection?.key() ?? "") !== (s.selection?.key() ?? "") || !!this.selection !== !!s.selection;
    this.selection = s.selection ? s.selection.share() : null;
    this.lastSelection = s.lastSelection ? s.lastSelection.share() : null;
    const guidesChanged = JSON.stringify(this.guides) !== JSON.stringify(s.guides);
    this.guides = { h: [...s.guides.h], v: [...s.guides.v] };
    const qmChanged = this.quickMask !== s.quickMask;
    this.quickMask = s.quickMask;
    if (!this.activeNode?.mask) this.editMask = false;
    if (sizeChanged) this.emit({ type: "size" });
    this.emit({ type: "layers" });
    if (structural) this.dirty(null);
    else for (const r of dirty) this.dirty(r);
    if (selChanged || qmChanged) this.emit({ type: "selection" });
    if (guidesChanged) this.emit({ type: "guides" });
  }

  // ---------- reading pixels ----------

  /**
   * CPU composite of a canvas region into straight RGBA: the reference for
   * the GPU compositor, and used for Copy Merged, Flatten and sampling.
   */
  composite(r: Rect = { x: 0, y: 0, w: this.width, h: this.height }): Uint8ClampedArray {
    return compositeRegion(this, r);
  }

  samplePixel(x: number, y: number): RGBA {
    const d = this.composite({ x: Math.floor(x), y: Math.floor(y), w: 1, h: 1 });
    return [d[0], d[1], d[2], d[3]];
  }
}
