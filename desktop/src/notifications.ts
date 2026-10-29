import {
  type FeedbackCueAudioSettings,
  type FeedbackCueId,
  resolveFeedbackCueAudio,
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

/** The end of a turn long enough to have been worth waiting for, on a successful outcome:
 *  the one moment task-completion feedback is due. The cue, the desktop notification and
 *  the in-thread notice all read it here, so they cannot drift apart. */
function isCompletionMoment(args: {
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  outcome?: TurnOutcome | null;
}): boolean {
  return (
    isSuccessfulOutcome(args.outcome) &&
    args.wasBusy &&
    !args.isBusy &&
    args.busyDurationMs >= COMPLETION_NOTIFY_MIN_MS
  );
}

/** Play one cue's sound when the active pack enables it and its volume is audible —
 *  the single gate every sound trigger shares. `audio` is the active pack's matrix, so
 *  the pack that plays nothing (no entry for any cue) stays silent. */
export function playEnabledCue(
  audio: FeedbackCueAudioSettings | null | undefined,
  id: FeedbackCueId,
  player: FeedbackSoundPlayer,
  packId: string | undefined,
): void {
  const setting = resolveFeedbackCueAudio(audio?.[id]);
  if (setting.enabled && setting.volume > 0) player.play(id, setting.volume, packId);
}

/** Is this cue switched on for the active pack? The one gate sounds and desktop
 *  notifications share: a cue the pack leaves off neither plays nor notifies. Volume stays
 *  audio-only, so a cue at 0% still notifies. */
export function cueEnabled(
  audio: FeedbackCueAudioSettings | null | undefined,
  id: FeedbackCueId,
): boolean {
  return resolveFeedbackCueAudio(audio?.[id]).enabled;
}

/** Cue ids whose sound is driven by turn/plan state (not a dedicated wire
 *  event): task completion and plan completion. Focus is irrelevant to sounds —
 *  the caller gates playback on the pack's switch. */
export function deriveStateCueSounds(args: {
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  outcome?: TurnOutcome | null;
  previousPlan?: PlanFeedbackState | null;
  currentPlan?: PlanFeedbackState | null;
}): FeedbackCueId[] {
  const cues: FeedbackCueId[] = [];
  if (isCompletionMoment(args)) {
    cues.push("taskComplete");
  }
  if (isPlanCompletionTransition(args.previousPlan, args.currentPlan)) {
    cues.push("planComplete");
  }
  return cues;
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
  /** The active pack's cue matrix: a notification follows the same switch its sound does,
   *  so an absent entry notifies nothing. */
  audio?: FeedbackCueAudioSettings | null;
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

  if (totalPending(args.current) > totalPending(args.previous)) {
    const approval = newestApproval(args.current);
    if (approval) notifications.push(approval);
  }

  if (isCompletionMoment(args)) {
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

  return notifications.filter((note) => cueEnabled(args.audio, note.cue));
}

export function shouldAppendCompletionNotice(args: {
  wasBusy: boolean;
  isBusy: boolean;
  busyDurationMs: number;
  focused: boolean;
  /** Terminal outcome of the finished turn — non-success suppresses the success notice. */
  outcome?: TurnOutcome | null;
}): boolean {
  return args.focused && isCompletionMoment(args);
}

let notificationPermissionAttempted = false;

export async function dispatchDesktopNotifications(
  notifications: DesktopNotification[],
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

  let granted = await deps.isPermissionGranted().catch(() => false);
  if (!granted && !notificationPermissionAttempted) {
    notificationPermissionAttempted = true;
    const permission = await deps.requestPermission().catch(() => "denied" as const);
    granted = permission === "granted";
  }
  if (!granted) return;

  for (const note of notifications) {
    deps.sendNotification({ title: note.title, body: note.body });
  }
}
