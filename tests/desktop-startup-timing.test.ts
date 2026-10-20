import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../desktop/src/diagnostics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/src/diagnostics")>();
  return { ...actual, recordFrontendDiagnostic: vi.fn() };
});

import { recordFrontendDiagnostic } from "../desktop/src/diagnostics";
import { StartupTimingTracker } from "../desktop/src/startup-timing";

const record = vi.mocked(recordFrontendDiagnostic);

describe("StartupTimingTracker", () => {
  beforeEach(() => {
    record.mockClear();
  });

  it("tracks step deltas and cumulative time", () => {
    const tracker = new StartupTimingTracker(100);

    const step1 = tracker.mark("step_1", { details: { key: "val" } });
    expect(step1.step).toBe("step_1");
    expect(step1.deltaMs).toBeGreaterThanOrEqual(0);
    expect(step1.cumulativeMs).toBeGreaterThanOrEqual(0);
    // Per-step marks stay out of the diagnostics sink: that flood is what the console
    // carried before, and one event per mark is exactly what got removed.
    expect(record).not.toHaveBeenCalled();

    tracker.finish("all_workspaces_ready");

    expect(record).toHaveBeenCalledTimes(1);
    const [event, details, level] = record.mock.calls[0] ?? [];
    expect(event).toBe("frontend.throbber_dismissed");
    expect(details).toMatchObject({ reason: "all_workspaces_ready" });
    expect(level).toBe("info");
  });

  it("reports the dismissal exactly once per boot", () => {
    const tracker = new StartupTimingTracker(100);
    tracker.finish("focused_workspace_initialized");
    tracker.finish("all_workspaces_initialized");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[1]).toMatchObject({
      reason: "focused_workspace_initialized",
    });
  });

  it("logs a loading failure as an error, once", () => {
    const tracker = new StartupTimingTracker(100);
    tracker.fail("rpc_exit", { code: 1 });
    tracker.fail("rpc_exit", { code: 1 });

    expect(record).toHaveBeenCalledTimes(1);
    const [event, details, level] = record.mock.calls[0] ?? [];
    expect(event).toBe("frontend.loading_failed");
    expect(details).toMatchObject({ reason: "rpc_exit", code: 1 });
    expect(level).toBe("error");
  });
});
