import { describe, expect, it } from "vitest";
import { MAX_OPEN_TABS, type TabCapCandidate, pickTabToEvict } from "../src/desktop/tab-cap.js";

const tab = (id: string, focusedAt?: number, running = false): TabCapCandidate => ({
  id,
  focusedAt,
  running,
});

/** Exactly `cap` candidates, so the cap is reached and eviction is in play. */
const atCap = (...candidates: TabCapCandidate[]) => {
  expect(candidates).toHaveLength(MAX_OPEN_TABS);
  return candidates;
};

const fillers = (): TabCapCandidate[] =>
  Array.from({ length: MAX_OPEN_TABS - 2 }, (_, i) => tab(`filler-${i}`, 100 + i));

describe("pickTabToEvict", () => {
  it("closes nothing while the tab set fits", () => {
    expect(pickTabToEvict([tab("a", 1), tab("b", 2)], "a")).toBeNull();
    expect(pickTabToEvict([], "a")).toBeNull();
  });

  it("picks the least recently focused tab once the cap is reached", () => {
    const picked = pickTabToEvict(atCap(tab("old", 1), tab("mid", 5), ...fillers()), "active");
    expect(picked?.id).toBe("old");
  });

  it("never evicts the active tab, even when it looks least recent", () => {
    const picked = pickTabToEvict(atCap(tab("active", 1), tab("mid", 5), ...fillers()), "active");
    expect(picked?.id).not.toBe("active");
    // `mid` (stamp 5) is the oldest tab that is not the active one.
    expect(picked?.id).toBe("mid");
  });

  it("never evicts a tab with an agent running, even when it is the oldest", () => {
    const picked = pickTabToEvict(
      atCap(tab("busy", 1, true), tab("idle", 9), ...fillers()),
      "active",
    );
    // `busy` is oldest but running, so the next oldest, `idle`, goes instead.
    expect(picked?.id).toBe("idle");
  });

  it("returns null when every other tab is busy, so the caller can refuse", () => {
    const busy = Array.from({ length: MAX_OPEN_TABS - 1 }, (_, i) => tab(`busy-${i}`, i, true));
    expect(pickTabToEvict([tab("active", 99), ...busy], "active")).toBeNull();
  });

  it("treats a never-focused tab as the oldest", () => {
    const picked = pickTabToEvict(atCap(tab("never"), tab("seen", 1), ...fillers()), "active");
    expect(picked?.id).toBe("never");
  });
});
