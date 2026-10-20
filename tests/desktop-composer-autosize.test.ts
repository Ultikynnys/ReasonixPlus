import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPOSER_ROWS,
  getComposerTextareaSizing,
} from "../desktop/src/ui/composer-sizing";
import { cssRule, sourceFile } from "./support/css.js";

// The composer must hold a fixed height and never resize (#1594 regression):
// it previously expanded past a five-row threshold, so the box jumped as the
// user typed across that boundary.
describe("desktop composer textarea never resizes", () => {
  const height = DEFAULT_COMPOSER_ROWS * 20 + 18;

  it("uses CSS sizing and native overflow without per-render layout measurement", () => {
    const composer = sourceFile("desktop/src/ui/composer.tsx");
    const textareaRule = cssRule(".composer textarea");
    expect(textareaRule).toContain("height: calc(2 * 1.55em + 18px)");
    expect(textareaRule).toContain("overflow-y: auto");
    expect(composer).not.toContain("applyComposerTextareaSize");
  });

  it("holds the fixed height for a single line", () => {
    const sizing = getComposerTextareaSizing({
      contentRows: 1,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });

    expect(sizing.heightPx).toBe(height);
    expect(sizing.overflowY).toBe("hidden");
  });

  it("keeps the same height regardless of how much content is typed", () => {
    for (const contentRows of [1, 2, 3, 5, 10, 20]) {
      const sizing = getComposerTextareaSizing({
        contentRows,
        lineHeightPx: 20,
        verticalPaddingPx: 18,
      });

      expect(sizing.heightPx).toBe(height);
    }
  });

  it("scrolls inside the box instead of growing once content overflows", () => {
    const fits = getComposerTextareaSizing({
      contentRows: DEFAULT_COMPOSER_ROWS,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });
    const overflows = getComposerTextareaSizing({
      contentRows: DEFAULT_COMPOSER_ROWS + 1,
      lineHeightPx: 20,
      verticalPaddingPx: 18,
    });

    expect(fits.overflowY).toBe("hidden");
    expect(overflows.overflowY).toBe("auto");
    expect(overflows.heightPx).toBe(height);
  });
});
