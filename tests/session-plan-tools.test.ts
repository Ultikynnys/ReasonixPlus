import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
it("creates, inspects, revises and completes one session-owned plan", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const sessionName = "pipeline";
  const created = await tools.dispatch(
    "submit_plan",
    { plan: "Plan", steps: [{ id: "one", title: "First", action: "Do first" }] },
    { sessionName, confirmationGate: gate("approve") },
  );
  const planId = String(created).split("planId: ")[1];
  expect(planId).toBeTruthy();
  expect(JSON.parse(String(await tools.dispatch("list_plans", {}, { sessionName })))[0].id).toBe(
    planId,
  );
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
    { sessionName, confirmationGate: gate("accepted") },
  );
  const rejected = await tools.dispatch(
    "mark_step_complete",
    { planId, stepId: "one", result: "Done" },
    { sessionName, confirmationGate: gate("stop") },
  );
  expect(String(rejected)).toContain("stopped");
  let detail = JSON.parse(String(await tools.dispatch("open_plan", { planId }, { sessionName })));
  expect(detail.completions).toEqual({});
  for (const stepId of ["one", "two"])
    await tools.dispatch(
      "mark_step_complete",
      { planId, stepId, result: "Done", evidence: [{ kind: "verification", summary: "Passed" }] },
      { sessionName, confirmationGate: gate("continue") },
    );
  detail = JSON.parse(String(await tools.dispatch("open_plan", { planId }, { sessionName })));
  expect(detail.status).toBe("completed");
  expect(detail.revisions).toHaveLength(1);
  expect(detail.completions.one.evidence).toHaveLength(1);
  expect(String(await tools.dispatch("open_plan", { planId }, { sessionName: "other" }))).toContain(
    "Unknown plan",
  );
});
it("requires correct plan identity and retains explicit abandonment", async () => {
  const tools = registerPlanTool(new ToolRegistry());
  const sessionName = "abandon";
  const created = await tools.dispatch(
    "submit_plan",
    { plan: "Plan" },
    { sessionName, confirmationGate: gate("approve") },
  );
  const planId = String(created).split("planId: ")[1];
  expect(
    String(
      await tools.dispatch(
        "mark_step_complete",
        { stepId: "one", result: "Done" },
        { sessionName },
      ),
    ),
  ).toContain("planId");
  await tools.dispatch(
    "abandon_plan",
    { planId, reason: "New requirements" },
    { sessionName, confirmationGate: gate("pick", "abandon") },
  );
  expect(
    JSON.parse(String(await tools.dispatch("open_plan", { planId }, { sessionName }))),
  ).toMatchObject({ status: "abandoned", dispositionReason: "New requirements", finishedAt: null });
});
