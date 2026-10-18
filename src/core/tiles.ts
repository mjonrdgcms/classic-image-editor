/**
 * Tiled pixel storage with copy-on-write.
 *
 * Pixels are straight (non-premultiplied) RGBA, 8 bits per channel, stored in
 * 256 x 256 tiles. A missing tile (null) is fully transparent, so empty layers
 * cost almost nothing. History snapshots share tiles; a tile becomes "frozen"
 * once a snapshot references it, and the next write clones it first.
 */

export const TILE = 256;
export const TILE_PX = TILE * TILE;

let nextTileVersion = 1;

export class Tile {
  /** RGBA bytes, TILE * TILE * 4. */
  data: Uint8ClampedArray;
  /** Shared with a history snapshot; must be cloned before writing. */
  frozen = false;
  /** Bumped on every write so the GPU knows to re-upload. */
  version = nextTileVersion++;

  constructor(data?: Uint8ClampedArray) {
    this.data = data ?? new Uint8ClampedArray(TILE_PX * 4);
  }

  clone(): Tile {
    return new Tile(new Uint8ClampedArray(this.data));
  }

  touch(): void {
    this.version = nextTileVersion++;
  }

  /** True if every pixel is fully transparent. */
  isEmpty(): boolean {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectUnion(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export class TileGrid {
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
  tiles: (Tile | null)[];

  constructor(width: number, height: number, tiles?: (Tile | null)[]) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / TILE);
    this.rows = Math.ceil(height / TILE);
    this.tiles = tiles ?? new Array(this.cols * this.rows).fill(null);
  }

  getTile(tx: number, ty: number): Tile | null {
    if (tx < 0 || ty < 0 || tx >= this.cols || ty >= this.rows) return null;
    return this.tiles[ty * this.cols + tx];
  }

  /** Returns a tile that is safe to write, cloning or allocating as needed. */
  writableTile(tx: number, ty: number): Tile {
    const i = ty * this.cols + tx;
    let t = this.tiles[i];
    if (!t) {
      t = new Tile();
      this.tiles[i] = t;
    } else if (t.frozen) {
      t = t.clone();
      this.tiles[i] = t;
    }
    return t;
  }

  /** Mark all tiles shared, so the next write to each clones it. */
  freeze(): void {
    for (const t of this.tiles) if (t) t.frozen = true;
  }

  /** Shallow copy that shares tiles (used for snapshots). */
  share(): TileGrid {
    this.freeze();
    return new TileGrid(this.width, this.height, this.tiles.slice());
  }

  /** Drop tiles that became fully transparent. */
  compact(): void {
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (t && t.isEmpty()) this.tiles[i] = null;
    }
  }

  getPixel(x: number, y: number): [number, number, number, number] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0];
    const t = this.getTile((x / TILE) | 0, (y / TILE) | 0);
    if (!t) return [0, 0, 0, 0];
    const o = ((y % TILE) * TILE + (x % TILE)) * 4;
    const d = t.data;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]];
  }

  /** Copy a region out as a contiguous RGBA buffer (transparent outside). */
  readRegion(r: Rect): Uint8ClampedArray {
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    const clip = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
    if (!clip) return out;
    const tx0 = (clip.x / TILE) | 0;
    const ty0 = (clip.y / TILE) | 0;
    const tx1 = ((clip.x + clip.w - 1) / TILE) | 0;
    const ty1 = ((clip.y + clip.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.getTile(tx, ty);
        if (!t) continue;
        const sub = rectIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          const src = ((y - ty * TILE) * TILE + (sub.x - tx * TILE)) * 4;
          const dst = ((y - r.y) * r.w + (sub.x - r.x)) * 4;
          out.set(t.data.subarray(src, src + sub.w * 4), dst);
        }
      }
    }
    return out;
  }

  /** Write a contiguous RGBA buffer into the grid (clipped to bounds). */
  writeRegion(r: Rect, data: Uint8ClampedArray): void {
    const clip = rectIntersect(r, { x: 0, y: 0, w: this.width, h: this.height });
    if (!clip) return;
    const tx0 = (clip.x / TILE) | 0;
    const ty0 = (clip.y / TILE) | 0;
    const tx1 = ((clip.x + clip.w - 1) / TILE) | 0;
    const ty1 = ((clip.y + clip.h - 1) / TILE) | 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const sub = rectIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE })!;
        // Skip allocating a tile just to write transparent pixels into it.
        if (!this.getTile(tx, ty) && regionIsTransparent(data, r, sub)) continue;
        const t = this.writableTile(tx, ty);
        for (let y = sub.y; y < sub.y + sub.h; y++) {
          const dst = ((y - ty * TILE) * TILE + (sub.x - tx * TILE)) * 4;
          const src = ((y - r.y) * r.w + (sub.x - r.x)) * 4;
          t.data.set(data.subarray(src, src + sub.w * 4), dst);
        }
        t.touch();
      }
    }
  }

  /** Fill the whole grid with one color. */
  fill(rgba: [number, number, number, number]): void {
    if (rgba[3] === 0) {
      this.tiles.fill(null);
      return;
    }
    const proto = new Tile();
    for (let i = 0; i < TILE_PX; i++) proto.data.set(rgba, i * 4);
    for (let i = 0; i < this.tiles.length; i++) this.tiles[i] = proto.clone();
  }

  /** Canvas rects of tiles that differ (by identity) between two grids. */
  static diff(a: TileGrid, b: TileGrid): Rect[] {
    const out: Rect[] = [];
    const n = Math.max(a.tiles.length, b.tiles.length);
    for (let i = 0; i < n; i++) {
      if (a.tiles[i] !== b.tiles[i]) {
        const tx = i % a.cols;
        const ty = (i / a.cols) | 0;
        out.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
    return out;
  }
}

function regionIsTransparent(data: Uint8ClampedArray, r: Rect, sub: Rect): boolean {
  for (let y = sub.y; y < sub.y + sub.h; y++) {
    let o = ((y - r.y) * r.w + (sub.x - r.x)) * 4 + 3;
    for (let x = 0; x < sub.w; x++, o += 4) if (data[o] !== 0) return false;
  }
  return true;
}
