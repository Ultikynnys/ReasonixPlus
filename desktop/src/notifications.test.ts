import type { FeedbackCueAudioSetting, FeedbackCueId } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import type { FeedbackSoundPlayer } from "./feedback-sounds";
import {
  type ApprovalSnapshot,
  COMPLETION_NOTIFY_MIN_MS,
  cueAudio,
  deriveDesktopNotifications,
  deriveStateCueSounds,
  notifyEnabled,
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

function emptySnapshotWithConfirm(): ApprovalSnapshot {
  const snapshot = emptySnapshot();
  snapshot.confirms.push({ id: 1, command: "git push" });
  return snapshot;
}

describe("desktop notifications", () => {
  it("notifies when a new approval request appears while unfocused", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshotWithConfirm(),
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      notify: ["inputRequired"],
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

    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: next,
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: true,
      notify: ["inputRequired"],
    });

    expect(notifications).toEqual([]);
  });

  it("notifies on long task completion when the window is unfocused", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      notify: ["taskComplete"],
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
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS - 1,
      focused: false,
      notify: ["taskComplete"],
    });

    expect(notifications).toEqual([]);
  });

  it("does not notify completion for a stopped turn", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      outcome: "stopped",
      notify: ["taskComplete"],
    });

    expect(notifications).toEqual([]);
  });

  it("treats an absent notify list as none: nothing is derived even unfocused", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshotWithConfirm(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
    });

    expect(notifications).toEqual([]);
  });

  it("derives no notifications from an empty notify list", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshotWithConfirm(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      notify: [],
    });

    expect(notifications).toEqual([]);
  });

  it("notifies a cue whose sound is off: notifications are not audio", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshotWithConfirm(),
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      notify: ["inputRequired"],
    });

    expect(notifications.map((note) => note.cue)).toEqual(["inputRequired"]);
  });

  it("derives a plan_complete notification on the active → finished transition", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      notify: ["planComplete"],
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
    const base = {
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: false,
      notify: ["planComplete"] as FeedbackCueId[],
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
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshot(),
      wasBusy: true,
      isBusy: true,
      busyDurationMs: 1_000,
      focused: false,
      notify: ["guardTriggered"],
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

  it("keeps a focused window silent even with every cue notifying", () => {
    const notifications = deriveDesktopNotifications({
      previous: emptySnapshot(),
      current: emptySnapshotWithConfirm(),
      wasBusy: true,
      isBusy: false,
      busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
      focused: true,
      notify: ["inputRequired", "taskComplete", "planComplete", "guardTriggered"],
      previousPlan: { status: "active", totalSteps: 1, completedSteps: 0 },
      currentPlan: { status: "finished", totalSteps: 1, completedSteps: 1 },
      guardWarnings: [{ cause: "repetition-guard" }],
    });

    expect(notifications).toEqual([]);
  });

  it("cueAudio resolves absent entries to silent", () => {
    expect(cueAudio(undefined)).toEqual({ enabled: false, volume: 0.5 });
    expect(cueAudio({ enabled: true, volume: 0.8 })).toEqual({ enabled: true, volume: 0.8 });
    // Persisted JSON may omit `volume` (hand-edited / older config): the resolver
    // must fall back to the shared default, not crash.
    const partial = { enabled: true } as FeedbackCueAudioSetting;
    expect(cueAudio(partial)).toEqual({ enabled: true, volume: 0.5 });
  });

  it("notifyEnabled reads the shared cue list", () => {
    expect(notifyEnabled(undefined, "inputRequired")).toBe(false);
    expect(notifyEnabled([], "inputRequired")).toBe(false);
    expect(notifyEnabled(["inputRequired"], "inputRequired")).toBe(true);
    expect(notifyEnabled(["inputRequired"], "guardTriggered")).toBe(false);
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
  function recorder(): {
    calls: [string, number, string | undefined][];
    player: FeedbackSoundPlayer;
  } {
    const calls: [string, number, string | undefined][] = [];
    return {
      calls,
      player: {
        play: (id, volume, packId) => {
          calls.push([id, volume, packId]);
          return true;
        },
      },
    };
  }

  it("plays only cues this pack enables with an audible volume", () => {
    const { calls, player } = recorder();
    playEnabledCue({ taskComplete: { enabled: true, volume: 0.4 } }, "taskComplete", player, "halo");
    playEnabledCue(
      { taskComplete: { enabled: false, volume: 0.4 } },
      "taskComplete",
      player,
      "halo",
    );
    playEnabledCue({ taskComplete: { enabled: true, volume: 0 } }, "taskComplete", player, "halo");
    playEnabledCue(undefined, "taskComplete", player, "halo");
    expect(calls).toEqual([["taskComplete", 0.4, "halo"]]);
  });

  it("stays silent for a cue the pack has no entry for", () => {
    const { calls, player } = recorder();
    playEnabledCue({ planComplete: { enabled: true, volume: 0.6 } }, "taskComplete", player, "halo");
    expect(calls).toEqual([]);
  });

  it("reads only the pack it is given: another pack's switches never apply", () => {
    const { calls, player } = recorder();
    // `nothing` has no audio entry at all, so a pack configured elsewhere cannot
    // make the silent pack play.
    playEnabledCue({ taskComplete: { enabled: true, volume: 0.9 } }, "taskComplete", player, "nothing");
    expect(calls).toEqual([["taskComplete", 0.9, "nothing"]]);
  });
});
