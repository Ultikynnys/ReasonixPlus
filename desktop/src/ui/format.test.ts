import { describe, expect, it } from "vitest";
import { costLevel, hitPercent, multiplierLabel } from "./format";

describe("hitPercent", () => {
  it("keeps one decimal instead of rounding to a whole percentage", () => {
    expect(hitPercent(996, 4)).toBe("99.6");
  });

  it("never rounds a near-total hit rate up to an impossible 100.0", () => {
    // 999,838 / (999,838 + 162) = 99.984% real — a whole-percent round shows "100%".
    expect(hitPercent(999_838, 162)).toBe("99.9");
    expect(hitPercent(1_000_000, 1)).toBe("99.9");
  });

  it("shows 100.0 only when the miss count is exactly zero", () => {
    expect(hitPercent(500, 0)).toBe("100.0");
  });

  it("returns 0.0 with no data", () => {
    expect(hitPercent(0, 0)).toBe("0.0");
    expect(hitPercent(Number.NaN, undefined as unknown as number)).toBe("0.0");
  });

  it("handles a pure miss", () => {
    expect(hitPercent(0, 100)).toBe("0.0");
  });
});

describe("multiplierLabel", () => {
  it("drops the decimal on a whole multiple", () => {
    expect(multiplierLabel(1)).toBe("1");
    expect(multiplierLabel(2)).toBe("2");
  });

  it("keeps one decimal when the multiple is fractional", () => {
    expect(multiplierLabel(7.4987)).toBe("7.5");
    expect(multiplierLabel(3.7494)).toBe("3.7");
    expect(multiplierLabel(1.679)).toBe("1.7");
  });

  it("rounds the second decimal instead of truncating it", () => {
    expect(multiplierLabel(28.55)).toBe("28.6");
  });
});

describe("costLevel", () => {
  it("keeps 1x and anything cheaper at the green end", () => {
    expect(costLevel(1)).toBe(0);
    expect(costLevel(0.5)).toBe(0);
    expect(costLevel(0.4)).toBe(0);
  });

  it("reaches red at three times, and clamps past it", () => {
    expect(costLevel(3)).toBeCloseTo(1, 6);
    expect(costLevel(28.6)).toBe(1);
  });

  it("ramps linearly between the two, so the midpoint reads half", () => {
    expect(costLevel(2)).toBeCloseTo(0.5, 6);
    expect(costLevel(1.5)).toBeCloseTo(0.25, 6);
    expect(costLevel(2.6)).toBeCloseTo(0.8, 6);
  });
});
