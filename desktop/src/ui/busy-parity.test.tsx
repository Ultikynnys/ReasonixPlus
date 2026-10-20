// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useCallback, useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAppState } from "../../../tests/support/app-state.js";
import { reduce } from "../App";
import type { IncomingEvent } from "../protocol";
import { useTurnWatchdog } from "./useTurnWatchdog";

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
      <Harness engaged awaitingAckWithoutBusy connected probe={() => {}} onStaleAck={onStaleAck} />,
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
      <Harness engaged awaitingAckWithoutBusy connected probe={() => {}} onStaleAck={onStaleAck} />,
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
    const [state, dispatch] = useReducer(reduce, baseAppState({ ready: true, busy: initialBusy }));
    const probe = useCallback(() => {
      dispatch({
        t: "incoming",
        event: { type: "$tab_status", busy: false, queued: 0, compacting: false, switching: false },
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
