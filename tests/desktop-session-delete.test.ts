import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NO_WORKSPACE_MESSAGE,
  abandonedSessionOnClose,
  clearSessionPlan,
  deletableSessionNames,
  missingSessionRefusal,
  newAnsweredMutationLog,
  runSessionClear,
  sessionRunningRefusal,
  sessionsWithLiveTurn,
  shouldDetachDeletedSession,
  skeletonSessionFor,
  tabNeedsWorkspace,
} from "../src/cli/commands/desktop.js";

describe("bulk session clear", () => {
  it("answers requested deletions before a slow scan and clears each name once", async () => {
    let finishScan!: (names: string[]) => void;
    const scan = new Promise<string[]>((resolve) => {
      finishScan = resolve;
    });
    const batches: string[][] = [];
    const answers: string[] = [];
    const clear = runSessionClear({
      requested: ["a", "a", "running"],
      list: () => scan,
      clear: async (names) => {
        batches.push(clearSessionPlan(names, new Set(["running"]), ["promised"]).doomed);
      },
      answer: () => answers.push("answered"),
      failed: () => {
        throw new Error("unexpected failure");
      },
    });
    await Promise.resolve();
    expect(batches).toEqual([["a"]]);
    expect(answers).toEqual(["answered"]);
    finishScan(["a", "b", "b", "running", "promised"]);
    await clear;
    expect(batches).toEqual([["a"], ["b"]]);
    expect(answers).toEqual(["answered"]);
  });

  it("settles and reports failures in both phases", async () => {
    const failures: string[] = [];
    let answered = 0;
    await runSessionClear({
      requested: ["a"],
      list: async () => {
        throw new Error("scan failed");
      },
      clear: async () => {
        throw new Error("delete failed");
      },
      answer: () => {
        answered += 1;
      },
      failed: (stage, error) => failures.push(`${stage}: ${(error as Error).message}`),
    });
    expect(answered).toBe(1);
    expect(failures).toEqual(["clear: delete failed", "list: scan failed"]);
  });

  it("reports a failed later batch after answering the requested batch", async () => {
    const events: string[] = [];
    await runSessionClear({
      requested: ["a"],
      list: async () => ["b"],
      clear: async (names) => {
        events.push(`clear ${names.join(",")}`);
        if (names.includes("b")) throw new Error("denied");
      },
      answer: () => events.push("answer"),
      failed: (stage) => events.push(`failed ${stage}`),
    });
    expect(events).toEqual(["clear a", "answer", "clear b", "failed clear"]);
  });
});

describe("desktop session deletion synchronization", () => {
  it("detaches the backend-bound session after deleting the active session", () => {
    expect(shouldDetachDeletedSession("active-session", "active-session", true)).toBe(true);
  });

  it("keeps the current conversation when an inactive session is deleted", () => {
    expect(shouldDetachDeletedSession("active-session", "older-session", true)).toBe(false);
  });

  it("does not detach the current session when deletion fails", () => {
    expect(shouldDetachDeletedSession("active-session", "active-session", false)).toBe(false);
  });

  it("never leaves a channel in the deleted session it kept after a failed delete", () => {
    // The session is still on disk, so the channel keeps it: only a successful
    // delete may move the channel out of a session.
    expect(shouldDetachDeletedSession("doomed", "doomed", false)).toBe(false);
  });
});

describe("desktop — how a channel skeleton gets its session", () => {
  it("adopts a persisted session that still exists", () => {
    expect(skeletonSessionFor({ session: "kept" }, "kept")).toEqual({
      kind: "adopt",
      name: "kept",
    });
  });

  it("mints for a genuinely new channel", () => {
    expect(skeletonSessionFor(undefined, undefined)).toEqual({ kind: "mint" });
    expect(skeletonSessionFor({ active: true }, undefined)).toEqual({ kind: "mint" });
  });

  it("lands neutral when the persisted session is gone", () => {
    // No name may be bound to a session that is absent from disk.
    expect(skeletonSessionFor({ session: "deleted-session" }, undefined)).toEqual({
      kind: "neutral",
    });
  });

  it("restores a channel persisted neutral as neutral instead of minting", () => {
    expect(skeletonSessionFor({ detached: true }, undefined)).toEqual({ kind: "neutral" });
  });

  it("treats a channel persisted as both detached and named as neutral", () => {
    expect(skeletonSessionFor({ session: "kept", detached: true }, "kept")).toEqual({
      kind: "neutral",
    });
  });

  it("does not adopt a session another workspace owns", () => {
    expect(skeletonSessionFor({ session: "foreign" }, undefined)).toEqual({ kind: "neutral" });
  });
});

describe("desktop — a running session is never deleted", () => {
  const channel = (currentSession: string, aborter: unknown) => ({ currentSession, aborter });

  it("collects only the sessions whose channel has a turn in flight", () => {
    const running = sessionsWithLiveTurn([
      channel("working", new AbortController()),
      channel("idle", null),
    ]);
    expect([...running]).toEqual(["working"]);
  });

  it("ignores a channel with no session bound yet", () => {
    expect(sessionsWithLiveTurn([channel("", new AbortController())]).size).toBe(0);
  });

  it("protects a turn whose body is still unwinding after its aborter cleared", () => {
    // Stop hooks and cleanup awaits run with the aborter gone but the turn body
    // alive, and the row still reads as running: deleting it would abort work the
    // user was told is kept.
    const unwinding = { ...channel("draining", null), activeTurn: Promise.resolve() };
    expect([...sessionsWithLiveTurn([unwinding])]).toEqual(["draining"]);
  });

  it("protects a session in the middle of a manual context fold", () => {
    // A fold awaits the turn before it starts, so both turn markers are clear while
    // the daemon still works on that session.
    const folding = { ...channel("folding", null), compactingManual: true };
    expect([...sessionsWithLiveTurn([folding])]).toEqual(["folding"]);
  });

  it("leaves a running session out of a clear-all", () => {
    const doomed = deletableSessionNames(["working", "idle", "older"], new Set(["working"]));
    expect(doomed).toEqual(["idle", "older"]);
  });

  it("keeps every name the confirm dialog promised to keep", () => {
    // The caller's list wins over the daemon's own view: a session the dialog
    // labeled running survives a clear even when this daemon sees it idle, so the
    // promise costs an undeleted row instead of a deleted session.
    const plan = clearSessionPlan(["working", "promised", "older"], new Set(["working"]), [
      "promised",
    ]);
    expect(plan.doomed).toEqual(["older"]);
    expect(plan.kept).toEqual(["working", "promised"]);
  });

  it("clears everything when nothing is live or promised", () => {
    const plan = clearSessionPlan(["a", "b"], new Set());
    expect(plan.doomed).toEqual(["a", "b"]);
    expect(plan.kept).toEqual([]);
  });

  it("ships a refusal that names the session and the way out", () => {
    const message = sessionRunningRefusal("working");
    expect(message).toContain("working");
    expect(message).toMatch(/running/i);
    expect(message).toMatch(/stop/i);
  });
});

describe("desktop — a row whose session is gone cannot be opened", () => {
  it("refuses in one shared wording that names the session", () => {
    const message = missingSessionRefusal("session_open", "ghost-1");
    expect(message).toContain("ghost-1");
    expect(message).toMatch(/no longer exists/i);
    expect(message).toMatch(/refreshed/i);
  });

  it("checks the session is on disk before it bootstraps a tab", () => {
    // Opening a missing session would show a blank chat and, through the load's
    // workspace stamp, rebuild its folder: the existence check has to run first.
    const src = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
    const open = src.slice(
      src.indexOf("function openOrFocusSession("),
      src.indexOf("function patchSessionMetaAndResync("),
    );
    expect(open).toContain("if (!sessionExists(name)) {");
    expect(open).toContain("emitSessionsForWorkspace(tab.rootDir, undefined, { force: true });");
    expect(open.indexOf("if (!sessionExists(name))")).toBeLessThan(open.indexOf("bootstrapTab("));
  });
});

describe("desktop — a closing channel releases the chat it never filled", () => {
  it("releases an empty session no other channel serves", () => {
    expect(
      abandonedSessionOnClose({ session: "fresh", empty: true, heldByAnotherChannel: false }),
    ).toBe("fresh");
  });

  it("keeps a session that holds any conversation", () => {
    expect(
      abandonedSessionOnClose({ session: "talked", empty: false, heldByAnotherChannel: false }),
    ).toBeUndefined();
  });

  it("keeps a session another channel still serves", () => {
    expect(
      abandonedSessionOnClose({ session: "shared", empty: true, heldByAnotherChannel: true }),
    ).toBeUndefined();
  });

  it("releases nothing from a channel with no session", () => {
    expect(
      abandonedSessionOnClose({ session: undefined, empty: true, heldByAnotherChannel: false }),
    ).toBeUndefined();
  });
});

describe("desktop — refusing a session command without a workspace", () => {
  it("flags a pending tab and a tab with no root dir", () => {
    expect(tabNeedsWorkspace({ pending: true, rootDir: "/ws" })).toBe(true);
    expect(tabNeedsWorkspace({ pending: false, rootDir: "" })).toBe(true);
  });

  it("lets a normal workspace tab through", () => {
    expect(tabNeedsWorkspace({ pending: false, rootDir: "/ws" })).toBe(false);
  });

  it("ships one user-facing refusal wording", () => {
    // The daemon echoes this instead of returning silently, so a refused click
    // still tells the user what to do next.
    expect(NO_WORKSPACE_MESSAGE).toMatch(/workspace/i);
  });
});

describe("desktop — a session mutation owns its workspace while it settles", () => {
  const daemon = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const app = readFileSync(join(process.cwd(), "desktop/src/App.tsx"), "utf8");

  it("books the workspace for a single delete, exactly like a clear", () => {
    const remove = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_delete") {'),
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
    );
    expect(remove).toContain("const releaseDeleteBooking = sessionWork.begin(tab.rootDir);");
    expect(remove).toContain("releaseDeleteBooking();");
    // The booking has to cover the detach as well: that is what re-targets the channel.
    expect(remove.indexOf("sessionWork.begin(tab.rootDir)")).toBeLessThan(
      remove.indexOf("detachDoomedSessionWriters("),
    );
  });

  it("never publishes a second listing over a mutation on tab activation", () => {
    const activate = daemon.slice(
      daemon.indexOf('if (msg.cmd === "tab_activate") {'),
      daemon.indexOf('if (msg.cmd === "confirm_response") {'),
    );
    expect(activate).toContain(
      "if (!workspaceSessionBusy(activated.rootDir)) void emitSessions(activated);",
    );
  });

  it("routes every user tab switch through the one gate", () => {
    expect(app).toContain("const tabSwitchBlocked = hasOpenSessionIntent(sessionsStore);");
    expect(app).toContain("if (hasOpenSessionIntent(sessionsStoreRef.current)) return;");
    expect(app).toContain("setActiveTabId={activateWorkspaceTab}");
    expect(app).toContain("tabSwitchBlocked={tabSwitchBlocked}");
  });

  it("stands the focus reconcile down while a mutation is settling", () => {
    // An open mutation is answered by its own request id, so a focus listing can only
    // waste a walk over the store: the reconcile waits for the answer instead.
    const focus = app.slice(
      app.indexOf("const lastFocusRefreshRef = useRef(0);"),
      app.indexOf("// Tracks each tab's running-agent flag"),
    );
    expect(focus).toContain("if (hasOpenSessionIntent(sessionsStoreRef.current)) return;");
    expect(focus.indexOf("hasOpenSessionIntent")).toBeLessThan(focus.indexOf("requestSessionList"));
  });

  it("answers a delete with the client's own request id, on every exit", () => {
    const remove = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_delete") {'),
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
    );
    expect(remove).toContain("const requestId = mutationRequestId(msg.requestId);");
    // Every exit publishes the answer through the ONE publisher, and each one is the
    // same request; a re-send republishes the stored answer instead of mutating again.
    const published = remove.match(/publishSessionAnswer\(tab, [^)]*\)/g) ?? [];
    expect(published).toHaveLength(3);
    expect(published.filter((call) => call.includes("requestId"))).toHaveLength(2);
    expect(remove).toContain("publishSessionAnswer(tab, known);");
  });

  it("answers a clear through the same publisher, including its crash fallback", () => {
    const clear = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
      daemon.indexOf('if (msg.cmd === "session_rename") {'),
    );
    expect(clear).toContain("const requestId = mutationRequestId(msg.requestId);");
    // The crash fallback answers too: a clear that never finished must not stay hidden.
    expect(clear).toContain(".catch((err) => {");
    expect(clear.match(/publishSessionAnswer\(tab, \{ requestId \}\)/g)).toHaveLength(2);
    expect(clear).toContain("publishSessionAnswer(tab, known);");
  });

  it("processes requested sessions before the workspace sweep and suppresses concurrent retries", () => {
    const clear = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
      daemon.indexOf('if (msg.cmd === "session_rename") {'),
    );
    expect(clear.indexOf("if (clearingMutations.has(requestId)) return;")).toBeLessThan(
      clear.indexOf("clearingMutations.add(requestId);"),
    );
    expect(clear).toContain("await runSessionClear({");
    expect(clear).toContain("clearingMutations.delete(requestId);");
    expect(clear).toContain("clearSessionPlan(candidates, running, declaredKeep)");
    expect(clear).toContain("session_clear ${stage} failed:");
  });

  it("never lets a workspace refresh carry an answer, so a request answers once", () => {
    const resync = daemon.slice(
      daemon.indexOf("function resyncAfterDeletes("),
      daemon.indexOf("function focusSessionChannel("),
    );
    // A delete can touch several workspaces; refreshing them all with the answer would
    // publish the same request's verdict once per workspace.
    expect(resync).not.toContain("answers");
    expect(resync).toContain("emitSessionsForWorkspace(dir, undefined, { revalidate: false })");
    expect(daemon).toContain("function publishSessionAnswer(");
  });

  it("emits ONE snapshot per workspace, not one per channel", () => {
    const emit = daemon.slice(
      daemon.indexOf("function emitSessionsForWorkspace("),
      daemon.indexOf("function createTabSkeleton("),
    );
    expect(emit).toContain("void emitSessions(channel,");
    // A loop over the workspace's channels would make N channels N verdicts.
    expect(emit).not.toContain("for (const t of tabsInWorkspace(");
  });

  it("answers a re-sent request from the log instead of mutating twice", () => {
    const answered = daemon.slice(
      daemon.indexOf('if (msg.cmd === "session_delete") {'),
      daemon.indexOf('if (msg.cmd === "session_clear") {'),
    );
    expect(answered).toContain("const known = answeredMutations.get(requestId);");
    expect(answered.indexOf("answeredMutations.get(requestId)")).toBeLessThan(
      answered.indexOf("detachDoomedSessionWriters("),
    );
  });
});

describe("desktop — a repeated mutation request is answered, not repeated", () => {
  it("remembers an answered request so a re-send can republish its answer", () => {
    const answered = newAnsweredMutationLog();
    expect(answered.get("m1")).toBeUndefined();
    answered.add({ requestId: "m1", created: "session-b" });
    expect(answered.get("m1")).toEqual({ requestId: "m1", created: "session-b" });
    // Adding twice must not consume a second slot: a re-send is the same request.
    answered.add({ requestId: "m1", created: "other" });
    expect(answered.get("m1")).toEqual({ requestId: "m1", created: "session-b" });
  });

  it("forgets the oldest answer so a long session cannot grow the log", () => {
    const answered = newAnsweredMutationLog(2);
    answered.add({ requestId: "m1" });
    answered.add({ requestId: "m2" });
    answered.add({ requestId: "m3" });
    expect(answered.get("m1")).toBeUndefined();
    expect(answered.get("m2")).toEqual({ requestId: "m2" });
    expect(answered.get("m3")).toEqual({ requestId: "m3" });
  });
});

describe("desktop — session creation is answered like any other request", () => {
  const daemon = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
  const app = readFileSync(join(process.cwd(), "desktop/src/App.tsx"), "utf8");

  it("asks for the create under a client request id", () => {
    const newChat = daemon.slice(
      daemon.indexOf('if (msg.cmd === "new_chat") {'),
      daemon.indexOf('if (msg.cmd === "duplicate_session") {'),
    );
    expect(newChat).toContain("requestId: mutationRequestId(msg.requestId)");

    const duplicate = daemon.slice(
      daemon.indexOf('if (msg.cmd === "duplicate_session") {'),
      daemon.indexOf('if (msg.cmd === "oauth_begin") {'),
    );
    expect(duplicate).toContain("const requestId = mutationRequestId(msg.requestId);");
    // An empty duplicate is refused, and a refusal still owes the client an answer.
    expect(duplicate).toContain("answerCreateRefusal(tab, requestId);");
  });

  it("answers every path that will not mint", () => {
    const open = daemon.slice(
      daemon.indexOf("function openFreshChat("),
      daemon.indexOf("// Restore the full tab set from the previous session"),
    );
    // Re-send of an already answered request: republish, never mint twice.
    expect(open.indexOf("const known = answeredMutations.get(spec.requestId);")).toBeGreaterThan(0);
    expect(open.indexOf("const known = answeredMutations.get(spec.requestId);")).toBeLessThan(
      open.indexOf("sessionCreationGate.tryEnter("),
    );
    const refusals = open.match(/answerCreateRefusal\(tab, spec\.requestId\);/g) ?? [];
    expect(refusals).toHaveLength(3);
  });

  it("answers the mint on the listing that first contains it", () => {
    const bootStart = daemon.indexOf("const createAnswer: SessionMutationAnswer | undefined");
    expect(bootStart).toBeGreaterThan(0);
    const boot = daemon.slice(bootStart, daemon.indexOf("emitMemory(tab);", bootStart));
    expect(boot).toContain("...(createAnswer ? { answers: [createAnswer] } : {})");
    expect(boot).toContain("created: tab.currentSession");
    // The gate reopens where the answer lands, so the two cannot drift apart.
    expect(boot.indexOf("answeredMutations.add(createAnswer)")).toBeLessThan(
      boot.indexOf("sessionCreationGate.leave(tab.rootDir)"),
    );
  });

  it("answers a bootstrap that never lists its mint, and reopens the gate", () => {
    const arm = daemon.slice(
      daemon.indexOf("function armCreationRelease("),
      daemon.indexOf("function bootstrapTab("),
    );
    expect(arm).toContain("const requestId = tab.createRequestId;");
    // The fallback goes through the same publisher, and only when the listing did not
    // answer first: that guard is what keeps it to one answer per request.
    expect(arm).toContain("answeredMutations.get(requestId) === undefined");
    expect(arm).toContain("publishSessionAnswer(tab, {");
    expect(arm).toContain("sessionCreationGate.leave(tab.rootDir);");
  });

  it("sends no create flag on the wire: the click is the only source of the lock", () => {
    const opened = daemon.slice(
      daemon.indexOf("function emitTabOpened("),
      daemon.indexOf("The authoritative tab set"),
    );
    expect(opened).not.toContain("creating");
    expect(app).not.toContain("ev.creating");
    // Both create kinds lock from the click, through the one mutation entry point.
    expect(app).toContain('startSessionMutation({ kind: "create", origin: "new-chat" }');
    expect(app).toContain('startSessionMutation({ kind: "create", origin: "duplicate" }');
  });

  it("starts every mutation through the one helper that owns the id", () => {
    const helper = app.slice(
      app.indexOf("const startSessionMutation = useCallback("),
      app.indexOf("const newChat = useCallback("),
    );
    expect(helper).toContain("const { requestId, request } = onSessionIntent(workspaceDir, ask);");
    // The click sends what a retry would re-send: one derivation, not two.
    expect(helper).toContain("mutationCommand(request, requestId)");
    expect(helper).toContain("if (!sent) onSessionIntentFailed(workspaceDir, requestId);");
    // No call site may bypass it: a mutation sent without that id could never settle.
    const callSites = app.match(/startSessionMutation\(\{ kind: "(delete|clear|create)"/g) ?? [];
    expect(callSites).toHaveLength(4);
    expect(app).not.toContain('sendRpc({ cmd: "session_delete"');
    expect(app).not.toContain('sendRpc({ cmd: "session_clear"');
    expect(app).not.toContain('rpcSend({ tabId, cmd: "new_chat"');
  });

  it("reports a duplicate from the answer, never from the send", () => {
    const duplicate = app.slice(
      app.indexOf("const duplicateSession = useCallback("),
      app.indexOf("// Sessions whose agent is ACTIVELY RUNNING"),
    );
    expect(duplicate).not.toContain('t("app.toast.duplicatedSession")');
    const sessionsEvent = app.slice(
      app.indexOf('if (ev.type === "$sessions" && tabId) {'),
      app.indexOf('if (ev.type === "$workspace_initialized" && tabId) {'),
    );
    expect(sessionsEvent).toContain('request.origin !== "duplicate"');
    expect(sessionsEvent).toContain("settled.answer.created");
  });
});
