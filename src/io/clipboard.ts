/**
 * System clipboard bridge for images. Copy puts a PNG on the system
 * clipboard (so other programs can paste it); Paste prefers an image another
 * program put there, and otherwise uses the editor's own exact pixels.
 */

import type { ClipboardImage } from "../core/cmd/edit";
import { decodeImage, encodeImage } from "./files";

let lastWritten: { w: number; h: number } | null = null;

export async function writeSystemClipboard(c: ClipboardImage): Promise<void> {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") return;
    lastWritten = { w: c.w, h: c.h };
    await navigator.clipboard.write([new ClipboardItem({ "image/png": encodeImage(c.data, c.w, c.h, "png") })]);
  } catch {
    // Not allowed here (permissions, no focus); the internal clipboard still works.
  }
}

/** An image from the system clipboard that didn't come from us, or null. */
export async function readSystemClipboard(): Promise<ClipboardImage | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith("image/"));
      if (!type) continue;
      const img = await decodeImage(await it.getType(type), "clipboard");
      if (lastWritten && img.width === lastWritten.w && img.height === lastWritten.h) return null;
      return { w: img.width, h: img.height, data: img.data };
    }
  } catch {
    /* permission denied or empty */
  }
  return null;
}

/** Image from a DOM paste event (works without clipboard permissions). */
export async function imageFromPasteEvent(e: ClipboardEvent): Promise<ClipboardImage | null> {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return null;
  try {
    const img = await decodeImage(files[0], files[0].name);
    if (lastWritten && img.width === lastWritten.w && img.height === lastWritten.h) return null;
    return { w: img.width, h: img.height, data: img.data };
  } catch {
    return null;
  }
}
