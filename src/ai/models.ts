/**
 * The AI model files behind Select > People and Face-Aware Liquify:
 * MediaPipe's vision runtime (WebAssembly), its body-part segmenter and
 * its face landmarker, all Apache 2.0.
 *
 * They are too big to carry inside the program, so they are fetched once
 * from Google's and jsDelivr's servers and kept: on the desktop in the
 * app's data folder (downloaded by the native side), in a browser in
 * IndexedDB. A machine with no internet can load the same files by hand.
 */

import { isDesktop } from "../io/files";

/** Must match the installed @mediapipe/tasks-vision package (the runtime and its JS glue are one build). */
export const TASKS_VISION_VERSION = "1.1.1";

const MP = "https://storage.googleapis.com/mediapipe-models/";
const RT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm/`;

export interface ModelFile {
  name: string;
  url: string;
  /** Expected size in bytes (a finished file of another size is fetched again). */
  size: number;
  /** SHA-256 of the file, checked after every download or import. */
  sha256: string;
  label: string;
}

export const MODEL_FILES = {
  runtimeJs: {
    name: "vision_wasm_internal.js",
    url: RT + "vision_wasm_internal.js",
    size: 334128,
    sha256: "6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8",
    label: "Vision runtime (script)",
  },
  runtimeWasm: {
    name: "vision_wasm_internal.wasm",
    url: RT + "vision_wasm_internal.wasm",
    size: 13519922,
    sha256: "0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd",
    label: "Vision runtime",
  },
  segmenter: {
    name: "selfie_multiclass_256x256.tflite",
    url: MP + "image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    size: 16371837,
    sha256: "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
    label: "People and body parts",
  },
  face: {
    name: "face_landmarker.task",
    url: MP + "face_landmarker/face_landmarker/float16/1/face_landmarker.task",
    size: 3758596,
    sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
    label: "Face landmarks",
  },
} satisfies Record<string, ModelFile>;

export type ModelKey = keyof typeof MODEL_FILES;
export const ALL_MODELS = Object.keys(MODEL_FILES) as ModelKey[];
export const totalBytes = (keys: ModelKey[]) => keys.reduce((s, k) => s + MODEL_FILES[k].size, 0);

// ------------------------------------------------------------------ storage

interface Store {
  /** Sizes of the stored files (0 = missing). */
  sizes(names: string[]): Promise<number[]>;
  /** Fetch one file, reporting bytes received. */
  fetch(f: ModelFile, progress: (bytes: number) => void, signal: AbortSignal): Promise<void>;
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  remove(names: string[]): Promise<void>;
  where(): Promise<string>;
}

const desktopStore = (): Store => {
  const core = () => import("@tauri-apps/api/core");
  const status = async (names: string[]) => (await core()).invoke<{ dir: string; files: { name: string; size: number; part: number }[] }>("model_status", { names });
  return {
    async sizes(names) {
      return (await status(names)).files.map((f) => f.size);
    },
    async fetch(f, progress, signal) {
      // The native side knows the address of each file; only the name goes across.
      const { invoke } = await core();
      let stop = false;
      const poll = async () => {
        while (!stop) {
          await new Promise((r) => setTimeout(r, 250));
          if (stop) break;
          const s = await status([f.name]).catch(() => null);
          if (s) progress(s.files[0].part || s.files[0].size);
        }
      };
      const cancel = () => void invoke("model_cancel", { name: f.name }).catch(() => {});
      signal.addEventListener("abort", cancel);
      void poll();
      try {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        await invoke("model_download", { name: f.name }).catch(async (e) => {
          const msg = String(e);
          if (signal.aborted || msg === "Stopped") throw new DOMException("Stopped", "AbortError");
          if (!/already downloading/.test(msg)) throw new Error(msg);
          // Another window is fetching it: wait for that download.
          while (!signal.aborted && (await status([f.name])).files[0].part > 0) await new Promise((r) => setTimeout(r, 300));
        });
      } finally {
        stop = true;
        signal.removeEventListener("abort", cancel);
      }
      progress(f.size);
    },
    async read(name) {
      const { invoke } = await core();
      const buf = await invoke<ArrayBuffer>("model_read", { name });
      return new Uint8Array(buf);
    },
    async write(name, data) {
      const { invoke } = await core();
      await invoke("model_write", data, { headers: { "x-model-name": name } });
    },
    async remove(names) {
      const { invoke } = await core();
      await invoke("model_remove", { names });
    },
    async where() {
      return (await status([])).dir;
    },
  };
};

const webStore = (): Store => {
  const DB = "cie-ai-models";
  const open = () =>
    new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error ?? new Error("This browser could not open its storage."));
    });
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("files", mode);
      const req = fn(t.objectStore("files"));
      t.oncomplete = () => {
        db.close();
        res(req ? req.result : undefined);
      };
      // WebKit can fail a transaction with no error object (private storage, quota).
      const fail = () => rej(t.error ?? req?.error ?? new Error("This browser could not save the file (its storage may be private or full)."));
      t.onerror = fail;
      t.onabort = fail;
    });
  };
  // Older versions stored Blobs; WebKit can't store Blobs in private storage, so new files are ArrayBuffers.
  type Stored = Blob | ArrayBuffer;
  const size = (v: Stored) => (v instanceof Blob ? v.size : v.byteLength);
  return {
    async sizes(names) {
      const out: number[] = [];
      for (const n of names) {
        const v = await tx<Stored>("readonly", (s) => s.get(n)).catch(() => undefined);
        out.push(v ? size(v) : 0);
      }
      return out;
    },
    async fetch(f, progress, signal) {
      const r = await fetch(f.url, { signal });
      if (!r.ok || !r.body) throw new Error(`${f.label}: the server answered ${r.status}`);
      const reader = r.body.getReader();
      const parts: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        n += value.length;
        progress(n);
      }
      await this.write(f.name, concat(parts, n));
    },
    async read(name) {
      const b = await tx<Stored>("readonly", (s) => s.get(name));
      if (!b) throw new Error(`${name} is not downloaded`);
      return new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b);
    },
    async write(name, data) {
      const buf = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
      await tx("readwrite", (s) => s.put(buf, name));
    },
    async remove(names) {
      for (const n of names) await tx("readwrite", (s) => s.delete(n));
    },
    async where() {
      return "this browser's storage";
    },
  };
};

function concat(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

let store: Store | null = null;
const st = () => (store ??= isDesktop ? desktopStore() : webStore());

// ------------------------------------------------------------------ API

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Check a stored file against its hash; a bad one is deleted so it gets fetched again. */
async function verify(k: ModelKey): Promise<void> {
  const f = MODEL_FILES[k];
  const bytes = await st().read(f.name);
  if (bytes.length === f.size && (await sha256(bytes)) === f.sha256) return;
  await st().remove([f.name]);
  throw new Error(`${f.label} arrived damaged (its checksum does not match); please try again`);
}

/** Which of these files still need fetching. */
export async function missingModels(keys: ModelKey[] = ALL_MODELS): Promise<ModelKey[]> {
  const sizes = await st().sizes(keys.map((k) => MODEL_FILES[k].name));
  return keys.filter((k, i) => sizes[i] !== MODEL_FILES[k].size);
}

/** Fetch the given files one after another. progress gets (bytes done, bytes total, current label). */
export async function downloadModels(keys: ModelKey[], progress: (done: number, total: number, label: string) => void, signal: AbortSignal): Promise<void> {
  const total = totalBytes(keys);
  let before = 0;
  for (const k of keys) {
    const f = MODEL_FILES[k];
    progress(before, total, f.label);
    await st().fetch(f, (b) => progress(before + Math.min(b, f.size), total, f.label), signal);
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    await verify(k);
    before += f.size;
  }
  const still = await missingModels(keys);
  if (still.length) throw new Error(`${MODEL_FILES[still[0]].label} did not download completely; please try again`);
}

/** Store files the user picked by hand; returns the keys that matched. */
export async function importModelFiles(files: { name: string; bytes: Uint8Array }[]): Promise<ModelKey[]> {
  const got: ModelKey[] = [];
  for (const f of files) {
    const k = ALL_MODELS.find((k) => MODEL_FILES[k].name === f.name.replace(/^.*[\\/]/, ""));
    if (!k) continue;
    if (f.bytes.length !== MODEL_FILES[k].size || (await sha256(f.bytes)) !== MODEL_FILES[k].sha256) throw new Error(`${f.name} is not the expected version of this file (its size or checksum differs).`);
    await st().write(MODEL_FILES[k].name, f.bytes);
    got.push(k);
  }
  return got;
}

export async function readModel(k: ModelKey): Promise<Uint8Array> {
  return st().read(MODEL_FILES[k].name);
}

export async function removeModels(): Promise<void> {
  await st().remove(ALL_MODELS.map((k) => MODEL_FILES[k].name));
}

export async function modelsFolder(): Promise<string> {
  return st().where();
}
