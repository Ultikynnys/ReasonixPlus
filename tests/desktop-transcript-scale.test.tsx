// @vitest-environment jsdom
/**
 * Scale budget for the transcript, pinned against the reported worst case:
 * 10 workspaces x 100 sessions x 2000 messages.
 *
 * Recorded before/after on this machine (Windows x64, Node 24). Absolute ms drift
 * between runs, so the row counts below are compared inside one probe run.
 *
 *   BEFORE (full history mounted and re-derived every frame)
 *   one 2000-message $session_loaded .... 4.69 MB on the wire, 6.3 ms parse
 *   10 restored at boot ................. 46.9 MB, ~63 ms of blocking parse
 *   markdown pipeline, one transcript ... 1577 ms (1500 prose blocks)
 *   mount, 2000 rows .................... 254 ms (jsdom)
 *   one streaming flush over 2000 rows .. 31.9 ms median, p95 93.9 ms
 *   DOM nodes, 2000 rows ................ 4001 = 191% of a 16.7 ms frame
 *
 *   AFTER (one page; SESSION_PAGE_SIZE in src/cli/commands/desktop.ts)
 *   one 300-record page on the wire ..... 1.89 MB; the 4.69 MB session never ships
 *   mount, 300 rows ..................... 55 ms
 *   one streaming flush over 300 rows ... 4.97 ms median, p95 16.6 ms
 *   DOM nodes, 300 rows ................. 601 = 30% of a 16.7 ms frame
 *   per-flush work ...................... one row, not O(messages): the tail card is
 *                                         split out and the row list keys on
 *                                         messagesVersion, so a text delta re-renders
 *                                         the tail and leaves the rows alone
 *
 * These tests guard the shape, not the clock: budgets are ceilings that only a
 * pathological regression can breach. The invariants that do not hold yet are
 * skipped with the step that turns them green.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectPersistedNotices,
  mapLoadedMessages,
  reduce,
  settleTurnMessages,
  streamingTailIndex,
} from "../desktop/src/App";
import { DiffCard, parseEditResult } from "../desktop/src/ui/cards";
import { sessionEvents } from "../desktop/src/ui/events";
import { AssistantMsg, UserMsg } from "../desktop/src/ui/thread";
import {
  SCALE_WORST_CASE,
  scaleStore,
  sessionRecords,
  wireSessionOfSize,
  writeScaleStore,
} from "./fixtures/scale-sessions.js";
import { baseAppState } from "./support/app-state.js";
import { PERF_ENABLED } from "./support/perf-gate.js";

type UiMessage = ReturnType<typeof mapLoadedMessages>[number];

const noop = () => undefined;
const noopRule = () => undefined;

/** The transcript structure, with text flattened away: two states with the same
 *  structure differ only in what is inside a card, never in what is on screen. */
function shapeOf(messages: readonly UiMessage[]): string {
  return messages
    .map((m) => {
      if (m.kind === "user") return `u${m.turn}`;
      if (m.kind === "notice") return `n${m.id}`;
      return `a${m.turn}:${m.segments.map((s) => s.kind).join(",")}`;
    })
    .join("|");
}

/** The transcript rows App.tsx builds, minus the App shell around them. */
function transcriptRows(messages: readonly UiMessage[]) {
  return messages.map((m, i) => {
    if (m.kind === "user") {
      return (
        <div key={`u-${m.turn}`} className="thread-row" data-turn={m.turn}>
          <UserMsg text={m.text} images={m.images} />
        </div>
      );
    }
    if (m.kind === "assistant") {
      return (
        <div key={`a-${m.turn}-${i}`} className="thread-row">
          <AssistantMsg
            segments={m.segments}
            pending={m.pending}
            model="deepseek-v4-flash"
            onApproveConfirm={noop}
            onRejectConfirm={noop}
            onRuleConfirm={noopRule}
            onStopTool={noop}
            pendingConfirms={[]}
          />
        </div>
      );
    }
    return (
      <div key={m.id} className="thread-row">
        {m.text}
      </div>
    );
  });
}

afterEach(() => {
  cleanup();
});

describe("scale fixtures", () => {
  it("keeps the worst case at 10 x 100 x 2000 without materializing it", () => {
    expect(SCALE_WORST_CASE).toEqual({
      workspaces: 10,
      sessionsPerWorkspace: 100,
      messagesPerSession: 2000,
    });
    const first = scaleStore(SCALE_WORST_CASE).next();
    expect(first.done).toBe(false);
    expect(first.value?.records).toHaveLength(2000);
    expect(first.value?.meta.workspace).toBe("C:\\perf\\workspace-0");
  });

  it("writes a store in the daemon's on-disk layout", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-scale-"));
    try {
      const written = writeScaleStore(root, {
        workspaces: 2,
        sessionsPerWorkspace: 3,
        messagesPerSession: 50,
      });
      expect(written.sessions).toBe(6);
      const records = sessionRecords(50);
      expect(records).toHaveLength(50);
      expect(records[0]?.role).toBe("user");
      expect(records[1]?.role).toBe("assistant");
      expect(records[2]?.role).toBe("tool");
      const session = [
        ...scaleStore({ workspaces: 1, sessionsPerWorkspace: 1, messagesPerSession: 50 }),
      ][0]!;
      const lines = readFileSync(join(root, session.name, "messages.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(50);
      expect(JSON.parse(lines[0]!)).toMatchObject({ role: "user" });
      const meta = JSON.parse(readFileSync(join(root, session.name, "meta.json"), "utf8"));
      expect(meta.workspace).toBe("C:\\perf\\workspace-0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("transcript at 2000 messages", () => {
  const wire = wireSessionOfSize(SCALE_WORST_CASE.messagesPerSession);
  const loaded = mapLoadedMessages(wire);

  it("maps the wire snapshot to closed cards with 1-based turns", () => {
    expect(loaded).toHaveLength(wire.length);
    const assistant = loaded.filter((m) => m.kind === "assistant");
    expect(assistant.length).toBeGreaterThan(0);
    for (const card of assistant) {
      // History is a snapshot, never the streaming target.
      expect(card.closed).toBe(true);
      expect(card.pending).toBe(false);
    }
    const userTurns = loaded.filter((m) => m.kind === "user").map((m) => m.turn);
    expect(userTurns[0]).toBe(1);
    expect(userTurns.at(-1)).toBe(userTurns.length);
  });

  // Gated: jsdom mount of 2000 rows costs ~19 s and only fails on a blow-up.
  it.skipIf(!PERF_ENABLED)(
    "mounts the whole transcript inside a ceiling only a blow-up breaches",
    () => {
      const started = performance.now();
      const { container } = render(<div className="thread-inner">{transcriptRows(loaded)}</div>);
      const elapsed = performance.now() - started;

      expect(container.querySelectorAll(".thread-row")).toHaveLength(loaded.length);
      // Row order is the transcript order: every user row keeps its own turn number.
      expect(
        [...container.querySelectorAll(".thread-row[data-turn]")].map((el) =>
          el.getAttribute("data-turn"),
        ),
      ).toEqual(loaded.filter((m) => m.kind === "user").map((m) => String(m.turn)));
      // Real prose rendered through react-markdown, not a stub.
      expect(container.querySelectorAll(".markdown").length).toBeGreaterThan(500);
      const nodes = container.querySelectorAll("*").length;
      // Deterministic gate, unlike the clock: the unoptimized shape is ~70k nodes
      // for 2000 messages, and collapsing history cards is what cuts it.
      expect(nodes).toBeGreaterThan(loaded.length);
      expect(nodes).toBeLessThan(120_000);
      console.log(
        `[scale] mount ${loaded.length} messages: ${elapsed.toFixed(0)} ms, ${nodes} DOM nodes`,
      );
      // Blow-up detector only; jsdom timing is far noisier than a real WebView.
      expect(elapsed).toBeLessThan(30_000);
    },
    120_000,
  );

  it("opens exactly one card and grows only that card across 60 flushes", () => {
    const state = baseAppState({ messages: loaded });
    const before = shapeOf(state.messages);
    const tail = loaded.filter((m) => m.kind === "assistant").at(-1)!;
    const tailTurn = tail.kind === "assistant" ? tail.turn : 1;

    let next = state;
    for (let i = 0; i < 60; i++) {
      next = reduce(next, {
        t: "batch_delta",
        items: [{ turn: tailTurn, channel: "content", text: `chunk ${i} ` }],
      });
    }

    // Loaded history is closed, so the first flush opens one fresh card below it
    // and `openAssistantIndex` routes every later chunk into that same card.
    expect(next.messages).toHaveLength(loaded.length + 1);
    expect(shapeOf(next.messages)).toBe(`${before}|a${tailTurn}:text`);
    const tailAfter = next.messages.at(-1)!;
    expect(tailAfter.kind === "assistant" && tailAfter.segments.at(-1)).toMatchObject({
      kind: "text",
      text: expect.stringContaining("chunk 59"),
    });
  });

  it("bumps the structural revision when a card opens, not when text grows", () => {
    const state = baseAppState({ messages: loaded });
    // Loaded history is closed, so the first flush opens a card: structural.
    const opened = reduce(state, {
      t: "batch_delta",
      items: [{ turn: 1, channel: "content", text: "first" }],
    });
    expect(opened.messagesVersion).toBe(state.messagesVersion + 1);

    let next = opened;
    for (let i = 0; i < 60; i++) {
      next = reduce(next, {
        t: "batch_delta",
        items: [{ turn: 1, channel: "content", text: ` ${i}` }],
      });
    }
    // Every later chunk grows the same segment, so nothing structural moved.
    expect(next.messagesVersion).toBe(opened.messagesVersion);
  });

  it("keeps the streaming card out of the memoized history", () => {
    // Nothing is streaming yet, so the memoized history is the whole transcript.
    expect(streamingTailIndex(loaded)).toBe(-1);

    const opened = reduce(baseAppState({ messages: loaded }), {
      t: "batch_delta",
      items: [{ turn: 1, channel: "content", text: "first" }],
    });
    // The card the next token lands in is the last index: the one row a delta changes.
    const tail = streamingTailIndex(opened.messages);
    expect(tail).toBe(opened.messages.length - 1);

    // History plus tail covers the transcript exactly once, in order.
    const history = opened.messages.slice(0, tail);
    expect(history.length + 1).toBe(opened.messages.length);
    expect([...history, opened.messages[tail]]).toEqual(opened.messages);

    // Once the card is sealed it rejoins the memoized history.
    expect(streamingTailIndex(settleTurnMessages(opened.messages))).toBe(-1);
  });

  it("derives the same Events timeline across a text-only delta", () => {
    // The right panel is handed the transcript from the last structural change, so
    // a text-only frame must not be able to change what its Events tab derives.
    const opened = reduce(baseAppState({ messages: loaded }), {
      t: "batch_delta",
      items: [{ turn: 1, channel: "content", text: "first" }],
    });
    const before = sessionEvents(opened.messages, []);
    expect(before.length).toBeGreaterThan(0);

    let next = opened;
    for (let i = 0; i < 60; i++) {
      next = reduce(next, {
        t: "batch_delta",
        items: [{ turn: 1, channel: "content", text: ` ${i}` }],
      });
    }
    expect(sessionEvents(next.messages, [])).toEqual(before);
  });

  it("keeps the persisted-notices array identity across a text-only delta", () => {
    const annotated: UiMessage[] = loaded.map((m, i) =>
      m.kind === "assistant" && i === 3
        ? {
            ...m,
            segments: [
              ...m.segments,
              {
                kind: "warning" as const,
                id: "w-1",
                text: "guard tripped",
                severity: "high" as const,
              },
            ],
          }
        : m,
    );
    const baseline = collectPersistedNotices(annotated);
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toMatchObject({ kind: "warning", id: "w-1", text: "guard tripped" });

    // The first flush opens a card, which is structural, so the list is walked
    // again — but its contents are unchanged, so the array itself is reused.
    const opened = reduce(baseAppState({ messages: annotated }), {
      t: "batch_delta",
      items: [{ turn: 1, channel: "content", text: "a" }],
    });
    const afterOpen = collectPersistedNotices(opened.messages);
    expect(afterOpen).toBe(baseline);

    let next = opened;
    for (let i = 0; i < 60; i++) {
      next = reduce(next, {
        t: "batch_delta",
        items: [{ turn: 1, channel: "content", text: ` ${i}` }],
      });
    }
    // A text-only frame hands the sidecar sync the same array, so it neither
    // re-stringifies the payload nor sends another notices_sync.
    expect(collectPersistedNotices(next.messages)).toBe(afterOpen);
  });
});

describe("history cards", () => {
  const diffText = ["# src/foo.ts", "+added line", "+another", "-removed"].join("\n");
  const segments = [
    { kind: "text" as const, text: "did the work" },
    {
      kind: "tool" as const,
      callId: "c1",
      name: "edit_file",
      args: "{}",
      startedAt: 0,
      durationMs: 1,
      result: diffText,
      ok: true,
    },
    {
      kind: "tool" as const,
      callId: "c2",
      name: "run_command",
      args: JSON.stringify({ command: "npm test" }),
      startedAt: 0,
      durationMs: 1,
      result: "command failed",
      ok: false,
    },
  ];

  const renderCards = (history: boolean | undefined) =>
    render(
      <AssistantMsg
        segments={segments}
        pending={false}
        history={history}
        onApproveConfirm={noop}
        onRejectConfirm={noop}
        onRuleConfirm={noopRule}
        onStopTool={noop}
        pendingConfirms={[]}
      />,
    );

  it("mounts no diff or shell body for a history turn", () => {
    const { container } = renderCards(true);
    // A collapsed card mounts no body at all, so a long transcript carries neither
    // the diff lines nor the command output.
    expect(container.querySelector(".diff")).toBeNull();
    expect(container.querySelector(".shell")).toBeNull();
    expect(container.querySelectorAll('.card[data-open="true"]')).toHaveLength(0);
  });

  it("keeps the live turn expanded, exactly as before", () => {
    const { container } = renderCards(undefined);
    expect(container.querySelector(".diff")).toBeTruthy();
    expect(container.querySelector(".shell")).toBeTruthy();
  });

  it("renders one page of a huge diff behind an explicit expand", () => {
    const big = ["# src/big.ts", ...Array.from({ length: 200 }, (_, i) => `+line ${i}`)].join("\n");
    const first = parseEditResult(big)[0]!;
    const { container } = render(<DiffCard filename={first.filename} lines={first.lines} />);
    expect(container.querySelectorAll(".diff .ln")).toHaveLength(120);
    fireEvent.click(screen.getByRole("button", { name: /Show all 200 lines/ }));
    expect(container.querySelectorAll(".diff .ln")).toHaveLength(200);
  });
});

describe("session paging", () => {
  const carryover = {
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalCompletionTokens: 0,
  };
  const turnOf = (m: UiMessage) => (m.kind === "notice" ? (m.turn ?? 0) : m.turn);

  it("numbers a page's turns from the base the daemon reports", () => {
    const page = wireSessionOfSize(300);
    const ui = mapLoadedMessages(page, 500);
    const users = ui.filter((m) => m.kind === "user").map((m) => m.turn);
    expect(users.length).toBeGreaterThan(0);
    // The page starts mid-conversation; its rows keep absolute turn numbers.
    expect(users[0]).toBe(501);
    expect(users.at(-1)).toBe(500 + users.length);
    expect(ui.filter((m) => m.kind === "assistant").every((m) => m.turn > 500)).toBe(true);
  });

  it("prepends an older page without renumbering what is on screen", () => {
    // Each page's wire turns restart at 1, exactly as buildLoadedMessages builds
    // them; turnBase is what makes them absolute again.
    const onScreenPage = wireSessionOfSize(300);
    const loaded = reduce(baseAppState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "s",
        messages: onScreenPage,
        hasOlder: true,
        turnBase: 500,
        events: [],
        carryover,
      },
    });
    expect(loaded.historyHasOlder).toBe(true);
    expect(loaded.historyLoaded).toBe(300);
    const onScreen = loaded.messages.map(turnOf);

    const older = reduce(loaded, {
      t: "incoming",
      event: {
        type: "$session_history",
        name: "s",
        messages: wireSessionOfSize(300, 11),
        hasOlder: false,
        turnBase: 200,
      },
    });

    expect(older.messages).toHaveLength(600);
    expect(older.historyHasOlder).toBe(false);
    expect(older.historyLoaded).toBe(600);
    // Every row already on screen kept its number, and the newly prepended rows
    // sit strictly above them — which is what keeps Events anchors and rewind
    // mapping pointing at the same turns.
    expect(older.messages.map(turnOf).slice(300)).toEqual(onScreen);
    const prepended = older.messages.map(turnOf).slice(0, 300);
    expect(prepended.length).toBe(300);
    expect(Math.max(...prepended)).toBeLessThan(Math.min(...onScreen));
  });
});
