/**
 * MediaPipe Tasks (vision) loaded from the stored model files: the body-part
 * segmenter behind Select > People and the face landmarker behind
 * Face-Aware Liquify. Both run on the CPU (XNNPACK), which works the same on
 * every machine.
 */

import { fitImg, type Box, type SegOut } from "./people";
import { readModel, type ModelKey } from "./models";
import type { Img } from "../filters/img";

import type { FaceLandmarker, ImageSegmenter } from "@mediapipe/tasks-vision";

type TV = typeof import("@mediapipe/tasks-vision");
type Seg = ImageSegmenter;
type FaceL = FaceLandmarker;

export interface Face {
  /** 478 landmarks as x, y pairs in image pixels. */
  pts: Float32Array;
  box: Box;
}

let tvP: Promise<{ tv: TV; fileset: { wasmLoaderPath: string; wasmBinaryPath: string } }> | null = null;
let segP: Promise<Seg> | null = null;
let faceP: Promise<FaceL> | null = null;

const blobUrl = (bytes: Uint8Array, type: string) => URL.createObjectURL(new Blob([bytes as BlobPart], { type }));

function runtime() {
  return (tvP ??= (async () => {
    const [tv, js, wasm] = await Promise.all([import("@mediapipe/tasks-vision"), readModel("runtimeJs"), readModel("runtimeWasm")]);
    return { tv, fileset: { wasmLoaderPath: blobUrl(js, "text/javascript"), wasmBinaryPath: blobUrl(wasm, "application/wasm") } };
  })().catch((e) => {
    tvP = null;
    throw asError(e);
  }));
}

const model = async (k: ModelKey) => readModel(k);

function segmenter(): Promise<Seg> {
  return (segP ??= (async () => {
    const { tv, fileset } = await runtime();
    return tv.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: await model("segmenter"), delegate: "CPU" },
      runningMode: "IMAGE",
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  })().catch((e) => {
    segP = null;
    throw asError(e);
  }));
}

function landmarker(): Promise<FaceL> {
  return (faceP ??= (async () => {
    const { tv, fileset } = await runtime();
    return tv.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: await model("face"), delegate: "CPU" },
      runningMode: "IMAGE",
      numFaces: 12,
      minFaceDetectionConfidence: 0.35,
      minFacePresenceConfidence: 0.35,
    });
  })().catch((e) => {
    faceP = null;
    throw asError(e);
  }));
}

/** Forget (and free) a model instance after a failure: a WebAssembly abort leaves it unusable. */
function reset(which: "seg" | "face"): void {
  const p: Promise<{ close(): void }> | null = which === "seg" ? segP : faceP;
  if (which === "seg") segP = null;
  else faceP = null;
  void p?.then((m) => {
    try {
      m.close();
    } catch {
      /* already broken */
    }
  }).catch(() => {});
}

/** MediaPipe rejects with a DOM Event when its loader script fails; make that a readable Error. */
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(e instanceof Event ? "the vision runtime could not be loaded" : String(e)));

const imageData = (img: Img) => new ImageData(new Uint8ClampedArray(img.data), img.w, img.h);

/** A synchronous segmenter for analyzePeople (load it first with loadSegmenter). */
export async function loadSegmenter(): Promise<(img: Img) => SegOut> {
  const s = await segmenter();
  return (img: Img) => {
    try {
      const r = s.segment(imageData(img));
      const conf = (r.confidenceMasks ?? []).map((m) => m.getAsFloat32Array().slice());
      r.close();
      if (conf.length < 6) throw new Error("the segmenter returned no masks");
      return { conf };
    } catch (e) {
      reset("seg");
      throw e;
    }
  };
}

function toFace(lm: { x: number; y: number }[], ox: number, oy: number, sx: number, sy: number): Face {
  const pts = new Float32Array(lm.length * 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  lm.forEach((p, i) => {
    const x = ox + p.x * sx, y = oy + p.y * sy;
    pts[i * 2] = x;
    pts[i * 2 + 1] = y;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  });
  return { pts, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

const iou = (a: Box, b: Box) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = x * y;
  return i / (a.w * a.h + b.w * b.h - i || 1);
};

/**
 * Faces in img with their 478 landmarks. The landmarker's own detector only
 * sees faces that fill a good part of the frame, so small faces are found
 * again in close crops around the given head boxes (from people detection).
 */
export async function detectFaces(img: Img, heads: Box[] = []): Promise<Face[]> {
  const f = await landmarker();
  const out: Face[] = [];
  try {
    const small = fitImg(img, 1024);
    const r = f.detect(imageData(small));
    for (const lm of r.faceLandmarks) out.push(toFace(lm, 0, 0, img.w, img.h));
    for (const h of heads) {
      const side = Math.round(Math.max(h.w, h.h) * 2.4);
      const cx = h.x + h.w / 2, cy = h.y + h.h / 2;
      const b = { x: Math.max(0, Math.round(cx - side / 2)), y: Math.max(0, Math.round(cy - side / 2)), w: 0, h: 0 };
      b.w = Math.min(img.w, b.x + side) - b.x;
      b.h = Math.min(img.h, b.y + side) - b.y;
      if (b.w < 24 || b.h < 24) continue;
      if (out.some((o) => iou(o.box, h) > 0.2 || (o.box.x < cx && cx < o.box.x + o.box.w && o.box.y < cy && cy < o.box.y + o.box.h))) continue;
      const crop = new Uint8ClampedArray(b.w * b.h * 4);
      for (let y = 0; y < b.h; y++) crop.set(img.data.subarray(((b.y + y) * img.w + b.x) * 4, ((b.y + y) * img.w + b.x + b.w) * 4), y * b.w * 4);
      const c = fitImg({ w: b.w, h: b.h, data: crop }, 512);
      const rr = f.detect(imageData(c));
      let best: Face | null = null;
      for (const lm of rr.faceLandmarks) {
        const face = toFace(lm, b.x, b.y, b.w, b.h);
        const fc = { x: face.box.x + face.box.w / 2, y: face.box.y + face.box.h / 2 };
        const d = Math.hypot(fc.x - cx, fc.y - cy);
        if (d < side * 0.4 && (!best || d < Math.hypot(best.box.x + best.box.w / 2 - cx, best.box.y + best.box.h / 2 - cy))) best = face;
      }
      if (best && !out.some((o) => iou(o.box, best!.box) > 0.3)) out.push(best);
    }
  } catch (e) {
    reset("face");
    throw e;
  }
  out.sort((a, b) => a.box.x - b.box.x);
  return out;
}
