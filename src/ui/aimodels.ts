/**
 * The one-time download of the AI models (people and face detection), with
 * progress, and a way to load the files by hand on an offline machine.
 */

import type { App } from "../app";
import { ALL_MODELS, MODEL_FILES, downloadModels, importModelFiles, missingModels, modelsFolder, removeModels, totalBytes, type ModelKey } from "../ai/models";
import { pickBinaryFiles } from "../io/files";
import { confirmDialog, el, modal, sheet } from "./dialogs";

export const PEOPLE_MODELS: ModelKey[] = ["runtimeJs", "runtimeWasm", "segmenter"];
export const FACE_MODELS: ModelKey[] = ["runtimeJs", "runtimeWasm", "segmenter", "face"];

const mb = (n: number) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;

/**
 * Make sure the given model files are present, asking to download them if
 * not. Resolves false if the user cancels.
 */
export async function ensureModels(app: App, keys: ModelKey[], feature: string): Promise<boolean> {
  let missing: ModelKey[];
  try {
    missing = await missingModels(keys);
  } catch (e) {
    app.toast(`Could not check the AI models: ${(e as Error).message}`);
    return false;
  }
  if (!missing.length) return true;

  const all = keys;
  const rows = new Map<ModelKey, HTMLElement>();
  const list = el("ul", { class: "ai-files" });
  const refreshRows = (have: Set<ModelKey>) => {
    list.textContent = "";
    for (const k of all) {
      const f = MODEL_FILES[k];
      const li = el("li", { class: have.has(k) ? "ok" : "" }, el("span", { class: "ai-tick", text: have.has(k) ? "✓" : "" }), el("span", { text: f.label }), el("span", { class: "ai-size", text: mb(f.size) }));
      rows.set(k, li);
      list.append(li);
    }
  };
  refreshRows(new Set(all.filter((k) => !missing.includes(k))));

  const bar = el("div", { class: "ai-bar" }, el("div", { class: "ai-fill" }));
  const fill = bar.firstElementChild as HTMLElement;
  const state = el("div", { class: "ai-state", role: "status", text: `${mb(totalBytes(missing))} to download.` });
  const err = el("div", { class: "ai-error", role: "alert" });
  const dl = el("button", { type: "button", class: "btn default", text: "Download" });
  const load = el("button", { type: "button", class: "btn", text: "Load Files...", title: "Use model files copied from another computer" });
  const cancel = el("button", { type: "button", class: "btn", text: "Cancel" });
  const body = el(
    "div",
    { class: "ai-dl" },
    el("p", {
      text: `${feature} uses on-device AI models (MediaPipe, by Google, Apache 2.0 license). They are a one-time download; after that they work offline, and your images never leave this computer.`,
    }),
    list,
    bar,
    state,
    err,
    el("div", { class: "ai-buttons" }, load, el("span", { style: "flex:1" }), cancel, dl),
  );
  const dlg = sheet("AI Models", body, { className: "ai-dialog" });
  let ctrl: AbortController | null = null;
  cancel.addEventListener("click", () => {
    ctrl?.abort();
    dlg.close("cancel");
  });
  dl.addEventListener("click", async () => {
    err.textContent = "";
    dl.disabled = load.disabled = true;
    ctrl = new AbortController();
    try {
      await downloadModels(
        missing,
        (done, total, label) => {
          fill.style.width = `${(done / total) * 100}%`;
          state.textContent = `${label}: ${mb(done)} of ${mb(total)}`;
        },
        ctrl.signal,
      );
      dlg.close("ok");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      err.textContent = `The download failed: ${(e as Error).message}. Check the internet connection and try again, or load the files by hand.`;
      dl.textContent = "Try Again";
      dl.disabled = load.disabled = false;
      missing = await missingModels(keys).catch(() => missing);
      refreshRows(new Set(all.filter((k) => !missing.includes(k))));
    }
  });
  load.addEventListener("click", async () => {
    err.textContent = "";
    try {
      const files = await pickBinaryFiles([".js", ".wasm", ".tflite", ".task"]);
      if (!files.length) return;
      const got = await importModelFiles(files);
      if (!got.length) err.textContent = `None of those are the model files. They are named ${missing.map((k) => MODEL_FILES[k].name).join(", ")}.`;
      missing = await missingModels(keys);
      refreshRows(new Set(all.filter((k) => !missing.includes(k))));
      if (!missing.length) dlg.close("ok");
      else state.textContent = `Still needed: ${missing.map((k) => MODEL_FILES[k].name).join(", ")}`;
    } catch (e) {
      err.textContent = (e as Error).message;
    }
  });
  dl.focus();
  const r = await dlg.done;
  // Closing the dialog any way (Esc, the X, Cancel) stops a running download.
  if (r !== "ok") (ctrl as AbortController | null)?.abort();
  return r === "ok";
}

/** Help > AI Models...: what is installed, where, and a way to download or remove it. */
export async function manageModels(app: App): Promise<void> {
  const missing = await missingModels(ALL_MODELS).catch(() => ALL_MODELS);
  const where = await modelsFolder().catch(() => "");
  const list = el(
    "ul",
    { class: "ai-files" },
    ...ALL_MODELS.map((k) => {
      const ok = !missing.includes(k);
      return el("li", { class: ok ? "ok" : "" }, el("span", { class: "ai-tick", text: ok ? "✓" : "" }), el("span", { text: MODEL_FILES[k].label }), el("span", { class: "ai-size", text: ok ? mb(MODEL_FILES[k].size) : "not downloaded" }));
    }),
  );
  const body = el(
    "div",
    {},
    el("p", { text: "Select > Subject, Select > People, Face-Aware Liquify and the Face Swap tool run these on-device models (MediaPipe, by Google, Apache 2.0 license). Your images never leave this computer." }),
    list,
    where ? el("p", { class: "ai-where", text: `Stored in ${where}.` }) : null,
  );
  const buttons = [{ label: "Close", value: "cancel", default: true }];
  if (missing.length) buttons.unshift({ label: "Download...", value: "download", default: false });
  if (missing.length < ALL_MODELS.length) buttons.unshift({ label: "Remove", value: "remove", default: false });
  const r = await modal("AI Models", body, buttons);
  if (r === "download") await ensureModels(app, ALL_MODELS, "People selection, Face-Aware Liquify and Face Swap");
  if (r === "remove" && (await confirmDialog("Remove AI Models", `Delete the downloaded models (${mb(totalBytes(ALL_MODELS))})? These features will offer to download them again.`, "Remove"))) {
    await removeModels();
    app.toast("The AI models were removed.");
  }
}
