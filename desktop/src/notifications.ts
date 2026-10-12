import {
  DEFAULT_FEEDBACK_CUES,
  type FeedbackCueId,
  type FeedbackCueSettings,
} from "@reasonix/core-utils";
import type { FeedbackSoundPlayer } from "./feedback-sounds";
import { t } from "./i18n";
import type { TurnOutcome } from "./protocol";

/** Only success (or an absent outcome from an older sidecar) warrants completion
 *  feedback; stopped/failed/aborted turns surface an explanatory stop card instead. */
function isSuccessfulOutcome(outcome: TurnOutcome | null | undefined): boolean {
  return outcome === undefined || outcome === null || outcome === "success";
}

export type ApprovalSnapshot = {
  confirms: { id: number; command: string }[];
  pathAccess: { id: number; path: string; intent: "read" | "write" }[];
  choices: { id: number; question: string }[];
  plans: { id: number; summary?: string; plan: string }[];
  checkpoints: { id: number; title?: string; result: string }[];
  revisions: { id: number; summary?: string; reason: string }[];
};

export type DesktopNotification =
  | { kind: "approval"; cue: FeedbackCueId; title: string; body: string }
  | { kind: "turn_complete"; cue: FeedbackCueId; title: string; body: string }
  | { kind: "plan_complete"; cue: FeedbackCueId; title: string; body: string }
  | { kind: "guard"; cue: FeedbackCueId; title: string; body: string };

/** The plan fields the feedback derivation needs — structurally satisfied by
 *  App's ActivePlan without importing it (notifications must not import App). */
export type PlanFeedbackState = {
  status?: "active" | "finished" | "cancelled" | null;
  totalSteps: number;
  completedSteps: number;
};

/** True on the active → finished transition with every step completed — a
 *  cancelled plan or a restore replay must not fire the completion cue. */
export function isPlanCompletionTransition(
  previous: PlanFeedbackState | null | undefined,
  current: PlanFeedbackState | null | undefined,
): boolean {
  return (
    previous?.status === "active" &&
    current?.status === "finished" &&
    current.totalSteps > 0 &&
    current.completedSteps >= current.totalSteps
  );
}

export const COMPLETION_NOTIFY_MIN_MS = 15_000;

function newestApproval(snapshot: ApprovalSnapshot): DesktopNotification | null {
  const confirm = snapshot.confirms.at(-1);
  if (confirm) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.approvalTitle"),
      body: t("notifications.commandBody", { command: confirm.command }),
    };
  }
  const pathAccess = snapshot.pathAccess.at(-1);
  if (pathAccess) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.approvalTitle"),
      body: t(
        pathAccess.intent === "write" ? "notifications.writeBody" : "notifications.readBody",
        { path: pathAccess.path },
      ),
    };
  }
  const choice = snapshot.choices.at(-1);
  if (choice) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.inputTitle"),
      body: choice.question,
    };
  }
  const plan = snapshot.plans.at(-1);
  if (plan) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.planApprovalTitle"),
      body: plan.summary ?? plan.plan,
    };
  }
  const checkpoint = snapshot.checkpoints.at(-1);
  if (checkpoint) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.checkpointApprovalTitle"),
      body: checkpoint.title ?? checkpoint.result,
    };
  }
  const revision = snapshot.revisions.at(-1);
  if (revision) {
    return {
      kind: "approval",
      cue: "inputRequired",
      title: t("notifications.revisionTitle"),
      body: revision.summary ?? revision.reason,
    };
  }
  return null;
}

export function totalPending(snapshot: ApprovalSnapshot): number {
  return (
    snapshot.confirms.length +
    snapshot.pathAccess.length +
    snapshot.choices.length +
    snapshot.plans.length +
    snapshot.checkpoints.length +
    snapshot.revisions.length
  );
}

/** Resolve one cue's settings through the shared all-off defaults: an absent
 *  entry (or missing field) means disabled — the whole feature is opt-in. */
export function cueSetting(
  cues: FeedbackCueSettings | null | undefined,
  id: FeedbackCueId,
): { enabled: boolean; volume: number; notify: boolean } {
  const fallback = DEFAULT_FEEDBACK_CUES[id];
  const entry = cues?.[id] ?? fallback;
  return {
    enabled: entry?.enabled === true,
    volume: typeof entry?.volume === "number" ? entry.volume : (fallback?.volume ?? 0.5),
    notify: entry?.notify === true,
  };
}

/** Play one cue's sound when the user enabled it and its volume is audible —
 *  the single gate every sound trigger shares. */
export function playEnabledCue(
  cues: FeedbackCueSettings | null | undefined,
  id: FeedbackCueId,
  player: FeedbackSoundPlayer,
): void {
  const setting = cueSetting(cues, id);
  if (setting.enabled && setting.volume > 0) player.play(id, setting.volume);
}

/** Cue ids whose sound is driven by turn/plan state (not a dedicated wire
 *  event): task completion and plan completion. Focus and the notify toggle are
 *  irrelevant to sounds — the caller gates playback on `enabled`. */
export function deriveStateCueSounds(args: {
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  outcome?: TurnOutcome | null;
  previousPlan?: PlanFeedbackState | null;
  currentPlan?: PlanFeedbackState | null;
}): FeedbackCueId[] {
  const cues: FeedbackCueId[] = [];
  if (
    isSuccessfulOutcome(args.outcome) &&
    args.wasBusy &&
    !args.isBusy &&
    args.busyDurationMs >= COMPLETION_NOTIFY_MIN_MS
  ) {
    cues.push("taskComplete");
  }
  if (isPlanCompletionTransition(args.previousPlan, args.currentPlan)) {
    cues.push("planComplete");
  }
  return cues;
}

/** Does ANY cue of these kinds have an enabled sound or notification? Gates
 *  the whole derivation so the default (all off) costs one boolean check. */
function anyCueEnabled(
  cues: FeedbackCueSettings | null | undefined,
  ids: FeedbackCueId[],
): boolean {
  return ids.some((id) => {
    const s = cueSetting(cues, id);
    return s.enabled || s.notify;
  });
}

export function deriveDesktopNotifications(args: {
  previous: ApprovalSnapshot;
  current: ApprovalSnapshot;
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  focused: boolean;
  /** Terminal outcome of the finished turn — non-success suppresses completion noise. */
  outcome?: TurnOutcome | null;
  /** Per-type cue matrix; absent = all off (no sounds, no notifications). */
  cues?: FeedbackCueSettings | null;
  /** Plan rail state on the previous and current render, for the completion cue. */
  previousPlan?: PlanFeedbackState | null;
  /** Plan rail state on the current render. */
  currentPlan?: PlanFeedbackState | null;
  /** High-severity warnings since the last pass, keyed by machine cause.
   *  "repetition-guard" maps to the guardTriggered cue; untagged ones don't cue. */
  guardWarnings?: ReadonlyArray<{ cause?: string }>;
}): DesktopNotification[] {
  const notifications: DesktopNotification[] = [];
  if (args.focused) return notifications;
  if (
    !anyCueEnabled(args.cues, ["inputRequired", "taskComplete", "planComplete", "guardTriggered"])
  ) {
    return notifications;
  }

  if (totalPending(args.current) > totalPending(args.previous)) {
    const approval = newestApproval(args.current);
    if (approval) notifications.push(approval);
  }

  if (
    isSuccessfulOutcome(args.outcome) &&
    args.wasBusy &&
    !args.isBusy &&
    args.busyDurationMs >= COMPLETION_NOTIFY_MIN_MS
  ) {
    notifications.push({
      kind: "turn_complete",
      cue: "taskComplete",
      title: t("notifications.turnCompleteTitle"),
      body: t("notifications.turnCompleteBody"),
    });
  }

  if (isPlanCompletionTransition(args.previousPlan, args.currentPlan)) {
    notifications.push({
      kind: "plan_complete",
      cue: "planComplete",
      title: t("notifications.planCompleteTitle"),
      body: t("notifications.planCompleteBody"),
    });
  }

  if ((args.guardWarnings?.length ?? 0) > 0) {
    notifications.push({
      kind: "guard",
      cue: "guardTriggered",
      title: t("notifications.guardTitle"),
      body: t("notifications.guardBody"),
    });
  }

  return notifications;
}

export function shouldAppendCompletionNotice(args: {
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  focused: boolean;
  /** Terminal outcome of the finished turn — non-success suppresses the success notice. */
  outcome?: TurnOutcome | null;
}): boolean {
  return (
    isSuccessfulOutcome(args.outcome) &&
    args.focused &&
    args.wasBusy &&
    !args.isBusy &&
    args.busyDurationMs >= COMPLETION_NOTIFY_MIN_MS
  );
}

let notificationPermissionAttempted = false;

export async function dispatchDesktopNotifications(
  notifications: DesktopNotification[],
  cues: FeedbackCueSettings | null | undefined,
  deps: {
    isFocused: () => Promise<boolean>;
    isPermissionGranted: () => Promise<boolean>;
    requestPermission: () => Promise<"default" | "denied" | "granted">;
    sendNotification: (note: { title: string; body: string }) => void;
  },
): Promise<void> {
  if (notifications.length === 0) return;
  const focused = await deps.isFocused().catch(() => true);
  if (focused) return;
  // Only cue types with notify:true reach the OS notification center; sounds
  // are dispatched separately (feedback-sounds) and follow enabled instead.
  const notifiable = notifications.filter((n) => cueSetting(cues, n.cue).notify);
  if (notifiable.length === 0) return;

  let granted = await deps.isPermissionGranted().catch(() => false);
  if (!granted && !notificationPermissionAttempted) {
    notificationPermissionAttempted = true;
    const permission = await deps.requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  if (!granted) return;

  for (const note of notifiable) {
    deps.sendNotification({ title: note.title, body: note.body });
  }
}
