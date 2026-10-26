// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { msUntilNextRateFlip } from "./rate-clock";

/** Weekday fixture: 2026-01-01 is a Thursday. */
function weekday(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute));
}

/** Saturday 2026-09-05. */
function saturday(hour: number): Date {
  return new Date(Date.UTC(2026, 8, 5, hour));
}

describe("rate clock", () => {
  it("wakes at the earliest declared flip, not on a fixed poll", () => {
    // DeepSeek's first window opens 01:00 UTC, before Ollama's 12:00 and Z.AI's 06:00.
    expect(msUntilNextRateFlip(weekday(0))).toBe(60 * 60_000);
    // Ollama is the only calendar still off-peak at 11:30, and it flips at 12:00.
    expect(msUntilNextRateFlip(weekday(11, 30))).toBe(30 * 60_000);
    expect(msUntilNextRateFlip(weekday(13))).toBe(5 * 60 * 60_000);
  });

  it("counts through a weekend to the next weekday window", () => {
    // Every calendar is suppressed on a weekend, so the wake-up is Monday 01:00 UTC
    // (DeepSeek), 37 hours out rather than the next 24-hour boundary.
    expect(msUntilNextRateFlip(saturday(12))).toBe(37 * 60 * 60_000);
  });
});
