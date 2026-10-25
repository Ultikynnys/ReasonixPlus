// Consolidated from 5 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { describe, expect, it } from "vitest";
import type { ClientStatus, DeepSeekClient, StreamChunk } from "../src/client.js";
import type { ReasoningEffort } from "../src/config.js";
import {
  CacheFirstLoop,
  type LoopEvent,
  formatLoopError,
  healLoadedMessages,
  healLoadedMessagesByTokens,
  stripHallucinatedToolMarkup,
} from "../src/loop.js";
import { looksCutOffMidSentence, looksLikePrematureStop } from "../src/loop/premature-stop.js";
import { type StreamModelResult, streamModelResponse } from "../src/loop/streaming.js";
import { extractThinkingTags } from "../src/loop/thinking.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { ToolRegistry } from "../src/tools.js";
import type { ChatMessage } from "../src/types.js";
import { type FakeResponseShape, makeFakeClient } from "./support/fake-client.js";

// Loop error decorator — context-overflow gets a user hint; everything else passes through.
describe("loop-error", () => {
  describe("formatLoopError", () => {
    it("annotates a DeepSeek 400 'maximum context length' error", () => {
      const raw = new Error(
        'DeepSeek 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens. ' +
          "However, you requested 929452 tokens (929452 in the messages, 0 in the completion). " +
          'Please reduce the length of the messages or completion."}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/Context overflow/);
      expect(out).toMatch(/Start a new conversation/);
      expect(out).toMatch(/929,452 tokens/); // pretty-printed from the raw JSON
    });

    it("401 → authentication hint with setup/env var fix", () => {
      const raw = new Error(
        'DeepSeek 401: {"error":{"message":"Authentication Fails, Your api key is invalid"}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/Authentication failed/);
      expect(out).toMatch(/DEEPSEEK_API_KEY in Settings/);
      expect(out).toMatch(/DEEPSEEK_API_KEY/);
      // Inner error.message survives the unwrap
      expect(out).toContain("Your api key is invalid");
    });

    it("Upstream 401 without host info → generic upstream hint, no DeepSeek-specific fix", () => {
      const raw = new Error('Upstream 401: {"error":{"message":"Incorrect API key provided"}}');
      const out = formatLoopError(raw);
      expect(out).toMatch(/Authentication failed/);
      expect(out).toMatch(/401/);
      expect(out).not.toContain("DEEPSEEK_API_KEY");
      expect(out).not.toContain("platform.deepseek.com");
      // Inner error.message survives the unwrap
      expect(out).toContain("Incorrect API key provided");
    });

    it("Upstream 401 against api.openai.com → OpenAI-branded hint with OPENAI_API_KEY fix", () => {
      const raw = new Error('Upstream 401: {"error":{"message":"Incorrect API key provided"}}');
      const out = formatLoopError(raw, undefined, { upstreamHost: "https://api.openai.com/v1" });
      expect(out).toContain("OpenAI 401");
      expect(out).toContain("OPENAI_API_KEY");
      expect(out).toContain("Incorrect API key provided");
      expect(out).not.toContain("DEEPSEEK_API_KEY");
      expect(out).not.toContain("platform.deepseek.com");
    });

    it("DeepSeek 401 keeps the DeepSeek-branded hint", () => {
      const raw = new Error('DeepSeek 401: {"error":{"message":"Authentication Fails"}}');
      const out = formatLoopError(raw);
      expect(out).toContain("DeepSeek 401");
      expect(out).toContain("DEEPSEEK_API_KEY");
      expect(out).toContain("Authentication Fails");
    });

    it("402 → balance hint with top-up URL", () => {
      const raw = new Error('DeepSeek 402: {"error":{"message":"Insufficient Balance"}}');
      const out = formatLoopError(raw);
      expect(out).toMatch(/Out of balance/);
      expect(out).toMatch(/top_up/);
      expect(out).toContain("Insufficient Balance");
    });

    it("422 → invalid parameter with the server's reason", () => {
      const raw = new Error(
        'DeepSeek 422: {"error":{"message":"Invalid value for `temperature`: must be between 0 and 2"}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/Invalid parameter/);
      expect(out).toContain("temperature");
    });

    it("429 → concurrency-limit hint with cap numbers + remediation (#1522)", () => {
      const raw = new Error(
        'DeepSeek 429: {"error":{"message":"Too Many Requests, please reduce concurrency"}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/concurrency limit/);
      expect(out).toMatch(/500/);
      expect(out).toMatch(/2500/);
      expect(out).toContain("reduce concurrency");
      expect(out).toContain("platform.deepseek.com");
    });

    it("OpenAI 429 with 'no credits remaining' → out-of-credits hint, not the concurrency advice", () => {
      const raw = new Error(
        'Upstream 429: {"error":{"message":"You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/"}}',
      );
      const out = formatLoopError(raw, undefined, { upstreamHost: "https://api.openai.com/v1" });
      expect(out).toContain("OpenAI");
      expect(out).toContain("(429)");
      expect(out).toMatch(/out of credits/i);
      expect(out).toContain("platform.openai.com");
      expect(out).toMatch(/sign in with your ChatGPT account/i);
      expect(out).not.toMatch(/in-flight/i);
    });

    it("OpenAI 429 concurrency → generic rate-limit hint stays", () => {
      const raw = new Error(
        'Upstream 429: {"error":{"message":"Too many requests in a short period. Please retry."}}',
      );
      const out = formatLoopError(raw, undefined, { upstreamHost: "https://api.openai.com/v1" });
      expect(out).toContain("OpenAI rate limit hit (429)");
      expect(out).toMatch(/in-flight/i);
    });

    it("400 (non-overflow) → extracts the inner error message, drops the JSON wrapping", () => {
      const raw = new Error(
        'DeepSeek 400: {"error":{"message":"request body malformed at messages[3].role"}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/Bad request/);
      expect(out).toContain("messages[3].role");
      expect(out).not.toContain("{"); // JSON wrapping is gone
    });

    it("Z.AI insufficient-resource 429 uses only Z.AI billing and Coding Plan guidance", () => {
      const raw = new Error(
        'Z.AI 429: {"error":{"message":"Insufficient balance or no resource package"}}',
      );
      const out = formatLoopError(raw, undefined, { provider: "zai" });
      expect(out).toContain("Z.AI");
      expect(out).toContain("Insufficient balance or no resource package");
      expect(out).toContain("Coding Plan");
      expect(out).not.toContain("OpenAI");
      expect(out).not.toContain("ChatGPT");
    });

    it("Experiential 401 → gateway-branded hint naming the xpl_ key", () => {
      const raw = new Error('Experiential 401: {"error":{"message":"Invalid API key"}}');
      const out = formatLoopError(raw);
      expect(out).toContain("Experiential Labs authentication failed (401)");
      expect(out).toContain("EXPERIENTIAL_API_KEY");
      expect(out).toContain("Invalid API key");
      expect(out).not.toContain("DEEPSEEK_API_KEY");
    });

    it.each([
      ["deepseek", "DeepSeek 401: bad key", "DEEPSEEK_API_KEY"],
      ["openai", "OpenAI 401: bad key", "OPENAI_API_KEY"],
      ["ollama", "Ollama 401: bad key", "OLLAMA_API_KEY"],
      ["gemini", "Antigravity 401: expired", "Google Antigravity"],
      ["zai", "Z.AI 401: bad key", "ZAI_API_KEY"],
      ["opencode", "OpenCode 401: bad key", "OPENCODE_API_KEY"],
    ] as const)("%s authentication has provider-only guidance", (provider, message, marker) => {
      const out = formatLoopError(new Error(message), undefined, { provider });
      expect(out).toContain(marker);
      for (const forbidden of [
        "DEEPSEEK_API_KEY",
        "OPENAI_API_KEY",
        "OLLAMA_API_KEY",
        "ZAI_API_KEY",
        "OPENCODE_API_KEY",
      ]) {
        if (forbidden !== marker) expect(out).not.toContain(forbidden);
      }
    });

    it.each([
      ["OpenAI 400: invalid", "openai"],
      ["Ollama 404: model missing", "ollama"],
      ["Antigravity 403: forbidden", "gemini"],
      ["Z.AI 429: rate limit", "zai"],
      ["OpenCode 429: rate limit", "opencode"],
    ] as const)("recognizes %s as a non-retryable provider 4xx", (message) => {
      expect(formatLoopError(new Error(message))).not.toBe(message);
    });

    it("leaves non-DeepSeek-shaped errors untouched", () => {
      const raw = new Error("socket hang up");
      expect(formatLoopError(raw)).toBe("socket hang up");
    });

    it("Ollama body-too-large maps to the image-payload message, not the generic request hint", () => {
      const raw = new Error('Ollama 400: {"error":"http: request body too large"}');
      const out = formatLoopError(raw);
      expect(out).toMatch(/images in context made the payload too large/);
      expect(out).toMatch(/smaller or cropped image/);
      expect(out).toContain("request body too large");
    });

    it("tolerates an overflow error without a requested-tokens figure", () => {
      const raw = new Error("DeepSeek 400: This model's maximum context length is 131072 tokens.");
      const out = formatLoopError(raw);
      expect(out).toMatch(/Context overflow/);
      expect(out).toMatch(/too many tokens/);
    });

    it("context-overflow message mentions both the 1M V4 limit and the legacy 131k", () => {
      const raw = new Error(
        'DeepSeek 400: {"error":{"message":"This model\'s maximum context length is 131072 tokens. However, you requested 200000 tokens."}}',
      );
      const out = formatLoopError(raw);
      expect(out).toMatch(/1M/);
      expect(out).toMatch(/131k/);
    });

    it("503 with no probe → DS-side outage notice + retry hint, no probe-specific line", () => {
      const raw = new Error('DeepSeek 503: {"error":{"message":"Service unavailable"}}');
      const out = formatLoopError(raw);
      expect(out).toMatch(/service unavailable \(503\)/);
      expect(out).toMatch(/DeepSeek-side problem, not Reasonix/);
      expect(out).toMatch(/Already retried 4×/);
      expect(out).toContain("status.deepseek.com");
      expect(out).not.toMatch(/main API answered/);
      expect(out).not.toMatch(/unreachable from your network/);
    });

    it("503 with reachable probe → tells user DS chat endpoint is sick but main API is up", () => {
      const raw = new Error("DeepSeek 503: ");
      const out = formatLoopError(raw, { reachable: true });
      expect(out).toMatch(/main API answered our health check/);
      expect(out).toMatch(/partial outage on their side/);
      expect(out).not.toMatch(/check your network/);
    });

    it("503 with unreachable probe → tells user DS or their network is down, network-first hint", () => {
      const raw = new Error("DeepSeek 503: ");
      const out = formatLoopError(raw, { reachable: false });
      expect(out).toMatch(/unreachable from your network/);
      expect(out).toMatch(/check your network/);
      expect(out).not.toMatch(/main API answered/);
    });

    it("500/502/504 also remap to the DS-side outage notice", () => {
      for (const status of [500, 502, 504]) {
        const out = formatLoopError(new Error(`DeepSeek ${status}: `));
        expect(out).toMatch(new RegExp(`service unavailable \\(${status}\\)`));
        expect(out).toMatch(/DeepSeek-side problem/);
      }
    });

    it("tolerates an empty body on a 5xx — still produces the outage notice", () => {
      const out = formatLoopError(new Error("DeepSeek 500: "));
      expect(out).toMatch(/service unavailable \(500\)/);
    });

    it("5xx from Ollama → Ollama-specific wording with no DeepSeek hint", () => {
      const out = formatLoopError(new Error("Ollama 500: daemon failed"), undefined, {
        provider: "ollama",
        upstreamHost: "http://localhost:11434/v1",
      });
      expect(out).toContain("Ollama service failure (500)");
      expect(out).toContain("local daemon logs");
      expect(out).not.toContain("status.deepseek.com");
      expect(out).not.toMatch(/DeepSeek-side problem/);
    });

    it("5xx from api.deepseek.com → still gets the DS-specific wording (allow-list)", () => {
      const out = formatLoopError(new Error("DeepSeek 503: "), undefined, {
        upstreamHost: "https://api.deepseek.com",
      });
      expect(out).toMatch(/DeepSeek-side problem/);
      expect(out).toContain("status.deepseek.com");
    });
  });

  describe("healLoadedMessagesByTokens", () => {
    it("shrinks oversized paired tool-call args when loading an old session", () => {
      const bigArgs = JSON.stringify({
        path: "src/large.ts",
        content: Array.from({ length: 1200 }, (_, i) => `line ${i}: replacement`).join("\n"),
      });
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "write_blob", arguments: bigArgs } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ];

      const healed = healLoadedMessagesByTokens(messages, 500);

      expect(healed.healedCount).toBe(1);
      expect(healed.tokensSaved).toBeGreaterThan(0);
      const assistant = healed.messages[0];
      if (assistant?.role !== "assistant" || !assistant.tool_calls) {
        throw new Error("assistant tool call missing");
      }
      const savedArgs = assistant.tool_calls[0]!.function.arguments;
      expect(savedArgs.length).toBeLessThan(bigArgs.length / 5);
      expect(JSON.parse(savedArgs).content).toMatch(/shrunk/);
    });
  });

  describe("healLoadedMessages", () => {
    it("truncates a giant tool result, leaves user/assistant messages alone", () => {
      const big = "X".repeat(80_000);
      // Needs a proper assistant.tool_calls + matching tool response so
      // the 0.4.12+ validator doesn't prune the tool as stray.
      const messages: ChatMessage[] = [
        { role: "user", content: "read the big file" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: big },
        { role: "assistant", content: "here's what I found" },
      ];
      const { messages: healed, healedCount, healedFrom } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(1);
      expect(healedFrom).toBe(80_000);
      expect(healed[0]).toEqual(messages[0]); // user untouched
      expect(healed[1]).toEqual(messages[1]); // assistant untouched
      expect(typeof healed[2]!.content).toBe("string");
      expect((healed[2]!.content as string).length).toBeLessThan(33_000);
      expect(healed[2]!.content).toContain("truncated");
      expect(healed[3]).toEqual(messages[3]); // trailing assistant untouched
    });

    it("is a no-op when every message fits AND pairing is valid", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hi back" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(0);
      expect(healed).toEqual(messages);
    });

    it("drops empty assistant messages that have no tool calls", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "   " },
        { role: "user", content: "still there?" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(2);
      expect(healed).toEqual([
        { role: "user", content: "hi" },
        { role: "user", content: "still there?" },
      ]);
    });

    it("heals multiple oversized tool messages in one pass (all properly paired)", () => {
      // Each oversized tool MUST be the response to a preceding
      // assistant.tool_calls, otherwise the 0.4.12 validator prunes it.
      const messages: ChatMessage[] = [
        { role: "user", content: "do three things" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "t1", type: "function", function: { name: "x", arguments: "{}" } },
            { id: "t2", type: "function", function: { name: "x", arguments: "{}" } },
            { id: "t3", type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "A".repeat(40_000) },
        { role: "tool", tool_call_id: "t2", content: "B".repeat(50_000) },
        { role: "tool", tool_call_id: "t3", content: "small" },
      ];
      const { healedCount, healedFrom } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(2);
      expect(healedFrom).toBe(90_000);
    });

    it("drops stray tool messages that have no preceding assistant.tool_calls", () => {
      // This is the shape that triggered the "tool must be a response
      // to a preceding tool_calls" 400 — a tool entry with no opener.
      const messages: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "stray", content: "orphan result" },
        { role: "assistant", content: "sure" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(1);
      expect(healed.map((m) => m.role)).toEqual(["user", "assistant"]);
    });

    it("drops an assistant.tool_calls whose response set is incomplete", () => {
      // tool_calls declares [a, b], but only tool[a] follows. The
      // validator can't deliver this to DeepSeek — drops the pair.
      const messages: ChatMessage[] = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "a", type: "function", function: { name: "x", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "x", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "partial" },
        { role: "assistant", content: "trailing note" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBeGreaterThan(0);
      // Assistant.tool_calls and its partial tool response both dropped;
      // the trailing plain assistant note survives.
      expect(healed.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(healed[1]!.content).toBe("trailing note");
    });

    it("repairs legacy id-less Antigravity tool exchanges by function name", () => {
      // Old Antigravity sessions can contain an id-less call and result. Pair by
      // name, then propagate the generated call id to the result so Google can
      // translate the exchange to providers that require explicit correlation.
      const messages: ChatMessage[] = [
        { role: "user", content: "list it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { type: "function", function: { name: "directory_tree", arguments: '{"depth":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "", name: "directory_tree", content: '["a"]' },
        { role: "assistant", content: "done" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(0);
      expect(healed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      const callId = healed[1]?.tool_calls?.[0]?.id;
      expect(callId).toMatch(/^z-ext-/);
      expect(healed[2]?.tool_call_id).toBe(callId);
    });

    it("strips a dangling assistant-with-tool_calls tail (pre-0.4.12 session files)", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "analyze" },
        { role: "assistant", content: "sure" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "t1", type: "function", function: { name: "probe", arguments: "{}" } },
          ],
        },
        // NO tool response follows — this is the corrupted shape that
        // DeepSeek 400s on the next user message. Heal must drop it.
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(1);
      expect(healed).toHaveLength(2);
      expect(healed[healed.length - 1]!.role).toBe("assistant");
      expect(healed[healed.length - 1]!.content).toBe("sure");
    });

    it("strips MULTIPLE trailing assistant-with-tool_calls entries (stacked corruption)", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "a", type: "function", function: { name: "x", arguments: "{}" } }],
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "b", type: "function", function: { name: "x", arguments: "{}" } }],
        },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      // Both dangling assistant entries trimmed; user message survives.
      expect(healedCount).toBe(2);
      expect(healed).toHaveLength(1);
      expect(healed[0]!.role).toBe("user");
    });

    it("keeps a PAIRED assistant.tool_calls + tool response intact", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "t1", content: "ok" },
      ];
      const { messages: healed, healedCount } = healLoadedMessages(messages, 32_000);
      expect(healedCount).toBe(0);
      expect(healed).toEqual(messages);
    });
  });

  describe("stripHallucinatedToolMarkup", () => {
    it("removes a full DSML function_calls block (the R1 hallucination we saw live)", () => {
      const input = [
        "Let me look at the file structure.",
        "",
        '<｜DSML｜function_calls> <｜DSML｜invoke name="filesystem_edit_file">',
        '  <｜DSML｜parameter name="path" string="true">F:.html</｜DSML｜parameter>',
        '  <｜DSML｜parameter name="edits" string="false">[...]</｜DSML｜parameter>',
        "</｜DSML｜invoke> </｜DSML｜function_calls>",
        "",
        "Saved.",
      ].join("\n");
      const out = stripHallucinatedToolMarkup(input);
      expect(out).toContain("Let me look at the file structure.");
      expect(out).toContain("Saved.");
      expect(out).not.toContain("DSML");
      expect(out).not.toContain("filesystem_edit_file");
    });

    it("removes an Anthropic-style <function_calls> block", () => {
      const input =
        "Here is the plan.\n<function_calls>\n<tool>...</tool>\n</function_calls>\nDone.";
      const out = stripHallucinatedToolMarkup(input);
      expect(out).toContain("Here is the plan.");
      expect(out).toContain("Done.");
      expect(out).not.toContain("function_calls");
    });

    it("strips a truncated DSML opener that never gets closed", () => {
      const input = 'Before the junk.\n<｜DSML｜function_calls> <｜DSML｜invoke name="x"> ...';
      const out = stripHallucinatedToolMarkup(input);
      expect(out).toBe("Before the junk.");
    });

    it("leaves plain prose completely alone", () => {
      const input = "Just a normal summary with no markup anywhere.";
      expect(stripHallucinatedToolMarkup(input)).toBe(input);
    });

    it("returns empty string when ALL content was hallucinated markup", () => {
      const input = "<｜DSML｜function_calls>garbage</｜DSML｜function_calls>";
      expect(stripHallucinatedToolMarkup(input)).toBe("");
    });

    it("strips loose DSML invoke blocks without outer function_calls envelope", () => {
      const input =
        'Answer before call.\n<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter></｜DSML｜invoke>\nAnswer after call.';
      const out = stripHallucinatedToolMarkup(input);
      expect(out).toContain("Answer before call.");
      expect(out).toContain("Answer after call.");
      expect(out).not.toContain("DSML");
      expect(out).not.toContain("read_file");
    });
  });

  describe("extractThinkingTags", () => {
    it("extracts closed <think>...</think> tags and returns cleaned content", () => {
      const input = "<think>Let me ponder this problem first.</think>Here is the solution.";
      const result = extractThinkingTags(input);
      expect(result.content).toBe("Here is the solution.");
      expect(result.extractedReasoning).toBe("Let me ponder this problem first.");
    });

    it("extracts multiple <think> blocks and joins them with newlines", () => {
      const input =
        "<think>First thought.</think>Interim text.<think>Second thought.</think>Final answer.";
      const result = extractThinkingTags(input);
      expect(result.content).toBe("Interim text.Final answer.");
      expect(result.extractedReasoning).toBe("First thought.\n\nSecond thought.");
    });

    it("handles unclosed trailing <think> tags gracefully", () => {
      const input = "Done with step 1.\n<think>Now thinking about step 2...";
      const result = extractThinkingTags(input);
      expect(result.content).toBe("Done with step 1.");
      expect(result.extractedReasoning).toBe("Now thinking about step 2...");
    });

    it("strips stray closing </think> tags", () => {
      const input = "</think>Just normal content here.";
      const result = extractThinkingTags(input);
      expect(result.content).toBe("Just normal content here.");
      expect(result.extractedReasoning).toBeNull();
    });

    it("returns null reasoning and original content when no tags exist", () => {
      const input = "Plain message without any tags.";
      const result = extractThinkingTags(input);
      expect(result.content).toBe(input);
      expect(result.extractedReasoning).toBeNull();
    });
  });
});

describe("loop-streaming-repetition", () => {
  function fakeClient(chunks: StreamChunk[]): DeepSeekClient {
    return {
      stream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as DeepSeekClient;
  }

  async function run(chunks: StreamChunk[]): Promise<StreamModelResult> {
    const gen = streamModelResponse({
      client: fakeClient(chunks),
      model: "test-model",
      messages: [],
      toolSpecs: [],
      signal: new AbortController().signal,
      reasoningEffort: "low" as ReasoningEffort,
      turn: 1,
      repetitionGuardEnabled: true,
    });
    // Drain the async generator; the settled result is the generator's return value.
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return next.value;
  }

  function argChunks(name: string, args: string, deltaSize = 20): StreamChunk[] {
    const chunks: StreamChunk[] = [{ toolCallDelta: { index: 0, id: "call_1", name } }];
    for (let i = 0; i < args.length; i += deltaSize) {
      chunks.push({ toolCallDelta: { index: 0, argumentsDelta: args.slice(i, i + deltaSize) } });
    }
    return chunks;
  }

  describe("streamModelResponse — repetition stall false positives", () => {
    it("does not stall a write_file whose content legitimately repeats lines", async () => {
      const line = "server.listen(8080);\\n";
      const args = JSON.stringify({ path: "src/index.js", content: line.repeat(20) });
      const result = await run(argChunks("write_file", args));

      expect(result.repetitionStall).toBeUndefined();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.arguments).toBe(args);
    });

    it("does not stall edit_file arguments containing a repeated SEARCH block", async () => {
      const repeated = "  return sameValue;\n";
      const args = JSON.stringify({
        path: "src/mod.ts",
        search: repeated.repeat(10),
        replace: repeated.repeat(10),
      });
      const result = await run(argChunks("edit_file", args));

      expect(result.repetitionStall).toBeUndefined();
      expect(result.toolCalls[0]!.function.arguments).toBe(args);
    });

    it("still stalls a non-exempt tool whose arguments degenerate", async () => {
      const args = "a".repeat(400);
      const result = await run(argChunks("web_search", args));

      expect(result.repetitionStall).toMatchObject({ channel: "tool_call", period: 1 });
    });

    it("does not stall long-form reasoning after three exact deliberation cycles", async () => {
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
      const reasoning = `${healthy}\n\n${cycle}\n\n${cycle}\n\n${cycle}`;
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < reasoning.length; i += 17) {
        chunks.push({ reasoningDelta: reasoning.slice(i, i + 17) });
      }

      const result = await run(chunks);

      expect(result.repetitionStall).toBeUndefined();
      expect(result.reasoningContent).toBe(reasoning);
    });

    it("does not stall healthy reasoning that restates a hypothesis 3x", async () => {
      const healthy = Array.from(
        { length: 30 },
        (_, i) =>
          `Step ${i}: inspected the retry branch, confirmed the 5xx path retries once, and noted finding ${i * 7}.`,
      ).join("\n\n");
      const para =
        "Let me reconsider the providerErrorRetryable check. For a 500 error it should be true, unless the error is being thrown as a 4xx by the parse path. But opencode uses chat-completions, not responses, so that is unlikely.";
      const reasoning = `${healthy}\n\n${`${para}\n`.repeat(3)}`;
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < reasoning.length; i += 17) {
        chunks.push({ reasoningDelta: reasoning.slice(i, i + 17) });
      }

      const result = await run(chunks);

      expect(result.repetitionStall).toBeUndefined();
      expect(result.reasoningContent).toBe(reasoning);
    });

    it("does not stall reasoning that emits comment rules and a markdown table", async () => {
      // Regression: the whitespace-stripped stream turns a divider banner and a
      // separator row into long pipe/dash runs. While each is the stream tail it
      // used to look like degeneration and aborted the channel.
      const rule = "-".repeat(60);
      const banner = Array.from({ length: 6 }, () => rule).join("\n");
      const table = ["| Name | Value |", "|------|-------|", "| a | 1 |", "| b | 2 |"].join("\n");
      const reasoning = `Findings:\n\n${banner}\n\n${table}\n\nDone.`;
      const chunks: StreamChunk[] = [];
      for (let i = 0; i < reasoning.length; i += 17) {
        chunks.push({ reasoningDelta: reasoning.slice(i, i + 17) });
      }

      const result = await run(chunks);

      expect(result.repetitionStall).toBeUndefined();
      expect(result.reasoningContent).toBe(reasoning);
    });
  });

  describe("streamModelResponse — Gemini thought signature", () => {
    it("backfills a signature that arrives in a later frame onto an earlier call", async () => {
      const chunks: StreamChunk[] = [
        {
          toolCallDelta: {
            index: 0,
            id: "call_1",
            name: "todo_write",
            argumentsDelta: '{"text":"x"}',
          },
        },
        { thoughtSignature: "sig-late" },
      ];

      const result = await run(chunks);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.thoughtSignature).toBe("sig-late");
    });

    it("leaves a call's own signature untouched when one is already present", async () => {
      const chunks: StreamChunk[] = [
        {
          toolCallDelta: {
            index: 0,
            id: "call_1",
            name: "todo_write",
            argumentsDelta: '{"text":"x"}',
            thoughtSignature: "sig-own",
          },
        },
        { thoughtSignature: "sig-late" },
      ];

      const result = await run(chunks);

      expect(result.toolCalls[0]!.thoughtSignature).toBe("sig-own");
    });

    it("backfills a signature from a sibling tool call when one tool call lacks it", async () => {
      const chunks: StreamChunk[] = [
        {
          toolCallDelta: {
            index: 0,
            id: "call_1",
            name: "web_search",
            argumentsDelta: '{"query":"a"}',
            thoughtSignature: "sig-call-1",
          },
        },
        {
          toolCallDelta: {
            index: 1,
            id: "call_2",
            name: "read_file",
            argumentsDelta: '{"path":"b"}',
            // Lacks thoughtSignature
          },
        },
      ];

      const result = await run(chunks);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.thoughtSignature).toBe("sig-call-1");
      expect(result.toolCalls[1]!.thoughtSignature).toBe("sig-call-1");
    });
  });
});

describe("loop-streaming-status", () => {
  function fakeClient(chunks: StreamChunk[]): DeepSeekClient {
    return {
      stream: async function* () {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as DeepSeekClient;
  }

  async function events(chunks: StreamChunk[]): Promise<LoopEvent[]> {
    const gen = streamModelResponse({
      client: fakeClient(chunks),
      model: "test-model",
      messages: [],
      toolSpecs: [],
      signal: new AbortController().signal,
      reasoningEffort: "low" as ReasoningEffort,
      turn: 3,
    });
    const out: LoopEvent[] = [];
    let next = await gen.next();
    while (!next.done) {
      out.push(next.value);
      next = await gen.next();
    }
    return out;
  }

  describe("streamModelResponse — client waits", () => {
    it("forwards a rate-limit throttle as a tagged status before any content", async () => {
      const status: ClientStatus = { kind: "rate-limit", waitMs: 1_500 };
      const out = await events([
        { status, raw: null },
        { contentDelta: "hi", raw: null },
      ]);

      expect(out[0]).toMatchObject({
        role: "status",
        turn: 3,
        statusCode: "rate-limit",
        statusWaitMs: 1_500,
      });
      expect(out[0]?.content).toContain("rate limit");
      // The content that follows is untouched by the progress event.
      expect(out[1]).toMatchObject({ role: "assistant_delta", content: "hi" });
    });

    it("forwards a retry backoff with its attempt number and does not count it as output", async () => {
      const status: ClientStatus = { kind: "retry", waitMs: 3_400, attempt: 2, reason: "http 429" };
      const out = await events([{ status, raw: null }]);

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        role: "status",
        statusCode: "model-retry",
        statusAttempt: 2,
        statusWaitMs: 3_400,
      });
      expect(out[0]?.content).toContain("http 429");
      expect(out[0]?.content).toContain("attempt 2");
    });

    it("rounds a sub-second wait up so the row never promises 0s", async () => {
      const out = await events([{ status: { kind: "retry", waitMs: 40, attempt: 1 }, raw: null }]);

      expect(out[0]?.content).toContain("in 1s");
    });
  });
});

// // Non-Ollama truncation continuation: the Ollama-native behavior
// // (finish_reason cutoff → bounded resume) now covers every provider.
describe("loop-truncation-continuation", () => {
  describe("CacheFirstLoop truncation continuation (non-Ollama providers)", () => {
    it("continues a deepseek stream that truncates at the token cap", async () => {
      const responses: FakeResponseShape[] = [
        { content: "The fix is to updat", finish_reason: "length" },
        { content: "e the config and rerun." },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: true,
        model: "deepseek-v4-flash",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("continue your answer")) events.push(ev);

      expect(captured.length).toBe(2);
      expect(events.find((ev) => ev.role === "done")?.content).toBe("e the config and rerun.");
      expect(
        events
          .filter((ev) => ev.role === "warning")
          .some((ev) => ev.content?.includes("continuing generation")),
      ).toBe(true);
    });

    it("continues an OpenCode Responses-style 'incomplete' cutoff (non-stream)", async () => {
      const responses: FakeResponseShape[] = [
        { content: "partial ans", finish_reason: "incomplete" },
        { content: "wer completed" },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        model: "glm-5-free",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("go")) events.push(ev);

      expect(captured.length).toBe(2);
      expect(events.find((ev) => ev.role === "done")?.content).toBe("wer completed");
    });

    it("keeps continuing for as long as the model keeps truncating", async () => {
      const responses: FakeResponseShape[] = [
        ...Array.from({ length: 6 }, () => ({ content: "same partial", finish_reason: "length" })),
        { content: "and finished" },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        model: "deepseek-v4-flash",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("go")) events.push(ev);

      // Six cutoffs in a row, well past the three the old budget allowed: every
      // one resumes, and the turn ends on the model's own completion.
      expect(captured.length).toBe(7);
      expect(events.find((ev) => ev.role === "done")?.content).toBe("and finished");
      expect(
        events
          .filter((ev) => ev.role === "warning")
          .some((ev) => ev.content?.includes("continuations")),
      ).toBe(false);
    });
  });
});

// Premature-stop guard: the model must not end a task turn mid-thought.
// *  Covers the pure heuristic plus the loop-level bounded nudge.
describe("loop-premature-stop", () => {
  describe("looksLikePrematureStop", () => {
    it("flags the real-world mid-task narration stop", () => {
      expect(
        looksLikePrematureStop(
          "Now the remaining verification: a test that pins the new behavior. Existing test files give me the patterns:",
        ),
      ).toBe(true);
      expect(looksLikePrematureStop("Reading the config now")).toBe(false); // narration but no starter match? no — covered below
    });

    it("flags narration lines that carry no sentence end", () => {
      expect(looksLikePrematureStop("Now the remaining verification")).toBe(true);
      expect(looksLikePrematureStop("Let me check the failing test")).toBe(true);
    });

    it("flags dangling list bullets and unclosed code fences", () => {
      expect(looksLikePrematureStop("Plan:\n- item one\n- ")).toBe(true);
      expect(looksLikePrematureStop("Here is the fix:\n\n```ts\nconst x = 1;")).toBe(true);
    });

    it("accepts complete-looking messages", () => {
      expect(looksLikePrematureStop("All steps complete: tests pass.")).toBe(false);
      expect(looksLikePrematureStop("Next steps: run npm test")).toBe(false);
      expect(
        looksLikePrematureStop("Done. Everything works.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"),
      ).toBe(false);
      expect(
        looksLikePrematureStop("See the guide below:\n\n```ts\ncode();\n```\n\nThat's it."),
      ).toBe(false);
      expect(looksLikePrematureStop("")).toBe(false);
    });
  });

  describe("looksCutOffMidSentence", () => {
    it("flags the field report — a stream that died inside an opened clause", () => {
      expect(
        looksCutOffMidSentence(
          "I'll gather the last details I need (test file body, all consumers of",
        ),
      ).toBe(true);
    });

    it("flags an unclosed opener with no dangling word", () => {
      expect(looksCutOffMidSentence("Reading the call sites (src/loop.ts, src/client.ts")).toBe(
        true,
      );
      expect(looksCutOffMidSentence("The shape is")).toBe(true);
      expect(looksCutOffMidSentence("I need the exports, the types and all consumers of")).toBe(
        true,
      );
    });

    it("does not flag prose that closes its own structure", () => {
      expect(looksCutOffMidSentence("Done. All 14 tests pass.")).toBe(false);
      expect(looksCutOffMidSentence("Call `foo(1)` to run it.")).toBe(false);
      expect(looksCutOffMidSentence("See [the guide](docs/guide.md).")).toBe(false);
      expect(looksCutOffMidSentence("Fixed.\n\n```ts\nconst x = f(1);\n```")).toBe(false);
      expect(looksCutOffMidSentence("Full log: https://example.com/run/1234")).toBe(false);
      expect(looksCutOffMidSentence("Done.\n\n---")).toBe(false);
    });

    it("leaves one-word answers alone", () => {
      expect(looksCutOffMidSentence("a")).toBe(false);
      expect(looksCutOffMidSentence("ok")).toBe(false);
      expect(looksCutOffMidSentence("")).toBe(false);
    });
  });

  function probeRegistry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register({
      name: "probe",
      description: "no-op",
      parameters: { type: "object", properties: {} },
      fn: async () => "ok",
    });
    return reg;
  }

  describe("CacheFirstLoop premature-stop nudge", () => {
    it("re-prompts a mid-thought final after tool activity and completes the turn", async () => {
      const reg = probeRegistry();
      const responses: FakeResponseShape[] = [
        {
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "probe", arguments: "{}" } },
          ],
        },
        // The model's actual stop shape from the field: narrates the next step
        // and cuts off at the colon.
        {
          content:
            "Now the remaining verification: a test that pins the new behavior. Existing test files give me the patterns:",
        },
        { content: "Task complete: the test passes and the fix is verified." },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
        tools: reg,
        stream: false,
        model: "deepseek-v4-flash",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("fix the bug")) events.push(ev);

      expect(captured.length).toBe(3);
      // The nudge arrived as a user message between the partial and the retry.
      const nudgedMessages = captured[2]?.messages ?? [];
      const lastUser = [...nudgedMessages].reverse().find((m) => m.role === "user");
      expect(lastUser?.content).toContain("If the task is now complete");
      expect(lastUser?.content).toContain("continue working");
      expect(events.find((ev) => ev.role === "done")?.content).toBe(
        "Task complete: the test passes and the fix is verified.",
      );
      expect(
        events.some((ev) => ev.role === "warning" && ev.content?.includes("stopped mid-task")),
      ).toBe(true);
    });

    it("does not nudge plain Q&A answers that never used tools", async () => {
      const responses: FakeResponseShape[] = [{ content: "Now the remaining verification" }];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        model: "deepseek-v4-flash",
      });

      for await (const _ of loop.step("just answer this")) {
        /* drain */
      }
      expect(captured.length).toBe(1);
    });

    it("resumes a reply the provider cut off mid-sentence, before any tool ran", async () => {
      // The field report: a stream that died mid-phrase and was reported as a
      // finished turn ("Task complete") with the half-written message.
      const responses: FakeResponseShape[] = [
        { content: "I'll gather the last details I need (test file body, all consumers of" },
        {
          content:
            "I'll gather the last details I need (test file body, all consumers of the helper). Done: no test needs changing.",
        },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        model: "deepseek-v4-flash",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("check the helper")) events.push(ev);

      expect(captured.length).toBe(2);
      const retryMessages = captured[1]?.messages ?? [];
      const lastUser = [...retryMessages].reverse().find((m) => m.role === "user");
      expect(lastUser?.content).toContain("cut off mid-sentence");
      expect(events.find((ev) => ev.role === "done")?.content).toContain("no test needs changing");
      expect(
        events.some((ev) => ev.role === "warning" && ev.content?.includes("cut off mid-sentence")),
      ).toBe(true);
    });

    it("does not nudge a complete answer that closes its own punctuation", async () => {
      const responses: FakeResponseShape[] = [{ content: "Done. All 14 tests pass." }];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s" }),
        stream: false,
        model: "deepseek-v4-flash",
      });

      for await (const _ of loop.step("just answer this")) {
        /* drain */
      }
      expect(captured.length).toBe(1);
    });

    it("does not nudge complete-looking finals after tool activity", async () => {
      const reg = probeRegistry();
      const responses: FakeResponseShape[] = [
        {
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "probe", arguments: "{}" } },
          ],
        },
        { content: "Task complete: the test passes and the fix is verified." },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
        tools: reg,
        stream: false,
        model: "deepseek-v4-flash",
      });

      for await (const _ of loop.step("fix the bug")) {
        /* drain */
      }
      expect(captured.length).toBe(2);
    });

    it("keeps nudging for as long as the model ends mid-task, then finishes on its own answer", async () => {
      const reg = probeRegistry();
      const partial = "Now the remaining verification:";
      const responses: FakeResponseShape[] = [
        {
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "probe", arguments: "{}" } },
          ],
        },
        ...Array.from({ length: 4 }, () => ({ content: partial })),
        { content: "All checks passed; the task is complete." },
      ];
      const { client, captured } = makeFakeClient(responses, { echoMessages: true });
      const loop = new CacheFirstLoop({
        client,
        prefix: new ImmutablePrefix({ system: "s", toolSpecs: reg.specs() }),
        tools: reg,
        stream: false,
        model: "deepseek-v4-flash",
      });

      const events: LoopEvent[] = [];
      for await (const ev of loop.step("fix the bug")) events.push(ev);

      // Tool round, then four premature finals past the two nudges the old
      // budget allowed, then the model's own completion ends the turn.
      expect(captured.length).toBe(6);
      expect(events.find((ev) => ev.role === "done")?.content).toBe(
        "All checks passed; the task is complete.",
      );
      expect(
        events
          .filter((ev) => ev.role === "warning")
          .some((ev) => ev.content?.includes("continuation prompts")),
      ).toBe(false);
    });
  });
});
