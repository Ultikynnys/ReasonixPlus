import type { SessionMutationAnswer } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./App";
import {
  FOCUS_REFRESH_THROTTLE_MS,
  abandonIntent,
  applySessionsSnapshot,
  beginIntent,
  clearPartition,
  derivedItems,
  emptySessionsStore,
  focusRefreshDue,
  hasOpenSessionIntent,
  hiddenNames,
  intentRecord,
  mutationFor,
  noteIntentAttempt,
  pendingSessionRequests,
  visibleSessions,
} from "./sessions-store";

const WORKSPACE = "/repo";

function session(name: string, createdAt: number): SessionInfo {
  return { name, messageCount: 1, mtime: new Date(createdAt).toISOString(), createdAt };
}

const A = session("a", 1_000);
const B = session("b", 2_000);

/** An answer to one request, as the daemon publishes it. */
function answer(requestId: string, created?: string): SessionMutationAnswer {
  return created === undefined ? { requestId } : { requestId, created };
}

function snap(
  revision: number,
  items: readonly SessionInfo[],
  extra: {
    epoch?: string;
    primed?: boolean;
    stale?: boolean;
    answers?: SessionMutationAnswer[];
  } = {},
) {
  return {
    epoch: extra.epoch ?? "daemon-1",
    revision,
    items,
    primed: extra.primed,
    stale: extra.stale,
    answers: extra.answers,
  };
}

function confirmed(items: readonly SessionInfo[], revision = 1) {
  return applySessionsSnapshot(emptySessionsStore(), WORKSPACE, snap(revision, items)).store;
}

function names(rows: readonly SessionInfo[]): string[] {
  return rows.map((row) => row.name);
}

function hidden(store: ReturnType<typeof confirmed>): string[] {
  return hiddenNames(store, WORKSPACE);
}

/** The request ids an applied snapshot settled. */
function answeredIds(result: ReturnType<typeof applySessionsSnapshot>): string[] {
  return result.answered.map((settled) => settled.answer.requestId);
}

describe("derivedItems", () => {
  it("applies every intent's hide and sorts newest-created first", () => {
    const rows = derivedItems(
      [A, B],
      [
        {
          requestId: "r1",
          kind: "delete",
          hide: ["a"],
          request: { kind: "delete", name: "a" },
          attempts: 0,
        },
      ],
    );
    expect(names(rows)).toEqual(["b"]);
  });

  it("keeps one row per name and never drops an empty session", () => {
    const empty = { ...session("c", 3_000), messageCount: 0 };
    const rows = derivedItems([A, A, empty], []);
    expect(names(rows)).toEqual(["c", "a"]);
    expect(rows[0]!.messageCount).toBe(0);
  });
});

describe("snapshot acceptance", () => {
  it("ignores a snapshot that is not newer than the applied revision", () => {
    const store = confirmed([A], 4);
    const stale = applySessionsSnapshot(store, WORKSPACE, snap(3, [A, B]));
    expect(stale.changed).toBe(false);
    expect(names(visibleSessions(stale.store, WORKSPACE))).toEqual(["a"]);
  });

  it("ignores an equal revision once a snapshot confirmed the workspace", () => {
    const store = confirmed([A], 2);
    const repeat = applySessionsSnapshot(store, WORKSPACE, snap(2, [A, B]));
    expect(repeat.changed).toBe(false);
    expect(names(visibleSessions(repeat.store, WORKSPACE))).toEqual(["a"]);
  });

  it("takes a new epoch wholesale and drops intents the old daemon never answered", () => {
    const deleting = beginIntent(confirmed([A]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    expect(hidden(deleting)).toEqual(["a"]);

    const rebooted = applySessionsSnapshot(
      deleting,
      WORKSPACE,
      snap(1, [A], { epoch: "daemon-2" }),
    );
    expect(pendingSessionRequests(rebooted.store)).toEqual([]);
    expect(names(visibleSessions(rebooted.store, WORKSPACE))).toEqual(["a"]);
  });

  it("accepts new revisions after a daemon restart", () => {
    const old = confirmed([A], 100);
    const restarted = applySessionsSnapshot(old, WORKSPACE, snap(1, [A], { epoch: "daemon-2" }));
    const next = applySessionsSnapshot(restarted.store, WORKSPACE, snap(2, [B], { epoch: "daemon-2" }));
    expect(names(visibleSessions(next.store, WORKSPACE))).toEqual(["b"]);
    expect(next.store.byWorkspace.get(WORKSPACE)!.revision).toBe(2);
  });

  it("marks failed scans unconfirmed without replacing verified rows", () => {
    const store = confirmed([A], 4);
    const degraded = applySessionsSnapshot(store, WORKSPACE, snap(5, [B], { stale: true }));
    expect(names(visibleSessions(degraded.store, WORKSPACE))).toEqual(["a"]);
    expect(degraded.store.byWorkspace.get(WORKSPACE)!.confirmed).toBe(false);
    const recovered = applySessionsSnapshot(degraded.store, WORKSPACE, snap(6, [B]));
    expect(names(visibleSessions(recovered.store, WORKSPACE))).toEqual(["b"]);
    expect(recovered.store.byWorkspace.get(WORKSPACE)!.confirmed).toBe(true);
  });

  it("rejects delayed snapshots from a retired daemon epoch", () => {
    const old = confirmed([A], 100);
    const restarted = applySessionsSnapshot(old, WORKSPACE, snap(1, [B], { epoch: "daemon-2" }));
    const delayed = applySessionsSnapshot(restarted.store, WORKSPACE, snap(101, [A]));
    expect(names(visibleSessions(delayed.store, WORKSPACE))).toEqual(["b"]);
    expect(delayed.store.byWorkspace.get(WORKSPACE)!.epoch).toBe("daemon-2");
  });

  it("preserves verified rows through repeated degraded snapshots and primed caches", () => {
    let store = confirmed([A], 4);
    store = applySessionsSnapshot(store, WORKSPACE, snap(5, [B], { stale: true })).store;
    store = applySessionsSnapshot(store, WORKSPACE, snap(6, [B], { stale: true })).store;
    store = applySessionsSnapshot(store, WORKSPACE, snap(7, [B], { primed: true })).store;
    expect(names(visibleSessions(store, WORKSPACE))).toEqual(["a"]);
    expect(store.byWorkspace.get(WORKSPACE)!.confirmed).toBe(false);
  });

  it("keeps the previous items array when a newer snapshot lists the same rows", () => {
    const store = confirmed([A, B], 1);
    const first = visibleSessions(store, WORKSPACE);
    const again = applySessionsSnapshot(store, WORKSPACE, snap(2, [B, A]));
    expect(again.changed).toBe(false);
    expect(visibleSessions(again.store, WORKSPACE)).toBe(first);
  });
});

describe("primed snapshots", () => {
  it("initialises a workspace without claiming a revision", () => {
    const primed = applySessionsSnapshot(
      emptySessionsStore(),
      WORKSPACE,
      snap(9, [A], { primed: true }),
    );
    expect(names(visibleSessions(primed.store, WORKSPACE))).toEqual(["a"]);
    const entry = primed.store.byWorkspace.get(WORKSPACE)!;
    expect(entry.revision).toBe(0);
    expect(entry.confirmed).toBe(false);
  });

  it("cannot outrank a settled scan", () => {
    const store = confirmed([A], 6);
    const primed = applySessionsSnapshot(store, WORKSPACE, snap(9, [A, B], { primed: true }));
    expect(primed.changed).toBe(false);
    expect(names(visibleSessions(primed.store, WORKSPACE))).toEqual(["a"]);
  });

  it("cannot resurrect a name an open intent hides", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const fresh = applySessionsSnapshot(
      emptySessionsStore(),
      WORKSPACE,
      snap(9, [A, B], { primed: true }),
    );
    expect(names(visibleSessions(fresh.store, WORKSPACE))).toEqual(["b", "a"]);
    const primed = applySessionsSnapshot(deleting, WORKSPACE, snap(9, [A, B], { primed: true }));
    expect(names(visibleSessions(primed.store, WORKSPACE))).toEqual(["b"]);
  });
});

describe("delete intents", () => {
  const deletingA = () =>
    beginIntent(confirmed([A, B]), WORKSPACE, { requestId: "r1", kind: "delete", name: "a" });

  it("hides the row from the click, before any snapshot", () => {
    expect(names(visibleSessions(deletingA(), WORKSPACE))).toEqual(["b"]);
    expect(mutationFor(deletingA(), WORKSPACE)).toEqual({ kind: "delete" });
  });

  it("settles on the answer to its own request", () => {
    const settled = applySessionsSnapshot(
      deletingA(),
      WORKSPACE,
      snap(2, [B], { answers: [answer("r1")] }),
    );
    expect(answeredIds(settled)).toEqual(["r1"]);
    expect(pendingSessionRequests(settled.store)).toEqual([]);
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
    expect(hidden(settled.store)).toEqual([]);
  });

  it("is not answered by a listing that merely omits the row", () => {
    // The daemon may list a workspace that never held the row (a scan that ran
    // before the delete, another window's view). That is not an answer.
    const store = deletingA();
    const listed = applySessionsSnapshot(store, WORKSPACE, snap(2, [B]));
    expect(listed.answered).toEqual([]);
    expect(hidden(listed.store)).toEqual(["a"]);
  });

  it("is not answered by repeated listings that still hold the row", () => {
    let store = deletingA();
    for (let revision = 2; revision < 12; revision += 1) {
      const step = applySessionsSnapshot(store, WORKSPACE, snap(revision, [A, B]));
      expect(step.answered).toEqual([]);
      expect(hidden(step.store)).toEqual(["a"]);
      expect(mutationFor(step.store, WORKSPACE)).toEqual({ kind: "delete" });
      store = step.store;
    }
    expect(names(visibleSessions(store, WORKSPACE))).toEqual(["b"]);
  });

  it("reveals the row when the answer says the delete did not happen", () => {
    const refused = applySessionsSnapshot(
      deletingA(),
      WORKSPACE,
      snap(2, [A, B], { answers: [answer("r1")] }),
    );
    expect(pendingSessionRequests(refused.store)).toEqual([]);
    expect(names(visibleSessions(refused.store, WORKSPACE))).toEqual(["b", "a"]);
  });

  it("settles an older answer without replacing a newer list", () => {
    const store = beginIntent(confirmed([A, B], 5), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const answered = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(2, [B], { answers: [answer("r1")] }),
    );
    expect(answeredIds(answered)).toEqual(["r1"]);
    expect(hidden(answered.store)).toEqual([]);
    expect(names(visibleSessions(answered.store, WORKSPACE))).toEqual(["b", "a"]);
    expect(answered.store.byWorkspace.get(WORKSPACE)!.revision).toBe(5);
  });

  it("ignores an answer to some other request", () => {
    const store = deletingA();
    const other = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(2, [B], { answers: [answer("r9")] }),
    );
    expect(hidden(other.store)).toEqual(["a"]);
  });
});

describe("create intents", () => {
  const creating = (origin: "new-chat" | "duplicate" = "new-chat") =>
    beginIntent(confirmed([A]), WORKSPACE, { requestId: "r1", kind: "create", origin });

  it("locks the workspace from the click, before the daemon has minted anything", () => {
    const store = creating();
    expect(mutationFor(store, WORKSPACE)).toEqual({ kind: "create" });
    expect(names(visibleSessions(store, WORKSPACE))).toEqual(["a"]);
    expect(hasOpenSessionIntent(store)).toBe(true);
  });

  it("settles only on the answer, and reports the session the daemon minted", () => {
    const store = creating();
    const settled = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(2, [A, B], { answers: [answer("r1", "b")] }),
    );
    expect(settled.answered).toHaveLength(1);
    expect(settled.answered[0]!.answer.created).toBe("b");
    expect(settled.answered[0]!.request).toEqual({ kind: "create", origin: "new-chat" });
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
    expect(names(visibleSessions(settled.store, WORKSPACE))).toEqual(["b", "a"]);
  });

  it("is not settled by a listing that happens to contain a session", () => {
    // The reported class of bug for creation: another channel's listing can show a
    // session that is not this request's mint, and the indicator must outlive it.
    const store = creating();
    const listed = applySessionsSnapshot(store, WORKSPACE, snap(2, [A, B]));
    expect(listed.answered).toEqual([]);
    expect(mutationFor(listed.store, WORKSPACE)).toEqual({ kind: "create" });
    expect(hasOpenSessionIntent(listed.store)).toBe(true);
  });

  it("settles on a refusal answer, so a create that never minted cannot lock the workspace", () => {
    const store = creating();
    const refused = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(2, [A], { answers: [answer("r1")] }),
    );
    expect(refused.answered).toHaveLength(1);
    expect(refused.answered[0]!.answer.created).toBeUndefined();
    expect(pendingSessionRequests(refused.store)).toEqual([]);
    expect(hasOpenSessionIntent(refused.store)).toBe(false);
    expect(names(visibleSessions(refused.store, WORKSPACE))).toEqual(["a"]);
  });

  it("keeps the origin a duplicate asked under, so the caller can report it", () => {
    const store = creating("duplicate");
    const settled = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(2, [A, B], { answers: [answer("r1", "b")] }),
    );
    expect(settled.answered[0]!.request).toEqual({ kind: "create", origin: "duplicate" });
  });
});

describe("clear intents", () => {
  it("hides every doomed row and reports the latest ask to the pill", () => {
    const clearing = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "clear",
      names: ["a", "b"],
    });
    expect(hidden(clearing).sort()).toEqual(["a", "b"]);
    expect(mutationFor(clearing, WORKSPACE)).toEqual({ kind: "clear" });

    const settled = applySessionsSnapshot(
      clearing,
      WORKSPACE,
      snap(2, [], { answers: [answer("r1")] }),
    );
    expect(visibleSessions(settled.store, WORKSPACE)).toEqual([]);
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
  });

  it("keeps a protected row visible through the whole clear", () => {
    // A session with a running agent is refused by the daemon, so a row hidden
    // here would blink out and come straight back.
    const clearing = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "clear",
      names: ["a", "b"],
      keep: ["a"],
    });
    expect(hidden(clearing)).toEqual(["b"]);
    expect(names(visibleSessions(clearing, WORKSPACE))).toEqual(["a"]);
    expect(mutationFor(clearing, WORKSPACE)).toEqual({ kind: "clear" });
  });

  it("stays hidden while a slow clear keeps listing the doomed rows", () => {
    // A chunked clear over a big workspace keeps the folders on disk for a while,
    // and every ambient listing in that window still lists them. The rows must not
    // come back until the clear itself answers.
    const clearing = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "clear",
      names: ["a", "b"],
    });
    let store = clearing;
    for (let revision = 2; revision < 8; revision += 1) {
      store = applySessionsSnapshot(store, WORKSPACE, snap(revision, [A, B])).store;
      expect(visibleSessions(store, WORKSPACE)).toEqual([]);
      expect(mutationFor(store, WORKSPACE)).toEqual({ kind: "clear" });
    }
    const settled = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(8, [], { answers: [answer("r1")] }),
    );
    expect(visibleSessions(settled.store, WORKSPACE)).toEqual([]);
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
  });
});

describe("pending requests", () => {
  it("carries the ask a retry has to re-send", () => {
    const store = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "clear",
      names: ["a", "b"],
      keep: ["b"],
    });
    expect(pendingSessionRequests(store)).toEqual([
      {
        workspaceDir: WORKSPACE,
        requestId: "r1",
        request: { kind: "clear", names: ["a"], keep: ["b"] },
        attempts: 0,
      },
    ]);
  });

  it("counts a re-send without settling the request", () => {
    const store = beginIntent(confirmed([A]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const resent = noteIntentAttempt(store, WORKSPACE, "r1");
    expect(pendingSessionRequests(resent)[0]!.attempts).toBe(1);
    expect(hidden(resent)).toEqual(["a"]);
    expect(noteIntentAttempt(resent, WORKSPACE, "gone")).toBe(resent);
  });

  it("reveals the rows it hid when the caller gives up", () => {
    const store = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const abandoned = abandonIntent(store, WORKSPACE, "r1");
    expect(abandoned.abandoned).toBe(true);
    expect(names(visibleSessions(abandoned.store, WORKSPACE))).toEqual(["b", "a"]);
    expect(mutationFor(abandoned.store, WORKSPACE)).toBeNull();
    expect(abandonIntent(abandoned.store, WORKSPACE, "r1").abandoned).toBe(false);
  });

  it("carries the origin of a create so the driver can re-send the right command", () => {
    const store = beginIntent(confirmed([A]), WORKSPACE, {
      requestId: "r1",
      kind: "create",
      origin: "duplicate",
    });
    expect(pendingSessionRequests(store)[0]!.request).toEqual({
      kind: "create",
      origin: "duplicate",
    });
  });

  it("records exactly the request a click sends, for every kind", () => {
    // The click sends `intentRecord(ask)` and the retry re-sends the recorded request.
    // If these two ever differed, a re-send would ask the daemon for something the user
    // never clicked, so pin them together for all three kinds.
    const asks = [
      { kind: "delete", name: "a" },
      { kind: "clear", names: ["a", "b"], keep: ["b"] },
      { kind: "create", origin: "new-chat" },
      { kind: "create", origin: "duplicate" },
    ] as const;
    for (const [index, ask] of asks.entries()) {
      const requestId = `r${index}`;
      const store = beginIntent(confirmed([A, B]), WORKSPACE, { ...ask, requestId });
      expect(pendingSessionRequests(store)[0]!.request).toEqual(
        intentRecord({ ...ask, requestId }),
      );
    }
  });

  it("hides and tells the daemon the same clear set", () => {
    const store = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "clear",
      names: ["a", "b"],
      keep: ["a"],
    });
    // One list: what the sidebar hides and what rides the request.
    expect(pendingSessionRequests(store)[0]!.request).toMatchObject({ names: ["b"] });
    expect(hidden(store)).toEqual(["b"]);
  });
});

describe("hasOpenSessionIntent", () => {
  it("sees an open mutation on ANY workspace, and clears once it settles", () => {
    // The app-global workspace-forget operator has no single channel to ask, so
    // this is the one fact it reads.
    expect(hasOpenSessionIntent(emptySessionsStore())).toBe(false);

    const creating = beginIntent(confirmed([A]), WORKSPACE, {
      requestId: "r1",
      kind: "create",
      origin: "new-chat",
    });
    expect(hasOpenSessionIntent(creating)).toBe(true);

    const settled = applySessionsSnapshot(
      creating,
      WORKSPACE,
      snap(2, [A], { answers: [answer("r1")] }),
    );
    expect(hasOpenSessionIntent(settled.store)).toBe(false);
  });

  it("reports a mutation booked on another workspace too", () => {
    const deleting = beginIntent(confirmed([A]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const other = beginIntent(deleting, "/elsewhere", {
      requestId: "r2",
      kind: "create",
      origin: "new-chat",
    });
    expect(hasOpenSessionIntent(other)).toBe(true);
  });
});

describe("focus reconcile throttle", () => {
  it("refreshes on the first focus, when nothing has been asked yet", () => {
    expect(focusRefreshDue(0, 10_000)).toBe(true);
  });

  it("refreshes again only after the throttle window", () => {
    expect(focusRefreshDue(10_000, 10_000 + FOCUS_REFRESH_THROTTLE_MS - 1)).toBe(false);
    expect(focusRefreshDue(10_000, 10_000 + FOCUS_REFRESH_THROTTLE_MS)).toBe(true);
  });

  it("takes the window as an argument so the caller owns the cadence", () => {
    expect(focusRefreshDue(1_000, 1_500, 250)).toBe(true);
  });
});

describe("clear-all partition", () => {
  it("keeps every running session and dooms the rest", () => {
    // The confirm dialog counts with this split and the request carries it, so a
    // session the dialog promised to keep can never arrive as doomed.
    const { doomed, kept } = clearPartition([A, B], new Set(["a"]));
    expect(doomed).toEqual(["b"]);
    expect(kept).toEqual(["a"]);
  });

  it("dooms every row when nothing is running", () => {
    const { doomed, kept } = clearPartition([A, B]);
    expect(doomed).toEqual(["a", "b"]);
    expect(kept).toEqual([]);
  });

  it("dooms nothing when every session is running", () => {
    const { doomed, kept } = clearPartition([A, B], new Set(["a", "b"]));
    expect(doomed).toEqual([]);
    expect(kept).toEqual(["a", "b"]);
  });
});

describe("request identity", () => {
  it("keeps one intent per request, and a second ask is a second request", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const clearing = beginIntent(deleting, WORKSPACE, {
      requestId: "r2",
      kind: "clear",
      names: ["a", "b"],
    });
    expect(pendingSessionRequests(clearing).map((r) => r.requestId)).toEqual(["r1", "r2"]);

    // Answering the first leaves the second waiting for its own answer.
    const first = applySessionsSnapshot(
      clearing,
      WORKSPACE,
      snap(2, [B], { answers: [answer("r1")] }),
    );
    expect(answeredIds(first)).toEqual(["r1"]);
    expect(pendingSessionRequests(first.store).map((r) => r.requestId)).toEqual(["r2"]);
  });

  it("never reports the same hidden name twice", () => {
    // The UI guards against a repeat, but the store is what the sidebar trusts.
    const once = beginIntent(confirmed([A, B]), WORKSPACE, {
      requestId: "r1",
      kind: "delete",
      name: "a",
    });
    const twice = beginIntent(once, WORKSPACE, { requestId: "r2", kind: "delete", name: "a" });
    expect(hidden(twice)).toEqual(["a"]);
  });
});
