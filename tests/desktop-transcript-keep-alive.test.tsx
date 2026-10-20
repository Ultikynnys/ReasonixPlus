// @vitest-environment jsdom
// A tab switch used to unmount the transcript, and remounting re-runs remark +
// rehype for every card. The app now keeps the previously visible tab's transcript
// mounted (hidden) instead, so this pins that contract: after focusing another tab,
// the one you just left still has its transcript in the DOM.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../desktop/src/App";

const WS = "C:\\ws";
const handlers = new Map<string, (e: { payload: unknown }) => void>();

async function feed(ev: Record<string, unknown>, tabId?: string) {
  const handler = handlers.get("rpc:event");
  if (!handler) throw new Error("rpc:event handler not registered yet");
  const line = JSON.stringify(tabId ? { ...ev, tabId } : ev);
  await act(async () => {
    handler({ payload: { data: line } });
  });
}

const settle = (ms = 40) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const settings = (model: string) => ({ type: "$settings", workspaceDir: WS, model });

const openTab = (id: string, active: boolean, session: string) =>
  feed(
    {
      type: "$tab_opened",
      workspaceDir: WS,
      active,
      groupId: "g1",
      sessions: [session],
      activeSession: session,
    },
    id,
  );

/** Transcript rows currently mounted. The gate sits INSIDE `.thread-inner`, so that
 *  container exists for every mounted tab and only the rows tell tabs apart. */
const rows = () => document.querySelectorAll(".thread-row").length;

const sessionLoaded = (name: string, text: string) => ({
  type: "$session_loaded",
  name,
  messages: [{ kind: "user", text, ts: 1 }],
  events: [],
  carryover: {
    totalCostUsd: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalCompletionTokens: 0,
  },
});

describe("transcript keep-alive across a tab switch", () => {
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
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) =>
      cmd === "rpc_spawn" ? true : undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps the tab you just left mounted, and mounts a tab you have not seen", async () => {
    render(<App />);
    await settle(60);
    await feed({ type: "$connected" });

    await openTab("t1", true, "A");
    await feed(settings("model-A"), "t1");
    await feed(sessionLoaded("A", "first tab"), "t1");
    await settle();
    expect(rows()).toBe(1);

    // t2 exists but was never visible, so its transcript renders no rows at all.
    await openTab("t2", false, "B");
    await feed(settings("model-B"), "t2");
    await feed(sessionLoaded("B", "second tab"), "t2");
    await settle();
    expect(rows()).toBe(1);

    // Focusing t2 keeps t1's rows in the DOM (hidden) instead of unmounting and
    // re-parsing them the next time the user comes back.
    await openTab("t2", true, "B");
    await settle();
    expect(rows()).toBe(2);

    // Going back adds no third copy: t1 is reused, and t2 takes its turn at being
    // the one that stays mounted.
    await openTab("t1", true, "A");
    await settle();
    expect(rows()).toBe(2);
  });
});
