/** The filter library: every filter, by id. */

import { artisticFilters } from "./defs/artistic";
import { blurFilters } from "./defs/blur";
import { cartoonFilters } from "./defs/cartoon";
import { distortFilters } from "./defs/distort";
import { lookFilters } from "./defs/looks";
import { otherFilters } from "./defs/other";
import { painterlyFilters } from "./defs/painterly";
import { sketchFilters } from "./defs/sketch";
import { stylizeFilters } from "./defs/stylize";
import { toneFilters } from "./defs/tone";
import { CATEGORIES, type FilterDef } from "./types";

const OLD: FilterDef[] = [...cartoonFilters, ...artisticFilters, ...sketchFilters, ...blurFilters, ...distortFilters, ...stylizeFilters, ...lookFilters, ...otherFilters];

/** The rebuilt painterly filters replace older versions with the same id; new ones join their category. */
function merge(old: FilterDef[], next: FilterDef[]): FilterDef[] {
  const byId = new Map(next.map((f) => [f.id, f]));
  const out = old.map((f) => byId.get(f.id) ?? f);
  for (const f of next) {
    if (old.some((o) => o.id === f.id)) continue;
    let at = -1;
    out.forEach((o, i) => o.category === f.category && (at = i));
    out.splice(at + 1, 0, f);
  }
  return out;
}

export const FILTERS: FilterDef[] = merge(merge(OLD, painterlyFilters), toneFilters);

export const FILTER_MAP = new Map(FILTERS.map((f) => [f.id, f]));

export function filtersIn(category: string): FilterDef[] {
  return FILTERS.filter((f) => f.category === category);
}

export { CATEGORIES };
export type { FilterDef };
