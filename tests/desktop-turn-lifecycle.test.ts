/** Turn lifecycle invariant — the daemon settles the desktop exactly once per
 *  accepted or rejected user_input; a missed terminal event wedges the UI busy. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TAB_CLOSE_TIMEOUT_MS,
  TURN_CLEANUP_WAIT_MS,
  type TurnCleanupOutcome,
  settleTurnBeforeClose,
  settleTurnCleanup,
  tabBusy,
  tabStatus,
  turnStartRejection,
  unsettledTurnNotice,
} from "../src/cli/commands/desktop.js";
import type { TurnImage } from "../src/types.js";

const OPENAI_MODEL = "gate-test-openai";
const UNCLASSIFIED_MODEL = "gate-test-model";

describe("turnStartRejection — pre-flight gate table", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-turn-lifecycle-"));
    vi.stubEnv("USERPROFILE", tmp);
    vi.stubEnv("HOME", tmp);
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({ models: { [OPENAI_MODEL]: { provider: "openai" } } }),
      "utf8",
    );
    vi.stubEnv("REASONIX_CONFIG", join(tmp, "config.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  const okEnv = {
    pending: false,
    hasRootDir: true,
    runtimeReady: true,
    modelUsable: true,
  };

  it("pending tab is aborted without a reason card", () => {
    expect(turnStartRejection(UNCLASSIFIED_MODEL, undefined, { ...okEnv, pending: true })).toEqual({
      kind: "pending-tab",
      outcome: "aborted",
    });
  });

  it("missing workspace root is aborted like a pending tab", () => {
    expect(
      turnStartRejection(UNCLASSIFIED_MODEL, undefined, { ...okEnv, hasRootDir: false }),
    ).toEqual({ kind: "pending-tab", outcome: "aborted" });
  });

  it("runtime not ready stops the turn with a setup hint", () => {
    const rejection = turnStartRejection(UNCLASSIFIED_MODEL, undefined, {
      ...okEnv,
      runtimeReady: false,
    });
    expect(rejection?.kind).toBe("runtime-missing");
    expect(rejection?.outcome).toBe("stopped");
    expect(rejection?.reason).toContain("Not configured yet");
  });

  it("unusable model stops the turn with a provider-specific credential hint", () => {
    const deepseek = turnStartRejection(UNCLASSIFIED_MODEL, undefined, {
      ...okEnv,
      modelUsable: false,
    });
    expect(deepseek?.kind).toBe("credential-unavailable");
    expect(deepseek?.reason).toContain("No API key configured");

    const openai = turnStartRejection(OPENAI_MODEL, undefined, {
      ...okEnv,
      modelUsable: false,
    });
    expect(openai?.kind).toBe("credential-unavailable");
    expect(openai?.reason).toContain("No OpenAI credential");
  });

  it("images on a non-vision model are rejected before reaching the API", () => {
    const images: TurnImage[] = [{ url: "data:image/png;base64,AAAA" }];
    const rejection = turnStartRejection(UNCLASSIFIED_MODEL, images, okEnv);
    expect(rejection?.kind).toBe("images-need-vision");
    expect(rejection?.outcome).toBe("stopped");
    expect(rejection?.reason).toContain("vision-capable");
  });

  it("a clean tab passes every gate", () => {
    expect(turnStartRejection(UNCLASSIFIED_MODEL, undefined, okEnv)).toBeNull();
  });
});

describe("turn lifecycle — structural single-settlement invariant", () => {
  const src = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const wrapperStart = src.indexOf("async function runTurnInner(");
  const bodyStart = src.indexOf("async function runTurnInnerBody(");
  const bodyEnd = src.indexOf("async function switchWorkspace(");

  it("the turn functions exist in the expected order", () => {
    expect(wrapperStart).toBeGreaterThan(0);
    expect(bodyStart).toBeGreaterThan(wrapperStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
  });

  it("$turn_complete has exactly one construction site (emitTurnEnded)", () => {
    expect(src.match(/type: "\$turn_complete"/g)?.length).toBe(1);
  });

  it("the settlement wrapper is the only caller inside the turn pipeline", () => {
    const wrapper = src.slice(wrapperStart, bodyStart);
    const body = src.slice(bodyStart, bodyEnd);
    expect(wrapper.match(/emitTurnEnded\(/g)?.length).toBe(1);
    expect(body).not.toContain("emitTurnEnded(");
    expect(body).not.toContain('type: "$turn_complete"');
    // The body settles exclusively through the injected endTurn, so the
    // wrapper's finally-backstop can guarantee exactly-once settlement.
    expect(body).toContain("endTurn(");
  });

  it("$turn_started is emitted once, before the generator and any kernel event", () => {
    const body = src.slice(bodyStart, bodyEnd);
    const started = body.indexOf('type: "$turn_started"');
    const generator = body.indexOf("rt.loop.step(");
    const firstKernelEmit = body.indexOf("emitKernelEvent(");
    expect(started).toBeGreaterThan(0);
    expect(body.match(/type: "\$turn_started"/g)?.length).toBe(1);
    expect(generator).toBeGreaterThan(started);
    expect(firstKernelEmit).toBeGreaterThan(started);
  });

  it("Stop-hook output precedes the terminal event", () => {
    // The turn's last cards (a hook verdict notice) must be on the wire before
    // $turn_complete, or they land in a chat the daemon already declared idle.
    const body = src.slice(bodyStart, bodyEnd);
    const stopHook = body.indexOf('event: "Stop"');
    const terminal = body.indexOf("endTurn(outcome,");
    expect(stopHook).toBeGreaterThan(0);
    expect(terminal).toBeGreaterThan(0);
    expect(stopHook).toBeLessThan(terminal);
  });
});

describe("tabBusy / tabStatus — one busy source", () => {
  it("busy is true only when an aborter or turn promise is held", () => {
    expect(tabBusy({ aborter: null, activeTurn: undefined } as never)).toBe(false);
    expect(tabBusy({ aborter: new AbortController(), activeTurn: undefined } as never)).toBe(true);
    expect(tabBusy({ aborter: null, activeTurn: Promise.resolve() } as never)).toBe(true);
  });

  it("$tab_status mirrors the same busy source as tabBusy", () => {
    const busyNoRuntime = {
      aborter: new AbortController(),
      activeTurn: undefined,
      runtime: null,
      compactingManual: false,
      switching: true,
      parkedSends: 0,
    };
    const idle = {
      aborter: null,
      activeTurn: undefined,
      runtime: null,
      compactingManual: false,
      switching: false,
      parkedSends: 0,
    };

    expect(tabStatus(busyNoRuntime as never)).toEqual({
      type: "$tab_status",
      busy: true,
      queued: 0,
      compacting: false,
      switching: true,
    });
    expect(tabStatus(idle as never)).toEqual({
      type: "$tab_status",
      busy: false,
      queued: 0,
      compacting: false,
      switching: false,
    });
  });

  it("reports the loop's current turn when a runtime exists", () => {
    const running = {
      aborter: null,
      activeTurn: undefined,
      runtime: { loop: { currentTurn: 3 } },
      compactingManual: true,
      switching: false,
      parkedSends: 0,
    };
    expect(tabStatus(running as never)).toEqual({
      type: "$tab_status",
      busy: false,
      turn: 3,
      queued: 0,
      compacting: true,
      switching: false,
    });
  });

  it("counts the sends the daemon is holding behind the active turn", () => {
    // A parked input is acknowledged through this count; reporting zero made the
    // desktop time the send out mid-turn and drop the queue behind it.
    const holding = {
      aborter: null,
      activeTurn: Promise.resolve(),
      runtime: null,
      compactingManual: false,
      switching: false,
      parkedSends: 2,
    };
    expect(tabStatus(holding as never)).toEqual({
      type: "$tab_status",
      busy: true,
      queued: 2,
      compacting: false,
      switching: false,
    });
  });
});

describe("settleTurnBeforeClose: a closing tab never outlives its child", () => {
  it("returns at once for a tab with no turn in flight", async () => {
    await expect(settleTurnBeforeClose({ activeTurn: undefined })).resolves.toBeUndefined();
  });

  it("waits for the aborting turn to unwind", async () => {
    let settled = false;
    const turn = new Promise<void>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve();
      }, 0);
    });
    await settleTurnBeforeClose({ activeTurn: turn });
    expect(settled).toBe(true);
  });

  it("still frees the close when the turn body rejected", async () => {
    // A throw escaping a turn must not skip the tab teardown that follows it.
    await expect(
      settleTurnBeforeClose({ activeTurn: Promise.reject(new Error("boom")) }),
    ).resolves.toBeUndefined();
  });

  it("bounds the wait so a wedged client cannot stall the close", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = settleTurnBeforeClose({
        activeTurn: new Promise<void>(() => undefined),
      }).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(TAB_CLOSE_TIMEOUT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("turn cleanup: a stopped turn that never unwinds", () => {
  it("reports a cleanup that finished cleanly", async () => {
    expect(await settleTurnCleanup(undefined)).toEqual({ settled: true });
    expect(await settleTurnCleanup(Promise.resolve())).toEqual({ settled: true });
    expect(unsettledTurnNotice({ settled: true })).toBeNull();
  });

  it("keeps a failing cleanup visible instead of failing the next turn", async () => {
    const boom = new Error("boom");
    const outcome = await settleTurnCleanup(Promise.reject(boom));
    expect(outcome).toEqual({ settled: true, error: boom });
    expect(unsettledTurnNotice(outcome)).toContain("boom");
  });

  it("gives up after the bounded wait and names the reason", async () => {
    vi.useFakeTimers();
    try {
      let outcome: TurnCleanupOutcome | undefined;
      const waiting = settleTurnCleanup(new Promise<void>(() => undefined)).then((settled) => {
        outcome = settled;
      });
      await vi.advanceTimersByTimeAsync(TURN_CLEANUP_WAIT_MS - 1);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(outcome).toEqual({ settled: false });
      expect(unsettledTurnNotice({ settled: false })).toContain("still running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("tab close: a parked send never starts a turn behind a removed tab", () => {
  const src = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const runTurn = src.slice(
    src.indexOf("async function runTurn("),
    src.indexOf("async function runTurnInner("),
  );
  const close = src.slice(
    src.indexOf("async function closeChannel("),
    src.indexOf("async function closeWorkspaceTab("),
  );

  it("marks the channel closed before it aborts the turn", () => {
    // A send parked behind the unwinding turn wakes up when it resolves; it has to
    // find the channel closed, or it starts a turn nobody can see or stop.
    expect(src).toContain("closing: boolean;");
    expect(close.indexOf("tab.closing = true;")).toBeGreaterThan(0);
    expect(close.indexOf("tab.closing = true;")).toBeLessThan(close.indexOf("abortTurn(tab);"));
    expect(close).toContain("await settleTurnBeforeClose(tab);");
  });

  it("stops a runTurn that finds the channel closed instead of starting it", () => {
    expect(runTurn).toContain("if (tab.closing) return;");
    // The guard sits after the park loop, so a send that waited is covered too.
    expect(runTurn.indexOf("if (tab.closing) return;")).toBeGreaterThan(
      runTurn.indexOf("tab.parkedSends -= 1;"),
    );
  });
});
