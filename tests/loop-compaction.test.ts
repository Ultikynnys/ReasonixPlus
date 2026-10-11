/** CacheFirstLoop compaction integration: auto trigger, overflow recovery,
 *  manual compactNow, and the session checkpoint, seeded past real thresholds. */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { COMPACTION_SUMMARY_PREFIX, DROPPED_WORK_NOTICE_PREFIX } from "../src/loop/compaction.js";
import { AUTO_COMPACT_TRIGGER_RATIO } from "../src/loop/compaction.js";
import type { LoopEvent } from "../src/loop/types.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMessages } from "../src/memory/session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../src/telemetry/stats.js";
import { estimateConversationTokens } from "../src/tokenizer.js";
import type { ChatMessage, ToolCall } from "../src/types.js";
import { jsonOkResponse, makeFakeClient } from "./support/fake-client.js";

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Append tool round-trips until the log's own estimate reaches `minTokens`. */
function seedLogTo(loop: CacheFirstLoop, minTokens: number, marker: string): void {
  for (let n = 0; n < 4_000 && estimateConversationTokens(loop.log.entries) < minTokens; n++) {
    const id = `${marker}-${n}`;
    loop.log.append({
      role: "assistant",
      content: "",
      tool_calls: [call(id, "run_command", { command: `echo ${marker} ${n}` })],
    });
    loop.log.append({
      role: "tool",
      tool_call_id: id,
      content: `output line for ${marker} ${n}\n`.repeat(120),
    });
  }
}

async function drain(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe("CacheFirstLoop.compactNow (manual, LLM path)", () => {
  it("summarizes with a verification probe and replaces the log with the rolling summary first", async () => {
    const client = makeFakeClient([
      { content: "candidate summary of older work" },
      { content: "improved summary of older work" },
    ]).client;
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedLogTo(loop, 30_000, "a");
    loop.log.append({ role: "user", content: "first ask" });
    loop.log.append({ role: "user", content: "latest ask" });
    loop.log.append({ role: "assistant", content: "latest answer" });
    const before = loop.log.length;

    const outcome = await loop.compactNow({ trigger: "manual" });

    expect(outcome.status).toBe("done");
    expect(outcome.method).toBe("summary");
    expect(outcome.tokensAfter!).toBeLessThan(outcome.tokensBefore!);
    expect(loop.log.length).toBeLessThan(before);
    const first = String(loop.log.entries[0]!.content);
    expect(first).toContain(COMPACTION_SUMMARY_PREFIX);
    // The probe's improved summary won over the candidate.
    expect(first).toContain("improved summary of older work");
    // Real user prompts survive verbatim.
    expect(loop.log.entries.some((m) => m.role === "user" && m.content === "latest ask")).toBe(
      true,
    );
    expect(loop.log.entries.some((m) => m.role === "user" && m.content === "first ask")).toBe(true);
    const retracted = outcome.events.find((e) => e.role === "session_retracted");
    expect(retracted?.sessionRetractedKind).toBe("compact");
    expect(retracted?.afterMessages).toBe(loop.log.length);
    const warning = outcome.events.find((e) => e.role === "warning");
    expect(warning?.content).toContain("Context compacted");
  });

  it("falls back to the deterministic fold when the summarizer returns nothing", async () => {
    const client = makeFakeClient([{ content: "" }, { content: "" }]).client;
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedLogTo(loop, 30_000, "b");
    loop.log.append({ role: "user", content: "latest ask" });
    loop.log.append({ role: "assistant", content: "latest answer" });

    const outcome = await loop.compactNow({ trigger: "manual" });

    expect(outcome.status).toBe("done");
    expect(outcome.method).toBe("fold");
    expect(
      loop.log.entries.some((m) => String(m.content).startsWith(DROPPED_WORK_NOTICE_PREFIX)),
    ).toBe(true);
    expect(loop.log.entries.some((m) => m.role === "user" && m.content === "latest ask")).toBe(
      true,
    );
  });

  it("is a no-op on a small conversation", async () => {
    const client = makeFakeClient([{ content: "x" }]).client;
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    loop.log.append({ role: "user", content: "hi" });
    loop.log.append({ role: "assistant", content: "hello" });
    const outcome = await loop.compactNow({ trigger: "manual" });
    expect(outcome.status).toBe("noop");
    expect(loop.log.length).toBe(2);
  });
});

describe("CacheFirstLoop auto-compaction", () => {
  it("fires pre-turn when the estimate crosses the trigger ratio", async () => {
    const fake = makeFakeClient([
      { content: "rolling summary" },
      { content: "rolling summary verified" },
      { content: "final answer" },
    ]);
    const loop = new CacheFirstLoop({
      client: fake.client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      // Unknown model id: the window falls back to DEFAULT_CONTEXT_TOKENS, so
      // the seeded estimate deterministically crosses the trigger ratio.
      model: "test-model",
    });
    seedLogTo(loop, AUTO_COMPACT_TRIGGER_RATIO * DEFAULT_CONTEXT_TOKENS + 2_000, "auto");

    const events = await drain(loop.step("continue please"));

    const retracted = events.find((e) => e.role === "session_retracted");
    expect(retracted?.sessionRetractedKind).toBe("compact");
    expect(String(loop.log.entries[0]!.content)).toContain(COMPACTION_SUMMARY_PREFIX);
    // Compaction ran before the turn's own request: summary, then probe, then turn.
    expect(fake.captured).toHaveLength(3);
    expect(String(fake.captured[0]!.messages[0]!.content)).toContain(
      "compacting an agent conversation",
    );
    expect(events.some((e) => e.role === "assistant_final" && e.content === "final answer")).toBe(
      true,
    );
    // The fresh prompt was never folded away.
    expect(loop.log.entries.some((m) => m.role === "user" && m.content === "continue please")).toBe(
      true,
    );
  });

  it("stays idle below the trigger ratio", async () => {
    const fake = makeFakeClient([{ content: "short answer" }]);
    const loop = new CacheFirstLoop({
      client: fake.client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "test-model",
    });
    seedLogTo(loop, 10_000, "idle");

    const events = await drain(loop.step("hi"));

    expect(events.some((e) => e.role === "session_retracted")).toBe(false);
    expect(fake.captured).toHaveLength(1);
    expect(String(fake.captured[0]!.messages[0]!.content)).not.toContain(
      "compacting an agent conversation",
    );
  });

  it("honors a configured trigger ratio", async () => {
    // Sized between the 0.5 and 0.8 ratios: the default stays idle, an
    // explicit 0.5 fires.
    const seed = Math.round(0.5 * DEFAULT_CONTEXT_TOKENS) + 2_000;

    const idle = new CacheFirstLoop({
      client: makeFakeClient([{ content: "final answer" }]).client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "test-model",
    });
    seedLogTo(idle, seed, "cfg-idle");
    const idleEvents = await drain(idle.step("hi"));
    expect(idleEvents.some((e) => e.role === "session_retracted")).toBe(false);

    const eager = new CacheFirstLoop({
      client: makeFakeClient([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
        { content: "final answer" },
      ]).client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "test-model",
      autoCompactTriggerRatio: 0.5,
    });
    seedLogTo(eager, seed, "cfg-eager");
    const eagerEvents = await drain(eager.step("hi"));
    expect(eagerEvents.some((e) => e.role === "session_retracted")).toBe(true);
  });

  it("applies a reconfigured trigger ratio live", async () => {
    const seed = Math.round(0.5 * DEFAULT_CONTEXT_TOKENS) + 2_000;
    const loop = new CacheFirstLoop({
      client: makeFakeClient([
        { content: "rolling summary" },
        { content: "rolling summary verified" },
        { content: "final answer" },
      ]).client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      model: "test-model",
    });
    seedLogTo(loop, seed, "cfg-live");
    // The default 0.8 would stay idle at this size; the live configure applies.
    loop.configure({ autoCompactTriggerRatio: 0.5 });
    expect(loop.autoCompactTriggerRatio).toBe(0.5);

    const events = await drain(loop.step("hi"));
    expect(events.some((e) => e.role === "session_retracted")).toBe(true);
  });
});

describe("CacheFirstLoop overflow recovery", () => {
  it("folds deterministically on a context-overflow error and retries the iteration", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "This model's maximum context length is 8192 tokens. However, you requested 12000 tokens.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return jsonOkResponse({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "recovered answer",
              reasoning_content: null,
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
    const client = new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
    });
    seedLogTo(loop, 30_000, "ovf");
    const before = loop.log.length;

    const events = await drain(loop.step("keep going"));

    const retracted = events.find((e) => e.role === "session_retracted");
    expect(retracted?.sessionRetractedKind).toBe("compact");
    const warning = events.find((e) => e.role === "warning" && e.severity === "high");
    expect(warning?.content).toContain("Context window exceeded");
    // Fold-only recovery: the log shrank, then the retry answered.
    expect(loop.log.length).toBeLessThan(before);
    expect(
      events.some((e) => e.role === "assistant_final" && e.content === "recovered answer"),
    ).toBe(true);
  });
});

describe("compaction persistence", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-compact-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("checkpoints the pre-compaction transcript and rewrites the session log", async () => {
    const client = makeFakeClient([
      { content: "rolling summary" },
      { content: "rolling summary" },
    ]).client;
    const loop = new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: "compact-test",
    });
    seedLogTo(loop, 30_000, "persist");
    loop.log.append({ role: "user", content: "latest ask" });
    loop.log.append({ role: "assistant", content: "latest answer" });

    const outcome = await loop.compactNow({ trigger: "manual" });

    expect(outcome.status).toBe("done");
    expect(outcome.checkpoint).toBeTruthy();
    expect(existsSync(outcome.checkpoint!)).toBe(true);
    expect(loadSessionMessages("compact-test").length).toBe(loop.log.length);
    const dir = join(tmp, ".reasonix", "sessions", "compact-test");
    expect(readdirSync(dir).some((f) => f.startsWith("messages.precompact-"))).toBe(true);
  });
});

void homedir;
