/** Runs filters and the B&W conversion off the main thread. */

import { FILTER_MAP } from "./index";
import { blackWhite, type BWSettings } from "./bw";
import { runFilter, type FilterEnv } from "./types";
import { inpaint } from "../core/inpaint";

export interface WorkRequest {
  id: number;
  op: "filter" | "bw" | "inpaint";
  key: string;
  params: Record<string, any>;
  env: FilterEnv;
  full?: { w: number; h: number };
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

self.onmessage = (e: MessageEvent<WorkRequest>) => {
  const m = e.data;
  try {
    const src = { w: m.w, h: m.h, data: m.data };
    let out;
    if (m.op === "inpaint") out = { w: m.w, h: m.h, data: inpaint({ w: m.w, h: m.h, data: m.data, hole: m.params.hole, allowed: m.params.allowed }, m.params.opts) };
    else if (m.op === "bw") out = blackWhite(src, m.params as BWSettings, m.env.scale, m.full);
    else {
      const def = FILTER_MAP.get(m.key);
      if (!def) throw new Error(`unknown filter ${m.key}`);
      out = runFilter(def, src, m.params, m.env);
    }
    (self as unknown as Worker).postMessage({ id: m.id, w: out.w, h: out.h, data: out.data }, [out.data.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
