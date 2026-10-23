import { type PlanHistoryItem, isWorkingPlanStatus } from "@reasonix/core-utils";

/** What a session's plan badge says about the plan it owns. Only a plan the
 *  session is still working has an owner, so every label here is in flight, and
 *  the sidebar chips one only while that session is actually running. */
export type SessionPlanLabel = {
  /** 1-based index in the plan-history list — the same number the plan section
   *  shows, so a badge and a history row can be matched by eye. */
  index: number;
  status: string;
  summary?: string;
};

/** The working plan of every owner, keyed by session. The history is workspace-wide
 *  and newest-first, so the first entry seen for a session is its newest in-flight
 *  plan. A finished plan belongs to nobody, and claiming otherwise would attribute
 *  it to a session that no longer works it. */
function ownedPlans(
  history: readonly PlanHistoryItem[],
): Map<string, { index: number; plan: PlanHistoryItem }> {
  const owned = new Map<string, { index: number; plan: PlanHistoryItem }>();
  history.forEach((plan, position) => {
    const owner = plan.ownerSession;
    if (!owner || !isWorkingPlanStatus(plan.status) || owned.has(owner)) return;
    owned.set(owner, { index: position + 1, plan });
  });
  return owned;
}

/** Maps a session name to the plan it is working, for the sidebar's badge. The map
 *  covers every session of the workspace, so it stays valid whichever session the
 *  tab is currently showing. */
export function planLabelsBySession(
  history: readonly PlanHistoryItem[],
): Map<string, SessionPlanLabel> {
  return new Map(
    [...ownedPlans(history)].map(([owner, { index, plan }]) => [
      owner,
      { index, status: plan.status, summary: plan.summary },
    ]),
  );
}

/** The id of the plan `session` is working, or undefined when it owns none — the
 *  plan the plan section opens on, so a session never shows another session's plan. */
export function planIdForSession(
  history: readonly PlanHistoryItem[],
  session: string | undefined,
): string | undefined {
  return session ? ownedPlans(history).get(session)?.plan.id : undefined;
}
