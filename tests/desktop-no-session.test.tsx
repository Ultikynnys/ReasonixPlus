import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// @vitest-environment jsdom
// Mounts the full App against a mocked Tauri bridge and drives the daemon's
// session events, so the "no sessions" main-area state is exercised end to end.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../desktop/src/App";

const WS = "C:\\ws";
const handlers = new Map<string, (e: { payload: unknown }) => void>();
/** Every command the app pushed to the daemon, in order. */
const sent: Record<string, unknown>[] = [];

async function feed(ev: Record<string, unknown>, tabId?: string) {
  const h = handlers.get("rpc:event");
  if (!h) throw new Error("rpc:event handler not registered yet");
  const line = JSON.stringify(tabId ? { ...ev, tabId } : ev);
  await act(async () => {
    h({ payload: { data: line } });
  });
}

const settle = (ms = 40) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

/** The id the app sent with its most recent `cmd`, which is what the daemon answers. */
function lastRequestId(cmd: "session_delete" | "session_clear" | "new_chat"): string {
  const calls = sent.filter((command) => command.cmd === cmd);
  const id = calls[calls.length - 1]?.requestId;
  if (typeof id !== "string") throw new Error(`no requestId on ${cmd}`);
  return id;
}

/** Boot one active tab bound to session "A" (which has two messages). */
async function startupWithSessionA() {
  await feed({ type: "$connected" });
  await feed({
    type: "$tabs_snapshot",
    tabs: [{ id: "t1", workspaceDir: WS, active: true, groupId: "g1", activeSession: "A" }],
  });
  await feed(
    {
      type: "$tab_opened",
      workspaceDir: WS,
      active: true,
      groupId: "g1",
      sessions: ["A"],
      activeSession: "A",
    },
    "t1",
  );
  await feed(
    {
      type: "$settings",
      reasoningEffort: "medium",
      editMode: "follow",
      quickSendId: "proceed",
      quickSends: [],
      workspaceDir: WS,
      recentWorkspaces: [WS],
      model: "deepseek-v4-flash",
      version: "0.50.1",
    },
    "t1",
  );
  await feed({ type: "$ready" }, "t1");
  await feed(
    {
      type: "$session_loaded",
      name: "A",
      messages: [
        { kind: "user", text: "hello from session A" },
        {
          kind: "assistant",
          turn: 1,
          segments: [{ kind: "text", text: "hi there" }],
          pending: false,
        },
      ],
      carryover: {
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
      },
    },
    "t1",
  );
  await feed(
    {
      type: "$sessions",
      epoch: "e1",
      revision: 1,
      items: [{ name: "A", messageCount: 2, mtime: new Date(1).toISOString() }],
    },
    "t1",
  );
  await settle(30);
}

describe("desktop — no-session main-area state", () => {
  beforeEach(() => {
    handlers.clear();
    sent.length = 0;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
    if (!window.matchMedia) {
      (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      });
    }
    (listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string, cb: (e: { payload: unknown }) => void) => {
        handlers.set(name, cb);
        return () => handlers.delete(name);
      },
    );
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string, args?: { line?: string }) => {
        if (cmd === "rpc_send" && args?.line) sent.push(JSON.parse(args.line));
        return undefined;
      },
    );
    (getCurrentWindow as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      isMaximized: vi.fn(async () => false),
      isFocused: vi.fn(async () => true),
      isVisible: vi.fn(async () => true),
      isMinimized: vi.fn(async () => false),
      listen: vi.fn(async () => () => {}),
      close: vi.fn(),
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      setTitle: vi.fn(),
      onCloseRequested: vi.fn(async () => () => {}),
      onResized: vi.fn(async () => () => {}),
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the thread while a session exists (no false prompt)", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();
    expect(screen.getByText(/hello from session A/)).toBeTruthy();
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
  });

  it("routes a delayed snapshot to the workspace it scanned", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();
    await feed(
      {
        type: "$sessions",
        workspaceDir: "C:\\other",
        epoch: "e1",
        revision: 2,
        items: [{ name: "FOREIGN-SESSION", messageCount: 1, mtime: new Date(2).toISOString() }],
      },
      "t1",
    );
    expect(screen.queryByText("FOREIGN-SESSION")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete session" })).toBeTruthy();
  });

  it("keeps the composer, not a prompt, once the last session is gone", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    // The daemon deletes A and detaches the channel: nothing is bound.
    await feed({ type: "$session_bound", name: "" }, "t1");
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 2,
        items: [],
      },
      "t1",
    );
    await settle(50);

    expect(screen.queryByText(/hello from session A/)).toBeNull();
    // The neutral channel must still be typable: that is where the next session
    // comes from, so no "create a chat first" panel may replace the composer.
    expect(screen.queryByText(/No conversations yet/)).toBeNull();
    const composer = screen.getByPlaceholderText(/Ask the agent/);
    expect(composer).toBeTruthy();
    expect((composer as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("shows a deleting throbber from the optimistic delete until the daemon settles it", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    // Optimistically delete session A through the sidebar confirm popover.
    await act(async () => {
      screen.getByRole("button", { name: "Delete session" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });
    await settle(20);

    // In flight: one indicator, in the main area, and nowhere else.
    expect(screen.getAllByText("Deleting session…")).toHaveLength(1);
    expect(screen.queryByText("Deleting…")).toBeNull();

    // Daemon settles: it detaches the channel and lists no sessions. Only the
    // answer to this delete's own request id may lift the row and the indicator.
    await feed({ type: "$session_bound", name: "" }, "t1");
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 2,
        items: [],
        answers: [{ requestId: lastRequestId("session_delete") }],
      },
      "t1",
    );
    await settle(40);

    expect(screen.queryByText("Deleting…")).toBeNull();
    expect(screen.queryByText("Deleting session…")).toBeNull();
    expect(screen.queryByText(/hello from session A/)).toBeNull();
    expect(screen.getByPlaceholderText(/Ask the agent/)).toBeTruthy();
  });

  it("keeps the row hidden and the throbber running until the delete is answered", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();
    expect(document.querySelectorAll(".session-item")).toHaveLength(1);

    await act(async () => {
      screen.getByRole("button", { name: "Delete session" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Delete" }).click();
    });
    await settle(20);

    // The optimistic hide takes the row off before any snapshot lands.
    expect(document.querySelectorAll(".session-item")).toHaveLength(0);
    expect(screen.getAllByText("Deleting session…")).toHaveLength(1);

    // Another channel's refresh, a turn ending, a tab closing: every one of these
    // lists the session again because the folder is still on disk. None of them is
    // the answer to this delete, so none of them may put the row back.
    for (let revision = 2; revision <= 4; revision += 1) {
      await feed(
        {
          type: "$sessions",
          epoch: "e1",
          revision,
          items: [{ name: "A", messageCount: 2, mtime: new Date(1).toISOString() }],
        },
        "t1",
      );
      await settle(10);
      expect(document.querySelectorAll(".session-item")).toHaveLength(0);
      expect(screen.getAllByText("Deleting session…")).toHaveLength(1);
    }

    // The answer lands: one listing, one verdict, and the list agrees with it.
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 5,
        items: [],
        answers: [{ requestId: lastRequestId("session_delete") }],
      },
      "t1",
    );
    await settle(40);
    expect(screen.queryByText("Deleting session…")).toBeNull();
    expect(document.querySelectorAll(".session-item")).toHaveLength(0);
  });

  it("creates the session from the message typed in the neutral state", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();
    await feed({ type: "$session_bound", name: "" }, "t1");
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 2,
        items: [],
      },
      "t1",
    );
    await settle(40);
    expect(screen.queryByText(/hello from session A/)).toBeNull();

    // Sending from the neutral channel is what brings a session back: the message
    // goes out on the channel that holds nothing, and the daemon mints the session
    // it lands in. (The composer is the typing path and is asserted above; this
    // uses the empty-state suggestion so the assertion is about the send, not about
    // simulated keystrokes.)
    await act(async () => {
      screen.getByText("Review my latest commit changes").click();
    });
    await settle(30);

    const sentUserInput = sent.filter((command) => command.cmd === "user_input");
    expect(sentUserInput).toHaveLength(1);
    expect(sentUserInput[0]).toMatchObject({ text: "Review my latest commit changes" });
    // The echo is visible immediately, before the daemon names the session.
    expect(screen.getByText("Review my latest commit changes")).toBeTruthy();

    // The bind names the session the message created and keeps that transcript.
    await feed({ type: "$session_bound", name: "desktop-20260101120000-3" }, "t1");
    await settle(20);
    expect(screen.getByText("Review my latest commit changes")).toBeTruthy();
  });

  it("surfaces a New-chat creation from the click and seeds the channel from the workspace's sessions", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    // New chat locks the workspace at the CLICK and asks under a request id; nothing
    // the daemon does afterwards is needed to start the indicator.
    await act(async () => {
      document.querySelector<HTMLButtonElement>(".new-btn")!.click();
    });
    await settle(20);

    const newChats = sent.filter((command) => command.cmd === "new_chat");
    expect(newChats).toHaveLength(1);
    expect(typeof newChats[0]!.requestId).toBe("string");

    // Creation is surfaced the same way deletion is: once, in the main area, with no
    // second copy in the sidebar header or the empty-state button.
    expect(screen.getAllByText("Creating session…")).toHaveLength(1);
    expect(screen.queryByText("Creating…")).toBeNull();

    // The daemon opens the fresh channel for the session it minted.
    await feed(
      {
        type: "$tab_opened",
        workspaceDir: WS,
        active: true,
        groupId: "g1",
        sessions: ["B"],
        activeSession: "B",
      },
      "t2",
    );
    await settle(20);

    // The fresh channel seeds its sidebar from the workspace's list, so session A's
    // row never blanks out to "No sessions yet".
    expect(screen.queryByText(/No sessions yet/)).toBeNull();

    // The minted channel's own listing answers the request and carries the session.
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 2,
        items: [
          { name: "B", messageCount: 0, mtime: new Date(2).toISOString() },
          { name: "A", messageCount: 2, mtime: new Date(1).toISOString() },
        ],
        answers: [{ requestId: lastRequestId("new_chat"), created: "B" }],
      },
      "t2",
    );
    await settle(40);

    expect(screen.queryByText("Creating session…")).toBeNull();
    expect(screen.queryByText("Creating…")).toBeNull();
    // The minted session is on screen beside the one that was already there.
    expect(document.querySelectorAll('.session-item[title="B"]').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.session-item[title="A"]').length).toBeGreaterThan(0);
  });

  it("keeps the create indicator through listings that do not answer it", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".new-btn")!.click();
    });
    await settle(20);
    expect(screen.getByText("Creating session…")).toBeTruthy();

    // Two listings that even contain a session nobody in this request asked for: the
    // old rule settled the indicator on exactly this, which is the class of bug that
    // made the UI claim a mint the backend had not confirmed.
    for (let revision = 2; revision <= 3; revision += 1) {
      await feed(
        {
          type: "$sessions",
          epoch: "e1",
          revision,
          items: [
            { name: "B", messageCount: 0, mtime: new Date(2).toISOString() },
            { name: "A", messageCount: 2, mtime: new Date(1).toISOString() },
          ],
        },
        "t1",
      );
      await settle(20);
      expect(screen.getByText("Creating session…")).toBeTruthy();
    }

    // The answer to this request settles it, and names what was minted.
    await feed(
      {
        type: "$sessions",
        epoch: "e1",
        revision: 4,
        items: [
          { name: "B", messageCount: 0, mtime: new Date(2).toISOString() },
          { name: "A", messageCount: 2, mtime: new Date(1).toISOString() },
        ],
        answers: [{ requestId: lastRequestId("new_chat"), created: "B" }],
      },
      "t1",
    );
    await settle(40);
    expect(screen.queryByText("Creating session…")).toBeNull();
  });
});
