/**
 * Applying filters from the UI: the work runs in a worker so the window
 * stays responsive (with a Cancel button), then the result is committed
 * and recorded as the normal "filter.<id>" command, so History, Actions
 * and Fade all see it.
 */

import type { App } from "../app";
import { commitFilter, filterEnv, filterRegion } from "../core/cmd/filters";
import { NeedsRasterizeError } from "../core/cmd/common";
import { validate } from "../core/commands";
import { FILTER_MAP } from "../filters";
import { Cancelled, FilterLane } from "../filters/client";
import { downscale, type Img } from "../filters/img";
import { busyPill } from "./dialogs";
import type { FilterOrg } from "./filterorg";

export class FilterRunner {
  private lane = new FilterLane();
  last: { id: string; params: Record<string, unknown> } | null = null;
  running = false;

  constructor(
    private app: App,
    readonly org: FilterOrg,
  ) {}

  /** The image a filter dialog previews: the target inside the selection. */
  previewSource(maxSide: number): { img: Img; scale: number; full: { w: number; h: number } } | null {
    const app = this.app;
    if (!app.doc) return null;
    try {
      const r = filterRegion({ doc: app.doc, bus: app.bus }, { pad: () => 0 }, {});
      const img = downscale(r.img, maxSide);
      return { img, scale: img.w / r.img.w, full: { w: r.img.w, h: r.img.h } };
    } catch {
      return null;
    }
  }

  /** Apply a filter (asynchronously). Resolves false if it could not run or was cancelled. */
  async apply(id: string, params: Record<string, unknown>): Promise<boolean> {
    const app = this.app;
    const def = FILTER_MAP.get(id);
    const doc = app.doc;
    if (!def || !doc) return false;
    if (this.running) return false;
    const ctx = { doc, bus: app.bus };
    let region;
    try {
      if (!app.bus.isEnabled(`filter.${id}`)) throw new Error("Filters need a layer (or Quick Mask) to work on.");
      // Check the settings before touching any pixels.
      params = validate(app.bus.get(`filter.${id}`)!.params, params) as Record<string, unknown>;
      region = filterRegion(ctx, def, params);
    } catch (e) {
      if (e instanceof NeedsRasterizeError) return (await app.askRasterize(e.layerId)) && this.apply(id, params);
      app.toast(`Could not apply ${def.name}: ${(e as Error).message}`);
      return false;
    }
    const stateBefore = app.bus.history.current?.id;
    this.running = true;
    const big = region.img.w * region.img.h > 400_000;
    const pill = big ? busyPill(`Applying ${def.name}...`, () => this.lane.cancel()) : null;
    document.body.classList.add("busy");
    try {
      const out = await this.lane.run("filter", id, params, filterEnv(doc), region.img);
      // Don't land in the middle of a brush stroke or drag.
      while (app.isDragging) await new Promise((r) => setTimeout(r, 50));
      // Bail out if the image changed while we worked.
      if (app.doc !== doc || app.bus.history.current?.id !== stateBefore) {
        app.toast(`${def.name} was not applied because the image changed.`);
        return false;
      }
      commitFilter(doc, region, out, def.name);
      app.bus.dispatch(`filter.${id}`, params, { applied: true });
      this.last = { id, params: { ...params } };
      this.org.used(id, params);
      app.emit("settings");
      return true;
    } catch (e) {
      if (!(e instanceof Cancelled)) app.toast(`${def.name} failed: ${(e as Error).message}`);
      return false;
    } finally {
      this.running = false;
      pill?.done();
      document.body.classList.remove("busy");
    }
  }

  /** Run a filter synchronously through the bus (Actions playback, batch, scripts). */
  applySync(id: string, params: Record<string, unknown>): void {
    this.app.bus.dispatch(`filter.${id}`, params);
    this.last = { id, params: { ...params } };
  }
}
