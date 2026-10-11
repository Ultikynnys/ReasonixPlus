/** Defensive arg sanitizers shared by plan-core (tool args) and session-plans
 *  (persisted files + legacy migration). Pure — no registry / pause-gate deps. */

import type { PlanStep, PlanStepRisk, StepEvidence } from "./plan-types.js";

export function sanitizeRisk(raw: unknown): PlanStepRisk | undefined {
  if (raw === "low" || raw === "med" || raw === "high") return raw;
  return undefined;
}

export function sanitizeStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Map one raw step entry to a PlanStep, or null when id/title/action are missing.
 *  `trim` normalizes those three (tool args) vs. preserving them verbatim (persisted files). */
export function coercePlanStep(entry: unknown, opts: { trim: boolean }): PlanStep | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  const text = (value: unknown): string => {
    const s = typeof value === "string" ? value : "";
    return opts.trim ? s.trim() : s;
  };
  const id = text(e.id);
  const title = text(e.title);
  const action = text(e.action);
  if (!id || !title || !action) return null;
  const step: PlanStep = { id, title, action };
  const risk = sanitizeRisk(e.risk);
  if (risk) step.risk = risk;
  const targets = sanitizeStringList(e.targets);
  if (targets) step.targets = targets;
  const acceptance = typeof e.acceptance === "string" ? e.acceptance.trim() : "";
  if (acceptance) step.acceptance = acceptance;
  const verification = sanitizeStringList(e.verification);
  if (verification) step.verification = verification;
  return step;
}

export function sanitizeEvidence(raw: unknown): StepEvidence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StepEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const kind = entry.kind;
    if (kind !== "verification" && kind !== "diff" && kind !== "checkpoint" && kind !== "manual") {
      continue;
    }
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    if (!summary) continue;
    const evidence: StepEvidence = { kind, summary };
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    if (command) evidence.command = command;
    const paths = sanitizeStringList(entry.paths);
    if (paths) evidence.paths = paths;
    out.push(evidence);
  }
  return out.length > 0 ? out : undefined;
}
