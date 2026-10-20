import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLAN_INTERACTIVE_TOOL_NAMES,
  PLAN_TOOL_NAMES,
  PLAN_UNGATED_TOOL_NAMES,
} from "@reasonix/core-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PauseGate } from "../src/core/pause-gate.js";
import { ToolRegistry } from "../src/tools.js";
import { registerPlanTool } from "../src/tools/plan.js";
let home: string;
let previous: [string | undefined, string | undefined];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-tools-"));
  previous = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  [process.env.HOME, process.env.USERPROFILE] = previous;
  rmSync(home, { recursive: true, force: true });
});
function gate(type: string, optionId?: string): PauseGate {
  const gate = new PauseGate();
  gate.on((request) => gate.resolve(request.id, { type, optionId } as never));
  return gate;
}

it("plan name sets cover every registered plan tool, so a new one cannot leak to a child", () => {
  const tools = registerPlanTool(new ToolRegistry());
  const all = tools.specs().map((spec) => spec.function.name);
  const gated = all.filter((name) => tools.isUserIntervention(name));

  // Derived from the registry, never hand-listed: an eighth plan tool must fail here
  // rather than silently reach a subagent through NEVER_INHERITED_TOOLS.
  expect(new Set(PLAN_TOOL_NAMES)).toEqual(new Set(all));
  expect(new Set(PLAN_INTERACTIVE_TOOL_NAMES)).toEqual(new Set(gated));
  expect(new Set(PLAN_UNGATED_TOOL_NAMES)).toEqual(new Set(all.filter((n) => !gated.includes(n))));
});
it("creates, inspects, revises and completes one workspace-owned plan", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const workspace = "pipeline";
  const created = await tools.dispatch(
    "submit_plan",
    { plan: "Plan", steps: [{ id: "one", title: "First", action: "Do first" }] },
    { rootDir: workspace, confirmationGate: gate("approve") },
  );
  const planId = String(created).split("planId: ")[1];
  expect(planId).toBeTruthy();
  expect(
    JSON.parse(String(await tools.dispatch("list_plans", {}, { rootDir: workspace })))[0].id,
  ).toBe(planId);
  await tools.dispatch(
    "revise_plan",
    {
      planId,
      reason: "Add check",
      remainingSteps: [
        { id: "one", title: "First", action: "Do first" },
        { id: "two", title: "Check", action: "Verify" },
      ],
    },
    { rootDir: workspace, confirmationGate: gate("accepted") },
  );
  const rejected = await tools.dispatch(
    "mark_step_complete",
    { planId, stepId: "one", result: "Done" },
    { rootDir: workspace, confirmationGate: gate("stop") },
  );
  expect(String(rejected)).toContain("stopped");
  let detail = JSON.parse(
    String(await tools.dispatch("open_plan", { planId }, { rootDir: workspace })),
  );
  expect(detail.completions).toEqual({});
  for (const stepId of ["one", "two"])
    await tools.dispatch(
      "mark_step_complete",
      { planId, stepId, result: "Done", evidence: [{ kind: "verification", summary: "Passed" }] },
      { rootDir: workspace, confirmationGate: gate("continue") },
    );
  detail = JSON.parse(
    String(await tools.dispatch("open_plan", { planId }, { rootDir: workspace })),
  );
  expect(detail.status).toBe("completed");
  expect(detail.revisions).toHaveLength(1);
  expect(detail.completions.one.evidence).toHaveLength(1);
  expect(String(await tools.dispatch("open_plan", { planId }, { rootDir: "other" }))).toContain(
    "Unknown plan",
  );
});
it("requires correct plan identity and retains explicit abandonment", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const workspace = "abandon";
  const created = await tools.dispatch(
    "submit_plan",
    { plan: "Plan" },
    { rootDir: workspace, confirmationGate: gate("approve") },
  );
  const planId = String(created).split("planId: ")[1];
  expect(
    String(
      await tools.dispatch(
        "mark_step_complete",
        { stepId: "one", result: "Done" },
        { rootDir: workspace },
      ),
    ),
  ).toContain("planId");
  await tools.dispatch(
    "abandon_plan",
    { planId, reason: "New requirements" },
    { rootDir: workspace, confirmationGate: gate("pick", "abandon") },
  );
  expect(
    JSON.parse(String(await tools.dispatch("open_plan", { planId }, { rootDir: workspace }))),
  ).toMatchObject({ status: "abandoned", dispositionReason: "New requirements", finishedAt: null });
});
it("activates a non-completed plan and refuses a completed one", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const workspace = "activate-tools";
  const a = await tools.dispatch(
    "submit_plan",
    { plan: "A", steps: [{ id: "one", title: "First", action: "Do first" }] },
    { rootDir: workspace, confirmationGate: gate("approve") },
  );
  const aId = String(a).split("planId: ")[1];
  await tools.dispatch(
    "mark_step_complete",
    { planId: aId, stepId: "one", result: "Done" },
    { rootDir: workspace, confirmationGate: gate("continue") },
  );
  const b = await tools.dispatch(
    "submit_plan",
    { plan: "B" },
    { rootDir: workspace, confirmationGate: gate("approve") },
  );
  const bId = String(b).split("planId: ")[1];

  const activated = JSON.parse(
    String(
      await tools.dispatch(
        "activate_plan",
        { planId: bId },
        { rootDir: workspace, confirmationGate: gate("pick", "activate") },
      ),
    ),
  );
  expect(activated).toMatchObject({ id: bId, status: "active" });

  let refused = "";
  try {
    refused = String(
      await tools.dispatch(
        "activate_plan",
        { planId: aId },
        { rootDir: workspace, confirmationGate: gate("pick", "activate") },
      ),
    );
  } catch (err) {
    refused = String(err);
  }
  expect(refused).toContain("completed");
});
