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

/** Ceiling for the built-in tool payload. tests/prompt-budget.test.ts holds the built-ins under it,
 *  so growth there fails loudly. Bridged MCP tools are bounded separately, per server. */
export const MAX_TOOL_SPEC_BYTES = 64_000;

/** Bytes ONE bridged MCP server may add. Per server, never pooled: a pool shared with the
 *  built-in payload and the other servers lets one server defer every tool of the next.
 *  Condensed shipped servers measure ~20 KB (mail) and ~10 KB (browser). */
export const MAX_MCP_SERVER_SPEC_BYTES = 36_000;

function positiveByteOverride(raw: string | undefined): number | null {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}

/** Env override so a user with many MCP servers can raise the ceiling without a rebuild. */
export function resolveSpecBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
  return positiveByteOverride(env.REASONIX_SPEC_BUDGET_BYTES) ?? MAX_TOOL_SPEC_BYTES;
}

/** Per-server bridge allowance. `REASONIX_MCP_SPEC_BUDGET_BYTES` wins, then the older
 *  array-wide `REASONIX_SPEC_BUDGET_BYTES`, so existing overrides keep working. */
export function resolveMcpServerSpecBytes(env: NodeJS.ProcessEnv = process.env): number {
  return (
    positiveByteOverride(env.REASONIX_MCP_SPEC_BUDGET_BYTES) ??
    positiveByteOverride(env.REASONIX_SPEC_BUDGET_BYTES) ??
    MAX_MCP_SERVER_SPEC_BYTES
  );
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
