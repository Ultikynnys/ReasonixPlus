import { describe, expect, it } from "vitest";
import { cssRules, stylesCss } from "../../tests/support/css.js";

describe("chat table CSS", () => {
  it("keeps the table wrapper inside the text column", () => {
    // Every rule for the selector, so a bleed added in a second block still
    // fails instead of hiding behind the first.
    const bodies = cssRules(".markdown-table-wrap");
    expect(bodies.length).toBeGreaterThan(0);
    const wrapper = bodies.join("\n");
    expect(wrapper).toContain("overflow-x: auto");
    // A width past 100% or a negative side margin overflows the column, and
    // every ancestor that clips paint (row containment, card overflow) then
    // slices the first cell's leading glyph.
    expect(wrapper).not.toMatch(/calc\(/);
    expect(wrapper).not.toMatch(/margin(?:-[a-z-]+)?:\s*[^;]*-/);
    const widths = [...wrapper.matchAll(/(?:max-|min-)?width:\s*([^;]+)/g)].map((m) =>
      m[1]!.trim(),
    );
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect(width).toMatch(/^(100%|auto|0|none)$/);
  });

  it("routes every chat table rule through the wrapper", () => {
    expect(stylesCss).not.toMatch(/\.markdown\s+(table|tbody|th|td)\b/);
    expect(stylesCss).not.toMatch(/\.msg-text\s+(table|tbody|th|td)\b/);
  });
});
