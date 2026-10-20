/** Subagent tool — registration, child-loop isolation, fork-registry exclusion, abort propagation, plan-mode inheritance. */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeepSeekClient, Usage } from "../src/client.js";
import { planRepository } from "../src/code/plans.js";
import { PauseGate } from "../src/core/pause-gate.js";
import { CacheFirstLoop } from "../src/loop.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { estimateRequestTokens } from "../src/tokenizer.js";
import { ToolRegistry } from "../src/tools.js";
import { registerPlanTool } from "../src/tools/plan.js";
import {
  NEVER_INHERITED_TOOLS,
  type SubagentEvent,
  type SubagentResult,
  type SubagentSink,
  childLoopOptions,
  forkRegistryExcluding,
  forkRegistryWithAllowList,
  formatSubagentResult,
  registerSubagentTool,
  spawnSubagent,
  subagentBudgetHint,
} from "../src/tools/subagent.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";
import { MATERIAL_REASONING_LOOP } from "./support/repetition-fixtures.js";

function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
  return makeFakeClient(responses, { echoMessages: true }).client;
}

function makeToolCallResponses(n: number): FakeResponseShape[] {
  return Array.from({ length: n }, (_, i) => ({
    content: "",
    tool_calls: [
      {
        id: `call_${i + 1}`,
        type: "function",
        function: { name: "noop", arguments: JSON.stringify({ i: i + 1 }) },
      },
    ],
  }));
}

/** Approves every gate the plan tools raise, so a plan can be created in a test. */
function approvingGate(): PauseGate {
  const gate = new PauseGate();
  gate.on((request) => gate.resolve(request.id, { type: "approve" } as never));
  return gate;
}

function makeSink(): { sink: SubagentSink; events: SubagentEvent[] } {
  const events: SubagentEvent[] = [];
  const sink: SubagentSink = {
    current: (ev) => {
      events.push(ev);
    },
  };
  return { sink, events };
}

describe("registerSubagentTool", () => {
  it("registers spawn_subagent into the parent registry", () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "ok" }]);
    registerSubagentTool(parent, { client });
    expect(parent.has("spawn_subagent")).toBe(true);
  });

  it("returns a structured success payload with the subagent's final answer", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "the answer is 42" }]);
    registerSubagentTool(parent, { client });
    const out = await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "what is the answer?" }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("the answer is 42");
    expect(parsed.turns).toBe(1);
    expect(parsed.tool_iters).toBe(0);
    expect(typeof parsed.elapsed_ms).toBe("number");
  });

  it("rejects an empty task with a structured error", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "won't be called" }]);
    registerSubagentTool(parent, { client });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "   \n  " }));
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/non-empty 'task'/);
  });

  it("emits start → end events through the sink", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "done" }]);
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "this task is over thirty characters long" }),
    );
    expect(events[0]?.kind).toBe("start");
    expect(events[events.length - 1]?.kind).toBe("end");
    // The start event carries the instruction WHOLE: the card that shows the
    // run must show what the child was actually asked to do.
    expect(events[0]?.task).toBe("this task is over thirty characters long");
    // end event carries the summary + turn count
    const end = events[events.length - 1]!;
    expect(end.summary).toBe("done");
    expect(end.turns).toBe(1);
    expect(end.error).toBeUndefined();
    // 0.5.14: end event also carries cost, model, and aggregate usage
    // so the sink can write a subagent row to the usage log without
    // recomputing anything.
    expect(end.model).toBeTruthy();
    expect(end.usage).toBeDefined();
    expect(end.usage?.promptTokens).toBeGreaterThan(0);
    expect(end.costUsd).toBeGreaterThan(0);
  });

  it("emits a progress event for each tool result inside the child loop", async () => {
    const parent = new ToolRegistry();
    parent.register({
      name: "noop",
      readOnly: true,
      fn: () => "noop-result",
    });
    const client = makeClient([
      {
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "noop", arguments: "{}" },
          },
        ],
      },
      { content: "all done" },
    ]);
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "use noop" }));
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.length).toBe(1);
    expect(progress[0]?.iter).toBe(1);
  });

  it("enforces maxToolIters and returns a partial budget result", async () => {
    const parent = new ToolRegistry();
    let calls = 0;
    parent.register({
      name: "noop",
      readOnly: true,
      fn: () => {
        calls++;
        return "ok";
      },
    });
    const client = makeClient([
      ...makeToolCallResponses(3),
      { content: "Partial review from the evidence already collected." },
    ]);
    const { sink, events } = makeSink();
    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "review",
      task: "review",
      maxToolIters: 2,
      sink,
    });
    expect(calls).toBe(2);
    expect(result.success).toBe(false);
    expect(result.budgetExhausted).toBe("tool-iters");
    expect(result.toolIters).toBe(2);
    expect(result.output).toContain("Partial review");
    expect(JSON.parse(formatSubagentResult(result))).toMatchObject({
      partial: true,
      budget_exhausted: "tool-iters",
      max_tool_iters: 2,
    });
    expect(events.at(-1)).toMatchObject({
      kind: "end",
      budgetExhausted: "tool-iters",
      maxToolIters: 2,
    });
  });

  it("stops and trims a degenerating streamed child response", async () => {
    let requestSignal: AbortSignal | undefined;
    const repeated = MATERIAL_REASONING_LOOP.repeat(4);
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      const frames = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: `Verified findings. ${repeated}` } }] })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const body = new ReadableStream({
        start(ctrl) {
          for (const frame of frames) ctrl.enqueue(new TextEncoder().encode(frame));
          ctrl.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const { sink, events } = makeSink();
    const result = await spawnSubagent({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: fetchMock as typeof fetch }),
      parentRegistry: new ToolRegistry(),
      system: "review",
      task: "review",
      sink,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.output).toBe("Verified findings. ");
    expect(result.output).not.toContain("blaze_eye_R.vmt");
    expect(
      events.some(
        (event) =>
          event.kind === "inner" &&
          event.inner?.role === "warning" &&
          event.inner.content.includes("Stopped a degenerating model stream"),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "end",
      summary: "Verified findings. ",
    });
  });

  it("enforces maxElapsedMs for a hanging child request", async () => {
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: (await import("./support/fake-client.js")).neverResolvingFetch(),
      retry: { maxAttempts: 1 },
    });
    const started = Date.now();
    const result = await spawnSubagent({
      client,
      parentRegistry: new ToolRegistry(),
      system: "review",
      task: "review",
      maxElapsedMs: 25,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.success).toBe(false);
    expect(result.budgetExhausted).toBe("elapsed");
    expect(result.error).toMatch(/time budget exhausted/);
  });

  it("surfaces a child-loop error in the structured result + end event", async () => {
    const parent = new ToolRegistry();
    // 401 from the fake fetch → DeepSeekClient throws inside the child step()
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async () => new Response("unauthorized", { status: 401 })) as any,
      retry: { maxAttempts: 1 },
    });
    const { sink, events } = makeSink();
    registerSubagentTool(parent, { client, sink });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "fail please" }));
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeTruthy();
    const end = events[events.length - 1]!;
    expect(end.kind).toBe("end");
    expect(end.error).toBeTruthy();
    expect(end.summary).toBeUndefined();
  });

  it("truncates oversized output and signals the truncation", async () => {
    const parent = new ToolRegistry();
    const huge = Array.from({ length: 2_000 }, (_, i) => `result-${i}: verified\n`).join("");
    const client = makeClient([{ content: huge }]);
    registerSubagentTool(parent, { client, maxResultChars: 100 });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "spew" }));
    const parsed = JSON.parse(out);
    expect(parsed.output.length).toBeLessThan(huge.length);
    expect(parsed.output).toMatch(/truncated/);
  });

  it("never registers spawn_subagent itself into the child registry (no recursion)", async () => {
    // We can't easily peek at the child registry from outside the tool,
    // but we CAN observe the child loop's prefix.toolSpecs via the
    // request body the fake fetch sees. Tools advertised in the request
    // are exactly the child registry's specs.
    const parent = new ToolRegistry();
    parent.register({ name: "harmless", readOnly: true, fn: () => "ok" });
    parent.register({ name: "submit_plan", readOnly: true, fn: () => "ok" });
    const seenToolNames: string[][] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
        seenToolNames.push(tools.map((t) => t.function.name));
        // The child loop streams (stream: true) — a non-SSE body parses to
        // zero frames and looks like an empty completion, tripping the loop's
        // empty-response retry and doubling the call count.
        if (body.stream === true) {
          const frames = [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "fine" } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ];
          return new Response(new TextEncoder().encode(frames.join("")), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "fine" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    registerSubagentTool(parent, { client });
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "go" }));
    expect(seenToolNames.length).toBe(1);
    const childTools = seenToolNames[0]!;
    // Inherited the harmless tool, but NOT spawn_subagent or submit_plan.
    expect(childTools).toContain("harmless");
    expect(childTools).not.toContain("spawn_subagent");
    expect(childTools).not.toContain("submit_plan");
  });

  it("respects a custom system prompt passed in the tool args", async () => {
    const seenSystems: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const sys = (body.messages ?? []).find((m: any) => m.role === "system");
        if (sys) seenSystems.push(sys.content);
        return new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "go", system: "You are a custom subagent." }),
    );
    expect(seenSystems[0]).toContain("You are a custom subagent.");
  });

  it("falls back to the default model when the model arg is invalid", async () => {
    const seenModels: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        seenModels.push(body.model);
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    // Only known model namespaces (deepseek-*, gpt-*) pass the args guard —
    // an id from neither must fall back to the default.
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "go", model: "claude-sonnet" }));
    // Subagent default was pro pre-0.6; now flash to keep explore/research
    // cheap. Skill frontmatter `model:` is the opt-in override for skills
    // that empirically benefit from pro.
    expect(seenModels[0]).toBe("deepseek-flash");
  });

  it("aborts the child when the parent's tool ctx signal fires", async () => {
    const parent = new ToolRegistry();
    // Slow client — sleeps 200ms before responding so the abort beats it.
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const signal: AbortSignal | undefined = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
      retry: { maxAttempts: 1 },
    });
    registerSubagentTool(parent, { client });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "slow" }), {
      signal: ctrl.signal,
    });
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(false);
  });

  it("aborts the child when the per-tool cancelSignal fires", async () => {
    const parent = new ToolRegistry();
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const signal: AbortSignal | undefined = init?.signal;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
      retry: { maxAttempts: 1 },
    });
    registerSubagentTool(parent, { client });
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 20);

    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "slow" }), {
      cancelSignal: cancel.signal,
    });

    expect(JSON.parse(out).success).toBe(false);
  });

  it("honors a parentSignal that was already aborted at dispatch time", async () => {
    // Race we previously dropped on the floor: parent.abort() fires
    // before spawn_subagent's listener attach runs. addEventListener
    // doesn't replay abort events for already-aborted signals, so the
    // listener stayed silent forever and the child ran free until it
    // hit its iter budget. Fix: synchronously check `.aborted` at
    // attach and forward immediately to childLoop.abort(), and have
    // step() carry the aborted state across its _turnAbort reset.
    const parent = new ToolRegistry();
    let fetchCalls = 0;
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      // If the abort propagation works, fetch is never called — the
      // child loop bails at iter 0 because its signal is already
      // aborted before the API call site is reached.
      fetch: vi.fn(async () => {
        fetchCalls++;
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "late" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
      retry: { maxAttempts: 1 },
    });
    registerSubagentTool(parent, { client });
    const ctrl = new AbortController();
    ctrl.abort(); // already aborted before dispatch is even called
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "x" }), {
      signal: ctrl.signal,
    });
    const parsed = JSON.parse(out);
    // Central dispatch now refuses an already-aborted call before the tool
    // runs (issue #1236); the subagent's own iter-0 bail is the fallback
    // for late aborts. Either shape proves no API call was made.
    expect(parsed.rejectedReason === "aborted" || parsed.success === false).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("type=explore uses the explore persona", async () => {
    const seenSystems: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const sys = (body.messages ?? []).find((m: any) => m.role === "system");
        if (sys) seenSystems.push(sys.content);
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "find all callers of foo()", type: "explore" }),
    );
    expect(seenSystems[0]).toMatch(/exploration subagent/);
  });

  it("explicit system overrides the type's default prompt", async () => {
    const seenSystems: string[] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: any, init: any) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const sys = (body.messages ?? []).find((m: any) => m.role === "system");
        if (sys) seenSystems.push(sys.content);
        return new Response(
          JSON.stringify({
            choices: [
              { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as any,
    });
    const parent = new ToolRegistry();
    registerSubagentTool(parent, { client });
    await parent.dispatch(
      "spawn_subagent",
      JSON.stringify({ task: "go", type: "explore", system: "I am a custom prompt." }),
    );
    expect(seenSystems[0]).toContain("I am a custom prompt.");
  });

  it("fires onSpawnComplete once per dispatch with the full SubagentResult", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "noop-result" });
    const client = makeClient([{ content: "the distilled answer" }]);
    const captured: { output: string; costUsd: number; usage: { completionTokens: number } }[] = [];
    registerSubagentTool(parent, {
      client,
      onSpawnComplete: (result) => {
        captured.push({
          output: result.output,
          costUsd: result.costUsd,
          usage: { completionTokens: result.usage.completionTokens },
        });
      },
    });
    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "say something" }));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.output).toBe("the distilled answer");
    expect(captured[0]!.usage.completionTokens).toBeGreaterThan(0);
  });

  it("does not propagate onSpawnComplete errors out of the spawn tool dispatch", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "noop-result" });
    const client = makeClient([{ content: "ok" }]);
    registerSubagentTool(parent, {
      client,
      onSpawnComplete: () => {
        throw new Error("telemetry boom");
      },
    });
    const out = await parent.dispatch("spawn_subagent", JSON.stringify({ task: "anything" }));
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("ok");
  });
});

describe("subagentBudgetHint", () => {
  it("stays silent on the first spawn of a session", () => {
    expect(subagentBudgetHint(1, 120)).toBeNull();
  });

  it("emits the soft note from the second spawn through the fourth", () => {
    expect(subagentBudgetHint(2, 240)).toMatch(/\[note: this session has spawned 2 subagents/);
    expect(subagentBudgetHint(4, 480)).toMatch(/\[note: this session has spawned 4 subagents/);
  });

  it("escalates to the strong budget hint past five spawns", () => {
    const out = subagentBudgetHint(5, 600);
    expect(out).toMatch(/\[budget: this session has now spawned 5 subagents/);
    expect(out).toMatch(/parallel fan-out or >10-read context blow-up/);
  });

  it("escalates to the strong hint when cumulative tokens cross 50k even at low spawn count", () => {
    const out = subagentBudgetHint(2, 60_000);
    expect(out).toMatch(
      /\[budget: this session has now spawned 2 subagents totalling 60000 tokens/,
    );
  });
});

describe("registerSubagentTool — per-session budget feedback", () => {
  it("appends nothing on the first spawn, the soft note on the second, and the strong hint on the fifth", async () => {
    const parent = new ToolRegistry();
    const client = makeClient([{ content: "answer" }]);
    registerSubagentTool(parent, { client });

    const outs: string[] = [];
    for (let i = 0; i < 5; i++) {
      outs.push(await parent.dispatch("spawn_subagent", JSON.stringify({ task: `q${i}` })));
    }

    expect(outs[0]).not.toMatch(/\[(note|budget):/);
    expect(outs[1]).toMatch(/\[note: this session has spawned 2 subagents/);
    expect(outs[2]).toMatch(/\[note: this session has spawned 3 subagents/);
    expect(outs[3]).toMatch(/\[note: this session has spawned 4 subagents/);
    expect(outs[4]).toMatch(/\[budget: this session has now spawned 5 subagents/);
  });
});

describe("formatSubagentResult — forcedSummary path", () => {
  function baseResult(over: Partial<SubagentResult>): SubagentResult {
    return {
      success: false,
      output: "",
      turns: 1,
      toolIters: 4,
      elapsedMs: 1000,
      costUsd: 0.0001,
      model: "deepseek-chat",
      usage: new Usage(),
      ...over,
    };
  }

  it("renders forcedSummary results with partial:true and `output` carrying the synthesis", () => {
    const formatted = formatSubagentResult(
      baseResult({
        forcedSummary: true,
        output: "I found X and Y; could not reach Z because the file was truncated.",
      }),
    );
    const parsed = JSON.parse(formatted);
    expect(parsed.success).toBe(false);
    expect(parsed.partial).toBe(true);
    expect(parsed.output).toMatch(/found X and Y/);
    expect(parsed.note).toMatch(/force-summarized/i);
  });

  it("forcedSummary takes precedence over the generic !success branch", () => {
    const formatted = formatSubagentResult(
      baseResult({
        forcedSummary: true,
        output: "partial answer",
        error: "ignored when forcedSummary is set",
      }),
    );
    const parsed = JSON.parse(formatted);
    expect(parsed.partial).toBe(true);
    expect(parsed.output).toBe("partial answer");
    expect(parsed.error).toBeUndefined();
  });

  it("genuine !success without forcedSummary still uses the error-only shape", () => {
    const formatted = formatSubagentResult(
      baseResult({ error: "subagent ended without producing an answer" }),
    );
    const parsed = JSON.parse(formatted);
    expect(parsed.success).toBe(false);
    expect(parsed.partial).toBeUndefined();
    expect(parsed.error).toMatch(/ended without producing/);
    expect(parsed.output).toBeUndefined();
  });
});

describe("forkRegistryExcluding", () => {
  it("the production exclusion set blocks every nested delegation entry point", () => {
    expect([...NEVER_INHERITED_TOOLS]).toEqual(
      expect.arrayContaining([
        "spawn_subagent",
        "run_skill",
        "explore",
        "research",
        "review",
        "security_review",
        "submit_plan",
      ]),
    );
  });

  it("copies all tools except the excluded names", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "a", fn: () => "a" });
    parent.register({ name: "b", fn: () => "b" });
    parent.register({ name: "c", fn: () => "c" });
    const child = forkRegistryExcluding(parent, new Set(["b"]));
    expect(child.has("a")).toBe(true);
    expect(child.has("b")).toBe(false);
    expect(child.has("c")).toBe(true);
    expect(child.size).toBe(2);
  });

  it("propagates plan-mode state from the parent", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "x", readOnly: true, fn: () => "x" });
    parent.setPlanMode(true);
    const child = forkRegistryExcluding(parent, new Set());
    expect(child.planMode).toBe(true);
  });

  it("child registry's plan mode defaults off when parent's is off", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "x", fn: () => "x" });
    const child = forkRegistryExcluding(parent, new Set());
    expect(child.planMode).toBe(false);
  });

  it("dispatching a copied tool still runs its fn", async () => {
    const parent = new ToolRegistry();
    let calls = 0;
    parent.register({
      name: "counter",
      fn: () => {
        calls++;
        return `n=${calls}`;
      },
    });
    const child = forkRegistryExcluding(parent, new Set());
    const out = await child.dispatch("counter", "{}");
    expect(out).toBe("n=1");
  });
});

describe("forkRegistryWithAllowList", () => {
  it("includes only names in the allow-list", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "read" });
    parent.register({ name: "write", fn: () => "write" });
    parent.register({ name: "shell", fn: () => "shell" });
    const child = forkRegistryWithAllowList(parent, new Set(["read", "write"]), new Set());
    expect(child.has("read")).toBe(true);
    expect(child.has("write")).toBe(true);
    expect(child.has("shell")).toBe(false);
    expect(child.size).toBe(2);
  });

  it("alsoExclude wins over allow", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "spawn_subagent", fn: () => "x" });
    parent.register({ name: "read", fn: () => "read" });
    const child = forkRegistryWithAllowList(
      parent,
      new Set(["read", "spawn_subagent"]),
      new Set(["spawn_subagent"]),
    );
    expect(child.has("read")).toBe(true);
    expect(child.has("spawn_subagent")).toBe(false);
  });

  it("propagates parent plan mode", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "x" });
    parent.setPlanMode(true);
    const child = forkRegistryWithAllowList(parent, new Set(["read"]), new Set());
    expect(child.planMode).toBe(true);
  });

  it("ignores allow-list names that are not registered (caller validates)", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "x" });
    const child = forkRegistryWithAllowList(parent, new Set(["read", "ghost"]), new Set());
    expect(child.has("read")).toBe(true);
    expect(child.has("ghost")).toBe(false);
    expect(child.size).toBe(1);
  });

  it("keeps every bridged MCP tool the parent has, allow-listed or not", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read_file", readOnly: true, fn: () => "text" });
    parent.register({ name: "edit_file", fn: () => "edited" });
    parent.register({ name: "unreal_mcp_spawn_actor", bridged: true, fn: () => "spawned" });
    parent.register({ name: "playwright_browser_click", bridged: true, fn: () => "clicked" });
    // A skill allow-list that names none of the MCP tools, like review/security-review.
    const child = forkRegistryWithAllowList(parent, new Set(["read_file"]), new Set());
    expect(child.has("read_file")).toBe(true);
    // Not allow-listed and not bridged: still scoped out.
    expect(child.has("edit_file")).toBe(false);
    // MCP tools come along: the child sees the user's servers like the parent does.
    expect(child.has("unreal_mcp_spawn_actor")).toBe(true);
    expect(child.has("playwright_browser_click")).toBe(true);
  });

  it("still applies alsoExclude to a bridged tool", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "playwright_browser_click", bridged: true, fn: () => "clicked" });
    const child = forkRegistryWithAllowList(
      parent,
      new Set(["read_file"]),
      new Set(["playwright_browser_click"]),
    );
    expect(child.has("playwright_browser_click")).toBe(false);
  });
});

describe("spawnSubagent allowedTools", () => {
  it("scopes the child registry to the allow-list", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "read result" });
    parent.register({ name: "write", fn: () => "write result" });
    parent.register({ name: "shell", fn: () => "shell result" });
    const client = makeClient([{ content: "done" }]);
    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "test",
      task: "test",
      allowedTools: ["read"],
    });
    expect(result.success).toBe(true);
    expect(parent.has("write")).toBe(true);
    expect(parent.has("shell")).toBe(true);
  });

  it("returns a structured error when allow-list names a tool the parent does not have", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "read result" });
    const client = makeClient([{ content: "should not run" }]);
    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "test",
      task: "test",
      allowedTools: ["read", "missing_tool"],
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing_tool");
    expect(result.error).toContain("allow-list");
    expect(result.turns).toBe(0);
    expect(result.toolIters).toBe(0);
  });

  it("emits start then end with the validation error and runs no API call", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read", fn: () => "read result" });
    const fetchSpy = vi.fn();
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const { sink, events } = makeSink();
    await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "test",
      task: "test",
      allowedTools: ["ghost"],
      sink,
    });
    expect(events.map((e) => e.kind)).toEqual(["start", "end"]);
    expect(events[1]?.error).toContain("ghost");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("advertises the parent's bridged MCP tools to an allow-listed child", async () => {
    // The wire tool list IS the child registry's specs, so capturing the request
    // proves what the subagent was actually offered.
    const parent = new ToolRegistry();
    parent.register({ name: "read_file", readOnly: true, fn: () => "text" });
    parent.register({ name: "write_file", fn: () => "written" });
    await bridgeMcpTools(
      {
        listTools: async () => ({
          tools: [
            {
              name: "spawn_actor",
              description: "spawn an actor in the open level",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        }),
        callTool: async () => ({ content: [{ type: "text", text: "spawned" }] }),
      } as never,
      { registry: parent, namePrefix: "unreal_mcp_" },
    );
    expect(parent.get("unreal_mcp_spawn_actor")?.bridged).toBe(true);

    const seen: string[][] = [];
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: vi.fn(async (_url: never, init: { body?: string }) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
        seen.push(tools.map((t) => t.function.name));
        const frames = [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "fine" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(new TextEncoder().encode(frames.join("")), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }) as never,
    });
    await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "test",
      task: "test",
      // The read-only built-in scoping: MCP tools still come along.
      allowedTools: ["read_file"],
    });

    expect(seen[0]).toContain("read_file");
    expect(seen[0]).not.toContain("write_file");
    expect(seen[0]).toContain("unreal_mcp_spawn_actor");
  });

  it("cannot resurrect a plan tool through a skill allow-list", () => {
    const parent = new ToolRegistry();
    parent.register({ name: "read_file", readOnly: true, fn: () => "ok" });
    registerPlanTool(parent, { rootDir: ".", confirmationGate: approvingGate() });

    // alsoExclude wins over allow: naming a plan tool in `allowed-tools` must not hand a
    // child read or write access to the parent's plan.
    const child = forkRegistryWithAllowList(
      parent,
      new Set(["read_file", "submit_plan", "open_plan", "list_plans"]),
      NEVER_INHERITED_TOOLS,
    );

    expect(child.has("read_file")).toBe(true);
    expect(child.has("submit_plan")).toBe(false);
    expect(child.has("open_plan")).toBe(false);
    expect(child.has("list_plans")).toBe(false);
  });
});

describe("iteration-cap recovery", () => {
  it("a child that exhausts the iteration cap returns an attributed partial, never silence", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "ok" });
    // Distinct args per call: the storm breaker must not end this turn first —
    // the submission is exercising the cap, not the repeat guard.
    const { client } = makeFakeClient(
      Array.from({ length: 200 }, (_, i) => ({
        content: "",
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function" as const,
            function: { name: "noop", arguments: JSON.stringify({ i }) },
          },
        ],
      })),
    );

    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "gather facts",
      task: "keep scanning",
    });

    // Before the unattended ladder this was the unattributable
    // "subagent ended without producing an answer" with empty output.
    expect(result.success).toBe(false);
    expect(result.forcedSummary).toBe(true);
    expect(result.output).toMatch(/iteration budget/);
    expect(result.error).toBeUndefined();
    expect(result.stopReason ?? result.output).toMatch(/iteration budget/);
    expect(result.toolIters).toBeGreaterThanOrEqual(CacheFirstLoop.DEFAULT_MAX_ITER_PER_TURN);

    const envelope = JSON.parse(formatSubagentResult(result));
    expect(envelope.partial).toBe(true);
    expect(envelope.output).toMatch(/iteration budget/);
    expect(envelope.note).toMatch(/force-summarized/i);
  }, 120_000);
});

describe("repetition guard — always on for children", () => {
  it("terminates a child that re-thinks the identical thought instead of returning nothing", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "ok" });
    // Distinct args every iteration so the storm breaker cannot fire first: the
    // reasoning-loop guard is what has to catch this one.
    const repeatedReasoning = "I should re-read the file to be sure the same bytes are there.";
    const { client, fetchMock } = makeFakeClient(
      Array.from({ length: 10 }, (_, i) => ({
        content: "",
        reasoning_content: repeatedReasoning,
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function" as const,
            function: { name: "noop", arguments: JSON.stringify({ i }) },
          },
        ],
      })),
    );

    // No repetitionGuardEnabled option exists any more: the guard runs even when
    // the parent agent's config has it switched off.
    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "gather facts",
      task: "keep re-thinking",
    });

    // Caught on the third identical thought, not after burning the whole budget.
    expect(fetchMock.mock.calls.length).toBe(CacheFirstLoop.REASONING_LOOP_LIMIT);
    expect(result.success).toBe(false);
    expect(result.stopCause).toBe("repetition-guard");
    expect(result.error).toMatch(/terminated by the repetition guard/);

    const envelope = JSON.parse(formatSubagentResult(result));
    expect(envelope.terminated).toBe(true);
    expect(envelope.stop_cause).toBe("repetition-guard");
  }, 60_000);
});

describe("a child must return an answer", () => {
  it("is told it must answer after an empty completion, and that answer is the result", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "ok" });
    const { client } = makeFakeClient([{ content: "" }, { content: "the answer" }]);
    const { sink, events } = makeSink();

    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "gather facts",
      task: "answer me",
      sink,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("the answer");
    expect(
      events.some(
        (e) =>
          e.kind === "inner" &&
          e.inner?.role === "warning" &&
          /must return an answer/.test(e.inner.content),
      ),
    ).toBe(true);
  }, 30_000);

  it("ends with an attributed final instead of silence when it never answers", async () => {
    const { client } = makeFakeClient([{ content: "" }]);
    const result = await spawnSubagent({
      client,
      parentRegistry: new ToolRegistry(),
      system: "gather facts",
      task: "stay empty",
    });

    expect(result.success).toBe(false);
    expect(result.forcedSummary).toBe(true);
    expect(result.stopCause).toBe("empty-response");
    expect(result.output).toMatch(/without an answer/);
    expect(result.error).toBeUndefined();

    const envelope = JSON.parse(formatSubagentResult(result));
    expect(envelope.partial).toBe(true);
    expect(envelope.stop_cause).toBe("empty-response");
    expect(envelope.terminated).toBeUndefined();
  }, 30_000);
});

describe("inherited loop options", () => {
  it("enforces the parent's window cap and reports it as the meter denominator", async () => {
    const parent = new ToolRegistry();
    parent.register({ name: "noop", readOnly: true, fn: () => "ok" });
    const { client } = makeFakeClient([{ content: "done" }]);
    const { sink, events } = makeSink();

    const result = await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "gather facts",
      task: "answer me",
      inherited: { ctxMaxOverride: 300_000 },
      sink,
    });

    expect(result.success).toBe(true);
    // The denominator is the INHERITED cap, not the child model's default window.
    expect(events.at(-1)).toMatchObject({ kind: "end", contextMax: 300_000 });
  }, 30_000);

  it("inherits every loop setting and forces compaction on", () => {
    // `defaults` is passed explicitly so this is a policy assertion, not a read of the
    // developer machine's config: an inherited value wins, config/env fills the gap.
    const defaults = { maxIterPerTurn: 50, maxOutputTokens: 8_192 };
    // A child must not depend on the loop's DEFAULT for compaction: if that default
    // ever flipped, an unattended run would have no compaction and nobody to press
    // it. No caller can switch it off either — the policy has one implementation.
    expect(childLoopOptions(undefined, defaults)).toEqual({
      ctxMaxOverride: undefined,
      autoCompactTriggerRatio: undefined,
      maxIterPerTurn: 50,
      maxOutputTokens: 8_192,
      hooks: undefined,
      hookCwd: undefined,
      autoCompact: true,
    });
    expect(
      childLoopOptions(
        {
          ctxMaxOverride: 300_000,
          autoCompactTriggerRatio: 0.5,
          maxIterPerTurn: 12,
          maxOutputTokens: 1_024,
          hooks: [],
          hookCwd: "C:/ws",
        },
        defaults,
      ),
    ).toEqual({
      ctxMaxOverride: 300_000,
      autoCompactTriggerRatio: 0.5,
      maxIterPerTurn: 12,
      maxOutputTokens: 1_024,
      hooks: [],
      hookCwd: "C:/ws",
      autoCompact: true,
    });
  });

  it("runs the child's tools in the parent's workspace root", async () => {
    const parent = new ToolRegistry();
    let seenRoot: string | undefined;
    parent.register({
      name: "noop",
      readOnly: true,
      fn: (_args: string, ctx?: { rootDir?: string }) => {
        seenRoot = ctx?.rootDir;
        return "ok";
      },
    });
    const { client } = makeFakeClient([
      {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
      },
      { content: "done" },
    ]);

    await spawnSubagent({
      client,
      parentRegistry: parent,
      system: "gather facts",
      task: "answer me",
      inherited: { hookCwd: "C:/ws-root" },
    });

    // hookCwd is also the rootDir a tool resolves relative paths against, so inheriting
    // it keeps a child's file tools pointed at the parent's workspace. Left alone, the
    // child fell back to process.cwd() — a different tree entirely.
    expect(seenRoot).toBe("C:/ws-root");
  }, 30_000);

  it("actually compacts the child once the inherited cap is crossed", async () => {
    const parent = new ToolRegistry();
    // A result small enough to survive the 8k-token heal threshold, repeated enough
    // times to cross the trigger: the log growth a real child gets from reading.
    parent.register({ name: "noop", readOnly: true, fn: () => "y".repeat(20_000) });
    const system = "gather facts";
    const task = "answer me";

    // Size the run from the loop's OWN estimator instead of guessing: fill to 60% of
    // a 128k cap, i.e. above the 0.5 trigger (64k) and under the cap itself.
    const prefix = new ImmutablePrefix({ system, toolSpecs: parent.specs() });
    const base = estimateRequestTokens(
      [...prefix.toMessages(), { role: "user", content: task }],
      prefix.tools(),
    );
    const oneRead = estimateRequestTokens(
      [
        ...prefix.toMessages(),
        { role: "user", content: task },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c0", type: "function", function: { name: "noop", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c0", name: "noop", content: "y".repeat(20_000) },
      ],
      prefix.tools(),
    );
    const perRead = Math.max(1, oneRead - base);
    const readsNeeded = Math.max(1, Math.ceil((128_000 * 0.6 - base) / perRead));

    // The summariser call is the ONLY non-streaming request in a child run, so the
    // fake can route on `stream`: text for the fold, tool calls for the turns.
    let turnsLeft = readsNeeded;
    const summarised: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (body.stream === true) {
        turnsLeft--;
        const delta =
          turnsLeft >= 0
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${turnsLeft}`,
                    type: "function",
                    function: { name: "noop", arguments: JSON.stringify({ i: turnsLeft }) },
                  },
                ],
              }
            : { content: "done" };
        const frames = [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
          `data: ${JSON.stringify({
            choices: [
              { index: 0, delta: {}, finish_reason: turnsLeft >= 0 ? "tool_calls" : "stop" },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
          })}\n\n`,
          "data: [DONE]\n\n",
        ];
        return new Response(frames.join(""), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      summarised.push(String(init?.body ?? "").slice(0, 60));
      return new Response(
        JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: "CONSOLIDATED SUMMARY" } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { sink, events } = makeSink();

    const result = await spawnSubagent({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: fetchMock as never }),
      parentRegistry: parent,
      system,
      task,
      // 128k is the floor resolveContextTokens applies to a non-Ollama override, so
      // the inherited cap and the 0.5 trigger are exactly these numbers.
      inherited: { ctxMaxOverride: 128_000, autoCompactTriggerRatio: 0.5 },
      sink,
    });

    const inner = events.flatMap((e) => (e.kind === "inner" && e.inner ? [e.inner] : []));
    // The fold is announced...
    expect(inner.some((e) => e.role === "compaction_start")).toBe(true);
    // ...and completes, reporting the before/after token counts.
    expect(
      inner.some((e) => e.role === "warning" && /Context compacted/.test(e.content ?? "")),
    ).toBe(true);
    // A real summariser call happened, so this was a fold and not just an event.
    expect(summarised.length).toBeGreaterThanOrEqual(1);
    // And the child survives its own compaction to finish normally.
    expect(result.success).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "end", contextMax: 128_000 });
  }, 120_000);

  it("forwards a library caller's inherited-loop getter into the spawn", async () => {
    const parent = new ToolRegistry();
    const { client } = makeFakeClient([{ content: "done" }]);
    const { sink, events } = makeSink();
    registerSubagentTool(parent, {
      client,
      sink,
      inherited: () => ({ ctxMaxOverride: 400_000 }),
    });

    await parent.dispatch("spawn_subagent", JSON.stringify({ task: "answer me" }));

    expect(events.at(-1)).toMatchObject({ kind: "end", contextMax: 400_000 });
  }, 30_000);
});

describe("plan isolation", () => {
  it("never lets a child see the parent's plan, by tools or by injected context", async () => {
    // Plans AND sessions both live under the user home, so redirect it: this test must not
    // read the real plan store, nor leave a real session behind.
    const home = mkdtempSync(join(tmpdir(), "subagent-plan-home-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    const previousHome = [process.env.HOME, process.env.USERPROFILE];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      // An ACTIVE and UNCLAIMED plan: exactly the state any loop in this workspace may
      // adopt, which is what makes the isolation below meaningful.
      const repository = planRepository(workspace);
      const plan = repository.propose("SECRET-PLAN-MARKER: rewrite the parser", [
        { id: "s1", title: "Rewrite", action: "Rewrite the parser" },
      ]);
      repository.activate(plan.id);

      // 1. The child shares the parent's workspace (inherited hookCwd) and its registry,
      //    which carries the plan tools. It must adopt nothing and be offered no plan tool.
      const parent = new ToolRegistry();
      registerPlanTool(parent, { rootDir: workspace, confirmationGate: approvingGate() });
      const child: Array<{ messages?: unknown; tools?: Array<{ function: { name: string } }> }> =
        [];
      // The child tries to author a plan it was never asked for. The registry it inherits
      // has the tool dropped, so the call must die as an unknown name, not pause for a gate.
      await spawnSubagent({
        client: makeFakeClient(
          [
            {
              content: "",
              tool_calls: [
                {
                  id: "call_plan",
                  type: "function" as const,
                  function: {
                    name: "submit_plan",
                    arguments: JSON.stringify({
                      plan: "CHILD-PLAN-MARKER: do the parent's job",
                      steps: [{ id: "c1", title: "Sneak", action: "Do it" }],
                    }),
                  },
                },
              ],
            },
            { content: "done" },
          ],
          { capture: (r) => child.push(r) },
        ).client,
        parentRegistry: parent,
        system: "gather facts",
        task: "look at the code",
        inherited: { hookCwd: workspace },
      });

      const wire = JSON.stringify(child.map((r) => r.messages));
      expect(wire).not.toContain("Authoritative session plan state");
      expect(wire).not.toContain("SECRET-PLAN-MARKER");
      // The write attempt was refused, and nothing it named reached the store.
      expect(wire).toContain("unknown tool: submit_plan");
      expect(repository.list()).toHaveLength(1);
      expect(repository.open(plan.id).body).not.toContain("CHILD-PLAN-MARKER");
      const offered = child.flatMap((r) => (r.tools ?? []).map((t) => t.function.name));
      for (const planTool of ["list_plans", "open_plan", "submit_plan", "mark_step_complete"]) {
        expect(offered).not.toContain(planTool);
      }

      // 2. Control, run AFTER the child: an ordinary loop adopts that same plan, so it was
      //    still adoptable all along and step 1 proved isolation rather than an empty store.
      const control: Array<{ messages?: unknown }> = [];
      const controlLoop = new CacheFirstLoop({
        client: makeFakeClient([{ content: "ok" }], { capture: (r) => control.push(r) }).client,
        prefix: new ImmutablePrefix({ system: "parent" }),
        session: "parent-session",
        hookCwd: workspace,
        stream: false,
      });
      for await (const _event of controlLoop.step("go")) {
        // drain
      }
      expect(JSON.stringify(control)).toContain("Authoritative session plan state");
    } finally {
      [process.env.HOME, process.env.USERPROFILE] = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
