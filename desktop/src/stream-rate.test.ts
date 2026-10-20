import { describe, expect, it } from "vitest";
import { StreamRateTracker, SubagentRateFolder, formatTokensPerSecond } from "./stream-rate";

describe("StreamRateTracker", () => {
  it("reports 0 with no samples", () => {
    const t = new StreamRateTracker();
    expect(t.tokensPerSecond(1_000)).toBe(0);
  });

  it("estimates tokens/second from received characters at 4 chars/token", () => {
    const t = new StreamRateTracker();
    // 400 chars over a 2s span ≈ 100 tokens / 2s = 50 tok/s.
    t.record(200, 0);
    t.record(200, 1_000);
    expect(t.tokensPerSecond(2_000)).toBeCloseTo(50, 1);
  });

  it("decays to 0 once the stream goes stale", () => {
    const t = new StreamRateTracker();
    t.record(400, 0);
    expect(t.tokensPerSecond(100)).toBeGreaterThan(0);
    // No delta for > STALE_MS (1200ms) ⇒ nothing is being received.
    expect(t.tokensPerSecond(2_000)).toBe(0);
  });

  it("drops samples older than the window", () => {
    const t = new StreamRateTracker();
    t.record(10_000, 0);
    // The 10k-char burst is outside the 2500ms window by now.
    t.record(40, 3_000);
    // Only the recent 40 chars count: ~10 tokens over the floor span.
    expect(t.tokensPerSecond(3_100)).toBeLessThan(20);
  });

  it("reset() clears the window", () => {
    const t = new StreamRateTracker();
    t.record(400, 0);
    t.reset();
    expect(t.tokensPerSecond(100)).toBe(0);
  });

  it("ignores non-positive character counts", () => {
    const t = new StreamRateTracker();
    t.record(0, 0);
    t.record(-5, 0);
    expect(t.tokensPerSecond(0)).toBe(0);
  });
});

describe("SubagentRateFolder", () => {
  /** A tracker that only records what it is handed — the fold's own arithmetic is
   *  what these tests are about, not the sliding window it feeds. */
  function recounter(): { tracker: StreamRateTracker; samples: number[] } {
    const samples: number[] = [];
    const tracker = {
      record: (chars: number) => {
        samples.push(chars);
      },
    } as unknown as StreamRateTracker;
    return { tracker, samples };
  }

  it("counts a run's cumulative total as growth, never twice", () => {
    const { tracker, samples } = recounter();
    const folder = new SubagentRateFolder();
    folder.record("sub-1", 800, tracker);
    folder.record("sub-1", 1_000, tracker);
    folder.record("sub-1", 1_000, tracker);
    expect(samples).toEqual([800, 200]);
  });

  it("keeps parallel runs apart so both feed the same window", () => {
    const { tracker, samples } = recounter();
    const folder = new SubagentRateFolder();
    folder.record("sub-1", 400, tracker);
    folder.record("sub-2", 100, tracker);
    folder.record("sub-1", 900, tracker);
    folder.record("sub-2", 500, tracker);
    expect(samples).toEqual([400, 100, 500, 400]);
  });

  it("ignores a total that stops advancing or goes backwards", () => {
    const { tracker, samples } = recounter();
    const folder = new SubagentRateFolder();
    folder.record("sub-1", 900, tracker);
    folder.record("sub-1", 300, tracker);
    folder.record("sub-1", 0, tracker);
    folder.record("sub-1", Number.NaN, tracker);
    folder.record("sub-1", 950, tracker);
    // The high-water mark survives a bad sample: only real growth counts.
    expect(samples).toEqual([900, 50]);
  });

  it("forget() lets a reused run id count from zero again", () => {
    const { tracker, samples } = recounter();
    const folder = new SubagentRateFolder();
    folder.record("sub-1", 1_000, tracker);
    folder.forget("sub-1");
    folder.record("sub-1", 300, tracker);
    expect(samples).toEqual([1_000, 300]);
  });
});

describe("formatTokensPerSecond", () => {
  it("renders 0 for empty and non-finite rates", () => {
    expect(formatTokensPerSecond(0)).toBe("0");
    expect(formatTokensPerSecond(Number.NaN)).toBe("0");
    expect(formatTokensPerSecond(-3)).toBe("0");
  });

  it("uses one decimal below 10 and rounds at/above 10", () => {
    expect(formatTokensPerSecond(3.456)).toBe("3.5");
    expect(formatTokensPerSecond(9.94)).toBe("9.9");
    expect(formatTokensPerSecond(42.4)).toBe("42");
    expect(formatTokensPerSecond(100)).toBe("100");
  });
});
