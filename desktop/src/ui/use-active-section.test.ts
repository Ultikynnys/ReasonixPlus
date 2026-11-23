import { describe, expect, it } from "vitest";
import { activeSectionAt, isScrollEnd } from "./use-active-section";

const OFFSETS = [
  { id: "one", top: 0 },
  { id: "two", top: 400 },
  { id: "three", top: 900 },
];

describe("activeSectionAt", () => {
  it("reads the section under the reading line", () => {
    expect(activeSectionAt(OFFSETS, 0)).toBe("one");
    expect(activeSectionAt(OFFSETS, 300)).toBe("one");
    expect(activeSectionAt(OFFSETS, 800)).toBe("two");
    // The third section's top is 900, so it claims the reader one line early at 876.
    expect(activeSectionAt(OFFSETS, 875)).toBe("two");
    expect(activeSectionAt(OFFSETS, 876)).toBe("three");
  });

  it("switches a line early, so the heading is already on screen", () => {
    // 400 - 24 is the last scroll where the second section is still below the line.
    expect(activeSectionAt(OFFSETS, 375)).toBe("one");
    expect(activeSectionAt(OFFSETS, 376)).toBe("two");
  });

  it("names the last section at the end of the scroll, however short it is", () => {
    // A short last section can never reach the reading line, so the bottom of the scroll
    // has to claim it or the index never points at it.
    expect(activeSectionAt(OFFSETS, 500, { atBottom: true })).toBe("three");
  });

  it("has nothing to report for an empty index", () => {
    expect(activeSectionAt([], 0)).toBeNull();
  });
});

describe("isScrollEnd", () => {
  it("is false when the content fits, even at the last pixel", () => {
    expect(isScrollEnd(0, 500, 500)).toBe(false);
    expect(isScrollEnd(0, 500, 501)).toBe(false);
  });

  it("is true only within two pixels of a real scroll end", () => {
    expect(isScrollEnd(0, 500, 900)).toBe(false);
    expect(isScrollEnd(397, 500, 900)).toBe(false);
    expect(isScrollEnd(398, 500, 900)).toBe(true);
    expect(isScrollEnd(400, 500, 900)).toBe(true);
  });
});
