// @vitest-environment jsdom
// Consolidated from 5 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../desktop/src/App";
import { restoreAbortedDraft } from "../desktop/src/abort-draft";
import { createComposerDraft } from "../desktop/src/ui/composer-draft";
import { StuckLabel } from "../desktop/src/ui/live";
import { StartupFailure, coerceStartupFailure } from "../desktop/src/ui/startup-failure";
import { StartupLoadingOverlay } from "../desktop/src/ui/startup-loading";

describe("desktop-composer-draft", () => {
  afterEach(cleanup);

  describe("composer draft isolation", () => {
    it("updates the input without rerendering its conversation parent", () => {
      const parentRender = vi.fn();
      const sent = vi.fn();
      const store = createComposerDraft();
      function Input() {
        const draft = useSyncExternalStore(store.subscribe, store.getSnapshot);
        return (
          <textarea
            aria-label="draft"
            value={draft}
            onChange={(event) => store.setDraft(event.target.value)}
          />
        );
      }
      function Conversation() {
        parentRender();
        const [, setTick] = useState(0);
        return (
          <>
            <Input />
            <button type="button" onClick={() => sent(store.getSnapshot())}>
              Send
            </button>
            <button type="button" onClick={() => setTick((tick) => tick + 1)}>
              Update
            </button>
          </>
        );
      }
      const view = render(<Conversation />);
      for (const value of ["a", "ab", "abc", "abc\nlong draft"]) {
        fireEvent.change(view.getByLabelText("draft"), { target: { value } });
      }
      expect(parentRender).toHaveBeenCalledTimes(1);
      fireEvent.click(view.getByText("Send"));
      expect(sent).toHaveBeenCalledWith("abc\nlong draft");
      fireEvent.click(view.getByText("Update"));
      expect((view.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("abc\nlong draft");
      act(() => store.setDraft(""));
      expect((view.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("");
    });

    it("applies functional attachments and replacements to the latest text synchronously", () => {
      const store = createComposerDraft();
      store.setDraft("typed");
      store.setDraft((current) => `${current} file.ts`);
      store.setDraft((current) => `${current} voice`);
      expect(store.getSnapshot()).toBe("typed file.ts voice");
      expect(restoreAbortedDraft(store.getSnapshot(), "sent text")).toBeNull();
      for (const restored of ["queued text", "retry text", "history text", ""]) {
        store.setDraft(restored);
        expect(store.getSnapshot()).toBe(restored);
      }
    });

    it("notifies only for changes and stops notifying after unsubscribe", () => {
      const store = createComposerDraft();
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      store.setDraft("text");
      store.setDraft("text");
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      store.setDraft("");
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("desktop-startup-failure", () => {
  describe("desktop startup failure screen (#1752)", () => {
    it("renders backend startup failures instead of leaving the window blank", () => {
      const retry = vi.fn();
      render(<StartupFailure details={["spawn: dist/cli/index.js not found"]} onRetry={retry} />);

      expect(screen.getByRole("alert").textContent).toContain("Reasonix+ could not start");
      expect(screen.getByText("spawn: dist/cli/index.js not found")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it("keeps the original error and recent stderr lines for diagnosis", () => {
      expect(coerceStartupFailure(new Error("spawn failed"), ["stderr a", "stderr b"])).toEqual({
        details: ["spawn failed", "stderr a", "stderr b"],
      });
    });
  });
});

describe("desktop-startup-loading", () => {
  describe("desktop startup loading overlay", () => {
    afterEach(() => {
      cleanup();
    });

    it("renders a throbber overlay with accessible status role and theme spinner", () => {
      render(<StartupLoadingOverlay />);

      const overlay = screen.getByRole("status");
      expect(overlay).toBeTruthy();
      expect(overlay.classList.contains("startup-loading-overlay")).toBe(true);
      expect(screen.getByText("Loading workspaces…")).toBeTruthy();
      expect(screen.getByText("Restoring sessions and workspace state…")).toBeTruthy();
      const spinner = overlay.querySelector(".startup-loading-spinner");
      expect(spinner).toBeTruthy();
      expect(spinner?.classList.contains("spin")).toBe(true);
    });

    it("suppresses mouse click and mousedown events", () => {
      render(<StartupLoadingOverlay />);
      const overlay = screen.getByRole("status");

      const downEvt = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      overlay.dispatchEvent(downEvt);
      expect(downEvt.defaultPrevented).toBe(true);

      const clickEvt = new MouseEvent("click", { bubbles: true, cancelable: true });
      overlay.dispatchEvent(clickEvt);
      expect(clickEvt.defaultPrevented).toBe(true);
    });
  });
});

describe("desktop-stuck-label", () => {
  afterEach(cleanup);

  describe("StuckLabel", () => {
    it("shows nothing while the turn is quiet below the threshold, then appears without re-rendering its parent every tick", () => {
      vi.useFakeTimers();
      const base = Date.now();
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(base);
      const parentRender = vi.fn();
      function Conversation() {
        parentRender();
        const [busy, setBusy] = useState(true);
        return (
          <>
            <StuckLabel
              active={busy}
              sinceMs={base}
              afterSec={30}
              render={(sec) => <span>stuck {sec}s</span>}
            />
            <button type="button" onClick={() => setBusy(false)}>
              stop
            </button>
          </>
        );
      }
      render(<Conversation />);
      expect(screen.queryByText(/stuck/)).toBeNull();
      expect(parentRender).toHaveBeenCalledTimes(1);

      // 29 quiet seconds: still hidden, parent never re-rendered.
      dateSpy.mockReturnValue(base + 29_000);
      act(() => vi.advanceTimersByTime(29_000));
      expect(screen.queryByText(/stuck/)).toBeNull();
      expect(parentRender).toHaveBeenCalledTimes(1);

      // Crossing 30s flips the label once; further ticks mutate the seconds
      // without any additional parent render.
      dateSpy.mockReturnValue(base + 31_000);
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByText(/stuck 31s/)).toBeTruthy();
      const rendersAfterShow = parentRender.mock.calls.length;
      dateSpy.mockReturnValue(base + 35_000);
      act(() => vi.advanceTimersByTime(4_000));
      expect(parentRender.mock.calls.length).toBe(rendersAfterShow);

      // Turn end hides the label.
      act(() => {
        fireEvent.click(screen.getByText("stop"));
        vi.advanceTimersByTime(1_000);
      });
      expect(screen.queryByText(/stuck/)).toBeNull();
      dateSpy.mockRestore();
      vi.useRealTimers();
    });
  });
});

// // A tab switch used to unmount the transcript, and remounting re-runs remark +
// // rehype for every card. The app now keeps the previously visible tab's transcript
// // mounted (hidden) instead, so this pins that contract: after focusing another tab,
// // the one you just left still has its transcript in the DOM.
describe("desktop-transcript-keep-alive", () => {
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
});
