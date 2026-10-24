/**
 * Crash recovery: every few minutes (Preferences > File Handling) a copy of
 * each changed image goes to the scratch disk; saving or closing the image
 * removes it, and so does quitting normally. If the editor stops without
 * that, the next start offers to open the copies.
 */

import type { App } from "../app";
import { encodeProjectAsync } from "../io/project";
import { scratchPlatform, type RecoveredFile } from "../io/scratchstore";
import { isDesktop } from "../io/files";
import { el, isModalOpen, modal } from "./dialogs";

export function startRecovery(app: App): void {
  const p = scratchPlatform();
  if (!p) return;
  /** Session id -> the history state its recovery copy shows. */
  const saved = new Map<number, number>();
  let last = Date.now();
  let busy = false;
  const keyOf = (id: number) => `d${id}`;
  const tick = async () => {
    const minutes = app.prefs.recoveryMinutes;
    if (busy || app.scratchUnavailable || minutes <= 0 || Date.now() - last < minutes * 60000) return;
    // Not in the middle of something that holds the image in a temporary state
    // (a drag, Free Transform, a dialog previewing a filter).
    if (app.isDragging || app.baseTool.id === "transform" || isModalOpen()) return;
    busy = true;
    last = Date.now();
    try {
      for (const s of [...app.sessions]) {
        const state = s.history.current?.id;
        if (!app.sessionModified(s) || state === undefined || saved.get(s.id) === state) continue;
        const bytes = await encodeProjectAsync(s.doc);
        if (!app.sessions.includes(s)) continue;
        await p.recoverySave(keyOf(s.id), s.doc.name, bytes);
        saved.set(s.id, state);
      }
    } catch (e) {
      app.status(`Could not save recovery information: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), 15000);
  // Saved or closed images don't need their copies.
  const prune = () => {
    for (const [id] of saved) {
      const s = app.sessions.find((x) => x.id === id);
      if (!s || !app.sessionModified(s)) {
        saved.delete(id);
        void p.recoveryForget(keyOf(id)).catch(() => {});
      }
    }
  };
  app.on("sessions", prune);
  app.on("doc", prune);
  // Leaving the page on purpose (the browser asked about unsaved changes first) isn't a crash.
  // The desktop app cleans up on exit itself.
  if (!isDesktop) window.addEventListener("pagehide", () => {
    for (const [id] of saved) void p.recoveryForget(keyOf(id)).catch(() => {});
  });
}

/** At startup: offer the copies a crashed editor left behind. */
export async function offerRecovery(app: App): Promise<void> {
  const p = scratchPlatform();
  if (!p) return;
  await app.scratchReady;
  if (app.scratchUnavailable) return;
  const files = await p.recoveryList().catch(() => [] as RecoveredFile[]);
  if (!files.length) return;
  const rows = files.map((f) => ({ f, box: el("input", { type: "checkbox", checked: true }) as HTMLInputElement }));
  const when = (f: RecoveredFile) => new Date(f.modified).toLocaleString();
  const body = el(
    "div",
    { class: "form recovery" },
    el("p", { text: "Classic Image Editor did not close normally last time. These images had unsaved changes; recovery copies were kept:" }),
    ...rows.map(({ f, box }) => el("label", { class: "rec-row" }, box, el("b", { text: f.name }), el("span", { class: "rec-when", text: ` saved ${when(f)}` }))),
    el("p", { class: "hint", text: "Opened copies are unsaved: save them where you want to keep them. Copies you don't open are deleted." }),
  );
  const r = await modal("Recover Images", body, [
    { label: "Open Selected", value: "open", default: true },
    { label: "Delete All", value: "discard" },
  ]);
  const done: string[] = [];
  for (const { f, box } of rows) {
    if (r === "open" && box.checked) {
      try {
        await app.openProject(await p.recoveryRead(f.path), f.name, null, true);
      } catch (e) {
        app.toast(`Could not recover "${f.name}": ${e instanceof Error ? e.message : String(e)}.`);
        continue;
      }
    }
    done.push(f.path);
  }
  // Esc / closing the dialog keeps the copies for next time.
  if (r === "open" || r === "discard") await p.recoveryDiscard(done).catch(() => {});
}
