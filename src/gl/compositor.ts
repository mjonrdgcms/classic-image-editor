/**
 * WebGL2 compositor.
 *
 * The canvas is composited tile by tile into one canvas-sized texture. Only
 * tiles marked dirty are rebuilt. For each one we walk the layer tree the
 * same way the CPU reference (src/core/composite.ts) does:
 *
 *   - each layer's source is assembled into a 256x256 buffer (its pixels
 *     with the layer mask multiplied into alpha), then blended onto the
 *     backdrop buffer with its mode and opacity, optionally clipped by the
 *     alpha of its clipping base;
 *   - an isolated layer set is built in its own buffer pair and blended on
 *     as a unit; a Pass Through set draws straight onto the backdrop and,
 *     below 100% opacity, is faded against a saved copy of the backdrop.
 *
 * The display pass samples the finished texture with the current zoom and
 * pan, so panning and zooming never re-blend layers.
 */

import { blendIndex } from "../core/blend";
import type { Document, Group, Layer } from "../core/document";
import type { Mask, MaskTile } from "../core/mask";
import { Rect, TILE, Tile } from "../core/tiles";
import { effectTiles, layerEffects, type LayerEffects } from "../core/styles";
import { ASSEMBLE_FS, BLEND_FS, DISPLAY_FS, FADE_FS, FULLSCREEN_VS, MASKMUL_FS } from "./shaders";

export interface View {
  /** Canvas pixels to CSS pixels. */
  zoom: number;
  /** CSS px position of the canvas's top-left inside the viewport. */
  x: number;
  y: number;
}

export interface Theme {
  pasteboard: [number, number, number];
  checkA: [number, number, number];
  checkB: [number, number, number];
}

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Buf {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/** A ping-pong pair; `cur` holds the result so far. */
class Pair {
  i = 0;
  constructor(readonly a: Buf, readonly b: Buf) {}
  get cur(): Buf {
    return this.i ? this.b : this.a;
  }
  get next(): Buf {
    return this.i ? this.a : this.b;
  }
  swap(): void {
    this.i ^= 1;
  }
}

export class Compositor {
  readonly gl: WebGL2RenderingContext;
  private blend: Prog;
  private assemble: Prog;
  private fade: Prog;
  private maskmul: Prog;
  /** Viewing the active layer's (or set's) mask: as a tinted overlay or in grayscale. */
  maskView: { mode: "off" | "overlay" | "gray"; color: [number, number, number]; opacity: number } = { mode: "off", color: [1, 0, 0], opacity: 0.5 };
  private overlayKey = "";
  private display: Prog;
  private main: Pair;
  private group: Pair;
  private save: Buf;
  private src: Buf;
  private clip: Buf;
  private composite: WebGLTexture | null = null;
  private compositeFbo: WebGLFramebuffer | null = null;
  private tileTex = new Map<Tile, { tex: WebGLTexture; version: number }>();
  private maskTex = new Map<MaskTile, { tex: WebGLTexture; version: number }>();
  private selTex: WebGLTexture | null = null;
  private selVersions: number[] = [];
  private selDirty = true;
  private dirty = new Set<number>();
  private cols = 0;
  private rows = 0;
  private mipsDirty = true;
  private doc: Document | null = null;
  private frameRequested = false;
  readonly maxTextureSize: number;
  view: View = { zoom: 1, x: 0, y: 0 };
  theme: Theme = { pasteboard: [0.5, 0.5, 0.5], checkA: [1, 1, 1], checkB: [0.8, 0.8, 0.8] };
  /** Called after each rendered frame (overlays). */
  readonly frameListeners = new Set<() => void>();
  /** Called after canvas tiles were re-composited (Navigator, thumbnails). */
  readonly compositeListeners = new Set<() => void>();
  stats = { lastCompositeMs: 0, lastTiles: 0, frames: 0 };

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available on this system.");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.blend = this.program(BLEND_FS, ["uBackdrop", "uSource", "uClip", "uUseClip", "uTileOrigin", "uMode", "uOpacity"]);
    this.assemble = this.program(ASSEMBLE_FS, ["uTile", "uMaskTex", "uMaskMode", "uMaskValue", "uTileOrigin", "uSourceOrigin", "uGMaskTex", "uGMaskMode", "uGMaskValue"]);
    this.maskmul = this.program(MASKMUL_FS, ["uSource", "uMaskTex", "uMaskMode", "uMaskValue"]);
    this.fade = this.program(FADE_FS, ["uSaved", "uCurrent", "uOpacity", "uMaskTex", "uMaskMode", "uMaskValue"]);
    this.display = this.program(DISPLAY_FS, [
      "uImage", "uDocSize", "uOffset", "uZoom", "uScreenH", "uPasteboard", "uCheckA", "uCheckB", "uCheckSize", "uSel", "uOverlay", "uOverlayColor", "uOverlayOpacity",
    ]);
    gl.bindVertexArray(gl.createVertexArray());
    const buf = (): Buf => {
      const tex = this.makeTexture(TILE, TILE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    };
    this.main = new Pair(buf(), buf());
    this.group = new Pair(buf(), buf());
    this.save = buf();
    this.src = buf();
    this.clip = buf();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---------------- setup ----------------

  private program(fs: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, FULLSCREEN_VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
    const u: Prog["u"] = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }

  private makeTexture(w: number, h: number, levels = 1, format?: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, format ?? gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Point the compositor at a document (on New / Open / canvas resize). */
  setDocument(doc: Document): void {
    const gl = this.gl;
    if (doc.width > this.maxTextureSize || doc.height > this.maxTextureSize) {
      throw new Error(`This GPU supports images up to ${this.maxTextureSize} px per side; tiled display for larger images is planned.`);
    }
    this.doc = doc;
    if (this.composite) gl.deleteTexture(this.composite);
    if (this.compositeFbo) gl.deleteFramebuffer(this.compositeFbo);
    if (this.selTex) gl.deleteTexture(this.selTex);
    const levels = Math.floor(Math.log2(Math.max(doc.width, doc.height))) + 1;
    this.composite = this.makeTexture(doc.width, doc.height, levels);
    this.compositeFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.compositeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.composite, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.selTex = this.makeTexture(doc.width, doc.height, 1, gl.R8);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    this.selVersions = [];
    this.selDirty = true;
    this.cols = Math.ceil(doc.width / TILE);
    this.rows = Math.ceil(doc.height / TILE);
    this.markDirty(null);
  }

  /** Stop showing a document (File > Close). */
  clear(): void {
    this.doc = null;
    this.dirty.clear();
    this.requestFrame();
  }

  // ---------------- invalidation ----------------

  markDirty(r: Rect | null): void {
    if (!r) {
      for (let i = 0; i < this.cols * this.rows; i++) this.dirty.add(i);
    } else {
      const tx0 = Math.max(0, Math.floor(r.x / TILE));
      const ty0 = Math.max(0, Math.floor(r.y / TILE));
      const tx1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / TILE));
      const ty1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / TILE));
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.dirty.add(ty * this.cols + tx);
    }
    this.requestFrame();
  }

  /** The selection changed (Quick Mask overlay needs re-upload). */
  markSelectionDirty(): void {
    this.selDirty = true;
    this.requestFrame();
  }

  requestFrame(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  // ---------------- textures for tiles ----------------

  private textureFor(t: Tile): WebGLTexture {
    const gl = this.gl;
    let e = this.tileTex.get(t);
    if (!e) {
      e = { tex: this.makeTexture(TILE, TILE), version: -1 };
      this.tileTex.set(t, e);
    }
    if (e.version !== t.version) {
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RGBA, gl.UNSIGNED_BYTE, t.data);
      e.version = t.version;
    }
    return e.tex;
  }

  private maskTextureFor(t: MaskTile): WebGLTexture {
    const gl = this.gl;
    let e = this.maskTex.get(t);
    if (!e) {
      e = { tex: this.makeTexture(TILE, TILE, 1, gl.R8), version: -1 };
      this.maskTex.set(t, e);
    }
    if (e.version !== t.version) {
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TILE, TILE, gl.RED, gl.UNSIGNED_BYTE, t.data);
      e.version = t.version;
    }
    return e.tex;
  }

  /** What the overlay shows right now. */
  private overlayMode(): number {
    const doc = this.doc;
    if (!doc) return 0;
    if (doc.quickMask) return 1;
    if (this.maskView.mode === "off" || !doc.activeNode?.mask) return 0;
    return this.maskView.mode === "gray" ? 2 : 1;
  }

  /** Upload the viewed layer/set mask into the overlay texture when it changed. */
  private syncMaskView(): void {
    const doc = this.doc;
    if (!doc || !this.selTex || doc.quickMask || this.maskView.mode === "off") return;
    const host = doc.activeNode;
    const m = host?.mask ? (host.activeMask ?? host.mask) : null;
    if (!host || !m) return;
    const key = `${host.id}:${m.key()}:${host.offsetX},${host.offsetY}:${doc.width}x${doc.height}`;
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const gl = this.gl;
    const data = m.readRegion({ x: -host.offsetX, y: -host.offsetY, w: doc.width, h: doc.height }, m.defaultValue);
    gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, doc.width, doc.height, gl.RED, gl.UNSIGNED_BYTE, data);
    // The Quick Mask path must re-upload everything next time.
    this.selVersions.fill(-0x7fffffff);
    this.selDirty = true;
  }

  /** Upload changed selection tiles into the canvas-sized R8 texture (Quick Mask). */
  private syncSelection(): void {
    const doc = this.doc;
    this.syncMaskView();
    if (!doc || !this.selTex || !this.selDirty) return;
    if (!doc.quickMask) return;
    this.selDirty = false;
    this.overlayKey = "";
    const gl = this.gl;
    const m: Mask | null = doc.selection;
    gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const zero = new Uint8Array(TILE * TILE);
    for (let i = 0; i < this.cols * this.rows; i++) {
      const t = m ? m.tiles[i] : null;
      const ver = t ? t.version : m ? -m.defaultValue - 1 : -1;
      if (this.selVersions[i] === ver) continue;
      this.selVersions[i] = ver;
      const tx = i % this.cols, ty = (i / this.cols) | 0;
      const w = Math.min(TILE, doc.width - tx * TILE), h = Math.min(TILE, doc.height - ty * TILE);
      let data = t ? t.data : m && m.defaultValue === 255 ? zero.fill(255) : zero.fill(0);
      if (w < TILE) {
        // Rows of a partial tile must be packed to its width.
        const packed = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) packed.set(data.subarray(y * TILE, y * TILE + w), y * w);
        data = packed;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, tx * TILE, ty * TILE, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    }
  }

  // ---------------- compositing ----------------

  private bindTarget(b: Buf): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    gl.viewport(0, 0, TILE, TILE);
  }

  private clearBuf(b: Buf): void {
    const gl = this.gl;
    this.bindTarget(b);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private copy(from: Buf, to: Buf): void {
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to.fbo);
    gl.blitFramebuffer(0, 0, TILE, TILE, 0, 0, TILE, TILE, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /**
   * Assemble a layer's masked pixels for the work tile at (ox, oy) into the
   * SRC buffer. Returns false if the layer has nothing there.
   */
  /** Bind a set's mask tile for the work tile at (ox, oy) to unit 3 (returns the mode). */
  private bindGroupMask(gm: Mask | null, ox: number, oy: number): { mode: number; value: number } {
    if (!gm) return { mode: 0, value: 1 };
    const t = gm.tiles[(oy / TILE) * gm.cols + ox / TILE];
    if (!t) return { mode: 2, value: gm.defaultValue / 255 };
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTextureFor(t));
    return { mode: 1, value: 1 };
  }

  private assembleLayer(l: Pick<Layer, "grid" | "offsetX" | "offsetY" | "activeMask">, ox: number, oy: number, w: number, h: number, gm: Mask | null = null): boolean {
    const gl = this.gl;
    const lx0 = ox - l.offsetX, ly0 = oy - l.offsetY;
    const ltx0 = Math.max(0, Math.floor(lx0 / TILE)), lty0 = Math.max(0, Math.floor(ly0 / TILE));
    const ltx1 = Math.min(l.grid.cols - 1, Math.floor((lx0 + w - 1) / TILE));
    const lty1 = Math.min(l.grid.rows - 1, Math.floor((ly0 + h - 1) / TILE));
    let drew = false;
    const mask = l.activeMask;
    for (let lty = lty0; lty <= lty1; lty++)
      for (let ltx = ltx0; ltx <= ltx1; ltx++) {
        const tile = l.grid.getTile(ltx, lty);
        if (!tile) continue;
        const cx0 = Math.max(ox, l.offsetX + ltx * TILE), cy0 = Math.max(oy, l.offsetY + lty * TILE);
        const cx1 = Math.min(ox + w, l.offsetX + ltx * TILE + TILE, l.offsetX + l.grid.width);
        const cy1 = Math.min(oy + h, l.offsetY + lty * TILE + TILE, l.offsetY + l.grid.height);
        if (cx1 <= cx0 || cy1 <= cy0) continue;
        if (!drew) {
          this.clearBuf(this.src);
          gl.useProgram(this.assemble.p);
          gl.uniform1i(this.assemble.u.uTile, 1);
          gl.uniform1i(this.assemble.u.uMaskTex, 2);
          gl.uniform2i(this.assemble.u.uTileOrigin, ox, oy);
          const g = this.bindGroupMask(gm, ox, oy);
          gl.uniform1i(this.assemble.u.uGMaskTex, 3);
          gl.uniform1i(this.assemble.u.uGMaskMode, g.mode);
          gl.uniform1f(this.assemble.u.uGMaskValue, g.value);
          gl.enable(gl.SCISSOR_TEST);
          drew = true;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.textureFor(tile));
        if (mask) {
          const mt = mask.tiles[lty * mask.cols + ltx];
          if (mt) {
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, this.maskTextureFor(mt));
            gl.uniform1i(this.assemble.u.uMaskMode, 1);
          } else {
            gl.uniform1i(this.assemble.u.uMaskMode, 2);
            gl.uniform1f(this.assemble.u.uMaskValue, mask.defaultValue / 255);
          }
        } else gl.uniform1i(this.assemble.u.uMaskMode, 0);
        gl.uniform2i(this.assemble.u.uSourceOrigin, l.offsetX + ltx * TILE, l.offsetY + lty * TILE);
        gl.scissor(cx0 - ox, cy0 - oy, cx1 - cx0, cy1 - cy0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    gl.disable(gl.SCISSOR_TEST);
    return drew;
  }

  /** Blend `source` (same 256 space) onto `target`'s current buffer. */
  private blendOnto(target: Pair, source: Buf, mode: number, opacity: number, ox: number, oy: number, useClip: boolean): void {
    const gl = this.gl;
    this.bindTarget(target.next);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.blend.p);
    gl.uniform1i(this.blend.u.uBackdrop, 0);
    gl.uniform1i(this.blend.u.uSource, 1);
    gl.uniform1i(this.blend.u.uClip, 2);
    gl.uniform1i(this.blend.u.uUseClip, useClip ? 1 : 0);
    gl.uniform2i(this.blend.u.uTileOrigin, ox, oy);
    gl.uniform1i(this.blend.u.uMode, mode);
    gl.uniform1f(this.blend.u.uOpacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.cur.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.clip.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    target.swap();
  }

  /** Mirror of composite.ts drawLayers: siblings with clipping. */
  private drawLayers(list: Layer[], target: Pair, ox: number, oy: number, w: number, h: number, gm: Mask | null = null): void {
    let hasBase = false;
    let baseOk = false;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      const clipped = l.clipped && hasBase;
      if (!clipped) {
        hasBase = true;
        baseOk = false;
      }
      if (!l.visible || l.opacity <= 0) continue;
      if (clipped && !baseOk) continue;
      const fx = l.style ? layerEffects(l) : null;
      if (fx)
        for (const f of fx.below)
          if (this.assembleLayer(f, ox, oy, w, h, gm)) this.blendOnto(target, this.src, blendIndex(f.blendMode), f.opacity * l.opacity, ox, oy, clipped);
      const has = this.assembleLayer(l, ox, oy, w, h, gm);
      if (!clipped) {
        baseOk = has;
        // Keep the base's alpha for any clipped layers that follow.
        if (has && list[i + 1]?.clipped) this.copy(this.src, this.clip);
      }
      if (has) this.blendOnto(target, this.src, blendIndex(l.blendMode), l.opacity, ox, oy, clipped);
      if (fx)
        for (const f of fx.above)
          if (this.assembleLayer(f, ox, oy, w, h, gm)) this.blendOnto(target, this.src, blendIndex(f.blendMode), f.opacity * l.opacity, ox, oy, clipped);
    }
  }

  /** Layers whose effects were last drawn, and where (to repaint when they change). */
  private fxSeen = new Map<Layer, LayerEffects | null>();

  /** Mark the areas of changed layer effects dirty. */
  private markEffectChanges(): void {
    const doc = this.doc!;
    const seen = new Map<Layer, LayerEffects | null>();
    for (const l of doc.layers) {
      const prev = this.fxSeen.get(l);
      const fx = l.style ? layerEffects(l) : null;
      if (fx || prev) seen.set(l, fx);
      if (fx === prev) continue;
      if (prev) this.markRect(prev.bounds);
      if (fx) this.markRect(fx.bounds);
    }
    for (const [l, fx] of this.fxSeen) if (!seen.has(l) && fx) this.markRect(fx.bounds);
    this.fxSeen = seen;
  }

  private markRect(r: Rect): void {
    const doc = this.doc!;
    const x0 = Math.max(0, Math.floor(r.x / TILE)), y0 = Math.max(0, Math.floor(r.y / TILE));
    const x1 = Math.min(this.cols - 1, Math.floor((r.x + r.w - 1) / TILE)), y1 = Math.min(this.rows - 1, Math.floor((r.y + r.h - 1) / TILE));
    if (r.x >= doc.width || r.y >= doc.height) return;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) this.dirty.add(ty * this.cols + tx);
  }

  private drawGroup(g: Group, ox: number, oy: number, w: number, h: number): void {
    if (!g.visible || g.opacity <= 0) return;
    const gl = this.gl;
    const gm = g.activeMask;
    if (g.blendMode === "passThrough") {
      // Pass Through: the set's opacity and mask fade its combined effect
      // (mix between the backdrop before and after its layers).
      const fadeIt = g.opacity < 1 || !!gm;
      if (fadeIt) this.copy(this.main.cur, this.save);
      this.drawLayers(g.children, this.main, ox, oy, w, h);
      if (fadeIt) {
        const bound = this.bindGroupMask(gm, ox, oy);
        this.bindTarget(this.main.next);
        gl.useProgram(this.fade.p);
        gl.uniform1i(this.fade.u.uSaved, 0);
        gl.uniform1i(this.fade.u.uCurrent, 1);
        gl.uniform1f(this.fade.u.uOpacity, g.opacity);
        gl.uniform1i(this.fade.u.uMaskTex, 3);
        gl.uniform1i(this.fade.u.uMaskMode, bound.mode);
        gl.uniform1f(this.fade.u.uMaskValue, bound.value);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.save.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.main.cur.tex);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.main.swap();
      }
      return;
    }
    this.clearBuf(this.group.cur);
    this.drawLayers(g.children, this.group, ox, oy, w, h);
    if (gm) {
      // Isolated set: mask the set's flattened result.
      const bound = this.bindGroupMask(gm, ox, oy);
      this.bindTarget(this.group.next);
      gl.disable(gl.SCISSOR_TEST);
      gl.useProgram(this.maskmul.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.group.cur.tex);
      gl.uniform1i(this.maskmul.u.uSource, 0);
      gl.uniform1i(this.maskmul.u.uMaskTex, 3);
      gl.uniform1i(this.maskmul.u.uMaskMode, bound.mode);
      gl.uniform1f(this.maskmul.u.uMaskValue, bound.value);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.group.swap();
    }
    this.blendOnto(this.main, this.group.cur, blendIndex(g.blendMode), g.opacity, ox, oy, false);
  }

  /** Rebuild all dirty canvas tiles. */
  private compositeDirty(): void {
    const doc = this.doc;
    if (!doc || this.dirty.size === 0) return;
    this.markEffectChanges();
    const gl = this.gl;
    const t0 = performance.now();
    gl.disable(gl.BLEND);
    for (const idx of this.dirty) {
      const tx = idx % this.cols;
      const ty = (idx / this.cols) | 0;
      const ox = tx * TILE;
      const oy = ty * TILE;
      const w = Math.min(TILE, doc.width - ox);
      const h = Math.min(TILE, doc.height - oy);
      this.clearBuf(this.main.cur);
      let run: Layer[] = [];
      for (const n of doc.stack) {
        if (n.kind === "layer") run.push(n);
        else {
          if (run.length) this.drawLayers(run, this.main, ox, oy, w, h);
          run = [];
          this.drawGroup(n, ox, oy, w, h);
        }
      }
      if (run.length) this.drawLayers(run, this.main, ox, oy, w, h);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.main.cur.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.compositeFbo);
      gl.blitFramebuffer(0, 0, w, h, ox, oy, ox + w, oy + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.stats.lastTiles = this.dirty.size;
    this.dirty.clear();
    this.mipsDirty = true;
    this.sweepTextures();
    this.stats.lastCompositeMs = performance.now() - t0;
    this.compositeListeners.forEach((fn) => fn());
  }

  /** Free GPU textures of tiles no longer in the document. */
  private sweepTextures(): void {
    if (!this.doc) return;
    // Pixels, painted masks and the effective (feathered / density) masks of layers and sets.
    const keep = new Set<Tile | MaskTile>();
    const addMask = (m: Mask | null) => {
      if (m) for (const t of m.tiles) if (t) keep.add(t);
    };
    for (const l of this.doc.layers) {
      for (const t of l.grid.tiles) if (t) keep.add(t);
      const fx = this.fxSeen.get(l);
      if (fx) for (const t of effectTiles(fx)) keep.add(t);
      addMask(l.mask);
      addMask(l.activeMask);
    }
    for (const g of this.doc.groups) {
      addMask(g.mask);
      addMask(g.activeMask);
    }
    if (this.tileTex.size + this.maskTex.size < keep.size * 1.5 + 64) return;
    for (const map of [this.tileTex, this.maskTex] as Map<Tile | MaskTile, { tex: WebGLTexture }>[])
      for (const [t, e] of map)
        if (!keep.has(t)) {
          this.gl.deleteTexture(e.tex);
          map.delete(t);
        }
  }

  // ---------------- display ----------------

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.requestFrame();
  }

  private useDisplay(zoom: number, offX: number, offY: number, screenH: number, checkSize: number): void {
    const gl = this.gl;
    const doc = this.doc!;
    const d = this.display;
    gl.useProgram(d.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.composite);
    if (zoom < 1) {
      if (this.mipsDirty) {
        gl.generateMipmap(gl.TEXTURE_2D);
        this.mipsDirty = false;
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      // At 100% and above show crisp pixels, as PS7 does.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    gl.uniform1i(d.u.uImage, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    gl.uniform1i(d.u.uSel, 1);
    const ov = this.overlayMode();
    gl.uniform1i(d.u.uOverlay, ov);
    if (doc.quickMask) {
      gl.uniform3f(d.u.uOverlayColor, 1, 0, 0);
      gl.uniform1f(d.u.uOverlayOpacity, 0.5);
    } else {
      gl.uniform3f(d.u.uOverlayColor, ...this.maskView.color);
      gl.uniform1f(d.u.uOverlayOpacity, this.maskView.opacity);
    }
    gl.uniform2f(d.u.uDocSize, doc.width, doc.height);
    gl.uniform2f(d.u.uOffset, offX, offY);
    gl.uniform1f(d.u.uZoom, zoom);
    gl.uniform1f(d.u.uScreenH, screenH);
    gl.uniform3f(d.u.uPasteboard, ...this.theme.pasteboard);
    gl.uniform3f(d.u.uCheckA, ...this.theme.checkA);
    gl.uniform3f(d.u.uCheckB, ...this.theme.checkB);
    gl.uniform1f(d.u.uCheckSize, checkSize);
  }

  /** Transparency checkerboard size in CSS px (Preferences). */
  checkSize = 8;

  render(): void {
    const gl = this.gl;
    const doc = this.doc;
    this.compositeDirty();
    this.syncSelection();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!doc || !this.composite) {
      gl.clearColor(...this.theme.pasteboard, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.frameListeners.forEach((fn) => fn());
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    this.useDisplay(this.view.zoom * dpr, Math.round(this.view.x * dpr), Math.round(this.view.y * dpr), this.canvas.height, this.checkSize * dpr);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.stats.frames++;
    this.frameListeners.forEach((fn) => fn());
  }

  private thumb: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number } | null = null;

  /** The whole image scaled to fit maxW x maxH over the checkerboard (Navigator). Top-down rows. */
  renderThumbnail(maxW: number, maxH: number): { data: Uint8Array; w: number; h: number } | null {
    const doc = this.doc;
    if (!doc || !this.composite) return null;
    const gl = this.gl;
    this.compositeDirty();
    this.syncSelection();
    const s = Math.min(maxW / doc.width, maxH / doc.height);
    const w = Math.max(1, Math.round(doc.width * s));
    const h = Math.max(1, Math.round(doc.height * s));
    if (!this.thumb || this.thumb.w !== w || this.thumb.h !== h) {
      if (this.thumb) {
        gl.deleteTexture(this.thumb.tex);
        gl.deleteFramebuffer(this.thumb.fbo);
      }
      const tex = this.makeTexture(w, h);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.thumb = { tex, fbo, w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.thumb.fbo);
    gl.viewport(0, 0, w, h);
    this.useDisplay(Math.min(0.999, w / doc.width), 0, 0, h, 4);
    gl.uniform1f(this.display.u.uZoom, w / doc.width);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const raw = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    this.requestFrame();
    return { data, w, h };
  }

  /** Read composited pixels (straight RGBA) from the GPU, compositing first if needed. */
  readPixels(r: Rect): Uint8Array {
    const gl = this.gl;
    this.compositeDirty();
    const out = new Uint8Array(r.w * r.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.compositeFbo);
    gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
}
