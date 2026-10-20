import { type PlanHistoryItem, isWorkingPlanStatus } from "@reasonix/core-utils";

/** What a session's plan badge says about the plan it owns. Only a plan the
 *  session is still working has an owner, so every label here is in flight. */
export type SessionPlanLabel = {
  /** 1-based index in the plan-history list — the same number the plan section
   *  shows, so a badge and a history row can be matched by eye. */
  index: number;
  status: string;
  summary?: string;
};

/** Maps a session name to the plan it is working, for the sidebar's badge. The
 *  history is workspace-wide and newest-first, so the first entry seen for a
 *  session is its newest in-flight plan. A finished plan is skipped: it belongs
 *  to nobody, and claiming otherwise would label a session that has no plan. */
export function planLabelsBySession(
  history: readonly PlanHistoryItem[],
): Map<string, SessionPlanLabel> {
  const labels = new Map<string, SessionPlanLabel>();
  history.forEach((plan, position) => {
    const owner = plan.ownerSession;
    if (!owner || !isWorkingPlanStatus(plan.status)) return;
    if (labels.has(owner)) return;
    labels.set(owner, { index: position + 1, status: plan.status, summary: plan.summary });
  });
  return labels;
}
