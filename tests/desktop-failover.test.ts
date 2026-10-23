/** Backup-model failover: which model takes over after a model failure, plus the
 *  structural guarantees the daemon keeps while it switches. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAILOVER_COOLDOWN_MS,
  failoverCooldown,
  failoverStopMessage,
  shouldFailover,
  subagentPinFollowsFailover,
  turnStoppedByUser,
} from "../src/cli/commands/desktop.js";
import { pickFallbackModel, walkFallbackChain } from "../src/config.js";
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

describe("walkFallbackChain — one walk over the configured order", () => {
  const allUsable = () => true;
  const startsAnyway = () => true;

  it("takes the first candidate in the user's order", () => {
    expect(walkFallbackChain(["a", "b"], new Set(), allUsable, startsAnyway)).toBe("a");
  });

  it("falls through a backup that cannot start here instead of ending the walk", () => {
    // The start-of-chat case: the first backup's runtime would not build, and the
    // whole list used to go untried because that one attempt failed.
    const tries: string[] = [];
    const started = walkFallbackChain(["a", "b", "c"], new Set(), allUsable, (model) => {
      tries.push(model);
      return model !== "a";
    });
    expect(started).toBe("b");
    expect(tries).toEqual(["a", "b"]);
  });

  it("skips models that already failed — including the one that opened the chat", () => {
    const blocked = new Set(["dead", "b"]);
    const started = walkFallbackChain(["dead", "b", "c"], blocked, allUsable, startsAnyway);
    expect(started).toBe("c");
  });

  it("never mutates the caller's chain state", () => {
    const blocked = new Set(["dead"]);
    walkFallbackChain(["a", "b"], blocked, allUsable, () => false);
    expect([...blocked]).toEqual(["dead"]);
  });

  it("returns null once every backup was tried and none started", () => {
    const tries: string[] = [];
    const started = walkFallbackChain(["a", "b"], new Set(), allUsable, (model) => {
      tries.push(model);
      return false;
    });
    expect(started).toBeNull();
    expect(tries).toEqual(["a", "b"]);
  });

  it("returns null when nothing is configured — no failover unless the user opts in", () => {
    expect(walkFallbackChain([], new Set(), allUsable, startsAnyway)).toBeNull();
  });
});

describe("failoverCooldown — the pause between two backup attempts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the full cooldown before the next attempt", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = failoverCooldown(undefined).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(FAILOVER_COOLDOWN_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("holds the cooldown at five seconds", () => {
    expect(FAILOVER_COOLDOWN_MS).toBe(5_000);
  });

  it("does not wait at all when the turn was already stopped", async () => {
    vi.useFakeTimers();
    const aborter = new AbortController();
    aborter.abort();
    let done = false;
    void failoverCooldown(aborter.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("wakes the moment Stop lands mid-cooldown", async () => {
    vi.useFakeTimers();
    const aborter = new AbortController();
    let done = false;
    const pending = failoverCooldown(aborter.signal).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    aborter.abort();
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(done).toBe(true);
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
    const switchModel = body.indexOf("switchTabModel(tab, next");
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
    // leaving the tab like that would reject every later send. ONE helper owns every
    // restore (a skipped backup, a startup walk that landed nowhere, a spent chain),
    // so no two exit paths can drift apart.
    expect(body).toContain('restoreTabModel(tab, failedModel, "backup-model rollback")');
    expect(src).toContain('restoreTabModel(tab, from, "startup backup rollback")');
    expect(src.match(/function restoreTabModel\(/g)?.length).toBe(1);
  });

  it("scopes every automatic switch to the conversation, never the global default", () => {
    // One constant defines the switch shape, so a new call site cannot silently
    // persist the backup as the user's global default — the whole guarantee is that
    // the turn body never spells out its own options.
    expect(src).toContain(
      "const FAILOVER_SWITCH = { persistDefault: false, followSubagentPin: true } as const;",
    );
    expect(body).toContain("switchTabModel(tab, next)");
    // The switch itself is defined once, so every failover (mid-turn and at chat start)
    // shares the session-scoped shape rather than spelling out its own options: the two
    // helpers are the only applyTabModel callers that take FAILOVER_SWITCH, and the turn
    // body cannot reach a model change any other way.
    expect(src.match(/applyTabModel\(tab, model, FAILOVER_SWITCH\)/g)?.length).toBe(2);
    expect(body).not.toContain("applyTabModel(");
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

  it("never marks its settings echo as a turn release", () => {
    // `turnReleased` is how a genuine (turn-aborting) model switch tells the
    // desktop it may settle. A failover only repaints the model, so any echo
    // carrying the flag would mark a live turn, and its running subagent,
    // complete the moment a composer click re-emitted settings.
    expect(body).toContain("if (failedOverTo) emitSettings(tab);");
    expect(body).not.toContain("turnReleased");
    // The one place that may set it aborts the turn first.
    expect(src).toContain("emitSettings(tab, { turnReleased: releasedTurn });");
  });

  it("keeps the failover inside the single turn lifecycle", () => {
    expect(body.match(/type: "\$turn_started"/g)?.length).toBe(1);
    expect(body).not.toContain('type: "$turn_complete"');
  });

  it("walks the configured order top-down, one model at a time", () => {
    // The chain seeds the model that failed first and records each pick, so the
    // next pick can only be further down the list — never the same model twice.
    expect(body).toContain("const primaryModel = tab.currentModel;");
    expect(body).toContain("const triedModels = new Set([primaryModel, ...tab.failoverExcluded]);");
    expect(body).toContain("triedModels.add(next);");
  });

  it("never offers the model that opened the chat as its own backup", () => {
    // Starting a chat on an unavailable model used to make the FIRST send dead on
    // arrival: the pre-flight gate stopped the turn and every backup went untried.
    expect(src).toContain("function adoptStartupBackup(");
    expect(body).toContain("adoptStartupBackup(tab);");
    expect(src).toContain("adoptStartupBackup(tab);\n    // A channel with no runtime");
    // One walker decides which backup runs next, and it keeps trying the rest when
    // one cannot build a runtime.
    expect(src).toContain("walkFallbackChain(");
    // A walk that lands nowhere must not leave the tab naming a backup that never ran.
    expect(src).toContain('restoreTabModel(tab, from, "startup backup rollback")');
    // …and it runs before the turn exists, so it may never throw into the send path.
    expect(src).toContain("startup backup switch failed");
  });

  it("records every failed model for the whole session, not just the turn", () => {
    // The model that triggered the chain is the one a later send must never try again,
    // so the ONE recording point is the loop that begins by naming it, and the seed
    // carries every earlier failure of this chat into the pick.
    expect(body).toContain("tab.failoverExcluded.add(tab.currentModel);");
    expect(body.match(/failoverExcluded\.add\(/g)?.length).toBe(1);
    expect(src).toContain("failoverExcluded: Set<string>;");
    // A conversation opened later (or another workspace) gives models a fresh chance.
    expect(src).toContain("function resetFailoverExclusions(");
    expect(src.match(/resetFailoverExclusions\(tab\);/g)?.length).toBe(2);
  });

  it("cools down between two backup attempts, and a Stop breaks the wait", () => {
    expect(src).toContain("export const FAILOVER_COOLDOWN_MS = 5_000;");
    const waited = body.indexOf("await failoverCooldown(tab.aborter?.signal);");
    const switched = body.indexOf("switchTabModel(tab, next)");
    // The pause lands BEFORE the switch, so a Stop during it leaves the tab on the
    // model it was already on: nothing to unwind, nothing rewound.
    expect(waited).toBeGreaterThan(0);
    expect(switched).toBeGreaterThan(waited);
    expect(body).toContain("if (turnStoppedByUser(tab)) break;");
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
    // …plus a fourth for a list this chat already spent in an earlier turn.
    expect(src).toContain('t("loop.failoverAlreadyFailed"');
    expect(body).toContain("excluded: [...tab.failoverExcluded]");
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
    expect(body).toContain('"restoring the turn\'s own model after a spent failover"');
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

  it("says the backups already failed earlier in this chat, not that they lack keys", () => {
    // The session remembers every model that failed, so a later send can walk a list
    // it never attempted. Reporting that as "no credential" would be false.
    const msg = failoverStopMessage({
      failed: PRIMARY,
      configured: ["glm-4.6"],
      attempted: [],
      skipped: [],
      excluded: [PRIMARY, "glm-4.6"],
    });
    expect(msg).toContain("already failed earlier in this chat");
    expect(msg).toContain("glm-4.6");
    expect(msg).not.toContain("no configured backup model can run here");
  });

  it("still blames the credentials when nothing had failed before", () => {
    const msg = failoverStopMessage({
      failed: PRIMARY,
      configured: ["glm-4.6"],
      attempted: [],
      skipped: [],
      excluded: [PRIMARY],
    });
    expect(msg).toContain("no configured backup model can run here");
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
