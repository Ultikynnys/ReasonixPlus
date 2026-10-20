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

/** The ungated plan tools: no user gate, but they return plan bodies and history — the
 *  on-demand read path. Excluded from subagents too, because a child that can read the
 *  parent's plan will work a task nobody delegated to it. NOTE: not derivable from the
 *  registry's `readOnly` flag, which abandon/activate share while still mutating. */
export const PLAN_UNGATED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_plans",
  "open_plan",
]);

/** Every plan tool, gated or read-only: the set a subagent must never inherit. */
export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...PLAN_INTERACTIVE_TOOL_NAMES,
  ...PLAN_UNGATED_TOOL_NAMES,
]);
