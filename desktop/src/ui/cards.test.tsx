// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

import { WorkspaceProvider } from "../Markdown";
import {
  DiffCard,
  NoticeCard,
  PlanCardView,
  PreText,
  ReasoningCard,
  ShellCard,
  SubagentCard,
  ToolCard,
  extractSubagentResultMeta,
  fullerSubagentTask,
  isSubagentTaskPreview,
  isSubagentTool,
  parseEditResult,
} from "./cards";
import { formatDuration } from "./format";
import { requestAnchorExpansion } from "./transcript-jump";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn() },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();
});

function wrap(ui: React.ReactNode) {
  return (
    <WorkspaceProvider value={{ dir: "/repo" }}>
      <div>{ui}</div>
    </WorkspaceProvider>
  );
}

/** Force a scroll container's scrollTop (jsdom has no layout engine). */
function setScrollTop(el: HTMLElement, top: number) {
  Object.defineProperty(el, "scrollTop", { value: top, writable: true, configurable: true });
}

describe("card duration labels", () => {
  it("keeps sub-second durations in ms and switches to seconds at 1s", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(111)).toBe("111 ms");
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2500)).toBe("2.5s");
    expect(formatDuration(8421)).toBe("8.4s");
  });

  it("shows a reasoning card's duration in the header", () => {
    const { container } = render(
      wrap(<ReasoningCard text="weighing options" streaming={false} durationMs={1500} />),
    );
    expect(container.querySelector(".meta-dur")?.textContent).toBe("1.5s");
  });

  it("shows no duration on a reasoning card still streaming without a time", () => {
    const { container } = render(wrap(<ReasoningCard text="…" streaming={true} />));
    expect(container.querySelector(".meta-dur")).toBeNull();
  });

  it("keeps the whole live reasoning scrollable while streaming", () => {
    const text = Array.from({ length: 12 }, (_, i) => `reasoning row ${i + 1}`).join("\n\n");
    const { container } = render(wrap(<ReasoningCard text={text} streaming />));
    const rows = Array.from(container.querySelectorAll(".reason .stream p"));

    expect(rows).toHaveLength(12);
    expect(rows[0]?.textContent).toBe("reasoning row 1");
    expect(rows.at(-1)?.textContent).toBe("reasoning row 12");
  });

  it("keeps all reasoning paragraphs after streaming completes", () => {
    const text = Array.from({ length: 12 }, (_, i) => `reasoning row ${i + 1}`).join("\n\n");
    const { container } = render(wrap(<ReasoningCard text={text} streaming={false} />));
    fireEvent.click(screen.getByRole("button", { name: /reasoning/i }));

    expect(container.querySelectorAll(".reason .stream p")).toHaveLength(12);
  });

  it("renders a tool card's duration in seconds once it passes 1s", () => {
    render(<ToolCard name="read_file" args="{}" result="ok" durationMs={2500} ok />);
    expect(screen.getByText("2.5s")).toBeTruthy();
  });

  it("renders a sub-second tool duration in ms", () => {
    render(<ToolCard name="read_file" args="{}" result="ok" durationMs={42} ok />);
    expect(screen.getByText("42 ms")).toBeTruthy();
  });
});

describe("reasoning scroll lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("pins completed reasoning on initial expansion and every reopening", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
    const { container } = render(wrap(<ReasoningCard text="completed" streaming={false} />));
    const header = screen.getByRole("button", { name: /reasoning/i });
    expect(container.querySelector(".reason .stream")).toBeNull();
    fireEvent.click(header);
    const stream = container.querySelector<HTMLElement>(".reason .stream")!;
    expect(stream.scrollTop).toBe(900);
    stream.scrollTop = 0;
    fireEvent.click(header);
    expect(container.querySelector(".reason .stream")).toBeNull();
    fireEvent.click(header);
    expect(container.querySelector<HTMLElement>(".reason .stream")?.scrollTop).toBe(900);
  });

  it("pins updates, completion and resize, and keeps one observer until collapse", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(700);
    const disconnect = vi.fn();
    let onResize = () => {};
    let created = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          onResize = callback;
          created += 1;
        }
        observe = vi.fn();
        disconnect = disconnect;
      },
    );
    const { container, rerender } = render(wrap(<ReasoningCard text="first" streaming />));
    const stream = container.querySelector<HTMLElement>(".reason .stream")!;
    expect(stream.scrollTop).toBe(700);
    stream.scrollTop = 0;
    rerender(wrap(<ReasoningCard text="first\nsecond" streaming />));
    expect(stream.scrollTop).toBe(700);
    // A token append re-pins the view without rebuilding the observer that keeps
    // it pinned, so a long stream allocates one observer, not one per token.
    expect(created).toBe(1);
    stream.scrollTop = 0;
    rerender(wrap(<ReasoningCard text="first\nsecond" streaming={false} />));
    expect(stream.scrollTop).toBe(700);
    stream.scrollTop = 0;
    onResize();
    expect(stream.scrollTop).toBe(700);
    fireEvent.click(screen.getByRole("button", { name: /reasoning/i }));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps a manually scrolled thinking card put until it is scrolled back to the bottom", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);

    const { container, rerender } = render(wrap(<ReasoningCard text="first" streaming />));
    const stream = container.querySelector<HTMLElement>(".reason .stream")!;
    expect(stream.scrollTop).toBe(700);

    // User wheels up to read earlier reasoning: this card un-pins.
    stream.scrollTop = 200;
    fireEvent.wheel(stream, { deltaY: -50 });

    // More tokens arrive: the viewport must hold, not snap back to the bottom.
    rerender(wrap(<ReasoningCard text={"first\nsecond\nthird"} streaming />));
    expect(stream.scrollTop).toBe(200);

    // User wheels back down to the bottom: this card re-pins.
    stream.scrollTop = 700;
    fireEvent.wheel(stream, { deltaY: 50 });

    rerender(wrap(<ReasoningCard text={"first\nsecond\nthird\nfourth"} streaming />));
    expect(stream.scrollTop).toBe(700);
  });

  it("splits single-newline CRLF rows and drops blank trailing rows", () => {
    const text = Array.from({ length: 12 }, (_, i) => `row ${i + 1}`).join("\r\n") + "\r\n\r\n";
    const { container } = render(wrap(<ReasoningCard text={text} streaming />));
    const rows = container.querySelectorAll(".reason .stream p");
    expect(rows).toHaveLength(12);
    expect(rows[0]?.textContent).toBe("row 1");
    expect(rows[11]?.textContent).toBe("row 12");
  });
});

describe("ToolCard — show-in-explorer button", () => {
  it("shows the button for read_file even while the card body is collapsed", async () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: "src/foo.ts", range: "50-100" })}
          result="…content…"
          ok
        />,
      ),
    );

    // ToolCard body starts collapsed (defaultOpen=false) — but the header
    // action must be visible regardless.
    expect(container.querySelector(".tool-call")).toBeNull();
    const btn = screen.getByRole("button", { name: "src/foo.ts" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/foo.ts",
        workspace: "/repo",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
    // Clicking the action must not expand the card (it's outside the toggle button).
    expect(container.querySelector(".tool-call")).toBeNull();
  });

  it("shows the button for write_file args", async () => {
    render(
      wrap(
        <ToolCard
          name="write_file"
          args={JSON.stringify({ path: "src/new.ts", content: "…" })}
          result="ok"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/new.ts" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new.ts",
        workspace: "/repo",
      }),
    );
  });

  it("handles long file paths without omitting the button or accessible name", async () => {
    const longPath =
      "CookingForBlockheads-1.4.4-GTNH/src/main/java/net/blay09/mods/cookingforblockheads/container/ContainerRecipeBook.java";
    render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: longPath })}
          result="ok"
          durationMs={111}
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: longPath });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("title")).toBe(longPath);

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: `/repo/${longPath}`,
        workspace: "/repo",
      }),
    );
  });

  it("shows no file button for non-file tools", () => {
    render(
      wrap(
        <ToolCard
          name="run_command"
          args={JSON.stringify({ command: "npm test" })}
          result="✓"
          ok
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /npm test/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^src\// })).toBeNull();
  });

  it("shows the engine pill for web_search results", () => {
    render(
      wrap(
        <ToolCard
          name="web_search"
          args={JSON.stringify({ query: "flutter 3.19" })}
          result={"query: flutter 3.19\nengine: bing\nresults (2):\n1. One\n   https://one"}
          ok
        />,
      ),
    );

    const header = screen.getByRole("button", { name: /web_search/ });
    expect(header.textContent).toContain("bing");
  });

  it("shows the engine pill for web_fetch results too", () => {
    render(
      wrap(
        <ToolCard
          name="web_fetch"
          args={JSON.stringify({ url: "https://example.com/" })}
          result={"engine: ollama\n\nFetched\nhttps://example.com/\n\ncontent"}
          ok
        />,
      ),
    );

    const header = screen.getByRole("button", { name: /web_fetch/ });
    expect(header.textContent).toContain("ollama");
  });

  it("shows no engine pill when the result has no engine line", () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="run_command"
          args={JSON.stringify({ command: "npm test" })}
          result="✓"
          ok
        />,
      ),
    );
    expect(container.querySelector(".pill-tag")).toBeNull();
  });
});

describe("ToolCard — expanded body formatting", () => {
  it("pretty-prints JSON args as an indented pre-wrap block when expanded", () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="mark_step_complete"
          args={JSON.stringify({
            stepId: "step-1",
            title: "Remove the 3 buttons + relayout",
            evidence: [{ kind: "manual", summary: "3 edits applied" }],
          })}
          result="Done."
          ok
        />,
      ),
    );
    fireEvent.click(screen.getByText("mark_step_complete"));

    const argsValue = container.querySelector(".tool-call .row .v .pre-text");
    expect(argsValue).not.toBeNull();
    // pre-wrap is on the element (class), not an inline style — shared with plan cards
    expect(argsValue!.className).toContain("pre-text");
    // pretty-printed: keys land on their own lines, not one blob
    expect(argsValue!.textContent).toContain('\n  "stepId": "step-1"');
    expect(argsValue!.textContent).toContain('\n  "title":');
  });

  it("keeps line breaks in a multi-line result (multi_edit summary) via pre-wrap", () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="multi_edit"
          args={JSON.stringify({ edits: [{ path: "src/a.ts", search: "x", replace: "y" }] })}
          result={"multi_edit: applied 7 edits across 1 file\n# src/a.ts\n@@ -14,4 +14,3 @@"}
          ok
        />,
      ),
    );
    fireEvent.click(screen.getByText("multi_edit"));

    const rows = container.querySelectorAll(".tool-call .row .v .pre-text");
    expect(rows.length).toBe(2);
    const resultValue = rows[1]!;
    expect(resultValue.textContent).toContain("\n");
  });

  it("renders a long read_file result past the old 1200-char cap", () => {
    const content = `${"x".repeat(1500)}\nEND-MARKER`;
    const { container } = render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: "src/big.ts" })}
          result={content}
          ok
        />,
      ),
    );
    fireEvent.click(screen.getByText("read_file"));

    const body = container.querySelector(".tool-call")!;
    expect(body.textContent).toContain("END-MARKER");
  });

  it("leaves non-JSON args (shell command text) untouched", () => {
    const { container } = render(
      wrap(<ToolCard name="unknown_tool" args={"--flag value\nsecond line"} result="ok" ok />),
    );
    fireEvent.click(screen.getByText("unknown_tool"));

    const argsValue = container.querySelector(".tool-call .row .v .pre-text")!;
    expect(argsValue.textContent).toBe("--flag value\nsecond line");
  });
});

describe("SubagentCard — model visibility", () => {
  const run = {
    runId: "run-1",
    task: "Inspect quota rendering",
    skillName: "explore",
    model: "deepseek-v4-flash",
    status: "done" as const,
    contextTokens: 12_345,
    costUsd: 0.0123,
    tools: [],
  };

  it("shows the child model in the card header", () => {
    render(<SubagentCard name="explore" runs={[run]} />);

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash");
    expect(header.textContent).toContain("ctx 12.3k");
    expect(header.textContent).toContain("$0.0123");
  });

  it("updates context while running and hides cost until completion", () => {
    const { rerender } = render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, status: "running", contextTokens: 8_000, costUsd: undefined }]}
      />,
    );

    let header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("ctx 8.0k");
    expect(header.textContent).not.toContain("$");

    rerender(<SubagentCard name="explore" runs={[run]} />);
    header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("ctx 12.3k");
    expect(header.textContent).toContain("$0.0123");
  });

  it("shows the child context meter instead of raw char counters on the run row", () => {
    const { container } = render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, contextMax: 300_000, outputChars: 1_204, toolReadChars: 45_678 }]}
      />,
    );

    // No run row may display the old "read chars" counter — context x/y replaces it.
    // toolReadChars is set so a revert to the raw counter would fail the ctx assertion.
    expect(container.textContent).not.toContain("read chars");
    const row = container.querySelector(".sub-row");
    const statsRole = row
      ? [...row.querySelectorAll(".role")].find((el) => el.textContent?.includes("ctx "))
      : undefined;
    expect(statsRole?.textContent).toContain("ctx 12.3k / 300.0k");
    expect(statsRole?.textContent).toContain("output chars");
  });

  it("shows no row context meter when the daemon omits the cap (older versions)", () => {
    const { container } = render(<SubagentCard name="explore" runs={[run]} />);
    const statsRole = [...container.querySelectorAll(".sub-row .role")].find((el) =>
      el.textContent?.includes("ctx "),
    );
    expect(statsRole).toBeUndefined();
    expect(container.textContent).not.toContain("read chars");
  });

  it("shows a provider quota % instead of a dollar figure for plan-billed runs", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          {
            ...run,
            costUsd: 0,
            billingKind: "quota",
            quotaUsedPct: 2.5,
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("2.50%");
    expect(header.textContent).not.toContain("$");
  });

  it("shows no cost metric when the run has no measurable billing", () => {
    render(<SubagentCard name="explore" runs={[{ ...run, costUsd: 0, billingKind: "none" }]} />);
    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).not.toContain("$");
    expect(header.textContent).not.toContain("%");
  });

  it("shows no cost metric when a quota run produced no measurable delta", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, costUsd: 0, billingKind: "quota", quotaUsedPct: undefined }]}
      />,
    );
    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).not.toContain("$");
    expect(header.textContent).not.toContain("%");
  });

  it("shows every distinct model for mixed-model fan-out", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          run,
          {
            ...run,
            runId: "run-2",
            model: "deepseek-v4-pro",
            contextTokens: 24_680,
            costUsd: 0.02,
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash + deepseek-v4-pro");
    expect(header.textContent).toContain("ctx 12.3k / 24.7k");
    expect(header.textContent).toContain("$0.0323");
  });

  it("renders subagent kind badge and markdown result in card body", () => {
    const { container } = render(
      <SubagentCard
        name="explore"
        runs={[run]}
        result="Found 3 references in `src/index.ts`."
        durationMs={2500}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.querySelector(".kind")?.textContent).toBe("subagent");
    expect(header.textContent).toContain("2.5s");

    const resultEl = container.querySelector(".subagent-result");
    expect(resultEl?.textContent).toContain("Found 3 references in src/index.ts.");
  });

  it("shows the whole instruction the subagent was given, not a cut-down head", () => {
    const task =
      "Survey every Events-tab consumer and report, per consumer, which fields it renders and which it drops, then flag any field that no consumer reads at all.";
    const { container } = render(
      <SubagentCard
        name="explore"
        args={JSON.stringify({ task })}
        // The wire only forwards a preview of the task; the card has the args.
        runs={[{ ...run, task: `${task.slice(0, 30)}…` }]}
      />,
    );
    const row = container.querySelector(".sub-row");
    // The whole instruction, verbatim: nothing trimmed, nothing elided.
    expect(row?.textContent).toContain(task);
    expect(row?.textContent).not.toContain("…");
  });

  it("falls back to the run's own task when the card has no args", () => {
    const { container } = render(<SubagentCard name="explore" runs={[run]} />);
    expect(container.querySelector(".sub-row")?.textContent).toContain("Inspect quota rendering");
  });

  it("carries the spawn's anchor so the Events tab can land on the card", () => {
    const { container } = render(<SubagentCard name="explore" runs={[run]} anchor="call:tc-7" />);
    expect(container.querySelector(".card-wrap")?.getAttribute("data-anchor")).toBe("call:tc-7");
  });

  it("keeps a foreign instruction out of a run row", () => {
    // The card may carry args from a different call than the run (progress events
    // fall back to a sibling segment). A non-matching text must not be substituted.
    const { container } = render(
      <SubagentCard
        name="explore"
        args={JSON.stringify({ task: "Investigate the parser" })}
        runs={[{ ...run, task: "Inspect quota rendering" }]}
      />,
    );
    const text = container.querySelector(".sub-row")?.textContent ?? "";
    expect(text).toContain("Inspect quota rendering");
    expect(text).not.toContain("Investigate the parser");
  });

  it("ranks task previews with one shared rule", () => {
    const full = "Diagnose the crash in suite_measure_group and prescribe the fix.";
    // A cut-down head (either cut path) is recognised as a preview of the whole.
    expect(isSubagentTaskPreview(`${full.slice(0, 30)}…`, full)).toBe(true);
    expect(isSubagentTaskPreview(full.slice(0, 12), full)).toBe(true);
    // A whole instruction, a longer text, or an unrelated one is not a preview.
    expect(isSubagentTaskPreview(full, full)).toBe(false);
    expect(isSubagentTaskPreview("something else entirely", full)).toBe(false);
    expect(fullerSubagentTask(full, `${full.slice(0, 30)}…`)).toBe(full);
    expect(fullerSubagentTask(undefined, "first")).toBe("first");
    // A genuinely different (shorter) task replaces what we had: it is not a preview.
    expect(fullerSubagentTask(full, "rerun the suite")).toBe("rerun the suite");
  });

  it("identifies the one spawn tool and nothing else", () => {
    expect(isSubagentTool("spawn_subagent")).toBe(true);
    expect(isSubagentTool("read_file")).toBe(false);
    expect(isSubagentTool("run_command")).toBe(false);
  });

  it("recovers model and cost from the persisted result envelope", () => {
    expect(
      extractSubagentResultMeta(
        JSON.stringify({
          success: true,
          output: "…",
          turns: 6,
          elapsed_ms: 25223,
          cost_usd: 0.0062,
          model: "deepseek-v4-flash",
          billing_kind: "usd",
        }),
      ),
    ).toEqual({
      costUsd: 0.0062,
      model: "deepseek-v4-flash",
      billingKind: "usd",
      elapsedMs: 25223,
      turns: 6,
    });

    // quota-billed run
    expect(
      extractSubagentResultMeta(
        JSON.stringify({ cost_usd: 0, billing_kind: "quota", quota_used_pct: 2.5 }),
      ),
    ).toEqual({ costUsd: 0, billingKind: "quota", quotaUsedPct: 2.5 });

    expect(extractSubagentResultMeta("not json")).toEqual({});
    expect(extractSubagentResultMeta(undefined)).toEqual({});
  });

  it("shows model and cost on a result-only run (no subagentRuns after reload)", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          {
            runId: "run-1",
            task: "Inspect quota rendering",
            skillName: "explore",
            model: "deepseek-v4-flash",
            status: "done",
            costUsd: 0.0422,
            billingKind: "usd",
            tools: [],
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash");
    expect(header.textContent).toContain("$0.0422");
  });

  it("shows the last 3 rows of thinking and process when subagent is running", () => {
    const runningRun = {
      runId: "run-live",
      task: "Analyze codebase",
      skillName: "explore",
      model: "deepseek-v4-flash",
      status: "running" as const,
      tools: [],
      recentRows: [
        { id: "r1", kind: "thinking" as const, text: "Initial thoughts" },
        { id: "r2", kind: "process" as const, text: "↳ read_file src/index.ts" },
        { id: "r3", kind: "thinking" as const, text: "Parsing export signatures" },
        { id: "r4", kind: "process" as const, text: "↳ search_content loop" },
      ],
    };

    render(<SubagentCard name="explore" runs={[runningRun]} />);

    const activityBox = screen.getByLabelText("Subagent activity");
    expect(activityBox).toBeTruthy();

    const rows = activityBox.querySelectorAll(".sub-activity-row");
    expect(rows.length).toBe(3);

    // Should show the last 3 rows (r2, r3, r4), dropping r1
    expect(rows[0]?.textContent).toContain("process");
    expect(rows[0]?.textContent).toContain("↳ read_file src/index.ts");
    expect(rows[1]?.textContent).toContain("thinking");
    expect(rows[1]?.textContent).toContain("Parsing export signatures");
    expect(rows[2]?.textContent).toContain("process");
    expect(rows[2]?.textContent).toContain("↳ search_content loop");
  });

  it("updates the visible last three rows while a subagent is streaming", () => {
    const run = {
      runId: "run-streaming",
      task: "Research current docs",
      skillName: "research",
      status: "running" as const,
      tools: [],
      recentRows: [{ id: "start", kind: "process" as const, text: "Starting research..." }],
    };
    const { rerender } = render(<SubagentCard name="research" runs={[run]} />);

    let activityBox = screen.getByLabelText("Subagent activity");
    expect(activityBox.textContent).toContain("Starting research...");

    rerender(
      <SubagentCard
        name="research"
        runs={[
          {
            ...run,
            recentRows: [
              ...run.recentRows,
              { id: "line-1", kind: "thinking", text: "Checking Tauri events" },
              { id: "line-2", kind: "thinking", text: "Reading local event bridge" },
              { id: "tool-1", kind: "process", text: "↳ web_fetch Tauri docs" },
            ],
          },
        ]}
      />,
    );

    activityBox = screen.getByLabelText("Subagent activity");
    const rows = activityBox.querySelectorAll(".sub-activity-row");
    expect(rows.length).toBe(3);
    expect(activityBox.textContent).not.toContain("Starting research...");
    expect(rows[0]?.textContent).toContain("Checking Tauri events");
    expect(rows[1]?.textContent).toContain("Reading local event bridge");
    expect(rows[2]?.textContent).toContain("↳ web_fetch Tauri docs");
  });

  it("names the run's skill in its first row, never the spawn tool", () => {
    const firstRow = (skillName?: string) => {
      const { unmount } = render(
        <SubagentCard
          name="spawn_subagent"
          runs={[
            {
              runId: "run-placeholder",
              task: "Fan out two probes",
              ...(skillName === undefined ? {} : { skillName }),
              status: "running" as const,
              tools: [],
              recentRows: [],
            },
          ]}
        />,
      );
      const text = screen.getByLabelText("Subagent activity").textContent ?? "";
      unmount();
      return text;
    };
    // An argless spawn carries no skill, and its own tool name reads as an event
    // rather than work in progress — the placeholder must never print it.
    expect(firstRow("spawn_subagent")).toContain("Starting subagent...");
    expect(firstRow(undefined)).toContain("Starting subagent...");
    expect(firstRow("research")).toContain("Starting research...");
  });
});

describe("DiffCard — show-in-explorer button", () => {
  it("renders the button in the header and reveals the file in the explorer", async () => {
    render(
      wrap(
        <DiffCard
          filename="src/foo.ts"
          applied
          lines={[
            { t: "hunk", s: "@@ -12,3 +12,3 @@" },
            { t: "ctx", l: 12, r: 12, s: "const a = 1;" },
            { t: "rm", l: 13, s: "const b = 2;" },
            { t: "add", r: 13, s: "const b = 3;" },
          ]}
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "Show in file explorer" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/foo.ts",
        workspace: "/repo",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("right-click exposes an Open-with… menu that fires open_with_dialog", async () => {
    render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: "src/foo.ts", range: "1-10" })}
          result="…content…"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/foo.ts" });
    fireEvent.contextMenu(btn);

    const openWith = await screen.findByRole("menuitem", { name: "Open with…" });
    expect(openWith).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("open_with_dialog", expect.anything());

    fireEvent.click(openWith);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_with_dialog", {
        path: "/repo/src/foo.ts",
      }),
    );
  });

  it("right-click menu also offers Copy path and copies the resolved absolute path", async () => {
    render(
      wrap(
        <ToolCard
          name="write_file"
          args={JSON.stringify({ path: "src/new.ts", content: "…" })}
          result="ok"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/new.ts" });
    fireEvent.contextMenu(btn);

    const copyPath = await screen.findByRole("menuitem", { name: "Copy path" });
    fireEvent.click(copyPath);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/repo/src/new.ts"),
    );
  });
});

describe("ShellCard — full output stream while running", () => {
  it("renders every streamed line, not just a trailing tail", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="npm test"
          liveOutput={"pass 1\npass 2\npass 3\npass 4\n"}
          state="running"
        />,
      ),
    );
    const rows = [...container.querySelectorAll(".shell .stream > div")].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["pass 1", "pass 2", "pass 3", "pass 4"]);
  });

  it("shows nothing until output actually arrives", () => {
    const { container } = render(wrap(<ShellCard command="npm test" state="running" />));
    expect(container.querySelector(".shell .stream")).toBeNull();
  });

  it("shows a trailing partial line while the command is still writing", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="cargo build"
          liveOutput={"Compiling reasonix\nBuilding... 90%"}
          state="running"
        />,
      ),
    );
    const rows = [...container.querySelectorAll(".shell .stream > div")].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["Compiling reasonix", "Building... 90%"]);
  });

  it("hides the stream until the user expands a settled card", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="npm test"
          output="✓ 10 tests passed"
          liveOutput={"pass 1\npass 2\n"}
          state="done"
        />,
      ),
    );
    // Done cards collapse to the header — the stream must not render until the
    // user expands the card, where the settled result replaces the live tail.
    expect(container.querySelector(".shell .stream")).toBeNull();
    expect(container.querySelector(".shell")).toBeNull();
  });

  it("labels a live background job and streams its output instead of reading as finished", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="curl -o out.bin https://example.com/big.bin"
          liveOutput={"% Total    % Received\n0 685M    0  2403k  0  1610k"}
          state="running"
          background
          onStop={() => {}}
        />,
      ),
    );
    // A detached job is not a finished command: the header shows the background
    // running label, never a done checkmark with a duration.
    expect(screen.getByRole("img", { name: "Running in background" })).toBeTruthy();
    const rows = [...container.querySelectorAll(".shell .stream > div")].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["% Total    % Received", "0 685M    0  2403k  0  1610k"]);
    expect(container.querySelector(".meta-dur")).toBeNull();
  });

  it("pins the output to the bottom as new lines stream in", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(640);
    const { container, rerender } = render(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2"} state="running" />),
    );
    const stream = container.querySelector<HTMLElement>(".shell .stream")!;
    expect(stream.scrollTop).toBe(640);
    stream.scrollTop = 0;
    rerender(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2\nline 3"} state="running" />),
    );
    expect(stream.scrollTop).toBe(640);
  });

  it("holds position when the user scrolls up, and re-pins at the bottom", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const { container, rerender } = render(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2"} state="running" />),
    );
    const stream = container.querySelector<HTMLElement>(".shell .stream")!;
    expect(stream.scrollTop).toBe(700);

    // User wheels up to read earlier output: the stream un-pins.
    stream.scrollTop = 200;
    fireEvent.wheel(stream, { deltaY: -50 });

    // More output arrives: the viewport must hold, not snap back to the bottom.
    rerender(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2\nline 3"} state="running" />),
    );
    expect(stream.scrollTop).toBe(200);

    // User wheels back down to the bottom: the stream re-pins and follows again.
    stream.scrollTop = 700;
    fireEvent.wheel(stream, { deltaY: 50 });
    rerender(
      wrap(
        <ShellCard
          command="npm test"
          liveOutput={"line 1\nline 2\nline 3\nline 4"}
          state="running"
        />,
      ),
    );
    expect(stream.scrollTop).toBe(700);
  });

  it("re-pins when the scrollbar is dragged to the bottom and never bounces back", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const { container, rerender } = render(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2"} state="running" />),
    );
    const stream = container.querySelector<HTMLElement>(".shell .stream")!;

    // Drag up (release), then down to the bottom, with a 1px jitter back up.
    fireEvent.pointerDown(stream);
    setScrollTop(stream, 200);
    fireEvent.scroll(stream);
    setScrollTop(stream, 400);
    fireEvent.scroll(stream);
    setScrollTop(stream, 399);
    fireEvent.scroll(stream);
    fireEvent.pointerUp(window);

    // The re-pin held through the jitter: the next append still follows the bottom.
    setScrollTop(stream, 300);
    rerender(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2\nline 3"} state="running" />),
    );
    expect(stream.scrollTop).toBe(700);
  });
});

describe("ShellCard — terminal escape handling", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI colors from a settled command output", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="npx vitest run --reporter=dot"
          output={`${ESC}[32m·${ESC}[39m${ESC}[33m·${ESC}[39m${ESC}[22m`}
          state="failed"
        />,
      ),
    );
    const out = container.querySelector(".shell .stream")?.textContent ?? "";
    expect(out).not.toContain(ESC);
    expect(out).toContain("··");
  });

  it("strips ANSI colors from the live output rows", () => {
    const { container } = render(
      wrap(
        <ShellCard
          command="npx vitest run --reporter=dot"
          liveOutput={`${ESC}[32mRUN${ESC}[39m\n${ESC}[33mpass${ESC}[39m`}
          state="running"
        />,
      ),
    );
    const rows = [...container.querySelectorAll(".shell .stream > div")].map(
      (el) => el.textContent,
    );
    expect(rows).toEqual(["RUN", "pass"]);
  });
});

describe("PreText — raw text sanitization", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes and control bytes from string children", () => {
    const raw = `a${ESC}[31mb${ESC}[0m${String.fromCharCode(7)}c`;
    const { container } = render(wrap(<PreText>{raw}</PreText>));
    expect(container.querySelector(".pre-text")?.textContent).toBe("abc");
  });

  it("leaves composed node children untouched", () => {
    const { container } = render(
      wrap(
        <PreText>
          <div key="k">node child</div>
        </PreText>,
      ),
    );
    expect(container.querySelector(".pre-text div")?.textContent).toBe("node child");
    expect(container.querySelector(".pre-text")?.textContent).toBe("node child");
  });
});

describe("NoticeCard — raw text sanitization", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes and control bytes from the notice body", () => {
    const raw = `error ${ESC}[31mred${ESC}[0m${String.fromCharCode(7)}`;
    const { container } = render(wrap(<NoticeCard text={raw} severity="error" />));
    const body = container.querySelector(".notice-body")?.textContent ?? "";
    expect(body).not.toContain(ESC);
    expect(body).toBe("error red");
  });
});

describe("NoticeCard — compaction throbber states", () => {
  it("shows the running throbber and the Compaction name while compacting", () => {
    const { container } = render(
      wrap(<NoticeCard text="Compacting context…" severity="info" running />),
    );
    expect(container.querySelector('[aria-label="Compacting"]')).toBeTruthy();
    expect(screen.getByText("Compaction")).toBeTruthy();
  });

  it("shows the done check once compaction completes", () => {
    const { container } = render(
      wrap(<NoticeCard text="Context compacted." severity="success" running={false} />),
    );
    expect(container.querySelector('[aria-label="Compacted"]')).toBeTruthy();
    expect(screen.getByText("Compaction")).toBeTruthy();
  });

  it("renders plain notices without a status icon", () => {
    const { container } = render(wrap(<NoticeCard text="hi" severity="info" />));
    expect(container.querySelector('[aria-label="Compacting"]')).toBeNull();
    expect(container.querySelector('[aria-label="Compacted"]')).toBeNull();
  });

  it("carries the jump anchor recorded with its event", () => {
    const { container } = render(
      wrap(
        <NoticeCard
          text="Context compacted."
          severity="success"
          running={false}
          anchor="notice:n1"
        />,
      ),
    );
    expect(container.querySelector('[data-anchor="notice:n1"]')).toBeTruthy();
  });
});

describe("NoticeCard — a jump opens the card it lands on", () => {
  /** The anchored compaction card: its collapse head, and the box carrying the
   *  open state the jump can force. */
  const renderAnchored = () => {
    const { container } = render(
      wrap(
        <NoticeCard
          text="Context compacted."
          severity="success"
          running={false}
          anchor="notice:n1"
        />,
      ),
    );
    return {
      head: container.querySelector(".card-head") as HTMLElement,
      open: () => container.querySelector(".card")?.getAttribute("data-open"),
    };
  };

  it("opens a collapsed card the Events tab jumps to", () => {
    const { head, open } = renderAnchored();

    fireEvent.click(head);
    expect(open()).toBe("false");

    act(() => requestAnchorExpansion(["notice:n1"]));
    expect(open()).toBe("true");
  });

  it("keeps the reader's own collapse, and a jump elsewhere releases the card", () => {
    const { head, open } = renderAnchored();

    act(() => requestAnchorExpansion(["notice:n1"]));
    expect(open()).toBe("true");

    // A click on the head closes it even though a jump opened it.
    fireEvent.click(head);
    expect(open()).toBe("false");

    // A jump to a plain turn (no anchor) takes the forced state back out.
    act(() => requestAnchorExpansion(["notice:n1"]));
    act(() => requestAnchorExpansion([]));
    expect(open()).toBe("false");
  });

  it("opens on any of the ids one record carries, so an alias reaches the card", () => {
    const { head, open } = renderAnchored();

    fireEvent.click(head);
    expect(open()).toBe("false");

    act(() => requestAnchorExpansion(["call:call-loop-7", "notice:n1"]));
    expect(open()).toBe("true");
  });
});

describe("DiffCard — terminal escape handling", () => {
  const ESC = String.fromCharCode(27);

  it("renders no escape bytes from a parsed edit result", () => {
    const result = [
      "# src/foo.ts",
      "@@ -1,1 +1,1 @@",
      `-old ${ESC}[31mred${ESC}[0m`,
      `+new ${ESC}[32mgreen${ESC}[0m`,
    ].join("\n");
    const files = parseEditResult(result);
    const { container } = render(
      wrap(<DiffCard filename={files[0]!.filename} lines={files[0]!.lines} applied />),
    );
    const text = container.querySelector(".diff")?.textContent ?? "";
    expect(text).not.toContain(ESC);
    expect(text).toContain("old red");
    expect(text).toContain("new green");
  });
});

describe("SubagentCard — terminal escape handling", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes from an activity row", () => {
    const run = {
      runId: "run-esc",
      task: "do it",
      skillName: "research",
      status: "running" as const,
      tools: [],
      recentRows: [{ id: "r1", kind: "process" as const, text: `${ESC}[32mgreen row${ESC}[0m` }],
    };
    const { container } = render(wrap(<SubagentCard name="research" runs={[run]} />));
    const rows = [...container.querySelectorAll(".sub-activity-text")].map((el) => el.textContent);
    expect(rows).toEqual(["green row"]);
  });
});

describe("PlanCardView — terminal escape handling", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes from a step's text", () => {
    const { container } = render(
      wrap(
        <PlanCardView items={[{ id: 1, status: "active", text: `${ESC}[36mstep one${ESC}[0m` }]} />,
      ),
    );
    const text = container.querySelector(".plan-item .text")?.textContent ?? "";
    expect(text).not.toContain(ESC);
    expect(text).toBe("step one");
  });
});

describe("ShellCard — command line sanitization", () => {
  const ESC = String.fromCharCode(27);

  it("strips ANSI escapes from the command text", () => {
    const { container } = render(
      wrap(<ShellCard command={`echo ${ESC}[31mhi${ESC}[0m`} state="running" />),
    );
    const cmd = container.querySelector(".shell .cmd .text")?.textContent ?? "";
    expect(cmd).not.toContain(ESC);
    expect(cmd).toBe("echo hi");
  });
});

// Every long card body shares one bounded box (`.row-scroll`): the same window
// the thinking and shell streams use, so nothing is truncated and nothing runs
// the full transcript height.
describe("long card bodies share the row window", () => {
  const run = {
    runId: "run-window",
    task: "Inspect quota rendering",
    skillName: "explore",
    status: "done" as const,
    tools: [],
  };

  it("windows the thinking stream", () => {
    const { container } = render(wrap(<ReasoningCard text="a\n\nb" streaming={false} />));
    fireEvent.click(screen.getByRole("button", { name: /reasoning/i }));
    const box = container.querySelector(".reason .stream");
    expect(box?.classList.contains("row-scroll")).toBe(true);
  });

  it("windows the shell output stream", () => {
    const { container } = render(
      wrap(<ShellCard command="npm test" liveOutput={"line 1\nline 2"} state="running" />),
    );
    const box = container.querySelector(".shell .stream");
    expect(box?.classList.contains("row-scroll")).toBe(true);
  });

  it("windows a subagent's run rows and result", () => {
    const { container } = render(wrap(<SubagentCard name="explore" runs={[run]} result="done" />));
    const box = container.querySelector(".sub-card");
    expect(box?.classList.contains("row-scroll")).toBe(true);
    expect(box?.querySelector(".subagent-result")?.textContent).toBe("done");
  });

  it("keeps every run row mounted so the box scrolls instead of truncating", () => {
    const runs = Array.from({ length: 8 }, (_, i) => ({ ...run, runId: `run-${i}` }));
    const { container } = render(wrap(<SubagentCard name="explore" runs={runs} />));
    expect(container.querySelectorAll(".sub-row")).toHaveLength(8);
  });
});
