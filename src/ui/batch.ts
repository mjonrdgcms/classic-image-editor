/**
 * File > Automate > Batch: run an action on many images. Each image opens
 * in its own window, the action plays, and the result is saved (to a
 * folder in the desktop app, or as one .zip download in a browser) and
 * closed, or left open.
 */

import type { App } from "../app";
import { OutputSink, decodeImage, encodeImage, isDesktop, pickFolder, pickImageFiles, pickImageFolder, type SourceFile } from "../io/files";
import type { ActionPlayer } from "./actionspal";
import { el, sheet } from "./dialogs";
import * as storage from "./storage";

interface BatchSettings {
  set: string;
  action: string;
  suppress: boolean;
  recursive: boolean;
  dest: "none" | "save";
  keepFolders: boolean;
  suffix: string;
  serial: boolean;
  format: "png" | "jpeg";
  quality: number;
  onError: "stop" | "log";
}

const DEFAULTS: BatchSettings = { set: "", action: "", suppress: true, recursive: false, dest: "save", keepFolders: true, suffix: "-edited", serial: false, format: "jpeg", quality: 90, onError: "log" };

export async function batchDialog(app: App, player: ActionPlayer, preset?: { action?: string }): Promise<void> {
  const store = player.store;
  const s: BatchSettings = { ...DEFAULTS, ...storage.load<Partial<BatchSettings>>("batch", {}) };
  if (preset?.action) {
    const f = store.findAction(preset.action);
    if (f) {
      s.set = f.set.id;
      s.action = f.action.id;
    }
  }
  let files: SourceFile[] = [];
  let sourceLabel = "";
  let outFolder: string | null = null;

  // ---------------------------------------------------------------- form
  const setSel = el("select", { "aria-label": "Action set" });
  const actSel = el("select", { "aria-label": "Action" });
  const fillSets = () => {
    setSel.textContent = "";
    for (const st of store.sets) setSel.append(el("option", { value: st.id, text: st.name }));
    if (store.findSet(s.set)) setSel.value = s.set;
    fillActions();
  };
  const fillActions = () => {
    actSel.textContent = "";
    const st = store.findSet(setSel.value);
    for (const a of st?.actions ?? []) actSel.append(el("option", { value: a.id, text: a.name + (a.key ? `  (${a.key})` : "") }));
    if (st?.actions.some((a) => a.id === s.action)) actSel.value = s.action;
  };
  setSel.addEventListener("change", fillActions);

  const srcInfo = el("span", { class: "bt-info", text: "No images chosen" });
  const pickFiles = el("button", { type: "button", class: "btn small", text: "Choose Images..." });
  const pickDir = el("button", { type: "button", class: "btn small", text: "Choose Folder..." });
  const recursive = el("input", { type: "checkbox" });
  recursive.checked = s.recursive;
  const showSrc = () => (srcInfo.textContent = files.length ? `${files.length} image${files.length === 1 ? "" : "s"}${sourceLabel ? ` from ${sourceLabel}` : ""}` : "No images chosen");
  pickFiles.addEventListener("click", async () => {
    const f = await pickImageFiles();
    if (f.length) {
      files = f;
      sourceLabel = "";
      showSrc();
      sync();
    }
  });
  pickDir.addEventListener("click", async () => {
    const r = await pickImageFolder(recursive.checked);
    if (r) {
      files = r.files;
      sourceLabel = r.label;
      showSrc();
      sync();
    }
  });
  const suppress = el("input", { type: "checkbox" });
  suppress.checked = s.suppress;

  const destSel = el("select", { "aria-label": "Destination" });
  destSel.append(el("option", { value: "save", text: isDesktop ? "Save to Folder and Close" : "Save as a .zip Download and Close" }), el("option", { value: "none", text: "None (leave images open)" }));
  destSel.value = s.dest;
  const destBtn = el("button", { type: "button", class: "btn small", text: "Choose Folder..." });
  const destInfo = el("span", { class: "bt-info" });
  destBtn.addEventListener("click", async () => {
    outFolder = await pickFolder();
    sync();
  });
  const keepFolders = el("input", { type: "checkbox" });
  keepFolders.checked = s.keepFolders;
  const suffix = el("input", { type: "text", value: s.suffix, "aria-label": "Name suffix", style: "width:120px" });
  const serial = el("input", { type: "checkbox" });
  serial.checked = s.serial;
  const fmt = el("select", { "aria-label": "Format" });
  fmt.append(el("option", { value: "jpeg", text: "JPEG" }), el("option", { value: "png", text: "PNG" }));
  fmt.value = s.format;
  const quality = el("input", { type: "number", min: 1, max: 100, value: s.quality, "aria-label": "JPEG quality" });
  const example = el("span", { class: "bt-info" });
  const onErr = el("select", { "aria-label": "Errors" });
  onErr.append(el("option", { value: "log", text: "Log Errors and Keep Going" }), el("option", { value: "stop", text: "Stop for Errors" }));
  onErr.value = s.onError;

  const row = (label: string, ...kids: (HTMLElement | string)[]) => el("div", { class: "bt-row" }, el("label", { class: "bt-label", text: label }), el("div", { class: "bt-ctl" }, ...kids));
  const check = (box: HTMLInputElement, text: string) => el("label", { class: "bt-check" }, box, " " + text);

  const ok = el("button", { type: "button", class: "btn default", text: "Run Batch" });
  const cancel = el("button", { type: "button", class: "btn", text: "Cancel" });
  const sync = () => {
    const save = destSel.value === "save";
    destBtn.style.display = save && isDesktop ? "" : "none";
    destInfo.textContent = save ? (isDesktop ? (outFolder ?? "Choose where the results go") : "Results download together as one .zip file") : "Images stay open in their windows";
    quality.disabled = fmt.value !== "jpeg";
    const first = files[0]?.name ?? "photo.jpg";
    example.textContent = `Example: ${first.replace(/\.[^.]+$/, "")}${suffix.value}${serial.checked ? "-001" : ""}.${fmt.value === "png" ? "png" : "jpg"}`;
    ok.disabled = !files.length || !actSel.value || (save && isDesktop && !outFolder);
  };
  for (const c of [destSel, fmt, suffix, serial, actSel]) c.addEventListener("input", sync);
  for (const c of [destSel, fmt, serial, actSel]) c.addEventListener("change", sync);

  const body = el(
    "div",
    { class: "bt-body" },
    el("div", { class: "form-heading", text: "Play" }),
    row("Set", setSel),
    row("Action", actSel),
    el("div", { class: "form-heading", text: "Source" }),
    row("Images", pickFiles, pickDir, srcInfo),
    row("", check(recursive, "Include all subfolders")),
    row("", check(suppress, "Don't show step dialogs (use the recorded settings)")),
    el("div", { class: "form-heading", text: "Destination" }),
    row("Results", destSel, destBtn),
    row("", destInfo),
    row("", check(keepFolders, "Keep the subfolder structure")),
    row("File Name", el("span", { text: "Document name +" }), suffix, check(serial, "Number them")),
    row("Format", fmt, el("span", { text: "Quality" }), quality),
    row("", example),
    el("div", { class: "form-heading", text: "Errors" }),
    row("If a step fails", onErr),
    el("div", { class: "bt-actions" }, el("span", { style: "flex:1" }), cancel, ok),
  );
  const dlg = sheet("Batch", body, { className: "bt-dialog" });
  cancel.addEventListener("click", () => dlg.close("cancel"));
  ok.addEventListener("click", () => dlg.close("ok"));
  fillSets();
  showSrc();
  sync();
  if ((await dlg.done) !== "ok") return;

  Object.assign(s, {
    set: setSel.value,
    action: actSel.value,
    suppress: suppress.checked,
    recursive: recursive.checked,
    dest: destSel.value,
    keepFolders: keepFolders.checked,
    suffix: suffix.value,
    serial: serial.checked,
    format: fmt.value,
    quality: Math.max(1, Math.min(100, +quality.value || 90)),
    onError: onErr.value,
  });
  storage.save("batch", s);
  await runBatch(app, player, s, files, outFolder);
}

async function runBatch(app: App, player: ActionPlayer, s: BatchSettings, files: SourceFile[], outFolder: string | null): Promise<void> {
  const action = player.store.findAction(s.action)?.action;
  if (!action) return;
  // ---------------------------------------------------------------- progress
  const bar = el("div", { class: "bt-bar" }, el("div", { class: "bt-fill" }));
  const status = el("div", { class: "bt-status" });
  const log = el("div", { class: "bt-log", role: "log" });
  const stopBtn = el("button", { type: "button", class: "btn", text: "Stop" });
  const doneBtn = el("button", { type: "button", class: "btn default", text: "Close" });
  doneBtn.style.display = "none";
  const body = el("div", { class: "bt-body bt-progress" }, status, bar, log, el("div", { class: "bt-actions" }, el("span", { style: "flex:1" }), stopBtn, doneBtn));
  const dlg = sheet(`Batch: ${action.name}`, body, { className: "bt-dialog" });
  let stopped = false;
  stopBtn.addEventListener("click", () => {
    stopped = true;
    player.requestStop();
  });
  doneBtn.addEventListener("click", () => dlg.close("ok"));
  dlg.done.then(() => (stopped = true));

  const sink = s.dest === "save" ? new OutputSink(outFolder) : null;
  const ext = s.format === "png" ? "png" : "jpg";
  let okCount = 0, errCount = 0;
  const addLog = (name: string, ok: boolean, msg: string) => {
    log.append(el("div", { class: "bt-line " + (ok ? "ok" : "err") }, el("span", { class: "bt-mark", text: ok ? "✓" : "✕" }), el("span", { class: "bt-file", text: name }), el("span", { class: "bt-msg", text: msg })));
    log.scrollTop = log.scrollHeight;
  };
  if (s.dest === "none" && files.length > 10) addLog("", false, "Only the first 10 images will stay open (each open image needs its own graphics context).");
  const list = s.dest === "none" ? files.slice(0, 10) : files;
  const usedNames = new Set<string>();
  const uniqueName = (name: string) => {
    if (!usedNames.has(name.toLowerCase())) {
      usedNames.add(name.toLowerCase());
      return name;
    }
    const dot = name.lastIndexOf(".");
    for (let k = 2; ; k++) {
      const n = `${name.slice(0, dot)}-${k}${name.slice(dot)}`;
      if (!usedNames.has(n.toLowerCase())) {
        usedNames.add(n.toLowerCase());
        return n;
      }
    }
  };

  for (let i = 0; i < list.length; i++) {
    if (stopped) break;
    const f = list[i];
    let session: typeof app.active = null;
    status.textContent = `Image ${i + 1} of ${list.length}: ${f.rel}`;
    (bar.firstChild as HTMLElement).style.width = `${(i / list.length) * 100}%`;
    try {
      const img = await decodeImage(await f.read(), f.name);
      app.openImage(img);
      session = app.active!;
      const err = await player.play(action, { suppressDialogs: s.suppress });
      if (err) throw new Error(err);
      if (sink) {
        const doc = session.doc;
        const px = doc.composite({ x: 0, y: 0, w: doc.width, h: doc.height });
        const blob = await encodeImage(px, doc.width, doc.height, s.format, s.quality / 100);
        const dir = s.keepFolders && f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/") + 1) : "";
        const name = uniqueName(`${dir}${f.name.replace(/\.[^.]+$/, "")}${s.suffix}${s.serial ? "-" + String(i + 1).padStart(3, "0") : ""}.${ext}`);
        await sink.write(name, blob);
        app.closeSession(session);
        addLog(f.rel, true, `Saved ${name}`);
      } else addLog(f.rel, true, "Done (left open)");
      okCount++;
    } catch (e) {
      errCount++;
      addLog(f.rel, false, (e as Error).message);
      // Close the half-processed image the batch opened (never one of yours).
      if (sink && session && app.sessions.includes(session)) app.closeSession(session);
      if (s.onError === "stop") break;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  (bar.firstChild as HTMLElement).style.width = "100%";
  if (sink && !isDesktop && sink.count) {
    status.textContent = "Packing the .zip...";
    await sink.finish(`batch-${action.name.replace(/[^\w-]+/g, "-").toLowerCase()}.zip`);
  }
  status.textContent = `${stopped ? "Stopped. " : "Finished. "}${okCount} done${errCount ? `, ${errCount} with errors` : ""}.`;
  stopBtn.style.display = "none";
  doneBtn.style.display = "";
  doneBtn.focus();
  await dlg.done;
}
