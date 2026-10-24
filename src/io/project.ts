/**
 * The editor's own file format (.cie): everything needed to keep working
 * on an image later — layers, sets, masks, type, blend modes, locks, the
 * selection and guides.
 *
 * A .cie file is a zip:
 *   doc.json         the document structure and every layer's settings
 *   px/<n>.bin       one layer's pixels (only its non-empty 256x256 tiles)
 *   mk/<n>.bin       one mask (only tiles that differ from its default)
 *   preview.png      a small flattened picture (optional, for file browsers)
 *
 * Tile blobs: u32 count, count x u32 tile index, then the tiles' bytes.
 */

import { strFromU8, strToU8, unzip, unzipSync, zip, zipSync } from "fflate";
import { Document, Group, Layer, type GroupProps, type LayerProps, type Node, type DocPath, type Note, type Slice } from "../core/document";
import { Mask, MaskTile } from "../core/mask";
import { normalizePath } from "../core/vector";
import { TILE, Tile, TileGrid } from "../core/tiles";

export const PROJECT_EXT = "cie";
const FORMAT = "classic-image-editor";
const VERSION = 1;

interface MaskJson {
  w: number;
  h: number;
  def: 0 | 255;
  file: string;
}
interface LayerJson {
  kind: "layer";
  props: LayerProps;
  w: number;
  h: number;
  file: string;
  mask: MaskJson | null;
}
interface GroupJson {
  kind: "group";
  props: GroupProps;
  children: LayerJson[];
  mask: MaskJson | null;
}
interface DocJson {
  format: string;
  version: number;
  app: string;
  /** Pixels per inch (since 0.11). */
  resolution?: number;
  width: number;
  height: number;
  activeId: number;
  guides: { h: number[]; v: number[] };
  notes?: Note[];
  slices?: Slice[];
  paths?: DocPath[];
  selection: MaskJson | null;
  foreground?: number[];
  background?: number[];
  stack: (LayerJson | GroupJson)[];
}

function packTiles(tiles: ({ data: Uint8Array | Uint8ClampedArray } | null)[], keep: (i: number) => boolean, bytesPerTile: number): Uint8Array {
  const idx: number[] = [];
  tiles.forEach((t, i) => t && keep(i) && idx.push(i));
  const head = 4 + idx.length * 4;
  const out = new Uint8Array(head + idx.length * bytesPerTile);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, idx.length, true);
  idx.forEach((ti, k) => {
    dv.setUint32(4 + k * 4, ti, true);
    const d = tiles[ti]!.data;
    out.set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), head + k * bytesPerTile);
  });
  return out;
}

function unpackTiles(bytes: Uint8Array, count: number, bytesPerTile: number, make: (data: Uint8Array) => void, put: (index: number) => void): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  const head = 4 + n * 4;
  if (bytes.length < head + n * bytesPerTile) throw new Error("a layer's data is cut short");
  for (let k = 0; k < n; k++) {
    const ti = dv.getUint32(4 + k * 4, true);
    if (ti >= count) throw new Error("a layer's data is damaged");
    make(bytes.slice(head + k * bytesPerTile, head + (k + 1) * bytesPerTile));
    put(ti);
  }
}

/** Write a document as a .cie file. */
export function encodeProject(doc: Document, preview?: Uint8Array | null): Uint8Array {
  // Level 1: tiles of photos barely compress further, and saving stays quick.
  return zipSync(projectFiles(doc, preview), { level: 1 });
}

/** The same, compressing in background workers so the window stays responsive. */
export function encodeProjectAsync(doc: Document, preview?: Uint8Array | null): Promise<Uint8Array> {
  const files = projectFiles(doc, preview);
  return new Promise((resolve, reject) => zip(files, { level: 1 }, (err, data) => (err ? reject(err) : resolve(data))));
}

/** Read a .cie file, decompressing in background workers. */
export async function decodeProjectAsync(bytes: Uint8Array, name: string): Promise<Document> {
  let files: Record<string, Uint8Array>;
  try {
    files = await new Promise((resolve, reject) => unzip(bytes, (err, data) => (err ? reject(err) : resolve(data))));
  } catch {
    throw new Error(`"${name}" is not a Classic Image Editor file, or it is damaged.`);
  }
  return projectFromFiles(files, name);
}

function projectFiles(doc: Document, preview?: Uint8Array | null): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  const maskJson = (m: Mask | null): MaskJson | null => {
    if (!m) return null;
    const file = `mk/${n++}.bin`;
    // Tiles equal to the default (or absent) are left out.
    files[file] = packTiles(m.tiles, (i) => m.tiles[i]!.uniform() !== m.defaultValue, TILE * TILE);
    return { w: m.width, h: m.height, def: m.defaultValue, file };
  };
  const layerJson = (l: Layer): LayerJson => {
    const file = `px/${n++}.bin`;
    files[file] = packTiles(l.grid.tiles, (i) => !l.grid.tiles[i]!.isEmpty(), TILE * TILE * 4);
    return { kind: "layer", props: l.props(), w: l.grid.width, h: l.grid.height, file, mask: maskJson(l.mask) };
  };
  const json: DocJson = {
    format: FORMAT,
    version: VERSION,
    app: "Classic Image Editor",
    width: doc.width,
    resolution: doc.resolution,
    height: doc.height,
    activeId: doc.activeLayerId,
    guides: { h: [...doc.guides.h], v: [...doc.guides.v] },
    notes: doc.notes,
    slices: doc.slices,
    paths: doc.paths,
    selection: maskJson(doc.selection),
    foreground: [...doc.foreground],
    background: [...doc.background],
    stack: doc.stack.map((node) =>
      node.kind === "layer" ? layerJson(node) : { kind: "group", props: node.props(), children: node.children.map(layerJson), mask: maskJson(node.mask) },
    ),
  };
  files["doc.json"] = strToU8(JSON.stringify(json));
  if (preview) files["preview.png"] = preview;
  return files;
}

export function isProject(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Read a .cie file into a new document. Layer ids are renumbered to stay unique among open images. */
export function decodeProject(bytes: Uint8Array, name: string): Document {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(`"${name}" is not a Classic Image Editor file, or it is damaged.`);
  }
  return projectFromFiles(files, name);
}

function projectFromFiles(files: Record<string, Uint8Array>, name: string): Document {
  if (!files["doc.json"]) throw new Error(`"${name}" is not a Classic Image Editor file.`);
  const json = JSON.parse(strFromU8(files["doc.json"])) as DocJson;
  if (json.format !== FORMAT) throw new Error(`"${name}" is not a Classic Image Editor file.`);
  if (json.version > VERSION) throw new Error(`"${name}" was saved by a newer version of Classic Image Editor. Please update to open it.`);
  if (!(json.width > 0 && json.height > 0 && json.width <= 30000 && json.height <= 30000)) throw new Error(`"${name}" has an impossible size.`);

  const file = (f: string) => {
    const b = files[f];
    if (!b) throw new Error(`"${name}" is missing ${f}.`);
    return b;
  };
  const readMask = (m: MaskJson | null): Mask | null => {
    if (!m) return null;
    const mask = new Mask(m.w, m.h, m.def);
    let pending: MaskTile | null = null;
    unpackTiles(file(m.file), mask.tiles.length, TILE * TILE, (d) => (pending = new MaskTile(d)), (i) => (mask.tiles[i] = pending));
    return mask;
  };
  const ids = new Map<number, number>();
  const readLayer = (lj: LayerJson): Layer => {
    const l = new Layer(lj.w, lj.h, lj.props.name);
    ids.set(lj.props.id, l.id);
    Object.assign(l, lj.props, { id: l.id, locks: { ...lj.props.locks } });
    const grid = new TileGrid(lj.w, lj.h);
    let pending: Tile | null = null;
    unpackTiles(file(lj.file), grid.tiles.length, TILE * TILE * 4, (d) => (pending = new Tile(new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength))), (i) => (grid.tiles[i] = pending));
    l.grid = grid;
    l.mask = readMask(lj.mask);
    return l;
  };
  const doc = new Document(json.width, json.height, name);
  if (typeof json.resolution === "number" && json.resolution > 0) doc.resolution = json.resolution;
  doc.stack = json.stack.map((nj): Node => {
    if (nj.kind === "layer") return readLayer(nj);
    const g = new Group(nj.props.name);
    ids.set(nj.props.id, g.id);
    Object.assign(g, nj.props, { id: g.id });
    g.children = nj.children.map(readLayer);
    g.mask = readMask(nj.mask);
    return g;
  });
  if (!doc.stack.length) throw new Error(`"${name}" has no layers.`);
  doc.activeLayerId = ids.get(json.activeId) ?? doc.layers[doc.layers.length - 1].id;
  doc.guides = { h: [...(json.guides?.h ?? [])], v: [...(json.guides?.v ?? [])] };
  doc.notes = (json.notes ?? []).map((n) => ({ ...n }));
  doc.slices = (json.slices ?? []).map((n) => ({ ...n }));
  doc.paths = (json.paths ?? []).filter((p) => p && Array.isArray(p.path?.subpaths)).map((p) => ({ id: p.id, name: String(p.name), work: !!p.work, path: normalizePath(p.path) }));
  doc.selection = readMask(json.selection);
  if (json.foreground?.length === 4) doc.foreground = json.foreground as Document["foreground"];
  if (json.background?.length === 4) doc.background = json.background as Document["background"];
  return doc;
}
