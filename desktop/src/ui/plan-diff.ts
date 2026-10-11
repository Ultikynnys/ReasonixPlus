/** Diff a `revise_plan` rewrite against the plan's current remaining steps, so
 *  the revision card can show exactly which steps were added, changed or dropped. */

import type { PlanStep } from "@reasonix/core-utils";

export type PlanStepChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface PlanStepFieldChange {
  field: "title" | "action" | "risk";
  from: string;
  to: string;
}

export interface PlanStepDiffRow {
  kind: PlanStepChangeKind;
  step: PlanStep;
  /** Present only on `changed` rows: the fields that differ, before → after. */
  fields?: PlanStepFieldChange[];
}

export interface PlanStepDiffCounts {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/** Unset risk reads as "low" so adding an explicit `low` isn't reported as a change. */
const riskOf = (step: PlanStep): string => step.risk ?? "low";

/** Walk the new step list in order (adding / changing / keeping), then append the
 *  steps that were dropped, so a removal is visible instead of silently absent. */
export function diffPlanSteps(previous: PlanStep[], next: PlanStep[]): PlanStepDiffRow[] {
  const before = new Map(previous.map((step) => [step.id, step]));
  const nextIds = new Set(next.map((step) => step.id));
  const rows: PlanStepDiffRow[] = [];
  for (const step of next) {
    const prior = before.get(step.id);
    if (!prior) {
      rows.push({ kind: "added", step });
      continue;
    }
    const fields: PlanStepFieldChange[] = [];
    if (prior.title !== step.title)
      fields.push({ field: "title", from: prior.title, to: step.title });
    if (prior.action !== step.action)
      fields.push({ field: "action", from: prior.action, to: step.action });
    if (riskOf(prior) !== riskOf(step))
      fields.push({ field: "risk", from: riskOf(prior), to: riskOf(step) });
    rows.push(fields.length > 0 ? { kind: "changed", step, fields } : { kind: "unchanged", step });
  }
  for (const step of previous) if (!nextIds.has(step.id)) rows.push({ kind: "removed", step });
  return rows;
}

export function countPlanStepDiff(rows: readonly PlanStepDiffRow[]): PlanStepDiffCounts {
  const counts: PlanStepDiffCounts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}
