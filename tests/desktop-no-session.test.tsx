import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
// @vitest-environment jsdom
// Mounts the full App against a mocked Tauri bridge and drives the daemon's
// session events, so the "no sessions" main-area state is exercised end to end.
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../desktop/src/App";

const WS = "C:\\ws";
const handlers = new Map<string, (e: { payload: unknown }) => void>();

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
        totalCostUsd: 0,
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
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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

  it("swaps the transcript for a create-session prompt once the last session is gone", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    // The daemon deletes A, mints a virtual replacement B, and lists no sessions.
    await feed(
      {
        type: "$session_loaded",
        name: "B",
        messages: [],
        carryover: {
          totalCostUsd: 0,
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
        revision: 2,
        items: [],
        settledDeletes: [{ name: "A", removed: true }],
      },
      "t1",
    );
    await settle(50);

    expect(screen.queryByText(/hello from session A/)).toBeNull();
    expect(screen.getByText(/No conversations yet/)).toBeTruthy();
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

    // In flight — the sidebar reports the daemon work instead of looking dead.
    expect(screen.getByText("Deleting…")).toBeTruthy();
    expect(screen.getByText("Deleting session…")).toBeTruthy();

    // Daemon settles: it mints a virtual replacement and lists no sessions.
    await feed(
      {
        type: "$session_loaded",
        name: "B",
        messages: [],
        carryover: {
          totalCostUsd: 0,
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
        revision: 2,
        items: [],
        settledDeletes: [{ name: "A", removed: true }],
      },
      "t1",
    );
    await settle(40);

    expect(screen.queryByText("Deleting…")).toBeNull();
    expect(screen.queryByText("Deleting session…")).toBeNull();
    expect(screen.getByText(/No conversations yet/)).toBeTruthy();
  });

  it("surfaces a New-chat creation and seeds the channel from the workspace's sessions", async () => {
    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });
    await startupWithSessionA();

    // New chat opens a fresh channel (t2) on the same workspace.
    await feed(
      {
        type: "$tab_opened",
        workspaceDir: WS,
        active: true,
        groupId: "g1",
        sessions: ["B"],
        activeSession: "B",
        creating: true,
      },
      "t2",
    );
    await settle(20);

    // The fresh channel seeds its sidebar from the workspace cache, so session
    // A's row never blanks out to "No sessions yet"...
    expect(screen.queryByText(/No sessions yet/)).toBeNull();
    // ...and creation is surfaced the same way deletion is.
    expect(screen.getByText("Creating session…")).toBeTruthy();
    expect(screen.getByText("Creating…")).toBeTruthy();

    // The channel's first snapshot settles the indicator.
    await feed(
      {
        type: "$sessions",
        epoch: "e2",
        revision: 1,
        items: [
          { name: "A", messageCount: 2, mtime: new Date(1).toISOString() },
          { name: "B", messageCount: 0, mtime: new Date(2).toISOString() },
        ],
      },
      "t2",
    );
    await settle(40);

    expect(screen.queryByText("Creating session…")).toBeNull();
    expect(screen.queryByText("Creating…")).toBeNull();
  });
});
