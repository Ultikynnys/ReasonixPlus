// @vitest-environment jsdom
// Boot contract for the desktop shell: a daemon this app spawned already emitted
// its boot state, so the follow-up resync must not replay every tab (the duplicate
// pass that doubled cold-start work), and the splash must lift on the tab the user
// is actually shown rather than on the last restored tab.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../desktop/src/App";

const WS = "C:\\ws";
const handlers = new Map<string, (e: { payload: unknown }) => void>();
let sent: Array<Record<string, unknown>> = [];
/** What the host reports for `rpc_spawn`: true = this app just created the daemon. */
let spawnedFresh: unknown = true;

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

const resyncs = () => sent.filter((c) => c.cmd === "desktop_resync");
const splash = () => screen.queryByText(/Loading workspaces/);

const settings = (model = "deepseek-v4-flash") => ({
  type: "$settings",
  reasoningEffort: "medium",
  editMode: "follow",
  quickSendId: "proceed",
  quickSends: [],
  workspaceDir: WS,
  recentWorkspaces: [WS],
  model,
  version: "0.50.1",
});

describe("desktop boot — resync and splash gating", () => {
  beforeEach(() => {
    handlers.clear();
    sent = [];
    spawnedFresh = true;
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
    (invoke as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string, args?: { line?: string }) => {
        if (cmd === "rpc_send" && args?.line) {
          sent.push(JSON.parse(args.line) as Record<string, unknown>);
          return undefined;
        }
        if (cmd === "rpc_spawn") return spawnedFresh;
        return undefined;
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("skips the per-tab replay when this app spawned the daemon itself", async () => {
    spawnedFresh = true;
    render(<App />);
    await settle(60);

    expect(resyncs()).toHaveLength(1);
    expect(resyncs()[0]).toEqual({ cmd: "desktop_resync", replay: false });
  });

  it("asks for the full replay when the daemon was already running", async () => {
    spawnedFresh = false;
    render(<App />);
    await settle(60);

    expect(resyncs()).toHaveLength(1);
    expect(resyncs()[0]).toEqual({ cmd: "desktop_resync" });
  });

  it("keeps the full replay when the host reports no spawn result", async () => {
    // An older host binary (or the browser bridge) answers with undefined; the
    // safe default is the replay, since out-of-date hosts may have missed events.
    spawnedFresh = undefined;
    render(<App />);
    await settle(60);

    expect(resyncs()).toHaveLength(1);
    expect(resyncs()[0]).toEqual({ cmd: "desktop_resync" });
  });

  /** Two restored tabs sharing a workspace, t1 focused. */
  async function bootTwoTabs() {
    render(<App />);
    await settle(60);
    await feed({ type: "$connected" });
    await feed({
      type: "$tabs_snapshot",
      tabs: [
        { id: "t1", workspaceDir: WS, active: true, groupId: "g1", activeSession: "A" },
        { id: "t2", workspaceDir: WS, active: false, groupId: "g1", activeSession: "B" },
      ],
    });
    for (const id of ["t1", "t2"]) {
      await feed(
        {
          type: "$tab_opened",
          workspaceDir: WS,
          active: id === "t1",
          groupId: "g1",
          sessions: [id === "t1" ? "A" : "B"],
          activeSession: id === "t1" ? "A" : "B",
        },
        id,
      );
      await feed(settings(), id);
    }
    expect(splash()).toBeTruthy();
  }

  it("lifts the splash on the focused tab while background tabs keep loading", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await bootTwoTabs();

      // Only the focused tab has acked: t2 is still initializing behind it.
      await feed({ type: "$workspace_initialized", revision: 1 }, "t1");
      await settle();

      expect(splash()).toBeNull();
      const reasons = info.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("throbber_dismissed:"));
      expect(reasons.join("\n")).toContain("throbber_dismissed:focused_workspace_initialized");
    } finally {
      info.mockRestore();
    }
  });

  it("keeps the splash up when only a background tab has acked", async () => {
    await bootTwoTabs();

    await feed({ type: "$workspace_initialized", revision: 1 }, "t2");
    await settle();

    expect(splash()).toBeTruthy();
  });
});
