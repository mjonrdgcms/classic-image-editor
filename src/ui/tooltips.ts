/**
 * Preferences > General > Show Tool Tips. The UI uses the browser's own
 * tooltips (title attributes); with tool tips off, titles are set aside as
 * the pointer reaches them, and put back when the preference is turned on.
 */

import type { App } from "../app";

const STASH = "data-tip";

export function mountTooltips(app: App): void {
  const strip = (e: Event) => {
    if (app.prefs.showToolTips) return;
    for (let n = e.target as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
      const t = n.getAttribute?.("title");
      if (t) {
        n.setAttribute(STASH, t);
        n.removeAttribute("title");
      }
    }
  };
  document.addEventListener("mouseover", strip, true);
  document.addEventListener("focusin", strip, true);
  app.on("prefs", () => {
    if (!app.prefs.showToolTips) return;
    for (const n of document.querySelectorAll<HTMLElement>(`[${STASH}]`)) {
      if (!n.hasAttribute("title")) n.setAttribute("title", n.getAttribute(STASH)!);
      n.removeAttribute(STASH);
    }
  });
}
