/** Spec-array accounting. Every byte of this array ships in every request, so growth is bounded where it is
 *  actually unbounded (MCP bridging) rather than only in tests. */

import type { ToolSpec } from "../types.js";

/** Description plus the serialized parameter schema: the same basis tests/prompt-budget.test.ts asserts. */
export function specBytes(spec: ToolSpec): number {
  // Tolerate a missing description: the type requires it, but a JS caller (or an old fixture) can omit it.
  return (
    (spec.function.description ?? "").length + JSON.stringify(spec.function.parameters ?? {}).length
  );
}

/** Total desc + schema bytes across a spec list. */
export function toolSpecBytes(specs: readonly ToolSpec[]): number {
  let total = 0;
  for (const spec of specs) total += specBytes(spec);
  return total;
}

/** Ceiling for the whole array, sized above the built-in payload to leave room for bridged MCP tools.
 *  tests/prompt-budget.test.ts holds the built-ins under it, so growth there fails loudly. */
export const MAX_TOOL_SPEC_BYTES = 64_000;

/** Env override so a user with many MCP servers can raise the ceiling without a rebuild. */
export function resolveSpecBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.REASONIX_SPEC_BUDGET_BYTES ?? "", 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : MAX_TOOL_SPEC_BYTES;
}

/** The one budget comparison. Callers that already hold committed bytes use this directly. */
export function fitsSpecBudgetBytes(
  used: number,
  cost: number,
  budget: number = resolveSpecBudgetBytes(),
): boolean {
  return used + cost <= budget;
}

/** Same rule expressed in specs, so a caller holding a list cannot drift from the byte form. */
export function fitsSpecBudget(
  current: readonly ToolSpec[],
  next: ToolSpec,
  budget = resolveSpecBudgetBytes(),
): boolean {
  return fitsSpecBudgetBytes(toolSpecBytes(current), specBytes(next), budget);
}
