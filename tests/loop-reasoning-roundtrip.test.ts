/** Thinking-mode contract: an assistant turn missing `reasoning_content` fails
 *  the whole request, so the loop must repair it and re-send instead of dying. */

import { describe, expect, it } from "vitest";
import { CacheFirstLoop, isThinkingModeModel, thinkingModeForModel } from "../src/loop.js";
import { isReasoningRoundTripError } from "../src/loop/errors.js";
import { stampMissingReasoningForThinkingMode } from "../src/loop/healing.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import type { ChatMessage } from "../src/types.js";

/** Verbatim message relayed by OpenCode's Go gateway (diagnostics
 *  `model.error.body`) when DeepSeek's thinking mode refuses the body. */
const ROUND_TRIP_BODY =
  '{"error":{"param":null,"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API."}}';

function roundTripError(): Error {
  return new Error(`OpenCode 400: ${ROUND_TRIP_BODY}`);
}

describe("isReasoningRoundTripError", () => {
  it("matches the relayed thinking-mode rejection under any provider brand", () => {
    expect(isReasoningRoundTripError(roundTripError())).toBe(true);
    expect(
      isReasoningRoundTripError(
        new Error("DeepSeek 400: reasoning_content must be included for every assistant turn"),
      ),
    ).toBe(true);
    expect(
      isReasoningRoundTripError(
        new Error("OpenCode 400: reasoning_content 字段在思考模式必须回传"),
      ),
    ).toBe(true);
  });

  it("leaves other 400 families on their own recovery paths", () => {
    expect(
      isReasoningRoundTripError(new Error("OpenCode 400: maximum context length is 128000 tokens")),
    ).toBe(false);
    expect(
      isReasoningRoundTripError(
        new Error(
          'OpenCode 400: {"error":{"param":null,"message":"Upstream request failed: [invalid_request_error] request could not be processed"}}',
        ),
      ),
    ).toBe(false);
    expect(isReasoningRoundTripError(new Error("OpenCode 400: bad request"))).toBe(false);
    expect(isReasoningRoundTripError(undefined)).toBe(false);
  });
});

describe("thinking-mode classification covers the whole DeepSeek flash/pro line", () => {
  it("recognizes v4.1 ids bare and OpenCode-qualified", () => {
    expect(isThinkingModeModel("deepseek-v4.1-flash")).toBe(true);
    expect(isThinkingModeModel("opencode/deepseek-v4.1-flash")).toBe(true);
    expect(thinkingModeForModel("opencode/deepseek-v4.1-flash")).toBe("enabled");
  });

  it("keeps the non-thinking and non-DeepSeek ids clean", () => {
    expect(isThinkingModeModel("deepseek-chat")).toBe(false);
    expect(isThinkingModeModel("deepseek-coder")).toBe(false);
    expect(isThinkingModeModel("opencode/qwen3.8-max")).toBe(false);
  });

  it("is enough for the session-load heal to repair a resumed session", () => {
    const resumed: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    expect(
      stampMissingReasoningForThinkingMode(resumed, "opencode/deepseek-v4.1-flash").stampedCount,
    ).toBe(1);
  });
});

describe("stampMissingReasoningForThinkingMode", () => {
  const bare: ChatMessage[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ];

  it("honours the window start and forces on an unclassified model", () => {
    const windowed = stampMissingReasoningForThinkingMode(bare, "deepseek-v4.1-flash", {
      fromIndex: 2,
    });
    expect(windowed.stampedCount).toBe(1);
    expect(Object.hasOwn(windowed.messages[1]!, "reasoning_content")).toBe(false);
    expect(windowed.messages[3]!.reasoning_content).toBe("");

    const forced = stampMissingReasoningForThinkingMode(bare, "opencode/unknown-model", {
      force: true,
    });
    expect(forced.stampedCount).toBe(2);
    expect(forced.messages[1]!.reasoning_content).toBe("");
    expect(forced.messages[3]!.reasoning_content).toBe("");
  });

  it("returns the same array when nothing needed stamping", () => {
    const clean: ChatMessage[] = [{ role: "assistant", content: "a", reasoning_content: "t" }];
    const out = stampMissingReasoningForThinkingMode(clean, "deepseek-v4.1-flash");
    expect(out.stampedCount).toBe(0);
    expect(out.messages).toBe(clean);
  });
});

describe("CacheFirstLoop — thinking-mode round-trip recovery", () => {
  /** Stream client that refuses with the captured body for the first
   *  `failures` calls, then answers. Records every request's messages. */
  function repairingClient(failures: number) {
    let calls = 0;
    const sent: ChatMessage[][] = [];
    const client = {
      baseUrl: "https://opencode.ai/zen/v1",
      model: "opencode/deepseek-v4.1-flash",
      calls: () => calls,
      sent,
      stream: async function* (opts: { messages: ChatMessage[] }) {
        calls++;
        sent.push(opts.messages.map((m) => ({ ...m })));
        if (calls <= failures) throw roundTripError();
        yield { contentDelta: "recovered answer" };
        yield { finishReason: "stop" };
      },
    };
    return client;
  }

  async function runTurn(
    loop: { step: (input: string) => AsyncGenerator<Record<string, unknown>> },
    input: string,
  ) {
    const events: Array<Record<string, unknown>> = [];
    for await (const ev of loop.step(input)) events.push(ev as Record<string, unknown>);
    return events;
  }

  function makeLoop(client: unknown) {
    return new CacheFirstLoop({
      client: client as never,
      prefix: new ImmutablePrefix({ system: "test prompt" }),
      model: "opencode/deepseek-v4.1-flash",
      stream: true,
    });
  }

  /** A resumed session whose assistant turn was persisted without the field —
   *  the state that makes every later request fail. */
  function seedBareTurn(loop: unknown): void {
    const log = (loop as { log: { append: (m: Record<string, unknown>) => void } }).log;
    log.append({ role: "user", content: "earlier question" });
    log.append({ role: "assistant", content: "earlier answer" });
  }

  it("back-fills the bare turn, re-sends, and finishes the turn", async () => {
    const client = repairingClient(1);
    const loop = makeLoop(client);
    seedBareTurn(loop);

    const events = await runTurn(loop, "carry on");

    expect(client.calls()).toBe(2);
    const firstRequest = client.sent[0]!;
    const bareTurn = firstRequest.find((m) => m.role === "assistant");
    expect(bareTurn?.reasoning_content).toBeUndefined();

    const repairedTurn = client.sent[1]!.find((m) => m.role === "assistant");
    expect(repairedTurn?.reasoning_content).toBe("");

    const warnings = events.filter((e) => e.role === "warning").map((e) => String(e.content));
    expect(warnings.some((w) => w.includes("Back-filled the missing reasoning"))).toBe(true);
    expect(events.some((e) => e.role === "error")).toBe(false);
    expect(
      events.some((e) => e.role === "assistant_delta" && e.content === "recovered answer"),
    ).toBe(true);
  });

  it("stops retrying once nothing is left to repair and surfaces the error", async () => {
    const client = repairingClient(Number.POSITIVE_INFINITY);
    const loop = makeLoop(client);
    seedBareTurn(loop);

    const events = await runTurn(loop, "carry on");

    // One refused attempt, one repaired replay, then the error — the second
    // failure has no bare turn left, so another replay would be identical.
    expect(client.calls()).toBe(2);
    const errorEvent = events.find((e) => e.role === "error");
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent?.error)).toContain("reasoning_content");
  });
});
