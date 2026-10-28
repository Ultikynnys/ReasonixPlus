// @vitest-environment jsdom
// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useReducer, useRef } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAppState } from "../../../tests/support/app-state.js";
import { TabBar, reduce } from "../App";
import type { IncomingEvent } from "../protocol";
import { ZoomableImage } from "./image-preview";
import { CapabilityDialog } from "./mcp-setup";
import { TabMenu, getTabsToClear } from "./tab-menu";
import {
  EXPAND_EVENT,
  callAnchor,
  endJumpAlignment,
  jumpTargetFor,
  jumpToAnchor,
  noticeAnchor,
} from "./transcript-jump";
import { useAutoScroll } from "./useAutoScroll";
import { DEFAULT_PIN_THRESHOLD, PIN_SETTLE_MS, useStickyBottom } from "./useStickyBottom";
import { useTurnWatchdog } from "./useTurnWatchdog";
import { WorkdirPop } from "./workdir-pop";

describe("tab-menu", () => {
  afterEach(() => {
    cleanup();
  });

  describe("getTabsToClear", () => {
    const tabs = [
      { id: "tab-1", workspaceDir: "/ws1" },
      { id: "tab-2", workspaceDir: "/ws2" },
      { id: "tab-3", workspaceDir: "/ws3" },
      { id: "tab-4", workspaceDir: "/ws4" },
    ];

    it("returns all tabs when scope is 'all'", () => {
      const result = getTabsToClear(tabs, "tab-2", "all");
      expect(result.map((t) => t.id)).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
    });

    it("returns tabs to the right of the active tab", () => {
      const result = getTabsToClear(tabs, "tab-2", "right");
      expect(result.map((t) => t.id)).toEqual(["tab-3", "tab-4"]);
    });

    it("returns tabs to the left of the active tab", () => {
      const result = getTabsToClear(tabs, "tab-3", "left");
      expect(result.map((t) => t.id)).toEqual(["tab-1", "tab-2"]);
    });

    it("returns empty array for 'left' when active tab is the first tab", () => {
      const result = getTabsToClear(tabs, "tab-1", "left");
      expect(result).toEqual([]);
    });

    it("returns empty array for 'right' when active tab is the last tab", () => {
      const result = getTabsToClear(tabs, "tab-4", "right");
      expect(result).toEqual([]);
    });

    it("handles unknown activeId safely", () => {
      expect(getTabsToClear(tabs, "unknown", "all").map((t) => t.id)).toEqual([
        "tab-1",
        "tab-2",
        "tab-3",
        "tab-4",
      ]);
      expect(getTabsToClear(tabs, "unknown", "right")).toEqual([]);
      expect(getTabsToClear(tabs, "unknown", "left")).toEqual([]);
    });
  });

  describe("TabMenu component", () => {
    const tabs = [{ id: "tab-1" }, { id: "tab-2" }, { id: "tab-3" }];

    it("renders the 3 options and handles clicking each option", () => {
      const onClear = vi.fn();
      const onClose = vi.fn();

      const { rerender } = render(
        <TabMenu
          anchor={{ x: 100, y: 100 }}
          tabs={tabs}
          activeId="tab-2"
          onClear={onClear}
          onClose={onClose}
        />,
      );

      const clearAllBtn = screen.getByRole("menuitem", { name: "Clear all tabs" });
      const clearRightBtn = screen.getByRole("menuitem", { name: "Clear tabs to the right" });
      const clearLeftBtn = screen.getByRole("menuitem", { name: "Clear tabs to the left" });

      expect(clearAllBtn).toBeTruthy();
      expect(clearRightBtn).toBeTruthy();
      expect(clearLeftBtn).toBeTruthy();

      fireEvent.click(clearAllBtn);
      expect(onClear).toHaveBeenCalledWith("all");
      expect(onClose).toHaveBeenCalledTimes(1);

      onClear.mockReset();
      onClose.mockReset();

      rerender(
        <TabMenu
          anchor={{ x: 100, y: 100 }}
          tabs={tabs}
          activeId="tab-2"
          onClear={onClear}
          onClose={onClose}
        />,
      );

      fireEvent.click(clearRightBtn);
      expect(onClear).toHaveBeenCalledWith("right");
      expect(onClose).toHaveBeenCalledTimes(1);

      onClear.mockReset();
      onClose.mockReset();

      rerender(
        <TabMenu
          anchor={{ x: 100, y: 100 }}
          tabs={tabs}
          activeId="tab-2"
          onClear={onClear}
          onClose={onClose}
        />,
      );

      fireEvent.click(clearLeftBtn);
      expect(onClear).toHaveBeenCalledWith("left");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("dismisses on Escape key", () => {
      const onClose = vi.fn();
      render(
        <TabMenu
          anchor={{ x: 100, y: 100 }}
          tabs={tabs}
          activeId="tab-2"
          onClear={vi.fn()}
          onClose={onClose}
        />,
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("dismisses on outside click", () => {
      const onClose = vi.fn();
      render(
        <div>
          <div data-testid="outside">Outside area</div>
          <TabMenu
            anchor={{ x: 100, y: 100 }}
            tabs={tabs}
            activeId="tab-2"
            onClear={vi.fn()}
            onClose={onClose}
          />
        </div>,
      );

      fireEvent.mouseDown(screen.getByTestId("outside"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("TabBar context menu integration", () => {
    it("switches workspace tab on click", () => {
      const setActive = vi.fn();
      render(
        <TabBar
          tabs={[
            { id: "alpha-1", workspaceDir: "/project/alpha" },
            { id: "beta-1", workspaceDir: "/project/beta" },
          ]}
          activeId="alpha-1"
          setActive={setActive}
          onClose={vi.fn()}
          onNew={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByText("beta").closest(".tab-group")!);
      expect(setActive).toHaveBeenCalledWith("beta-1");
    });

    it("locks the ribbon while a session change is still settling", () => {
      // A delete/clear is settled by a snapshot of the workspace it started on, so the
      // switch that would re-target that wait is refused and says why.
      const setActive = vi.fn();
      render(
        <TabBar
          tabs={[
            { id: "alpha-1", workspaceDir: "/project/alpha" },
            { id: "beta-1", workspaceDir: "/project/beta" },
          ]}
          activeId="alpha-1"
          setActive={setActive}
          onClose={vi.fn()}
          onNew={vi.fn()}
          blocked
        />,
      );

      const betaTab = screen.getByText("beta").closest(".tab-group")!;
      expect(betaTab.getAttribute("aria-disabled")).toBe("true");
      expect(betaTab.getAttribute("data-blocked")).toBe("true");
      expect(betaTab.getAttribute("title")).toBe("Finishing a session change first");
      fireEvent.click(betaTab);
      expect(setActive).not.toHaveBeenCalled();
    });

    it("renders one workspace tab for multiple independent session channels", () => {
      const onClose = vi.fn();
      const { container } = render(
        <TabBar
          tabs={[
            { id: "alpha-1", workspaceDir: "/project/alpha", session: "session-a" },
            { id: "alpha-2", workspaceDir: "/project/alpha/", session: "session-b" },
            { id: "beta-1", workspaceDir: "/project/beta", session: "session-c" },
          ]}
          activeId="alpha-2"
          setActive={vi.fn()}
          onClose={onClose}
          onNew={vi.fn()}
        />,
      );

      expect(container.querySelectorAll(".tab-group")).toHaveLength(2);
      expect(container.querySelectorAll(".tab-session")).toHaveLength(0);
      expect(screen.getAllByText("alpha")).toHaveLength(1);

      const alphaTab = screen.getByText("alpha").closest(".tab-group")!;
      fireEvent.click(alphaTab.querySelector(".close")!);
      expect(onClose).toHaveBeenCalledWith("alpha-2");
    });

    it("opens drop down menu on right-clicking the ribbon and clears tabs", () => {
      const onClearTabs = vi.fn();
      const tabs = [
        { id: "tab-1", workspaceDir: "/project/alpha" },
        { id: "tab-2", workspaceDir: "/project/beta" },
        { id: "tab-3", workspaceDir: "/project/gamma" },
      ];

      const { container } = render(
        <TabBar
          tabs={tabs}
          activeId="tab-2"
          setActive={vi.fn()}
          onClose={vi.fn()}
          onNew={vi.fn()}
          onClearTabs={onClearTabs}
        />,
      );

      const tabbar = container.querySelector(".tabbar")!;
      expect(screen.queryByRole("menu")).toBeNull();

      // Right-click the ribbon
      fireEvent.contextMenu(tabbar, { clientX: 200, clientY: 50 });

      // Context menu should appear
      expect(screen.getByRole("menu")).toBeTruthy();

      // Click "Clear tabs to the right"
      fireEvent.click(screen.getByRole("menuitem", { name: "Clear tabs to the right" }));
      expect(onClearTabs).toHaveBeenCalledWith("right");

      // Menu should close
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });
});

describe("busy-parity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  type HarnessProps = Parameters<typeof useTurnWatchdog>[0];

  function Harness(props: HarnessProps) {
    useTurnWatchdog(props);
    return null;
  }

  describe("useTurnWatchdog — probing", () => {
    it("probes immediately when engaged, then once per poll cycle", () => {
      const probe = vi.fn();
      render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      expect(probe).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(probe).toHaveBeenCalledTimes(2);
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(probe).toHaveBeenCalledTimes(3);
    });

    it("never probes while the backend is disconnected", () => {
      const probe = vi.fn();
      render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected={false}
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(probe).not.toHaveBeenCalled();
    });

    it("probes the moment the backend reconnects while a turn is engaged", () => {
      const probe = vi.fn();
      const { rerender } = render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected={false}
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      expect(probe).not.toHaveBeenCalled();
      rerender(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      expect(probe).toHaveBeenCalledTimes(1);
    });

    it("probes on window focus", () => {
      const probe = vi.fn();
      render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      expect(probe).toHaveBeenCalledTimes(1);
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it("stops probing once the turn is released", () => {
      const probe = vi.fn();
      const { rerender } = render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      rerender(
        <Harness
          engaged={false}
          awaitingAckWithoutBusy={false}
          connected
          probe={probe}
          onStaleAck={() => {}}
        />,
      );
      const afterRelease = probe.mock.calls.length;
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(probe.mock.calls.length).toBe(afterRelease);
    });
  });

  describe("useTurnWatchdog — stale optimistic send", () => {
    it("releases a send the daemon never acked after the stale window", () => {
      const onStaleAck = vi.fn();
      render(
        <Harness
          engaged
          awaitingAckWithoutBusy
          connected
          probe={() => {}}
          onStaleAck={onStaleAck}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(9_999);
      });
      expect(onStaleAck).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onStaleAck).toHaveBeenCalledTimes(1);
    });

    it("does not arm the stale timer while the turn is daemon-owned busy", () => {
      const onStaleAck = vi.fn();
      render(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={() => {}}
          onStaleAck={onStaleAck}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onStaleAck).not.toHaveBeenCalled();
    });

    it("cancels the stale timer when the ack arrives before the window closes", () => {
      const onStaleAck = vi.fn();
      const { rerender } = render(
        <Harness
          engaged
          awaitingAckWithoutBusy
          connected
          probe={() => {}}
          onStaleAck={onStaleAck}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      rerender(
        <Harness
          engaged
          awaitingAckWithoutBusy={false}
          connected
          probe={() => {}}
          onStaleAck={onStaleAck}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(onStaleAck).not.toHaveBeenCalled();
    });
  });

  describe("busy parity — lost $turn_complete recovery (end to end)", () => {
    /** Mirrors the real TabRuntime wiring: probe sends tab_status, the daemon's
     *  reply lands as an incoming event, the reducer reconciles. The fake daemon
     *  here is IDLE — the UI's turn was wedged busy by a lost terminal event. */
    function ReconcileHarness({ initialBusy }: { initialBusy: boolean }) {
      const [state, dispatch] = useReducer(
        reduce,
        baseAppState({ ready: true, busy: initialBusy }),
      );
      const probe = useCallback(() => {
        dispatch({
          t: "incoming",
          event: {
            type: "$tab_status",
            busy: false,
            queued: 0,
            compacting: false,
            switching: false,
          },
        });
      }, []);
      const onStaleAck = useCallback(() => dispatch({ t: "release_stale_send" }), []);
      useTurnWatchdog({
        engaged: state.busy || state.awaitingAck,
        awaitingAckWithoutBusy: state.awaitingAck && !state.busy,
        connected: true,
        probe,
        onStaleAck,
      });
      const resync = state.messages.find((m) => m.kind === "notice" && m.text.includes("Resynced"));
      return (
        <div>
          <span data-testid="busy">{String(state.busy)}</span>
          <span data-testid="awaiting">{String(state.awaitingAck)}</span>
          <span data-testid="resync">{resync?.kind === "notice" ? resync.text : ""}</span>
        </div>
      );
    }

    it("recovers to idle within one poll cycle and shows the resync notice", () => {
      const { getByTestId } = render(<ReconcileHarness initialBusy />);
      // The engage-probe fires synchronously on mount; the daemon says idle.
      expect(getByTestId("busy").textContent).toBe("false");
      expect(getByTestId("awaiting").textContent).toBe("false");
      expect(getByTestId("resync").textContent).toContain("Resynced");
      // One full poll cycle later: still idle, no re-wedge, no duplicate notice.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(getByTestId("busy").textContent).toBe("false");
      expect(getByTestId("resync").textContent).toContain("Resynced");
    });

    it("the idle resync clears open gate queues exactly like $turn_complete", () => {
      const shellPrompt = (command: string): import("@reasonix/core-utils").ApprovalPrompt => ({
        id: 1,
        kind: "shell",
        tone: "warn",
        title: "Run command",
        subtitle: command,
        preview: command,
        meta: {},
        actions: [{ id: "run_once", label: "Run once", kind: "allow_once" }],
        data: {},
      });
      const pathPrompt = (): import("@reasonix/core-utils").ApprovalPrompt => ({
        id: 2,
        kind: "path",
        tone: "warn",
        title: "Access path — read",
        subtitle: "/etc/hosts",
        preview: "tool → /etc/hosts",
        meta: {},
        actions: [{ id: "run_once", label: "Allow read", kind: "allow_once" }],
        data: {},
      });
      const runTo = (terminal: IncomingEvent) => {
        let s = reduce(baseAppState({ ready: true }), {
          t: "send_user",
          text: "go",
          clientId: "c-1",
        });
        s = reduce(s, { t: "incoming", event: { type: "$turn_started" } });
        s = reduce(s, {
          t: "incoming",
          event: { type: "tool.preparing", id: 2, ts: "t", turn: 1, callId: "tc-1", name: "shell" },
        });
        s = reduce(s, {
          t: "incoming",
          event: {
            type: "$confirm_required",
            id: 1,
            kind: "run_command",
            command: "rm -rf /",
            prompt: shellPrompt("rm -rf /"),
          },
        });
        s = reduce(s, {
          t: "incoming",
          event: {
            type: "$path_access_required",
            id: 2,
            path: "/etc/hosts",
            intent: "read",
            toolName: "read_file",
            sandboxRoot: "/workspace",
            allowPrefix: "/etc",
            prompt: pathPrompt(),
          },
        });
        s = reduce(s, {
          t: "incoming",
          event: {
            type: "$choice_required",
            id: 3,
            question: "pick",
            options: [{ id: "A", title: "a" }],
            allowCustom: true,
          },
        });
        s = reduce(s, {
          t: "incoming",
          event: { type: "$plan_required", id: 4, plan: "the plan", summary: "sum", callId: "c1" },
        });
        s = reduce(s, {
          t: "incoming",
          event: {
            type: "$checkpoint_required",
            id: 5,
            stepId: "step-1",
            title: "t",
            result: "r",
            completed: 1,
            total: 3,
          },
        });
        s = reduce(s, {
          t: "incoming",
          event: {
            type: "$revision_required",
            id: 6,
            reason: "why",
            remainingSteps: [],
            summary: "s",
          },
        });
        return reduce(s, { t: "incoming", event: terminal });
      };

      const viaComplete = runTo({ type: "$turn_complete", outcome: "aborted" });
      const viaResync = runTo({
        type: "$tab_status",
        busy: false,
        queued: 0,
        compacting: false,
        switching: false,
      });

      for (const settled of [viaComplete, viaResync]) {
        expect(settled.busy).toBe(false);
        expect(settled.pendingConfirms).toHaveLength(0);
        expect(settled.pendingPathAccess).toHaveLength(0);
        expect(settled.pendingChoices).toHaveLength(0);
        expect(settled.pendingPlans).toHaveLength(0);
        expect(settled.pendingCheckpoints).toHaveLength(0);
        expect(settled.pendingRevisions).toHaveLength(0);
      }
      // Same settlement body: the streaming card closes and the unresolved tool
      // segment gets the canned cancelled result on both paths.
      for (const settled of [viaComplete, viaResync]) {
        const card = settled.messages.find((m) => m.kind === "assistant");
        expect(card).toMatchObject({ kind: "assistant", pending: false });
        if (card?.kind === "assistant") {
          expect(card.segments[0]).toMatchObject({
            kind: "tool",
            result: "Tool call cancelled because the conversation stopped. No result was produced.",
            ok: false,
          });
        }
      }
    });

    it("an idle idle agreement produces no notice and no probe churn", () => {
      const { getByTestId } = render(<ReconcileHarness initialBusy={false} />);
      expect(getByTestId("busy").textContent).toBe("false");
      expect(getByTestId("resync").textContent).toBe("");
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(getByTestId("resync").textContent).toBe("");
    });
  });
});

describe("image-preview", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  });
  afterEach(cleanup);
  describe("ZoomableImage", () => {
    it("opens, zooms, resets and closes with focus restoration", () => {
      render(<ZoomableImage src="chart.png" alt="chart.png" />);
      const trigger = screen.getByRole("button", { name: "View image: chart.png" });
      trigger.focus();
      fireEvent.click(trigger);
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector("img")?.src).toContain("chart.png");
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
      expect(screen.getByText("125%")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
      expect(screen.getByText("100%")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    it("zooms with the regular mouse wheel and keeps the pointer location anchored", () => {
      render(<ZoomableImage src="chart.png" alt="chart.png" />);
      fireEvent.click(screen.getByRole("button", { name: "View image: chart.png" }));
      const stage = screen
        .getByRole("dialog")
        .querySelector(".image-viewer-viewport") as HTMLDivElement;
      Object.defineProperty(stage, "clientWidth", { configurable: true, value: 500 });
      Object.defineProperty(stage, "clientHeight", { configurable: true, value: 400 });
      stage.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 500,
        bottom: 400,
        width: 500,
        height: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const image = stage.querySelector("img")!;
      Object.defineProperty(image, "naturalWidth", { configurable: true, value: 100 });
      Object.defineProperty(image, "naturalHeight", { configurable: true, value: 80 });
      fireEvent.load(image);
      fireEvent.wheel(stage, { deltaY: -120, clientX: 300, clientY: 200 });
      expect(screen.getByText("120%")).toBeTruthy();
      expect(stage.scrollLeft).toBeGreaterThan(0);
      expect(stage.scrollTop).toBeGreaterThan(0);
      expect(screen.getByRole("dialog").querySelector(".image-viewer-image-stage")).toBeTruthy();
    });
    it("dismisses on the native Escape cancel event", () => {
      render(<ZoomableImage src="chart.png" />);
      fireEvent.click(screen.getByRole("button", { name: "View image" }));
      fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", { bubbles: false, cancelable: true }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    it("retains thumbnail error handling and reports full image errors", () => {
      const onError = vi.fn();
      const view = render(<ZoomableImage src="missing.png" onError={onError} />);
      fireEvent.error(view.container.querySelector("img")!);
      expect(onError).toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "View image" }));
      fireEvent.error(screen.getByRole("dialog").querySelector("img")!);
      expect(screen.getByRole("alert").textContent).toContain("Image could not be loaded");
    });
  });
});

describe("mcp-setup", () => {
  afterEach(cleanup);

  const servers = [
    { name: "playwright", enabled: true, builtin: true },
    { name: "blender", enabled: false, builtin: false },
  ];

  const installedPlugins = [{ name: "notfair", displayName: "NotFair", enabled: true }];

  const installedSkills = [
    { name: "churn-analysis", description: "Predicts churn.", enabled: true },
    { name: "seo-audit", enabled: false },
  ];

  function renderDialog({
    list = servers,
    pluginList = installedPlugins,
    skillList = installedSkills,
    subagents = false,
  }: {
    list?: typeof servers;
    pluginList?: typeof installedPlugins;
    skillList?: typeof installedSkills;
    subagents?: boolean;
  } = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CapabilityDialog
        title="Set up this chat"
        hint="Choose what this chat starts with. Every choice here is locked for the session, even after a restart."
        servers={list}
        plugins={pluginList}
        skills={skillList}
        subagents={subagents}
        confirmLabel="Confirm and start"
        busyLabel="Starting session"
        dismissLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  /** The answer the dialog reports, in the shape every caller consumes. */
  function answerOf(onConfirm: ReturnType<typeof vi.fn>) {
    return onConfirm.mock.calls[0]?.[0] as {
      servers: string[];
      plugins: string[];
      skills: string[];
      subagents: boolean;
    };
  }

  describe("CapabilityDialog", () => {
    it("invokes onCancel from the top-right X", () => {
      const { onCancel } = renderDialog();
      fireEvent.click(screen.getByLabelText("Cancel"));
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("starts from the Settings defaults and reports the enabled set on confirm", () => {
      const { onConfirm } = renderDialog();
      fireEvent.click(screen.getByText("Confirm and start"));
      expect(answerOf(onConfirm)).toEqual({
        servers: ["playwright"],
        plugins: ["notfair"],
        skills: ["churn-analysis"],
        subagents: false,
      });
    });

    it("adds a toggled server to the confirmed set", () => {
      const { onConfirm } = renderDialog();
      fireEvent.click(screen.getByRole("switch", { name: "blender" }));
      fireEvent.click(screen.getByText("Confirm and start"));
      const answer = answerOf(onConfirm);
      expect([...answer.servers].sort()).toEqual(["blender", "playwright"]);
      expect(answer.plugins).toEqual(["notfair"]);
      expect(answer.subagents).toBe(false);
    });

    it("drops a plugin the user switched off from the confirmed set", () => {
      const { onConfirm } = renderDialog();
      fireEvent.click(screen.getByRole("switch", { name: "NotFair" }));
      fireEvent.click(screen.getByText("Confirm and start"));
      expect(answerOf(onConfirm).plugins).toEqual([]);
    });

    it("reports the standalone skills that start switched on", () => {
      const { onConfirm } = renderDialog();
      fireEvent.click(screen.getByText("Confirm and start"));
      expect(answerOf(onConfirm).skills).toEqual(["churn-analysis"]);
    });

    it("adds and drops a skill independently of the plugin set", () => {
      const { onConfirm } = renderDialog();
      fireEvent.click(screen.getByRole("switch", { name: "seo-audit" }));
      fireEvent.click(screen.getByRole("switch", { name: "churn-analysis" }));
      fireEvent.click(screen.getByText("Confirm and start"));
      const answer = answerOf(onConfirm);
      expect(answer.skills).toEqual(["seo-audit"]);
      expect(answer.plugins).toEqual(["notfair"]);
    });

    it("says so when no standalone skill is installed and points at the plugin rule", () => {
      renderDialog({ skillList: [] });
      expect(screen.getByText(/No standalone skill installed/)).toBeTruthy();
      expect(screen.getByText(/Skills a plugin ships arrive with that plugin/)).toBeTruthy();
    });

    it("says so when no plugin is installed", () => {
      renderDialog({ pluginList: [] });
      expect(screen.getByText(/No plugin installed/)).toBeTruthy();
    });

    it("pre-fills the subagent switch from the session default", () => {
      const { onConfirm } = renderDialog({ subagents: true });
      const toggle = screen.getByRole("switch", { name: "Subagents" });
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByText("Confirm and start"));
      expect(answerOf(onConfirm).subagents).toBe(true);
    });

    it("reports the subagent choice independently of the server set", () => {
      const { onConfirm } = renderDialog({ subagents: false });
      fireEvent.click(screen.getByRole("switch", { name: "Subagents" }));
      fireEvent.click(screen.getByText("Confirm and start"));
      const answer = answerOf(onConfirm);
      expect(answer.servers).toEqual(["playwright"]);
      expect(answer.plugins).toEqual(["notfair"]);
      expect(answer.subagents).toBe(true);
    });

    it("still offers the subagent switch when no MCP server is configured", () => {
      const { onConfirm } = renderDialog({ list: [], subagents: false });
      expect(screen.getByText(/None configured/)).toBeTruthy();
      fireEvent.click(screen.getByRole("switch", { name: "Subagents" }));
      fireEvent.click(screen.getByText("Confirm and start"));
      const answer = answerOf(onConfirm);
      expect(answer.servers).toEqual([]);
      expect(answer.subagents).toBe(true);
    });

    it("greys out the confirm button and throbs while the session starts", () => {
      const { onConfirm } = renderDialog();
      const confirm = screen.getByRole("button", { name: /Confirm and start/ });
      expect(confirm.hasAttribute("disabled")).toBe(false);
      expect(confirm.querySelector(".btn-throbber")).toBeNull();

      fireEvent.click(confirm);

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(confirm.hasAttribute("disabled")).toBe(true);
      expect(confirm.getAttribute("aria-busy")).toBe("true");
      expect(confirm.querySelector(".spin.btn-throbber")).toBeTruthy();
      expect(screen.getByRole("status", { name: "Starting session" })).toBeTruthy();
    });

    it("ignores extra confirm clicks while the session is starting", () => {
      const { onConfirm } = renderDialog();
      const confirm = screen.getByRole("button", { name: /Confirm and start/ });
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });
});

describe("workdir-pop", () => {
  afterEach(() => {
    cleanup();
  });

  describe("WorkdirPop component", () => {
    it("renders nothing when closed", () => {
      const { container } = render(
        <WorkdirPop
          open={false}
          onClose={vi.fn()}
          recent={["/repo/alpha", "/repo/beta"]}
          onPick={vi.fn()}
          onBrowse={vi.fn()}
        />,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders recent workspaces and allows picking one", () => {
      const onPick = vi.fn();
      const onClose = vi.fn();

      render(
        <WorkdirPop
          open
          onClose={onClose}
          recent={["/repo/alpha", "/repo/beta"]}
          current="/repo/current"
          onPick={onPick}
          onBrowse={vi.fn()}
        />,
      );

      expect(screen.getByText("alpha")).toBeTruthy();
      expect(screen.getByText("beta")).toBeTruthy();

      fireEvent.click(screen.getByText("alpha"));
      expect(onPick).toHaveBeenCalledWith("/repo/alpha");
      expect(onClose).toHaveBeenCalled();
    });

    it("renders remove button for recent workspaces when onRemove is provided", () => {
      const onRemove = vi.fn();
      const onPick = vi.fn();
      const onClose = vi.fn();

      render(
        <WorkdirPop
          open
          onClose={onClose}
          recent={["/repo/alpha", "/repo/beta"]}
          current="/repo/current"
          onPick={onPick}
          onRemove={onRemove}
          onBrowse={vi.fn()}
        />,
      );

      const removeBtns = screen.getAllByRole("button", { name: "Remove from recent" });
      expect(removeBtns.length).toBe(2);

      // Clicking the remove button must call onRemove and NOT call onPick or onClose
      fireEvent.click(removeBtns[0]!);
      expect(onRemove).toHaveBeenCalledWith("/repo/alpha");
      expect(onPick).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("triggers remove on keyboard Enter or Space", () => {
      const onRemove = vi.fn();
      const onPick = vi.fn();
      const onClose = vi.fn();

      render(
        <WorkdirPop
          open
          onClose={onClose}
          recent={["/repo/alpha"]}
          onPick={onPick}
          onRemove={onRemove}
          onBrowse={vi.fn()}
        />,
      );

      const btn = screen.getByRole("button", { name: "Remove from recent" });
      fireEvent.keyDown(btn, { key: "Enter" });
      expect(onRemove).toHaveBeenCalledWith("/repo/alpha");
      expect(onPick).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(btn, { key: " " });
      expect(onRemove).toHaveBeenCalledTimes(2);
    });

    it("renders checkmark for current workspace when recent is empty and does not render remove button", () => {
      render(
        <WorkdirPop
          open
          onClose={vi.fn()}
          recent={[]}
          current="/repo/current"
          onPick={vi.fn()}
          onRemove={vi.fn()}
          onBrowse={vi.fn()}
        />,
      );

      expect(screen.getByText("current")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Remove from recent" })).toBeNull();
    });

    it("pins a Reasonix+ Local row and picks it", () => {
      const onPick = vi.fn();
      const onClose = vi.fn();

      render(
        <WorkdirPop
          open
          onClose={onClose}
          recent={["/repo/alpha"]}
          local="/install/reasonix"
          onPick={onPick}
          onBrowse={vi.fn()}
        />,
      );

      expect(screen.getByText("Reasonix+ Local")).toBeTruthy();
      fireEvent.click(screen.getByText("Reasonix+ Local"));
      expect(onPick).toHaveBeenCalledWith("/install/reasonix");
      expect(onClose).toHaveBeenCalled();
    });

    it("does not duplicate the local row when it is also in recents", () => {
      render(
        <WorkdirPop
          open
          onClose={vi.fn()}
          recent={["/install/reasonix", "/repo/alpha"]}
          local="/install/reasonix"
          onPick={vi.fn()}
          onBrowse={vi.fn()}
        />,
      );

      expect(screen.getAllByText("/install/reasonix").length).toBe(1);
      expect(screen.getByText("alpha")).toBeTruthy();
    });

    it("turns inert while a session mutation is in flight", () => {
      // A mutation can start in a sibling channel while the picker is already open,
      // so the lock cannot rely on the popover merely not opening.
      const onPick = vi.fn();
      const onRemove = vi.fn();
      const onBrowse = vi.fn();
      const { container } = render(
        <WorkdirPop
          open
          locked
          onClose={vi.fn()}
          recent={["/repo/alpha"]}
          current="/repo/current"
          onPick={onPick}
          onRemove={onRemove}
          onBrowse={onBrowse}
        />,
      );

      fireEvent.click(screen.getByText("alpha"));
      expect(onPick).not.toHaveBeenCalled();

      const remove = screen.getByRole("button", {
        name: "Remove from recent",
      }) as HTMLButtonElement;
      expect(remove.disabled).toBe(true);

      const browse = container.querySelector<HTMLButtonElement>(".wd-foot button");
      expect(browse?.disabled).toBe(true);
      fireEvent.click(browse as HTMLButtonElement);
      expect(onBrowse).not.toHaveBeenCalled();
      expect(container.querySelector('.wd-row[data-locked="true"]')).toBeTruthy();
    });
  });
});

describe("transcript-jump", () => {
  const rectOf = (top: number): DOMRect =>
    ({
      top,
      bottom: top + 10,
      left: 0,
      right: 100,
      width: 100,
      height: 10,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;

  /** A scroller with two turns, a scrollTo spy and a write counter, so a test can
   *  tell a landing (one write) from a hold that keeps correcting. */
  function fakeThread(options: { height?: number; content?: number } = {}) {
    const height = options.height ?? 400;
    const content = options.content ?? 2_000;
    const el = document.createElement("div");
    const turns = new Map<number, HTMLElement>();
    for (const turn of [1, 2]) {
      const node = document.createElement("div");
      node.setAttribute("data-turn", String(turn));
      el.appendChild(node);
      turns.set(turn, node);
    }
    const geom = { scrollTop: 0, writes: 0 };
    Object.defineProperty(el, "scrollTop", {
      get: () => geom.scrollTop,
      set: (value: number) => {
        geom.scrollTop = value;
        geom.writes += 1;
      },
    });
    Object.defineProperty(el, "scrollHeight", { get: () => content });
    Object.defineProperty(el, "clientHeight", { get: () => height });
    el.getBoundingClientRect = () => rectOf(0);
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      el.scrollTop = top ?? 0;
    });
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    /** Put a turn at a content offset; its viewport rect follows the scroll. */
    const place = (turn: number, offset: number) => {
      const node = turns.get(turn);
      if (!node) throw new Error(`no turn ${turn}`);
      node.getBoundingClientRect = () => rectOf(offset - geom.scrollTop);
    };
    /** Mount a card carrying a jump anchor at a content offset. `laidOut: false`
     *  reports the zero rect of a card inside a hidden subtree. */
    const placeCard = (anchor: string, offset: number, options: { laidOut?: boolean } = {}) => {
      let at = offset;
      const laidOut = options.laidOut ?? true;
      const mount = () => {
        const wrap = document.createElement("div");
        wrap.setAttribute("data-anchor", anchor);
        wrap.getBoundingClientRect = () =>
          laidOut
            ? rectOf(at - geom.scrollTop)
            : ({ ...rectOf(0), width: 0, height: 0 } as DOMRect);
        el.appendChild(wrap);
        return wrap;
      };
      let node = mount();
      return {
        /** The card opens (or its body finishes loading): it moves to `next`. */
        openAt: (next: number) => {
          at = next;
        },
        /** A re-render swaps the card for a fresh element sitting at `next`. */
        rerenderAt: (next: number) => {
          node.remove();
          at = next;
          node = mount();
        },
        /** The card goes away entirely (its gate resolved into something else). */
        remove: () => node.remove(),
      };
    };
    return { el, place, placeCard, scrollTo, geom };
  }

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  /** A transcript in the document, which is the only state the hold works in. */
  function mountedThread(options: { height?: number; content?: number } = {}) {
    const thread = fakeThread(options);
    document.body.append(thread.el);
    return thread;
  }

  afterEach(() => {
    endJumpAlignment();
    document.body.replaceChildren();
  });

  describe("jumpTargetFor", () => {
    it("clamps a jump target to the reachable scroll range", () => {
      expect(jumpTargetFor(9000, 1000, 564)).toBe(436);
      expect(jumpTargetFor(100, 1000, 564)).toBe(100);
    });

    it("targets the top while the transcript cannot scroll", () => {
      expect(jumpTargetFor(500, 400, 400)).toBe(0);
    });
  });

  describe("jumpToAnchor — turn targets", () => {
    it("brings the turn's top edge to the viewport top, at once", () => {
      const { el, place, scrollTo, geom } = fakeThread();
      place(2, 600);
      expect(jumpToAnchor(el, { turn: 2 })).toBe(true);
      // Instant, never animated: an animation is one more thing a later layout
      // change can cancel or outrun, and one click has to be enough.
      expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: "instant" });
      expect(geom.scrollTop).toBe(600);
    });

    it("reads the turn's offset at jump time, not from a cached layout", () => {
      const { el, place, geom } = fakeThread();
      place(2, 600);
      geom.scrollTop = 200;
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });
      expect(geom.scrollTop).toBe(600);
    });

    it("clamps a turn near the end to the last reachable scroll position", () => {
      const { el, place, geom } = fakeThread();
      place(2, 1_900);
      jumpToAnchor(el, { turn: 2 });
      expect(geom.scrollTop).toBe(1_600);
    });

    it("reports a missing turn instead of scrolling somewhere else", () => {
      const { el, scrollTo } = fakeThread();
      expect(jumpToAnchor(el, { turn: 9 })).toBe(false);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("reports a missing scroller and a non-turn instead of throwing", () => {
      const { el } = fakeThread();
      expect(jumpToAnchor(null, { turn: 1 })).toBe(false);
      expect(jumpToAnchor(el, { turn: 0 })).toBe(false);
      expect(jumpToAnchor(el, { turn: Number.NaN })).toBe(false);
    });
  });

  describe("jumpToAnchor — anchored cards", () => {
    it("lands on the event's own card, not on its turn's prompt", () => {
      // The bug this covers: every recorded event carried only a turn, so a plan,
      // choice or fold row always scrolled to the prompt bubble instead of itself.
      const { el, place, placeCard, scrollTo, geom } = fakeThread();
      place(1, 100);
      placeCard("call:c1", 900);
      expect(jumpToAnchor(el, { turn: 1, anchor: "call:c1" })).toBe(true);
      expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "instant" });
      expect(geom.scrollTop).toBe(900);
    });

    it("lands on the card that answers to the record's other id", () => {
      // A plan row carries two ids: the gate's (what a reloaded transcript renders)
      // and the live wire's `tc-…`. A live session only has the second one mounted.
      const { el, place, placeCard, geom } = fakeThread();
      place(2, 600);
      placeCard("call:tc-7", 900);
      expect(
        jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" }),
      ).toBe(true);
      expect(geom.scrollTop).toBe(900);
    });

    it("prefers the primary id when the record's ids both resolve", () => {
      const { el, place, placeCard, geom } = fakeThread();
      place(2, 600);
      placeCard("call:call-loop-7", 900);
      placeCard("call:tc-7", 1_200);
      jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" });
      expect(geom.scrollTop).toBe(900);
    });

    it("falls back to the turn while the anchored card is gone", () => {
      const { el, place, placeCard, geom } = fakeThread();
      place(2, 600);
      placeCard("notice:n2", 100);
      expect(jumpToAnchor(el, { turn: 2, anchor: "notice:n1" })).toBe(true);
      expect(geom.scrollTop).toBe(600);
    });

    it("lands an anchored event that has no turn at all", () => {
      const { el, placeCard, geom } = fakeThread();
      placeCard("notice:n9", 300);
      expect(jumpToAnchor(el, { turn: 0, anchor: "notice:n9" })).toBe(true);
      expect(geom.scrollTop).toBe(300);
    });

    it("reports a target that is nowhere instead of scrolling somewhere else", () => {
      const { el, scrollTo } = fakeThread();
      expect(jumpToAnchor(el, { turn: 0, anchor: "call:gone" })).toBe(false);
      expect(jumpToAnchor(null, { turn: 1 })).toBe(false);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("does not land on a card that is mounted but not laid out", () => {
      // A card in a hidden subtree reports a zero rect; scrolling to it would land
      // at the transcript top and still report success.
      const { el, place, placeCard, geom } = fakeThread();
      place(2, 600);
      placeCard("call:hidden", 0, { laidOut: false });
      expect(jumpToAnchor(el, { turn: 2, anchor: "call:hidden" })).toBe(true);
      expect(geom.scrollTop).toBe(600);
    });
  });

  describe("jumpToAnchor — holding the target", () => {
    const requests = () => {
      const seen: (readonly string[])[] = [];
      const onExpand = (event: Event) =>
        seen.push((event as CustomEvent<readonly string[]>).detail ?? []);
      document.addEventListener(EXPAND_EVENT, onExpand);
      return { seen, done: () => document.removeEventListener(EXPAND_EVENT, onExpand) };
    };

    it("asks the card a record names to open, and releases it on a plain-turn jump", () => {
      const { el, place, placeCard } = mountedThread();
      place(1, 100);
      placeCard("call:c1", 900);
      const expand = requests();

      jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
      jumpToAnchor(el, { turn: 1 });

      expect(expand.seen).toEqual([["call:c1"], []]);
      expand.done();
    });

    it("offers every id a record carries, so the card that mounts answers one of them", () => {
      // The card this transcript renders answers to the alias, and a card that mounts
      // a commit later answers to whichever id its own segment minted: asking for both
      // at once covers either without guessing.
      const { el, place, placeCard } = mountedThread();
      place(2, 600);
      placeCard("call:tc-7", 900);
      const expand = requests();

      jumpToAnchor(el, { turn: 2, anchor: "call:call-loop-7", anchorAlias: "call:tc-7" });

      expect(expand.seen).toEqual([["call:call-loop-7", "call:tc-7"]]);
      expand.done();
    });

    it("re-pins the target when its card opens after the jump", async () => {
      // The card is a header at click time and its whole body a commit later, so a
      // jump that measured once would be high by exactly the body height.
      const { el, place, placeCard, geom } = mountedThread();
      place(1, 100);
      const card = placeCard("call:c1", 300);
      jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
      expect(geom.scrollTop).toBe(300);

      card.openAt(900);
      await nextFrame();
      expect(geom.scrollTop).toBe(900);
    });

    it("switches to the card once it mounts", async () => {
      // A gate renders nothing until its args parse and its segment lands, so the
      // click falls back to the prompt bubble and the card appears a commit later.
      const { el, place, placeCard, geom } = mountedThread();
      place(1, 600);
      jumpToAnchor(el, { turn: 1, anchor: "call:c1" });
      expect(geom.scrollTop).toBe(600);

      placeCard("call:c1", 900);
      await nextFrame();
      expect(geom.scrollTop).toBe(900);
    });

    it("re-pins a target a re-render replaced", async () => {
      const { el, place, placeCard, geom } = mountedThread();
      place(1, 100);
      const card = placeCard("call:c1", 300);
      jumpToAnchor(el, { turn: 1, anchor: "call:c1" });

      card.rerenderAt(950);
      await nextFrame();
      expect(geom.scrollTop).toBe(950);
    });

    it("accumulates sub-pixel drift instead of dismissing each shift as noise", async () => {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      place(2, 600.6);
      await nextFrame();
      expect(geom.scrollTop).toBe(600);

      place(2, 601.2);
      await nextFrame();
      expect(geom.scrollTop).toBeCloseTo(601.2, 5);
    });

    it("leaves the viewport alone when the target has not moved", async () => {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });
      const landing = geom.writes;

      place(2, 600);
      await nextFrame();
      await nextFrame();
      expect(geom.writes).toBe(landing);
    });

    it("stops as soon as the reader takes over", async () => {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      window.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      place(2, 850);
      await nextFrame();
      expect(geom.scrollTop).toBe(600);
    });

    it("stops when the transcript goes away", async () => {
      const { el, place, geom } = mountedThread();
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });

      el.remove();
      place(2, 850);
      await nextFrame();
      expect(geom.scrollTop).toBe(600);
    });

    it("gives the transcript to the newest jump", async () => {
      const { el, place, geom } = mountedThread();
      place(1, 100);
      place(2, 600);
      jumpToAnchor(el, { turn: 2 });
      jumpToAnchor(el, { turn: 1 });
      expect(geom.scrollTop).toBe(100);

      place(2, 850);
      await nextFrame();
      expect(geom.scrollTop).toBe(100);
    });
  });

  describe("anchor formats", () => {
    it("addresses a gate card by its tool call, and a fold by its notice", () => {
      expect(callAnchor("call-7")).toEqual({ anchor: "call:call-7" });
      expect(callAnchor(undefined)).toEqual({});
      expect(noticeAnchor("n-1")).toBe("notice:n-1");
    });
  });
});

describe("useAutoScroll", () => {
  let resizeCallback: (() => void) | null = null;

  class MockResizeObserver {
    constructor(cb: () => void) {
      resizeCallback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {
      resizeCallback = null;
    }
  }

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(performance.now());
      return 1;
    });
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    resizeCallback = null;
    vi.restoreAllMocks();
  });

  function TestHarness({
    busy = false,
    getRestoreScrollTop,
    active = true,
  }: {
    busy?: boolean;
    getRestoreScrollTop?: () => number | null;
    active?: boolean;
  }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const { showJumpButton, scrollToBottom } = useAutoScroll(
      containerRef,
      contentRef,
      busy,
      getRestoreScrollTop,
      active,
    );

    return (
      <div>
        <div ref={containerRef} data-testid="container" style={{ height: 400, overflowY: "auto" }}>
          <div ref={contentRef} data-testid="content" style={{ height: 1000 }} />
        </div>
        {showJumpButton ? (
          <button type="button" data-testid="jump-btn" onClick={() => scrollToBottom(true)}>
            Jump
          </button>
        ) : null}
      </div>
    );
  }

  describe("useAutoScroll", () => {
    it("auto-scrolls to bottom on resize while pinned", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      act(() => {
        resizeCallback?.();
      });

      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("immediately unpins and shows jump button when user scrolls up with wheel", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 580, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      // User scrolls up by 20px (within PIN_THRESHOLD 80px, but intentional up-scroll)
      fireEvent.wheel(container, { deltaY: -20 });

      // Jump button must be visible now
      expect(screen.getByTestId("jump-btn")).toBeTruthy();

      // Now content resizes (e.g. streaming token arrived)
      scrollToSpy.mockClear();
      act(() => {
        resizeCallback?.();
      });

      // Must NOT scroll to bottom because user unpinned
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("unpins when user presses PageUp or ArrowUp", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      fireEvent.keyDown(container, { key: "PageUp" });
      expect(screen.getByTestId("jump-btn")).toBeTruthy();

      scrollToSpy.mockClear();
      act(() => {
        resizeCallback?.();
      });
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("re-pins when clicking jump button", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 300, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      // Unpin first
      fireEvent.wheel(container, { deltaY: -50 });
      const jumpBtn = screen.getByTestId("jump-btn");
      expect(jumpBtn).toBeTruthy();

      // Click jump
      fireEvent.click(jumpBtn);
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

      // Jump button is dismissed
      expect(screen.queryByTestId("jump-btn")).toBeNull();

      // Subsequent resize follows bottom again
      scrollToSpy.mockClear();
      act(() => {
        resizeCallback?.();
      });
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("does not scroll to bottom on turn end if user scrolled up", () => {
      const { rerender } = render(<TestHarness busy={true} />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 400, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      // User scrolls up during turn
      fireEvent.wheel(container, { deltaY: -100 });
      scrollToSpy.mockClear();

      // Turn ends (busy becomes false)
      rerender(<TestHarness busy={false} />);

      // Must NOT yank user to bottom
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("settles at bottom on turn end if user stayed pinned", () => {
      const { rerender } = render(<TestHarness busy={true} />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      // Turn ends without user unpinning
      rerender(<TestHarness busy={false} />);

      // Should settle at bottom
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    });

    it("unpins when user drags touch downward (scrolling content up)", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      fireEvent.touchStart(container, { touches: [{ clientY: 200 }] });
      fireEvent.touchMove(container, { touches: [{ clientY: 250 }] }); // finger moved down -> scrolls UP

      expect(screen.getByTestId("jump-btn")).toBeTruthy();
      scrollToSpy.mockClear();
      act(() => {
        resizeCallback?.();
      });
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("disables auto-scroll during pointer/scrollbar dragging and unpins if dragged up", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 600, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      fireEvent.pointerDown(container);
      // User drags scrollbar thumb up
      Object.defineProperty(container, "scrollTop", { value: 500, writable: true });
      fireEvent.scroll(container);

      expect(screen.getByTestId("jump-btn")).toBeTruthy();

      scrollToSpy.mockClear();
      act(() => {
        resizeCallback?.();
      });
      expect(scrollToSpy).not.toHaveBeenCalled();

      // Release drag
      fireEvent.pointerUp(window);
    });

    it("re-pins when scrolling down to bottom with wheel", () => {
      render(<TestHarness />);
      const container = screen.getByTestId("container");
      const scrollToSpy = vi.fn();
      container.scrollTo = scrollToSpy;

      Object.defineProperty(container, "scrollTop", { value: 400, writable: true });
      Object.defineProperty(container, "clientHeight", { value: 400, writable: true });
      Object.defineProperty(container, "scrollHeight", { value: 1000, writable: true });

      // Unpin first
      fireEvent.wheel(container, { deltaY: -50 });
      expect(screen.getByTestId("jump-btn")).toBeTruthy();

      // Scroll down until within PIN_THRESHOLD of bottom (e.g. scrollTop 550 + clientHeight 400 = 950 >= 1000 - 80)
      Object.defineProperty(container, "scrollTop", { value: 550, writable: true });
      fireEvent.wheel(container, { deltaY: 50 });

      // Jump button is hidden and view is pinned again
      expect(screen.queryByTestId("jump-btn")).toBeNull();
    });
  });
});

describe("useStickyBottom", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(performance.now());
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function Harness() {
    const containerRef = useRef<HTMLDivElement>(null);
    const sticky = useStickyBottom(containerRef, {
      scrollToBottom: (smooth) => {
        const el = containerRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
      },
    });

    return (
      <div>
        <div ref={containerRef} data-testid="container" style={{ height: 400, overflowY: "auto" }}>
          <div style={{ height: 1000 }} />
        </div>
        <button type="button" data-testid="follow" onClick={() => sticky.follow()}>
          Follow
        </button>
        <button type="button" data-testid="pin" onClick={() => sticky.pin(true)}>
          Pin
        </button>
      </div>
    );
  }

  /** Give the container a scroll geometry, then return a spy on its scrollTo. */
  function sizeContainer(top: number, height = 400, content = 1000) {
    const container = screen.getByTestId("container");
    const scrollToSpy = vi.fn();
    container.scrollTo = scrollToSpy;
    Object.defineProperty(container, "scrollTop", {
      value: top,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(container, "clientHeight", {
      value: height,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      value: content,
      writable: true,
      configurable: true,
    });
    return { container, scrollToSpy };
  }

  describe("useStickyBottom", () => {
    it("follows to the bottom while pinned and suppresses while dragging the scrollbar", () => {
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(600);

      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });

      // Start a scrollbar drag; follow must not rubber-band the thumb.
      fireEvent.pointerDown(container);
      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).not.toHaveBeenCalled();

      fireEvent.pointerUp(window);
    });

    it("un-pins on wheel-up and re-pins only after reaching the bottom", () => {
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(600);

      fireEvent.wheel(container, { deltaY: -30 });
      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).not.toHaveBeenCalled();

      // Scroll down to within the threshold of the bottom: re-pins.
      Object.defineProperty(container, "scrollTop", {
        value: 1000 - 400 - (DEFAULT_PIN_THRESHOLD - 1),
        writable: true,
        configurable: true,
      });
      fireEvent.wheel(container, { deltaY: 30 });

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("re-pins when the scrollbar drag ends at the bottom", () => {
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(200);

      fireEvent.pointerDown(container);
      // Drag up to un-pin, then to the very bottom, then release.
      Object.defineProperty(container, "scrollTop", {
        value: 100,
        writable: true,
        configurable: true,
      });
      fireEvent.scroll(container);
      Object.defineProperty(container, "scrollTop", {
        value: 600,
        writable: true,
        configurable: true,
      });
      fireEvent.scroll(container);
      fireEvent.pointerUp(window);

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("pin(smooth) jumps to the bottom and re-enables following", () => {
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(200);

      // Un-pin first so pin() has a visible effect.
      fireEvent.wheel(container, { deltaY: -100 });
      scrollToSpy.mockClear();

      fireEvent.click(screen.getByTestId("pin"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("notifies onPinChange as the pin state flips", () => {
      const onPinChange = vi.fn();
      function NotifyHarness() {
        const containerRef = useRef<HTMLDivElement>(null);
        useStickyBottom(containerRef, { onPinChange, scrollToBottom: () => {} });
        return <div ref={containerRef} data-testid="container" />;
      }
      render(<NotifyHarness />);
      const { container } = sizeContainer(600);

      fireEvent.wheel(container, { deltaY: -30 });
      expect(onPinChange).toHaveBeenLastCalledWith(false);

      Object.defineProperty(container, "scrollTop", {
        value: 600,
        writable: true,
        configurable: true,
      });
      fireEvent.wheel(container, { deltaY: 30 });
      expect(onPinChange).toHaveBeenLastCalledWith(true);
    });

    it("uses the provided threshold for the bottom test", () => {
      let isAtBottom: () => boolean = () => false;
      function ThresholdHarness() {
        const containerRef = useRef<HTMLDivElement>(null);
        const sticky = useStickyBottom(containerRef, { threshold: 300, scrollToBottom: () => {} });
        isAtBottom = sticky.isAtBottom;
        return <div ref={containerRef} data-testid="container" />;
      }
      render(<ThresholdHarness />);
      const { container } = sizeContainer(400); // 400 + 400 = 800 >= 1000 - 300 => bottom

      expect(isAtBottom()).toBe(true);
      Object.defineProperty(container, "scrollTop", {
        value: 0,
        writable: true,
        configurable: true,
      });
      expect(isAtBottom()).toBe(false);
    });

    it("re-pins once a down-scroll settles at the bottom, even if the reading at gesture time missed", () => {
      vi.useFakeTimers();
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(200);

      // Un-pin, then scroll down. The wheel event fires BEFORE the browser applies
      // the scroll, so the synchronous bottom test still reads "not at bottom".
      fireEvent.wheel(container, { deltaY: -50 });
      fireEvent.wheel(container, { deltaY: 50 });
      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).not.toHaveBeenCalled();

      // The scroll then settles at the bottom; the debounced re-check re-pins.
      Object.defineProperty(container, "scrollTop", {
        value: 600,
        writable: true,
        configurable: true,
      });
      vi.advanceTimersByTime(PIN_SETTLE_MS);

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("keeps following through a down-scroll that reads off-bottom (no spurious release)", () => {
      render(<Harness />);
      // Pinned by default, viewport well away from the bottom (content is still
      // streaming in, so follow() has not caught up yet).
      const { container, scrollToSpy } = sizeContainer(0);

      // A down-scroll here must NOT release the pin the user never left.
      fireEvent.wheel(container, { deltaY: 30 });

      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });

    it("stays pinned when dragged to the bottom, even through a small up-jitter", () => {
      render(<Harness />);
      const { container, scrollToSpy } = sizeContainer(200);
      const setTop = (value: number) =>
        Object.defineProperty(container, "scrollTop", {
          value,
          writable: true,
          configurable: true,
        });

      // Drag up to release, then down to the bottom, then nudge 1px back up.
      fireEvent.pointerDown(container);
      setTop(100);
      fireEvent.scroll(container);
      setTop(600);
      fireEvent.scroll(container);
      setTop(599);
      fireEvent.scroll(container);
      fireEvent.pointerUp(window);

      // The re-pin held: the jitter did not bounce it back into manual mode.
      scrollToSpy.mockClear();
      fireEvent.click(screen.getByTestId("follow"));
      expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    });
  });
});
