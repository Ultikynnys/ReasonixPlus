/** Plan tools that pause for a user gate and mutate the plan repository
 *  (list_plans/open_plan are read-only). Shared source of truth for the daemon
 *  re-projection, the transcript's gated set, and subagent non-inheritance. */
export const PLAN_INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "submit_plan",
  "mark_step_complete",
  "revise_plan",
  "abandon_plan",
  "activate_plan",
]);
