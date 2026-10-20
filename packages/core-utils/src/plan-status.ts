/** Which plan statuses a session is still driving. The ONE definition shared by the
 *  plan store (takeover gating) and the desktop surfaces (owner labels), so the UI
 *  can never attribute a finished plan to a session that no longer works it. */
export const PLAN_WORKING_STATUSES = ["proposed", "active"] as const;

export type PlanWorkingStatus = (typeof PLAN_WORKING_STATUSES)[number];

/** True while a session is still working the plan: proposed (awaiting approval) or
 *  active. A completed, superseded, cancelled, sent-back or abandoned plan belongs
 *  to nobody, whatever claim it was written with. */
export function isWorkingPlanStatus(status: string): status is PlanWorkingStatus {
  return (PLAN_WORKING_STATUSES as readonly string[]).includes(status);
}
