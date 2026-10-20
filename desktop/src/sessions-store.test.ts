import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./App";
import {
  INTENT_ESCAPE_SNAPSHOTS,
  type SessionIntent,
  type SessionsStore,
  applySessionsSnapshot,
  beginIntent,
  derivedItems,
  emptySessionsStore,
  hiddenNames,
  mutationFor,
  openIntentId,
  visibleSessions,
} from "./sessions-store";

const WORKSPACE = "/repo";

function session(name: string, createdAt: number): SessionInfo {
  return { name, messageCount: 1, mtime: new Date(createdAt).toISOString(), createdAt };
}

const A = session("a", 1_000);
const B = session("b", 2_000);

function snap(
  revision: number,
  items: readonly SessionInfo[],
  extra: {
    epoch?: string;
    primed?: boolean;
    settledDeletes?: { name: string; removed: boolean }[];
  } = {},
) {
  return {
    epoch: extra.epoch ?? "daemon-1",
    revision,
    items,
    primed: extra.primed,
    settledDeletes: extra.settledDeletes,
  };
}

function confirmed(items: readonly SessionInfo[], revision = 1): SessionsStore {
  return applySessionsSnapshot(emptySessionsStore(), WORKSPACE, snap(revision, items)).store;
}

function names(rows: readonly SessionInfo[]): string[] {
  return rows.map((row) => row.name);
}

function intentOf(store: SessionsStore): readonly SessionIntent[] {
  return store.byWorkspace.get(WORKSPACE)?.intents ?? [];
}

describe("derivedItems", () => {
  it("applies every intent's hide and sorts newest-created first", () => {
    const rows = derivedItems(
      [A, B],
      [
        {
          id: 1,
          kind: "delete",
          hide: ["a"],
          requestedRevision: 0,
          unconfirmed: 0,
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

  it("takes a new epoch wholesale and drops intents the old daemon never settled", () => {
    const deleting = beginIntent(confirmed([A]), WORKSPACE, { kind: "delete", name: "a" });
    expect(hiddenNames(deleting, WORKSPACE)).toEqual(["a"]);

    const rebooted = applySessionsSnapshot(
      deleting,
      WORKSPACE,
      snap(1, [A], { epoch: "daemon-2" }),
    );
    expect(intentOf(rebooted.store)).toEqual([]);
    expect(names(visibleSessions(rebooted.store, WORKSPACE))).toEqual(["a"]);
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
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
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
  it("settles when the newer snapshot no longer lists the name", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
    expect(names(visibleSessions(deleting, WORKSPACE))).toEqual(["b"]);

    const settled = applySessionsSnapshot(deleting, WORKSPACE, snap(2, [B]));
    expect(intentOf(settled.store)).toEqual([]);
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
    expect(hiddenNames(settled.store, WORKSPACE)).toEqual([]);
  });

  it("reveals the row when the daemon reports the delete failed", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
    const failed = applySessionsSnapshot(
      deleting,
      WORKSPACE,
      snap(2, [A, B], { settledDeletes: [{ name: "a", removed: false }] }),
    );
    expect(intentOf(failed.store)).toEqual([]);
    expect(names(visibleSessions(failed.store, WORKSPACE))).toEqual(["b", "a"]);
  });

  it("does not settle on a snapshot that predates the request", () => {
    const deleting = beginIntent(confirmed([A, B], 5), WORKSPACE, { kind: "delete", name: "a" });
    const inFlight = applySessionsSnapshot(deleting, WORKSPACE, snap(5, [A, B]));
    expect(inFlight.changed).toBe(false);
    expect(hiddenNames(inFlight.store, WORKSPACE)).toEqual(["a"]);
  });
});

describe("create intents", () => {
  it("waits for the named session, and an unrelated refresh does not settle it", () => {
    const creating = beginIntent(confirmed([A]), WORKSPACE, { kind: "create", name: "b" });
    expect(mutationFor(creating, WORKSPACE)).toEqual({ kind: "create", awaitingName: "b" });

    const unrelated = applySessionsSnapshot(creating, WORKSPACE, snap(2, [A]));
    expect(mutationFor(unrelated.store, WORKSPACE)).toEqual({ kind: "create", awaitingName: "b" });

    const landed = applySessionsSnapshot(unrelated.store, WORKSPACE, snap(3, [A, B]));
    expect(mutationFor(landed.store, WORKSPACE)).toBeNull();
  });
});

describe("bounded escape", () => {
  it("drops a hide only after the daemon keeps listing the session", () => {
    const deleting = beginIntent(confirmed([A, B], 1), WORKSPACE, { kind: "delete", name: "a" });
    let store = deleting;
    for (let revision = 2; revision < 1 + INTENT_ESCAPE_SNAPSHOTS; revision += 1) {
      const step = applySessionsSnapshot(store, WORKSPACE, snap(revision, [A, B]));
      expect(step.escaped).toEqual([]);
      expect(hiddenNames(step.store, WORKSPACE)).toEqual(["a"]);
      store = step.store;
    }

    const escaped = applySessionsSnapshot(
      store,
      WORKSPACE,
      snap(1 + INTENT_ESCAPE_SNAPSHOTS, [A, B]),
    );
    expect(escaped.escaped).toHaveLength(1);
    expect(names(visibleSessions(escaped.store, WORKSPACE))).toEqual(["b", "a"]);
    expect(hiddenNames(escaped.store, WORKSPACE)).toEqual([]);
  });
});

describe("clear intents", () => {
  it("hides every row on screen and reports the latest ask to the pill", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
    const clearing = beginIntent(deleting, WORKSPACE, { kind: "clear" });
    expect(hiddenNames(clearing, WORKSPACE).sort()).toEqual(["a", "b"]);
    expect(mutationFor(clearing, WORKSPACE)).toEqual({ kind: "clear" });

    const settled = applySessionsSnapshot(clearing, WORKSPACE, snap(2, []));
    expect(visibleSessions(settled.store, WORKSPACE)).toEqual([]);
    expect(mutationFor(settled.store, WORKSPACE)).toBeNull();
  });
});

describe("open intent identity", () => {
  it("advances per intent so a caller reconciles once for each", () => {
    const deleting = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
    const first = openIntentId(deleting, WORKSPACE);
    expect(first).not.toBeNull();

    // A follow-up ask gets its own id, so the reconciliation driver fires again.
    const clearing = beginIntent(deleting, WORKSPACE, { kind: "clear" });
    expect(openIntentId(clearing, WORKSPACE)).not.toBe(first);

    // Settled: there is nothing left to reconcile.
    const settled = applySessionsSnapshot(clearing, WORKSPACE, snap(2, []));
    expect(openIntentId(settled.store, WORKSPACE)).toBeNull();
  });

  it("never reports the same hidden name twice", () => {
    // The UI guards against a repeat, but the store is what the sidebar trusts.
    const once = beginIntent(confirmed([A, B]), WORKSPACE, { kind: "delete", name: "a" });
    const twice = beginIntent(once, WORKSPACE, { kind: "delete", name: "a" });
    expect(hiddenNames(twice, WORKSPACE)).toEqual(["a"]);
  });
});
