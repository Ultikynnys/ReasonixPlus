import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { restorePlanForTab } from "../src/cli/commands/desktop.js";
import { sessionPlanRepository } from "../src/code/session-plans.js";

let home: string;
let previous: [string | undefined, string | undefined];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-restore-"));
  previous = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  [process.env.HOME, process.env.USERPROFILE] = previous;
  rmSync(home, { recursive: true, force: true });
});

it("projects the active plan for a healthy session", () => {
  const session = "healthy";
  const repository = sessionPlanRepository(session);
  const plan = repository.propose("Ship it", [{ id: "one", title: "First", action: "Do first" }]);
  repository.verdict(plan.id, "active");

  const event = restorePlanForTab({ currentSession: session }, true);
  expect(event).toMatchObject({ type: "$plan_restored", status: "active" });
  expect(event?.steps.map((s) => s.id)).toEqual(["one"]);
});

it("never throws on a corrupt plan store — degrades to no active plan", () => {
  const session = "corrupt";
  const repository = sessionPlanRepository(session);
  repository.propose("Plan");
  // The store deliberately fails closed; the daemon projection must still survive.
  writeFileSync(repository.path, "not valid json");

  let event: ReturnType<typeof restorePlanForTab>;
  expect(() => {
    event = restorePlanForTab({ currentSession: session }, true);
  }).not.toThrow();
  expect(event!).toBeNull();
});

it("returns null without a session or prior messages", () => {
  expect(restorePlanForTab({ currentSession: "" }, true)).toBeNull();
  expect(restorePlanForTab({ currentSession: "anything" }, false)).toBeNull();
});
