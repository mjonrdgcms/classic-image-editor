/**
 * Retouching tools: Clone Stamp (S), Healing Brush and Spot Healing Brush
 * (J), History Brush (Y), Dodge / Burn / Sponge (O), Blur / Sharpen /
 * Smudge (R), the Red Eye Tool (J), the Magic Eraser and Background Eraser
 * (E), the Pattern Stamp (S), the Art History Brush (Y) and the Color
 * Replacement Tool (B).
 *
 * The brush tools preview live with a RetouchStroke and then dispatch
 * paint.retouch with the stroke's points, so History, Actions and scripts
 * see the same thing as any other paint stroke.
 */

import type { App, RetouchToolId } from "../app";
import { retouchOptions, type RetouchParams } from "../core/cmd/heal";
import type { Document } from "../core/document";
import { RetouchStroke, type RetouchTool } from "../core/retouch";
import { patternToJSON } from "../core/patterns";
import type { Tool, ToolEvent } from "./tools";

const ENGINE: Record<RetouchToolId, RetouchTool> = {
  stamp: "clone",
  heal: "heal",
  spotHeal: "spotHeal",
  historyBrush: "history",
  dodge: "dodge",
  burn: "burn",
  sponge: "sponge",
  blur: "blur",
  sharpen: "sharpen",
  smudge: "smudge",
  patternStamp: "pattern",
  artHistory: "artHistory",
  bgEraser: "bgErase",
  colorReplace: "colorReplace",
};

const INFO: Record<RetouchToolId, { label: string; key: string; icon: string; hint: string }> = {
  stamp: { label: "Clone Stamp Tool", key: "S", icon: "stamp", hint: "Alt-click to set where to copy from, then paint to copy it here." },
  heal: { label: "Healing Brush Tool", key: "J", icon: "healing", hint: "Alt-click a clean area, then paint over a flaw: the texture is copied and blended to match its new surroundings." },
  spotHeal: { label: "Spot Healing Brush Tool", key: "J", icon: "spotHeal", hint: "Paint over a spot, blemish or small object; it is filled from its surroundings when you let go." },
  historyBrush: { label: "History Brush Tool", key: "Y", icon: "historyBrush", hint: "Paint back the image as it was when opened (or a snapshot, chosen in the options bar)." },
  dodge: { label: "Dodge Tool", key: "O", icon: "dodge", hint: "Paint to lighten. Alt paints with the Burn Tool." },
  burn: { label: "Burn Tool", key: "O", icon: "burn", hint: "Paint to darken. Alt paints with the Dodge Tool." },
  sponge: { label: "Sponge Tool", key: "O", icon: "sponge", hint: "Paint to saturate or desaturate colors." },
  blur: { label: "Blur Tool", key: "R", icon: "blur", hint: "Paint to soften detail. Alt sharpens." },
  sharpen: { label: "Sharpen Tool", key: "R", icon: "sharpen", hint: "Paint to crisp up detail. Alt blurs." },
  smudge: { label: "Smudge Tool", key: "R", icon: "smudge", hint: "Drag to push paint around, like a finger in wet paint." },
  patternStamp: { label: "Pattern Stamp Tool", key: "S", icon: "patternStamp", hint: "Paint with the pattern chosen in the options bar (Edit > Define Pattern makes new ones)." },
  artHistory: { label: "Art History Brush", key: "Y", icon: "artHistory", hint: "Paint stylized strokes in the colors of the image as it was opened (or a snapshot)." },
  bgEraser: {
    label: "Background Eraser Tool",
    key: "E",
    icon: "bgEraser",
    hint: "Drag around an edge: colors like the one under the center of the brush are erased to transparency, the rest is kept.",
  },
  colorReplace: { label: "Color Replacement Tool", key: "B", icon: "colorReplace", hint: "Paint to recolor what's under the brush with the foreground color, keeping its shading." },
};

/** Clone source, shared by the Clone Stamp and the Healing Brush (like PS). */
interface CloneSource {
  doc: Document;
  x: number;
  y: number;
  /** Aligned mode: source minus destination, fixed by the first stroke. */
  offset: [number, number] | null;
}
let cloneSource: CloneSource | null = null;
/** Where the pointer is while painting with an offset (for the source crosshair). */
let liveOffset: [number, number] | null = null;

export function makeRetouchTools(app: App): Record<RetouchToolId | "redEye" | "magicEraser", Tool> {
  // Source crosshair for Clone Stamp and Healing Brush.
  app.overlayPainters.add((ctx, s, v) => {
    const id = app.tool.id;
    if ((id !== "stamp" && id !== "heal") || !cloneSource || s.doc !== cloneSource.doc || s !== app.active) return;
    let x = cloneSource.x, y = cloneSource.y;
    const off = liveOffset ?? cloneSource.offset;
    if (off && app.pointer) {
      x = app.pointer.x + off[0];
      y = app.pointer.y + off[1];
    }
    const sx = x * v.zoom + v.x, sy = y * v.zoom + v.y;
    ctx.lineWidth = 1;
    for (const [c, w] of [
      ["rgba(0,0,0,.8)", 3],
      ["rgba(255,255,255,.95)", 1],
    ] as const) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(sx - 8, sy);
      ctx.lineTo(sx + 8, sy);
      ctx.moveTo(sx, sy - 8);
      ctx.lineTo(sx, sy + 8);
      ctx.stroke();
    }
  });

  let stroke: RetouchStroke | null = null;
  let params: Omit<RetouchParams, "points"> | null = null;

  const layerFor = (label: string) => {
    const doc = app.doc!;
    if (doc.quickMask || (doc.editMask && doc.activeNode?.mask)) {
      app.toast(`The ${label} works on layer pixels; leave Quick Mask or click the layer thumbnail first.`);
      return null;
    }
    const l = doc.activeLayer;
    if (!l) {
      app.toast(`Could not use the ${label} because a layer set is selected. Select a layer.`);
      return null;
    }
    if (!l.visible) {
      app.toast(`Could not use the ${label} because the target layer is hidden.`);
      return null;
    }
    if (l.locks.pixels) {
      app.toast(`Could not use the ${label} because "${l.name}" has its image pixels locked.`);
      return null;
    }
    if (l.text || l.shape) {
      void app.askRasterize(l.id);
      return null;
    }
    return l;
  };

  const make = (id: RetouchToolId): Tool => {
    const info = INFO[id];
    const tool: Tool = {
      id,
      label: info.label,
      shortcut: info.key,
      icon: info.icon,
      cursor: "crosshair",
      hint: info.hint,
      down(e: ToolEvent) {
        const doc = app.doc!;
        const s = app.settings;
        if ((id === "stamp" || id === "heal") && e.alt) {
          cloneSource = { doc, x: e.x, y: e.y, offset: null };
          app.status(`Source set at ${Math.round(e.x)}, ${Math.round(e.y)}. Now paint where you want it copied.`);
          app.emit("overlay");
          return;
        }
        const l = layerFor(info.label);
        if (!l) return;
        let engine = ENGINE[id];
        // Alt swaps to the opposite tool, like PS.
        if (e.alt && id === "dodge") engine = "burn";
        else if (e.alt && id === "burn") engine = "dodge";
        else if (e.alt && id === "blur") engine = "sharpen";
        else if (e.alt && id === "sharpen") engine = "blur";
        let offset: [number, number] | undefined;
        if (id === "stamp" || id === "heal") {
          if (!cloneSource || cloneSource.doc !== doc) {
            app.toast(`Alt-click to set where the ${info.label.replace(/ Tool$/, "")} copies from.`);
            return;
          }
          const aligned = id === "stamp" ? s.stampAligned : s.healAligned;
          offset = aligned && cloneSource.offset ? cloneSource.offset : [cloneSource.x - e.x, cloneSource.y - e.y];
          if (aligned) cloneSource.offset = offset;
          liveOffset = offset;
        }
        const brush = app.toolBrush[id];
        const pattern = id === "patternStamp" ? app.patterns[Math.min(s.patternIndex, app.patterns.length - 1)] : undefined;
        if (id === "patternStamp" && !pattern) return void app.toast("There are no patterns. Make one with Edit > Define Pattern.");
        const strength =
          id === "patternStamp"
            ? s.patternStampOpacity
            : id === "artHistory"
              ? s.artOpacity
              : id === "bgEraser" || id === "colorReplace"
                ? 100
                : 
          id === "stamp"
            ? s.stampOpacity
            : id === "historyBrush"
              ? s.historyBrushOpacity
              : engine === "dodge"
                ? s.dodgeExposure
                : engine === "burn"
                  ? s.burnExposure
                  : id === "sponge"
                    ? s.spongeFlow
                    : engine === "blur"
                      ? s.blurStrength
                      : engine === "sharpen"
                        ? s.sharpenStrength
                        : id === "smudge"
                          ? s.smudgeStrength
                          : 100;
        const from = s.historyBrushFrom;
        params = {
          tool: engine,
          size: Math.max(1, Math.round(brush.size)),
          hardness: brush.hardness,
          strength,
          offset: offset ? [Math.round(offset[0]), Math.round(offset[1])] : undefined,
          sampleAll: id === "stamp" ? s.stampSampleAll : id === "heal" ? s.healSampleAll : false,
          range: engine === "dodge" ? s.dodgeRange : s.burnRange,
          sponge: s.spongeMode,
          historyState: 0,
          historySnapshot: from.startsWith("snap:") ? +from.slice(5) : undefined,
          seed: (Math.random() * 2 ** 31) | 0,
          pattern: pattern ? patternToJSON(pattern) : undefined,
          tolerance: id === "bgEraser" ? s.bgEraserTolerance : s.colorReplaceTolerance,
          sampling: id === "bgEraser" ? s.bgEraserSampling : s.colorReplaceSampling,
          limits: id === "bgEraser" ? s.bgEraserLimits : s.colorReplaceLimits,
          protectFg: s.bgEraserProtectFg,
          replaceMode: s.colorReplaceMode,
          artStyle: s.artStyle,
          artArea: s.artArea,
        };
        // Erasing to transparency needs a normal layer (recorded with the stroke).
        const wasBackground = id === "bgEraser" && l.isBackground ? l.name : null;
        if (wasBackground !== null) {
          l.isBackground = false;
          l.name = "Layer 0";
          doc.emit({ type: "layers" });
        }
        try {
          const opts = retouchOptions({ doc, bus: app.bus }, l.id, { ...params, points: [] });
          stroke = new RetouchStroke(doc, l, opts);
        } catch (err) {
          if (wasBackground !== null) {
            l.isBackground = true;
            l.name = wasBackground;
            doc.emit({ type: "layers" });
          }
          app.toast(err instanceof Error ? err.message : String(err));
          params = null;
          return;
        }
        stroke.addPoint(e.x, e.y, e.pressure);
      },
      move(e: ToolEvent) {
        if (!stroke) {
          if ((id === "stamp" || id === "heal") && cloneSource) app.emit("overlay");
          return;
        }
        stroke.addPoint(e.x, e.y, e.pressure);
        app.emit("overlay");
      },
      up() {
        const s = stroke, p = params;
        stroke = null;
        params = null;
        liveOffset = null;
        if (!s || !p) return;
        s.end();
        const r2 = (v: number) => Math.round(v * 100) / 100;
        const pts = s.points.map(([x, y]) => [r2(x), r2(y)]);
        app.bus.dispatch("paint.retouch", { ...p, points: pts }, { applied: true });
      },
      hover() {
        if ((id === "stamp" || id === "heal") && cloneSource) app.emit("overlay");
      },
      deactivate() {
        if (stroke) tool.up({} as ToolEvent);
      },
    };
    return tool;
  };

  const redEye: Tool = {
    id: "redEye",
    label: "Red Eye Tool",
    shortcut: "J",
    icon: "redEye",
    cursor: "crosshair",
    hint: "Click on a red pupil (or drag a box around the eye) to make it dark again.",
    down(e) {
      drag = { x: e.x, y: e.y, x1: e.x, y1: e.y };
    },
    move(e) {
      if (!drag) return;
      drag.x1 = e.x;
      drag.y1 = e.y;
      app.preview.rect = { x: Math.min(drag.x, drag.x1), y: Math.min(drag.y, drag.y1), w: Math.abs(drag.x1 - drag.x), h: Math.abs(drag.y1 - drag.y), shape: "ellipse" };
      app.emit("overlay");
    },
    up() {
      const d = drag;
      drag = null;
      app.preview.rect = undefined;
      app.emit("overlay");
      if (!d || !app.doc || !layerFor("Red Eye Tool")) return;
      const s = app.settings;
      const doc = app.doc;
      const w = Math.abs(d.x1 - d.x), h = Math.abs(d.y1 - d.y);
      const boxed = w > 6 && h > 6;
      const radius = boxed ? Math.max(w, h) / 2 : Math.max(16, Math.round(Math.min(doc.width, doc.height) * 0.035));
      app.run("paint.redEye", {
        x: boxed ? (d.x + d.x1) / 2 : d.x,
        y: boxed ? (d.y + d.y1) / 2 : d.y,
        radius: Math.round(radius),
        pupil: s.redEyePupil,
        darken: s.redEyeDarken,
      });
    },
  };
  let drag: { x: number; y: number; x1: number; y1: number } | null = null;

  const magicEraser: Tool = {
    id: "magicEraser",
    label: "Magic Eraser Tool",
    shortcut: "E",
    icon: "magicEraser",
    cursor: "crosshair",
    hint: "Click a color to erase it (and similar colors) to transparency.",
    down(e) {
      if (!layerFor("Magic Eraser Tool")) return;
      const s = app.settings;
      app.run("paint.magicErase", {
        x: Math.floor(e.x),
        y: Math.floor(e.y),
        tolerance: s.magicEraserTolerance,
        contiguous: s.magicEraserContiguous,
        antiAlias: s.magicEraserAntiAlias,
        sampleMerged: s.magicEraserSampleMerged,
        opacity: s.magicEraserOpacity,
      });
    },
    move() {},
    up() {},
  };

  // Order matters: tools sharing a letter take turns in this order (J: Spot Healing first).
  const order: (RetouchToolId | "redEye" | "magicEraser")[] = [
    "spotHeal",
    "heal",
    "redEye",
    "stamp",
    "patternStamp",
    "historyBrush",
    "artHistory",
    "bgEraser",
    "magicEraser",
    "colorReplace",
    "dodge",
    "burn",
    "sponge",
    "blur",
    "sharpen",
    "smudge",
  ];
  const out = {} as Record<RetouchToolId | "redEye" | "magicEraser", Tool>;
  for (const id of order) out[id] = id === "redEye" ? redEye : id === "magicEraser" ? magicEraser : make(id);
  return out;
}

/** The History Brush source choices for the options bar. */
export function historySourceOptions(app: App): [string, string][] {
  const out: [string, string][] = [["open", "Opened image"]];
  app.bus.history.snapshots.forEach((s, i) => out.push([`snap:${i}`, s.label]));
  return out;
}
