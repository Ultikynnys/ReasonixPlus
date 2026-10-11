import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionPlanRepository } from "../src/code/session-plans.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage } from "../src/types.js";
import { makeFakeClient } from "./support/fake-client.js";
let home: string;
let previous: [string | undefined, string | undefined];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "loop-plan-"));
  previous = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  [process.env.HOME, process.env.USERPROFILE] = previous;
  rmSync(home, { recursive: true, force: true });
});
function makeLoop(session: string) {
  return new CacheFirstLoop({
    client: makeFakeClient([]).client,
    prefix: new ImmutablePrefix({ system: "System" }),
    model: "deepseek-chat",
    session,
    stream: false,
  });
}
function request(loop: CacheFirstLoop) {
  return (loop as unknown as { buildMessages(): ChatMessage[] }).buildMessages();
}
it("rebuilds exact active-plan obligations after log compaction and harness recreation", () => {
  const repo = new SessionPlanRepository("active");
  const plan = repo.propose("Full body", [
    { id: "one", title: "First", action: "Do first" },
    { id: "two", title: "Second", action: "Do second" },
  ]);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Accepted" });
  const loop = makeLoop("active");
  loop.log.compactInPlace([{ role: "user", content: "Summary omits all plans" }]);
  const context = String(request(loop).at(-1)?.content);
  expect(context).toContain(plan.id);
  expect(context).toContain('"completedStepIds":["one"]');
  expect(context).toContain('"nextStepId":"two"');
  expect(String(request(makeLoop("active")).at(-1)?.content)).toBe(context);
  expect(request(makeLoop("other")).some((m) => String(m.content).includes(plan.id))).toBe(false);
  repo.abandon(plan.id, "Stop");
  expect(request(loop).some((m) => String(m.content).includes(plan.id))).toBe(false);
});
