// @vitest-environment jsdom
// Mounts the full App against a mocked Tauri bridge: the header's Duplicate button must
// raise the SAME centered capability dialog the session-start gate uses, pre-filled with
// what this chat runs with, and hand the daemon the set the user confirmed.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../desktop/src/App";

const WS = "C:\\ws";
const handlers = new Map<string, (e: { payload: unknown }) => void>();
/** Every command the app pushed to the daemon, in order. */
const sent: Record<string, unknown>[] = [];

const rows = [
  { name: "playwright", enabled: true, builtin: true },
  { name: "ghidra", enabled: false, builtin: false },
];

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

/** One active tab on session "A", which has a transcript and two configured servers. */
async function boot(capabilityPrefill = rows, subagents = false) {
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
      subagents,
      capabilityPrefill,
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
      carryover: { cacheHitTokens: 0, cacheMissTokens: 0, totalCompletionTokens: 0 },
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

function openDuplicate(): HTMLElement {
  fireEvent.click(screen.getByTitle("Duplicate session"));
  return screen.getByRole("dialog", { name: "Duplicate session" });
}

describe("desktop — Duplicate capability dialog", () => {
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

  it("raises the same centered, backdrop-dimmed dialog the session gate uses", async () => {
    render(<App />);
    await settle();
    await boot();

    const dialog = openDuplicate();
    // One modal: same overlay, same card, same dimmed backdrop the New chat gate shows.
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.querySelector(".mcp-setup-card")).toBeTruthy();
    expect((dialog as HTMLElement).style.position).toBe("fixed");
    expect((dialog as HTMLElement).style.inset).toBe("0px");
    expect((dialog as HTMLElement).style.background).toContain("rgba");
  });

  it("pre-fills the switches from what this chat runs with", async () => {
    render(<App />);
    await settle();
    await boot(rows, true);

    const dialog = openDuplicate();
    expect(
      within(dialog).getByRole("switch", { name: "playwright" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(dialog).getByRole("switch", { name: "ghidra" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      within(dialog).getByRole("switch", { name: "Subagents" }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("sends the confirmed server set and subagent flag, then closes", async () => {
    render(<App />);
    await settle();
    await boot();

    const dialog = openDuplicate();
    fireEvent.click(within(dialog).getByRole("switch", { name: "ghidra" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    // sendRpc queues on the tab's rpc chain, so the command lands a microtask later.
    await settle();

    const duplicate = sent.find((msg) => msg.cmd === "duplicate_session");
    expect(duplicate).toBeDefined();
    expect((duplicate?.enabled as string[]).slice().sort()).toEqual(["ghidra", "playwright"]);
    expect(duplicate?.subagents).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Duplicate session" })).toBeNull();
  });

  it("closes without duplicating when dismissed", async () => {
    render(<App />);
    await settle();
    await boot();

    const dialog = openDuplicate();
    fireEvent.click(within(dialog).getByLabelText("Back"));

    expect(screen.queryByRole("dialog", { name: "Duplicate session" })).toBeNull();
    expect(sent.some((msg) => msg.cmd === "duplicate_session")).toBe(false);
  });

  it("says so plainly when no MCP server is configured", async () => {
    render(<App />);
    await settle();
    await boot([]);

    const dialog = openDuplicate();
    expect(within(dialog).getByText(/No MCP servers configured/)).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "Subagents" })).toBeTruthy();
  });
});
