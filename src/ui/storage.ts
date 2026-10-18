/**
 * Persistent settings (preferences, workspaces, brushes, shortcuts).
 *
 * Stored in the webview's localStorage, which the desktop app keeps per
 * user across restarts. Every access is guarded: storage can be missing
 * or full, and the app must work without it.
 */

const PREFIX = "cie.";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Told (once per key) when something could not be saved, e.g. storage is full. */
let failed: ((key: string) => void) | null = null;
const reported = new Set<string>();
export function onSaveFailed(fn: (key: string) => void): void {
  failed = fn;
}

export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    reported.delete(key);
    return true;
  } catch {
    if (!reported.has(key)) {
      reported.add(key);
      failed?.(key);
    }
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Debounced save, for things that change continuously (palette drags, sliders). */
const timers = new Map<string, { t: number; value: () => unknown }>();
export function saveSoon(key: string, value: () => unknown, ms = 400): void {
  clearTimeout(timers.get(key)?.t);
  timers.set(key, {
    value,
    t: setTimeout(() => {
      timers.delete(key);
      save(key, value());
    }, ms),
  });
}

/** Write any pending debounced saves now (on quit). */
export function flush(): void {
  for (const [key, { t, value }] of timers) {
    clearTimeout(t);
    save(key, value());
  }
  timers.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
}
