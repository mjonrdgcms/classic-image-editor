/**
 * Filter > Liquify: a full-window editor with PS7's tools (Forward Warp,
 * Reconstruct, Smooth, Twirl, Pucker, Bloat, Push Left, Mirror,
 * Turbulence, Freeze / Thaw Mask, Hand, Zoom), reconstruct modes, mask
 * options, mesh / mask / backdrop views, its own undo, saved meshes, and
 * Face-Aware Liquify. The preview runs on the GPU; OK applies the mesh to
 * the full-resolution layer as one undoable step.
 */

import type { App } from "../app";
import { compositeNodes } from "../core/composite";
import type { Layer } from "../core/document";
import { LiquifyField, LiquifyTool, ReconstructMode, applyDab, decodeMesh, encodeMesh, reconstructAll, type Brush, type EncodedMesh } from "../core/liquify";
import { busyPill, el, sheet } from "./dialogs";
import * as storage from "./storage";
import { FacePanel } from "./liquifyface";

const MAX_FIELD = 1600;

interface ToolDef {
  id: LiquifyTool | "hand" | "zoom" | "face";
  label: string;
  key: string;
  icon: string;
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const TOOLS: ToolDef[] = [
  { id: "warp", label: "Forward Warp Tool", key: "W", icon: svg(`<path d="M4 18c3-1 5-3 6-6s3-6 8-7"/><path d="M14 5h4v4"/><circle cx="6" cy="17" r="2"/>`) },
  { id: "reconstruct", label: "Reconstruct Tool", key: "R", icon: svg(`<path d="M5 12a7 7 0 1 0 2-5"/><path d="M5 4v4h4"/><path d="M12 9v4l2 2"/>`) },
  { id: "smooth", label: "Smooth Tool", key: "E", icon: svg(`<path d="M3 15c3-4 6 2 9-2s6 2 9-2"/><path d="M3 10c3-4 6 2 9-2s6 2 9-2" opacity=".45"/>`) },
  { id: "twirlCW", label: "Twirl Clockwise Tool", key: "C", icon: svg(`<path d="M12 12m-1 0a1 1 0 1 0 2 0a3 3 0 1 0-6 0a5 5 0 1 0 10 0a7 7 0 1 0-14 0"/><path d="M19 9l0 3-3 0"/>`) },
  { id: "twirlCCW", label: "Twirl Counterclockwise Tool", key: "L", icon: svg(`<path d="M12 12m1 0a1 1 0 1 1-2 0a3 3 0 1 1 6 0a5 5 0 1 1-10 0a7 7 0 1 1 14 0"/><path d="M5 9l0 3 3 0"/>`) },
  { id: "pucker", label: "Pucker Tool", key: "P", icon: svg(`<circle cx="12" cy="12" r="8" stroke-dasharray="2 2"/><path d="M12 4v5M12 15v5M4 12h5M15 12h5"/><path d="M10 7l2 2 2-2M10 17l2-2 2 2M7 10l2 2-2 2M17 10l-2 2 2 2"/>`) },
  { id: "bloat", label: "Bloat Tool", key: "B", icon: svg(`<circle cx="12" cy="12" r="3"/><path d="M12 9V3M12 15v6M9 12H3M15 12h6"/><path d="M10 5l2-2 2 2M10 19l2 2 2-2M5 10l-2 2 2 2M19 10l2 2-2 2"/>`) },
  { id: "push", label: "Push Left Tool", key: "O", icon: svg(`<path d="M12 20V4"/><path d="M12 8H5M12 12H7M12 16H5"/><path d="M7 6L5 8l2 2M9 10l-2 2 2 2M7 14l-2 2 2 2"/>`) },
  { id: "mirror", label: "Mirror Tool", key: "M", icon: svg(`<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 12l5 5V7zM15 7l5 5-5 5V7z"/>`) },
  { id: "turbulence", label: "Turbulence Tool", key: "T", icon: svg(`<path d="M3 8c2-2 4 2 6 0s4 2 6 0 4 2 6 0M3 13c2-2 4 2 6 0s4 2 6 0 4 2 6 0M3 18c2-2 4 2 6 0s4 2 6 0 4 2 6 0"/>`) },
  { id: "freeze", label: "Freeze Mask Tool", key: "F", icon: svg(`<path d="M5 19l4-1 10-10-3-3L6 15l-1 4z"/><path d="M14 7l3 3"/><rect x="3" y="20" width="8" height="1.5" fill="currentColor"/>`) },
  { id: "thaw", label: "Thaw Mask Tool", key: "D", icon: svg(`<path d="M5 19l4-1 10-10-3-3L6 15l-1 4z"/><path d="M14 7l3 3"/><path d="M3 21h8" stroke-dasharray="2 2"/>`) },
  { id: "face", label: "Face Tool", key: "A", icon: svg(`<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M8.5 14.5c2 2 5 2 7 0"/>`) },
  { id: "hand", label: "Hand Tool", key: "H", icon: svg(`<path d="M8 13V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7c0 4-3 7-6 7-2.5 0-4-1-5.5-3l-2.5-4a1.5 1.5 0 0 1 2.5-1.5L8 14"/>`) },
  { id: "zoom", label: "Zoom Tool", key: "Z", icon: svg(`<circle cx="10" cy="10" r="6"/><path d="M15 15l5 5M10 7v6M7 10h6"/>`) },
];

const STATIONARY = new Set<LiquifyTool>(["twirlCW", "twirlCCW", "pucker", "bloat", "reconstruct", "smooth", "turbulence"]);

interface Settings {
  tool: ToolDef["id"];
  size: number;
  density: number;
  pressure: number;
  rate: number;
  jitter: number;
  mode: ReconstructMode;
  stylus: boolean;
  showImage: boolean;
  showMesh: boolean;
  meshSize: number;
  meshColor: string;
  showMask: boolean;
  maskColor: string;
  showBackdrop: boolean;
  backdrop: string;
  backdropMode: "front" | "behind" | "blend";
  backdropOpacity: number;
}

const DEFAULTS: Settings = {
  tool: "warp",
  size: 100,
  density: 50,
  pressure: 100,
  rate: 80,
  jitter: 50,
  mode: "revert",
  stylus: true,
  showImage: true,
  showMesh: false,
  meshSize: 32,
  meshColor: "#7a8cff",
  showMask: true,
  maskColor: "#ff3b3b",
  showBackdrop: false,
  backdrop: "all",
  backdropMode: "behind",
  backdropOpacity: 50,
};

// ------------------------------------------------------------------ GPU preview

const VS = `#version 300 es
in vec2 aPos;
uniform vec2 uCanvas;
uniform vec3 uView;
out vec2 vF;
void main() {
  vec2 sp = aPos * uCanvas;
  vF = (sp - uView.yz) / uView.x;
  gl_Position = vec4(aPos.x * 2.0 - 1.0, 1.0 - aPos.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vF;
uniform vec2 uField;
uniform sampler2D uSrc;
uniform sampler2D uDisp;
uniform sampler2D uFreeze;
uniform sampler2D uBack;
uniform int uShowImage, uShowMesh, uShowMask, uShowBack, uBackMode;
uniform float uMesh, uBackOpacity, uZoom;
uniform vec3 uMeshColor, uMaskColor, uPaste;
out vec4 o;
void main() {
  if (vF.x < 0.0 || vF.y < 0.0 || vF.x > uField.x || vF.y > uField.y) { o = vec4(uPaste, 1.0); return; }
  vec2 uv = vF / uField;
  vec2 d = texture(uDisp, uv).rg;
  vec2 sf = vF + d;
  vec2 suv = clamp(sf / uField, vec2(0.0), vec2(1.0));
  // Checkerboard under transparent pixels.
  vec2 ck = floor(gl_FragCoord.xy / 8.0);
  vec3 col = mod(ck.x + ck.y, 2.0) < 1.0 ? vec3(1.0) : vec3(0.82);
  vec4 img = uShowImage == 1 ? texture(uSrc, suv) : vec4(0.0);
  vec4 back = uShowBack == 1 ? texture(uBack, uv) : vec4(0.0);
  if (uShowBack == 1 && uBackMode == 1) col = mix(col, back.rgb, back.a);
  col = mix(col, img.rgb, img.a);
  if (uShowBack == 1 && uBackMode == 0) col = mix(col, back.rgb, back.a * uBackOpacity);
  if (uShowBack == 1 && uBackMode == 2) col = mix(col, back.rgb, back.a * uBackOpacity * 0.5);
  if (uShowBack == 1 && uBackMode == 1 && img.a < 1.0) col = mix(col, back.rgb, (1.0 - img.a) * back.a * uBackOpacity);
  if (uShowMask == 1) {
    float f = texture(uFreeze, uv).r;
    col = mix(col, uMaskColor, f * 0.5);
  }
  if (uShowMesh == 1) {
    vec2 g = sf / uMesh;
    vec2 fw = fwidth(g);
    vec2 a = abs(fract(g - 0.5) - 0.5) / max(fw, vec2(1e-4));
    float line = 1.0 - min(min(a.x, a.y), 1.0);
    col = mix(col, uMeshColor, line * 0.85);
  }
  o = vec4(col, 1.0);
}`;

class Preview {
  gl: WebGL2RenderingContext;
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null> = {};
  tex: { src: WebGLTexture; disp: WebGLTexture; freeze: WebGLTexture; back: WebGLTexture };

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly fw: number,
    readonly fh: number,
  ) {
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })!;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    this.prog = p;
    for (const n of ["uCanvas", "uView", "uField", "uSrc", "uDisp", "uFreeze", "uBack", "uShowImage", "uShowMesh", "uShowMask", "uShowBack", "uBackMode", "uMesh", "uBackOpacity", "uZoom", "uMeshColor", "uMaskColor", "uPaste"]) this.u[n] = gl.getUniformLocation(p, n);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const mk = (internal: number, format: number, type: number, filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, fw, fh, 0, format, type, null);
      return t;
    };
    this.tex = {
      src: mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR),
      disp: mk(gl.RG16F, gl.RG, gl.FLOAT, gl.LINEAR),
      freeze: mk(gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.LINEAR),
      back: mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR),
    };
  }

  uploadRGBA(which: "src" | "back", data: Uint8ClampedArray): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[which]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.fw, this.fh, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  /** Upload a rectangle of the displacement (sum of brush and face fields) and freeze mask. */
  uploadField(f: LiquifyField, extra: { dx: Float32Array; dy: Float32Array } | null, r: { x0: number; y0: number; x1: number; y1: number }): void {
    const gl = this.gl;
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    const rg = new Float32Array(w * h * 2);
    const fr = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y + r.y0) * f.w + x + r.x0, j = y * w + x;
        rg[j * 2] = f.dx[i] + (extra ? extra.dx[i] : 0);
        rg[j * 2 + 1] = f.dy[i] + (extra ? extra.dy[i] : 0);
        fr[j] = f.freeze[i] * 255;
      }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.disp);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, w, h, gl.RG, gl.FLOAT, rg);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.freeze);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, w, h, gl.RED, gl.UNSIGNED_BYTE, fr);
  }

  draw(view: { zoom: number; x: number; y: number }, s: Settings, paste: number[]): void {
    const gl = this.gl;
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniform2f(u.uCanvas, W, H);
    gl.uniform3f(u.uView, view.zoom * dpr, view.x * dpr, view.y * dpr);
    gl.uniform2f(u.uField, this.fw, this.fh);
    const units: [string, WebGLTexture][] = [["uSrc", this.tex.src], ["uDisp", this.tex.disp], ["uFreeze", this.tex.freeze], ["uBack", this.tex.back]];
    units.forEach(([n, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u[n], i);
    });
    const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
    gl.uniform1i(u.uShowImage, s.showImage ? 1 : 0);
    gl.uniform1i(u.uShowMesh, s.showMesh ? 1 : 0);
    gl.uniform1i(u.uShowMask, s.showMask ? 1 : 0);
    gl.uniform1i(u.uShowBack, s.showBackdrop ? 1 : 0);
    gl.uniform1i(u.uBackMode, s.backdropMode === "front" ? 0 : s.backdropMode === "behind" ? 1 : 2);
    gl.uniform1f(u.uMesh, s.meshSize);
    gl.uniform1f(u.uBackOpacity, s.backdropOpacity / 100);
    gl.uniform1f(u.uZoom, view.zoom);
    gl.uniform3fv(u.uMeshColor, hex(s.meshColor));
    gl.uniform3fv(u.uMaskColor, hex(s.maskColor));
    gl.uniform3fv(u.uPaste, paste);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    gl.deleteProgram(this.prog);
    if (!gl.isContextLost()) gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// ------------------------------------------------------------------ helpers

/** Area-average downscale of RGBA to fw x fh. */
function shrink(src: Uint8ClampedArray, w: number, h: number, fw: number, fh: number): Uint8ClampedArray {
  if (fw === w && fh === h) return new Uint8ClampedArray(src);
  const out = new Uint8ClampedArray(fw * fh * 4);
  const kx = w / fw, ky = h / fh;
  for (let y = 0; y < fh; y++) {
    const y0 = Math.floor(y * ky), y1 = Math.max(y0 + 1, Math.floor((y + 1) * ky));
    for (let x = 0; x < fw; x++) {
      const x0 = Math.floor(x * kx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * kx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * w + xx) * 4;
          const al = src[p + 3];
          r += src[p] * al;
          g += src[p + 1] * al;
          b += src[p + 2] * al;
          a += al;
          n++;
        }
      const o = (y * fw + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return out;
}

function resampleField(dx: Float32Array, dy: Float32Array, w: number, h: number, nw: number, nh: number): { dx: Float32Array; dy: Float32Array } {
  const ox = new Float32Array(nw * nh), oy = new Float32Array(nw * nh);
  const kx = w / nw, ky = h / nh;
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, x * kx), sy = Math.min(h - 1, y * ky);
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;
      const s = (a: Float32Array) => (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
      ox[y * nw + x] = s(dx) / kx;
      oy[y * nw + x] = s(dy) / ky;
    }
  return { dx: ox, dy: oy };
}

// ------------------------------------------------------------------ the dialog

export async function liquifyDialog(app: App): Promise<void> {
  const doc = app.doc;
  const layer = doc?.activeLayer;
  if (!doc || !layer) return;
  if (layer.locks.pixels) return app.toast(`Could not use Liquify because "${layer.name}" has its image pixels locked.`);
  if (!(await app.readyForPixels(true))) return;
  const L = doc.activeLayer as Layer;
  const W = L.grid.width, H = L.grid.height;
  const k = Math.min(1, MAX_FIELD / Math.max(W, H));
  const fw = Math.max(1, Math.round(W * k)), fh = Math.max(1, Math.round(H * k));
  const scale = fw / W; // field px per image px

  const s: Settings = { ...DEFAULTS, ...storage.load<Partial<Settings>>("liquify", {}) };
  // A remembered backdrop layer belongs to another image.
  if (s.backdrop !== "all" && (!doc.layerById(+s.backdrop) || +s.backdrop === L.id)) s.backdrop = "all";
  const save = () => storage.saveSoon("liquify", () => s);
  const field = new LiquifyField(fw, fh);
  // As in PS, only the selection can change: everything else starts frozen.
  if (doc.selection) {
    const sel = doc.selection;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const lx = Math.min(W - 1, Math.floor((x + 0.5) / scale)), ly = Math.min(H - 1, Math.floor((y + 0.5) / scale));
        field.freeze[y * fw + x] = 1 - sel.get(lx + L.offsetX, ly + L.offsetY) / 255;
      }
  }
  const shadow = field.snapshot();
  const undo: { r: { x0: number; y0: number; x1: number; y1: number }; dx: Float32Array; dy: Float32Array; fr: Float32Array }[] = [];
  const redo: typeof undo = [];

  // ---------- layout ----------
  const toolbar = el("div", { class: "lq-tools", role: "toolbar", "aria-label": "Liquify tools" });
  const canvas = el("canvas", { class: "lq-gl" });
  const overlay = el("canvas", { class: "lq-overlay" });
  const stage = el("div", { class: "lq-stage", tabindex: "0" }, canvas, overlay);
  const panel = el("div", { class: "lq-panel" });
  const okBtn = el("button", { type: "button", class: "btn default", text: "OK" });
  const cancelBtn = el("button", { type: "button", class: "btn", text: "Cancel" });
  const loadBtn = el("button", { type: "button", class: "btn", text: "Load Mesh..." });
  const saveBtn = el("button", { type: "button", class: "btn", text: "Save Mesh..." });
  const status = el("span", { class: "lq-status" });
  const footer = el("div", { class: "lq-footer" }, loadBtn, saveBtn, status, el("span", { style: "flex:1" }), cancelBtn, okBtn);
  const body = el("div", { class: "lq-body" }, toolbar, stage, panel);

  let preview: Preview;
  try {
    preview = new Preview(canvas, fw, fh);
  } catch (e) {
    return app.toast(`Liquify needs WebGL2: ${(e as Error).message}`);
  }
  const srcPx = shrink(L.grid.readRegion({ x: 0, y: 0, w: W, h: H }), W, H, fw, fh);
  preview.uploadRGBA("src", srcPx);
  preview.uploadField(field, null, { x0: 0, y0: 0, x1: fw, y1: fh });

  // Backdrop: everything except this layer (or one chosen layer), at field size.
  const backdropFor = (which: string): Uint8ClampedArray => {
    const r = { x: L.offsetX, y: L.offsetY, w: W, h: H };
    let px: Uint8ClampedArray;
    if (which === "all") {
      const was = L.visible;
      L.visible = false;
      try {
        px = compositeNodes(doc.stack, r);
      } finally {
        L.visible = was;
      }
    } else {
      const other = doc.layerById(+which);
      px = other ? other.grid.readRegion({ x: r.x - other.offsetX, y: r.y - other.offsetY, w: W, h: H }) : new Uint8ClampedArray(W * H * 4);
    }
    return shrink(px, W, H, fw, fh);
  };
  let backdropKey = "";
  const syncBackdrop = () => {
    if (!s.showBackdrop || backdropKey === s.backdrop) return;
    backdropKey = s.backdrop;
    preview.uploadRGBA("back", backdropFor(s.backdrop));
  };

  // Face-Aware Liquify adds its own displacement on top of the brushes.
  const face = new FacePanel(
    app,
    srcPx,
    fw,
    fh,
    () => {
      faceDirty = true;
      requestDraw();
    },
    { scale, ox: L.offsetX, oy: L.offsetY },
  );

  // ---------- view ----------
  const view = { zoom: 1, x: 0, y: 0 };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const z = Math.min((r.width - 24) / fw, (r.height - 24) / fh);
    view.zoom = Math.max(0.05, z);
    view.x = (r.width - fw * view.zoom) / 2;
    view.y = (r.height - fh * view.zoom) / 2;
    requestDraw();
  };
  const css = getComputedStyle(document.documentElement);
  const pasteHex = (css.getPropertyValue("--workspace").trim() || "#2a2b30").replace("#", "");
  const paste = pasteHex.length === 6 ? [0, 2, 4].map((i) => parseInt(pasteHex.slice(i, i + 2), 16) / 255) : [0.16, 0.17, 0.19];
  let pointer: { x: number; y: number } | null = null;
  let faceDirty = false;
  let raf = 0;
  const requestDraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const d = field.takeDirty();
      if (faceDirty) {
        // Face sliders change the whole field: upload it once per frame.
        faceDirty = false;
        preview.uploadField(field, face.active ? face.field() : null, { x0: 0, y0: 0, x1: fw, y1: fh });
      } else if (d) preview.uploadField(field, face.active ? face.field() : null, d);
      syncBackdrop();
      preview.draw(view, s, paste);
      drawOverlay();
    });
  };
  const octx = overlay.getContext("2d")!;
  const drawOverlay = () => {
    const dpr = window.devicePixelRatio || 1;
    const Wc = Math.round(overlay.clientWidth * dpr), Hc = Math.round(overlay.clientHeight * dpr);
    if (overlay.width !== Wc || overlay.height !== Hc) {
      overlay.width = Wc;
      overlay.height = Hc;
    }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, Wc, Hc);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    face.drawOverlay(octx, view, s.tool === "face");
    if (pointer && s.tool !== "hand" && s.tool !== "zoom" && s.tool !== "face") {
      const r = s.size * scale * view.zoom;
      octx.lineWidth = 1;
      octx.strokeStyle = "rgba(0,0,0,0.8)";
      octx.beginPath();
      octx.arc(pointer.x, pointer.y, r, 0, Math.PI * 2);
      octx.stroke();
      octx.strokeStyle = "rgba(255,255,255,0.9)";
      octx.beginPath();
      octx.arc(pointer.x, pointer.y, r + 1, 0, Math.PI * 2);
      octx.stroke();
    }
  };

  // ---------- tools ----------
  const toolBtns = new Map<string, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = el("button", { type: "button", class: "lq-tool", title: `${t.label} (${t.key})`, "aria-label": t.label });
    b.innerHTML = t.icon;
    b.addEventListener("click", () => setTool(t.id));
    toolBtns.set(t.id, b);
    toolbar.append(b);
  }
  const setTool = (id: ToolDef["id"]) => {
    s.tool = id;
    toolBtns.forEach((b, k) => b.classList.toggle("on", k === id));
    stage.style.cursor = id === "hand" ? "grab" : id === "zoom" ? "zoom-in" : id === "face" ? "default" : "none";
    face.setToolActive(id === "face");
    save();
    renderPanel();
    requestDraw();
  };

  // ---------- panel ----------
  const section = (title: string, ...kids: (HTMLElement | null)[]) => el("details", { class: "lq-sec", open: true }, el("summary", { text: title }), ...kids);
  const slider = (label: string, key: "size" | "density" | "pressure" | "rate" | "jitter", min: number, max: number) => {
    const r = el("input", { type: "range", min, max, value: s[key], "aria-label": label });
    const n = el("input", { type: "number", min, max, value: s[key], "aria-label": label + " value" });
    const set = (v: number) => {
      s[key] = Math.max(min, Math.min(max, Math.round(v)));
      r.value = n.value = String(s[key]);
      save();
      requestDraw();
    };
    r.addEventListener("input", () => set(+r.value));
    n.addEventListener("change", () => set(+n.value));
    return { row: el("div", { class: "lq-row" }, el("label", { text: label }), r, n), set };
  };
  const check = (label: string, key: "stylus" | "showImage" | "showMesh" | "showMask" | "showBackdrop") => {
    const c = el("input", { type: "checkbox", checked: s[key] });
    c.addEventListener("change", () => {
      s[key] = c.checked;
      save();
      if (key === "showBackdrop") backdropKey = "";
      requestDraw();
    });
    return el("label", { class: "lq-check" }, c, label);
  };
  const select = <K extends "mode" | "backdrop" | "backdropMode">(label: string, key: K, opts: [string, string][], onChange?: () => void) => {
    const sl = el("select", { "aria-label": label });
    for (const [v, t] of opts) sl.append(el("option", { value: v, text: t }));
    sl.value = String(s[key]);
    sl.addEventListener("change", () => {
      (s as unknown as Record<string, string>)[key] = sl.value;
      save();
      onChange?.();
      requestDraw();
    });
    return el("div", { class: "lq-row" }, el("label", { text: label }), sl);
  };
  const colorIn = (key: "meshColor" | "maskColor") => {
    const c = el("input", { type: "color", value: s[key], "aria-label": key === "meshColor" ? "Mesh color" : "Mask color" });
    c.addEventListener("input", () => {
      s[key] = c.value;
      save();
      requestDraw();
    });
    return c;
  };
  const btn = (text: string, fn: () => void, title = "") => {
    const b = el("button", { type: "button", class: "btn small", text, title });
    b.addEventListener("click", fn);
    return b;
  };
  let sizeSlider: ReturnType<typeof slider>;
  const reconAmount = el("input", { type: "range", min: 0, max: 100, value: 100, "aria-label": "Reconstruct amount" });

  function renderPanel(): void {
    panel.textContent = "";
    sizeSlider = slider("Brush Size", "size", 1, 1500);
    const toolOpts = section(
      "Tool Options",
      sizeSlider.row,
      slider("Brush Density", "density", 0, 100).row,
      slider("Brush Pressure", "pressure", 1, 100).row,
      slider("Brush Rate", "rate", 0, 100).row,
      s.tool === "turbulence" ? slider("Turbulent Jitter", "jitter", 1, 100).row : null,
      s.tool === "reconstruct" ? select("Reconstruct Mode", "mode", MODES) : null,
      check("Stylus Pressure", "stylus"),
    );
    const recon = section(
      "Reconstruct Options",
      select("Mode", "mode", MODES),
      el("div", { class: "lq-row" }, el("label", { text: "Amount" }), reconAmount),
      el("div", { class: "lq-btns" }, btn("Reconstruct", () => step(() => reconstructAll(field, s.mode, +reconAmount.value / 100)), "Pull the whole image back by the amount, using the mode"), btn("Restore All", () => step(() => {
        field.dx.fill(0);
        field.dy.fill(0);
        field.markDirty(0, 0, fw, fh);
      }), "Remove every distortion (frozen areas too)")),
    );
    const maskOps = section(
      "Mask Options",
      el("div", { class: "lq-row" }, el("label", { text: "From" }), maskSource),
      el("div", { class: "lq-btns lq-maskops" }, ...MASK_OPS.map(([op, label]) => btn(label, () => maskFrom(op), `${label} the freeze mask with the source`))),
      el("div", { class: "lq-btns" }, btn("None", () => maskAll(0), "Thaw everything"), btn("Mask All", () => maskAll(1), "Freeze everything"), btn("Invert All", () => maskAll(-1), "Swap frozen and thawed")),
    );
    const layers = doc!.layers.filter((x) => x !== L).reverse();
    const viewOpts = section(
      "View Options",
      check("Show Image", "showImage"),
      el("div", { class: "lq-row" }, check("Show Mesh", "showMesh"), meshSizeSel, colorIn("meshColor")),
      el("div", { class: "lq-row" }, check("Show Mask", "showMask"), colorIn("maskColor")),
      check("Show Backdrop", "showBackdrop"),
      select("Use", "backdrop", [["all", "All Layers"], ...layers.map((x): [string, string] => [String(x.id), x.name])], () => (backdropKey = "")),
      select("Mode", "backdropMode", [["front", "In Front"], ["behind", "Behind"], ["blend", "Blend"]]),
      (() => {
        const r = el("input", { type: "range", min: 0, max: 100, value: s.backdropOpacity, "aria-label": "Backdrop opacity" });
        r.addEventListener("input", () => {
          s.backdropOpacity = +r.value;
          save();
          requestDraw();
        });
        return el("div", { class: "lq-row" }, el("label", { text: "Opacity" }), r);
      })(),
    );
    panel.append(toolOpts, face.section(), recon, maskOps, viewOpts);
  }
  const MODES: [string, string][] = [["revert", "Revert"], ["rigid", "Rigid"], ["stiff", "Stiff"], ["smooth", "Smooth"], ["loose", "Loose"]];
  const MASK_OPS: [string, string][] = [["replace", "Replace"], ["add", "Add"], ["subtract", "Subtract"], ["intersect", "Intersect"], ["invert", "Invert"]];
  const meshSizeSel = el("select", { "aria-label": "Mesh size" });
  for (const [v, t] of [["16", "Small"], ["32", "Medium"], ["64", "Large"]]) meshSizeSel.append(el("option", { value: v, text: t }));
  meshSizeSel.value = String(s.meshSize);
  meshSizeSel.addEventListener("change", () => {
    s.meshSize = +meshSizeSel.value;
    save();
    requestDraw();
  });
  const maskSource = el("select", { "aria-label": "Mask source" });
  maskSource.append(el("option", { value: "selection", text: "Selection" }), el("option", { value: "transparency", text: "Transparency" }));
  if (L.mask) maskSource.append(el("option", { value: "mask", text: "Layer Mask" }));
  if (!doc.selection) maskSource.value = "transparency";

  /** Read a freeze source at field size (0..1). */
  const sourceMask = (): Float32Array | null => {
    const out = new Float32Array(fw * fh);
    const at = (fx: number, fy: number) => [Math.min(W - 1, Math.floor((fx + 0.5) / scale)), Math.min(H - 1, Math.floor((fy + 0.5) / scale))];
    if (maskSource.value === "selection") {
      const sel = doc.selection;
      if (!sel) {
        app.toast("There is no selection.");
        return null;
      }
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw; x++) {
          const [lx, ly] = at(x, y);
          out[y * fw + x] = sel.get(lx + L.offsetX, ly + L.offsetY) / 255;
        }
    } else if (maskSource.value === "mask" && L.mask) {
      for (let y = 0; y < fh; y++)
        for (let x = 0; x < fw; x++) {
          const [lx, ly] = at(x, y);
          out[y * fw + x] = L.mask.get(lx, ly) / 255;
        }
    } else for (let i = 0; i < out.length; i++) out[i] = srcPx[i * 4 + 3] / 255;
    return out;
  };
  const maskFrom = (op: string) => {
    const m = sourceMask();
    if (!m) return;
    step(() => {
      const f = field.freeze;
      for (let i = 0; i < f.length; i++) {
        const v = m[i];
        f[i] = op === "replace" ? v : op === "add" ? Math.max(f[i], v) : op === "subtract" ? Math.min(f[i], 1 - v) : op === "intersect" ? Math.min(f[i], v) : Math.abs(f[i] - v);
      }
      field.markDirty(0, 0, fw, fh);
    });
  };
  const maskAll = (v: number) =>
    step(() => {
      const f = field.freeze;
      for (let i = 0; i < f.length; i++) f[i] = v < 0 ? 1 - f[i] : v;
      field.markDirty(0, 0, fw, fh);
    });

  // ---------- undo ----------
  let strokeRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  const grow = (r: { x0: number; y0: number; x1: number; y1: number } | null, x0: number, y0: number, x1: number, y1: number) =>
    r ? { x0: Math.min(r.x0, x0), y0: Math.min(r.y0, y0), x1: Math.max(r.x1, x1), y1: Math.max(r.y1, y1) } : { x0, y0, x1, y1 };
  const region = (src: { dx: Float32Array; dy: Float32Array; freeze: Float32Array }, r: { x0: number; y0: number; x1: number; y1: number }) => {
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const dx = new Float32Array(w * h), dy = new Float32Array(w * h), fr = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const a = (y + r.y0) * fw + r.x0;
      dx.set(src.dx.subarray(a, a + w), y * w);
      dy.set(src.dy.subarray(a, a + w), y * w);
      fr.set(src.freeze.subarray(a, a + w), y * w);
    }
    return { r, dx, dy, fr };
  };
  const put = (dst: { dx: Float32Array; dy: Float32Array; freeze: Float32Array }, e: (typeof undo)[number]) => {
    const w = e.r.x1 - e.r.x0, h = e.r.y1 - e.r.y0;
    for (let y = 0; y < h; y++) {
      const a = (y + e.r.y0) * fw + e.r.x0;
      dst.dx.set(e.dx.subarray(y * w, y * w + w), a);
      dst.dy.set(e.dy.subarray(y * w, y * w + w), a);
      dst.freeze.set(e.fr.subarray(y * w, y * w + w), a);
    }
  };
  /** Finish an edit covering r: remember the previous state for undo. */
  const commitEdit = (r: { x0: number; y0: number; x1: number; y1: number }) => {
    const rr = { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(fw, Math.ceil(r.x1)), y1: Math.min(fh, Math.ceil(r.y1)) };
    if (rr.x1 <= rr.x0 || rr.y1 <= rr.y0) return;
    undo.push(region(shadow, rr));
    // Keep at most 40 steps and about 256 MB of them (whole-image steps are big).
    const bytes = () => undo.reduce((n, e) => n + e.dx.length * 12, 0);
    while (undo.length > 40 || (undo.length > 1 && bytes() > 256e6)) undo.shift();
    redo.length = 0;
    put(shadow, region(field, rr));
    updateStatus();
  };
  /** A whole-image operation as one undo step. */
  const step = (fn: () => void) => {
    fn();
    commitEdit({ x0: 0, y0: 0, x1: fw, y1: fh });
    requestDraw();
  };
  const undoRedo = (from: typeof undo, to: typeof undo) => {
    const e = from.pop();
    if (!e) return;
    to.push(region(field, e.r));
    put(field, e);
    put(shadow, e);
    field.markDirty(e.r.x0, e.r.y0, e.r.x1, e.r.y1);
    updateStatus();
    requestDraw();
  };
  const updateStatus = () => {
    status.textContent = `${fw} × ${fh} preview${k < 1 ? ` (${Math.round(k * 100)}%)` : ""} · ${undo.length} step${undo.length === 1 ? "" : "s"}`;
  };

  // ---------- painting ----------
  const toField = (e: PointerEvent | MouseEvent) => {
    const r = stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom };
  };
  const brush = (pressure: number): Brush => ({
    radius: Math.max(1, s.size * scale * (s.stylus ? 0.5 + pressure * 0.5 : 1)),
    density: s.density / 100,
    pressure: (s.pressure / 100) * (s.stylus ? pressure : 1),
    rate: s.rate / 100,
    jitter: s.jitter / 100,
    mode: s.mode,
  });
  let drag: { x: number; y: number; sx: number; sy: number; alt: boolean; pressure: number; pan?: { vx: number; vy: number } } | null = null;
  let timer = 0;
  let seed = 1;
  const dabAt = (x: number, y: number, dir: [number, number], alt: boolean, pressure: number) => {
    const tool = s.tool as LiquifyTool;
    const b = brush(pressure);
    applyDab(field, tool, x, y, dir, b, alt, seed);
    strokeRect = grow(strokeRect, x - b.radius - 2, y - b.radius - 2, x + b.radius + 2, y + b.radius + 2);
    requestDraw();
  };
  stage.addEventListener("pointerdown", (e) => {
    if (e.button > 1 || drag) return;
    stage.focus();
    stage.setPointerCapture(e.pointerId);
    const p = toField(e);
    const hand = s.tool === "hand" || e.button === 1 || spaceHeld;
    if (s.tool === "zoom" && !hand) {
      zoomAt(p.sx, p.sy, e.altKey ? 1 / 1.5 : 1.5);
      return;
    }
    if (s.tool === "face" && !hand) {
      face.pointerDown(p.x, p.y, e);
      drag = { x: p.x, y: p.y, sx: p.sx, sy: p.sy, alt: e.altKey, pressure: 1 };
      return;
    }
    drag = { x: p.x, y: p.y, sx: p.sx, sy: p.sy, alt: e.altKey, pressure: e.pointerType === "pen" ? e.pressure || 0.5 : 1, pan: hand ? { vx: view.x, vy: view.y } : undefined };
    if (hand) {
      stage.style.cursor = "grabbing";
      return;
    }
    seed = (seed * 16807) % 2147483647;
    strokeRect = null;
    const tool = s.tool as LiquifyTool;
    if (STATIONARY.has(tool) || tool === "freeze" || tool === "thaw") dabAt(p.x, p.y, [0, 0], drag.alt, drag.pressure);
    if (STATIONARY.has(tool)) {
      // Stationary tools keep working while the button is held.
      const tick = () => {
        if (!drag) return;
        const t0 = performance.now();
        dabAt(drag.x, drag.y, [0, 0], drag.alt, drag.pressure);
        // Leave time for input and drawing even when a huge brush is slow.
        timer = window.setTimeout(tick, Math.max(40, (performance.now() - t0) * 1.5));
      };
      timer = window.setTimeout(tick, 40);
    }
  });
  stage.addEventListener("pointermove", (e) => {
    const p = toField(e);
    pointer = { x: p.sx, y: p.sy };
    if (!drag) {
      if (s.tool === "face") face.hover(p.x, p.y, stage);
      requestDraw();
      return;
    }
    if (drag.pan) {
      view.x = drag.pan.vx + (p.sx - drag.sx);
      view.y = drag.pan.vy + (p.sy - drag.sy);
      requestDraw();
      return;
    }
    if (s.tool === "face") {
      face.pointerMove(p.x, p.y);
      return;
    }
    const pressure = e.pointerType === "pen" ? e.pressure || 0.5 : 1;
    drag.pressure = pressure;
    const tool = s.tool as LiquifyTool;
    const dx = p.x - drag.x, dy = p.y - drag.y;
    const dist = Math.hypot(dx, dy);
    if (STATIONARY.has(tool)) {
      drag.x = p.x;
      drag.y = p.y;
      return;
    }
    // Dabs along the path, spaced a fraction of the brush apart.
    const b = brush(pressure);
    const stepLen = Math.max(1, b.radius * 0.15);
    const n = Math.min(8, Math.max(1, Math.ceil(dist / stepLen)));
    for (let i = 1; i <= n; i++) {
      const x = drag.x + (dx * i) / n, y = drag.y + (dy * i) / n;
      dabAt(x, y, [dx / n, dy / n], drag.alt, pressure);
    }
    drag.x = p.x;
    drag.y = p.y;
  });
  const end = () => {
    clearTimeout(timer);
    if (!drag) return;
    const wasPan = !!drag.pan;
    drag = null;
    if (s.tool === "face") {
      face.pointerUp();
      return;
    }
    if (wasPan) {
      stage.style.cursor = s.tool === "hand" ? "grab" : s.tool === "zoom" ? "zoom-in" : "none";
      return;
    }
    if (strokeRect) commitEdit(strokeRect);
    strokeRect = null;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("pointerleave", () => {
    pointer = null;
    requestDraw();
  });
  const zoomAt = (sx: number, sy: number, f: number) => {
    const z = Math.max(0.05, Math.min(16, view.zoom * f));
    view.x = sx - ((sx - view.x) / view.zoom) * z;
    view.y = sy - ((sy - view.y) / view.zoom) * z;
    view.zoom = z;
    requestDraw();
  };
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      if (e.ctrlKey || e.altKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      else {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
        requestDraw();
      }
    },
    { passive: false },
  );

  // ---------- keys ----------
  let spaceHeld = false;
  const onKey = (e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement;
    if (t.closest("input, select, textarea") && !(t instanceof HTMLInputElement && (t.type === "range" || t.type === "checkbox"))) return false;
    if (e.type === "keyup") {
      if (e.code === "Space") spaceHeld = false;
      return false;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === "Space") {
      spaceHeld = true;
      e.preventDefault();
      return true;
    }
    if (ctrl && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) undoRedo(redo, undo);
      else if (e.altKey || undo.length) undoRedo(undo, redo);
      return true;
    }
    if (ctrl && (e.key === "=" || e.key === "+")) return zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.5), true;
    if (ctrl && e.key === "-") return zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.5), true;
    if (ctrl && e.key === "0") return fit(), true;
    if (e.key === "[" || e.key === "]") {
      const f = e.key === "]" ? 1.15 : 1 / 1.15;
      sizeSlider.set(Math.max(1, Math.round(s.size * f + (e.key === "]" ? 1 : -1))));
      requestDraw();
      return true;
    }
    if (!ctrl && !e.altKey && e.key.length === 1) {
      const t2 = TOOLS.find((x) => x.key === e.key.toUpperCase());
      if (t2) {
        setTool(t2.id);
        return true;
      }
    }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      okBtn.click();
      return true;
    }
    return false;
  };
  const keyup = (e: KeyboardEvent) => onKey(e);
  document.addEventListener("keyup", keyup, true);

  // ---------- files ----------
  saveBtn.addEventListener("click", async () => {
    const { saveText } = await import("../io/files");
    const m = encodeMesh(field.dx, field.dy, fw, fh);
    await saveText(JSON.stringify({ format: "classic-image-editor-liquify-mesh", version: 1, mesh: m }), "liquify-mesh.json");
  });
  loadBtn.addEventListener("click", async () => {
    const { pickText } = await import("../io/files");
    const t = await pickText([".json"]);
    if (!t) return;
    try {
      const d = JSON.parse(t);
      if (d.format !== "classic-image-editor-liquify-mesh" || !d.mesh) throw new Error("This is not a Liquify mesh file.");
      const m = decodeMesh(d.mesh as EncodedMesh);
      const r = d.mesh.w === fw && d.mesh.h === fh ? m : resampleField(m.dx, m.dy, d.mesh.w, d.mesh.h, fw, fh);
      step(() => {
        field.dx.set(r.dx);
        field.dy.set(r.dy);
        field.markDirty(0, 0, fw, fh);
      });
    } catch (e) {
      app.toast((e as Error).message);
    }
  });

  // ---------- open ----------
  const dlg = sheet(`Liquify (${L.name})`, el("div", { class: "lq" }, body, footer), {
    className: "lq-dialog",
    onKey: (e) => onKey(e),
  });
  cancelBtn.addEventListener("click", () => dlg.close("cancel"));
  okBtn.addEventListener("click", () => dlg.close("ok"));
  setTool(s.tool);
  updateStatus();
  const ro = new ResizeObserver(() => requestDraw());
  ro.observe(stage);
  requestAnimationFrame(fit);
  stage.focus();

  const result = await dlg.done;
  ro.disconnect();
  document.removeEventListener("keyup", keyup, true);
  clearTimeout(timer);
  if (raf) cancelAnimationFrame(raf);
  if (result === "ok") {
    // Brushes plus face adjustments, at the preview's resolution; the command scales it to the layer.
    const extra = face.active ? face.field() : null;
    let dx = field.dx, dy = field.dy;
    if (extra) {
      dx = dx.slice();
      dy = dy.slice();
      for (let i = 0; i < dx.length; i++) {
        dx[i] += extra.dx[i];
        dy[i] += extra.dy[i];
      }
    }
    const mesh = encodeMesh(dx, dy, fw, fh);
    if (mesh.tiles.length) {
      const big = W * H > 4e6;
      const pill = big ? busyPill("Applying Liquify...") : null;
      if (pill) await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        app.run("image.liquify", { id: L.id, mesh });
      } finally {
        pill?.done();
      }
    }
  }
  face.dispose();
  preview.dispose();
}
