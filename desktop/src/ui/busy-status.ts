import type { KernelStatusCode } from "@reasonix/core-utils";
import { t } from "../i18n";

/** Live phase of the running turn — what the agent is doing right now. */
export type TurnStatus =
  | "thinking"
  | "reasoning"
  | "calling_tool"
  | "waiting_model"
  | "responding"
  | "waiting_user";

/** A wait the daemon reported on the current model call, before its first byte. */
export interface StatusWait {
  code: Exclude<KernelStatusCode, "tool-upload">;
  attempt?: number;
  waitMs?: number;
}

/** The phase a tagged `status` event describes. Untagged and unknown tags return
 *  null: a newer daemon tag must not relabel a phase this client can't name. */
export function statusPhase(code: KernelStatusCode | undefined): "waiting_model" | null {
  switch (code) {
    case "tool-upload":
    case "model-retry":
    case "rate-limit":
      return "waiting_model";
    default:
      return null;
  }
}

/** The wait a tagged `status` event reported, or null when it names none. */
export function statusWait(ev: {
  code?: KernelStatusCode;
  attempt?: number;
  waitMs?: number;
}): StatusWait | null {
  if (ev.code !== "model-retry" && ev.code !== "rate-limit") return null;
  return {
    code: ev.code,
    ...(ev.attempt !== undefined ? { attempt: ev.attempt } : {}),
    ...(ev.waitMs !== undefined ? { waitMs: ev.waitMs } : {}),
  };
}

function waitSec(wait: StatusWait): number {
  return Math.max(1, Math.round((wait.waitMs ?? 0) / 1000));
}

/** Everything the status row reads. Structural on purpose: the reducer's state
 *  satisfies it, so there is no second copy of these fields to keep in sync. */
export interface BusyStatusInput {
  activeSkill: { name: string } | null;
  pendingChoices: readonly unknown[];
  pendingPlans: readonly unknown[];
  pendingCheckpoints: readonly unknown[];
  pendingRevisions: readonly unknown[];
  pendingConfirms: readonly unknown[];
  pendingPathAccess: readonly unknown[];
  turnStatus: TurnStatus | null;
  turnStatusTool: string | null;
  turnStatusWait: StatusWait | null;
}

/** The status row above the composer. A waiting prompt always outranks the turn
 *  phase: the agent is blocked on the user, not on the model. */
export function busyStatusLabel(state: BusyStatusInput): string {
  if (state.activeSkill) return `Skill · ${state.activeSkill.name}`;
  if (state.pendingChoices.length > 0) return t("app.status.waitingChoice");
  if (state.pendingPlans.length > 0) return t("app.status.waitingPlan");
  if (state.pendingCheckpoints.length > 0) return t("app.status.waitingCheckpoint");
  if (state.pendingRevisions.length > 0) return t("app.status.waitingRevision");
  if (state.pendingConfirms.length > 0 || state.pendingPathAccess.length > 0) {
    return t("app.status.waitingConfirm");
  }
  switch (state.turnStatus) {
    case "waiting_user":
      return t("app.status.waitingUser");
    case "calling_tool":
      return state.turnStatusTool
        ? `${t("app.status.callingTool")} ${state.turnStatusTool}`
        : t("app.status.thinking");
    case "reasoning":
      return t("app.status.reasoning");
    case "responding":
      return t("app.status.responding");
    case "waiting_model": {
      const wait = state.turnStatusWait;
      if (wait?.code === "model-retry") {
        return t("app.status.retrying", { attempt: wait.attempt ?? 1, sec: waitSec(wait) });
      }
      if (wait?.code === "rate-limit") return t("app.status.rateLimitWait", { sec: waitSec(wait) });
      return t("app.status.waitingModel");
    }
    default:
      return t("app.status.thinking");
  }
}

/** The silence hint. "Stuck" only fits a phase that stopped producing output on
 *  its own; while the daemon waits on the model, silence is expected and named. */
export function stuckStatusLabel(state: BusyStatusInput, sec: number): string {
  return state.turnStatus === "waiting_model"
    ? t("app.status.modelSilent", { sec })
    : t("app.status.stuck", { sec });
}
