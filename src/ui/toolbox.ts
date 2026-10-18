/**
 * The two-column toolbox, laid out like PS7's. Slots with a small triangle
 * hold several tools: press and hold (or right-click) for the flyout, or use
 * Shift+shortcut to cycle. Tools from later milestones show greyed out.
 */

import type { App } from "../app";
import type { ToolId } from "../tools/tools";
import { el } from "./dialogs";
import { ICONS } from "./icons";
import { MenuItem, prettyShortcut, showPopupMenu } from "./menus";

type Slot = { tools: ToolId[]; soon?: { icon: string; label: string; key: string; when: string }[] } | { soonOnly: { icon: string; label: string; key: string; when: string } };


const LAYOUT: [Slot, Slot][] = [
  [{ tools: ["marquee", "ellipse", "row", "column"] }, { tools: ["move"] }],
  [{ tools: ["lasso", "polyLasso", "magneticLasso"] }, { tools: ["wand"] }],
  [{ tools: ["crop"] }, { tools: ["slice", "sliceSelect"] }],
  [{ tools: ["spotHeal", "heal", "patch", "redEye", "faceSwap"] }, { tools: ["brush", "pencil", "colorReplace"] }],
  [{ tools: ["stamp", "patternStamp"] }, { tools: ["historyBrush", "artHistory"] }],
  [
    { tools: ["eraser", "bgEraser", "magicEraser"] },
    { tools: ["gradient", "bucket"] },
  ],
  [{ tools: ["blur", "sharpen", "smudge"] }, { tools: ["dodge", "burn", "sponge"] }],
  [{ tools: ["pathSelect", "directSelect"] }, { tools: ["type"] }],
  [{ tools: ["pen", "freeformPen", "addAnchor", "deleteAnchor", "convertPoint"] }, { tools: ["rectShape", "roundRectShape", "ellipseShape", "polygonShape", "lineShape", "customShape"] }],
  [{ tools: ["notes"] }, { tools: ["eyedropper", "colorSampler", "measure"] }],
  [{ tools: ["hand"] }, { tools: ["zoom"] }],
];

export function mountToolbox(root: HTMLElement, app: App, keyFor: (id: ToolId) => string): void {
  root.append(el("div", { class: "toolbox-logo", title: "Drag to move the toolbox; double-click to dock or float it", text: "CIE" }));
  const grid = el("div", { class: "tool-grid", role: "toolbar", "aria-label": "Tools" });
  const slots: { btn: HTMLButtonElement; tools: ToolId[]; shown: ToolId }[] = [];

  for (const pair of LAYOUT) {
    for (const slot of pair) {
      if ("soonOnly" in slot) {
        const t = slot.soonOnly;
        const b = el("button", { class: "tool-btn", type: "button", disabled: true, title: `${t.label} (${t.key}) - planned for ${t.when}`, "aria-label": t.label });
        b.innerHTML = ICONS[t.icon];
        grid.append(b);
        continue;
      }
      const flyout = slot.tools.length > 1 || !!slot.soon?.length;
      const b = el("button", { class: "tool-btn" + (flyout ? " has-flyout" : ""), type: "button" });
      const entry = { btn: b, tools: slot.tools, shown: slot.tools[0] };
      slots.push(entry);
      const openFlyout = () => {
        const r = b.getBoundingClientRect();
        const items: MenuItem[] = slot.tools.map((id) => ({
          label: app.tools[id].label,
          shortcut: keyFor(id),
          checked: app.tool.id === id,
          run: () => app.setTool(id),
        }));
        for (const t of slot.soon ?? []) items.push({ label: t.label, soon: t.when, shortcut: t.key });
        showPopupMenu(items, r.right + 2, r.top);
      };
      let hold = 0;
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !flyout) return;
        hold = window.setTimeout(() => {
          hold = 0;
          openFlyout();
        }, 350);
      });
      b.addEventListener("pointerup", () => {
        if (hold) {
          clearTimeout(hold);
          hold = 0;
          app.setTool(entry.shown);
        }
      });
      b.addEventListener("pointerleave", () => {
        if (hold) clearTimeout(hold);
        hold = 0;
      });
      b.addEventListener("click", (e) => {
        if (!flyout) app.setTool(entry.shown);
        e.preventDefault();
      });
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (flyout) openFlyout();
      });
      grid.append(b);
    }
  }
  root.append(grid, el("div", { class: "tool-sep" }));

  // Foreground / background color chips.
  const fg = el("div", { class: "chip fg", title: "Set foreground color" });
  const bg = el("div", { class: "chip bg", title: "Set background color" });
  const swap = el("button", { class: "mini swap", type: "button", title: "Switch Foreground and Background Colors (X)" });
  swap.innerHTML = ICONS.swap;
  swap.addEventListener("click", () => app.run("color.swap"));
  const reset = el("button", { class: "mini reset", type: "button", title: "Default Foreground and Background Colors (D)" });
  reset.addEventListener("click", () => app.run("color.reset"));
  const pickColor = (which: "foreground" | "background") => {
    if (!app.doc) return;
    const c = which === "foreground" ? app.doc.foreground : app.doc.background;
    const input = el("input", { type: "color", value: hex(c) });
    input.style.cssText = "position:fixed;left:-100px;opacity:0";
    document.body.append(input);
    input.addEventListener("input", () => {
      const v = input.value;
      app.run("color.set", { which, r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) });
    });
    input.addEventListener("change", () => input.remove());
    input.click();
  };
  fg.addEventListener("click", () => pickColor("foreground"));
  bg.addEventListener("click", () => pickColor("background"));
  root.append(el("div", { class: "swatches" }, fg, bg, swap, reset), el("div", { class: "tool-sep" }));

  const iconBtn = (icon: string, title: string, onClick: () => void) => {
    const b = el("button", { class: "tool-btn", type: "button", title, "aria-label": title });
    b.innerHTML = ICONS[icon];
    b.addEventListener("click", onClick);
    return b;
  };
  const qmOff = iconBtn("quickMaskOff", "Edit in Standard Mode (Q)", () => app.doc?.quickMask && app.run("select.quickMask", { on: false }));
  const qmOn = iconBtn("quickMaskOn", "Edit in Quick Mask Mode (Q)", () => app.doc && !app.doc.quickMask && app.run("select.quickMask", { on: true }));
  const scrStd = iconBtn("screenStd", "Standard Screen Mode (F)", () => app.setScreenMode("standard"));
  const scrMenu = iconBtn("screenFull", "Full Screen Mode with Menu Bar (F)", () => app.setScreenMode("fullMenu"));
  const scrFull = iconBtn("screenFull", "Full Screen Mode (F)", () => app.setScreenMode("full"));
  root.append(el("div", { class: "toolbox-row" }, qmOff, qmOn), el("div", { class: "tool-sep" }));
  const scr = el("div", { class: "toolbox-row toolbox-screens" }, scrStd, scrMenu, scrFull);
  root.append(scr, el("div", { class: "tool-sep" }));
  const ai = el("button", { class: "tool-btn", type: "button", disabled: true, title: "AI Assistant (Ollama) - arrives in M2" });
  ai.innerHTML = ICONS.ai;
  root.append(ai, el("div", { class: "toolbox-grip", title: "Drag to move the toolbox" }));

  const sync = () => {
    for (const sl of slots) {
      if (sl.tools.includes(app.tool.id)) sl.shown = app.tool.id;
      const t = app.tools[sl.shown];
      sl.btn.innerHTML = ICONS[t.icon];
      const k = keyFor(sl.shown);
      sl.btn.title = `${t.label}${k ? ` (${prettyShortcut(k)})` : ""}${sl.tools.length > 1 ? " - hold for more" : ""}`;
      sl.btn.setAttribute("aria-label", t.label);
      sl.btn.classList.toggle("active", sl.tools.includes(app.tool.id));
    }
    fg.style.background = app.doc ? hex(app.doc.foreground) : "#000000";
    bg.style.background = app.doc ? hex(app.doc.background) : "#ffffff";
    const qm = !!app.doc?.quickMask;
    qmOff.classList.toggle("active", !qm);
    qmOn.classList.toggle("active", qm);
    scrStd.classList.toggle("active", app.screenMode === "standard");
    scrMenu.classList.toggle("active", app.screenMode === "fullMenu");
    scrFull.classList.toggle("active", app.screenMode === "full");
  };
  for (const t of ["tool", "settings", "doc", "screen", "overlay"] as const) app.on(t, sync);
  sync();
}

export function hex(c: ArrayLike<number>): string {
  return "#" + [c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
