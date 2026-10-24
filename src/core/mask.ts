/**
 * Single-channel 8-bit masks, tiled and copy-on-write like TileGrid.
 *
 * Used for selections (canvas space, default 0 = unselected), layer masks
 * (layer space, default 255 = reveal all or 0 = hide all) and Quick Mask.
 * A null tile means "every pixel equals defaultValue"; fully-selected tiles
 * share one frozen constant tile, so Select All on a huge image is cheap.
 */

import { EvictedTileError, Rect, TILE, TILE_PX, rectIntersect, type SwapRef } from "./tiles";

let nextVersion = 1;

export class MaskTile {
  /** null while on the scratch disk (see TilePager). */
  private bytes: Uint8Array | null;
  frozen = false;
  version = nextVersion++;
  /** A copy on the scratch disk (kept after loading back, since frozen tiles never change). */
  swap: SwapRef | null = null;
  /** The shared all-0 / all-255 tiles never leave memory. */
  pinned = false;
  constructor(data?: Uint8Array) {
    this.bytes = data ?? new Uint8Array(TILE_PX);
  }
  get data(): Uint8Array {
    const d = this.bytes;
    if (!d) throw new EvictedTileError();
    return d;
  }
  set data(d: Uint8Array) {
    this.bytes = d;
  }
  get resident(): boolean {
    return this.bytes !== null;
  }
  evict(): void {
    if (!this.swap || !this.frozen || this.pinned) throw new Error("this mask tile can't be evicted");
    this.bytes = null;
  }
  load(d: Uint8Array): void {
    this.bytes = d;
  }
  clone(): MaskTile {
    return new MaskTile(new Uint8Array(this.data));
  }
  touch(): void {
    this.version = nextVersion++;
  }
  /** 0 or 255 if uniform, else -1. */
  uniform(): number {
    const d = this.data;
    const v = d[0];
    if (v !== 0 && v !== 255) return -1;
    for (let i = 1; i < d.length; i++) if (d[i] !== v) return -1;
    return v;
  }
}

/** Shared constant tiles (never written: frozen). */
const CONST: Record<0 | 255, MaskTile> = {
  0: Object.assign(new MaskTile(), { frozen: true, pinned: true }),
  255: Object.assign(new MaskTile(new Uint8Array(TILE_PX).fill(255)), { frozen: true, pinned: true }),
};

export class Mask {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  tiles: (MaskTile | null)[];
  defaultValue: 0 | 255;
  /** Set when the mask is exactly a hard-edged rectangle (fast outline/bounds). */
  rectHint: Rect | null = null;
  private boundsCache: { key: string; r: Rect | null } | null = null;

  constructor(width: number, height: number, defaultValue: 0 | 255 = 0, tiles?: (MaskTile | null)[]) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.defaultValue = defaultValue;
    this.tiles = tiles ?? new Array(this.cols * this.rows).fill(null);
  }

  static full(width: number, height: number): Mask {
    const m = new Mask(width, height, 0);
    m.tiles.fill(CONST[255]);
    m.rectHint = { x: 0, y: 0, w: width, h: height };
    return m;
  }

  // ---------- tiles ----------

  writable(tx: number, ty: number): MaskTile {
    const i = ty * this.cols + tx;
    let t = this.tiles[i];
    if (!t) {
      t = this.defaultValue === 0 ? new MaskTile() : CONST[255].clone();
      this.tiles[i] = t;
    } else if (t.frozen) {
      t = t.clone();
      this.tiles[i] = t;
    }
    this.rectHint = null;
    this.boundsCache = null;
    return t;
  }

  freeze(): void {
    for (const t of this.tiles) if (t) t.frozen = true;
  }

  share(): Mask {
    this.freeze();
    const m = new Mask(this.width, this.height, this.defaultValue, this.tiles.slice());
    m.rectHint = this.rectHint ? { ...this.rectHint } : null;
    return m;
  }

  /** Replace uniform tiles by null / the shared constant (after big edits). */
  compact(): void {
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (!t || t === CONST[255]) continue;
      const u = t.uniform();
      if (u === this.defaultValue) this.tiles[i] = null;
      else if (u === 255) this.tiles[i] = CONST[255];
      else if (u === 0) this.tiles[i] = CONST[0];
    }
    this.boundsCache = null;
  }

  /** Version key that changes whenever any tile changes. */
  key(): string {
    let h = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      h = (Math.imul(h, 31) + (t ? t.version : 0) + i) | 0;
    }
    return `${h}:${this.defaultValue}`;
  }

  // ---------- pixels ----------

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const t = this.tiles[((y / TILE) | 0) * this.cols + ((x / TILE) | 0)];
    if (!t) return this.defaultValue;
    return t.data[(y % TILE) * TILE + (x % TILE)];
  }

  /** Copy a region out (pixels outside the mask read as `outside`). */
  readRegion(r: Rect, outside = 0): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    if (outside) out.fill(outside);
    const clip = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
    if (!clip) return out;
    const tx0 = (clip.x / TILE) | 0, ty0 = (clip.y / TILE) | 0;
    const tx1 = ((clip.x + clip.w - 1) / TILE) | 0, ty1 = ((clip.y + clip.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const sub = rectIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        const t = this.tiles[ty * this.cols + tx];
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          const dst = (y - r.y) * r.w + (sub.x - r.x);
          if (!t) out.fill(this.defaultValue, dst, dst + sub.w);
          else {
            const src = (y - ty * TILE) * TILE + (sub.x - tx * TILE);
            out.set(t.data.subarray(src, src + sub.w), dst);
          }
        }
      }
    return out;
  }

  writeRegion(r: Rect, data: Uint8Array): void {
    const clip = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
    if (!clip) return;
    const tx0 = (clip.x / TILE) | 0, ty0 = (clip.y / TILE) | 0;
    const tx1 = ((clip.x + clip.w - 1) / TILE) | 0, ty1 = ((clip.y + clip.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const sub = rectIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        const t = this.writable(tx, ty);
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          const src = (y - r.y) * r.w + (sub.x - r.x);
          t.data.set(data.subarray(src, src + sub.w), (y - ty * TILE) * TILE + (sub.x - tx * TILE));
        }
        t.touch();
      }
    this.compact();
  }

  /** Set every pixel to v. */
  fill(v: 0 | 255): void {
    this.tiles.fill(v === this.defaultValue ? null : CONST[v]);
    this.rectHint = v === 255 ? { x: 0, y: 0, w: this.width, h: this.height } : null;
    this.boundsCache = null;
  }

  isEmpty(): boolean {
    return this.bounds() === null;
  }

  /** Bounding box of non-zero pixels, or null. */
  bounds(): Rect | null {
    if (this.rectHint) return { ...this.rectHint };
    const key = this.key();
    if (this.boundsCache?.key === key) return this.boundsCache.r ? { ...this.boundsCache.r } : null;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let ty = 0; ty < this.rows; ty++)
      for (let tx = 0; tx < this.cols; tx++) {
        const t = this.tiles[ty * this.cols + tx];
        const tw = Math.min(TILE, this.width - tx * TILE);
        const th = Math.min(TILE, this.height - ty * TILE);
        if (!t) {
          if (this.defaultValue === 0) continue;
          x0 = Math.min(x0, tx * TILE); y0 = Math.min(y0, ty * TILE);
          x1 = Math.max(x1, tx * TILE + tw - 1); y1 = Math.max(y1, ty * TILE + th - 1);
          continue;
        }
        if (t === CONST[255]) {
          x0 = Math.min(x0, tx * TILE); y0 = Math.min(y0, ty * TILE);
          x1 = Math.max(x1, tx * TILE + tw - 1); y1 = Math.max(y1, ty * TILE + th - 1);
          continue;
        }
        const d = t.data;
        for (let y = 0; y < th; y++) {
          const row = y * TILE;
          for (let x = 0; x < tw; x++)
            if (d[row + x]) {
              const cx = tx * TILE + x, cy = ty * TILE + y;
              if (cx < x0) x0 = cx;
              if (cx > x1) x1 = cx;
              if (cy < y0) y0 = cy;
              if (cy > y1) y1 = cy;
            }
        }
      }
    const r = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    this.boundsCache = { key, r };
    return r ? { ...r } : null;
  }

  // ---------- whole-mask operations ----------

  /** Combine another same-size mask into this one. */
  combine(other: Mask, mode: "add" | "subtract" | "intersect"): void {
    const n = this.tiles.length;
    for (let i = 0; i < n; i++) {
      const a = this.tiles[i];
      const b = other.tiles[i];
      const av = a ? (a === CONST[255] ? 255 : a === CONST[0] ? 0 : -1) : this.defaultValue;
      const bv = b ? (b === CONST[255] ? 255 : b === CONST[0] ? 0 : -1) : other.defaultValue;
      // Fast paths on uniform tiles.
      if (mode === "add") {
        if (bv === 0 || av === 255) continue;
        if (bv === 255) { this.tiles[i] = CONST[255]; continue; }
      } else if (mode === "subtract") {
        if (bv === 0 || av === 0) continue;
        if (bv === 255) { this.tiles[i] = this.defaultValue === 0 ? null : CONST[0]; continue; }
      } else {
        if (bv === 255 || av === 0) continue;
        if (bv === 0) { this.tiles[i] = this.defaultValue === 0 ? null : CONST[0]; continue; }
      }
      const tx = i % this.cols, ty = (i / this.cols) | 0;
      const t = this.writable(tx, ty);
      const bd = b ? b.data : null;
      const d = t.data;
      for (let p = 0; p < TILE_PX; p++) {
        const x = d[p];
        const y = bd ? bd[p] : bv;
        d[p] = mode === "add" ? (x > y ? x : y) : mode === "subtract" ? (x * (255 - y) + 127) / 255 : x < y ? x : y;
      }
      t.touch();
    }
    this.rectHint = null;
    this.boundsCache = null;
    this.compact();
  }

  invert(): void {
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      const v = t ? (t === CONST[255] ? 255 : t === CONST[0] ? 0 : -1) : this.defaultValue;
      if (v === 0) { this.tiles[i] = CONST[255]; continue; }
      if (v === 255) { this.tiles[i] = this.defaultValue === 0 ? null : CONST[0]; continue; }
      const w = this.writable(i % this.cols, (i / this.cols) | 0);
      for (let p = 0; p < TILE_PX; p++) w.data[p] = 255 - w.data[p];
      w.touch();
    }
    this.rectHint = null;
    this.boundsCache = null;
    this.compact();
  }

  /** A copy shifted by dx, dy (pixels moved off the edge are lost). */
  translated(dx: number, dy: number): Mask {
    const m = new Mask(this.width, this.height, 0);
    const b = this.bounds();
    if (!b) return m;
    const src = this.readRegion(b);
    m.writeRegion({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, src);
    if (this.rectHint) {
      const r = rectIntersect({ ...this.rectHint, x: this.rectHint.x + dx, y: this.rectHint.y + dy }, { x: 0, y: 0, w: this.width, h: this.height });
      m.rectHint = r;
    }
    return m;
  }

  clone(): Mask {
    return this.share();
  }
}
