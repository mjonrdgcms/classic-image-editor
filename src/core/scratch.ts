/**
 * Scratch disk paging, as in Photoshop: when the open images and their
 * History outgrow the memory the user allows (Preferences > Memory), the
 * pixels of older history states are written to the scratch disk and dropped
 * from memory. Going back to such a state loads them first.
 *
 * Pixels live in copy-on-write tiles that History snapshots share, so paging
 * works per tile: a tile is evicted only when nothing that must stay in
 * memory uses it (the live document, the current state and its neighbours,
 * the state the image was opened in, named snapshots and the History Brush
 * source). Tiles are frozen once a snapshot holds them and never change after
 * that, so a tile written once keeps its scratch copy; evicting it again later
 * costs nothing.
 *
 * Plain TypeScript with no DOM: the store is the only platform-specific part
 * (the desktop app's scratch folders, the browser's private file system, or
 * memory in tests).
 */

import type { Document, DocSnapshot } from "./document";
import type { History, HistoryState } from "./history";
import { Mask, MaskTile } from "./mask";
import { Tile, TileGrid } from "./tiles";

/** Where scratch files go. Names are flat ("p12"); offsets and lengths in bytes. */
export interface ScratchStore {
  write(name: string, data: Uint8Array): Promise<void>;
  read(name: string, offset: number, length: number): Promise<Uint8Array>;
  remove(names: string[]): Promise<void>;
}

/** A store in memory, for tests and when no scratch disk can be used. */
export class MemoryStore implements ScratchStore {
  files = new Map<string, Uint8Array>();
  async write(name: string, data: Uint8Array): Promise<void> {
    this.files.set(name, data.slice());
  }
  async read(name: string, offset: number, length: number): Promise<Uint8Array> {
    const f = this.files.get(name);
    if (!f || offset + length > f.length) throw new Error(`scratch file ${name} is missing or too short`);
    return f.slice(offset, offset + length);
  }
  async remove(names: string[]): Promise<void> {
    for (const n of names) this.files.delete(n);
  }
}

type AnyTile = Tile | MaskTile;

/** An open image as the pager sees it. */
export interface PagedImage {
  doc: Document;
  history: History;
  /** States that must stay loaded besides the current one and its neighbours (the History Brush source). */
  pinned?: HistoryState[];
}

export interface PagerStats {
  /** Bytes of pixels in memory (open images, their history and snapshots). */
  inMemory: number;
  /** Bytes of history pixels only on the scratch disk. */
  onDisk: number;
  /** Bytes in scratch files (including copies of tiles that are also in memory). */
  scratchFiles: number;
  /** The memory budget. */
  budget: number;
}

function* gridTiles(g: TileGrid | null | undefined): Generator<Tile> {
  if (g) for (const t of g.tiles) if (t) yield t;
}
function* maskTiles(m: Mask | null | undefined): Generator<MaskTile> {
  if (m) for (const t of m.tiles) if (t && !t.pinned) yield t;
}

/** Every tile a history snapshot uses. */
export function* snapshotTiles(s: DocSnapshot): Generator<AnyTile> {
  for (const n of s.stack) {
    if (n.kind === "layer") {
      yield* gridTiles(n.grid);
      yield* maskTiles(n.mask);
    } else {
      yield* maskTiles(n.mask);
      for (const c of n.children) {
        yield* gridTiles(c.grid);
        yield* maskTiles(c.mask);
      }
    }
  }
  yield* maskTiles(s.selection);
  yield* maskTiles(s.lastSelection);
}

/** Every tile the live document uses. */
export function* documentTiles(doc: Document): Generator<AnyTile> {
  for (const l of doc.layers) {
    yield* gridTiles(l.grid);
    yield* maskTiles(l.mask);
  }
  for (const g of doc.groups) yield* maskTiles(g.mask);
  yield* maskTiles(doc.selection);
  yield* maskTiles(doc.lastSelection);
}

/** Largest scratch file written at once. */
const PACK_BYTES = 64 * 1024 * 1024;

const bytesOf = (t: AnyTile) => (t instanceof Tile ? 256 * 256 * 4 : 256 * 256);

/** Does this snapshot need tiles loaded from the scratch disk before it can be used? */
export function needsLoading(s: DocSnapshot): boolean {
  for (const t of snapshotTiles(s)) if (!t.resident) return true;
  return false;
}

export class TilePager {
  /** Scratch files written, and their sizes. */
  private files = new Map<string, number>();
  private nextFile = 1;
  private busy: Promise<void> = Promise.resolve();
  private last: PagerStats = { inMemory: 0, onDisk: 0, scratchFiles: 0, budget: 0 };
  /** Called when a write fails (disk full, folder gone): paging stops until the store changes. */
  onError: ((e: unknown) => void) | null = null;
  private failed = false;

  constructor(
    public store: ScratchStore,
    private images: () => PagedImage[],
    private budget: () => number,
  ) {}

  get stats(): PagerStats {
    return this.last;
  }

  /** Use another store (Preferences changed the scratch disks). Loads everything back first. */
  async setStore(store: ScratchStore): Promise<void> {
    await this.run(async () => {
      // Everything back in memory (states, snapshots, the opened state), then forget the old copies.
      for (const img of this.images()) for (const s of this.statesOf(img.history)) await this.loadTiles(snapshotTiles(s.snapshot));
      this.forgetCopies();
      await this.store.remove([...this.files.keys()]).catch(() => {});
      this.files.clear();
      this.store = store;
      this.failed = false;
    });
  }

  /** Measure memory use (and refresh stats) without changing anything. */
  measure(): PagerStats {
    let inMemory = 0, onDisk = 0;
    const seen = new Set<AnyTile>();
    const count = (t: AnyTile) => {
      if (seen.has(t)) return;
      seen.add(t);
      if (t.resident) inMemory += bytesOf(t);
      else onDisk += bytesOf(t);
    };
    for (const img of this.images()) {
      for (const t of documentTiles(img.doc)) count(t);
      for (const s of this.statesOf(img.history)) for (const t of snapshotTiles(s.snapshot)) count(t);
    }
    let scratchFiles = 0;
    for (const v of this.files.values()) scratchFiles += v;
    this.last = { inMemory, onDisk, scratchFiles, budget: this.budget() };
    return this.last;
  }

  private statesOf(h: History): HistoryState[] {
    const out = [...h.states, ...h.snapshots];
    if (h.opened && !out.includes(h.opened)) out.push(h.opened);
    return out;
  }

  /** Serialize paging work (loads and evictions never interleave). */
  private run(fn: () => Promise<void>): Promise<void> {
    const p = this.busy.then(fn);
    this.busy = p.catch(() => {});
    return p;
  }

  /**
   * Make sure these states can be used (History jumps, the History Brush):
   * their tiles come back from the scratch disk.
   */
  ensure(states: (HistoryState | undefined)[]): Promise<void> {
    const need = states.filter((s): s is HistoryState => !!s && needsLoading(s.snapshot));
    if (!need.length) return Promise.resolve();
    return this.run(async () => {
      for (const s of need) await this.loadTiles(snapshotTiles(s.snapshot));
    });
  }

  private async loadTiles(tiles: Iterable<AnyTile>): Promise<void> {
    // Group by file and read each file's needed span once.
    const byFile = new Map<string, AnyTile[]>();
    for (const t of tiles) {
      if (t.resident) continue;
      const ref = t.swap!;
      let list = byFile.get(ref.pack);
      if (!list) byFile.set(ref.pack, (list = []));
      if (!list.includes(t)) list.push(t);
    }
    for (const [pack, list] of byFile) {
      list.sort((a, b) => a.swap!.offset - b.swap!.offset);
      // Contiguous runs, read in one go each.
      let i = 0;
      while (i < list.length) {
        let j = i;
        while (j + 1 < list.length && list[j + 1].swap!.offset === list[j].swap!.offset + list[j].swap!.length) j++;
        const start = list[i].swap!.offset;
        const end = list[j].swap!.offset + list[j].swap!.length;
        const bytes = await this.store.read(pack, start, end - start);
        for (let k = i; k <= j; k++) {
          const t = list[k];
          if (t.resident) continue;
          const o = t.swap!.offset - start;
          t.load(bytes.slice(o, o + t.swap!.length));
        }
        i = j + 1;
      }
    }
  }

  /**
   * If memory is over budget, move the history tiles nothing needs right now
   * to the scratch disk, oldest states first, until use is back under
   * 80% of the budget. Resolves with the stats afterwards.
   */
  enforce(): Promise<PagerStats> {
    return this.run(async () => {
      if (this.failed) return;
      const st = this.measure();
      if (st.inMemory <= st.budget) return void (await this.collect());
      const target = st.budget * 0.8;
      let inMemory = st.inMemory;
      const pinned = this.pinnedTiles();
      // Candidates: farthest from the current state first, across all images.
      const order: { dist: number; state: HistoryState }[] = [];
      for (const img of this.images()) {
        const h = img.history;
        h.states.forEach((s, i) => order.push({ dist: Math.abs(i - h.index), state: s }));
      }
      order.sort((a, b) => b.dist - a.dist);
      const evict: AnyTile[] = [];
      const picked = new Set<AnyTile>();
      for (const { state } of order) {
        if (inMemory <= target) break;
        for (const t of snapshotTiles(state.snapshot)) {
          if (!t.resident || pinned.has(t) || picked.has(t) || !t.frozen) continue;
          picked.add(t);
          evict.push(t);
          inMemory -= bytesOf(t);
          if (inMemory <= target) break;
        }
      }
      // A copy whose file is gone (deleted when nothing seemed to use it) doesn't count.
      for (const t of evict) if (t.swap && !this.files.has(t.swap.pack)) t.swap = null;
      // Tiles without a scratch copy are written first, all in one file.
      const fresh = evict.filter((t) => !t.swap);
      // In files of at most 64 MB, so paging never needs a huge buffer while memory is short.
      for (let i = 0; i < fresh.length; ) {
        const chunk: AnyTile[] = [];
        let total = 0;
        while (i < fresh.length && (total === 0 || total + bytesOf(fresh[i]) <= PACK_BYTES)) {
          total += bytesOf(fresh[i]);
          chunk.push(fresh[i++]);
        }
        const name = `p${this.nextFile++}`;
        const refs: [AnyTile, number][] = [];
        try {
          const buf = new Uint8Array(total);
          let o = 0;
          for (const t of chunk) {
            buf.set(t.data, o);
            refs.push([t, o]);
            o += bytesOf(t);
          }
          await this.store.write(name, buf);
        } catch (e) {
          this.failed = true;
          this.onError?.(e);
          break;
        }
        this.files.set(name, total);
        for (const [t, off] of refs) t.swap = { pack: name, offset: off, length: bytesOf(t) };
      }
      // Something may have started needing a tile while the file was written (an undo): check again.
      const still = this.pinnedTiles();
      for (const t of evict) if (t.swap && t.resident && !still.has(t)) t.evict();
      await this.collect();
    }).then(() => this.measure());
  }

  /** Tiles that must stay in memory. */
  private pinnedTiles(): Set<AnyTile> {
    const out = new Set<AnyTile>();
    for (const img of this.images()) {
      const h = img.history;
      for (const t of documentTiles(img.doc)) out.add(t);
      const keep = [h.states[h.index], h.states[h.index - 1], h.states[h.index + 1], h.opened ?? undefined, ...h.snapshots, ...(img.pinned ?? [])];
      for (const s of keep) if (s) for (const t of snapshotTiles(s.snapshot)) out.add(t);
    }
    return out;
  }

  /** Delete scratch files no tile refers to any more (states trimmed, images closed). */
  private async collect(): Promise<void> {
    if (!this.files.size) return;
    const used = new Set<string>();
    for (const img of this.images()) {
      for (const t of documentTiles(img.doc)) if (t.swap) used.add(t.swap.pack);
      for (const s of this.statesOf(img.history)) for (const t of snapshotTiles(s.snapshot)) if (t.swap) used.add(t.swap.pack);
    }
    const gone = [...this.files.keys()].filter((f) => !used.has(f));
    if (!gone.length) return;
    for (const f of gone) this.files.delete(f);
    await this.store.remove(gone).catch(() => {});
  }

  /** Everything back in memory and every scratch file deleted (before quitting, or to stop paging). */
  async clear(): Promise<void> {
    await this.run(async () => {
      for (const img of this.images()) for (const s of this.statesOf(img.history)) await this.loadTiles(snapshotTiles(s.snapshot));
      await this.store.remove([...this.files.keys()]).catch(() => {});
      this.files.clear();
      this.forgetCopies();
    });
  }

  /** Drop every tile's scratch copy reference (its file is about to go). */
  private forgetCopies(): void {
    for (const img of this.images()) {
      for (const s of this.statesOf(img.history)) for (const t of snapshotTiles(s.snapshot)) t.swap = null;
      for (const t of documentTiles(img.doc)) t.swap = null;
    }
  }
}
