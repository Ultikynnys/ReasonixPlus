import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PlanRepository, planRepository } from "../src/code/plans.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";
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
/** One loop over `workspace`, optionally with the `add` tool the turn-level tests drive. */
function buildLoop(workspace: string, responses: FakeResponseShape[] = [], withAddTool = false) {
  const fake = makeFakeClient(responses);
  const tools = new ToolRegistry();
  if (withAddTool) {
    tools.register<{ a: number; b: number }, number>({
      name: "add",
      parameters: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
      },
      fn: ({ a, b }) => a + b,
    });
  }
  const loop = new CacheFirstLoop({
    client: fake.client,
    prefix: new ImmutablePrefix({ system: "System", toolSpecs: tools.specs() }),
    model: "deepseek-chat",
    session: workspace,
    // The plan store is workspace-scoped; point the loop at the same workspace
    // the test repository is created for.
    hookCwd: workspace,
    tools,
    stream: false,
  });
  return { loop, captured: fake.captured };
}
function makeLoop(workspace: string): CacheFirstLoop {
  return buildLoop(workspace).loop;
}
/** Exactly the request the loop would send right now — production's own nextRequest. */
function request(loop: CacheFirstLoop): ChatMessage[] {
  return (loop as unknown as { nextRequest(): ChatMessage[] }).nextRequest();
}
const PLAN_NOTE_PREFIX = "Authoritative session plan state";
function isPlanNote(message: ChatMessage): boolean {
  return String(message.content).startsWith(PLAN_NOTE_PREFIX);
}
/** The plan notes carried by one request — at most one at a time. */
function planNotes(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter(isPlanNote);
}
function planNoteIndex(messages: readonly ChatMessage[]): number {
  return messages.findIndex(isPlanNote);
}
/** The `nextStepId` a plan note advertises. */
function nextStepOf(note: ChatMessage): string {
  return /"nextStepId":"([^"]+)"/.exec(String(note.content))?.[1] ?? "";
}
it("rebuilds exact active-plan obligations after a log rewrite and harness recreation", () => {
  const repo = new PlanRepository("active");
  const plan = repo.propose("Full body", [
    { id: "one", title: "First", action: "Do first" },
    { id: "two", title: "Second", action: "Do second" },
  ]);
  repo.verdict(plan.id, "active");
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Accepted" });
  const loop = makeLoop("active");
  loop.log.compactInPlace([{ role: "user", content: "Summary omits all plans" }]);
  const context = String(planNotes(request(loop))[0]?.content);
  expect(context).toContain(plan.id);
  expect(context).toContain('"completedStepIds":["one"]');
  expect(context).toContain('"nextStepId":"two"');
  expect(String(planNotes(request(makeLoop("active")))[0]?.content)).toBe(context);
  expect(request(makeLoop("other")).some((m) => String(m.content).includes(plan.id))).toBe(false);
  repo.abandon(plan.id, "Stop");
  expect(request(loop).some((m) => String(m.content).includes(plan.id))).toBe(false);
});

function addCall(id: string): FakeResponseShape {
  return {
    content: "",
    tool_calls: [{ id, type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } }],
  };
}

/** An active two-step plan in `workspace`, owned by nobody so the loop adopts it. */
function twoStepPlan(workspace: string) {
  const repo = planRepository(workspace);
  const plan = repo.propose("Body", [
    { id: "one", title: "First", action: "Do first" },
    { id: "two", title: "Second", action: "Do second" },
  ]);
  repo.verdict(plan.id, "active");
  return { repo, plan };
}

/** Pull events until the first tool result lands; true when the turn ended first. */
async function stepUntilTool(step: AsyncGenerator<{ role?: string }>): Promise<boolean> {
  for (let next = await step.next(); !next.done; next = await step.next()) {
    if (next.value.role === "tool") return false;
  }
  return true;
}

async function drain(step: AsyncGenerator<{ role?: string }>): Promise<void> {
  for await (const _event of step) {
    // drain
  }
}

it("injects the plan note on the turn's first request, not on every iteration", async () => {
  const workspace = "cadence";
  twoStepPlan(workspace);
  const { loop, captured } = buildLoop(workspace, [addCall("c1"), { content: "done" }], true);
  await drain(loop.step("go"));
  expect(captured).toHaveLength(2);
  expect(planNotes(captured[0]!.messages)).toHaveLength(1);
  // The turn's own query stays the last message; the note sits above it.
  expect(String(captured[0]!.messages.at(-1)?.content)).toBe("go");
  expect(planNotes(captured[1]!.messages)).toHaveLength(0);
});

it("re-injects the note once when a step completes mid-turn", async () => {
  const workspace = "rearm";
  const { repo, plan } = twoStepPlan(workspace);
  const { loop, captured } = buildLoop(
    workspace,
    [addCall("c1"), addCall("c2"), { content: "done" }],
    true,
  );
  const step = loop.step("go");
  expect(await stepUntilTool(step)).toBe(false);
  expect(captured).toHaveLength(1);
  expect(planNotes(captured[0]!.messages)).toHaveLength(1);
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Accepted" });
  await drain(step);
  expect(captured).toHaveLength(3);
  const [rearmed] = planNotes(captured[1]!.messages);
  expect(rearmed ? nextStepOf(rearmed) : "").toBe("two");
  expect(planNotes(captured[2]!.messages)).toHaveLength(0);
});

it("leaves a queued steer last when the note re-injects in the same request", async () => {
  const workspace = "steer-tail";
  const { repo, plan } = twoStepPlan(workspace);
  const { loop, captured } = buildLoop(workspace, [addCall("c1"), { content: "done" }], true);
  const step = loop.step("go");
  expect(await stepUntilTool(step)).toBe(false);
  repo.complete(plan.id, { kind: "step_completed", stepId: "one", result: "Accepted" });
  loop.steer("mid-turn steer: keep the weld pair");
  await drain(step);
  const withSteer = captured.find((req) =>
    req.messages.some((m) => String(m.content).includes("keep the weld pair")),
  );
  expect(withSteer).toBeDefined();
  const messages = withSteer?.messages ?? [];
  expect(String(messages.at(-1)?.content)).toContain("keep the weld pair");
  expect(planNotes(messages)).toHaveLength(1);
  expect(planNoteIndex(messages)).toBe(messages.length - 2);
});
