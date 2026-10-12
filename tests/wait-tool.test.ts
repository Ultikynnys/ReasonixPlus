import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  WAIT_DEFAULT_MS,
  WAIT_MAX_MS,
  formatLocal,
  formatUtc,
  registerWaitTool,
} from "../src/tools/wait.js";

function makeRegistry(clock: {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}): ToolRegistry {
  return registerWaitTool(new ToolRegistry(), { now: clock.now, sleep: clock.sleep });
}

describe("formatUtc / formatLocal", () => {
  it("formats UTC as timezone-independent sortable timestamp", () => {
    expect(formatUtc(Date.UTC(2026, 4, 14, 9, 5, 3))).toBe("2026-05-14 09:05:03 UTC");
  });

  it("formats local with the host timezone offset", () => {
    const ms = Date.UTC(2026, 4, 14, 12, 0, 0);
    const d = new Date(ms);
    const offsetMinutes = -d.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMinutes);
    const expected = ` (UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(
      abs % 60,
    ).padStart(2, "0")})`;
    expect(formatLocal(ms)).toMatch(
      new RegExp(`\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}${expected.replace(/[+()]/g, "\\$&")}$`),
    );
  });
});

describe("wait tool", () => {
  it("registers as readOnly and reports full time accounting", async () => {
    let t = 1_000;
    let slept = 0;
    const registry = makeRegistry({
      now: () => t,
      sleep: async (ms) => {
        slept = ms;
        t += ms;
      },
    });
    expect(registry.get("wait")?.readOnly).toBe(true);
    const out = JSON.parse(
      (await registry.dispatch("wait", JSON.stringify({ ms: 2500 }))) as string,
    ) as Record<string, unknown>;
    expect(slept).toBe(2500);
    expect(out.requestedMs).toBe(2500);
    expect(out.waitedMs).toBe(2500);
    expect(out.clamped).toBe(false);
    expect(out.cancelledByUser).toBeUndefined();
    expect(out.timeBefore).toEqual({
      utc: "1970-01-01 00:00:01 UTC",
      local: formatLocal(1_000),
    });
    expect(out.timeAfter).toEqual({
      utc: "1970-01-01 00:00:03 UTC",
      local: formatLocal(3_500),
    });
    expect(out.elapsed).toBe("2.5s");
  });

  it("clamps values over the cap instead of rejecting", async () => {
    let t = 0;
    let slept = 0;
    const registry = makeRegistry({
      now: () => t,
      sleep: async (ms) => {
        slept = ms;
        t += ms;
      },
    });
    const out = JSON.parse(
      (await registry.dispatch("wait", JSON.stringify({ ms: WAIT_MAX_MS * 10 }))) as string,
    ) as Record<string, unknown>;
    expect(slept).toBe(WAIT_MAX_MS);
    expect(out.requestedMs).toBe(WAIT_MAX_MS);
    expect(out.clamped).toBe(true);
  });

  it("falls back to the default on missing / zero / non-numeric ms", async () => {
    for (const args of [
      "{}",
      JSON.stringify({ ms: 0 }),
      JSON.stringify({ ms: -5 }),
      JSON.stringify({ ms: "soon" }),
    ]) {
      let t = 0;
      let slept = 0;
      const registry = makeRegistry({
        now: () => t,
        sleep: async (ms) => {
          slept = ms;
          t += ms;
        },
      });
      const out = JSON.parse((await registry.dispatch("wait", args)) as string) as Record<
        string,
        unknown
      >;
      expect(slept).toBe(WAIT_DEFAULT_MS);
      expect(out.requestedMs).toBe(WAIT_DEFAULT_MS);
    }
  });

  it("reports a user cancellation instead of throwing", async () => {
    const controller = new AbortController();
    const registry = makeRegistry({
      now: () => 0,
      sleep: async (_ms, signal) => {
        await new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    const dispatch = registry.dispatch("wait", "{}", { cancelSignal: controller.signal });
    controller.abort(new Error("user stop"));
    const out = JSON.parse((await dispatch) as string) as Record<string, unknown>;
    expect(out.cancelledByUser).toBe(true);
    expect(out.note).toMatch(/interrupted/);
  });

  it("wakes on the TURN abort signal too, not just the per-call cancel", async () => {
    const controller = new AbortController();
    let wakeAbort: (() => void) | null = null;
    const registry = makeRegistry({
      now: () => 0,
      sleep: async (_ms, signal) => {
        await new Promise((_resolve, reject) => {
          wakeAbort = () => reject(new Error("aborted"));
          signal?.addEventListener("abort", wakeAbort, { once: true });
        });
      },
    });
    const dispatch = registry.dispatch("wait", "{}", { signal: controller.signal });
    controller.abort(new Error("turn stop"));
    const out = JSON.parse((await dispatch) as string) as Record<string, unknown>;
    expect(out.cancelledByUser).toBe(true);
  });

  it("default sleeper sleeps no longer than requested (bounded real sleep)", async () => {
    const registry = registerWaitTool(new ToolRegistry());
    const out = JSON.parse(
      (await registry.dispatch("wait", JSON.stringify({ ms: 50 }))) as string,
    ) as Record<string, unknown>;
    expect(out.requestedMs).toBe(50);
    expect((out.waitedMs as number) >= 45).toBe(true);
    expect((out.waitedMs as number) < 2_000).toBe(true);
  });

  it("missing required-parameter path uses registry validation (ms is optional)", async () => {
    const registry = makeRegistry({ now: () => 0, sleep: async () => {} });
    expect(registry.get("wait")?.parameters?.required).toBeUndefined();
  });
});
