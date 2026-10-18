/**
 * Talks to the filter worker. A "lane" runs one job at a time; starting a
 * new job on a busy lane cancels the old one (the worker is replaced), so
 * fast slider drags never queue up stale previews.
 */

import type { Img } from "./img";
import type { FilterEnv } from "./types";

type Job = { resolve: (i: Img) => void; reject: (e: Error) => void };

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export class FilterLane {
  private worker: Worker | null = null;
  private job: { id: number; p: Job } | null = null;
  private nextId = 1;

  private spawn(): Worker {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data as { id: number; error?: string; w: number; h: number; data: Uint8ClampedArray };
      if (!this.job || this.job.id !== m.id) return;
      const { p } = this.job;
      this.job = null;
      if (m.error) p.reject(new Error(m.error));
      else p.resolve({ w: m.w, h: m.h, data: m.data });
    };
    w.onerror = (e) => {
      const j = this.job;
      this.job = null;
      j?.p.reject(new Error(e.message || "the filter crashed"));
      this.worker?.terminate();
      this.worker = null;
    };
    return w;
  }

  get busy(): boolean {
    return !!this.job;
  }

  cancel(): void {
    if (!this.job) return;
    this.job.p.reject(new Cancelled());
    this.job = null;
    this.worker?.terminate();
    this.worker = null;
  }

  /** Stop and free the worker (call when the owner goes away). */
  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Content-Aware Fill and healing, off the main thread. */
  inpaint(job: { input: { w: number; h: number; data: Uint8ClampedArray; hole: Uint8Array; allowed?: Uint8Array }; opts: object }): Promise<Uint8ClampedArray> {
    const { w, h, data, hole, allowed } = job.input;
    return this.run("inpaint", "", { hole, allowed, opts: job.opts }, { fg: [0, 0, 0], bg: [255, 255, 255], scale: 1 }, { w, h, data }).then((r) => r.data);
  }

  run(op: "filter" | "bw" | "inpaint", key: string, params: Record<string, unknown>, env: FilterEnv, img: Img, full?: { w: number; h: number }): Promise<Img> {
    this.cancel();
    if (!this.worker) this.worker = this.spawn();
    const id = this.nextId++;
    const data = img.data.slice();
    return new Promise<Img>((resolve, reject) => {
      this.job = { id, p: { resolve, reject } };
      this.worker!.postMessage({ id, op, key, params, env, full, w: img.w, h: img.h, data }, [data.buffer]);
    });
  }
}
