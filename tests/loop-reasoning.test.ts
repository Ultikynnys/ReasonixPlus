// Consolidated from 10 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { describe, expect, it } from "vitest";
import { DeepSeekClient, stripTranscriptMarkers } from "../src/client.js";
import type { ResolvedHook } from "../src/hooks.js";
import {
  CacheFirstLoop,
  type LoopEvent,
  isThinkingModeModel,
  stampMissingReasoningForThinkingMode,
  thinkingModeForModel,
} from "../src/loop.js";
import { isReasoningRoundTripError } from "../src/loop/errors.js";
import { buildAssistantMessage, buildSyntheticAssistantMessage } from "../src/loop/messages.js";
import { StreamRepetitionDetector } from "../src/loop/repetition.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";
import {
  type CapturedRequest,
  type FakeResponseShape,
  makeFakeClient,
} from "./support/fake-client.js";
import { MATERIAL_REASONING_LOOP } from "./support/repetition-fixtures.js";

// R1 thinking-mode contract: tool-call reasoning_content must round-trip; stale plain reasoning must age out.
describe("loop-r1-reasoning", () => {
  describe("isThinkingModeModel", () => {
    it("deepseek-reasoner → true (legacy R1 alias)", () => {
      expect(isThinkingModeModel("deepseek-reasoner")).toBe(true);
    });
    it("deepseek-v4-flash → true (default thinking)", () => {
      expect(isThinkingModeModel("deepseek-v4-flash")).toBe(true);
    });
    it("deepseek-v4-pro → true (default thinking)", () => {
      expect(isThinkingModeModel("deepseek-v4-pro")).toBe(true);
    });
    it("ollama/deepseek-v4-flash:0731 → true (Ollama hosted tagged v4 models)", () => {
      expect(isThinkingModeModel("ollama/deepseek-v4-flash:0731")).toBe(true);
    });
    it("deepseek-chat → false (non-thinking compat alias)", () => {
      expect(isThinkingModeModel("deepseek-chat")).toBe(false);
    });
    it("unknown models → false (safe default)", () => {
      expect(isThinkingModeModel("gpt-4")).toBe(false);
      expect(isThinkingModeModel("")).toBe(false);
    });
    it("mimo models → true (reasoning_content must round-trip)", () => {
      expect(isThinkingModeModel("mimo-v2.6-pro")).toBe(true);
    });
  });

  describe("thinkingModeForModel", () => {
    it("chat → disabled, reasoner → enabled (compat aliases pin the mode)", () => {
      expect(thinkingModeForModel("deepseek-chat")).toBe("disabled");
      expect(thinkingModeForModel("deepseek-reasoner")).toBe("enabled");
    });
    it("v4 models → enabled (docs default)", () => {
      expect(thinkingModeForModel("deepseek-v4-flash")).toBe("enabled");
      expect(thinkingModeForModel("deepseek-v4-pro")).toBe("enabled");
      expect(thinkingModeForModel("ollama/deepseek-v4-flash:0731")).toBe("enabled");
    });
    it("gemini thinking models → enabled so their thought summaries are captured", () => {
      expect(thinkingModeForModel("gemini-3.8-flash-tiered")).toBe("enabled");
      expect(thinkingModeForModel("gemini-2.5-flash")).toBe("enabled");
    });
    it("unknown models → undefined (let server decide)", () => {
      expect(thinkingModeForModel("gpt-4")).toBeUndefined();
      expect(thinkingModeForModel("anthropic-claude")).toBeUndefined();
    });
    it("mimo models → enabled (thinking on by default)", () => {
      expect(thinkingModeForModel("mimo-v2.6-pro")).toBe("enabled");
    });
  });

  function capturingFetch(responses: FakeResponseShape[]) {
    const { fetchMock, captured } = makeFakeClient(responses);
    return { fetch: fetchMock as unknown as typeof fetch, bodies: captured };
  }

  describe("stampMissingReasoningForThinkingMode (session-load heal)", () => {
    it("stamps empty reasoning_content on assistant turns missing the field for thinking-mode sessions", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hi" },
        // Pre-fix session: no reasoning_content attached.
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
        { role: "assistant", content: "b", reasoning_content: "kept" },
      ];
      const { messages, stampedCount } = stampMissingReasoningForThinkingMode(
        msgs,
        "deepseek-reasoner",
      );
      expect(stampedCount).toBe(1);
      expect(messages[1]!.reasoning_content).toBe("");
      expect(messages[3]!.reasoning_content).toBe("kept");
    });

    it("no-ops on non-thinking-mode sessions (deepseek-chat stays clean)", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const { messages, stampedCount } = stampMissingReasoningForThinkingMode(
        msgs,
        "deepseek-chat",
      );
      expect(stampedCount).toBe(0);
      expect(Object.hasOwn(messages[1]!, "reasoning_content")).toBe(false);
    });

    it("preserves existing empty-string reasoning_content without double-stamping", () => {
      const msgs: ChatMessage[] = [{ role: "assistant", content: "hi", reasoning_content: "" }];
      const { stampedCount } = stampMissingReasoningForThinkingMode(msgs, "deepseek-v4-pro");
      expect(stampedCount).toBe(0);
    });
  });

  describe("R1 reasoning_content round-trip", () => {
    it("preserves reasoning_content on the assistant message when the turn has tool_calls", async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: "noop",
        readOnly: true,
        fn: () => "ok",
      });

      const { fetch: fakeFetch, bodies } = capturingFetch([
        {
          // Turn 1: model emits reasoning + tool call.
          content: "",
          reasoning_content: "I should call noop to check something.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "noop", arguments: "{}" },
            },
          ],
        },
        {
          // Turn 2: plain text wrap-up after the tool result comes back.
          content: "done",
        },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "deepseek-reasoner",
        stream: false,
      });

      for await (const _ev of loop.step("please noop")) {
        /* drain */
      }

      expect(bodies.length).toBe(2);
      // Turn 2's request messages include the turn-1 assistant message;
      // find it and verify reasoning_content landed.
      const turn2Messages = bodies[1]!.messages;
      const assistantWithCalls = turn2Messages.find(
        (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
      );
      expect(assistantWithCalls).toBeDefined();
      expect(assistantWithCalls?.reasoning_content).toBe("I should call noop to check something.");
    });

    it("preserves mimo tool-call reasoning_content across the tool cycle", async () => {
      const tools = new ToolRegistry();
      tools.register({ name: "noop", readOnly: true, fn: () => "ok" });
      const { fetch: fakeFetch, bodies } = capturingFetch([
        {
          content: "",
          reasoning_content: "mimo reasoning before the tool call",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } },
          ],
        },
        { content: "done" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "mimo-v2.6-pro",
        stream: false,
      });
      for await (const _ev of loop.step("please noop")) {
        /* drain */
      }
      expect(bodies.length).toBe(2);
      const assistantWithCalls = bodies[1]!.messages.find(
        (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
      );
      expect(assistantWithCalls?.reasoning_content).toBe("mimo reasoning before the tool call");
      // MiMo's thinking toggle rides top-level (CapturedRequest.thinking only maps
      // the nested extra_body path), and there is no effort ladder.
      expect((bodies[0]!.body.thinking as { type?: string } | undefined)?.type).toBe("enabled");
      expect(bodies[0]!.reasoning_effort).toBeUndefined();
    });

    it("omits stale reasoning_content from plain-text turns on the next user request", async () => {
      // DeepSeek V4 ignores reasoning_content from prior no-tool turns.
      // Carrying it forward only bloats long-session request bodies.
      const { fetch: fakeFetch, bodies } = capturingFetch([
        {
          content: "a plain answer",
          reasoning_content: "reasoning attached to a plain-text turn".repeat(200),
        },
        { content: "follow-up" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-reasoner",
        stream: false,
      });

      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      for await (const _ev of loop.step("next")) {
        /* drain */
      }

      const turn2Messages = bodies[1]!.messages;
      const assistant = turn2Messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
      expect(JSON.stringify(turn2Messages)).not.toContain(
        "reasoning attached to a plain-text turn",
      );
    });

    it("preserves tool-call reasoning_content across later user turns", async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: "noop",
        readOnly: true,
        fn: () => "ok",
      });
      const { fetch: fakeFetch, bodies } = capturingFetch([
        {
          content: "",
          reasoning_content: "tool-call reasoning must stay available",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "noop", arguments: "{}" },
            },
          ],
        },
        { content: "done", reasoning_content: "plain final reasoning can age out" },
        { content: "follow-up" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: tools.specs() }),
        tools,
        model: "deepseek-v4-pro",
        stream: false,
      });

      for await (const _ev of loop.step("please noop")) {
        /* drain */
      }
      for await (const _ev of loop.step("next")) {
        /* drain */
      }

      const turn2Messages = bodies[2]!.messages;
      const assistantWithCalls = turn2Messages.find(
        (m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0,
      );
      const finalAssistant = turn2Messages
        .filter((m) => m.role === "assistant" && (m.tool_calls?.length ?? 0) === 0)
        .at(-1);
      expect(assistantWithCalls?.reasoning_content).toBe("tool-call reasoning must stay available");
      expect(Object.hasOwn(finalAssistant!, "reasoning_content")).toBe(false);
    });

    it("stamps empty reasoning_content on a thinking-mode turn that returned null reasoning", async () => {
      // 0.5.18 covered "reasoner turn with reasoning present." This is
      // the inverse: thinking-mode model returns `reasoning_content:
      // null` (legitimate edge case — zero reasoning deltas on a flash
      // turn). Prior
      // behavior was `if (reasoning.length > 0)` which silently dropped
      // the field, and the NEXT API call 400'd. Invariant is now keyed
      // to the producing model, not to whether reasoning arrived.
      const { fetch: fakeFetch, bodies } = capturingFetch([
        { content: "straight answer", reasoning_content: undefined },
        { content: "follow-up" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-v4-flash",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      for await (const _ev of loop.step("next")) {
        /* drain */
      }
      const turn2Messages = bodies[1]!.messages;
      const assistant = turn2Messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      // Plain assistant turns do not need stale reasoning in later user requests.
      expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
    });

    it("does NOT stamp reasoning_content on a deepseek-chat turn that returned null", async () => {
      // Mirror image: non-thinking-mode sessions must stay clean —
      // sending an empty string here would still be valid per the API
      // but would needlessly churn the prefix cache across V3 calls.
      const { fetch: fakeFetch, bodies } = capturingFetch([
        { content: "hi", reasoning_content: undefined },
        { content: "bye" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-chat",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      for await (const _ev of loop.step("next")) {
        /* drain */
      }
      const turn2Messages = bodies[1]!.messages;
      const assistant = turn2Messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
    });

    it("omits stale plain deepseek-chat reasoning_content on the next user request", async () => {
      // V4-era deepseek-chat can surface reasoning_content even with thinking
      // disabled. Once the turn is a plain historical assistant message,
      // carrying that body forward just grows the next request.
      const { fetch: fakeFetch, bodies } = capturingFetch([
        { content: "ok", reasoning_content: "v4-chat reasoning leaked" },
        { content: "bye" },
      ]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-chat",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      for await (const _ev of loop.step("next")) {
        /* drain */
      }
      const turn2Messages = bodies[1]!.messages;
      const assistant = turn2Messages.find((m) => m.role === "assistant");
      expect(Object.hasOwn(assistant!, "reasoning_content")).toBe(false);
    });

    it("pins thinking=enabled for v4-pro and sends the configured reasoning_effort", async () => {
      const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-v4-pro",
        stream: false,
        reasoningEffort: "max",
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      expect(
        (bodies[0]!.thinking as { type?: string } | undefined)?.type,
      ).toBe("enabled");
      expect(bodies[0]!.reasoning_effort).toBe("max");
    });

    it("pins thinking=disabled for deepseek-chat (non-thinking compat alias)", async () => {
      const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-chat",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      expect(
        (bodies[0]!.thinking as { type?: string } | undefined)?.type,
      ).toBe("disabled");
      expect(bodies[0]!.reasoning_effort).toBeUndefined();
    });

    it("omits thinking entirely for unknown models (let the server decide)", async () => {
      const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
      const client = new DeepSeekClient({ apiKey: "sk-test", fetch: fakeFetch });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "some-third-party-model",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      expect(bodies[0]!.thinking).toBeUndefined();
      expect(bodies[0]!.reasoning_effort).toBe("high");
    });

    it("skips the thinking toggle for Azure endpoints (issue #1299)", async () => {
      const { fetch: fakeFetch, bodies } = capturingFetch([{ content: "done" }]);
      const client = new DeepSeekClient({
        apiKey: "sk-test",
        baseUrl: "https://my-project.services.ai.azure.com/openai/v1",
        fetch: fakeFetch,
      });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        model: "deepseek-v4-pro",
        stream: false,
      });
      for await (const _ev of loop.step("hello")) {
        /* drain */
      }
      expect(bodies[0]!.thinking).toBeUndefined();
      expect(bodies[0]!.reasoning_effort).toBe("high");
    });
  });
});

// Thinking-mode contract: an assistant turn missing `reasoning_content` fails
// *  the whole request, so the loop must repair it and re-send instead of dying.
describe("loop-reasoning-roundtrip", () => {
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
        isReasoningRoundTripError(
          new Error("OpenCode 400: maximum context length is 128000 tokens"),
        ),
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
});

describe("loop-reasoning-preserved", () => {
  function makeLoop(model = "deepseek-reasoner") {
    return new CacheFirstLoop({
      client: makeFakeClient([{ content: "ok" }]).client,
      prefix: new ImmutablePrefix({ system: "s" }),
      model,
      stream: false,
    });
  }

  describe("reasoning survives a conversation replacement", () => {
    it("carries each turn's prior reasoning across a replace", () => {
      const loop = makeLoop();
      loop.replaceConversation("s", [
        { role: "user", content: "q" },
        { role: "assistant", content: "a", reasoning_content: "kept thinking" },
      ]);
      loop.replaceConversation("s", [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ]);

      const assistant = loop.log.toMessages().find((m) => m.role === "assistant");
      expect(assistant?.reasoning_content).toBe("kept thinking");
    });

    it("backfills empty reasoning on a new turn for a thinking model", () => {
      const loop = makeLoop();
      loop.replaceConversation("s", [
        { role: "user", content: "q" },
        { role: "assistant", content: "brand new" },
      ]);

      const assistant = loop.log.toMessages().find((m) => m.role === "assistant");
      expect(assistant?.reasoning_content).toBe("");
    });
  });
});

describe("loop-repetition", () => {
  function detect(chunks: string[]) {
    const detector = new StreamRepetitionDetector();
    for (const chunk of chunks) {
      const result = detector.append(chunk);
      if (result) return result;
    }
    return null;
  }

  describe("StreamRepetitionDetector", () => {
    it("detects a long repeated word", () => {
      const result = detect(["Let me find it:", "wright".repeat(200)]);

      expect(result).toMatchObject({ period: 6, safeLength: 15 });
      expect(result!.repeatedChars).toBeGreaterThanOrEqual(1024);
    });

    it("detects repetition across arbitrary stream chunks", () => {
      const text = `useful prefix ${"wright".repeat(200)}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 7) }, (_, i) =>
        text.slice(i * 7, i * 7 + 7),
      );

      expect(detect(chunks)?.safeLength).toBe("useful prefix ".length);
    });

    it("detects a repeated unit despite variable whitespace", () => {
      const unit = "tool_result";
      const repeated = Array.from({ length: 120 }, (_, i) => {
        if (i % 5 === 0) return unit;
        if (i % 3 === 0) return `${unit}\n\n`;
        return `${unit}\n`;
      }).join("");
      const text = `useful prefix\n${repeated}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 13) }, (_, i) =>
        text.slice(i * 13, i * 13 + 13),
      );

      expect(detect(chunks)).toMatchObject({
        period: unit.length,
        safeLength: "useful prefix\n".length,
      });
    });

    it("detects an alternating repeated sentence block", () => {
      const first =
        'Actually, "loss" might be a specific animation sequence. Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n';
      const second =
        "Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n";
      const prefix =
        "Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n";
      const text = `${prefix}${`${first}${second}`.repeat(20)}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 29) }, (_, i) =>
        text.slice(i * 29, i * 29 + 29),
      );

      expect(detect(chunks)?.safeLength).toBe(0);
    });

    it("detects a repeated multi-paragraph reasoning cycle larger than maxPeriod", () => {
      expect(MATERIAL_REASONING_LOOP.replace(/\s/gu, "").length).toBeGreaterThan(1024);
      const prefix = "Verified setup facts ZXQJ\n\n";
      const text = `${prefix}${MATERIAL_REASONING_LOOP.repeat(4)}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 53) }, (_, i) =>
        text.slice(i * 53, i * 53 + 53),
      );

      expect(detect(chunks)?.safeLength).toBe(prefix.length);
    });

    it("detects repeating words early with word-bias", () => {
      // A word like "read_file" (period 9) should trigger after ~8 repeats (72 chars), not waiting for 1024 chars.
      const chunks = ["Let me check: ", ...Array.from({ length: 12 }, () => "read_file")];
      const detector = new StreamRepetitionDetector();
      let detectedAtChunk = -1;
      for (let i = 0; i < chunks.length; i++) {
        const res = detector.append(chunks[i]!);
        if (res) {
          detectedAtChunk = i;
          expect(res.period).toBe(9);
          expect(res.safeLength).toBe("Let me check: ".length);
          expect(res.repeatedChars).toBeLessThan(150);
          break;
        }
      }
      // Should be detected around chunk 8 (72 chars of read_file), well before chunk 12
      expect(detectedAtChunk).toBeGreaterThanOrEqual(7);
      expect(detectedAtChunk).toBeLessThanOrEqual(9);
    });

    it("does not flag short repetitions or ordinary prose", () => {
      expect(detect(["ha".repeat(15)])).toBeNull();
      expect(detect(["0123456789abcdef".repeat(2)])).toBeNull();
      expect(detect(["-".repeat(80)])).toBeNull(); // Standard divider line
      expect(detect(["../".repeat(10)])).toBeNull(); // Deep relative path
      expect(
        detect([
          "The model checked the source folder, compared the files, and explained what was missing.",
        ]),
      ).toBeNull();
      const largeUniqueProse = Array.from(
        { length: 240 },
        (_, i) =>
          `Finding ${i}: inspected artifact ${i * 17}, compared unique path segment ${i * 31}, and recorded distinct evidence ${i * 47}.`,
      ).join("\n");
      expect(detect([largeUniqueProse])).toBeNull();
    });

    it("does not flag comment-separator rules and banner boxes", () => {
      // Regression: generated source routinely repeats short rules ('----', '###',
      // '====', box-drawing). These carry no letters or digits, so they are layout,
      // not the repeated words/identifiers that mark a degenerating model.
      const rule = "-".repeat(40);
      expect(detect([Array.from({ length: 8 }, () => rule).join("\n")])).toBeNull();
      expect(detect([Array.from({ length: 6 }, () => `// ${rule}`).join("\n")])).toBeNull();
      expect(detect([Array.from({ length: 6 }, () => `# ${rule}`).join("\n")])).toBeNull();
      expect(detect(["=".repeat(200)])).toBeNull();
      expect(detect(["#".repeat(200)])).toBeNull();
      expect(detect(["─".repeat(200)])).toBeNull();
    });

    it("does not flag a wide markdown table separator row", () => {
      // Regression: the whitespace-stripped separator row ('|------|------|…')
      // is a long small-period run of pipes and dashes — layout, not a stall.
      const separator = `|${"------|".repeat(12)}`;
      expect(detect([separator])).toBeNull();
      expect(detect([`| Col A | Col B |\n${separator}`])).toBeNull();
      expect(detect(["|-----|-----|".repeat(30)])).toBeNull();
    });

    it("still flags repeating content even when wrapped in decoration", () => {
      // The layout exemption keys on the repeating unit carrying a letter/digit,
      // so decorated but genuine repetition is still caught.
      expect(detect(["## Notice ##".repeat(40)])).toMatchObject({ period: 10, safeLength: 0 });
    });

    it("still aborts an unbounded character flood despite the layout exemption", () => {
      // The exemption has a hard ceiling: a run past it is a runaway flood, not a
      // divider, so detection is never silently disabled.
      expect(detect(["-".repeat(6000)])).toMatchObject({ period: 1, safeLength: 0 });
      expect(detect(["../".repeat(2000)])).toMatchObject({ period: 3, safeLength: 0 });
    });

    it("detects long repeating cycles", () => {
      expect(detect(["ha".repeat(400)])).toMatchObject({ period: 2, safeLength: 0 });
      expect(detect(["0123456789abcdef".repeat(60)])).toMatchObject({ period: 16, safeLength: 0 });
    });

    it("does not abort a healthy stream over a short repeated paragraph tail", () => {
      // Regression: a productive reasoning stream that restates one hypothesis
      // verbatim 3x near the end must not be killed as "repetitive output".
      const healthy = Array.from(
        { length: 30 },
        (_, i) =>
          `Step ${i}: inspected the retry branch, confirmed the 5xx path retries once, and noted finding ${i * 7}.`,
      ).join("\n\n");
      const para =
        "Let me reconsider the providerErrorRetryable check. For a 500 error it should be true, unless the error is being thrown as a 4xx by the parse path. But opencode uses chat-completions, not responses, so that is unlikely.";
      const text = `${healthy}\n\n${`${para}\n`.repeat(3)}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 11) }, (_, i) =>
        text.slice(i * 11, i * 11 + 11),
      );
      expect(detect(chunks)).toBeNull();
    });

    it("does not abort after only three long-form deliberation cycles", () => {
      const healthy = Array.from(
        { length: 36 },
        (_, i) =>
          `Finding ${i}: checked session deletion path ${i * 11}, compared backend event ${i * 13}, and preserved distinct evidence ${i * 17}.`,
      ).join("\n\n");
      const cycle = Array.from(
        { length: 8 },
        (_, i) =>
          `Actually, let me reconsider option ${i}. The backend and frontend state need to remain synchronized, so I should verify ordering case ${i * 19} before choosing the cleanest fix.`,
      ).join("\n\n");
      expect(cycle.replace(/\s/gu, "").length).toBeGreaterThan(512);
      const text = `${healthy}\n\n${cycle}\n\n${cycle}\n\n${cycle}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 17) }, (_, i) =>
        text.slice(i * 17, i * 17 + 17),
      );

      expect(detect(chunks)).toBeNull();
    });

    it("aborts once the repeated paragraph run grows unambiguous", () => {
      const healthy = Array.from(
        { length: 30 },
        (_, i) =>
          `Step ${i}: inspected the retry branch, confirmed the 5xx path retries once, and noted finding ${i * 7}.`,
      ).join("\n\n");
      const para =
        "Let me reconsider the providerErrorRetryable check. For a 500 error it should be true, unless the error is being thrown as a 4xx by the parse path. But opencode uses chat-completions, not responses, so that is unlikely.";
      // "END" (no trailing period) keeps the healthy tail from matching the
      // paragraph's final '.', so the run boundary is exact.
      const bridge = " END";
      const separator = "\n\n";
      const text = `${healthy}${bridge}${separator}${para.repeat(8)}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 11) }, (_, i) =>
        text.slice(i * 11, i * 11 + 11),
      );
      const result = detect(chunks);
      expect(result).not.toBeNull();
      // The healthy prefix, its bridge, and the separator must be preserved.
      expect(result!.safeLength).toBe(healthy.length + bridge.length + separator.length);
      expect(result!.repeatedChars).toBeGreaterThanOrEqual(1024);
    });

    it("aborts a prefix-free short paragraph cycle (repetition dominates the stream)", () => {
      const para =
        "Let me reconsider the providerErrorRetryable check. For a 500 error it should be true, unless the error is being thrown as a 4xx by the parse path. But opencode uses chat-completions, not responses, so that is unlikely.";
      const text = `${para}\n${para}\n${para}`;
      const chunks = Array.from({ length: Math.ceil(text.length / 13) }, (_, i) =>
        text.slice(i * 13, i * 13 + 13),
      );
      expect(detect(chunks)).toMatchObject({ safeLength: 0 });
    });

    it("keeps memory bounded while preserving absolute safe offsets", () => {
      const detector = new StreamRepetitionDetector({
        minRepeatedChars: 256,
        minRepeats: 12,
        maxBufferChars: 512,
      });
      expect(detector.append("x".repeat(5000))).toMatchObject({ safeLength: 0, period: 1 });
    });
  });
});

describe("loop-repetition-guard-toggle", () => {
  function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
    return makeFakeClient(responses, { echoMessages: true }).client;
  }

  async function drain(loop: CacheFirstLoop, prompt: string): Promise<LoopEvent[]> {
    const out: LoopEvent[] = [];
    for await (const ev of loop.step(prompt)) out.push(ev);
    return out;
  }

  /** Four iterations that re-emit the identical thought while the tool ARGS drift,
   *  so the storm breaker never trips and only the reasoning guard can catch it. */
  const REASONING = "I wonder whether the answer is right. Let me reconsider.";

  function reasoningLoopResponses(): FakeResponseShape[] {
    return [
      ...Array.from({ length: 4 }, (_, i) => ({
        reasoning_content: REASONING,
        content: "",
        tool_calls: [
          {
            id: `c${i}`,
            type: "function" as const,
            function: { name: "probe", arguments: JSON.stringify({ i }) },
          },
        ],
      })),
      { content: "done." },
    ];
  }

  function makeRegistry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    return reg;
  }

  const isReasoningWarning = (e: LoopEvent): boolean =>
    e.role === "warning" && /re-thinking the same point/i.test(e.content ?? "");

  describe("CacheFirstLoop repetition-guard toggle", () => {
    it("defaults repetitionGuardEnabled to false and can be hot-configured", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "hi" }]),
        prefix: new ImmutablePrefix({ system: "test system prompt" }),
      });
      expect(loop.repetitionGuardEnabled).toBe(false);

      loop.configure({ repetitionGuardEnabled: true });
      expect(loop.repetitionGuardEnabled).toBe(true);

      loop.configure({ repetitionGuardEnabled: false });
      expect(loop.repetitionGuardEnabled).toBe(false);
    });

    it("does NOT collapse a repeated-reasoning loop when the guard is disabled", async () => {
      const reg = makeRegistry();
      const loop = new CacheFirstLoop({
        client: makeClient(reasoningLoopResponses()),
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
        tools: reg,
        stream: false,
        maxToolIters: 8,
      });

      const events = await drain(loop, "explore");

      // Guard is off by default: no "stuck re-thinking" warning.
      expect(events.some(isReasoningWarning)).toBe(false);
    });

    it("collapses a repeated-reasoning loop once the guard is enabled", async () => {
      const reg = makeRegistry();
      const loop = new CacheFirstLoop({
        client: makeClient(reasoningLoopResponses()),
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
        tools: reg,
        stream: false,
        repetitionGuardEnabled: true,
        maxToolIters: 8,
      });

      const events = await drain(loop, "explore");

      expect(events.some(isReasoningWarning)).toBe(true);
    });
  });
});

describe("loop-message-model-stamp", () => {
  describe("assistant records carry the model that produced them", () => {
    it("stamps the producing model on the persisted record", () => {
      const record = buildAssistantMessage("answer", [], "deepseek-v4-pro", "thinking");
      expect(record.model).toBe("deepseek-v4-pro");
      expect(record.reasoning_content).toBe("thinking");
    });

    it("stamps the model a fallback switch moved the turn to", () => {
      const primary = buildAssistantMessage("first", [], "deepseek-v4-flash", "a");
      const fallback = buildAssistantMessage("second", [], "opencode/qwen3.8-max", "b");
      expect([primary.model, fallback.model]).toEqual([
        "deepseek-v4-flash",
        "opencode/qwen3.8-max",
      ]);
    });

    it("stamps abort notices with the model they were attributed to", () => {
      expect(buildSyntheticAssistantMessage("[aborted]", "deepseek-v4-flash").model).toBe(
        "deepseek-v4-flash",
      );
    });

    it("never sends the stamp to a provider", () => {
      const record = buildAssistantMessage("answer", [], "deepseek-v4-pro", "");
      const [wire] = stripTranscriptMarkers([record]);
      expect(wire).not.toHaveProperty("model");
      expect(wire).toMatchObject({ role: "assistant", content: "answer" });
    });
  });
});

// CacheFirstLoop hook wiring — confirms the loop honors `hooks` and exposes a swappable list for a hook reload.
describe("loop-hooks", () => {
  function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
    return makeFakeClient(responses, { echoMessages: true }).client;
  }

  describe("CacheFirstLoop hook wiring", () => {
    it("default hooks list is empty (zero overhead when no settings.json)", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
      });
      expect(loop.hooks).toEqual([]);
    });

    it("accepts a hooks list via options", () => {
      const hooks: ResolvedHook[] = [
        { event: "Stop", scope: "global", source: "/x", command: "echo done" },
      ];
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
        hooks,
      });
      expect(loop.hooks).toEqual(hooks);
    });

    it("hooks field is mutable so a hook reload can swap without rebuild", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
      });
      const fresh: ResolvedHook[] = [
        { event: "PreToolUse", scope: "project", source: "/x", command: "true" },
      ];
      loop.hooks = fresh;
      expect(loop.hooks).toEqual(fresh);
    });

    it("hookCwd defaults to process.cwd() when not provided", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
      });
      expect(loop.hookCwd).toBe(process.cwd());
    });

    it("hookCwd takes the explicit override when set", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
        hookCwd: "/some/sandbox/root",
      });
      expect(loop.hookCwd).toBe("/some/sandbox/root");
    });

    it("a no-tool-call turn never dispatches hooks (PreToolUse only fires around tools)", async () => {
      // Sanity check: a plain text response means no PreToolUse hook
      // would be invoked even if one were configured. We assert only
      // through observable events here — no hook = no warning rows.
      const client = makeClient([{ content: "just chatting" }]);
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        hooks: [{ event: "PreToolUse", scope: "global", source: "/x", command: "noop" }],
      });
      const events: LoopEvent[] = [];
      for await (const ev of loop.step("hi")) events.push(ev);
      expect(events.find((e) => e.role === "warning")).toBeUndefined();
      expect(events.find((e) => e.role === "assistant_final")?.content).toBe("just chatting");
    });
  });
});

// CacheFirstLoop.inflight — finally-driven cleanup around runOneToolCall.
describe("loop-inflight", () => {
  function makeClient(responses: FakeResponseShape[]): DeepSeekClient {
    return makeFakeClient(responses, { echoMessages: true }).client;
  }

  async function drain(loop: CacheFirstLoop, prompt: string): Promise<LoopEvent[]> {
    const out: LoopEvent[] = [];
    for await (const ev of loop.step(prompt)) out.push(ev);
    return out;
  }

  describe("CacheFirstLoop.inflight", () => {
    it("starts empty and exposes the InflightSet via getter", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
      });
      expect(loop.inflight.size).toBe(0);
      expect(loop.inflight.has("anything")).toBe(false);
    });

    it("tool_start event carries a callId that matches the inflight key", async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: "echo",
        description: "test tool",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        fn: async () => "ok",
      });
      const loop = new CacheFirstLoop({
        client: makeClient([
          {
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "echo", arguments: "{}" },
              },
            ],
          },
          { content: "all done" },
        ]),
        prefix: new ImmutablePrefix({ system: "s" }),
        tools,
        stream: false,
      });
      const events = await drain(loop, "go");
      const start = events.find((e) => e.role === "tool_start");
      expect(start).toBeDefined();
      expect(start?.callId).toBe("call_abc");
      // Set is drained after the turn completes — every dispatch's finally fired.
      expect(loop.inflight.size).toBe(0);
    });

    it("inflight is empty after a tool throws — finally still removes the id", async () => {
      const tools = new ToolRegistry();
      tools.register({
        name: "boom",
        description: "always fails",
        readOnly: true,
        parameters: { type: "object", properties: {} },
        fn: async () => {
          throw new Error("simulated tool failure");
        },
      });
      const loop = new CacheFirstLoop({
        client: makeClient([
          {
            tool_calls: [
              {
                id: "call_boom",
                type: "function",
                function: { name: "boom", arguments: "{}" },
              },
            ],
          },
          { content: "recovered" },
        ]),
        prefix: new ImmutablePrefix({ system: "s" }),
        tools,
        stream: false,
      });
      await drain(loop, "go");
      expect(loop.inflight.size).toBe(0);
      expect(loop.inflight.has("call_boom")).toBe(false);
    });

    it("clearLog drains the inflight set so a new session can't strand a stale callId", () => {
      const loop = new CacheFirstLoop({
        client: makeClient([{ content: "x" }]),
        prefix: new ImmutablePrefix({ system: "s" }),
      });
      loop.inflight.add("call-1");
      loop.inflight.add("call-2");
      expect(loop.inflight.size).toBe(2);
      loop.clearLog();
      expect(loop.inflight.size).toBe(0);
    });
  });
});

// Loop-level cache invariant: consecutive model requests extend the previous request by
// *  appended messages only. Folds, clears, and tool-set changes are deliberate misses, exempt.
describe("loop-append-invariant", () => {
  const SYSTEM_PROMPT = "You are a terse coding assistant. Answer in one sentence.";

  /** Every message of `prev` must appear byte-identical at the head of `next`. */
  function assertAppendExtension(prev: ChatMessage[], next: ChatMessage[], label: string): void {
    expect(next.length, `${label}: request grew`).toBeGreaterThanOrEqual(prev.length);
    for (let i = 0; i < prev.length; i++) {
      expect(next[i], `${label}: message ${i} rewritten`).toEqual(prev[i]);
    }
  }

  async function drainTurn(loop: CacheFirstLoop, text: string): Promise<void> {
    for await (const ev of loop.step(text)) {
      void ev;
    }
  }

  describe("append-only wire invariant (steady state)", () => {
    it("consecutive turns extend the previous request by appended messages only", async () => {
      const fake = makeFakeClient([{ content: "answer one" }, { content: "answer two" }]);
      const loop = new CacheFirstLoop({
        client: fake.client,
        prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT }),
        stream: false,
      });

      await drainTurn(loop, "first question");
      await drainTurn(loop, "second question");

      expect(fake.captured).toHaveLength(2);
      assertAppendExtension(
        fake.captured[0]!.messages,
        fake.captured[1]!.messages,
        "turn 2 vs turn 1",
      );
      // The second turn's appends are exactly the prior assistant reply + the new user prompt.
      expect(fake.captured[1]!.messages.length).toBe(fake.captured[0]!.messages.length + 2);
    });

    it("a queued steer appends as a synthetic user record; history bytes stay put", async () => {
      const fake = makeFakeClient([{ content: "answer one" }, { content: "answer two" }]);
      const loop = new CacheFirstLoop({
        client: fake.client,
        prefix: new ImmutablePrefix({ system: SYSTEM_PROMPT }),
        stream: false,
      });

      await drainTurn(loop, "first question");
      loop.steer("also mention the tradeoffs");
      await drainTurn(loop, "second question");

      expect(fake.captured).toHaveLength(2);
      const req1 = fake.captured[0]!.messages;
      const req2 = fake.captured[1]!.messages;
      assertAppendExtension(req1, req2, "steer turn vs turn 1");
      // The steer lands as a user-role record appended after the new prompt;
      // the client strips the internal synthetic flag before the wire.
      const steerMsg = req2[req2.length - 1]!;
      expect(steerMsg.role).toBe("user");
      expect(steerMsg.content).toContain("also mention the tradeoffs");
    });
  });
});

describe("loop-context-replace", () => {
  function makeLoop(system = "orig system"): CacheFirstLoop {
    const client: DeepSeekClient = makeFakeClient([], { echoMessages: true }).client;
    return new CacheFirstLoop({
      client,
      prefix: new ImmutablePrefix({ system }),
      model: "deepseek-chat",
      stream: false,
    });
  }

  describe("CacheFirstLoop.replaceConversation", () => {
    it("replaces the system prompt and the message log wholesale", () => {
      const loop = makeLoop();
      loop.log.append({ role: "user", content: "old" });

      const result = loop.replaceConversation("new system", [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);

      expect(result.systemChanged).toBe(true);
      expect(loop.prefix.system).toBe("new system");
      expect(loop.log.toMessages()).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]);
    });

    it("reports systemChanged=false when the prompt is unchanged", () => {
      const loop = makeLoop("same");
      const result = loop.replaceConversation("same", [{ role: "user", content: "x" }]);
      expect(result.systemChanged).toBe(false);
      expect(loop.prefix.system).toBe("same");
    });

    it("heals orphan tool messages before applying (never ships an invalid shape)", () => {
      const loop = makeLoop();
      const result = loop.replaceConversation("s", [
        { role: "user", content: "q" },
        // A tool result with no preceding tool_calls is unvalidatable, healed away.
        { role: "tool", tool_call_id: "missing", content: "orphan" },
      ]);
      expect(result.dropped).toBe(1);
      expect(loop.log.toMessages()).toEqual([{ role: "user", content: "q" }]);
    });
  });
});
