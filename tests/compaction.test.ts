import { describe, expect, it } from "vitest";
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
import { estimateConversationTokens } from "../src/tokenizer.js";
import type { ChatMessage, ToolCall } from "../src/types.js";

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
      expect(kept.some((m) => m.role === "user" && String(m.content).includes(prompt))).toBe(true);
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
          const resultIdx = messages.findIndex((x) => x.role === "tool" && x.tool_call_id === c.id);
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
