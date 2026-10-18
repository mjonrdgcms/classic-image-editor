/**
 * Draws a type layer's text with a 2D canvas: point text (lines from the
 * anchor) or paragraph text (wrapped and clipped to its box), with
 * tracking, leading, scaling, baseline shift, faux styles, underline /
 * strikethrough and PS7's anti-aliasing choices.
 */

import { ValidationError } from "../core/commands";
import type { TextBitmap, TextSpec } from "../core/text";
import { cssFont, nearestWeight } from "./fonts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { ctx: Ctx } {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(w, h);
    return { ctx: c.getContext("2d", { willReadFrequently: true })! };
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { ctx: c.getContext("2d", { willReadFrequently: true })! };
}

const MAX_SIDE = 16384;
/** 64 megapixels (256 MB of RGBA) at most. */
const MAX_AREA = 64 * 1024 * 1024;

interface Line {
  text: string;
  /** Words to space out for justified lines (null = draw as one run). */
  words: string[] | null;
  width: number;
}

export function renderText(t: TextSpec): TextBitmap {
  const content = t.allCaps ? t.content.toUpperCase() : t.content;
  const weight = nearestWeight(t.font, t.weight, t.italic);
  const font = cssFont(t.font, weight, t.italic, t.size);
  const sx = t.hScale / 100, sy = t.vScale / 100;
  const track = (t.tracking / 1000) * t.size;
  const leading = t.leading > 0 ? t.leading : t.size * 1.2;

  const { ctx: m } = makeCanvas(8, 8);
  m.font = font;
  const hasLS = "letterSpacing" in (m as object);
  if (hasLS) (m as unknown as { letterSpacing: string }).letterSpacing = `${track}px`;
  // Width of a run in layer pixels (tracking after every character, like CSS).
  const measure = (s: string): number => {
    if (!s) return 0;
    if (hasLS || !track) return m.measureText(s).width * sx;
    return (m.measureText(s).width + track * [...s].length) * sx;
  };
  const probe = m.measureText("HgÅjy");
  const ascent = (probe.fontBoundingBoxAscent ?? t.size * 0.9) * sy;
  const descent = (probe.fontBoundingBoxDescent ?? t.size * 0.25) * sy;

  // ---- lay out lines ----
  const lines: Line[] = [];
  const box = t.box;
  for (const para of content.split("\n")) {
    if (!box) {
      lines.push({ text: para, words: null, width: measure(para) });
      continue;
    }
    const maxW = box.w;
    const words = para.split(/ +/);
    let cur: string[] = [];
    const flush = (last: boolean) => {
      const text = cur.join(" ");
      lines.push({ text, words: t.align === "justify" && !last && cur.length > 1 ? [...cur] : null, width: measure(text) });
      cur = [];
    };
    for (let word of words) {
      // Break words longer than the box.
      while (measure(word) > maxW && [...word].length > 1) {
        if (cur.length) flush(false);
        const chars = [...word];
        let n = 1;
        while (n < chars.length && measure(chars.slice(0, n + 1).join("")) <= maxW) n++;
        lines.push({ text: chars.slice(0, n).join(""), words: null, width: measure(chars.slice(0, n).join("")) });
        word = chars.slice(n).join("");
      }
      const trial = cur.length ? cur.join(" ") + " " + word : word;
      if (cur.length && measure(trial) > maxW) flush(false);
      cur.push(word);
    }
    flush(true);
  }

  // ---- positions relative to the anchor ----
  const shift = t.baselineShift;
  const firstBase = box ? ascent : 0;
  const xOf = (ln: Line): number => {
    const avail = box ? box.w : 0;
    if (t.align === "center") return box ? (avail - ln.width) / 2 : -ln.width / 2;
    if (t.align === "right") return box ? avail - ln.width : -ln.width;
    return 0;
  };
  const placed = lines.map((ln, i) => ({ ln, x: xOf(ln), base: firstBase + i * leading - shift }));

  // ---- bounds (generous, then clipped to the box for paragraph text) ----
  const slant = t.fauxItalic ? 0.21 : 0;
  const stroke = (t.fauxBold ? t.size * 0.035 : 0) + (t.antiAlias === "strong" ? t.size * 0.012 : 0);
  const pad = Math.ceil(t.size * 0.15 + stroke + 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of placed) {
    const top = p.base - ascent, bottom = p.base + descent;
    x0 = Math.min(x0, p.x - pad - slant * descent);
    x1 = Math.max(x1, p.x + Math.max(p.ln.width, box && p.ln.words ? box.w : 0) + pad + slant * ascent);
    y0 = Math.min(y0, top - pad);
    y1 = Math.max(y1, bottom + pad);
  }
  if (!placed.length || !isFinite(x0)) {
    x0 = 0;
    y0 = -ascent;
    x1 = 1;
    y1 = descent;
  }
  if (box) {
    x0 = 0;
    y0 = 0;
    x1 = box.w;
    y1 = box.h;
  }
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  const w = Math.max(1, Math.ceil(x1) - x0);
  const h = Math.max(1, Math.ceil(y1) - y0);
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) throw new ValidationError("the text is too large to draw; use a smaller size or fewer lines");
  const ox = -x0, oy = -y0;

  // ---- draw ----
  const { ctx } = makeCanvas(w, h);
  const [r, g, b] = t.color;
  const css = `rgb(${r},${g},${b})`;
  ctx.font = font;
  if (hasLS) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${track}px`;
  ctx.fillStyle = css;
  ctx.strokeStyle = css;
  ctx.lineJoin = "round";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  if (box) {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
  }
  const run = (s: string, x: number) => {
    // x is in unscaled units here.
    if (hasLS || !track) {
      ctx.fillText(s, x, 0);
      if (stroke) ctx.strokeText(s, x, 0);
      return;
    }
    let cx = x;
    for (const ch of s) {
      ctx.fillText(ch, cx, 0);
      if (stroke) ctx.strokeText(ch, cx, 0);
      cx += ctx.measureText(ch).width + track;
    }
  };
  ctx.lineWidth = stroke * 2;
  for (const p of placed) {
    ctx.save();
    ctx.translate(ox + p.x, oy + p.base);
    if (slant) ctx.transform(1, 0, -slant, 1, 0, 0);
    ctx.scale(sx, sy);
    if (p.ln.words && box) {
      // Justify: spread the extra width between the words.
      const ws = p.ln.words;
      const natural = ws.reduce((s, wd) => s + measure(wd), 0);
      const gap = (box.w - natural) / (ws.length - 1);
      let x = 0;
      for (const wd of ws) {
        run(wd, x / sx);
        x += measure(wd) + gap;
      }
    } else run(p.ln.text, 0);
    const lw = (p.ln.words && box ? box.w : p.ln.width) / sx;
    const thick = Math.max(1, t.size * 0.055);
    if (t.underline) ctx.fillRect(0, t.size * 0.12, lw, thick);
    if (t.strikethrough) ctx.fillRect(0, -t.size * 0.3, lw, thick);
    ctx.restore();
  }

  // ---- anti-aliasing and a clean, uniform color ----
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let a = d[i + 3];
    if (!a) continue;
    switch (t.antiAlias) {
      case "none":
        a = a >= 128 ? 255 : 0;
        break;
      case "sharp":
        a = Math.max(0, Math.min(255, Math.round((a - 128) * 1.6 + 128)));
        break;
      case "smooth":
        a = Math.round(255 * Math.pow(a / 255, 0.85));
        break;
    }
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
  return { w, h, ox, oy, data: new Uint8ClampedArray(d.buffer, d.byteOffset, d.length), ascent };
}
