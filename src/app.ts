/**
 * The application hub: owns the document, the CommandBus, the compositor,
 * the view (zoom, pan, rulers, guides, grid), tool settings and brushes, and
 * wires them to the UI.
 */

import { forgetFilter } from "./core/cmd/filters";
import { BrushPreset, defaultBrushes, presetFromJSON, presetToJSON, roundBrush } from "./core/brushes";
import { registerBuiltins } from "./core/builtins";
import { CommandBus } from "./core/commands";
import { Document, RGBA } from "./core/document";
import type { SelectMode } from "./core/selection";
import type { Rect } from "./core/tiles";
import { History, settlePendingEdits } from "./core/history";
import { defaultPatterns, patternFromJSON, patternToJSON, type NamedPattern } from "./core/patterns";
import { Compositor } from "./gl/compositor";
import type { GradientPreset, GradientType } from "./core/gradient";
import type { TextStyle } from "./core/text";
import { NeedsRasterizeError } from "./core/cmd/common";
import { DecodedImage, ExportFormat, baseName, encodeImage, isDesktop, saveBlob, saveBytes } from "./io/files";
import { decodeProjectAsync, encodeProjectAsync } from "./io/project";
import { createTools, Tool, ToolEvent, ToolId } from "./tools/tools";
import { DocMode, DocWindow, DocWindows } from "./ui/docwindows";
import * as storage from "./ui/storage";
import { alertDialog, busyPill } from "./ui/dialogs";

/** PS7's zoom steps. */
export const ZOOM_STEPS = [
  0.01, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16,
];

export type PaintToolId = "brush" | "pencil" | "eraser";
/** Retouching tools that paint with a round brush. */
export type RetouchToolId =
  | "stamp"
  | "patternStamp"
  | "heal"
  | "spotHeal"
  | "historyBrush"
  | "artHistory"
  | "dodge"
  | "burn"
  | "sponge"
  | "blur"
  | "sharpen"
  | "smudge"
  | "bgEraser"
  | "colorReplace";
export const RETOUCH_TOOL_IDS: RetouchToolId[] = ["stamp", "patternStamp", "heal", "spotHeal", "historyBrush", "artHistory", "dodge", "burn", "sponge", "blur", "sharpen", "smudge", "bgEraser", "colorReplace"];
export type BrushToolId = PaintToolId | RetouchToolId;
const RETOUCH_DEFAULT_SIZE: Record<RetouchToolId, [number, number]> = {
  stamp: [45, 50],
  heal: [40, 50],
  spotHeal: [25, 60],
  historyBrush: [45, 0],
  dodge: [65, 0],
  burn: [65, 0],
  sponge: [65, 0],
  blur: [35, 0],
  sharpen: [35, 0],
  smudge: [25, 50],
  patternStamp: [45, 50],
  artHistory: [4, 100],
  bgEraser: [40, 100],
  colorReplace: [30, 80],
};

export interface ToolSettings {
  brushOpacity: number; // 0..100
  brushFlow: number;
  brushMode: string;
  pencilOpacity: number;
  pencilMode: string;
  pencilAutoErase: boolean;
  eraserOpacity: number;
  eraserFlow: number;
  eraserMode: "brush" | "pencil" | "block";
  bucketTolerance: number;
  bucketContiguous: boolean;
  bucketOpacity: number;
  gradientType: GradientType;
  gradientPreset: GradientPreset;
  gradientMode: string;
  gradientOpacity: number;
  gradientReverse: boolean;
  gradientDither: boolean;
  gradientTransparency: boolean;
  /** Type tool character / paragraph defaults (the color is the foreground color). */
  typeStyle: Partial<Omit<TextStyle, "color">>;
  moveAutoSelect: boolean;
  selectMode: SelectMode;
  marqueeFeather: number;
  marqueeAntiAlias: boolean;
  marqueeStyle: "normal" | "aspect" | "fixed";
  marqueeW: number;
  marqueeH: number;
  lassoFeather: number;
  lassoAntiAlias: boolean;
  wandTolerance: number;
  wandAntiAlias: boolean;
  wandContiguous: boolean;
  wandSampleMerged: boolean;
  stampOpacity: number;
  stampAligned: boolean;
  stampSampleAll: boolean;
  healAligned: boolean;
  healSampleAll: boolean;
  historyBrushOpacity: number;
  /** "open", or "snap:<index>" for a named snapshot. */
  historyBrushFrom: string;
  dodgeRange: "shadows" | "midtones" | "highlights";
  dodgeExposure: number;
  burnRange: "shadows" | "midtones" | "highlights";
  burnExposure: number;
  spongeMode: "saturate" | "desaturate";
  spongeFlow: number;
  blurStrength: number;
  sharpenStrength: number;
  smudgeStrength: number;
  redEyePupil: number;
  redEyeDarken: number;
  magicEraserTolerance: number;
  magicEraserAntiAlias: boolean;
  magicEraserContiguous: boolean;
  magicEraserSampleMerged: boolean;
  magicEraserOpacity: number;
  patternStampOpacity: number;
  /** Index into the pattern list. */
  patternIndex: number;
  bgEraserTolerance: number;
  bgEraserSampling: "once" | "continuous" | "background";
  bgEraserLimits: "contiguous" | "discontiguous";
  bgEraserProtectFg: boolean;
  colorReplaceTolerance: number;
  colorReplaceSampling: "once" | "continuous" | "background";
  colorReplaceLimits: "contiguous" | "discontiguous";
  colorReplaceMode: "hue" | "saturation" | "color" | "luminosity";
  artStyle: "tightShort" | "tightMedium" | "tightLong" | "looseMedium" | "looseLong" | "dab" | "tightCurl" | "looseCurl";
  artArea: number;
  artOpacity: number;
  magneticWidth: number;
  magneticFrequency: number;
  patchMode: "source" | "destination";
  noteAuthor: string;
  noteColor: string;
  /** Pen tools: draw paths, or shape layers. */
  penMode: "path" | "shape";
  /** Shape tools: new shape layer, a path, or pixels on the active layer. */
  shapeMode: "shape" | "path" | "pixels";
  shapeRadius: number;
  polygonSides: number;
  polygonIndent: number;
  lineWeight: number;
  lineArrowStart: boolean;
  lineArrowEnd: boolean;
  customShape: string;
  eyedropperSample: 1 | 3 | 5;
  cropShield: boolean;
}

export interface ViewOptions {
  extras: boolean;
  rulers: boolean;
  guides: boolean;
  grid: boolean;
  snap: boolean;
  lockGuides: boolean;
  selectionEdges: boolean;
}

export interface Preferences {
  historyStates: number;
  paintingCursor: "standard" | "precise" | "brushSize";
  otherCursor: "standard" | "precise";
  checkSize: 0 | 4 | 8 | 16;
  checkColors: "light" | "medium" | "dark";
  /** Layer mask overlay (rubylith) color and opacity (%). */
  maskOverlayColor: string;
  maskOverlayOpacity: number;
  gridSpacing: number;
  gridSubdivisions: number;
  guideColor: string;
  gridColor: string;
  /** How documents open: in floating windows (PS7 default) or maximized. */
  docMode: DocMode;
  /** Free Transform corner handles keep proportions unless Shift is held (off: the reverse, as in PS7). */
  transformProportional: boolean;
  /** Holding Ctrl switches to the Move tool until it is released. */
  ctrlMove: boolean;
}

export const DEFAULT_PREFS: Preferences = {
  historyStates: 50,
  transformProportional: true,
  ctrlMove: true,
  paintingCursor: "brushSize",
  otherCursor: "standard",
  checkSize: 8,
  checkColors: "light",
  gridSpacing: 64,
  gridSubdivisions: 4,
  guideColor: "#4aa8ff",
  gridColor: "#8a8a8a",
  docMode: "floating",
  maskOverlayColor: "#ff0000",
  maskOverlayOpacity: 50,
};

export interface NewDocOptions {
  name: string;
  width: number;
  height: number;
  contents: "white" | "background" | "transparent";
}

export type ScreenMode = "standard" | "fullMenu" | "full";

/** One open image: its document, history, GPU compositor and window. */
export interface Session {
  id: number;
  doc: Document;
  history: History;
  compositor: Compositor;
  win: DocWindow;
  /** History state id at the last save (or open/new). */
  savedStateId: number;
}

type Topic = "recent" | "composite" | "sessions" | "doc" | "view" | "tool" | "pointer" | "status" | "settings" | "theme" | "brushes" | "overlay" | "prefs" | "screen";

const DEFAULT_SETTINGS: ToolSettings = {
  brushOpacity: 100,
  brushFlow: 100,
  brushMode: "normal",
  pencilOpacity: 100,
  pencilMode: "normal",
  pencilAutoErase: false,
  eraserOpacity: 100,
  eraserFlow: 100,
  eraserMode: "brush",
  bucketTolerance: 32,
  bucketContiguous: true,
  bucketOpacity: 100,
  gradientType: "linear",
  gradientPreset: "fgToBg",
  gradientMode: "normal",
  gradientOpacity: 100,
  gradientReverse: false,
  gradientDither: true,
  gradientTransparency: true,
  typeStyle: {},
  moveAutoSelect: false,
  selectMode: "replace",
  marqueeFeather: 0,
  marqueeAntiAlias: true,
  marqueeStyle: "normal",
  marqueeW: 64,
  marqueeH: 64,
  lassoFeather: 0,
  lassoAntiAlias: true,
  wandTolerance: 32,
  wandAntiAlias: true,
  wandContiguous: true,
  wandSampleMerged: false,
  stampOpacity: 100,
  stampAligned: true,
  stampSampleAll: false,
  healAligned: true,
  healSampleAll: false,
  historyBrushOpacity: 100,
  historyBrushFrom: "open",
  dodgeRange: "midtones",
  dodgeExposure: 50,
  burnRange: "midtones",
  burnExposure: 50,
  spongeMode: "desaturate",
  spongeFlow: 50,
  blurStrength: 50,
  sharpenStrength: 50,
  smudgeStrength: 50,
  redEyePupil: 50,
  redEyeDarken: 50,
  magicEraserTolerance: 32,
  magicEraserAntiAlias: true,
  magicEraserContiguous: true,
  magicEraserSampleMerged: false,
  magicEraserOpacity: 100,
  patternStampOpacity: 100,
  patternIndex: 0,
  bgEraserTolerance: 50,
  bgEraserSampling: "continuous",
  bgEraserLimits: "contiguous",
  bgEraserProtectFg: false,
  colorReplaceTolerance: 30,
  colorReplaceSampling: "continuous",
  colorReplaceLimits: "contiguous",
  colorReplaceMode: "color",
  artStyle: "tightShort",
  artArea: 50,
  artOpacity: 100,
  magneticWidth: 10,
  magneticFrequency: 57,
  patchMode: "source",
  noteAuthor: "",
  noteColor: "#ffe066",
  penMode: "path",
  shapeMode: "shape",
  shapeRadius: 12,
  polygonSides: 5,
  polygonIndent: 0,
  lineWeight: 4,
  lineArrowStart: false,
  lineArrowEnd: false,
  customShape: "heart",
  eyedropperSample: 1,
  cropShield: true,
};

export class App {
  readonly bus: CommandBus;
  /** Open images, in opening order. */
  readonly sessions: Session[] = [];
  /** The image in the front window, or null. */
  active: Session | null = null;
  readonly windows: DocWindows;
  /** Stand-in used when no image is open (GPU limits, safe defaults). */
  private idle: Compositor;
  private idleViewport = document.createElement("div");
  /** Lets the UI add per-window pieces (overlay, rulers) as windows open. */
  onSessionCreated: ((s: Session) => void) | null = null;
  readonly maxTextureSize: number;
  /** Pasteboard and checkerboard colors applied to every window. */
  private theme = { pasteboard: [0.75, 0.75, 0.75] as [number, number, number], checkA: [1, 1, 1] as [number, number, number], checkB: [0.8, 0.8, 0.8] as [number, number, number], checkSize: 8 };
  readonly tools: Record<ToolId, Tool>;
  tool: Tool;
  settings: ToolSettings = { ...DEFAULT_SETTINGS, ...storage.load<Partial<ToolSettings>>("toolSettings", {}) };
  view: ViewOptions = { extras: true, rulers: false, guides: true, grid: false, snap: true, lockGuides: false, selectionEdges: true, ...storage.load<Partial<ViewOptions>>("view", {}) };
  prefs: Preferences = { ...DEFAULT_PREFS, ...storage.load<Partial<Preferences>>("prefs", {}) };
  screenMode: ScreenMode = "standard";
  /** The Brushes palette's preset library. */
  brushes: BrushPreset[];
  /** Patterns for Fill, the Pattern Stamp and the Pattern Overlay (Edit > Define Pattern adds). */
  patterns: NamedPattern[] = [];
  /** Each painting tool's current brush (edited by the Brushes palette). */
  toolBrush: Record<BrushToolId, BrushPreset>;
  /** Canvas-space pointer position (null when outside the viewport). */
  pointer: { x: number; y: number } | null = null;
  /** In-progress drawings for the overlay. */
  preview: {
    rect?: Rect & { shape: "rect" | "ellipse" };
    lasso?: [number, number][];
    lassoCursor?: [number, number] | null;
    crop?: Rect | null;
    guide?: { orientation: "horizontal" | "vertical"; position: number } | null;
    gradient?: [number, number, number, number] | null;
  } = {};
  /** Live offset of the selection outline while it's being dragged. */
  selectionOffset: { dx: number; dy: number } | null = null;
  /** Extra overlay drawings (e.g. Face Swap marks), drawn in every image window. */
  readonly overlayPainters = new Set<(ctx: CanvasRenderingContext2D, s: Session, view: { zoom: number; x: number; y: number }) => void>();
  private spaceHeld = false;
  private toolBeforeSpace: Tool | null = null;
  private ctrlHeld = false;
  /** The tool to go back to when Ctrl is released (null when Ctrl isn't borrowing the Move tool). */
  private toolBeforeCtrl: Tool | null = null;
  private dragging = false;
  private activeDragTool: Tool | null = null;
  private untitled = 1;
  private subs = new Map<Topic, Set<() => void>>();
  private colors: { fg: RGBA; bg: RGBA } = { fg: [0, 0, 0, 255], bg: [255, 255, 255, 255] };

  constructor(readonly docArea: HTMLElement) {
    this.idle = new Compositor(document.createElement("canvas"));
    this.maxTextureSize = this.idle.maxTextureSize;
    this.windows = new DocWindows(
      docArea,
      {
        activate: (w) => {
          const s = this.sessions.find((x) => x.win === w);
          if (s) this.activate(s);
        },
        requestClose: (w) => {
          const s = this.sessions.find((x) => x.win === w);
          if (s) void this.requestClose(s);
        },
        modeChanged: (mode) => {
          if (this.prefs.docMode !== mode) this.setPrefs({ docMode: mode });
          requestAnimationFrame(() => {
            for (const s of this.sessions) this.clampView(s);
            this.emit("view");
          });
        },
      },
      this.prefs.docMode,
    );
    this.bus = new CommandBus(new Document(1, 1));
    this.bus.history.maxStates = this.prefs.historyStates;
    registerBuiltins(this.bus);
    const savedPatterns = storage.load<{ name?: string; w: number; h: number; b64: string }[] | null>("patterns", null);
    try {
      this.patterns = savedPatterns ? savedPatterns.map(patternFromJSON) : defaultPatterns();
    } catch {
      this.patterns = defaultPatterns();
    }
    const savedBrushes = storage.load<unknown[] | null>("brushes", null);
    this.brushes = savedBrushes ? savedBrushes.map(presetFromJSON) : defaultBrushes();
    const savedTool = storage.load<Record<string, unknown> | null>("toolBrush", null);
    const find = (name: string) => this.brushes.find((b) => b.name === name) ?? this.brushes[0];
    this.toolBrush = {
      brush: savedTool?.brush ? presetFromJSON(savedTool.brush) : { ...find("Hard Round 13 pixels") },
      pencil: savedTool?.pencil ? presetFromJSON(savedTool.pencil) : { ...find("Hard Round 1 pixels") },
      eraser: savedTool?.eraser ? presetFromJSON(savedTool.eraser) : { ...find("Hard Round 19 pixels") },
      ...(Object.fromEntries(
        RETOUCH_TOOL_IDS.map((id) => {
          const [size, hardness] = RETOUCH_DEFAULT_SIZE[id];
          return [id, savedTool?.[id] ? presetFromJSON(savedTool[id]) : { ...roundBrush(size, hardness), name: `Retouch ${size}` }];
        }),
      ) as Record<RetouchToolId, BrushPreset>),
    };
    this.tools = createTools(this);
    this.tool = this.tools.brush;
    this.bus.onCommand(() => this.emit("doc"));
    this.applyPrefs();
    for (const t of ["settings"] as const) this.on(t, () => storage.saveSoon("toolSettings", () => this.settings));
    this.on("brushes", () => {
      storage.saveSoon("toolBrush", () => Object.fromEntries(Object.entries(this.toolBrush).map(([k, b]) => [k, presetToJSON(b)])));
    });
  }

  // ---------------- pub/sub for the UI ----------------

  on(topic: Topic, fn: () => void): () => void {
    let s = this.subs.get(topic);
    if (!s) this.subs.set(topic, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(topic: Topic): void {
    this.subs.get(topic)?.forEach((fn) => fn());
  }

  // ---------------- documents ----------------

  get doc(): Document | null {
    return this.active?.doc ?? null;
  }

  get compositor(): Compositor {
    return this.active?.compositor ?? this.idle;
  }

  get viewport(): HTMLElement {
    return this.active?.win.viewport ?? this.idleViewport;
  }

  get hasDoc(): boolean {
    return this.active !== null;
  }

  sessionModified(s: Session): boolean {
    return s.history.current?.id !== s.savedStateId;
  }

  get isModified(): boolean {
    return !!this.active && this.sessionModified(this.active);
  }

  get anyModified(): boolean {
    return this.sessions.some((s) => this.sessionModified(s));
  }

  nextUntitledName(): string {
    return `Untitled-${this.untitled}`;
  }

  newDocument(o: NewDocOptions): void {
    const doc = new Document(o.width, o.height, o.name);
    doc.foreground = [...this.colors.fg];
    doc.background = [...this.colors.bg];
    if (o.contents === "transparent") {
      doc.addLayer("Layer 1", 0);
    } else {
      const bg = doc.addLayer("Background", 0);
      bg.isBackground = true;
      bg.grid.fill(o.contents === "white" ? [255, 255, 255, 255] : [...doc.background]);
    }
    if (o.name === this.nextUntitledName()) this.untitled++;
    this.adopt(doc, "New");
  }

  openImage(img: DecodedImage): void {
    const doc = new Document(img.width, img.height, img.name);
    doc.sourceName = img.name;
    doc.foreground = [...this.colors.fg];
    doc.background = [...this.colors.bg];
    let opaque = true;
    for (let p = 3; p < img.data.length; p += 4)
      if (img.data[p] !== 255) {
        opaque = false;
        break;
      }
    const l = doc.addLayer(opaque ? "Background" : "Layer 0", 0);
    l.isBackground = opaque;
    l.grid.writeRegion({ x: 0, y: 0, w: img.width, h: img.height }, img.data);
    this.adopt(doc, "Open");
  }

  /** Asks whether to discard unsaved changes, then closes. Set by the UI. */
  confirmClose: ((s: Session) => Promise<boolean>) | null = null;
  /** Asks before turning a type layer into pixels (set by the UI). */
  confirmRasterize: ((name: string, kind: "type" | "shape") => Promise<boolean>) | null = null;

  /**
   * Offer to rasterize a type layer so its pixels can be edited (PS's
   * "This type layer must be rasterized" prompt). Resolves true if it was.
   */
  /** Before a pixel edit on the active layer: rasterize it first if it is type. */
  /** Offer to rasterize a type (or shape) layer before an edit of its pixels; vectorOk for edits that keep shapes as vectors. */
  async readyForPixels(pixelsOnly = false, vectorOk = false): Promise<boolean> {
    const d = this.doc;
    const l = d?.activeLayer;
    if (!d || !l || !(l.text || (l.shape && !vectorOk)) || d.quickMask || (!pixelsOnly && d.editMask && l.mask)) return true;
    return this.askRasterize(l.id);
  }

  async askRasterize(layerId: number): Promise<boolean> {
    const l = this.doc?.layerById(layerId);
    if (!l) return false;
    if (!l.text && !l.shape) return true;
    if (this.confirmRasterize && !(await this.confirmRasterize(l.name, l.shape ? "shape" : "type"))) return false;
    return this.run(l.shape ? "layer.rasterizeShape" : "layer.rasterizeType", { id: layerId });
  }

  async requestClose(s: Session): Promise<boolean> {
    if (this.sessionModified(s) && this.confirmClose && !(await this.confirmClose(s))) return false;
    this.closeSession(s);
    return true;
  }

  /** Close the active image (no prompt; see requestClose). */
  closeDocument(): void {
    if (this.active) this.closeSession(this.active);
  }

  closeSession(s: Session): void {
    if (this.dragging) return;
    forgetFilter(s.doc);
    this.rememberColors();
    const i = this.sessions.indexOf(s);
    if (i < 0) return;
    this.sessions.splice(i, 1);
    this.windows.remove(s.win);
    // Free the GPU context right away rather than waiting for GC.
    s.compositor.gl.getExtension("WEBGL_lose_context")?.loseContext();
    if (this.active === s) {
      this.active = null;
      this.preview = {};
      const next = this.windows.topmost();
      const ns = next && this.sessions.find((x) => x.win === next);
      if (ns) this.activate(ns);
      else {
        this.bus.attach(new Document(1, 1), new History(new Document(1, 1)));
        this.emit("doc");
        this.emit("view");
        this.emit("overlay");
      }
    }
    this.emit("sessions");
  }

  private rememberColors(): void {
    if (this.doc) this.colors = { fg: [...this.doc.foreground], bg: [...this.doc.background] };
  }

  /** Bring an image's window to the front and make it the target of everything. */
  activate(s: Session): void {
    if (this.active === s) return;
    if (this.dragging) return;
    this.tool.deactivate?.();
    if (this.maskView !== "off") this.setMaskView("off");
    this.rememberColors();
    this.active = s;
    s.doc.foreground = [...this.colors.fg];
    s.doc.background = [...this.colors.bg];
    this.bus.attach(s.doc, s.history);
    this.windows.focus(s.win);
    this.preview = {};
    this.selectionOffset = null;
    s.win.viewport.style.cursor = this.cursorFor(this.tool);
    s.compositor.requestFrame();
    for (const t of ["doc", "view", "settings", "overlay", "tool", "brushes", "sessions"] as const) this.emit(t);
  }

  /** Open a document in a new window. */
  private adopt(doc: Document, label: string): void {
    // Open at 100%, or zoomed out to fit the area (like PS7).
    const room = this.windows.maxContent();
    const zoom = Math.min(1, (room.w - 24) / doc.width, (room.h - 24) / doc.height);
    const win = this.windows.create(doc.width * zoom, doc.height * zoom);
    let compositor: Compositor;
    try {
      compositor = new Compositor(win.gl);
    } catch (e) {
      this.windows.remove(win);
      this.toast("Could not open another image window: the graphics system has run out of contexts. Close some images and try again.");
      throw e;
    }
    this.applyTheme(compositor);
    try {
      compositor.setDocument(doc);
    } catch (e) {
      this.windows.remove(win);
      compositor.gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw e;
    }
    const history = new History(doc);
    history.maxStates = this.prefs.historyStates;
    history.reset(doc, label);
    const s: Session = { id: win.id, doc, history, compositor, win, savedStateId: history.current!.id };
    this.sessions.push(s);
    history.on(() => {
      this.updateTitle(s);
      if (this.active === s) this.emit("doc");
    });
    compositor.compositeListeners.add(() => this.active === s && this.emit("composite"));
    doc.on((ev) => {
      if (ev.type === "pixels") compositor.markDirty(ev.rect);
      if (ev.type === "size") {
        compositor.setDocument(doc);
        this.fitOnScreen(true);
      }
      if (ev.type === "selection") {
        compositor.markSelectionDirty();
        if (this.active === s) this.emit("overlay");
      }
      if (ev.type === "guides" && this.active === s) this.emit("overlay");
      if (ev.type === "colors" && this.active === s) this.emit("settings");
      if (ev.type === "layers" && this.active === s && this.maskView !== "off") {
        const n = doc.activeNode;
        if (!n?.mask || n.id !== this.maskViewId) this.setMaskView("off");
      }
    });
    this.attachPointer(s);
    new ResizeObserver(() => {
      compositor.resize();
      this.clampView(s);
      if (this.active === s) this.emit("view");
    }).observe(win.viewport);
    compositor.view.zoom = zoom;
    this.onSessionCreated?.(s);
    this.activate(s);
    // Center once the window has its final size.
    compositor.resize();
    this.centerSession(s);
    this.updateTitle(s);
    this.emit("sessions");
  }

  /** Window caption: "name @ 50% (Layer 1, RGB)". */
  updateTitle(s: Session): void {
    const doc = s.doc;
    const z = +(s.compositor.view.zoom * 100).toFixed(1);
    const n = doc.activeNode;
    const target = doc.quickMask ? "Quick Mask" : doc.editMask && n?.mask ? `${n?.name}, Layer Mask` : (n?.name ?? "");
    this.windows.setTitle(s.win, `${doc.name}${this.sessionModified(s) ? "*" : ""} @ ${z}% (${target}, RGB)`);
  }

  /** Window > next image (Ctrl+Tab). */
  cycleDocument(dir: 1 | -1): void {
    if (this.sessions.length < 2 || !this.active) return;
    const i = this.sessions.indexOf(this.active);
    this.activate(this.sessions[(i + dir + this.sessions.length) % this.sessions.length]);
  }

  /**
   * Viewing the active layer's mask: "overlay" tints hidden areas (rubylith),
   * "gray" shows the mask alone. Turns off when another layer is selected.
   */
  maskView: "off" | "overlay" | "gray" = "off";
  private maskViewId = 0;

  setMaskView(mode: "off" | "overlay" | "gray"): void {
    const n = this.doc?.activeNode;
    if (mode !== "off" && !n?.mask) mode = "off";
    this.maskView = mode;
    this.maskViewId = n?.id ?? 0;
    for (const s of this.sessions) this.applyMaskView(s.compositor, s === this.active ? mode : "off");
    this.emit("view");
    this.emit("status");
  }

  private applyMaskView(c: Compositor, mode: "off" | "overlay" | "gray"): void {
    const hex = parseInt(this.prefs.maskOverlayColor.replace("#", ""), 16) || 0xff0000;
    c.maskView = { mode, color: [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255], opacity: this.prefs.maskOverlayOpacity / 100 };
    c.requestFrame();
  }

  private applyTheme(c: Compositor): void {
    c.theme = { pasteboard: [...this.theme.pasteboard], checkA: [...this.theme.checkA], checkB: [...this.theme.checkB] };
    c.checkSize = this.theme.checkSize;
    c.requestFrame();
  }

  setPasteboard(rgb: [number, number, number]): void {
    this.theme.pasteboard = rgb;
    for (const s of this.sessions) this.applyTheme(s.compositor);
  }

  /** Open a .cie project. path is its location on the desktop (for Save and Open Recent). */
  async openProject(bytes: Uint8Array, name: string, path: string | null = null): Promise<void> {
    const doc = await decodeProjectAsync(bytes, name);
    doc.filePath = path;
    this.adopt(doc, "Open");
    if (path) this.addRecent(path);
  }

  /**
   * Save the active image as a .cie project: to its own file (Save) or to a
   * new one (Save As). Returns false if cancelled.
   */
  async saveProject(saveAs = false): Promise<boolean> {
    settlePendingEdits();
    const s = this.active;
    if (!s) return false;
    const doc = s.doc;
    const base = doc.name.replace(/\.[^.]+$/, "");
    // A small flattened preview for file browsers.
    let preview: Uint8Array | null = null;
    try {
      const k = Math.min(1, 512 / Math.max(doc.width, doc.height));
      const w = Math.max(1, Math.round(doc.width * k)), h = Math.max(1, Math.round(doc.height * k));
      const full = s.compositor.readPixels({ x: 0, y: 0, w: doc.width, h: doc.height });
      const c = new OffscreenCanvas(doc.width, doc.height);
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(full), doc.width, doc.height), 0, 0);
      const t = new OffscreenCanvas(w, h);
      t.getContext("2d")!.drawImage(c, 0, 0, w, h);
      preview = new Uint8Array(await (await t.convertToBlob({ type: "image/png" })).arrayBuffer());
    } catch {
      /* no preview */
    }
    const pill = busyPill(`Saving ${doc.name}...`);
    let where: string | null;
    try {
      const bytes = await encodeProjectAsync(doc, preview);
      where = await saveBytes(bytes, `${base}.cie`, { name: "Classic Image Editor", ext: "cie" }, saveAs ? null : doc.filePath);
    } catch (e) {
      pill.done();
      await alertDialog("Save", `Could not save "${doc.name}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    pill.done();
    if (!where) return false;
    if (isDesktop) doc.filePath = where;
    doc.name = baseName(where);
    s.savedStateId = s.history.current!.id;
    this.updateTitle(s);
    this.emit("doc");
    if (isDesktop) this.addRecent(where);
    this.status(`Saved ${doc.name}`);
    return true;
  }

  /** Recently opened or saved files (desktop paths), newest first. */
  get recentFiles(): string[] {
    return storage.load<string[]>("recentFiles", []);
  }

  addRecent(path: string): void {
    const list = [path, ...this.recentFiles.filter((p) => p !== path)].slice(0, 12);
    storage.save("recentFiles", list);
    this.emit("recent");
  }

  clearRecent(): void {
    storage.save("recentFiles", []);
    this.emit("recent");
  }

  async save(format: ExportFormat, quality = 0.9): Promise<void> {
    settlePendingEdits();
    const doc = this.doc;
    if (!doc) return;
    const px = this.compositor.readPixels({ x: 0, y: 0, w: doc.width, h: doc.height });
    const blob = await encodeImage(px, doc.width, doc.height, format, quality);
    const base = doc.name.replace(/\.[^.]+$/, "");
    const saved = await saveBlob(blob, `${base}.${format === "png" ? "png" : "jpg"}`, format);
    if (saved) {
      doc.name = saved;
      this.active!.savedStateId = this.bus.history.current!.id;
      this.updateTitle(this.active!);
      this.emit("doc");
      this.status(`Saved ${saved}`);
    }
  }

  /** Run a command from the UI, showing refusals instead of throwing. */
  private preparing = new WeakMap<object, string>();

  run(name: string, params: Record<string, unknown> = {}): boolean {
    if (!this.doc) return false;
    try {
      // Commands with slow setup (AI models, Content-Aware Fill) get it done first, then run.
      // Pressing the same command again while it gets ready doesn't start it twice.
      const doc = this.doc;
      if (this.preparing.get(doc) === name) return false;
      const pending = this.bus.prepare(name, params);
      if (pending) {
        this.preparing.set(doc, name);
        void pending.then(
          () => {
            this.preparing.delete(doc);
            if (this.doc === doc) this.run(name, params);
          },
          (e: unknown) => {
            this.preparing.delete(doc);
            const err = e instanceof Error ? e : new Error(String(e));
            if (err.name !== "AbortError") this.toast(err.message);
          },
        );
        return false;
      }
      this.bus.dispatch(name, params);
      return true;
    } catch (e) {
      if (e instanceof NeedsRasterizeError && (this.doc?.layerById(e.layerId)?.text || this.doc?.layerById(e.layerId)?.shape)) {
        // Ask, rasterize, then try again (once).
        const id = e.layerId;
        void this.askRasterize(id).then((ok) => {
          const l = this.doc?.layerById(id);
          if (ok && l && !l.text && !l.shape) this.run(name, params);
        });
        return false;
      }
      const d = this.bus.get(name);
      const label = d ? (typeof d.label === "string" ? d.label : name) : name;
      this.toast(`Could not complete ${label}: ${(e as Error).message}.`);
      return false;
    }
  }

  // ---------------- settings, prefs, view options ----------------

  setView(patch: Partial<ViewOptions>): void {
    Object.assign(this.view, patch);
    storage.save("view", this.view);
    this.emit("view");
    this.emit("overlay");
  }

  setPrefs(patch: Partial<Preferences>): void {
    Object.assign(this.prefs, patch);
    storage.save("prefs", this.prefs);
    this.applyPrefs();
    this.emit("prefs");
  }

  private applyPrefs(): void {
    const p = this.prefs;
    for (const s of this.sessions) s.history.maxStates = p.historyStates;
    const checks = { light: [[1, 1, 1], [0.8, 0.8, 0.8]], medium: [[0.8, 0.8, 0.8], [0.6, 0.6, 0.6]], dark: [[0.4, 0.4, 0.4], [0.25, 0.25, 0.25]] }[p.checkColors];
    this.theme.checkSize = p.checkSize || 100000;
    this.theme.checkA = checks[0] as [number, number, number];
    this.theme.checkB = (p.checkSize ? checks[1] : checks[0]) as [number, number, number];
    for (const s of this.sessions) this.applyTheme(s.compositor);
    for (const s of this.sessions) this.applyMaskView(s.compositor, s === this.active ? this.maskView : "off");
    if (this.windows && this.windows.mode !== p.docMode) this.windows.setMode(p.docMode);
    if (this.active) this.viewport.style.cursor = this.cursorFor(this.tool);
  }

  savePatterns(): void {
    storage.save("patterns", this.patterns.map(patternToJSON));
    this.emit("brushes");
  }

  saveBrushes(): void {
    storage.save("brushes", this.brushes.map(presetToJSON));
    this.emit("brushes");
  }

  /** The brush the active painting tool uses. */
  get activeBrush(): BrushPreset | null {
    const id = this.tool.id as BrushToolId;
    return this.toolBrush[id] ?? null;
  }

  /** Snap a canvas point to guides and grid lines within 6 screen pixels. */
  snap(x: number, y: number): { x: number; y: number } {
    if (!this.doc || !this.view.snap || !this.view.extras) return { x, y };
    const tol = 6 / this.compositor.view.zoom;
    const xs: number[] = [0, this.doc.width];
    const ys: number[] = [0, this.doc.height];
    if (this.view.guides) {
      xs.push(...this.doc.guides.v);
      ys.push(...this.doc.guides.h);
    }
    if (this.view.grid) {
      const g = this.prefs.gridSpacing;
      xs.push(Math.round(x / g) * g);
      ys.push(Math.round(y / g) * g);
    }
    const near = (v: number, list: number[]) => {
      let best = v, d = tol;
      for (const c of list) if (Math.abs(c - v) <= d) (best = c), (d = Math.abs(c - v));
      return best;
    };
    return { x: near(x, xs), y: near(y, ys) };
  }

  setScreenMode(m: ScreenMode): void {
    this.screenMode = m;
    this.emit("screen");
    requestAnimationFrame(() => this.fitOnScreen());
  }

  // ---------------- view ----------------

  toCanvas(sx: number, sy: number): { x: number; y: number } {
    const v = this.compositor.view;
    return { x: (sx - v.x) / v.zoom, y: (sy - v.y) / v.zoom };
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    const v = this.compositor.view;
    return { x: x * v.zoom + v.x, y: y * v.zoom + v.y };
  }

  setZoom(zoom: number, anchor?: { sx: number; sy: number }): void {
    const v = this.compositor.view;
    zoom = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], zoom));
    const a = anchor ?? { sx: this.viewport.clientWidth / 2, sy: this.viewport.clientHeight / 2 };
    const c = this.toCanvas(a.sx, a.sy);
    v.zoom = zoom;
    v.x = Math.round(a.sx - c.x * zoom);
    v.y = Math.round(a.sy - c.y * zoom);
    this.clampView();
    this.compositor.requestFrame();
    if (this.active) this.updateTitle(this.active);
    this.emit("view");
  }

  zoomStep(dir: 1 | -1, anchor?: { sx: number; sy: number }): void {
    const z = this.compositor.view.zoom;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999);
    if (next) this.setZoom(next, anchor);
  }

  /**
   * Fit on Screen (Ctrl+0). In floating mode the window grows to the largest
   * size the area allows, as PS7 does; on open, never zoom above 100%.
   */
  fitOnScreen(capAt100 = false): void {
    const s = this.active;
    if (!s) return;
    const doc = s.doc;
    const floating = this.windows.mode === "floating";
    let room = { w: s.win.viewport.clientWidth, h: s.win.viewport.clientHeight };
    if (floating && !capAt100) room = this.windows.maxContent();
    const pad = floating ? 0 : 20;
    let z = Math.min((room.w - pad * 2) / doc.width, (room.h - pad * 2) / doc.height);
    if (capAt100) z = Math.min(1, z);
    z = Math.max(ZOOM_STEPS[0], z);
    if (floating && !capAt100) {
      this.windows.moveToOrigin(s.win);
      this.windows.sizeToContent(s.win, Math.ceil(doc.width * z), Math.ceil(doc.height * z));
      s.compositor.resize();
    }
    s.compositor.view.zoom = z;
    this.centerSession(s);
  }

  actualPixels(): void {
    this.setZoom(1);
    this.center();
  }

  center(): void {
    if (this.active) this.centerSession(this.active);
  }

  private centerSession(s: Session): void {
    const v = s.compositor.view;
    v.x = Math.round((s.win.viewport.clientWidth - s.doc.width * v.zoom) / 2);
    v.y = Math.round((s.win.viewport.clientHeight - s.doc.height * v.zoom) / 2);
    s.compositor.requestFrame();
    this.updateTitle(s);
    if (this.active === s) this.emit("view");
  }

  panBy(dx: number, dy: number): void {
    const s = this.active;
    if (!s) return;
    const v = s.compositor.view;
    v.x += dx;
    v.y += dy;
    this.clampView(s);
    s.compositor.requestFrame();
    this.emit("view");
  }

  /** Keep part of the image on screen; center it when it fits. */
  private clampView(s: Session | null = this.active): void {
    if (!s) return;
    const v = s.compositor.view;
    const vw = s.win.viewport.clientWidth;
    const vh = s.win.viewport.clientHeight;
    if (!vw || !vh) return;
    const w = s.doc.width * v.zoom;
    const h = s.doc.height * v.zoom;
    if (w <= vw) v.x = Math.round((vw - w) / 2);
    else v.x = Math.min(0, Math.max(vw - w, v.x));
    if (h <= vh) v.y = Math.round((vh - h) / 2);
    else v.y = Math.min(0, Math.max(vh - h, v.y));
    s.compositor.requestFrame();
  }

  // ---------------- tools ----------------

  cursorFor(t: Tool): string {
    const painting = t.id in this.toolBrush || t.id === "faceSwap";
    if (painting) return this.prefs.paintingCursor === "brushSize" ? "none" : "crosshair";
    if (this.prefs.otherCursor === "precise" && t.cursor !== "grab" && t.cursor !== "move") return "crosshair";
    return t.cursor;
  }

  /** The chosen tool, even while Space or Ctrl is borrowing the Hand or Move tool. */
  get baseTool(): Tool {
    return this.toolBeforeCtrl ?? this.toolBeforeSpace ?? this.tool;
  }

  setTool(id: ToolId): void {
    if (this.dragging) return;
    // Picking a tool ends any borrowing (releasing Ctrl or Space won't switch back).
    const prev = this.baseTool;
    this.toolBeforeCtrl = null;
    this.toolBeforeSpace = null;
    prev.deactivate?.();
    this.tool = this.tools[id];
    this.viewport.style.cursor = this.cursorFor(this.tool);
    this.emit("tool");
    this.emit("brushes");
    this.compositor.requestFrame();
  }

  private toolEvent(e: PointerEvent | MouseEvent): ToolEvent {
    const r = this.viewport.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const c = this.toCanvas(sx, sy);
    const pe = e as PointerEvent;
    return {
      x: c.x,
      y: c.y,
      sx,
      sy,
      shift: e.shiftKey,
      alt: e.altKey,
      // While Ctrl is only holding the Move tool, it isn't also a Ctrl-click.
      ctrl: (e.ctrlKey || e.metaKey) && !this.toolBeforeCtrl,
      button: e.button,
      detail: e.detail,
      pressure: pe.pointerType === "pen" ? pe.pressure : 1,
    };
  }

  private attachPointer(s: Session): void {
    const vp = s.win.viewport;
    vp.addEventListener("pointerdown", (e) => {
      if (e.button > 1) return;
      // Clicks in the Type tool's text box place the caret.
      if ((e.target as HTMLElement).closest?.(".type-editor")) return;
      if (this.active !== s) {
        // The first click on a background window only brings it forward.
        this.activate(s);
        e.preventDefault();
        return;
      }
      vp.setPointerCapture(e.pointerId);
      this.dragging = true;
      const tool = e.button === 1 ? this.tools.hand : this.tool;
      this.activeDragTool = tool;
      tool.down(this.toolEvent(e));
      e.preventDefault();
    });
    vp.addEventListener("pointermove", (e) => {
      if (this.active !== s) return;
      const ev = this.toolEvent(e);
      this.pointer = this.doc ? { x: ev.x, y: ev.y } : null;
      this.emit("pointer");
      if (this.dragging) {
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ce of events.length ? events : [e]) this.activeDragTool?.move(this.toolEvent(ce));
      } else this.tool.hover?.(ev);
      this.emit("overlay");
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.activeDragTool?.up(this.toolEvent(e));
      this.activeDragTool = null;
      if (!this.spaceHeld && this.toolBeforeSpace) this.restoreFromSpace();
      if (!this.ctrlHeld && this.toolBeforeCtrl) this.restoreFromCtrl();
      this.emit("overlay");
    };
    vp.addEventListener("pointerup", end);
    vp.addEventListener("pointercancel", end);
    vp.addEventListener("pointerleave", () => {
      if (this.active !== s) return;
      this.pointer = null;
      this.emit("pointer");
      this.emit("overlay");
    });
    vp.addEventListener("dblclick", (e) => {
      if (this.active === s) this.tool.dblclick?.(this.toolEvent(e));
    });
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (this.active !== s) this.activate(s);
        const r = vp.getBoundingClientRect();
        if (e.ctrlKey || e.altKey || e.metaKey) {
          const f = Math.exp(-e.deltaY * (e.ctrlKey && !e.altKey ? 0.01 : 0.002));
          this.setZoom(this.compositor.view.zoom * f, { sx: e.clientX - r.left, sy: e.clientY - r.top });
        } else this.panBy(-(e.shiftKey ? e.deltaY : e.deltaX), e.shiftKey ? 0 : -e.deltaY);
      },
      { passive: false },
    );
    vp.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  holdSpace(down: boolean): void {
    if (down && !this.spaceHeld) {
      this.spaceHeld = true;
      if (this.tool !== this.tools.hand && !this.dragging) {
        this.toolBeforeSpace = this.tool;
        this.tool = this.tools.hand;
        this.viewport.style.cursor = this.cursorFor(this.tool);
        this.emit("overlay");
      }
    } else if (!down && this.spaceHeld) {
      this.spaceHeld = false;
      if (!this.dragging) this.restoreFromSpace();
    }
  }

  /**
   * Hold Ctrl: the Move tool, until Ctrl is released (as in Photoshop). Not
   * for tools that use Ctrl themselves (Free Transform, an active crop, type
   * being edited), nor the Hand, Zoom or Move tools.
   */
  holdCtrl(down: boolean): void {
    if (down && !this.ctrlHeld) {
      this.ctrlHeld = true;
      if (!this.prefs.ctrlMove || !this.doc || this.dragging || this.toolBeforeSpace || this.toolBeforeCtrl) return;
      const t = this.tool as Tool & { active?: boolean; editing?: boolean };
      if (["move", "transform", "hand", "zoom", "pathSelect", "directSelect"].includes(t.id) || (t.id === "crop" && t.active) || (t.id === "type" && t.editing)) return;
      this.toolBeforeCtrl = this.tool;
      // The pen tools borrow Direct Selection instead, as in Photoshop.
      const pen = ["pen", "freeformPen", "addAnchor", "deleteAnchor", "convertPoint"].includes(t.id);
      this.tool = pen ? this.tools.directSelect : this.tools.move;
      this.viewport.style.cursor = this.cursorFor(this.tool);
      this.emit("overlay");
    } else if (!down && this.ctrlHeld) {
      this.ctrlHeld = false;
      if (!this.dragging) this.restoreFromCtrl();
    }
  }

  private restoreFromCtrl(): void {
    if (this.toolBeforeCtrl) {
      this.tool = this.toolBeforeCtrl;
      this.toolBeforeCtrl = null;
      this.viewport.style.cursor = this.cursorFor(this.tool);
      this.emit("overlay");
    }
  }

  private restoreFromSpace(): void {
    if (this.toolBeforeSpace) {
      this.tool = this.toolBeforeSpace;
      this.toolBeforeSpace = null;
      this.viewport.style.cursor = this.cursorFor(this.tool);
      this.emit("overlay");
    }
  }

  // ---------------- feedback ----------------

  private statusText = "";
  private statusTimer = 0;

  status(msg: string): void {
    this.statusText = msg;
    clearTimeout(this.statusTimer);
    this.statusTimer = window.setTimeout(() => {
      this.statusText = "";
      this.emit("status");
    }, 4000);
    this.emit("status");
  }

  get statusMessage(): string {
    return this.statusText;
  }

  toast(msg: string): void {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    el.setAttribute("role", "status");
    this.viewport.parentElement!.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
}
