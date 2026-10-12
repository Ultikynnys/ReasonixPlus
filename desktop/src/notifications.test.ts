import type { FeedbackCueSettings } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import type { FeedbackSoundPlayer } from "./feedback-sounds";
import {
  type ApprovalSnapshot,
  COMPLETION_NOTIFY_MIN_MS,
  cueSetting,
  deriveDesktopNotifications,
  deriveStateCueSounds,
  playEnabledCue,
} from "./notifications";

function emptySnapshot(): ApprovalSnapshot {
  return {
    confirms: [],
    pathAccess: [],
    choices: [],
    plans: [],
    checkpoints: [],
    revisions: [],
  };
}

describe("desktop notifications", () => {
  it("notifies when a new approval request appears while unfocused", () => {
    const next = emptySnapshot();
    next.confirms.push({ id: 1, command: "git push" });
    const cues = { inputRequired: { enabled: true, volume: 0.5, notify: true } };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      cues,
    });

    expect(notifications).toEqual([
      {
        kind: "approval",
        cue: "inputRequired",
        title: "Reasonix+ is waiting for approval",
        body: "Command: git push",
      },
    ]);
  });

  it("does not notify approvals when the window is focused", () => {
    const next = emptySnapshot();
    next.pathAccess.push({ id: 2, path: "/tmp/out.txt", intent: "write" });
    const cues = { inputRequired: { enabled: true, volume: 0.5, notify: true } };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: true,
      cues,
    });

    expect(notifications).toEqual([]);
  });

  it("notifies on long task completion when the window is unfocused", () => {
    const cues = { taskComplete: { enabled: true, volume: 0.5, notify: true } };
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      cues,
    });

    expect(notifications).toEqual([
      {
        kind: "turn_complete",
        cue: "taskComplete",
        title: "Reasonix+ task complete",
        body: "The current task finished and is ready for review.",
      },
    ]);
  });

  it("does not notify on short task completion", () => {
    const cues = { taskComplete: { enabled: true, volume: 0.5, notify: true } };
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS - 1,
      focused: false,
      cues,
    });

    expect(notifications).toEqual([]);
  });

  it("does not notify completion for a stopped turn", () => {
    const cues = { taskComplete: { enabled: true, volume: 0.5, notify: true } };
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      outcome: "stopped",
      cues,
    });

    expect(notifications).toEqual([]);
  });

  it("treats an absent cue matrix as all-off: nothing is derived even unfocused", () => {
    const next = emptySnapshot();
    next.confirms.push({ id: 1, command: "git push" });

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
    });

    expect(notifications).toEqual([]);
  });

  it("derives no notifications when every cue is disabled", () => {
    const next = emptySnapshot();
    next.confirms.push({ id: 1, command: "git push" });
    const cues = {
      inputRequired: { enabled: false, volume: 0.5, notify: false },
      taskComplete: { enabled: false, volume: 0.5, notify: false },
      planComplete: { enabled: false, volume: 0.5, notify: false },
      guardTriggered: { enabled: false, volume: 0.5, notify: false },
    };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      cues,
    });

    expect(notifications).toEqual([]);
  });

  it("derives an approval notification when inputRequired has notify on", () => {
    const next = emptySnapshot();
    next.confirms.push({ id: 1, command: "git push" });
    const cues = {
      inputRequired: { enabled: false, volume: 0.5, notify: true },
    };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      cues,
    });

    expect(notifications).toEqual([
      {
        kind: "approval",
        cue: "inputRequired",
        title: "Reasonix+ is waiting for approval",
        body: "Command: git push",
      },
    ]);
  });

  it("derives a plan_complete notification on the active → finished transition", () => {
    const cues = { planComplete: { enabled: true, volume: 0.5, notify: true } };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      cues,
      previousPlan: { status: "active", totalSteps: 3, completedSteps: 2 },
      currentPlan: { status: "finished", totalSteps: 3, completedSteps: 3 },
      outcome: "stopped",
    });

    expect(notifications).toEqual([
      {
        kind: "plan_complete",
        cue: "planComplete",
        title: "Reasonix+ plan complete",
        body: "Every step of the plan has been completed.",
      },
    ]);
  });

  it("does not derive plan_complete for a cancelled plan or a restore replay", () => {
    const cues = { planComplete: { enabled: true, volume: 0.5, notify: true } };
    const base = {
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      cues,
      outcome: "stopped" as const,
    };

    expect(
      deriveDesktopNotifications({
        ...base,
        previousPlan: { status: "active", totalSteps: 3, completedSteps: 1 },
        currentPlan: { status: "cancelled", totalSteps: 3, completedSteps: 1 },
      }),
    ).toEqual([]);
    expect(
      deriveDesktopNotifications({
        ...base,
        previousPlan: null,
        currentPlan: { status: "finished", totalSteps: 3, completedSteps: 3 },
      }),
    ).toEqual([]);
  });

  it("derives a guard notification for repetition-guard warnings", () => {
    const cues = { guardTriggered: { enabled: true, volume: 0.5, notify: true } };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      cues,
      guardWarnings: [{ cause: "repetition-guard" }],
    });

    expect(notifications).toEqual([
      {
        kind: "guard",
        cue: "guardTriggered",
        title: "Reasonix+ repetition guard fired",
        body: "A degenerating model stream was stopped. Check the transcript for details.",
      },
    ]);
  });

  it("keeps a focused window silent even with every cue enabled", () => {
    const next = emptySnapshot();
    next.confirms.push({ id: 1, command: "git push" });
    const cues = {
      inputRequired: { enabled: true, volume: 1, notify: true },
      taskComplete: { enabled: true, volume: 1, notify: true },
      planComplete: { enabled: true, volume: 1, notify: true },
      guardTriggered: { enabled: true, volume: 1, notify: true },
    };

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: true,
      cues,
      previousPlan: { status: "active", totalSteps: 1, completedSteps: 0 },
      currentPlan: { status: "finished", totalSteps: 1, completedSteps: 1 },
      guardWarnings: [{ cause: "repetition-guard" }],
    });

    expect(notifications).toEqual([]);
  });

  it("cueSetting resolves absent entries to disabled", () => {
    expect(cueSetting(undefined, "inputRequired")).toEqual({
      enabled: false,
      volume: 0.5,
      notify: false,
    });
    expect(cueSetting({}, "taskComplete")).toEqual({
      enabled: false,
      volume: 0.5,
      notify: false,
    });
    expect(
      cueSetting({ taskComplete: { enabled: true, volume: 0.8, notify: true } }, "taskComplete"),
    ).toEqual({
      enabled: true,
      volume: 0.8,
      notify: true,
    });
    // Persisted JSON may omit `notify` (hand-edited / older config); the
    // resolver must treat the missing field as off, not crash.
    const partial = { taskComplete: { enabled: true, volume: 0.8 } } as FeedbackCueSettings;
    expect(cueSetting(partial, "taskComplete")).toEqual({
      enabled: true,
      volume: 0.8,
      notify: false,
    });
  });
});

describe("deriveStateCueSounds — turn/plan transitions to cue ids", () => {
  it("fires taskComplete on a successful long turn end", () => {
    expect(
      deriveStateCueSounds({
        wasBusy: true,
        isBusy: false,
        busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      }),
    ).toEqual(["taskComplete"]);
  });

  it("suppresses taskComplete for short turns and non-success outcomes", () => {
    expect(deriveStateCueSounds({ wasBusy: true, isBusy: false, busyDurationMs: 1_000 })).toEqual(
      [],
    );
    for (const outcome of ["stopped", "failed", "aborted"] as const) {
      expect(
        deriveStateCueSounds({
          wasBusy: true,
          isBusy: false,
          busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
          outcome,
        }),
      ).toEqual([]);
    }
  });

  it("fires planComplete on the active → finished transition only", () => {
    expect(
      deriveStateCueSounds({
        wasBusy: false,
        isBusy: false,
        busyDurationMs: 0,
        previousPlan: { status: "active", totalSteps: 2, completedSteps: 1 },
        currentPlan: { status: "finished", totalSteps: 2, completedSteps: 2 },
      }),
    ).toEqual(["planComplete"]);
    expect(
      deriveStateCueSounds({
        wasBusy: false,
        isBusy: false,
        busyDurationMs: 0,
        previousPlan: { status: "active", totalSteps: 2, completedSteps: 1 },
        currentPlan: { status: "cancelled", totalSteps: 2, completedSteps: 1 },
      }),
    ).toEqual([]);
  });

  it("can report both cues in one pass", () => {
    expect(
      deriveStateCueSounds({
        wasBusy: true,
        isBusy: false,
        busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
        previousPlan: { status: "active", totalSteps: 1, completedSteps: 0 },
        currentPlan: { status: "finished", totalSteps: 1, completedSteps: 1 },
      }),
    ).toEqual(["taskComplete", "planComplete"]);
  });
});

describe("playEnabledCue — the single sound gate", () => {
  function recorder(): { calls: [string, number][]; player: FeedbackSoundPlayer } {
    const calls: [string, number][] = [];
    return {
      calls,
      player: {
        play: (id, volume) => {
          calls.push([id, volume]);
          return true;
        },
      },
    };
  }

  it("plays only enabled cues with an audible volume", () => {
    const { calls, player } = recorder();
    playEnabledCue(
      { taskComplete: { enabled: true, volume: 0.4, notify: false } },
      "taskComplete",
      player,
    );
    playEnabledCue(
      { taskComplete: { enabled: false, volume: 0.4, notify: false } },
      "taskComplete",
      player,
    );
    playEnabledCue(
      { taskComplete: { enabled: true, volume: 0, notify: false } },
      "taskComplete",
      player,
    );
    playEnabledCue(undefined, "taskComplete", player);
    expect(calls).toEqual([["taskComplete", 0.4]]);
  });
});
