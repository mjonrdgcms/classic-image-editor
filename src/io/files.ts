/**
 * Opening and saving image files.
 *
 * In the desktop app this uses Tauri's native dialogs and file system; in a
 * browser (dev mode, tests) it falls back to a file picker and downloads.
 * M0 decodes and encodes with the webview's built-in codecs; the Rust
 * decoders (TIFF, PSD, 16-bit) arrive with the file-format milestone.
 */

import { readDensity } from "./density";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DecodedImage {
  name: string;
  width: number;
  height: number;
  /** Straight RGBA. */
  data: Uint8ClampedArray;
  /** Pixels per inch, when the file says. */
  resolution?: number;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "avif"];

export function isImageName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.includes(ext);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function decodeImage(blob: Blob, name: string): Promise<DecodedImage> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  } catch {
    throw new Error(`Could not open "${name}" because it is not a supported image file or it is damaged.`);
  }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  // The resolution is in the file's header.
  const head = new Uint8Array(await blob.slice(0, 1 << 18).arrayBuffer().catch(() => new ArrayBuffer(0)));
  return { name, width: img.width, height: img.height, data: img.data, resolution: readDensity(head) ?? undefined };
}

/** Ask the user for an image. Returns null if they cancelled. */
export async function pickImage(): Promise<DecodedImage | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Images", extensions: IMAGE_EXTS }],
    });
    if (!path || Array.isArray(path)) return null;
    const bytes = await readFile(path);
    return decodeImage(new Blob([bytes]), baseName(path));
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_EXTS.map((e) => "." + e).join(",");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  return file ? decodeImage(file, file.name) : null;
}

export type ExportFormat = "png" | "jpeg";

/**
 * Encode straight RGBA pixels. JPEG has no alpha, so transparency is matted
 * onto white first (as PS7 does). `quality` is 0..1.
 */
export async function encodeImage(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  format: ExportFormat,
  quality = 0.9,
): Promise<Blob> {
  const px = new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  if (format === "jpeg") {
    for (let p = 0; p < px.length; p += 4) {
      const a = px[p + 3] / 255;
      px[p] = px[p] * a + 255 * (1 - a);
      px[p + 1] = px[p + 1] * a + 255 * (1 - a);
      px[p + 2] = px[p + 2] * a + 255 * (1 - a);
      px[p + 3] = 255;
    }
  }
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(px, width, height), 0, 0);
  return c.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality });
}

/** Save a blob, asking where. Returns the chosen name, or null if cancelled. */
export async function saveBlob(blob: Blob, suggestedName: string, format: ExportFormat): Promise<string | null> {
  const ext = format === "png" ? "png" : "jpg";
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: format === "png" ? "PNG" : "JPEG", extensions: format === "png" ? ["png"] : ["jpg", "jpeg"] }],
    });
    if (!path) return null;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return baseName(path);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName.endsWith("." + ext) ? suggestedName : `${suggestedName}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return a.download;
}

/** A file the user picked to open: an image or a .cie project. */
export interface PickedFile {
  name: string;
  /** Full path on the desktop (null in a browser). */
  path: string | null;
  bytes: Uint8Array;
}

export const OPEN_EXTS = [...IMAGE_EXTS, "cie"];

export function isOpenableName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return OPEN_EXTS.includes(ext);
}

/** Ask for a picture or a project to open. */
export async function pickOpenFile(): Promise<PickedFile | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "All Supported Files", extensions: OPEN_EXTS },
        { name: "Classic Image Editor", extensions: ["cie"] },
        { name: "Images", extensions: IMAGE_EXTS },
      ],
    });
    if (!path || Array.isArray(path)) return null;
    return { name: baseName(path), path, bytes: await readFile(path) };
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = OPEN_EXTS.map((e) => "." + e).join(",");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  return file ? { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

/** Read a file by path (desktop: Open Recent, Revert). */
export async function readPath(path: string): Promise<Uint8Array> {
  const { invoke } = await import("@tauri-apps/api/core");
  return new Uint8Array(await invoke<ArrayBuffer>("read_user_file", { path }));
}

/** Files the desktop app was started with (double-clicked .cie files). */
export async function launchFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("launch_files").catch(() => []);
}

/**
 * Save bytes. With a path (desktop), write there without asking; otherwise
 * ask where. Returns the path (desktop) or file name (browser), or null if cancelled.
 */
export async function saveBytes(bytes: Uint8Array, suggestedName: string, filter: { name: string; ext: string }, path?: string | null): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    let target = path ?? (await save({ defaultPath: suggestedName, filters: [{ name: filter.name, extensions: [filter.ext] }] }));
    if (!target) return null;
    if (!/\.[a-z0-9]+$/i.test(baseName(target))) target += "." + filter.ext;
    // Through the app (not the fs plugin), so files opened from anywhere can be saved back.
    await invoke("write_user_file", bytes, { headers: { "x-path": encodeURIComponent(target) } });
    return target;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName.toLowerCase().endsWith("." + filter.ext) ? suggestedName : `${suggestedName}.${filter.ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return a.download;
}

/** Save a text file (workspaces, brush sets). */
export async function saveText(text: string, suggestedName: string): Promise<string | null> {
  if (isDesktop) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ defaultPath: suggestedName, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return null;
    await writeTextFile(path, text);
    return baseName(path);
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return suggestedName;
}

/** Ask for a text file and return its contents. */
export async function pickText(exts: string[]): Promise<string | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Files", extensions: exts.map((e) => e.replace(/^\./, "")) }] });
    if (!path || Array.isArray(path)) return null;
    return readTextFile(path);
  }
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = exts.join(",");
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  return file ? file.text() : null;
}

/** Ask for any files (several allowed) and return their names and bytes. */
export async function pickBinaryFiles(exts: string[]): Promise<{ name: string; bytes: Uint8Array }[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const paths = await open({ multiple: true, directory: false, filters: [{ name: "Files", extensions: exts.map((e) => e.replace(/^\./, "")) }] });
    if (!paths) return [];
    const list = Array.isArray(paths) ? paths : [paths];
    return Promise.all(list.map(async (p) => ({ name: baseName(p), bytes: await readFile(p) })));
  }
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = exts.join(",");
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

// ------------------------------------------------------------------ batch helpers

/** An image file to process: a name and a way to read it. */
export interface SourceFile {
  name: string;
  /** Folder-relative path (for keeping subfolders), or the name. */
  rel: string;
  read(): Promise<Blob>;
}

/** Pick several image files. */
export async function pickImageFiles(): Promise<SourceFile[]> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const paths = await open({ multiple: true, directory: false, filters: [{ name: "Images", extensions: IMAGE_EXTS }] });
    if (!paths) return [];
    return (Array.isArray(paths) ? paths : [paths]).map((p) => ({ name: baseName(p), rel: baseName(p), read: async () => new Blob([await readFile(p)]) }));
  }
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = IMAGE_EXTS.map((e) => "." + e).join(",");
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
  return files.filter((f) => isImageName(f.name)).map((f) => ({ name: f.name, rel: f.name, read: async () => f }));
}

/** Pick a folder of images (desktop: a real folder; browser: a folder upload). */
export async function pickImageFolder(recursive: boolean): Promise<{ label: string; files: SourceFile[] } | null> {
  if (isDesktop) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readDir, readFile } = await import("@tauri-apps/plugin-fs");
    const dir = await open({ directory: true, multiple: false, recursive: true });
    if (!dir || Array.isArray(dir)) return null;
    const out: SourceFile[] = [];
    const walk = async (path: string, rel: string) => {
      for (const e of await readDir(path)) {
        const p = `${path}/${e.name}`;
        if (e.isDirectory && recursive) await walk(p, rel ? `${rel}/${e.name}` : e.name);
        else if (e.isFile && isImageName(e.name)) out.push({ name: e.name, rel: rel ? `${rel}/${e.name}` : e.name, read: async () => new Blob([await readFile(p)]) });
      }
    };
    await walk(dir, "");
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return { label: dir, files: out };
  }
  const files = await new Promise<File[]>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
  const list = files
    .filter((f) => isImageName(f.name))
    .map((f) => {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/").slice(1).join("/") || f.name;
      return { name: f.name, rel, read: async () => f as Blob };
    })
    .filter((f) => recursive || !f.rel.includes("/"));
  if (!list.length) return null;
  return { label: (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split("/")[0] ?? "Folder", files: list };
}

/** Desktop only: choose a destination folder. */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, recursive: true });
  return !dir || Array.isArray(dir) ? null : dir;
}

/** Where batch results go: a folder on disk, or (in a browser) a zip download. */
export class OutputSink {
  private zipFiles: Record<string, Uint8Array> = {};
  constructor(readonly folder: string | null) {}

  async write(rel: string, blob: Blob): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (this.folder && isDesktop) {
      const { writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
      const path = `${this.folder}/${rel}`;
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (rel.includes("/")) await mkdir(dir, { recursive: true }).catch(() => {});
      await writeFile(path, bytes);
    } else this.zipFiles[rel] = bytes;
  }

  get count(): number {
    return Object.keys(this.zipFiles).length;
  }

  /** Browser: download everything as one zip. */
  async finish(name: string): Promise<void> {
    if (!this.count) return;
    const { zipSync } = await import("fflate");
    const data = zipSync(this.zipFiles, { level: 0 });
    await saveBlobAs(new Blob([data as BlobPart], { type: "application/zip" }), name);
  }
}

async function saveBlobAs(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
