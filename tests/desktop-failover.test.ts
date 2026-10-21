/** Backup-model failover: which model takes over after a model failure, plus the
 *  structural guarantees the daemon keeps while it switches. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldFailover, subagentPinFollowsFailover } from "../src/cli/commands/desktop.js";
import { pickFallbackModel } from "../src/config.js";
import { t } from "../src/i18n/index.js";
import { isContextOverflowError } from "../src/loop/errors.js";

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

  it("fails over on any terminal model failure, never only on a quota wall", () => {
    // The case that exposed this was an OpenCode 429 ("Upstream request failed:
    // Endpoint is unavailable") that stopped the stream with backups configured:
    // the gate must not depend on a classifier match to notice a dead model.
    expect(body).toContain("modelFailure = isModelFailure(ev.errorDetail, turnAborted())");
    expect(body).not.toContain("isQuotaExhaustedError");
    // A generator that throws never yields an error event, so the catch path has to
    // mark the same failure or that shape of an outage stops the turn too.
    expect(body).toContain("modelFailure = isModelFailure(");
    // Both paths share one rule, so they cannot drift about the user's abort either.
    expect(src).toContain("function isModelFailure(");
    expect(src).toContain('if (err?.name === "AbortError") return false;');
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
    expect(body).toContain("applyTabModel(tab, failedModel, { persistDefault: false");
  });

  it("scopes the automatic switch to the conversation, never the global default", () => {
    // Partial match: the call also carries `followSubagentPin`, and a new option must
    // not silently break the scope guarantee this pins.
    expect(body).toContain("applyTabModel(tab, next, { persistDefault: false");
  });

  it("moves the session's subagent pin with the chat when its provider ran dry", () => {
    // Both composer pills and the session meta have to follow, or the subagent pill
    // keeps naming a dead model and every spawn spends an attempt hitting the wall.
    expect(body).toContain("followSubagentPin: true");
    // The policy lives in the one function that moves a tab's model, so an explicit
    // pick can never drag the pin along: it never passes the flag.
    expect(src).toContain(
      "if (opts.followSubagentPin && subagentPinFollowsFailover(prevSubagent, prevModel))",
    );
    // A rolled-back switch puts the pin back with the model.
    expect(src).toContain("tab.currentSubagentModel = prevSubagent;");
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

  it("walks the configured order top-down, one model at a time", () => {
    // The chain seeds the model that failed first and records each pick, so the
    // next pick can only be further down the list — never the same model twice.
    expect(body).toContain("const primaryModel = tab.currentModel;");
    expect(body).toContain("const triedModels = new Set([primaryModel]);");
    expect(body).toContain("triedModels.add(next);");
  });

  it("gives up with an explanation for each of the three end states", () => {
    // No backups at all, backups that cannot run here, and backups that were tried
    // and failed — each needs its own sentence, never a bare provider error card.
    expect(body).toContain('t("loop.failoverNoBackup"');
    expect(body).toContain('t("loop.failoverNoneUsable"');
    expect(body).toContain('t("loop.failoverAllExhausted"');
    // And a rewind that cannot be replayed must say so instead of going quiet.
    expect(body).toContain('t("loop.failoverPromptUnavailable"');
  });
});

describe("shouldFailover — which attempt hands the turn to a backup", () => {
  const attempt = (over: Partial<Parameters<typeof shouldFailover>[0]> = {}) => ({
    aborted: false,
    producedAnswer: false,
    modelFailure: true,
    ...over,
  });

  it("hands over on a provider failure, whether it is a rate limit, a quota or an outage", () => {
    expect(shouldFailover(attempt())).toBe(true);
  });

  it("never hands over a turn that already answered", () => {
    expect(shouldFailover(attempt({ producedAnswer: true }))).toBe(false);
  });

  it("never hands over a user abort", () => {
    expect(shouldFailover(attempt({ aborted: true }))).toBe(false);
  });

  it("leaves a healthy attempt alone", () => {
    expect(shouldFailover(attempt({ modelFailure: false }))).toBe(false);
  });

  it("counts a context overflow as a conversation problem, not a model failure", () => {
    // The driver screens the loop's raw detail with this predicate, so an overflow
    // ends the turn instead of spending every backup on the same wall.
    expect(isContextOverflowError("OpenCode 400: maximum context length exceeded")).toBe(true);
    expect(
      isContextOverflowError(
        'OpenCode 429: {"error":{"message":"Upstream request failed: Endpoint is unavailable."}}',
      ),
    ).toBe(false);
  });
});

describe("subagentPinFollowsFailover", () => {
  const FAILED = "deepseek-v4-flash";
  let dir: string;
  let configPath: string;

  // Provider identity is read from config + discovery, so pin it to an empty temp
  // config: the assertions must not depend on the machine's real ~/.reasonix.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-failover-pin-"));
    configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ apiKey: "sk-test" }), "utf8");
    vi.stubEnv("REASONIX_CONFIG", configPath);
    vi.stubEnv("OPENAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an unpinned session alone: subagents already follow the main model", () => {
    expect(subagentPinFollowsFailover(undefined, FAILED)).toBe(false);
  });

  it("moves a pin on the provider that ran dry, whatever its model id", () => {
    expect(subagentPinFollowsFailover(FAILED, FAILED)).toBe(true);
    // Same account, different model: the pin cannot work either.
    expect(subagentPinFollowsFailover("deepseek-v4-pro", FAILED)).toBe(true);
  });

  it("keeps a pin on another provider, which still has quota", () => {
    expect(subagentPinFollowsFailover("gpt-5.6-sol", FAILED)).toBe(false);
  });
});

describe("failover stop messages", () => {
  const PRIMARY = "deepseek-v4-flash";

  it("names every backup that was tried when the chain is spent", () => {
    const msg = t("loop.failoverAllExhausted", { failed: PRIMARY, models: "glm-4.6, gpt-5.6-sol" });
    expect(msg).toContain(PRIMARY);
    expect(msg).toContain("glm-4.6, gpt-5.6-sol");
    expect(msg).not.toContain("{models}");
  });

  it("keeps the three end states verbally distinct", () => {
    const noBackup = t("loop.failoverNoBackup", { failed: PRIMARY });
    const noneUsable = t("loop.failoverNoneUsable", { failed: PRIMARY });
    const allTried = t("loop.failoverAllExhausted", { failed: PRIMARY, models: "x" });
    expect(new Set([noBackup, noneUsable, allTried]).size).toBe(3);
    expect(noBackup).toContain("no backup model is configured");
    expect(noneUsable).toContain("no configured backup model can run here");
    expect(allTried).toContain("every backup model was tried");
  });

  it("explains an unreplayable prompt rather than stopping silently", () => {
    const msg = t("loop.failoverPromptUnavailable", { next: "glm-4.6" });
    expect(msg).toContain("glm-4.6");
    expect(msg).not.toContain("{next}");
  });
});
