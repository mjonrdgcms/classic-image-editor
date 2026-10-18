/**
 * The Type tool. Click to start point text, drag a box for paragraph text,
 * or click a type layer to edit it. While editing, a transparent text box
 * over the canvas takes the typing (with a real caret and selection) and the
 * layer re-renders live; committing records one history step.
 */

import type { App } from "../app";
import { DEFAULT_TEXT, TextSpec, TextStyle, renderTextLayer, textAnchor } from "../core/text";
import type { Document, Layer } from "../core/document";
import type { Tool, ToolEvent } from "../tools/tools";
import { ensureFont, nearestWeight } from "./fonts";

export interface TypeTool extends Tool {
  readonly editing: boolean;
  /** The settings shown in the options bar and palettes. */
  style(): TextStyle;
  /** Change settings: the text being edited, else the active type layer, else the defaults. */
  applyStyle(patch: Partial<TextStyle>): void;
  /** Paragraph settings that live outside TextStyle. */
  isParagraph(): boolean;
  commit(): void;
  cancel(): void;
  /** Start editing a type layer (double-click its thumbnail). */
  editLayer(id: number): void;
}

type StyleNoColor = Omit<TextStyle, "color">;

interface Session {
  doc: Document;
  layer: Layer;
  /** An existing layer being edited (else a new, temporary one). */
  existing: { grid: Layer["grid"]; offsetX: number; offsetY: number; mask: Layer["mask"]; text: TextSpec; name: string } | null;
  anchor: { x: number; y: number };
  prevActive: number;
  ta: HTMLTextAreaElement;
}

export function makeTypeTool(app: App): TypeTool {
  let ses: Session | null = null;
  let drag: { x: number; y: number; ex: number; ey: number } | null = null;

  const defaults = (): StyleNoColor => {
    const { color: _c, ...rest } = DEFAULT_TEXT;
    void _c;
    return { ...rest, ...((app.settings.typeStyle ?? {}) as Partial<StyleNoColor>) };
  };
  const fg = (): [number, number, number] => {
    const f = app.doc?.foreground ?? [0, 0, 0, 255];
    return [f[0], f[1], f[2]];
  };

  /** Topmost visible type layer whose box contains a canvas point. */
  const typeLayerAt = (x: number, y: number): Layer | null => {
    const doc = app.doc!;
    const layers = doc.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!l.text || !l.visible) continue;
      const b = l.bounds();
      if (x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h) return l;
    }
    return null;
  };

  /** Place and style the text box over the canvas to match the text. */
  const placeEditor = () => {
    if (!ses) return;
    const t = ses.layer.text!;
    const v = app.compositor.view;
    const z = v.zoom;
    const ta = ses.ta;
    const lead = (t.leading > 0 ? t.leading : t.size * 1.2) * z;
    ta.style.font = `${t.italic ? "italic " : ""}${nearestWeight(t.font, t.weight, t.italic)} ${t.size * z}px "${t.font}", sans-serif`;
    ta.style.lineHeight = `${lead}px`;
    ta.style.letterSpacing = `${(t.tracking / 1000) * t.size * z}px`;
    ta.style.textAlign = t.align === "justify" ? "justify" : t.align;
    ta.style.textTransform = t.allCaps ? "uppercase" : "none";
    ta.style.caretColor = `rgb(${t.color.join(",")})`;
    ta.style.transformOrigin = "0 0";
    ta.style.transform = `scale(${t.hScale / 100}, ${t.vScale / 100})`;
    const a = ses.anchor;
    const sx = a.x * z + v.x, sy = a.y * z + v.y;
    const lines = Math.max(1, ta.value.split("\n").length);
    // The line box puts the baseline about 0.8 em below its top plus half the extra leading.
    const top = t.box ? sy : sy - (lead - t.size * z) / 2 - t.size * z * 0.92 - t.baselineShift * z;
    if (t.box) {
      ta.style.left = `${sx}px`;
      ta.style.top = `${top}px`;
      ta.style.width = `${(t.box.w * z) / (t.hScale / 100)}px`;
      ta.style.height = `${(t.box.h * z) / (t.vScale / 100)}px`;
      ta.classList.add("box");
    } else {
      // Point text: size to the longest line; alignment moves the box around the anchor.
      const m = document.createElement("canvas").getContext("2d")!;
      m.font = ta.style.font;
      const longest = Math.max(4, ...ta.value.split("\n").map((s) => m.measureText(t.allCaps ? s.toUpperCase() : s).width + s.length * (t.tracking / 1000) * t.size * z));
      const w = longest + t.size * z * 0.6;
      const left = t.align === "center" ? sx - (w * t.hScale) / 200 : t.align === "right" ? sx - (w * t.hScale) / 100 + t.size * z * 0.3 : sx;
      ta.style.left = `${left}px`;
      ta.style.top = `${top}px`;
      ta.style.width = `${w}px`;
      ta.style.height = `${lines * lead + 4}px`;
      ta.classList.remove("box");
    }
  };

  const live = () => {
    if (!ses) return;
    const l = ses.layer;
    l.text = { ...l.text!, content: ses.ta.value };
    try {
      ses.doc.dirty(renderTextLayer(l, ses.anchor));
    } catch (e) {
      app.toast((e as Error).message);
    }
    placeEditor();
  };

  const startEditor = (layer: Layer, existing: Session["existing"], prevActive: number) => {
    const s = app.active!;
    const ta = document.createElement("textarea");
    ta.className = "type-editor type-ui";
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "Type");
    ta.value = layer.text!.content;
    s.win.viewport.append(ta);
    ses = { doc: app.doc!, layer, existing, anchor: textAnchor(layer), prevActive, ta };
    ta.addEventListener("input", () => {
      live();
      void ensureFont(layer.text!.font, layer.text!.weight, layer.text!.italic, ta.value).then(() => ses?.layer === layer && live());
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        tool.cancel();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.code === "NumpadEnter")) {
        e.preventDefault();
        e.stopPropagation();
        tool.commit();
      }
    });
    ta.addEventListener("blur", (e) => {
      // Clicking the type options keeps editing; anything else commits.
      const to = e.relatedTarget as HTMLElement | null;
      if (to?.closest(".type-ui, .menu, .popup-menu, .font-menu")) return;
      if (!to) return;
      setTimeout(() => ses?.ta === ta && document.activeElement !== ta && tool.commit(), 0);
    });
    placeEditor();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    setTimeout(() => {
      if (document.activeElement !== ta) ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
    app.emit("settings");
    app.status(layer.text!.box ? "Paragraph text: type, then Ctrl+Enter to commit or Esc to cancel." : "Point text: type, then Ctrl+Enter to commit or Esc to cancel.");
  };

  /** Undo the live preview so the command records the change itself. */
  const revert = (): Session | null => {
    const s = ses;
    if (!s) return null;
    ses = null;
    s.ta.remove();
    const doc = s.doc;
    if (s.existing) {
      Object.assign(s.layer, { grid: s.existing.grid, offsetX: s.existing.offsetX, offsetY: s.existing.offsetY, mask: s.existing.mask, text: s.existing.text, name: s.existing.name });
      doc.dirty(null);
    } else {
      const at = doc.locate(s.layer.id);
      if (at) at.list.splice(at.index, 1);
      doc.activeLayerId = s.prevActive;
      doc.dirty(s.layer.bounds());
    }
    doc.emit({ type: "layers" });
    return s;
  };

  let pending = 0;
  const start = async (x: number, y: number, box: { w: number; h: number } | null) => {
    const doc = app.doc!;
    const st = defaults();
    const token = ++pending;
    await ensureFont(st.font, st.weight, st.italic);
    // Something else happened while the font loaded (another click, a new tool or image).
    if (token !== pending || ses || app.doc !== doc || app.tool !== tool) return;
    const prevActive = doc.activeLayerId;
    const l = doc.addLayer("Type");
    l.text = { ...st, color: fg(), content: "", box, ax: 0, ay: 0 };
    renderTextLayer(l, { x, y });
    doc.emit({ type: "layers" });
    startEditor(l, null, prevActive);
  };

  const editLayer = (id: number) => {
    const doc = app.doc;
    const l = doc?.layerById(id);
    if (!doc || !l?.text) return;
    if (ses) tool.commit();
    if (doc.activeLayerId !== l.id) app.run("layer.select", { id: l.id });
    const layer = doc.layerById(id)!;
    if (layer.locks.pixels) return app.toast(`Could not edit the text because "${layer.name}" has its image pixels locked.`);
    doc.editMask = false;
    startEditor(layer, { grid: layer.grid, offsetX: layer.offsetX, offsetY: layer.offsetY, mask: layer.mask, text: layer.text!, name: layer.name }, doc.activeLayerId);
    void ensureFont(layer.text!.font, layer.text!.weight, layer.text!.italic, layer.text!.content).then(() => ses?.layer === layer && live());
  };

  const tool: TypeTool = {
    id: "type",
    label: "Type Tool",
    shortcut: "T",
    icon: "type",
    cursor: "text",
    hint: "Click to type point text, drag a box for paragraph text, click text to edit it. Ctrl+Enter commits, Esc cancels.",
    get editing() {
      return !!ses;
    },
    down(e: ToolEvent) {
      if (!app.doc) return;
      if (ses) {
        tool.commit();
        return;
      }
      drag = { x: e.x, y: e.y, ex: e.x, ey: e.y };
    },
    move(e: ToolEvent) {
      if (!drag) return;
      drag.ex = e.x;
      drag.ey = e.y;
      const x = Math.min(drag.x, e.x), y = Math.min(drag.y, e.y);
      app.preview.rect = { x, y, w: Math.abs(e.x - drag.x), h: Math.abs(e.y - drag.y), shape: "rect" };
    },
    up() {
      const d = drag;
      drag = null;
      app.preview.rect = undefined;
      if (!d || !app.doc) return;
      const w = Math.abs(d.ex - d.x), h = Math.abs(d.ey - d.y);
      const zoom = app.compositor.view.zoom;
      if (w * zoom > 8 && h * zoom > 8) {
        void start(Math.round(Math.min(d.x, d.ex)), Math.round(Math.min(d.y, d.ey)), { w: Math.round(w), h: Math.round(h) });
        return;
      }
      const hit = typeLayerAt(d.x, d.y);
      if (hit) return editLayer(hit.id);
      void start(Math.round(d.x), Math.round(d.y), null);
    },
    hover(e: ToolEvent) {
      if (!app.doc) return;
      app.viewport.style.cursor = typeLayerAt(e.x, e.y) ? "text" : "crosshair";
    },
    deactivate() {
      if (ses) tool.commit();
    },
    style(): TextStyle {
      if (ses) return ses.layer.text!;
      const l = app.doc?.activeLayer;
      if (l?.text && app.tool === tool) return l.text;
      if (l?.text) return l.text;
      return { ...defaults(), color: fg() };
    },
    isParagraph() {
      if (ses) return !!ses.layer.text!.box;
      return !!app.doc?.activeLayer?.text?.box;
    },
    applyStyle(patch: Partial<TextStyle>) {
      const doc = app.doc;
      // The style choices also become the defaults for new text (not the color).
      const { color, ...rest } = patch;
      if (Object.keys(rest).length) app.settings.typeStyle = { ...defaults(), ...rest };
      if (ses) {
        const l = ses.layer;
        l.text = { ...l.text!, ...patch };
        const t = l.text;
        void ensureFont(t.font, t.weight, t.italic, t.content).then(() => ses?.layer === l && live());
        live();
        // Back to typing after picking a setting.
        setTimeout(() => {
          const a = document.activeElement as HTMLElement | null;
          if (ses?.layer === l && !(a instanceof HTMLInputElement && a.type !== "color")) ses.ta.focus();
        }, 0);
      } else if (doc?.activeLayer?.text) {
        const id = doc.activeLayer.id;
        const t = { ...doc.activeLayer.text, ...patch };
        void ensureFont(t.font, t.weight, t.italic, t.content).then(() => app.doc === doc && doc.layerById(id)?.text && app.run("type.edit", { ...patch, id }));
      } else if (color && doc) app.run("color.set", { which: "foreground", r: color[0], g: color[1], b: color[2] });
      app.emit("settings");
    },
    commit() {
      if (committing) return;
      committing = true;
      try {
        commitNow();
      } finally {
        committing = false;
      }
    },
    cancel() {
      revert();
      app.status("");
      app.emit("settings");
    },
    editLayer,
  };

  function commitNow(): void {
    const s = revert();
    if (!s) return;
    const t = s.layer.text!;
    const content = s.ta.value;
    if (s.existing && !content.trim()) {
      // Emptied text removes the type layer, as in PS.
      app.run("layer.delete", { id: s.layer.id });
    } else if (s.existing) {
      const patch: Record<string, unknown> = { id: s.layer.id };
      const old = s.existing.text;
      if (content !== old.content) patch.content = content;
      for (const k of Object.keys(DEFAULT_TEXT) as (keyof TextStyle)[]) if (JSON.stringify(t[k]) !== JSON.stringify(old[k])) patch[k] = t[k];
      if (Object.keys(patch).length > 1) app.run("type.edit", patch);
    } else if (content.trim()) {
      const { content: _c, ax: _x, ay: _y, box, ...style } = t;
      void _c;
      void _x;
      void _y;
      app.run("type.create", { x: s.anchor.x, y: s.anchor.y, content, ...(box ? { box } : {}), ...style });
    }
    app.status("");
    app.emit("settings");
  }

  // Keep the text box over the text when the view zooms or scrolls.
  app.on("view", placeEditor);
  // Any other command (or a click outside the type controls) commits the text first.
  let committing = false;
  app.bus.onBeforeCommand(() => {
    if (ses && !committing) tool.commit();
  });
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!ses || t?.closest?.(".type-editor, .type-ui, .font-menu, .menu, .popup-menu, .modal-backdrop")) return;
      // Clicks on the canvas are the tool's business (it commits on its own).
      if (t?.closest?.(".viewport") && app.tool === tool) return;
      tool.commit();
    },
    true,
  );
  return tool;
}
