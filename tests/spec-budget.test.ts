/** Spec-budget accounting: the ceiling that bounds every request's tool payload. */

import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_SPEC_BYTES,
  fitsSpecBudget,
  resolveSpecBudgetBytes,
  specBytes,
  toolSpecBytes,
} from "../src/tools/spec-budget.js";
import type { ToolSpec } from "../src/types.js";

function spec(
  name: string,
  description: string,
  parameters: Record<string, unknown> = {},
): ToolSpec {
  return { type: "function", function: { name, description, parameters } };
}

describe("spec budget", () => {
  it("counts description plus serialized parameters", () => {
    const parameters = { type: "object", properties: { a: { type: "string" } } };
    expect(specBytes(spec("a", "hello", parameters))).toBe(
      "hello".length + JSON.stringify(parameters).length,
    );
  });

  it("sums across a spec list", () => {
    const specs = [spec("a", "one"), spec("b", "two")];
    expect(toolSpecBytes(specs)).toBe(specBytes(specs[0]!) + specBytes(specs[1]!));
    expect(toolSpecBytes([])).toBe(0);
  });

  it("defaults to the shared ceiling", () => {
    expect(resolveSpecBudgetBytes({})).toBe(MAX_TOOL_SPEC_BYTES);
    expect(MAX_TOOL_SPEC_BYTES).toBe(64_000);
  });

  it("honors REASONIX_SPEC_BUDGET_BYTES", () => {
    expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "8000" })).toBe(8000);
  });

  it("ignores an unparseable or zero override instead of disabling the cap", () => {
    expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "lots" })).toBe(
      MAX_TOOL_SPEC_BYTES,
    );
    expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "0" })).toBe(MAX_TOOL_SPEC_BYTES);
    expect(resolveSpecBudgetBytes({ REASONIX_SPEC_BUDGET_BYTES: "-5" })).toBe(MAX_TOOL_SPEC_BYTES);
  });

  it("is inclusive at the ceiling and exclusive one byte past it", () => {
    const one = spec("a", "12345");
    const cost = specBytes(one);
    expect(fitsSpecBudget([], one, cost)).toBe(true);
    expect(fitsSpecBudget([], one, cost - 1)).toBe(false);
  });

  it("accounts for specs already committed", () => {
    const first = spec("a", "12345");
    const second = spec("b", "12345");
    const budget = specBytes(first) + specBytes(second);
    expect(fitsSpecBudget([first], second, budget)).toBe(true);
    expect(fitsSpecBudget([first], second, budget - 1)).toBe(false);
  });
});
