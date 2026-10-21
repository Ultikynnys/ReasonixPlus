// jsdom has no layout engine, so the one-line backup row is pinned against the real
// stylesheet: index, picker and buttons must share a single non-wrapping line.
import { describe, expect, it } from "vitest";
import { cssRule } from "./support/css.js";

describe("desktop backup-model rows", () => {
  const row = ".rule.fallback-row";

  it("lays the index, picker and buttons out on one line", () => {
    const css = cssRule(row);
    expect(css).toContain("display: flex");
    expect(css).toContain("align-items: center");
    // Wrapping is what pushed the index and the buttons above the picker.
    expect(css).toContain("flex-wrap: nowrap");
  });

  it("lets the picker take the free width instead of the shared field width", () => {
    const css = cssRule(".fallback-row .fallback-select");
    expect(css).toContain("flex: 1 1 auto");
    expect(css).toContain("width: auto");
    // Without this a long model id would push the buttons out of the row.
    expect(css).toContain("min-width: 0");
  });

  it("keeps the index and the buttons at their own size", () => {
    expect(cssRule(".fallback-row .fallback-index")).toContain("flex: 0 0 auto");
    const actions = cssRule(".fallback-row .fallback-actions");
    expect(actions).toContain("flex: 0 0 auto");
    expect(actions).toContain("display: flex");
    expect(actions).toContain("align-items: center");
  });
});
