/** Backup-model failover: which model takes over after a model failure, plus the
 *  structural guarantees the daemon keeps while it switches. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  failoverStopMessage,
  shouldFailover,
  subagentPinFollowsFailover,
  turnStoppedByUser,
} from "../src/cli/commands/desktop.js";
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
    // leaving the tab like that would reject every later send. One helper owns the
    // restore, so a skip and a spent chain cannot drift apart.
    expect(body).toContain('restoreModel(failedModel, "backup-model rollback")');
  });

  it("scopes every automatic switch to the conversation, never the global default", () => {
    // One constant defines the switch shape, so a new call site cannot silently
    // persist the backup as the user's global default — the whole guarantee is that
    // the turn body never spells out its own options.
    expect(src).toContain(
      "const FAILOVER_SWITCH = { persistDefault: false, followSubagentPin: true } as const;",
    );
    expect(body).toContain("applyTabModel(tab, next, FAILOVER_SWITCH)");
    expect(body).toContain("applyTabModel(tab, model, FAILOVER_SWITCH)");
    expect(body).not.toContain("persistDefault:");
  });

  it("moves the session's subagent pin with the chat when its provider ran dry", () => {
    // Both composer pills and the session meta have to follow, or the subagent pill
    // keeps naming a dead model and every spawn spends an attempt hitting the wall.
    expect(src.match(/followSubagentPin: true/g)?.length).toBe(1);
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
    // The selection lives in failoverStopMessage so it is unit-tested below; the
    // daemon must never hand-roll one of the three.
    expect(body).toContain("failoverStopMessage({");
    expect(src).toContain('t("loop.failoverNoBackup"');
    expect(src).toContain('t("loop.failoverNoneUsable"');
    expect(src).toContain('t("loop.failoverAllExhausted"');
    // And a rewind that cannot be replayed must say so instead of going quiet.
    expect(body).toContain('t("loop.failoverPromptUnavailable"');
  });

  it("hands the chain to the next backup when one cannot even start", () => {
    // A rebuild that throws or a runtime that came back unusable used to end the
    // chain outright, so every backup below the broken one was never tried — the
    // "it just stops, switch the model yourself" bug.
    expect(body).toContain("skippedBackups.push(next);");
    expect(body).toContain(
      'notify(t("loop.failoverBackupUnusable", { next }));\n          continue;',
    );
    // The ONLY thing a broken chain may still abort on is a prompt that cannot be
    // replayed: no model can run that request, so walking the rest is pointless.
    expect(body.match(/failoverBroken = true;/g)?.length).toBe(1);
    expect(body).toContain('t("loop.failoverPromptUnavailable", { next })');
  });

  it("stops the chain when the user picks a model or presses Stop", () => {
    // One predicate decides "the user took over": the failure classifier and the chain
    // must never disagree about it, so the raw signal test exists exactly once.
    expect(src).toContain("export function turnStoppedByUser(");
    expect(src.match(/signal\.aborted === true/g)?.length).toBe(1);
    expect(body).not.toContain("signal.aborted");
    // A manual pick aborts the turn; one that lands BETWEEN two attempts must not be
    // overwritten by the next switch, so the chain re-checks before every step.
    expect(body).toContain("const turnAborted = (): boolean => aborted || turnStoppedByUser(tab);");
    expect(body).toContain("while (shouldFailover(attempt) && !turnStoppedByUser(tab))");
    // …and a turn the user stopped is never reported as an exhausted chain.
    expect(body).toContain(
      "if (shouldFailover(attempt) && !turnStoppedByUser(tab) && !failoverBroken)",
    );
  });

  it("puts the model the turn started on back when the chain is spent", () => {
    // Ending on the last backup would show a model the user never picked and send
    // their next message at the same wall.
    expect(body).toContain(
      'restoreModel(primaryModel, "restoring the turn\'s own model after a spent failover")',
    );
    expect(body).toContain("failedOverTo = null;");
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

  it("hands over a model that stalled on its own, not just one that errored", () => {
    // Empty responses and thinking-only stops are what "the backup never proceeds"
    // looked like: the loop spent its own recoveries and gave up with no error, so
    // the only thing left is a different model.
    expect(
      shouldFailover({
        aborted: false,
        producedAnswer: false,
        modelFailure: false,
        modelStalled: true,
      }),
    ).toBe(true);
    // An answer is still an answer, however much warning noise preceded it.
    expect(
      shouldFailover({
        aborted: false,
        producedAnswer: true,
        modelFailure: false,
        modelStalled: true,
      }),
    ).toBe(false);
    // A user abort dominates every other signal.
    expect(
      shouldFailover({
        aborted: true,
        producedAnswer: false,
        modelFailure: true,
        modelStalled: true,
      }),
    ).toBe(false);
  });
});

describe('turnStoppedByUser — the one predicate for "the user took over"', () => {
  it("stays quiet before the turn mints its aborter or while it is clean", () => {
    expect(turnStoppedByUser({ aborter: null })).toBe(false);
    expect(turnStoppedByUser({ aborter: new AbortController() })).toBe(false);
  });

  it("fires once Stop or a model pick aborted the turn", () => {
    const aborter = new AbortController();
    aborter.abort();
    expect(turnStoppedByUser({ aborter })).toBe(true);
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

describe("failoverStopMessage — the sentence that closes a spent chain", () => {
  const PRIMARY = "deepseek-v4-flash";

  it("says no backup is configured when the list is empty", () => {
    const msg = failoverStopMessage({
      failed: PRIMARY,
      configured: [],
      attempted: [],
      skipped: [],
    });
    expect(msg).toContain("no backup model is configured");
  });

  it("says none can run here when every one was skipped, and names none as tried", () => {
    const msg = failoverStopMessage({
      failed: PRIMARY,
      configured: ["glm-4.6"],
      attempted: [],
      skipped: ["glm-4.6"],
    });
    expect(msg).toContain("no configured backup model can run here");
    expect(msg).not.toContain("every backup model was tried");
  });

  it("names every backup the chain touched when they all failed", () => {
    const msg = failoverStopMessage({
      failed: PRIMARY,
      configured: ["glm-4.6", "gpt-5.6-sol"],
      attempted: ["gpt-5.6-sol"],
      skipped: ["glm-4.6"],
    });
    expect(msg).toContain("glm-4.6, gpt-5.6-sol");
    expect(msg).toContain("every backup model was tried");
    expect(msg).toContain(PRIMARY);
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
