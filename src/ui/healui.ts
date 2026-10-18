/** Runs Content-Aware Fill in a worker with a cancellable progress pill. */

import type { App } from "../app";
import { setInpaintRunner } from "../core/cmd/heal";
import { Cancelled, FilterLane } from "../filters/client";
import { busyPill } from "./dialogs";

export function installInpaint(_app: App): void {
  const lane = new FilterLane();
  setInpaintRunner(async (job) => {
    const pill = busyPill("Content-Aware Fill...", () => lane.cancel());
    // Let the pill paint before the work starts.
    await new Promise((r) => setTimeout(r, 0));
    try {
      return await lane.inpaint(job);
    } catch (e) {
      if (e instanceof Cancelled) throw Object.assign(new Error("Cancelled"), { name: "AbortError" });
      throw e;
    } finally {
      pill.done();
    }
  });
}
