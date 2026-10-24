/**
 * Where scratch files and recovery copies live: the folders chosen in
 * Preferences (desktop app), or the browser's private file system (the
 * browser build). See src/core/scratch.ts for what is paged and when.
 */

import type { ScratchStore } from "../core/scratch";
import { isDesktop } from "./files";

export interface DiskInfo {
  path: string;
  free: number;
  total: number;
  ok: boolean;
  error?: string | null;
}

export interface RecoveredFile {
  /** Opaque handle for recoveryRead / recoveryDiscard. */
  path: string;
  name: string;
  modified: number;
  size: number;
}

/** Scratch storage for this platform. configure() picks the folders (desktop) and cleans up after crashes. */
export interface Platform {
  /** Folders can be chosen (desktop); the browser always uses its own storage. */
  readonly folders: boolean;
  store: ScratchStore;
  configure(dirs: string[]): Promise<DiskInfo[]>;
  diskInfo(dirs: string[]): Promise<DiskInfo[]>;
  defaultDir(): Promise<string>;
  /** Installed memory in bytes (an estimate in the browser). */
  memory(): Promise<number>;
  recoverySave(key: string, name: string, bytes: Uint8Array): Promise<void>;
  recoveryForget(key: string): Promise<void>;
  recoveryList(): Promise<RecoveredFile[]>;
  recoveryRead(path: string): Promise<Uint8Array>;
  recoveryDiscard(paths: string[]): Promise<void>;
}

// ------------------------------------------------------------------ desktop

async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, opts?: { headers: Record<string, string> }): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args as never, opts);
}

function desktop(): Platform {
  return {
    folders: true,
    store: {
      write: (name, data) => invoke("scratch_write", data, { headers: { "x-name": name } }),
      read: async (name, offset, length) => new Uint8Array(await invoke<ArrayBuffer>("scratch_read", { name, offset, length })),
      remove: (names) => invoke("scratch_remove", { names }),
    },
    configure: (dirs) => invoke<DiskInfo[]>("scratch_configure", { dirs }),
    diskInfo: (dirs) => invoke<DiskInfo[]>("scratch_disk_info", { dirs }),
    defaultDir: () => invoke<string>("scratch_default_dir"),
    memory: () => invoke<number>("system_memory").catch(() => 0),
    recoverySave: (key, name, bytes) => invoke("recovery_save", bytes, { headers: { "x-key": key, "x-doc-name": encodeURIComponent(name) } }),
    recoveryForget: (key) => invoke("recovery_forget", { key }),
    recoveryList: () => invoke<RecoveredFile[]>("recovery_list").catch(() => []),
    recoveryRead: async (path) => new Uint8Array(await invoke<ArrayBuffer>("recovery_read", { path })),
    recoveryDiscard: (paths) => invoke("recovery_discard", { paths }),
  };
}

// ------------------------------------------------------------------ browser

/**
 * The browser's origin-private file system. Each tab holds a Web Lock named
 * after its session while it runs, so another tab can tell its folders from
 * those of a tab that crashed or was closed.
 */
function browser(): Platform | null {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  // Writing files from the page needs createWritable (Safari only has it in workers on older versions).
  if (!nav?.storage?.getDirectory || typeof FileSystemFileHandle === "undefined" || !("createWritable" in FileSystemFileHandle.prototype)) return null;
  const session = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const lockName = (s: string) => `cie-scratch-${s}`;
  // Held for the life of the tab.
  void nav.locks?.request(lockName(session), () => new Promise<void>(() => {}));
  const root = () => nav.storage.getDirectory();
  const dir = async (path: string[], create = true) => {
    let d = await root();
    for (const p of path) d = await d.getDirectoryHandle(p, { create });
    return d;
  };
  const alive = async (s: string) => {
    if (!nav.locks) return false;
    const q = await nav.locks.query();
    return [...(q.held ?? []), ...(q.pending ?? [])].some((l) => l.name === lockName(s));
  };
  const writeFile = async (d: FileSystemDirectoryHandle, name: string, data: Uint8Array) => {
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data as unknown as ArrayBuffer);
    await w.close();
  };
  return {
    folders: false,
    store: {
      write: async (name, data) => writeFile(await dir(["scratch", session]), name, data),
      read: async (name, offset, length) => {
        const f = await (await (await dir(["scratch", session])).getFileHandle(name)).getFile();
        return new Uint8Array(await f.slice(offset, offset + length).arrayBuffer());
      },
      remove: async (names) => {
        const d = await dir(["scratch", session]);
        for (const n of names) await d.removeEntry(n).catch(() => {});
      },
    },
    async configure() {
      // Folders of tabs that are gone.
      const s = await dir(["scratch"]);
      for await (const [name] of (s as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) {
        if (name !== session && !(await alive(name))) await s.removeEntry(name, { recursive: true }).catch(() => {});
      }
      // Some browsers list the private file system but can't write to it (private windows, some WebKit builds): find out now.
      const own = await dir(["scratch", session]);
      await writeFile(own, "probe", new Uint8Array([1]));
      await own.removeEntry("probe");
      return this.diskInfo([]);
    },
    async diskInfo() {
      const e = await nav.storage.estimate().catch(() => ({ quota: 0, usage: 0 }));
      const total = e.quota ?? 0;
      return [{ path: "Browser storage", free: Math.max(0, total - (e.usage ?? 0)), total, ok: true }];
    },
    defaultDir: async () => "Browser storage",
    memory: async () => ((nav as Navigator & { deviceMemory?: number }).deviceMemory ?? 4) * 1024 ** 3,
    recoverySave: async (key, name, bytes) => {
      const d = await dir(["recovery", session]);
      await writeFile(d, `${key}.cie`, bytes);
      await writeFile(d, `${key}.name`, new TextEncoder().encode(name));
    },
    recoveryForget: async (key) => {
      const d = await dir(["recovery", session]);
      await d.removeEntry(`${key}.cie`).catch(() => {});
      await d.removeEntry(`${key}.name`).catch(() => {});
    },
    async recoveryList() {
      const out: RecoveredFile[] = [];
      const r = await dir(["recovery"]);
      for await (const [s, h] of (r as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (s === session || h.kind !== "directory" || (await alive(s))) continue;
        const d = h as FileSystemDirectoryHandle;
        for await (const [n, fh] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (!n.endsWith(".cie")) continue;
          const f = await (fh as FileSystemFileHandle).getFile();
          let name = "Untitled";
          try {
            name = await (await (await d.getFileHandle(n.replace(/\.cie$/, ".name"))).getFile()).text();
          } catch {
            /* keep Untitled */
          }
          out.push({ path: `${s}/${n}`, name, modified: f.lastModified, size: f.size });
        }
      }
      return out;
    },
    recoveryRead: async (path) => {
      const [s, n] = path.split("/");
      const f = await (await (await dir(["recovery", s], false)).getFileHandle(n)).getFile();
      return new Uint8Array(await f.arrayBuffer());
    },
    recoveryDiscard: async (paths) => {
      for (const p of paths) {
        const [s, n] = p.split("/");
        try {
          const d = await dir(["recovery", s], false);
          await d.removeEntry(n).catch(() => {});
          await d.removeEntry(n.replace(/\.cie$/, ".name")).catch(() => {});
          let empty = true;
          for await (const _ of (d as unknown as { keys(): AsyncIterable<string> }).keys()) {
            void _;
            empty = false;
            break;
          }
          if (empty) await (await dir(["recovery"])).removeEntry(s).catch(() => {});
        } catch {
          /* already gone */
        }
      }
    },
  };
}

let platform: Platform | null | undefined;

/** This platform's scratch storage, or null when none is available (paging and recovery are then off). */
export function scratchPlatform(): Platform | null {
  if (platform === undefined) platform = isDesktop ? desktop() : browser();
  return platform;
}
