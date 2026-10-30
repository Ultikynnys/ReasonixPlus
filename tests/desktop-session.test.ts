// Consolidated from 12 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import type { LoadedMessage, PersistedNotice } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { reduce } from "../desktop/src/App.js";
import { areWorkspacesLoaded, isWorkspaceRevealReady } from "../desktop/src/workspace-loading";
import * as desktopCommand from "../src/cli/commands/desktop.js";
import {
  WORKSPACE_REMOVE_BLOCKED_MESSAGE,
  WORKSPACE_SWITCH_BLOCKED_MESSAGE,
  adoptableRestoredSession,
  channelServingSession,
  emptySessionCarryover,
  mergeNoticesIntoLoaded,
  newSessionCreationGate,
  newWorkspaceSessionWork,
  normalizeSessionTitle,
  projectKernelEvent,
  sessionCarryover,
  sessionCreationInFlightMessage,
  shouldDeferRestoredBuild,
} from "../src/cli/commands/desktop.js";
import type { PlanSummary } from "../src/code/plans.js";
import { Eventizer } from "../src/core/eventize.js";
import { toPlanHistoryItems } from "../src/desktop/plan-listing.js";
import { toSessionListItems } from "../src/desktop/session-listing.js";
import type { SessionInfo } from "../src/memory/session.js";
import type { ChatMessage } from "../src/types.js";
import { baseAppState } from "./support/app-state.js";

describe("desktop-session-carryover", () => {
  describe("desktop session carryover", () => {
    it("maps persisted metadata through one constructor", () => {
      expect(
        sessionCarryover({
          cacheHitTokens: 10,
          cacheMissTokens: 5,
          totalCompletionTokens: 3,
        }),
      ).toEqual({
        cacheHitTokens: 10,
        cacheMissTokens: 5,
        totalCompletionTokens: 3,
      });
    });

    it("constructs a fresh-session carryover consistently", () => {
      expect(emptySessionCarryover()).toEqual({
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      });
    });

    it("projects a session retraction through the explicit desktop wire boundary", () => {
      const eventizer = new Eventizer();
      const kernelEvent = eventizer.emitSessionRetracted(2, "retry", 4, 2, [
        { role: "user", content: "try again" },
      ]);

      expect(projectKernelEvent(kernelEvent)).toMatchObject({
        type: "session.retracted",
        kind: "retry",
        beforeMessages: 4,
        afterMessages: 2,
        replacementMessages: [{ kind: "user", text: "try again" }],
      });
    });
  });
});

describe("desktop-session-create", () => {
  describe("desktop — one session creation at a time per workspace", () => {
    it("refuses the second half of a double action", () => {
      const gate = newSessionCreationGate();
      expect(gate.begin("/repo/alpha", "a new chat").kind).toBe("claimed");
      const second = gate.begin("/repo/alpha", "a new chat");
      expect(second.kind).toBe("blocked");
      expect(second.kind === "blocked" && second.holder.label).toBe("a new chat");
    });

    it("reopens as soon as the first creation has landed", () => {
      const gate = newSessionCreationGate();
      const claim = gate.begin("/repo/alpha", "a new chat");
      expect(claim.kind).toBe("claimed");
      if (claim.kind === "claimed") claim.release();
      expect(gate.begin("/repo/alpha", "a new chat").kind).toBe("claimed");
    });

    it("only locks the workspace that is creating", () => {
      const gate = newSessionCreationGate();
      const alpha = gate.begin("/repo/alpha", "a new chat");
      const beta = gate.begin("/repo/beta", "a duplicate");
      expect(alpha.kind).toBe("claimed");
      expect(beta.kind).toBe("claimed");
      if (beta.kind === "claimed") beta.release();
      expect(gate.begin("/repo/beta", "a new chat").kind).toBe("claimed");
      // Releasing beta must not release the workspace still minting its session.
      expect(gate.begin("/repo/alpha", "a new chat").kind).toBe("blocked");
    });

    it("treats a relative and an absolute path to the same workspace as one", () => {
      const gate = newSessionCreationGate();
      expect(gate.begin(".", "a new chat").kind).toBe("claimed");
      expect(gate.begin(process.cwd(), "a new chat").kind).toBe("blocked");
    });

    it("names what is opening and how long it has been opening", () => {
      let clock = 0;
      const gate = newSessionCreationGate({ staleAfterMs: 60_000, now: () => clock });
      gate.begin("/repo/alpha", "a duplicated chat");
      clock = 12_000;
      const blocked = gate.begin("/repo/alpha", "a new chat");
      if (blocked.kind !== "blocked") throw new Error("expected the workspace to be held");
      const message = sessionCreationInFlightMessage(blocked.holder);
      expect(message).toMatch(/duplicated chat/);
      expect(message).toMatch(/12 s/);
    });

    it("takes a claim over once it outlives the stale window", () => {
      let clock = 0;
      const gate = newSessionCreationGate({ staleAfterMs: 60_000, now: () => clock });
      const abandoned = gate.begin("/repo/alpha", "a new chat");
      clock = 60_000;
      // The workspace is open again the moment the claim is stale: a creation that
      // never lands must not refuse every later click forever.
      expect(gate.isBusy("/repo/alpha")).toBe(false);
      const takeover = gate.begin("/repo/alpha", "a new chat");
      expect(takeover.kind).toBe("claimed");
      expect(takeover.kind === "claimed" && takeover.tookOver).toBe(true);
      // The abandoned claim settling later must not open its successor's workspace.
      if (abandoned.kind === "claimed") abandoned.release();
      expect(gate.isBusy("/repo/alpha")).toBe(true);
    });

    it("reports a claim inside the stale window as held", () => {
      let clock = 0;
      const gate = newSessionCreationGate({ staleAfterMs: 60_000, now: () => clock });
      expect(gate.begin("/repo/alpha", "a new chat").kind).toBe("claimed");
      clock = 59_999;
      expect(gate.isBusy("/repo/alpha")).toBe(true);
      expect(gate.begin("/repo/alpha", "a new chat").kind).toBe("blocked");
    });
  });
});

describe("desktop-session-load", () => {
  type BuildLoadedMessages = (records: ChatMessage[]) => Array<{
    kind: "assistant" | "user";
    text?: string;
    images?: string[];
    injected?: true;
    segments?: Array<{
      kind: string;
      text?: string;
      args?: string;
      result?: string;
      ok?: boolean;
      model?: string;
    }>;
  }>;

  describe("desktop session loading", () => {
    const buildLoadedMessages = (desktopCommand as { buildLoadedMessages?: BuildLoadedMessages })
      .buildLoadedMessages;

    it("elides old heavy assistant segments before sending $session_loaded", () => {
      expect(typeof buildLoadedMessages).toBe("function");

      const huge = "desktop retained field\n".repeat(900);
      const records: ChatMessage[] = [];
      for (let i = 0; i < 260; i++) {
        records.push({
          role: "assistant",
          content: huge,
          reasoning_content: huge,
          tool_calls: [
            {
              id: `c-${i}`,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: `file-${i}.txt`, content: huge }),
              },
            },
          ],
        });
        records.push({ role: "tool", tool_call_id: `c-${i}`, content: huge });
      }

      const loaded = buildLoadedMessages!(records);
      const firstAssistant = loaded.find((m) => m.kind === "assistant");
      expect(firstAssistant).toBeDefined();
      const reasoning = firstAssistant!.segments!.find((s) => s.kind === "reasoning");
      const text = firstAssistant!.segments!.find((s) => s.kind === "text");
      const tool = firstAssistant!.segments!.find((s) => s.kind === "tool");

      expect(reasoning?.text?.length).toBeLessThan(huge.length / 10);
      expect(text?.text?.length).toBeLessThan(huge.length / 10);
      expect(tool?.args?.length).toBeLessThan(huge.length / 10);
      expect(tool?.result?.length).toBeLessThan(huge.length / 10);
    });

    it("carries each persisted record's model onto its reasoning run", () => {
      const loaded = buildLoadedMessages!([
        { role: "user", content: "go" },
        { role: "assistant", content: "a", reasoning_content: "first", model: "deepseek-v4-flash" },
        { role: "assistant", content: "b", reasoning_content: "second", model: "deepseek-v4-pro" },
        // A record persisted before the stamp existed keeps no model: the card
        // falls back to the transcript's own model instead of inventing one.
        { role: "assistant", content: "c", reasoning_content: "third" },
      ]);
      const reasonings = loaded
        .flatMap((m) => m.segments ?? [])
        .filter((s) => s.kind === "reasoning");
      expect(reasonings.map((s) => s.text)).toEqual(["first", "second", "third"]);
      expect(reasonings.map((s) => s.model)).toEqual([
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        undefined,
      ]);
    });

    it("extracts text + image data URLs from OpenAI user content arrays", () => {
      const records: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "what does this show?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ];
      const loaded = buildLoadedMessages!(records);
      const user = loaded[0];
      expect(user?.kind).toBe("user");
      if (user?.kind === "user") {
        expect(user.text).toBe("what does this show?");
        expect(user.images).toEqual(["data:image/png;base64,AAAA"]);
      }
    });

    it("keeps plain-text user records without an images field", () => {
      const loaded = buildLoadedMessages!([{ role: "user", content: "just text" }]);
      const user = loaded[0];
      expect(user?.kind).toBe("user");
      if (user?.kind === "user") {
        expect(user.text).toBe("just text");
        expect(user.images).toBeUndefined();
      }
    });

    it("flags image-feedback records as injected and keeps their list slot", () => {
      const records: ChatMessage[] = [
        { role: "user", content: "real prompt" },
        {
          role: "user",
          injected: true,
          content: [
            { type: "text", text: "Screen capture (monitor 0): pixels attached" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
        { role: "user", content: "second prompt" },
      ];

      const loaded = buildLoadedMessages!(records);
      // The injected record keeps its slot, so the UI's positional numbering still
      // counts the second real prompt as turn 3.
      expect(loaded.map((m) => (m.kind === "user" ? m.injected === true : null))).toEqual([
        false,
        true,
        false,
      ]);
    });

    it("numbers tool-loop assistant records by their owning user turn", () => {
      const records: ChatMessage[] = [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: "file body" },
        {
          role: "assistant",
          content: "final answer",
        },
        { role: "user", content: "second" },
        { role: "assistant", content: "second answer" },
      ];
      const loaded = buildLoadedMessages!(records);
      // Three assistant records: two for turn 1's tool loop, one for turn 2.
      const assistants = loaded.filter((m) => m.kind === "assistant");
      expect(assistants).toHaveLength(3);
      expect(assistants.map((a) => (a.kind === "assistant" ? a.turn : -1))).toEqual([1, 1, 2]);
      // Tool results stay attached to their declaring record.
      const firstRecord = assistants[0];
      if (firstRecord?.kind !== "assistant") throw new Error("expected assistant");
      const toolSeg = firstRecord.segments.find((s) => s.kind === "tool");
      if (toolSeg?.kind !== "tool") throw new Error("expected tool segment");
      expect(toolSeg.result).toBe("file body");
      const users = loaded.filter((m) => m.kind === "user");
      expect(users).toHaveLength(2);
    });

    it("settles a tool call interrupted before its result was persisted", () => {
      const loaded = buildLoadedMessages!([
        { role: "user", content: "run it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "interrupted-call",
              type: "function",
              function: { name: "run_command", arguments: '{"command":"long task"}' },
            },
          ],
        },
      ]);

      const assistant = loaded.find((message) => message.kind === "assistant");
      const tool = assistant?.segments?.find((segment) => segment.kind === "tool");
      expect(tool).toMatchObject({
        result: "Tool call interrupted before a result was recorded.",
        ok: false,
      });
    });

    it("keeps a completed tool call settled with its persisted result", () => {
      const loaded = buildLoadedMessages!([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "completed-call",
              type: "function",
              function: { name: "run_command", arguments: '{"command":"quick task"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "completed-call", content: "finished" },
      ]);

      const assistant = loaded.find((message) => message.kind === "assistant");
      const tool = assistant?.segments?.find((segment) => segment.kind === "tool");
      expect(tool).toMatchObject({ result: "finished", ok: true });
    });

    it("drops synthetic user records — steers and nudges never start a turn or render", () => {
      const records: ChatMessage[] = [
        { role: "user", content: "real one" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "mid-turn steer text", synthetic: true },
        { role: "assistant", content: "answer two" },
        { role: "user", content: "real two" },
      ];
      const loaded = buildLoadedMessages!(records);
      const kinds = loaded.map((m) => m.kind);
      expect(kinds).toEqual(["user", "assistant", "assistant", "user"]);
      const texts = loaded.map((m) => (m.kind === "user" ? m.text : ""));
      expect(texts).not.toContain("mid-turn steer text");
    });

    it("keeps a failed turn's user record as its own turn (no assistant reply)", () => {
      const records: ChatMessage[] = [
        { role: "user", content: "one" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "failed prompt" },
        { role: "user", content: "three" },
      ];
      const loaded = buildLoadedMessages!(records);
      expect(loaded).toHaveLength(4);
      const users = loaded.filter((m) => m.kind === "user");
      expect(users).toHaveLength(3);
      expect(users.map((m) => (m.kind === "user" ? m.text : ""))).toEqual([
        "one",
        "failed prompt",
        "three",
      ]);
    });

    it("maps an assistant generated-image content part to an image segment", () => {
      const records: ChatMessage[] = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "here you go" },
            { type: "image", data_url: "data:image/jpeg;base64,AAAA", mime_type: "image/jpeg" },
          ],
        },
      ];
      const loaded = buildLoadedMessages!(records);
      const assistant = loaded[0];
      expect(assistant?.kind).toBe("assistant");
      if (assistant?.kind === "assistant") {
        expect(assistant.segments).toEqual([
          { kind: "text", text: "here you go" },
          { kind: "image", dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" },
        ]);
      }
    });
  });
});

describe("desktop-session-notices", () => {
  describe("mergeNoticesIntoLoaded — persisted annotation cards", () => {
    const base: LoadedMessage[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", turn: 1, segments: [{ kind: "text", text: "hello" }], pending: false },
      { kind: "user", text: "again" },
      { kind: "assistant", turn: 2, segments: [{ kind: "text", text: "world" }], pending: false },
    ];

    it("returns the transcript unchanged when there are no persisted cards", () => {
      expect(mergeNoticesIntoLoaded(base, [])).toBe(base);
    });

    it("slots a notice at the START of its turn's group, above that turn's reply", () => {
      const notices: PersistedNotice[] = [
        { id: "n1", kind: "notice", text: "Mode: AUTO", severity: "info", turn: 2 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices);
      expect(out.map((m) => m.kind)).toEqual(["user", "assistant", "user", "notice", "assistant"]);
      expect(out[3]).toMatchObject({ kind: "notice", id: "n1", text: "Mode: AUTO", turn: 2 });
    });

    it("keeps a turn's notices in append order, right after its user message", () => {
      const notices: PersistedNotice[] = [
        { id: "n1", kind: "notice", text: "one", severity: "info", turn: 1 },
        { id: "n2", kind: "notice", text: "two", severity: "warning", turn: 1 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices);
      expect(out.map((m) => (m.kind === "notice" ? m.text : m.kind))).toEqual([
        "user",
        "one",
        "two",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("drops a turn-0 notice at the very start of the transcript", () => {
      const notices: PersistedNotice[] = [
        { id: "n0", kind: "notice", text: "boot", severity: "info", turn: 0 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices);
      expect(out[0]).toMatchObject({ kind: "notice", id: "n0" });
    });

    it("re-attaches a warning segment to its turn's assistant card (no extra card)", () => {
      const notices: PersistedNotice[] = [
        { id: "w1", kind: "warning", text: "degeneration", severity: "high", turn: 1 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices);
      const assistant = out[1];
      expect(out).toHaveLength(base.length);
      expect(assistant?.kind === "assistant" ? assistant.segments.at(-1) : undefined).toMatchObject(
        {
          kind: "warning",
          id: "w1",
          severity: "high",
        },
      );
      // The caller's array is never mutated.
      expect(base[1]?.kind === "assistant" && base[1].segments).toHaveLength(1);
    });

    it("falls back to the tail when a notice's turn has no loaded home", () => {
      const notices: PersistedNotice[] = [
        { id: "n9", kind: "notice", text: "orphan", severity: "error", turn: 9 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices);
      expect(out.at(-1)).toMatchObject({ kind: "notice", id: "n9" });
    });

    it("rebases a card whose absolute turn exceeds the reconstructed user count", () => {
      // Live turns are absolute kernel ordinals; after a fold the transcript is
      // renumbered from 1, so turn 5 lands on the 2nd (last) surviving user.
      const notices: PersistedNotice[] = [
        { id: "n5", kind: "notice", text: "recent", severity: "success", turn: 5 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices, 5);
      expect(out.map((m) => (m.kind === "notice" ? m.text : m.kind))).toEqual([
        "user",
        "assistant",
        "user",
        "recent",
        "assistant",
      ]);
      const placed = out.find((m) => m.kind === "notice");
      expect(placed && placed.kind === "notice" ? placed.turn : undefined).toBe(2);
    });

    it("drops a card for a turn removed by a truncation (rebased to <= 0)", () => {
      const notices: PersistedNotice[] = [
        { id: "n3", kind: "notice", text: "gone", severity: "info", turn: 3 },
        { id: "n5", kind: "notice", text: "kept", severity: "info", turn: 5 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices, 5);
      const texts = out
        .filter((m) => m.kind === "notice")
        .map((m) => (m.kind === "notice" ? m.text : ""));
      expect(texts).toEqual(["kept"]);
    });

    it("does not rebase when the transcript already numbers every turn", () => {
      const notices: PersistedNotice[] = [
        { id: "n2", kind: "notice", text: "in-range", severity: "info", turn: 2 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices, 2);
      expect(out.at(-2)).toMatchObject({ kind: "notice", text: "in-range", turn: 2 });
    });

    it("drops an exact duplicate card for the same turn", () => {
      const notices: PersistedNotice[] = [
        { id: "a", kind: "notice", text: "Task complete", severity: "success", turn: 2 },
        { id: "b", kind: "notice", text: "Task complete", severity: "success", turn: 2 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices, 2);
      const dupes = out.filter((m) => m.kind === "notice" && m.text === "Task complete");
      expect(dupes).toHaveLength(1);
    });

    it("rebases a warning's absolute turn onto its reconstructed assistant card", () => {
      const notices: PersistedNotice[] = [
        { id: "w5", kind: "warning", text: "degeneration", severity: "high", turn: 5 },
      ];
      const out = mergeNoticesIntoLoaded(base, notices, 5);
      expect(out).toHaveLength(base.length);
      const assistant = out[3];
      expect(assistant?.kind === "assistant" ? assistant.segments.at(-1) : undefined).toMatchObject(
        {
          kind: "warning",
          id: "w5",
        },
      );
    });
  });
});

describe("desktop-session-prime", () => {
  // Priming is now subordinate on the wire (`$sessions.primed`), so it never needs a
  // "did the cache match the scan?" comparison: the client ignores a primed payload
  // once a workspace is confirmed. What still matters here is the projection itself.
  function session(name: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      name,
      path: `C:\\sessions\\${name}`,
      size: 10,
      messageCount: 2,
      mtime: new Date("2026-01-02T03:04:05.000Z"),
      meta: {
        workspace: "C:\\ws",
        summary: "Title",
        updatedAt: 1_700_000_000_000,
        createdAt: 1_600_000_000_000,
      },
      createdAt: 1_600_000_000_000,
      lastActive: 1_700_000_000_000,
      workspaceStatus: "matched",
      ...overrides,
    };
  }

  describe("session list projection", () => {
    it("projects sessions onto exactly the fields the sidebar renders", () => {
      const [item] = toSessionListItems([session("one")]);
      expect(item).toEqual({
        name: "one",
        messageCount: 2,
        mtime: "2026-01-02T03:04:05.000Z",
        updatedAt: 1_700_000_000_000,
        createdAt: 1_600_000_000_000,
        summary: "Title",
        workspaceStatus: "matched",
      });
      // Not a leak of the daemon-side record: paths, sizes and whole meta stay out.
      expect(Object.keys(item ?? {}).sort()).toEqual([
        "createdAt",
        "messageCount",
        "mtime",
        "name",
        "summary",
        "updatedAt",
        "workspaceStatus",
      ]);
    });

    it("carries the meta stamps the sidebar sorts and labels by", () => {
      const [item] = toSessionListItems([
        session("one", {
          createdAt: 1_600_000_000_001,
          lastActive: 1_700_000_000_009,
          meta: {
            workspace: "C:\\ws",
            summary: "Title",
            updatedAt: 1_700_000_000_005,
            createdAt: 1_600_000_000_000,
          },
        }),
      ]);
      // Creation drives the order, meta.updatedAt the relative label.
      expect(item?.createdAt).toBe(1_600_000_000_001);
      expect(item?.updatedAt).toBe(1_700_000_000_005);
      // `lastActive` is a daemon-side record field and never crosses the wire.
      expect(item === undefined || "lastActive" in item).toBe(false);
    });
  });
});

describe("desktop-session-rename", () => {
  describe("normalizeSessionTitle", () => {
    it("trims surrounding whitespace and collapses internal runs", () => {
      expect(normalizeSessionTitle("  hello   world  ")).toBe("hello world");
    });

    it("returns empty string for whitespace-only input — caller treats as clear", () => {
      expect(normalizeSessionTitle("   \n\t  ")).toBe("");
    });

    it("caps at 200 characters", () => {
      const long = "x".repeat(500);
      expect(normalizeSessionTitle(long)).toHaveLength(200);
    });

    it("preserves CJK without truncating below the cap", () => {
      expect(normalizeSessionTitle("我的会话")).toBe("我的会话");
    });
  });
});

describe("desktop-session-workspace-binding", () => {
  // The reported bug: a `local`-workspace tab held a session that its own meta
  // stamped to another workspace, so clicking that session in its real workspace
  // re-focused the local tab instead (six times in the user's diagnostics log).
  const LOCAL = "/proj/local";
  const PROJECT = "/proj";

  /** Inject the matcher so the rule is testable on any platform (the default
   *  resolver normalizes real filesystem paths). */
  const sameDir = (a: string, b: string) => a === b;

  describe("channelServingSession — a session is served only by its own workspace", () => {
    it("ignores a channel holding the session from another workspace", () => {
      const channels = [
        { id: "t590", currentSession: "desktop-1", rootDir: LOCAL },
        { id: "t594", currentSession: "desktop-2", rootDir: PROJECT },
      ];
      expect(channelServingSession(channels, "desktop-1", PROJECT, sameDir)).toBeUndefined();
      expect(channelServingSession(channels, "desktop-1", LOCAL, sameDir)?.id).toBe("t590");
    });

    it("still finds the channel when the session is open where it belongs", () => {
      const channels = [
        { id: "t1", currentSession: "desktop-1", rootDir: PROJECT },
        { id: "t2", currentSession: "desktop-2", rootDir: PROJECT },
      ];
      expect(channelServingSession(channels, "desktop-2", PROJECT, sameDir)?.id).toBe("t2");
    });

    it("returns nothing for a session no channel holds", () => {
      const channels = [{ id: "t1", currentSession: "desktop-1", rootDir: PROJECT }];
      expect(channelServingSession(channels, "desktop-9", PROJECT, sameDir)).toBeUndefined();
    });

    it("normalizes the paths with its default matcher", () => {
      // The default matcher is the daemon's own comparison, so a trailing or
      // duplicated separator must not make an owned session look foreign.
      const channels = [{ id: "t1", currentSession: "desktop-1", rootDir: "/proj" }];
      expect(channelServingSession(channels, "desktop-1", "/proj/")?.id).toBe("t1");
      expect(channelServingSession(channels, "desktop-1", "/proj//")?.id).toBe("t1");
      expect(channelServingSession(channels, "desktop-1", "/other")?.id).toBeUndefined();
    });
  });

  describe("adoptableRestoredSession — restore never resurrects a foreign binding", () => {
    const deps = {
      exists: (name: string) => name !== "deleted",
      // Undefined = the session predates workspace stamps.
      workspaceOf: (name: string) =>
        name === "foreign" ? LOCAL : name === "legacy" ? undefined : PROJECT,
    };

    it("adopts a session this workspace owns", () => {
      expect(adoptableRestoredSession("owned", PROJECT, deps)).toBe("owned");
    });

    it("refuses a session another workspace owns", () => {
      // Adopting it again would re-persist the crossed pair on every boot.
      expect(adoptableRestoredSession("foreign", PROJECT, deps)).toBeUndefined();
    });

    it("adopts an unstamped legacy session", () => {
      // Pre-workspace-stamp sessions are claimed by the tab that loads them.
      expect(adoptableRestoredSession("legacy", PROJECT, deps)).toBe("legacy");
    });

    it("refuses a session that no longer exists", () => {
      expect(adoptableRestoredSession("deleted", PROJECT, deps)).toBeUndefined();
      expect(adoptableRestoredSession(undefined, PROJECT, deps)).toBeUndefined();
    });
  });
});

describe("desktop-sidebar-workspace-scope", () => {
  // The session list is keyed by workspace in the store, so a channel can no longer
  // hold another workspace's rows. What the reducer still owes on a workspace change
  // is the transcript: a real switch resets it, a separator-only difference must not.
  const WS_A = "C:\\proj";
  const WS_B = "C:\\proj\\local";

  function seededState(workspaceDir: string) {
    return baseAppState({
      currentSession: "desktop-A",
      messages: [{ kind: "user" as const, text: "hi" }],
      settings: {
        reasoningEffort: "high",
        editMode: "follow",
        workspaceDir,
        recentWorkspaces: [workspaceDir],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    });
  }

  const settingsEvent = (workspaceDir: string) => ({
    type: "$settings" as const,
    reasoningEffort: "high" as const,
    editMode: "follow" as const,
    quickSendId: "proceed",
    quickSends: [],
    workspaceDir,
    recentWorkspaces: [workspaceDir],
    model: "deepseek-v4-flash",
    version: "0.50.1",
  });

  describe("$settings — a workspace switch resets the transcript", () => {
    it("clears the transcript when the workspace actually changes", () => {
      const next = reduce(seededState(WS_A), { t: "incoming", event: settingsEvent(WS_B) });
      expect(next.messages).toEqual([]);
      expect(next.settings?.workspaceDir).toBe(WS_B);
    });

    it("does not treat a separator-only difference as a workspace change", () => {
      // The daemon re-emits settings freely; a trailing slash must not wipe the thread.
      const state = seededState(WS_A);
      const next = reduce(state, { t: "incoming", event: settingsEvent(`${WS_A}\\`) });
      expect(next.messages).toEqual(state.messages);
    });
  });
});

describe("desktop-workspace-loading", () => {
  describe("desktop workspace loading lifecycle", () => {
    it("waits for every workspace UI to acknowledge initialization", () => {
      const expected = new Set(["tab-a", "tab-b"]);

      expect(areWorkspacesLoaded(expected, new Set())).toBe(false);
      expect(areWorkspacesLoaded(expected, new Set(["tab-a"]))).toBe(false);
      expect(areWorkspacesLoaded(expected, new Set(["tab-a", "tab-b"]))).toBe(true);
    });

    it("does not complete before the tabs snapshot defines the expected workspaces", () => {
      expect(areWorkspacesLoaded(null, new Set(["tab-a"]))).toBe(false);
    });

    it("allows an empty authoritative workspace snapshot to complete", () => {
      expect(areWorkspacesLoaded(new Set(), new Set())).toBe(true);
    });

    it("reveals the shell as soon as the focused tab acknowledges", () => {
      const expected = new Set(["tab-a", "tab-b", "tab-c"]);
      const initialized = new Set(["tab-b", "tab-c"]);

      expect(isWorkspaceRevealReady(expected, initialized, "tab-b")).toBe(true);
      expect(isWorkspaceRevealReady(expected, initialized, "tab-c")).toBe(true);
      expect(isWorkspaceRevealReady(expected, initialized, "tab-a")).toBe(false);
    });

    it("keeps waiting for every tab when no focused tab is known", () => {
      const expected = new Set(["tab-a", "tab-b"]);

      expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), null)).toBe(false);
      expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), "")).toBe(false);
      expect(isWorkspaceRevealReady(expected, new Set(["tab-a", "tab-b"]), null)).toBe(true);
    });

    it("ignores a focused id the snapshot does not describe", () => {
      const expected = new Set(["tab-a"]);

      expect(isWorkspaceRevealReady(expected, new Set(), "gone-tab")).toBe(false);
      expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), "gone-tab")).toBe(true);
    });

    it("never reveals before the tabs snapshot defines the expected workspaces", () => {
      expect(isWorkspaceRevealReady(null, new Set(["tab-a"]), "tab-a")).toBe(false);
    });
  });
});

describe("desktop-workspace-lock", () => {
  describe("desktop — a workspace busy with session work", () => {
    it("stays busy until every booking is released", () => {
      const work = newWorkspaceSessionWork();
      const first = work.begin("/repo/alpha");
      work.begin("/repo/alpha");
      expect(work.isBusy("/repo/alpha")).toBe(true);

      first();
      expect(work.isBusy("/repo/alpha")).toBe(true);
    });

    it("cannot be released twice out from under another booking", () => {
      // A double release must be a no-op for ITS booking: with a bare refcount the
      // second call would drop the other channel's live booking to zero and let a
      // workspace switch through mid-clear.
      const work = newWorkspaceSessionWork();
      const alpha = work.begin("/repo/alpha");
      work.begin("/repo/alpha");

      alpha();
      alpha();
      expect(work.isBusy("/repo/alpha")).toBe(true);
    });

    it("only marks the workspace that booked work", () => {
      const work = newWorkspaceSessionWork();
      const alpha = work.begin("/repo/alpha");
      expect(work.isBusy("/repo/beta")).toBe(false);
      alpha();
      expect(work.isBusy("/repo/alpha")).toBe(false);
    });

    it("treats a relative and an absolute path to one workspace as the same booking", () => {
      const work = newWorkspaceSessionWork();
      const release = work.begin(process.cwd());
      expect(work.isBusy(".")).toBe(true);
      release();
      expect(work.isBusy(".")).toBe(false);
    });

    it("counts a creation as work in the workspace the switch would leave", () => {
      const gate = newSessionCreationGate();
      expect(gate.isBusy("/repo/alpha")).toBe(false);
      const claim = gate.begin("/repo/alpha", "a new chat");
      expect(gate.isBusy("/repo/alpha")).toBe(true);
      if (claim.kind === "claimed") claim.release();
      expect(gate.isBusy("/repo/alpha")).toBe(false);
    });

    it("ships refusals that name the wait", () => {
      expect(WORKSPACE_SWITCH_BLOCKED_MESSAGE).toMatch(/created or deleted/i);
      expect(WORKSPACE_REMOVE_BLOCKED_MESSAGE).toMatch(/creating or deleting/i);
    });
  });
});

// Desktop plan projection — the stored claim only reaches the wire as an owner
// *  while the plan is still being worked.
describe("desktop-plan-listing", () => {
  function summary(status: string, session?: string): PlanSummary {
    const plan = {
      id: `plan-${status}-${session ?? "none"}`,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      totalSteps: 2,
      completedSteps: 0,
    } as PlanSummary;
    if (session) plan.claim = { session, pid: 1, since: "2026-01-01T00:00:00.000Z" };
    return plan;
  }

  describe("toPlanHistoryItems", () => {
    it("projects the owner of a plan a session is still working", () => {
      const [active, proposed] = toPlanHistoryItems([
        summary("active", "session-a"),
        summary("proposed", "session-b"),
      ]);
      expect(active?.ownerSession).toBe("session-a");
      expect(proposed?.ownerSession).toBe("session-b");
    });

    it("never projects an owner for a closed plan, whatever claim it carries", () => {
      const items = toPlanHistoryItems(
        ["completed", "cancelled", "abandoned", "superseded", "refinement_requested"].map(
          (status) => summary(status, "session-a"),
        ),
      );
      expect(items.map((item) => item.ownerSession)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      // The internal claim is stripped either way, so no surface can re-derive one.
      expect(items.every((item) => !("claim" in item))).toBe(true);
    });

    it("leaves an in-flight plan unowned when no session claimed it", () => {
      const [item] = toPlanHistoryItems([summary("active")]);
      expect(item?.ownerSession).toBeUndefined();
      expect(item?.status).toBe("active");
    });
  });
});

describe("desktop-boot-deferral", () => {
  describe("restored channel toolset deferral", () => {
    it("defers a restored channel the user is not looking at", () => {
      expect(shouldDeferRestoredBuild({ restored: true, focused: false })).toBe(true);
      expect(shouldDeferRestoredBuild({ restored: true, focused: false, active: false })).toBe(
        true,
      );
    });

    it("builds the focused channel now", () => {
      expect(shouldDeferRestoredBuild({ restored: true, focused: true })).toBe(false);
    });

    it("builds the channel the previous run had active", () => {
      expect(shouldDeferRestoredBuild({ restored: true, focused: false, active: true })).toBe(
        false,
      );
    });

    it("never defers a fresh tab, which has nothing to restore", () => {
      expect(shouldDeferRestoredBuild({ restored: false, focused: false })).toBe(false);
    });

    it("builds a channel holding an MCP setup picker, which lists servers", () => {
      expect(
        shouldDeferRestoredBuild({ restored: true, focused: false, mcpSetupPending: true }),
      ).toBe(false);
    });
  });
});
