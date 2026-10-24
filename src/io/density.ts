/**
 * Image resolution (pixels per inch) in PNG and JPEG files: read when a file
 * opens, written into saved copies so print sizes carry over to other
 * programs. PNG keeps it in a pHYs chunk; JPEG in the JFIF header.
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];

/** Pixels per inch stored in a PNG or JPEG, or null if the file doesn't say. */
export function readDensity(b: Uint8Array): number | null {
  if (b.length > 33 && PNG_SIG.every((v, i) => b[i] === v)) {
    let o = 8;
    while (o + 12 <= b.length) {
      const len = u32(b, o);
      const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (type === "pHYs" && len >= 9) {
        const x = u32(b, o + 8);
        // Unit 1: per metre.
        if (b[o + 16] !== 1 || !x) return null;
        // Pixels per metre are whole numbers, so 72 ppi comes back as 72.009: snap to whole ppi when that close.
        const ppi = x * 0.0254;
        return Math.abs(ppi - Math.round(ppi)) < 0.05 ? Math.round(ppi) : Math.round(ppi * 100) / 100;
      }
      if (type === "IDAT" || type === "IEND") return null;
      o += 12 + len;
    }
    return null;
  }
  if (b.length > 20 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const marker = b[o + 1];
      const len = u16(b, o + 2);
      if (marker === 0xe0 && String.fromCharCode(...b.subarray(o + 4, o + 9)) === "JFIF\0") {
        const units = b[o + 11], x = u16(b, o + 12);
        if (!x || !units) return null;
        return units === 1 ? x : Math.round(x * 2.54 * 100) / 100;
      }
      if (marker === 0xda) return null;
      o += 2 + len;
    }
  }
  return null;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The same PNG or JPEG with its resolution set (other files come back unchanged). */
export function writeDensity(b: Uint8Array, ppi: number): Uint8Array {
  if (b.length > 33 && PNG_SIG.every((v, i) => b[i] === v)) {
    // Drop an existing pHYs, then put ours right after IHDR.
    const parts: Uint8Array[] = [b.subarray(0, 8)];
    let o = 8;
    const ppm = Math.round(ppi / 0.0254);
    while (o + 12 <= b.length) {
      const len = u32(b, o);
      const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      const chunk = b.subarray(o, o + 12 + len);
      if (type !== "pHYs") parts.push(chunk);
      if (type === "IHDR") {
        const c = new Uint8Array(21);
        const dv = new DataView(c.buffer);
        dv.setUint32(0, 9);
        c.set([112, 72, 89, 115], 4);
        dv.setUint32(8, ppm);
        dv.setUint32(12, ppm);
        c[16] = 1;
        dv.setUint32(17, crc32(c.subarray(4, 17)));
        parts.push(c);
      }
      o += 12 + len;
    }
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let w = 0;
    for (const p of parts) {
      out.set(p, w);
      w += p.length;
    }
    return out;
  }
  if (b.length > 20 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[3] === 0xe0 && String.fromCharCode(...b.subarray(6, 11)) === "JFIF\0") {
    const out = b.slice();
    const v = Math.max(1, Math.min(65535, Math.round(ppi)));
    out[13] = 1;
    out[14] = v >> 8;
    out[15] = v & 255;
    out[16] = v >> 8;
    out[17] = v & 255;
    return out;
  }
  return b;
}
