import { describe, expect, it } from "vitest";
import { capTrace, countReversals } from "./scroll-jitter-probe";

describe("countReversals", () => {
  it("counts direction changes in a jittering sequence", () => {
    expect(countReversals([0, 10, 8, 12, 6, 14])).toBe(4);
  });

  it("stays zero for a monotonic pinned follow", () => {
    expect(countReversals([0, 30, 60, 90, 120])).toBe(0);
    expect(countReversals([120, 90, 60, 0])).toBe(0);
  });

  it("ignores sub-pixel noise below the movement epsilon", () => {
    expect(countReversals([100, 100.001, 100, 100.004])).toBe(0);
  });

  it("treats flat stretches as no direction", () => {
    expect(countReversals([5, 5, 5])).toBe(0);
    expect(countReversals([0, 10, 10, 0])).toBe(1);
  });
});

describe("capTrace", () => {
  it("keeps the newest parts that fit and restores oldest-to-newest order", () => {
    expect(capTrace(["aaa", "bbb", "ccc"], 7)).toEqual(["bbb", "ccc"]);
    expect(capTrace(["a", "b", "c", "d"], 5)).toEqual(["b", "c", "d"]);
  });

  it("drops a part that cannot fit and everything older", () => {
    expect(capTrace(["aaaaaaaaaaa"], 5)).toEqual([]);
    expect(capTrace(["x", "y"], 1)).toEqual(["y"]);
  });

  it("handles an empty trace", () => {
    expect(capTrace([], 10)).toEqual([]);
  });
});
