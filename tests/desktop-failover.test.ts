/** Backup-model failover: which model takes over after a quota wall, plus the
 *  structural guarantees the daemon keeps while it switches. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickFallbackModel } from "../src/config.js";

const allUsable = () => true;

describe("pickFallbackModel — failover order", () => {
  it("takes the first configured model, in the user's order", () => {
    expect(pickFallbackModel(["a", "b", "c"], new Set(["current"]), allUsable)).toBe("a");
  });

  it("skips the models this turn already failed on", () => {
    expect(pickFallbackModel(["a", "b", "c"], new Set(["current", "a"]), allUsable)).toBe("b");
  });

  it("skips models the daemon cannot run here (no credential for that provider)", () => {
    const usable = (model: string) => model !== "a";
    expect(pickFallbackModel(["a", "b"], new Set(["current"]), usable)).toBe("b");
  });

  it("returns null once the chain is spent — the turn ends honestly", () => {
    expect(pickFallbackModel(["a", "b"], new Set(["current", "a", "b"]), allUsable)).toBeNull();
  });

  it("returns null when nothing is configured — no failover unless the user opts in", () => {
    expect(pickFallbackModel([], new Set(["current"]), allUsable)).toBeNull();
  });

  it("ignores blank entries and trims ids", () => {
    expect(pickFallbackModel(["  ", " b "], new Set(["current"]), allUsable)).toBe("b");
  });

  it("skips rather than aborts when a credential lookup throws", () => {
    const usable = (model: string) => {
      if (model === "broken") throw new Error("config unreadable");
      return true;
    };
    expect(pickFallbackModel(["broken", "b"], new Set(["current"]), usable)).toBe("b");
  });
});

describe("failover wiring — structural invariants in the daemon", () => {
  const src = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const bodyStart = src.indexOf("async function runTurnInnerBody(");
  const bodyEnd = src.indexOf("async function switchWorkspace(");
  const body = src.slice(bodyStart, bodyEnd);

  it("detects the quota wall from the loop's error detail, not the formatted message", () => {
    expect(body).toContain("isQuotaExhaustedError(ev.errorDetail?.message)");
  });

  it("switches before it rewinds, so a failed switch cannot drop the prompt", () => {
    const switchModel = body.indexOf("applyTabModel(tab, next");
    const rewound = body.indexOf("rt.loop.retryLastUser()");
    // The LAST drive call is the one inside the failover loop ("let attempt = …"
    // contains the same substring, so the first match is the initial drive).
    const replay = body.lastIndexOf("attempt = await driveAttempt(text)");
    expect(switchModel).toBeGreaterThan(0);
    // Rewinding persists a truncated session file; if the switch ran second and
    // threw, the user's prompt would be gone from the log and Retry would resend
    // an older message.
    expect(rewound).toBeGreaterThan(switchModel);
    expect(replay).toBeGreaterThan(rewound);
  });

  it("restores the previous model when the backup cannot build a runtime", () => {
    // applyTabModel nulls the runtime for an unusable model instead of throwing;
    // leaving the tab like that would reject every later send.
    expect(body).toContain("applyTabModel(tab, failedModel, { persistDefault: false })");
  });

  it("scopes the automatic switch to the conversation, never the global default", () => {
    expect(body).toContain("applyTabModel(tab, next, { persistDefault: false })");
  });

  it("re-emits settings only after the turn is settled", () => {
    // A $settings model change mid-turn would make the desktop release its busy
    // flag while the retried attempt is still streaming.
    const settled = body.indexOf("endTurn(outcome");
    const emitted = body.indexOf("if (failedOverTo) emitSettings(tab);");
    expect(settled).toBeGreaterThan(0);
    expect(emitted).toBeGreaterThan(settled);
  });

  it("keeps the failover inside the single turn lifecycle", () => {
    expect(body.match(/type: "\$turn_started"/g)?.length).toBe(1);
    expect(body).not.toContain('type: "$turn_complete"');
  });
});
