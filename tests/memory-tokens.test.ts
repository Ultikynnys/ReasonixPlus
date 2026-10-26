// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionDirectoryIndex } from "../src/desktop/session-directory-index.js";
import {
  DUPLICATE_SESSION_INSTRUCTION,
  buildDuplicateContext,
  truncateMarkdownToTokens,
  truncateToolOutputsInMarkdown,
} from "../src/duplicate-session.js";
import {
  shrinkOversizedToolCallArgsByTokens,
  shrinkOversizedToolResultsByTokens,
} from "../src/loop.js";
import {
  COMPACTION_SUMMARY_PREFIX,
  DROPPED_WORK_NOTICE_PREFIX,
  buildCompactionRequest,
  buildDroppedWorkNotice,
  buildVerificationRequest,
  isCompactionSummary,
  isDroppedWorkNotice,
  planCompaction,
  renderDeterministic,
  renderTranscript,
  renderWithSummary,
  toolActivityDigest,
} from "../src/loop/compaction.js";
import {
  DEFAULT_MAX_RESULT_TOKENS,
  truncateForModel,
  truncateForModelByTokens,
} from "../src/mcp/registry.js";
import { AppendOnlyLog, ImmutablePrefix, VolatileScratch } from "../src/memory/runtime.js";
import {
  DEEPSEEK_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  resolveContextTokens,
} from "../src/telemetry/stats.js";
import {
  DEFAULT_BOUNDED_TOKENIZE_CHARS,
  IMAGE_DETAIL_LOW_TOKENS,
  countTokens,
  countTokensBounded,
  encode,
  estimateConversationTokens,
  estimateRequestTokens,
  formatDeepSeekPrompt,
} from "../src/tokenizer.js";
import type { ChatMessage, ToolCall } from "../src/types.js";

describe("tokenizer", () => {
  describe("DeepSeek V4 tokenizer — golden cases", () => {
    it("empty string is zero tokens", () => {
      expect(encode("")).toEqual([]);
      expect(countTokens("")).toBe(0);
    });

    it("ASCII words tokenize compactly", () => {
      expect(encode("Hello!")).toEqual([19923, 3]);
      expect(encode("Hello, world!")).toEqual([19923, 14, 2058, 3]);
    });

    it("common CJK collocation is a single token", () => {
      expect(encode("你好")).toEqual([30594]);
    });

    it("CJK sentence splits on punctuation", () => {
      expect(encode("你好，世界！")).toEqual([30594, 303, 3427, 1175]);
    });

    it("digit run is isolated by the \\p{N}{1,3} pre-tokenizer rule", () => {
      expect(encode("1 + 1 = 2")).toEqual([19, 940, 223, 19, 438, 223, 20]);
    });

    it("recognizes <think>/</think> as atomic added tokens", () => {
      const ids = encode("<think>reasoning here</think>");
      expect(ids[0]).toBe(128821);
      expect(ids[ids.length - 1]).toBe(128822);
      expect(ids.length).toBe(5);
    });

    it("mixed English+CJK follows the right pre-tokenizer branches", () => {
      const ids = encode("mixed 中文 and english 混合");
      expect(ids).toEqual([122545, 223, 21134, 305, 33010, 223, 14769]);
    });

    it("round-trips a code snippet at a reasonable compression ratio", () => {
      const src = "function add(a, b) { return a + b; }";
      const n = countTokens(src);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(16);
    });

    it("Chinese prose gets the expected ~0.6 tokens/char rate", () => {
      const text = "深度求索是一家专注于人工智能基础技术研究的公司";
      const n = countTokens(text);
      expect(n).toBeGreaterThanOrEqual(8);
      expect(n).toBeLessThanOrEqual(16);
    });
  });

  describe("formatDeepSeekPrompt", () => {
    it("renders system + user with BOS and generation suffix", () => {
      const out = formatDeepSeekPrompt([
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hi" },
      ]);
      expect(out).toBe("<｜begin▁of▁sentence｜>Be concise.<｜User｜>Hi<｜Assistant｜></think>");
    });

    it("renders multi-turn with role prefixes and EOS on assistant", () => {
      const out = formatDeepSeekPrompt([
        { role: "system", content: "Helpful." },
        { role: "user", content: "Q1" },
        { role: "assistant", content: "A1" },
        { role: "user", content: "Q2" },
      ]);
      expect(out).toBe(
        "<｜begin▁of▁sentence｜>Helpful.<｜User｜>Q1<｜Assistant｜></think>A1<｜end▁of▁sentence｜><｜User｜>Q2<｜Assistant｜></think>",
      );
    });

    it("renders DSML tool_calls when assistant has no content", () => {
      const out = formatDeepSeekPrompt([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
        },
      ]);
      expect(out).toContain("<｜DSML｜tool_calls>");
      expect(out).toContain('<｜DSML｜invoke name="read_file">');
      expect(out).toContain("a.ts");
      expect(out).toContain("<｜DSML｜parameter");
      expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
    });

    it("merges tool results into user messages with <tool_result> blocks", () => {
      const out = formatDeepSeekPrompt([
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", content: "file contents" },
        { role: "user", content: "thanks" },
      ]);
      expect(out).toContain("<tool_result>file contents</tool_result>");
      expect(out).toMatch(/<｜Assistant｜><\/think>$/);
    });

    it("handles missing role as user default", () => {
      const out = formatDeepSeekPrompt([{ content: "hello" }]);
      expect(out).toBe("<｜begin▁of▁sentence｜><｜User｜>hello<｜Assistant｜></think>");
    });

    it("empty messages array returns just the generation prompt", () => {
      expect(formatDeepSeekPrompt([])).toBe("<｜Assistant｜></think>");
    });

    it("wraps reasoning_content in <think>...</think> before content", () => {
      const out = formatDeepSeekPrompt([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "Hi there!",
          reasoning_content: "User greeted me, I should respond.",
        },
      ]);
      expect(out).toContain("<think>User greeted me, I should respond.</think>Hi there!");
    });

    it("renders reasoning_content without content", () => {
      const out = formatDeepSeekPrompt([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Thinking step only.",
        },
      ]);
      expect(out).toContain("<think>Thinking step only.</think>");
      expect(out).toMatch(/<｜end▁of▁sentence｜>$/);
    });

    it("renders reasoning_content alongside tool_calls", () => {
      const out = formatDeepSeekPrompt([
        { role: "user", content: "read file" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "I need to use read_file tool.",
          tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
        },
      ]);
      expect(out).toContain("<think>I need to use read_file tool.</think>");
      expect(out).toContain("<｜DSML｜tool_calls>");
    });

    it("handles drop_thinking by stripping early reasoning_content", () => {
      const out = formatDeepSeekPrompt(
        [
          { role: "user", content: "Q1" },
          {
            role: "assistant",
            content: "A1",
            reasoning_content: "Early reasoning - should be dropped.",
          },
          { role: "user", content: "Q2" },
          {
            role: "assistant",
            content: "A2",
            reasoning_content: "Late reasoning - should be kept.",
          },
        ],
        true,
      );
      expect(out).not.toContain("Early reasoning");
      expect(out).toContain("<think>Late reasoning");
    });

    it("default drop_thinking=false preserves all reasoning_content", () => {
      const out = formatDeepSeekPrompt([
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "A1",
          reasoning_content: "Early reasoning.",
        },
        { role: "user", content: "Q2" },
      ]);
      expect(out).toContain("Early reasoning");
    });
  });

  describe("estimateConversationTokens", () => {
    it("counts V4-templated tokens including framing overhead", () => {
      const n = estimateConversationTokens([
        { role: "user", content: "you are helpful" },
        { role: "user", content: "你好" },
        { role: "user", content: "Hello!" },
      ]);
      const rawContent =
        countTokens("you are helpful") + countTokens("你好") + countTokens("Hello!");
      expect(n).toBeGreaterThan(rawContent);
    });

    it("counts DSML tool_calls via template when present on assistant", () => {
      const withCalls = estimateConversationTokens([
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
        },
      ]);
      expect(withCalls).toBeGreaterThan(0);
    });

    it("counts framing tokens even for null/empty content messages", () => {
      const n = estimateConversationTokens([
        { role: "user", content: null },
        { role: "user", content: "" },
        { role: "user", content: undefined },
      ]);
      expect(n).toBeGreaterThan(0);
    });

    it("counts OpenAI image_url parts at the 85-token detail:low rate", () => {
      const textOnly = estimateConversationTokens([{ role: "user", content: "what is this?" }]);
      const withImage = estimateConversationTokens([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ]);
      expect(withImage - textOnly).toBe(IMAGE_DETAIL_LOW_TOKENS);
    });
  });

  describe("estimateRequestTokens", () => {
    it("includes TOOLS_TEMPLATE overhead when toolSpecs are provided", () => {
      const msgs = [{ role: "user", content: "hi" }];
      const withTools = estimateRequestTokens(msgs, [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ]);
      // The overhead should be significantly larger than the raw schema JSON count
      const rawSchema = countTokens(
        JSON.stringify({
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        }),
      );
      expect(withTools).toBeGreaterThan(estimateConversationTokens(msgs) + rawSchema);
    });

    it("returns conversation tokens when no tools", () => {
      const msgs = [{ role: "user", content: "hi" }];
      expect(estimateRequestTokens(msgs, null)).toBe(estimateConversationTokens(msgs));
    });

    it("returns conversation tokens when empty tools array", () => {
      const msgs = [{ role: "user", content: "hi" }];
      expect(estimateRequestTokens(msgs, [])).toBe(estimateConversationTokens(msgs));
    });

    it("counts tools with function extraction", () => {
      const msgs = [{ role: "user", content: "hi" }];
      const withFn = estimateRequestTokens(msgs, [
        { function: { name: "foo", parameters: { type: "object", properties: {} } } },
      ]);
      const bare = estimateConversationTokens(msgs);
      expect(withFn).toBeGreaterThan(bare);
    });

    it("drop_thinking=true reduces tokens when early reasoning exists", () => {
      const msgs = [
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "A1",
          reasoning_content: "Some lengthy early reasoning that should be dropped...",
        },
        { role: "user", content: "Q2" },
      ];
      const withDrop = estimateConversationTokens(msgs, true);
      const withoutDrop = estimateConversationTokens(msgs, false);
      expect(withDrop).toBeLessThan(withoutDrop);
    });
  });

  describe("countTokensBounded", () => {
    it("keeps the default sample cap conservative for pathological BPE input", () => {
      expect(DEFAULT_BOUNDED_TOKENIZE_CHARS).toBeLessThanOrEqual(2048);
    });

    it("returns the exact token count when input is within the char cap", () => {
      const text = "Hello world! 你好 deepseek.";
      expect(countTokensBounded(text, text.length)).toBe(countTokens(text));
    });

    it("estimates oversized input from a bounded head/tail sample", () => {
      const head = "Hello world! ".repeat(40);
      const middle = "A".repeat(100_000);
      const tail = "你好 deepseek ".repeat(40);
      const text = head + middle + tail;

      const estimate = countTokensBounded(text, 512);

      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(text.length);
      expect(estimate).toBeGreaterThan(Math.floor(text.length * 0.05));
    });

    it("bounds pathological repetitive input without multi-second BPE work", () => {
      const text = "A".repeat(100_000);
      const t0 = performance.now();
      const estimate = countTokensBounded(text);
      const t1 = performance.now();

      expect(estimate).toBeGreaterThan(0);
      expect(t1 - t0).toBeLessThan(1000);
    });
  });

  describe("countTokens ↔ encode equivalence", () => {
    const corpus: [string, string][] = [
      ["empty", ""],
      ["plain ASCII", "Hello, world!"],
      ["ASCII sentence", "The quick brown fox jumps over the lazy dog."],
      ["CJK characters", "你好世界"],
      ["CJK prose", "深度求索是一家专注于人工智能基础技术研究的公司"],
      ["mixed English+CJK", "mixed 中文 and english 混合"],
      ["emoji (surrogate pairs)", "🎉🚀💻🔥"],
      ["emoji in sentence", "Great job! 🎉 Let's go 🚀"],
      ["digits", "1 + 1 = 2, 1234567890"],
      ["special added tokens", "<think>reasoning here</think>"],
      ["multiple added tokens", "<｜begin▁of▁sentence｜>Hello<｜User｜>Hi<｜Assistant｜>"],
      ["code snippet", "function add(a, b) { return a + b; }"],
      ["JSON payload", '{"name":"test","values":[1,2,3],"nested":{"key":"value"}}'],
      ["repeated text", "Hello world! ".repeat(100)],
      ["whitespace heavy", "  \t\n  hello  \n\t  world  \t\n  "],
      ["long ASCII", "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(50)],
    ];

    for (const [label, text] of corpus) {
      it(`countTokens matches encode.length for: ${label}`, () => {
        expect(countTokens(text)).toBe(encode(text).length);
      });
    }

    it("countTokens matches encode.length for >10KB blob", () => {
      const big = "The quick brown fox jumps over the lazy dog. 你好世界 🎉 ".repeat(200);
      expect(big.length).toBeGreaterThan(10_000);
      expect(countTokens(big)).toBe(encode(big).length);
    });
  });

  describe("performance sanity", () => {
    it("tokenizes 10k chars of typical mixed content in under 200 ms", () => {
      const block = "Hello world! 你好 deepseek ".repeat(400);
      const t0 = performance.now();
      const n = countTokens(block);
      const t1 = performance.now();
      expect(n).toBeGreaterThan(1000);
      expect(t1 - t0).toBeLessThan(200);
    });
  });
});

describe("truncate-tokens", () => {
  function hasLoneSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) return true;
        i++;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) return true;
    }
    return false;
  }

  describe("truncateForModelByTokens", () => {
    it("returns the string unchanged when it fits the budget", () => {
      const s = "Hello, world! This is a short string.";
      expect(truncateForModelByTokens(s, 1000)).toBe(s);
    });

    it("returns the string unchanged when length <= budget (fast path)", () => {
      // Fast path: every token is ≥ 1 char, so length ≤ budget implies
      // tokens ≤ budget. No tokenize call should be needed.
      const s = "a".repeat(50);
      expect(truncateForModelByTokens(s, 100)).toBe(s);
    });

    it("truncates when tokens exceed the budget", () => {
      // 2000 "hello " tokens → well above 100-token budget
      const s = "hello ".repeat(2000);
      const out = truncateForModelByTokens(s, 100);
      expect(out).not.toBe(s);
      // Output includes the head, a truncation marker, and a short tail
      expect(out).toMatch(/…truncated ~?\d+ tokens \(\d+ chars\)/);
      // Final token count stays reasonably close to (at or below) budget
      // plus the marker's ~48-token overhead — we allow a small slack
      // because the slice refinement is char-based and can overshoot by
      // a few tokens before the retry loop settles.
      expect(countTokens(out)).toBeLessThanOrEqual(250);
    });

    it("caps CJK text at the same token footprint as English", () => {
      // 8000 chars of Chinese — roughly 5000-8000 tokens depending on
      // which chars; old char-based cap at 32000 would let this through
      // at 2× the token cost. Token cap pulls it down.
      const s = "你好世界".repeat(2000); // 8000 chars
      const out = truncateForModelByTokens(s, 500);
      expect(countTokens(out)).toBeLessThanOrEqual(700);
      expect(out).toMatch(/…truncated/);
    });

    it("preserves both the head and the tail of the content", () => {
      const head = "START-OF-RESULT\n";
      const middle = "filler line\n".repeat(5000);
      const tail = "\nEND-OF-RESULT";
      const s = head + middle + tail;
      const out = truncateForModelByTokens(s, 500);
      // Head leading sentinel is preserved at the start
      expect(out.startsWith("START-OF-RESULT")).toBe(true);
      // Tail trailing sentinel survives via the short tail window
      expect(out.endsWith("END-OF-RESULT")).toBe(true);
      expect(out).toMatch(/…truncated/);
    });

    it("returns the empty string when budget is zero or negative", () => {
      expect(truncateForModelByTokens("anything", 0)).toBe("");
      expect(truncateForModelByTokens("anything", -5)).toBe("");
    });

    it("handles the empty string", () => {
      expect(truncateForModelByTokens("", 100)).toBe("");
      expect(truncateForModelByTokens("", 0)).toBe("");
    });

    it("default token budget is 8000", () => {
      expect(DEFAULT_MAX_RESULT_TOKENS).toBe(8_000);
    });

    it("truncated marker reports a positive dropped-tokens count", () => {
      const s = "A".repeat(40_000);
      const out = truncateForModelByTokens(s, 200);
      const match = /truncated ~?(\d+) tokens \((\d+) chars\)/.exec(out);
      expect(match).not.toBeNull();
      const droppedTokens = Number(match![1]);
      const droppedChars = Number(match![2]);
      expect(droppedTokens).toBeGreaterThan(0);
      expect(droppedChars).toBeGreaterThan(0);
    });

    it("never leaves a lone UTF-16 surrogate at a slice boundary (issue #1970)", () => {
      // Emoji are UTF-16 surrogate pairs. Pack a content so the natural
      // token-budget slice lands inside one — without alignment, the head
      // would end with a lone high surrogate and DeepSeek's serde_json
      // would reject the request with "unexpected end of hex escape".
      const emoji = "🚀";
      const filler = "x".repeat(50);
      const segment = `${emoji}${filler}`;
      const s = segment.repeat(2000);
      const out = truncateForModelByTokens(s, 400);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(JSON.stringify(out)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}/);
    });
  });

  describe("truncateForModel (char-based)", () => {
    it("never leaves a lone UTF-16 surrogate at a slice boundary (issue #1970)", () => {
      const emoji = "🎯";
      const filler = "y".repeat(50);
      const s = `${emoji}${filler}`.repeat(2000);
      const out = truncateForModel(s, 1000);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(JSON.stringify(out)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}/);
    });
  });
});

describe("compact-tokens", () => {
  describe("shrinkOversizedToolResultsByTokens", () => {
    it("leaves small tool messages alone", () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hi" },
        { role: "tool", tool_call_id: "t1", content: "short" },
      ];
      const r = shrinkOversizedToolResultsByTokens(msgs, 1000);
      expect(r.healedCount).toBe(0);
      expect(r.tokensSaved).toBe(0);
      expect(r.messages).toEqual(msgs);
    });

    it("shrinks tool messages that exceed the token budget", () => {
      const huge = "some event detail line with words\n".repeat(1000);
      const msgs: ChatMessage[] = [
        { role: "user", content: "do stuff" },
        { role: "tool", tool_call_id: "t1", content: huge },
      ];
      const r = shrinkOversizedToolResultsByTokens(msgs, 500);
      expect(r.healedCount).toBe(1);
      expect(r.tokensSaved).toBeGreaterThan(0);
      expect(r.charsSaved).toBeGreaterThan(0);
      const toolMsg = r.messages.find((m) => m.role === "tool");
      const shrunk = typeof toolMsg?.content === "string" ? toolMsg.content : "";
      // Final token count stays reasonably near the cap (plus marker
      // overhead from truncateForModelByTokens).
      expect(countTokens(shrunk)).toBeLessThanOrEqual(600);
    });

    it("never mutates the input array", () => {
      const big = "line of text with content\n".repeat(800);
      const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content: big }];
      const original = msgs[0]!.content;
      shrinkOversizedToolResultsByTokens(msgs, 200);
      expect(msgs[0]!.content).toBe(original);
    });

    it("does not touch user or assistant messages even when long", () => {
      const bigUser = "user-intent prose ".repeat(2000);
      const msgs: ChatMessage[] = [
        { role: "user", content: bigUser },
        { role: "assistant", content: "ok" },
      ];
      const r = shrinkOversizedToolResultsByTokens(msgs, 100);
      expect(r.healedCount).toBe(0);
      expect(r.messages[0]!.content).toBe(bigUser);
    });

    it("caps CJK tool results at the same token budget as English", () => {
      // Under the old char cap, CJK text slipped through at ~2× the
      // intended token cost. With a token cap, both must converge.
      const cjk = "错误：步骤执行失败需要复查\n".repeat(1000);
      const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content: cjk }];
      const r = shrinkOversizedToolResultsByTokens(msgs, 500);
      expect(r.healedCount).toBe(1);
      const shrunk = typeof r.messages[0]!.content === "string" ? r.messages[0]!.content : "";
      expect(countTokens(shrunk)).toBeLessThanOrEqual(600);
    });

    it("fast-pathes tool messages whose content length is already below the budget", () => {
      // Every token is ≥1 char, so length <= maxTokens implies tokens
      // <= maxTokens — no tokenize call needed, message untouched.
      const content = "x".repeat(50);
      const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content }];
      const r = shrinkOversizedToolResultsByTokens(msgs, 100);
      expect(r.healedCount).toBe(0);
      expect(r.messages[0]!.content).toBe(content);
    });
  });

  describe("shrinkOversizedToolCallArgsByTokens", () => {
    it("leaves small tool-call args alone", () => {
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/foo.ts"}' },
            },
          ],
        },
      ];
      const r = shrinkOversizedToolCallArgsByTokens(msgs, 1000);
      expect(r.healedCount).toBe(0);
      expect(r.messages).toEqual(msgs);
    });

    it("shrinks long edit_file search/replace payloads into markers", () => {
      const longSearch = "old code line\n".repeat(200);
      const longReplace = "new code line\n".repeat(300);
      const argsJson = JSON.stringify({
        path: "src/foo.ts",
        search: longSearch,
        replace: longReplace,
      });
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "edit_file", arguments: argsJson } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "applied" },
      ];
      const r = shrinkOversizedToolCallArgsByTokens(msgs, 500);
      expect(r.healedCount).toBe(1);
      expect(r.tokensSaved).toBeGreaterThan(0);
      expect(r.charsSaved).toBeGreaterThan(0);
      const a = r.messages[0];
      if (a?.role !== "assistant" || !a.tool_calls) throw new Error("assistant missing");
      const shrunkArgs = a.tool_calls[0]!.function.arguments;
      const parsed = JSON.parse(shrunkArgs) as { path: string; search: string; replace: string };
      expect(parsed.path).toBe("src/foo.ts");
      expect(parsed.search).toMatch(/shrunk/);
      expect(parsed.replace).toMatch(/shrunk/);
    });

    it("leaves tool results intact (only targets assistant.tool_calls args)", () => {
      const hugeResult = "log line ".repeat(2000);
      const msgs: ChatMessage[] = [{ role: "tool", tool_call_id: "c1", content: hugeResult }];
      const r = shrinkOversizedToolCallArgsByTokens(msgs, 100);
      expect(r.healedCount).toBe(0);
      expect(r.messages[0]!.content).toBe(hugeResult);
    });

    it("preserves short string fields next to long ones", () => {
      const longBody = "x".repeat(4000);
      const argsJson = JSON.stringify({
        path: "src/foo.ts",
        content: longBody,
        mode: "append",
      });
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "write_file", arguments: argsJson } },
          ],
        },
      ];
      const r = shrinkOversizedToolCallArgsByTokens(msgs, 500);
      expect(r.healedCount).toBe(1);
      const a = r.messages[0];
      if (a?.role !== "assistant" || !a.tool_calls) throw new Error("assistant missing");
      const parsed = JSON.parse(a.tool_calls[0]!.function.arguments) as Record<string, unknown>;
      expect(parsed.path).toBe("src/foo.ts");
      expect(parsed.mode).toBe("append");
      expect(String(parsed.content)).toMatch(/shrunk/);
    });

    it("never mutates the input array or its tool_calls", () => {
      const bigArgs = JSON.stringify({ path: "a", search: "x".repeat(4000) });
      const msgs: ChatMessage[] = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "edit_file", arguments: bigArgs } },
          ],
        },
      ];
      const originalArgs = (msgs[0] as any).tool_calls[0].function.arguments;
      shrinkOversizedToolCallArgsByTokens(msgs, 100);
      expect((msgs[0] as any).tool_calls[0].function.arguments).toBe(originalArgs);
    });
  });
});

describe("context-tokens", () => {
  describe("resolveContextTokens", () => {
    it("uses the per-model table when no override is set", () => {
      expect(resolveContextTokens("deepseek-v4-flash")).toBe(
        DEEPSEEK_CONTEXT_TOKENS["deepseek-v4-flash"],
      );
      expect(resolveContextTokens("gpt-6.1-terra")).toBe(1_000_000);
      expect(resolveContextTokens("gpt-6-astra")).toBe(1_000_000);
      expect(resolveContextTokens("gpt-6-sol")).toBe(1_000_000);
      expect(resolveContextTokens("gpt-6-luna")).toBe(1_000_000);
      expect(resolveContextTokens("gpt-5.6-sol")).toBe(300_000);
      expect(resolveContextTokens("gemini-3.8-flash-tiered")).toBe(1_000_000);
      expect(resolveContextTokens("gemini-3.7-flash")).toBe(1_000_000);
    });

    it("falls back to DEFAULT_CONTEXT_TOKENS for unknown models", () => {
      expect(resolveContextTokens("some-future-model")).toBe(DEFAULT_CONTEXT_TOKENS);
    });

    it("honors an override above the model's default window, up to the API ceiling", () => {
      // An explicit override is the source of truth; the table only supplies
      // the default when no override is set.
      expect(resolveContextTokens("deepseek-v4-flash", 750_000)).toBe(750_000);
      expect(resolveContextTokens("deepseek-v4-flash", 1_000_000)).toBe(1_000_000);
      expect(resolveContextTokens("gpt-5.6-sol", 900_000)).toBe(900_000);
    });

    it("an override below the max stays in effect (floored to the config range)", () => {
      expect(resolveContextTokens("deepseek-v4-flash", 300_000)).toBe(300_000);
      expect(resolveContextTokens("deepseek-v4-flash", 250_000)).toBe(250_000);
      expect(resolveContextTokens("deepseek-v4-flash", 100_000)).toBe(MIN_CONTEXT_TOKENS);
    });

    it("an override also applies to unknown models up to the API ceiling (the table is only the no-override fallback)", () => {
      expect(resolveContextTokens("some-future-model", 900_000)).toBe(900_000);
    });

    it("clamps to the config range floor and the API ceiling", () => {
      expect(resolveContextTokens("deepseek-v4-flash", 100)).toBe(MIN_CONTEXT_TOKENS);
      expect(resolveContextTokens("some-future-model", 2_000_000)).toBe(MAX_CONTEXT_TOKENS);
    });

    it("floors fractional overrides and ignores non-finite ones", () => {
      expect(resolveContextTokens("deepseek-v4-flash", 350_000.9)).toBe(350_000);
      expect(resolveContextTokens("some-future-model", 350_000.9)).toBe(350_000);
      expect(resolveContextTokens("deepseek-v4-flash", Number.NaN)).toBe(1_000_000);
      expect(resolveContextTokens("deepseek-v4-flash", Number.POSITIVE_INFINITY)).toBe(1_000_000);
    });
  });
});

describe("memory", () => {
  describe("ImmutablePrefix", () => {
    it("fingerprint is stable for identical inputs", () => {
      const a = new ImmutablePrefix({ system: "hello" });
      const b = new ImmutablePrefix({ system: "hello" });
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("fingerprint changes with inputs", () => {
      const a = new ImmutablePrefix({ system: "hello" });
      const b = new ImmutablePrefix({ system: "world" });
      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("toMessages includes system plus few-shots", () => {
      const p = new ImmutablePrefix({
        system: "sys",
        fewShots: [{ role: "user", content: "hi" }],
      });
      expect(p.toMessages()).toEqual([
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ]);
    });

    it("fingerprint is cached across reads — same string identity", () => {
      const p = new ImmutablePrefix({ system: "x" });
      const first = p.fingerprint;
      const second = p.fingerprint;
      expect(first).toBe(second);
      // Cache hit returns the same primitive — strict equality is the
      // observable proof. (Strings are interned by content, but the
      // same getter call path re-reading should be a no-op recompute.)
      expect(first === second).toBe(true);
    });

    it("addTool invalidates the fingerprint cache", () => {
      const p = new ImmutablePrefix({ system: "x" });
      const before = p.fingerprint;
      const added = p.addTool({
        type: "function",
        function: { name: "echo", description: "", parameters: { type: "object" } },
      });
      expect(added).toBe(true);
      const after = p.fingerprint;
      expect(after).not.toBe(before);
    });

    it("addTool de-dupes by name and does NOT churn the fingerprint", () => {
      const p = new ImmutablePrefix({
        system: "x",
        toolSpecs: [
          {
            type: "function",
            function: { name: "echo", description: "", parameters: { type: "object" } },
          },
        ],
      });
      const before = p.fingerprint;
      const added = p.addTool({
        type: "function",
        function: { name: "echo", description: "different", parameters: { type: "object" } },
      });
      expect(added).toBe(false);
      expect(p.fingerprint).toBe(before);
    });

    it("verifyFingerprint passes when cache is consistent", () => {
      const p = new ImmutablePrefix({ system: "x" });
      p.fingerprint; // prime the cache
      expect(() => p.verifyFingerprint()).not.toThrow();
    });

    it("verifyFingerprint catches drift from out-of-band mutation", () => {
      const p = new ImmutablePrefix({ system: "x" });
      p.fingerprint; // prime the cache
      // Simulate a future bug: a new mutation path mutates the
      // backing array directly without going through addTool. The
      // cached fingerprint is now stale; verify should throw.
      (p as unknown as { _toolSpecs: unknown[] })._toolSpecs.push({
        type: "function",
        function: { name: "rogue", description: "", parameters: { type: "object" } },
      });
      expect(() => p.verifyFingerprint()).toThrow(/fingerprint drift/);
    });
  });

  describe("AppendOnlyLog", () => {
    it("appends in order and rejects malformed entries", () => {
      const log = new AppendOnlyLog();
      log.append({ role: "user", content: "hi" });
      log.append({ role: "assistant", content: "hello" });
      expect(log.length).toBe(2);
      expect(() => log.append({ content: "x" } as any)).toThrow();
    });

    it("toMessages returns a shallow-copy not affecting internal state", () => {
      const log = new AppendOnlyLog();
      log.append({ role: "user", content: "hi" });
      const msgs = log.toMessages();
      msgs[0]!.content = "tampered";
      expect(log.entries[0]!.content).toBe("hi");
    });
  });

  describe("VolatileScratch", () => {
    it("resets all fields", () => {
      const s = new VolatileScratch();
      s.reasoning = "x";
      s.planState = { a: 1 };
      s.notes.push("note");
      s.reset();
      expect(s.reasoning).toBeNull();
      expect(s.planState).toBeNull();
      expect(s.notes).toEqual([]);
    });
  });
});

describe("compaction", () => {
  function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  function user(content: string): ChatMessage {
    return { role: "user", content };
  }

  function assistant(content: string, toolCalls?: ToolCall[]): ChatMessage {
    return toolCalls
      ? { role: "assistant", content, tool_calls: toolCalls }
      : { role: "assistant", content };
  }

  function tool(id: string, content: string): ChatMessage {
    return { role: "tool", tool_call_id: id, content };
  }

  function bigRoundTrip(prefix: string, size = 400): ChatMessage[] {
    return [
      user(`${prefix}: please refactor the widget module`),
      assistant("", [call(`${prefix}-r1`, "read_file", { path: `src/${prefix}/widget.ts` })]),
      tool(
        `${prefix}-r1`,
        `export function widget() {\n${"  // filler line with words\n".repeat(size)}}`,
      ),
      assistant("", [call(`${prefix}-e1`, "edit_file", { path: `src/${prefix}/widget.ts` })]),
      tool(`${prefix}-e1`, "edit applied\n".repeat(20)),
      assistant("", [
        call(`${prefix}-c1`, "run_command", { command: `npm test -- --dir ${prefix}` }),
      ]),
      tool(`${prefix}-c1`, "tests passed\n".repeat(20)),
      assistant(`Done: widget module refactored for ${prefix}.`),
    ];
  }

  describe("planCompaction", () => {
    it("keeps user prompts and the recent tail, folds older work", () => {
      const messages: ChatMessage[] = [
        ...bigRoundTrip("a"),
        ...bigRoundTrip("b"),
        ...bigRoundTrip("c"),
        user("now update the docs"),
        assistant("Updating the docs now."),
      ];
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 600 });
      expect(plan).not.toBeNull();
      const kept = plan!.keptIndices.map((i) => messages[i]!);
      // Every real user prompt survives somewhere.
      for (const prompt of ["a: please refactor the widget module", "now update the docs"]) {
        expect(kept.some((m) => m.role === "user" && String(m.content).includes(prompt))).toBe(
          true,
        );
      }
      expect(plan!.foldedIndices.length).toBeGreaterThan(0);
      const rendered = renderDeterministic(plan!);
      expect(rendered).not.toBeNull();
      expect(rendered!.tokensAfter).toBeLessThan(rendered!.tokensBefore);
    });

    it("never returns a non-shrinking result", () => {
      const messages = [user("tiny"), assistant("ok")];
      expect(planCompaction(messages, { targetTokens: 50 })).toBeNull();
    });

    it("returns null when there is nothing foldable", () => {
      const messages = [user("hello"), assistant("hi there")];
      const plan = planCompaction(messages, {
        targetTokens: 10,
        preserveRecentTokens: 0,
        userRetentionTokens: 0,
      });
      // Prompts are mandatory keeps; without foldable work there is no plan.
      expect(plan).toBeNull();
    });

    it("preserves tool-call/result pairing across the fold boundary", () => {
      const messages: ChatMessage[] = [
        ...bigRoundTrip("a"),
        ...bigRoundTrip("b"),
        assistant("", [call("tail-1", "read_file", { path: "src/tail.ts" })]),
        tool("tail-1", "tail file contents"),
        assistant("Read the tail file."),
      ];
      const plan = planCompaction(messages, { targetTokens: 2_000, preserveRecentTokens: 300 });
      expect(plan).not.toBeNull();
      const keptSet = new Set(plan!.keptIndices);
      for (const i of plan!.keptIndices) {
        const m = messages[i]!;
        if (m.role === "tool") {
          const owner = messages.findIndex(
            (x) =>
              x.role === "assistant" && (x.tool_calls ?? []).some((c) => c.id === m.tool_call_id),
          );
          expect(keptSet.has(owner)).toBe(true);
        }
        if (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0) {
          for (const c of m.tool_calls ?? []) {
            const resultIdx = messages.findIndex(
              (x) => x.role === "tool" && x.tool_call_id === c.id,
            );
            if (resultIdx >= 0) expect(keptSet.has(resultIdx)).toBe(true);
          }
        }
      }
    });

    it("rolls the newest prior summary forward and drops older ones", () => {
      const oldSummary = `${COMPACTION_SUMMARY_PREFIX}\nstale summary`;
      const newSummary = `${COMPACTION_SUMMARY_PREFIX}\nfresh summary`;
      const messages: ChatMessage[] = [
        { role: "user", synthetic: true, content: oldSummary },
        ...bigRoundTrip("a"),
        { role: "user", synthetic: true, content: newSummary },
        ...bigRoundTrip("b"),
        user("continue"),
        assistant("working"),
      ];
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 400 });
      expect(plan).not.toBeNull();
      expect(plan!.priorSummary).toBe("fresh summary");
      const rendered = renderDeterministic(plan!);
      const summaries = rendered!.messages.filter((m) => isCompactionSummary(m));
      expect(summaries).toHaveLength(1);
      expect(String(summaries[0]!.content)).toContain("fresh summary");
      expect(String(summaries[0]!.content)).not.toContain("stale summary");
      // The summary sits up front so it reads as preamble, not as the latest ask.
      expect(isCompactionSummary(rendered!.messages[0]!)).toBe(true);
    });

    it("classifies summary and notice messages", () => {
      expect(
        isCompactionSummary({
          role: "user",
          synthetic: true,
          content: `${COMPACTION_SUMMARY_PREFIX}\nx`,
        }),
      ).toBe(true);
      expect(
        isDroppedWorkNotice({
          role: "user",
          synthetic: true,
          content: `${DROPPED_WORK_NOTICE_PREFIX}\ny`,
        }),
      ).toBe(true);
      expect(isCompactionSummary(user("plain"))).toBe(false);
    });
  });

  describe("dropped-work digest", () => {
    it("extracts files read, files edited and commands", () => {
      const span: ChatMessage[] = [
        user("refactor it"),
        assistant("", [call("1", "read_file", { path: "src/a.ts" })]),
        tool("1", "contents"),
        assistant("", [call("2", "edit_file", { path: "src/a.ts" })]),
        tool("2", "ok"),
        assistant("", [call("3", "run_command", { command: "npm test" })]),
        tool("3", "pass"),
        assistant("All done."),
      ];
      const digest = toolActivityDigest(span);
      expect(digest.filesRead.join(" ")).toContain("src/a.ts");
      expect(digest.filesEdited.join(" ")).toContain("src/a.ts");
      expect(digest.commands.join(" ")).toContain("npm test");
      expect(digest.lastReply).toContain("All done.");
      expect(digest.foldedPrompts.join(" ")).toContain("refactor it");
      const notice = buildDroppedWorkNotice(digest);
      expect(notice.startsWith(DROPPED_WORK_NOTICE_PREFIX)).toBe(true);
      expect(notice).toContain("Commands ran:");
      expect(notice).not.toMatch(/[\u2013\u2014]/);
    });
  });

  describe("summarizer requests", () => {
    const messages: ChatMessage[] = [
      ...bigRoundTrip("a"),
      ...bigRoundTrip("b"),
      user("continue with tests"),
      assistant("on it"),
    ];

    it("builds a compaction request over the folded span", () => {
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 500 });
      const req = buildCompactionRequest(plan!);
      expect(req).toHaveLength(1);
      expect(req[0]!.role).toBe("user");
      const text = String(req[0]!.content);
      expect(text).toContain("Conversation to summarize:");
      expect(text).toContain("read_file");
      expect(text).toMatch(/Generate a new state summary/);
    });

    it("anchors against a previous summary when one exists", () => {
      const withSummary = [
        {
          role: "user",
          synthetic: true,
          content: `${COMPACTION_SUMMARY_PREFIX}\nknown facts`,
        } as ChatMessage,
        ...messages,
      ];
      const plan = planCompaction(withSummary, { targetTokens: 1_500, preserveRecentTokens: 500 });
      const req = buildCompactionRequest(plan!);
      const text = String(req[0]!.content);
      expect(text).toContain("previous compaction summary");
      expect(text).toContain("known facts");
    });

    it("caps the summarizer input and notes omissions", () => {
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 500 });
      const req = buildCompactionRequest(plan!, 100);
      const text = String(req[0]!.content);
      expect(text).toContain("older messages omitted");
    });

    it("builds a verification request carrying the candidate summary", () => {
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 500 });
      const req = buildVerificationRequest(plan!, "candidate summary text");
      expect(String(req[0]!.content)).toContain("candidate summary text");
      expect(String(req[0]!.content)).toContain("FINAL improved summary");
    });

    it("renders a role-tagged transcript", () => {
      const text = renderTranscript([
        user("do it"),
        assistant("", [call("1", "run_command", { command: "ls" })]),
        tool("1", "file.txt"),
      ]);
      expect(text).toContain("User: do it");
      expect(text).toContain("Assistant requested tool call run_command");
      expect(text).toContain("Tool result (run_command): file.txt");
    });
  });

  describe("renderWithSummary", () => {
    it("places the rolling summary first and folds everything behind it", () => {
      const messages: ChatMessage[] = [
        ...bigRoundTrip("a"),
        ...bigRoundTrip("b"),
        user("final ask"),
        assistant("final answer"),
      ];
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 500 });
      const result = renderWithSummary(plan!, "The goal was refactoring widgets.");
      expect(result).not.toBeNull();
      const first = result!.messages[0]!;
      expect(isCompactionSummary(first)).toBe(true);
      expect(String(first.content)).toContain("The goal was refactoring widgets.");
      expect(result!.messages.some((m) => isDroppedWorkNotice(m))).toBe(false);
      expect(result!.tokensAfter).toBeLessThan(result!.tokensBefore);
      expect(estimateConversationTokens(result!.messages)).toBeLessThan(
        estimateConversationTokens(messages),
      );
    });

    it("refuses an empty summary and a summary that would not shrink", () => {
      const messages: ChatMessage[] = [...bigRoundTrip("a"), user("go"), assistant("ok")];
      const plan = planCompaction(messages, { targetTokens: 1_500, preserveRecentTokens: 500 });
      expect(renderWithSummary(plan!, "   ")).toBeNull();
      const bloated = "long summary ".repeat(50_000);
      expect(renderWithSummary(plan!, bloated)).toBeNull();
    });
  });
});

describe("duplicate-session", () => {
  const SEP = "\n\n---\n\n";

  describe("truncateMarkdownToTokens", () => {
    it("returns the transcript unchanged when it fits the budget", () => {
      const md = `### You${SEP}hello${SEP}### Reasonix+${SEP}hi`;
      const r = truncateMarkdownToTokens(md, 100_000);
      expect(r.text).toBe(md);
      expect(r.truncated).toBe(false);
      expect(r.droppedTokens).toBe(0);
    });

    it("empties the blob at a zero/negative budget", () => {
      const r = truncateMarkdownToTokens("### You\n\nhello", 0);
      expect(r.text).toBe("");
      expect(r.truncated).toBe(true);
      expect(r.droppedTokens).toBeGreaterThan(0);
    });

    it("handles empty input", () => {
      expect(truncateMarkdownToTokens("", 100)).toEqual({
        text: "",
        droppedTokens: 0,
        truncated: false,
      });
    });

    it("keeps the newest blocks and drops the oldest when over budget", () => {
      const oldest = `HEAD-ONLY-MARKER ${"word ".repeat(2000)}`;
      const newest = `### Reasonix+${SEP}the newest message stays`;
      const md = `### You${SEP}${oldest}${SEP}${newest}`;
      const budget = 60; // the newest block fits; the huge oldest block does not
      const r = truncateMarkdownToTokens(md, budget);
      expect(r.truncated).toBe(true);
      expect(r.text).toContain("the newest message stays");
      expect(r.text).not.toContain("HEAD-ONLY-MARKER");
      expect(countTokens(r.text)).toBeLessThanOrEqual(budget + 5);
    });

    it("tail-truncates the oldest retained block to fill the remaining budget", () => {
      const oldest = `HEAD-ONLY-MARKER ${"filler ".repeat(5000)}`;
      const newest = `### Reasonix+${SEP}${"tail ".repeat(50)}NEWEST-TAIL-SENTINEL`;
      const md = `${oldest}${SEP}${newest}`;
      const r = truncateMarkdownToTokens(md, 200);
      expect(r.text).toContain("NEWEST-TAIL-SENTINEL");
      // The oldest block's head is dropped; only its tail survives.
      expect(r.text).not.toContain("HEAD-ONLY-MARKER");
      expect(countTokens(r.text)).toBeLessThanOrEqual(210);
    });

    it("keeps every turn's thinking and user input when the transcript is over budget", () => {
      const turns: string[] = [];
      for (let i = 0; i < 40; i++) {
        // Segments within a message join with \n\n; messages join with SEP.
        turns.push(`### You\n\nuser-input-${i}`);
        const thinking = `<details>\n<summary>Reasoning</summary>\n\nTHINKING-${i} ${"reason ".repeat(20)}\n\n</details>`;
        const tool = `> **Tool · \`run_command\`**\n\n\`\`\`json\n{"cmd":${i}}\n\`\`\`\n\n\`\`\`\n${"out\n".repeat(30)}\`\`\``;
        turns.push(`### Reasonix+\n\n${thinking}\n\n${tool}\n\nprose ${i} ${"word ".repeat(40)}`);
      }
      const r = truncateMarkdownToTokens(turns.join(SEP), 4000);
      expect(r.truncated).toBe(true);
      // Thinking and user inputs from the OLDEST and the NEWEST turns both survive:
      // they are reserved before droppable tool output instead of being front-dropped
      // with their block (the old behavior kept only the newest third).
      expect(r.text).toContain("THINKING-0 ");
      expect(r.text).toContain("THINKING-39 ");
      expect(r.text).toContain("user-input-0");
      expect(r.text).toContain("user-input-39");
      // Bloated command output is still compressed to 3 lines.
      expect(r.text).not.toContain("out\nout\nout\nout");
    });
  });

  describe("buildDuplicateContext", () => {
    it("appends the continuation instruction and a truncation header", () => {
      const md = `### You${SEP}${"x ".repeat(4000)}${SEP}### Reasonix+${SEP}latest`;
      const out = buildDuplicateContext(md, 60);
      expect(out).toContain(DUPLICATE_SESSION_INSTRUCTION);
      expect(out).toContain("Truncated continuation context");
      expect(out).toContain("latest");
    });

    it("omits the truncation header when nothing was dropped", () => {
      const out = buildDuplicateContext("### You\n\nsmall session", 100_000);
      expect(out).not.toContain("Truncated continuation context");
      expect(out).toContain(DUPLICATE_SESSION_INSTRUCTION);
    });

    it("truncates bloated command outputs to 3 lines max per card output while keeping thinking intact", () => {
      const bloatedTool = [
        "> **Tool · `run_command`**",
        "",
        "```json",
        '{"command": "git log"}',
        "```",
        "",
        "```",
        "commit 1",
        "commit 2",
        "commit 3",
        "commit 4",
        "commit 5",
        "commit 6",
        "```",
      ].join("\n");

      const thinking = [
        "<details>",
        "<summary>Thought process</summary>",
        "",
        "Line 1 of reasoning",
        "Line 2 of reasoning",
        "Line 3 of reasoning",
        "Line 4 of reasoning",
        "Line 5 of reasoning",
        "",
        "</details>",
      ].join("\n");

      const md = `### You\n\nRun git log please\n\n---\n\n### Reasonix+\n\n${thinking}\n\n${bloatedTool}\n\nDone!`;
      const out = buildDuplicateContext(md, 50_000);

      // Command output is capped at 3 lines
      expect(out).toContain("commit 1\ncommit 2\ncommit 3\n```");
      expect(out).not.toContain("commit 4");
      expect(out).not.toContain("commit 5");

      // All thinking and user input are completely preserved
      expect(out).toContain("Run git log please");
      expect(out).toContain("Line 1 of reasoning");
      expect(out).toContain("Line 2 of reasoning");
      expect(out).toContain("Line 3 of reasoning");
      expect(out).toContain("Line 4 of reasoning");
      expect(out).toContain("Line 5 of reasoning");
    });

    it("leaves tool outputs with 3 or fewer lines unchanged", () => {
      const shortTool = ["> **Tool · `run_command`**", "", "```", "line A", "line B", "```"].join(
        "\n",
      );

      const out = truncateToolOutputsInMarkdown(shortTool, 3);
      expect(out).toContain("line A\nline B");
    });

    it("does not truncate code blocks outside of tool blocks", () => {
      const codeBlock = [
        "Here is the script:",
        "",
        "```typescript",
        "const a = 1;",
        "const b = 2;",
        "const c = 3;",
        "const d = 4;",
        "const e = 5;",
        "```",
      ].join("\n");

      const out = truncateToolOutputsInMarkdown(codeBlock, 3);
      expect(out).toContain("const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;");
    });
  });
});

describe("session-directory-index", () => {
  const dirs: string[] = [];

  async function fixture(): Promise<string> {
    const dir = join(tmpdir(), `reasonix-session-index-${crypto.randomUUID()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /** Seed a folder-per-session fixture: `<root>/<name>/messages.jsonl` with `body`. */
  async function seedSession(root: string, name: string, body: string): Promise<string> {
    const sessionDir = join(root, name);
    await mkdir(sessionDir, { recursive: true });
    const path = join(sessionDir, "messages.jsonl");
    await writeFile(path, body);
    return path;
  }

  afterEach(async () => {
    await Promise.all(
      dirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
  });

  describe("SessionDirectoryIndex", () => {
    it("single-flights refreshes and reuses an unchanged snapshot", async () => {
      const dir = await fixture();
      await seedSession(dir, "one", "a\nb\n");
      const loadMeta = vi.fn(() => ({ workspace: "a" }));
      const index = new SessionDirectoryIndex(() => dir, loadMeta);
      const first = index.load();
      const second = index.load();
      expect(first.cache).toBe("refresh");
      expect(second.cache).toBe("inflight");
      const [records] = await Promise.all([first.value, second.value]);
      expect(records[0]?.messageCount).toBe(2);
      expect(index.load().cache).toBe("hit");
      expect(loadMeta).toHaveBeenCalledTimes(1);
    });

    it("counts only appended bytes and fully recounts truncation", async () => {
      const dir = await fixture();
      const path = await seedSession(dir, "one", "a\n");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
      );
      await index.load().value;
      await appendFile(path, "b\nc\n");
      index.invalidate();
      expect((await index.load().value)[0]?.messageCount).toBe(3);
      await writeFile(path, "z\n");
      index.invalidate();
      expect((await index.load().value)[0]?.messageCount).toBe(1);
    });

    it("removes deleted files and retries an explicit refresh failure", async () => {
      const dir = await fixture();
      await seedSession(dir, "one", "a\n");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
      );
      expect(await index.load().value).toHaveLength(1);
      await rm(join(dir, "one"), { recursive: true });
      expect(await index.load().value).toHaveLength(0);
      await rm(dir, { recursive: true });
      expect(await index.load().value).toEqual([]);
    });

    it("rejects a directory that exceeds the configured file cap", async () => {
      const dir = await fixture();
      await seedSession(dir, "one", "a\n");
      await seedSession(dir, "two", "b\n");
      await seedSession(dir, "three", "c\n");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        2,
      );
      await expect(index.load().value).rejects.toThrow("session directory exceeds 2 files");
      // The failed refresh does not publish, so the next call retries the cap check.
      await expect(index.load().value).rejects.toThrow("session directory exceeds 2 files");
    });

    it("indexes a directory right at the configured file cap", async () => {
      const dir = await fixture();
      await seedSession(dir, "one", "a\n");
      await seedSession(dir, "two", "b\n");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        2,
      );
      expect((await index.load().value).map((record) => record.name)).toEqual(["one", "two"]);
    });

    it("persists the index to a cache file and reuses it across instances", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\nb\n");
      await seedSession(dir, "two", "x\ny\nz\n");
      const loadMeta = vi.fn(() => ({ workspace: "a" }));
      const first = new SessionDirectoryIndex(
        () => dir,
        loadMeta,
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      const [one, two] = (await first.load().value).sort((a, b) => a.name.localeCompare(b.name));
      expect(one?.messageCount).toBe(2);
      expect(two?.messageCount).toBe(3);
      expect(loadMeta).toHaveBeenCalledTimes(2);
      expect(existsSync(cacheFile)).toBe(true);
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        version: number;
        records: Array<{ name: string; messageCount: number }>;
      };
      expect(cached.version).toBe(3);
      expect(cached.records).toHaveLength(2);

      // A fresh instance (simulating relaunch) reuses the cache: no meta reloads,
      // no recounting of unchanged files.
      const second = new SessionDirectoryIndex(
        () => dir,
        loadMeta,
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      const [relaunchedOne, relaunchedTwo] = (await second.load().value).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      expect(relaunchedOne?.messageCount).toBe(2);
      expect(relaunchedTwo?.messageCount).toBe(3);
      expect(loadMeta).toHaveBeenCalledTimes(2);
    });

    it("persists only the meta a projector keeps and casts it back on seed", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\nb\n");
      const full = {
        workspace: "/ws",
        updatedAt: 5,
        createdAt: 1,
        summary: "Title",
        lastTurn: 7,
        turnCount: 3,
      };
      const keep = (meta: typeof full) => ({
        workspace: meta.workspace,
        updatedAt: meta.updatedAt,
        createdAt: meta.createdAt,
        summary: meta.summary,
      });
      const index = new SessionDirectoryIndex(
        () => dir,
        () => full,
        undefined,
        undefined,
        undefined,
        cacheFile,
        keep,
      );
      await index.load().value;
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        records: Array<{ meta: Record<string, unknown> }>;
      };
      expect(cached.records[0]?.meta).toEqual({
        workspace: "/ws",
        updatedAt: 5,
        createdAt: 1,
        summary: "Title",
      });

      // A relaunch reuses the projected meta for the unchanged session.
      const relaunched = new SessionDirectoryIndex(
        () => dir,
        () => full,
        undefined,
        undefined,
        undefined,
        cacheFile,
        keep,
      );
      const [record] = await relaunched.load().value;
      expect(record?.meta).toEqual({
        workspace: "/ws",
        updatedAt: 5,
        createdAt: 1,
        summary: "Title",
      });
    });

    it("persists meta whole when no projector is given", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\n");
      const full = { workspace: "/ws", summary: "Title", turnCount: 3 };
      const index = new SessionDirectoryIndex(
        () => dir,
        () => full,
        undefined,
        undefined,
        undefined,
        cacheFile,
      );
      await index.load().value;
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
        records: Array<{ meta: unknown }>;
      };
      expect(cached.records[0]?.meta).toEqual(full);
    });

    it("recounts only files that changed since the cache was written", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      const path = await seedSession(dir, "one", "a\n");
      await seedSession(dir, "two", "x\n");
      const first = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      await first.load().value;
      // Append to one session between instances; the other must stay cached.
      await appendFile(path, "b\nc\n");
      const second = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      const records = (await second.load().value).sort((a, b) => a.name.localeCompare(b.name));
      expect(records[0]?.messageCount).toBe(3);
      expect(records[1]?.messageCount).toBe(1);
    });

    it("snapshots the persisted cache without satisfying the TTL", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\nb\n");
      const first = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        undefined,
        undefined,
        undefined,
        cacheFile,
      );
      await first.load().value;

      // A relaunch can answer from the cache immediately...
      const second = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        undefined,
        undefined,
        undefined,
        cacheFile,
      );
      const snapshot = await second.snapshot();
      expect(snapshot?.map((record) => record.name)).toEqual(["one"]);
      expect(snapshot?.[0]?.messageCount).toBe(2);

      // ...and still owe the caller a full revalidation, which sees the new session.
      await seedSession(dir, "two", "x\n");
      const refreshed = second.load();
      expect(refreshed.cache).toBe("refresh");
      expect(
        (await refreshed.value).map((record) => record.name).sort((a, b) => a.localeCompare(b)),
      ).toEqual(["one", "two"]);
      expect(second.load().cache).toBe("hit");
    });

    it("returns no snapshot before anything is cached or loaded", async () => {
      const dir = await fixture();
      await seedSession(dir, "one", "a\n");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
      );
      expect(await index.snapshot()).toBeNull();
      // Once loaded, the in-memory set is the snapshot.
      await index.load().value;
      expect((await index.snapshot())?.map((record) => record.name)).toEqual(["one"]);
    });

    it("withholds a snapshot it cannot use or that belongs to another directory", async () => {
      const dir = await fixture();
      const other = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\n");
      await writeFile(cacheFile, "{ not json");
      const corrupt = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      expect(await corrupt.snapshot()).toBeNull();
      expect((await corrupt.load().value)[0]?.messageCount).toBe(1);

      const foreign = new SessionDirectoryIndex(
        () => other,
        () => ({}),
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      expect(await foreign.snapshot()).toBeNull();
    });

    it("ignores a corrupt cache file and rebuilds from disk", async () => {
      const dir = await fixture();
      const cacheFile = join(dir, "index-cache.json");
      await seedSession(dir, "one", "a\nb\n");
      await writeFile(cacheFile, "{ not json");
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
        undefined,
        cacheFile,
      );
      expect((await index.load().value)[0]?.messageCount).toBe(2);
    });

    it("parallelizes reads across many files", async () => {
      const dir = await fixture();
      const count = 300;
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          seedSession(dir, `session-${index}`, "a\nb\nc\n"),
        ),
      );
      const index = new SessionDirectoryIndex(
        () => dir,
        () => ({}),
        0,
        () => 0,
      );
      const records = await index.load().value;
      expect(records).toHaveLength(count);
      expect(records.every((record) => record.messageCount === 3)).toBe(true);
    }, 30_000);

    it("indexes empty session folders with or without messages.jsonl as zero-message sessions", async () => {
      const dir = await fixture();
      // Case 1: folder with empty messages.jsonl + meta.json
      const s1 = join(dir, "empty-with-file");
      await mkdir(s1, { recursive: true });
      await writeFile(join(s1, "messages.jsonl"), "");
      await writeFile(join(s1, "meta.json"), JSON.stringify({ workspace: "/workspace/a" }));

      // Case 2: folder with only meta.json (e.g. freshly created or hand-made)
      const s2 = join(dir, "empty-without-file");
      await mkdir(s2, { recursive: true });
      await writeFile(join(s2, "meta.json"), JSON.stringify({ workspace: "/workspace/a" }));

      const index = new SessionDirectoryIndex(
        () => dir,
        (name) =>
          name === "empty-without-file"
            ? { workspace: "/workspace/a" }
            : { workspace: "/workspace/a" },
      );
      const records = (await index.load().value).sort((a, b) => a.name.localeCompare(b.name));
      expect(records).toHaveLength(2);
      expect(records[0]?.name).toBe("empty-with-file");
      expect(records[0]?.messageCount).toBe(0);
      expect(records[1]?.name).toBe("empty-without-file");
      expect(records[1]?.messageCount).toBe(0);
    });
  });
});
