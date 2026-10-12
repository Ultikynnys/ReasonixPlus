/** Turn lifecycle invariant — the daemon settles the desktop exactly once per
 *  accepted or rejected user_input; a missed terminal event wedges the UI busy. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contextRawPayload,
  tabBusy,
  tabStatus,
  turnStartRejection,
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
});

describe("tabBusy / tabStatus — one busy source", () => {
  it("busy is true only when an aborter or turn promise is held", () => {
    expect(tabBusy({ aborter: null, activeTurn: undefined } as never)).toBe(false);
    expect(tabBusy({ aborter: new AbortController(), activeTurn: undefined } as never)).toBe(true);
    expect(tabBusy({ aborter: null, activeTurn: Promise.resolve() } as never)).toBe(true);
  });

  it("$tab_status mirrors the same busy source the raw-context payload reports", () => {
    const busyNoRuntime = {
      aborter: new AbortController(),
      activeTurn: undefined,
      runtime: null,
      compactingManual: false,
      switching: true,
    };
    const idle = {
      aborter: null,
      activeTurn: undefined,
      runtime: null,
      compactingManual: false,
      switching: false,
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

    expect(contextRawPayload(busyNoRuntime as never).busy).toBe(true);
    expect(contextRawPayload(idle as never).busy).toBe(false);
  });

  it("reports the loop's current turn when a runtime exists", () => {
    const running = {
      aborter: null,
      activeTurn: undefined,
      runtime: { loop: { currentTurn: 3 } },
      compactingManual: true,
      switching: false,
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
});
