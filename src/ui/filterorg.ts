/**
 * How you organize the filter library: favorites, your own collections,
 * hidden filters, recently used ones, saved settings (presets) per filter,
 * and the settings you used last time. Saved, and exportable.
 */

import { FILTER_MAP } from "../filters";
import * as storage from "./storage";

export interface Collection {
  id: string;
  name: string;
  filters: string[];
}

export interface FilterPreset {
  name: string;
  params: Record<string, unknown>;
}

interface OrgData {
  favorites: string[];
  collections: Collection[];
  hidden: string[];
  recent: string[];
  presets: Record<string, FilterPreset[]>;
  lastParams: Record<string, Record<string, unknown>>;
}

const KEY = "filterOrg";
const DEFAULT: OrgData = {
  favorites: ["cartoon", "gaussianBlur", "unsharpMask", "oilPaint", "pencilSketch", "vintage"],
  collections: [
    { id: "c-comic", name: "Comic Night", filters: ["comicBook", "benDay", "inkDrawing", "mangaTone", "speedLines"] },
    { id: "c-portrait", name: "Portrait Touch-Up", filters: ["surfaceBlur", "dustScratches", "clarity", "dreamyGlow", "vignetteFx"] },
  ],
  hidden: [],
  recent: [],
  presets: {},
  lastParams: {},
};

export class FilterOrg {
  data: OrgData;
  private listeners = new Set<() => void>();

  constructor() {
    const d = storage.load<Partial<OrgData>>(KEY, {});
    this.data = { ...structuredClone(DEFAULT), ...d };
    this.clean();
  }

  /** Drop ids of filters that no longer exist. */
  private clean(): void {
    const ok = (id: string) => FILTER_MAP.has(id);
    this.data.favorites = this.data.favorites.filter(ok);
    this.data.hidden = this.data.hidden.filter(ok);
    this.data.recent = this.data.recent.filter(ok);
    for (const c of this.data.collections) c.filters = c.filters.filter(ok);
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    storage.save(KEY, this.data);
    for (const fn of this.listeners) fn();
  }

  isFavorite(id: string): boolean {
    return this.data.favorites.includes(id);
  }
  toggleFavorite(id: string): void {
    const f = this.data.favorites;
    if (f.includes(id)) f.splice(f.indexOf(id), 1);
    else f.push(id);
    this.save();
  }
  isHidden(id: string): boolean {
    return this.data.hidden.includes(id);
  }
  setHidden(id: string, v: boolean): void {
    const h = this.data.hidden.filter((x) => x !== id);
    if (v) h.push(id);
    this.data.hidden = h;
    this.save();
  }

  used(id: string, params: Record<string, unknown>): void {
    this.data.recent = [id, ...this.data.recent.filter((x) => x !== id)].slice(0, 12);
    this.data.lastParams[id] = params;
    this.save();
  }
  lastParams(id: string): Record<string, unknown> | undefined {
    return this.data.lastParams[id];
  }

  addCollection(name: string): Collection {
    const c = { id: "c-" + Date.now().toString(36), name, filters: [] };
    this.data.collections.push(c);
    this.save();
    return c;
  }
  renameCollection(id: string, name: string): void {
    const c = this.data.collections.find((c) => c.id === id);
    if (c) c.name = name;
    this.save();
  }
  deleteCollection(id: string): void {
    this.data.collections = this.data.collections.filter((c) => c.id !== id);
    this.save();
  }
  addTo(cid: string, fid: string, before?: string): void {
    const c = this.data.collections.find((c) => c.id === cid);
    if (!c) return;
    c.filters = c.filters.filter((x) => x !== fid);
    const at = before ? c.filters.indexOf(before) : -1;
    if (at >= 0) c.filters.splice(at, 0, fid);
    else c.filters.push(fid);
    this.save();
  }
  removeFrom(cid: string, fid: string): void {
    const c = this.data.collections.find((c) => c.id === cid);
    if (c) c.filters = c.filters.filter((x) => x !== fid);
    this.save();
  }
  moveCollection(id: string, dir: -1 | 1): void {
    const cs = this.data.collections;
    const i = cs.findIndex((c) => c.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cs.length) return;
    [cs[i], cs[j]] = [cs[j], cs[i]];
    this.save();
  }

  presets(id: string): FilterPreset[] {
    return this.data.presets[id] ?? [];
  }
  savePreset(id: string, name: string, params: Record<string, unknown>): void {
    const list = (this.data.presets[id] ?? []).filter((p) => p.name !== name);
    list.push({ name, params: { ...params } });
    this.data.presets[id] = list;
    this.save();
  }
  deletePreset(id: string, name: string): void {
    this.data.presets[id] = this.presets(id).filter((p) => p.name !== name);
    this.save();
  }

  export(): string {
    return JSON.stringify({ format: "classic-image-editor-filters", version: 1, ...this.data }, null, 2);
  }
  import(text: string): void {
    const d = JSON.parse(text);
    if (d.format !== "classic-image-editor-filters") throw new Error("This is not a filter organization file.");
    const { favorites, collections, hidden, presets } = d;
    this.data = { ...this.data, favorites: favorites ?? [], collections: collections ?? [], hidden: hidden ?? [], presets: presets ?? {} };
    this.clean();
    this.save();
  }
  reset(): void {
    this.data = structuredClone(DEFAULT);
    this.save();
  }
}
