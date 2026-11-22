import { describe, expect, it } from "vitest";
import { FULL_BLEED_SCREEN_RATIO, wantsFullBleed } from "./settings-frame";

describe("settings frame width", () => {
  it("keeps the margins while the window is at least 70% of the screen", () => {
    expect(FULL_BLEED_SCREEN_RATIO).toBe(0.7);
    expect(wantsFullBleed(1920, 1920)).toBe(false);
    expect(wantsFullBleed(1344, 1920)).toBe(false);
  });

  it("takes the whole viewport below that share", () => {
    expect(wantsFullBleed(1343, 1920)).toBe(true);
    expect(wantsFullBleed(900, 1920)).toBe(true);
  });

  it("stays windowed when the screen width is unknown", () => {
    // jsdom and a webview that reports no screen must not make the frame full screen.
    expect(wantsFullBleed(900, 0)).toBe(false);
    expect(wantsFullBleed(900, Number.NaN)).toBe(false);
  });
});
