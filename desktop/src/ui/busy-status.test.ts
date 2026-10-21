import { describe, expect, it } from "vitest";
import {
  type BusyStatusInput,
  busyStatusLabel,
  statusPhase,
  statusWait,
  stuckStatusLabel,
} from "./busy-status";

function input(overrides: Partial<BusyStatusInput> = {}): BusyStatusInput {
  return {
    activeSkill: null,
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    pendingConfirms: [],
    pendingPathAccess: [],
    turnStatus: null,
    turnStatusTool: null,
    turnStatusWait: null,
    ...overrides,
  };
}

describe("statusPhase / statusWait", () => {
  it("maps every model-wait tag onto the waiting-model phase", () => {
    expect(statusPhase("tool-upload")).toBe("waiting_model");
    expect(statusPhase("model-retry")).toBe("waiting_model");
    expect(statusPhase("rate-limit")).toBe("waiting_model");
  });

  it("returns null for an untagged or unknown status so it cannot relabel a phase", () => {
    expect(statusPhase(undefined)).toBeNull();
    expect(statusPhase("some-future-tag" as never)).toBeNull();
  });

  it("keeps the wait numbers of a retry and drops them for a bare upload ping", () => {
    expect(statusWait({ code: "model-retry", attempt: 2, waitMs: 3000 })).toEqual({
      code: "model-retry",
      attempt: 2,
      waitMs: 3000,
    });
    expect(statusWait({ code: "rate-limit", waitMs: 500 })).toEqual({
      code: "rate-limit",
      waitMs: 500,
    });
    expect(statusWait({ code: "tool-upload" })).toBeNull();
    expect(statusWait({})).toBeNull();
  });
});

describe("busyStatusLabel", () => {
  it("names the phase after a tool result as waiting on the model", () => {
    const label = busyStatusLabel(input({ turnStatus: "waiting_model" }));
    expect(label).toContain("Waiting for model");
    // The row must never claim the tool result is still outstanding: by the time
    // this phase is reachable, the result has already landed in the transcript.
    expect(label).not.toContain("tool result");
  });

  it("shows the reported wait instead of the generic phase text", () => {
    expect(
      busyStatusLabel(
        input({
          turnStatus: "waiting_model",
          turnStatusWait: { code: "model-retry", attempt: 2, waitMs: 3000 },
        }),
      ),
    ).toBe("Provider retry · attempt 2 · backoff 3s…");
    expect(
      busyStatusLabel(
        input({ turnStatus: "waiting_model", turnStatusWait: { code: "rate-limit", waitMs: 500 } }),
      ),
    ).toBe("Rate limited · waiting 1s…");
  });

  it("names the running tool while the call is in flight", () => {
    expect(busyStatusLabel(input({ turnStatus: "calling_tool", turnStatusTool: "shell" }))).toBe(
      "Calling tool: shell",
    );
    expect(busyStatusLabel(input({ turnStatus: "calling_tool" }))).toBe("Thinking…");
  });

  it("lets a waiting prompt outrank the turn phase", () => {
    expect(
      busyStatusLabel(
        input({ turnStatus: "waiting_model", pendingChoices: [{ id: 1 }], activeSkill: null }),
      ),
    ).toBe("Waiting for your choice…");
    expect(
      busyStatusLabel(input({ turnStatus: "waiting_model", activeSkill: { name: "deploy" } })),
    ).toBe("Skill · deploy");
  });
});

describe("stuckStatusLabel", () => {
  it("calls silence a stalled model instead of a stuck turn while waiting on the model", () => {
    expect(stuckStatusLabel(input({ turnStatus: "waiting_model" }), 31)).toBe("No tokens for 31s");
  });

  it("keeps the plain stuck hint for every other phase", () => {
    expect(stuckStatusLabel(input({ turnStatus: "responding" }), 31)).toBe(
      "Stuck: no response for 31s",
    );
    expect(stuckStatusLabel(input({ turnStatus: null }), 31)).toBe("Stuck: no response for 31s");
  });
});
