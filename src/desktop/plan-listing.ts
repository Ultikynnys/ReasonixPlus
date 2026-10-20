import { type PlanHistoryItem, isWorkingPlanStatus } from "@reasonix/core-utils";
import type { PlanSummary } from "../code/plans.js";

/** Projects workspace plan summaries onto the wire shape the sidebar labels and the
 *  plan section render. The stored claim only becomes an owner while the plan is
 *  still worked: a finished, superseded, cancelled or sent-back plan owns nothing. */
export function toPlanHistoryItems(plans: readonly PlanSummary[]): PlanHistoryItem[] {
  return plans.map(({ claim, ...plan }) => ({
    ...plan,
    ownerSession: isWorkingPlanStatus(plan.status) ? claim?.session : undefined,
  }));
}
