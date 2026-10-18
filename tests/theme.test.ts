import { describe, expect, it } from "vitest";
import { THEMES, contrast, deriveTokens, mix } from "../src/ui/theme";

describe("themes", () => {
  for (const t of THEMES) {
    const c = t.colors;
    it(`${t.name}: text is readable`, () => {
      for (const bg of [c.bg, c.panel, c.raised, c.field]) {
        expect(contrast(c.text, bg), `text on ${bg}`).toBeGreaterThanOrEqual(7);
        expect(contrast(c.textDim, bg), `secondary text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${t.name}: accent stands out and its label is readable`, () => {
      expect(contrast(c.accent, c.panel)).toBeGreaterThanOrEqual(3);
      const tk = deriveTokens(c, "soft", "medium");
      expect(contrast(tk["--accent-text"], c.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.text, tk["--sel-bg"])).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("mixes colors", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
});
