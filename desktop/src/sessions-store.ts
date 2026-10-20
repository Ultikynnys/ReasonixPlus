import { sortSessionsByCreationDescending } from "@reasonix/core-utils";
import type { SessionInfo, SessionMutation } from "./App";
import { normalizeWorkspacePath } from "./workspace-path";

/** A session-list mutation the user asked for and the daemon has not confirmed.
 *  Intents are the ONLY source of hidden rows: no timer, no per-channel copy. */
export interface SessionIntent {
  id: number;
  kind: SessionMutation["kind"];
  /** Names this intent keeps hidden until it settles (empty for a create). */
  hide: readonly string[];
  /** Create only: the session that must be listed before the intent settles. */
  expectName?: string;
  /** Entry revision observed when the intent was recorded; a snapshot can only
   *  settle it by being strictly newer than this. */
  requestedRevision: number;
  /** Newer snapshots that left it unsettled, for the bounded escape. */
  unconfirmed: number;
}

/** One workspace's list. Every channel on that workspace reads THIS, so no
 *  channel can hold a list the others disagree with. */
export interface SessionsEntry {
  /** Last accepted authoritative list, hidden names included. */
  raw: readonly SessionInfo[];
  /** The rows the sidebar renders: `raw` minus every open hide, sorted. */
  items: SessionInfo[];
  epoch: string;
  /** Highest snapshot revision applied; 0 until a real snapshot establishes it. */
  revision: number;
  /** True once an authoritative snapshot (not a primed cache read) landed. */
  confirmed: boolean;
  intents: readonly SessionIntent[];
}

export interface SessionsStore {
  byWorkspace: ReadonlyMap<string, SessionsEntry>;
  nextIntentId: number;
}

export interface SessionsSnapshot {
  epoch: string;
  revision: number;
  items: readonly SessionInfo[];
  /** A cache read, not a scan: it may only be the first word on a workspace. */
  primed?: boolean;
  settledDeletes?: readonly { name: string; removed: boolean }[];
}

export interface SnapshotResult {
  store: SessionsStore;
  /** False when nothing the sidebar renders changed, so the caller need not render. */
  changed: boolean;
  /** Intents dropped by the bounded escape; the caller owes one fresh list request. */
  escaped: readonly SessionIntent[];
}

/** How many later listings may still show a hidden name before the hide is dropped.
 *  Dropping it then is truthful: the daemon has asserted that many times that the
 *  session is alive, and a row that cannot be hidden forever beats a stuck sidebar. */
export const INTENT_ESCAPE_SNAPSHOTS = 3;

const EMPTY_ENTRY: SessionsEntry = {
  raw: [],
  items: [],
  epoch: "",
  revision: 0,
  confirmed: false,
  intents: [],
};

/** True when two lists hold the same rows with the same metadata, so a caller can
 *  keep the previous array reference and a memoized sidebar can bail out. */
function sameSessionRows(a: readonly SessionInfo[], b: readonly SessionInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.name !== right.name ||
      left.messageCount !== right.messageCount ||
      left.mtime !== right.mtime ||
      left.updatedAt !== right.updatedAt ||
      left.createdAt !== right.createdAt ||
      left.summary !== right.summary ||
      left.workspaceStatus !== right.workspaceStatus
    ) {
      return false;
    }
  }
  return true;
}

/** Every name any open intent hides. One construction, so no caller can disagree
 *  with the visibility rule about what "hidden" means. */
function hiddenSet(intents: readonly SessionIntent[]): Set<string> {
  const hidden = new Set<string>();
  for (const intent of intents) {
    for (const name of intent.hide) hidden.add(name);
  }
  return hidden;
}

/** THE visibility rule: the authoritative list minus every open hide, newest-created
 *  first. Nothing else may filter or reorder rows for the sidebar. */
export function derivedItems(
  raw: readonly SessionInfo[],
  intents: readonly SessionIntent[],
): SessionInfo[] {
  const hidden = hiddenSet(intents);
  // One row per name, first occurrence wins: the store never trusts the wire to
  // be duplicate-free, and an empty session is still a real row.
  const seen = new Set<string>();
  const rows: SessionInfo[] = [];
  for (const row of raw) {
    if (hidden.has(row.name) || seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
  }
  return rows.sort(sortSessionsByCreationDescending);
}

/** The rows `raw` yields under `intents`, reusing `previous` when they are equal —
 *  the single place that decides whether the sidebar gets a new array. */
function keepRows(
  previous: SessionInfo[],
  raw: readonly SessionInfo[],
  intents: readonly SessionIntent[],
): SessionInfo[] {
  const next = derivedItems(raw, intents);
  return sameSessionRows(previous, next) ? previous : next;
}

function entryFor(store: SessionsStore, key: string): SessionsEntry {
  return store.byWorkspace.get(key) ?? EMPTY_ENTRY;
}

/** Copy-on-write publish: the one place a workspace entry reaches the map. */
function writeEntry(store: SessionsStore, key: string, entry: SessionsEntry): SessionsStore {
  const byWorkspace = new Map(store.byWorkspace);
  byWorkspace.set(key, entry);
  return { ...store, byWorkspace };
}

/** The user's most recent ask for this workspace, or undefined when it is settled. */
function latestIntent(store: SessionsStore, workspaceDir?: string): SessionIntent | undefined {
  const intents = sessionsEntry(store, workspaceDir).intents;
  return intents[intents.length - 1];
}

export function emptySessionsStore(): SessionsStore {
  return { byWorkspace: new Map(), nextIntentId: 0 };
}

export function sessionsEntry(store: SessionsStore, workspaceDir?: string): SessionsEntry {
  return entryFor(store, normalizeWorkspacePath(workspaceDir));
}

export function visibleSessions(store: SessionsStore, workspaceDir?: string): SessionInfo[] {
  return sessionsEntry(store, workspaceDir).items;
}

/** Every name currently hidden by an open intent, deduplicated. */
export function hiddenNames(store: SessionsStore, workspaceDir?: string): string[] {
  return [...hiddenSet(sessionsEntry(store, workspaceDir).intents)];
}

/** The in-flight mutation the progress pill reports: the user's most recent ask. */
export function mutationFor(store: SessionsStore, workspaceDir?: string): SessionMutation | null {
  const latest = latestIntent(store, workspaceDir);
  if (latest === undefined) return null;
  if (latest.kind === "create") return { kind: "create", awaitingName: latest.expectName };
  return { kind: latest.kind };
}

/** Identifies the open mutation so a caller can act once per intent (a stuck-hide
 *  reconciliation must not re-request on every snapshot). */
export function openIntentId(store: SessionsStore, workspaceDir?: string): number | null {
  return latestIntent(store, workspaceDir)?.id ?? null;
}

/** Records a mutation the user asked for. `delete` hides one name, `clear` hides
 *  everything on screen, `create` hides nothing and waits for its session to list. */
export function beginIntent(
  store: SessionsStore,
  workspaceDir: string | undefined,
  request: { kind: SessionMutation["kind"]; name?: string },
): SessionsStore {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = entryFor(store, key);
  const id = store.nextIntentId + 1;
  const hide =
    request.kind === "delete"
      ? request.name === undefined
        ? []
        : [request.name]
      : request.kind === "clear"
        ? entry.items.map((row) => row.name)
        : [];
  const intent: SessionIntent = {
    id,
    kind: request.kind,
    hide,
    expectName: request.kind === "create" ? request.name : undefined,
    requestedRevision: entry.revision,
    unconfirmed: 0,
  };
  const intents = [...entry.intents, intent];
  const next: SessionsEntry = {
    ...entry,
    items: keepRows(entry.items, entry.raw, intents),
    intents,
  };
  return { ...writeEntry(store, key, next), nextIntentId: id };
}

/** Applies an optimistic row edit (rename, reorder) to the shared list. The next
 *  authoritative snapshot overwrites it with whatever the daemon persisted. */
export function patchSession(
  store: SessionsStore,
  workspaceDir: string | undefined,
  name: string,
  patch: Partial<SessionInfo>,
): SessionsStore {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = store.byWorkspace.get(key);
  if (entry === undefined) return store;
  let touched = false;
  const raw = entry.raw.map((row) => {
    if (row.name !== name) return row;
    touched = true;
    return { ...row, ...patch };
  });
  if (!touched) return store;
  const next: SessionsEntry = { ...entry, raw, items: keepRows(entry.items, raw, entry.intents) };
  return writeEntry(store, key, next);
}

/** True when `snapshot` answers `intent` on content alone: the name it hides is gone,
 *  or the snapshot settles it explicitly; a create needs its session listed. */
function settledByContent(intent: SessionIntent, snapshot: SessionsSnapshot): boolean {
  if (intent.kind === "create") {
    if (intent.expectName === undefined) return true;
    return snapshot.items.some((item) => item.name === intent.expectName);
  }
  const listed = new Set(snapshot.items.map((item) => item.name));
  const settled = new Set((snapshot.settledDeletes ?? []).map((result) => result.name));
  return intent.hide.every((name) => !listed.has(name) || settled.has(name));
}

function sameIntentIdentity(a: readonly SessionIntent[], b: readonly SessionIntent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((intent, index) => intent === b[index]);
}

/** Folds one `$sessions` snapshot into the store.
 *
 *  A primed (cache) payload may only initialise a workspace with no authoritative
 *  snapshot yet and never advances a revision, so it cannot outrank a settled scan.
 *  An authoritative payload applies when the epoch changed (a restart, where disk is
 *  the only truth) or when its revision is newer; otherwise it is a stale result. */
export function applySessionsSnapshot(
  store: SessionsStore,
  workspaceDir: string | undefined,
  snapshot: SessionsSnapshot,
): SnapshotResult {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = entryFor(store, key);

  if (snapshot.primed === true) {
    if (entry.confirmed) return { store, changed: false, escaped: [] };
    const items = keepRows(entry.items, snapshot.items, entry.intents);
    const sameEpoch = entry.epoch === snapshot.epoch;
    const sameRaw = sameSessionRows(entry.raw, snapshot.items);
    if (sameEpoch && sameRaw && items === entry.items) {
      return { store, changed: false, escaped: [] };
    }
    const next: SessionsEntry = {
      ...entry,
      raw: [...snapshot.items],
      items,
      epoch: snapshot.epoch,
    };
    return { store: writeEntry(store, key, next), changed: items !== entry.items, escaped: [] };
  }

  const epochChanged = entry.epoch !== snapshot.epoch;
  if (!epochChanged && entry.confirmed && snapshot.revision <= entry.revision) {
    return { store, changed: false, escaped: [] };
  }

  const intents: SessionIntent[] = [];
  const escaped: SessionIntent[] = [];
  // A new daemon lifetime cannot confirm an intent recorded against the old one:
  // disk is the only truth left, and hiding a row the restarted daemon lists would
  // be a lie the frontend could never resolve.
  let intentsChanged = epochChanged;
  if (!epochChanged) {
    for (const intent of entry.intents) {
      // A snapshot older than the request cannot answer it.
      if (snapshot.revision <= intent.requestedRevision) {
        intents.push(intent);
        continue;
      }
      if (settledByContent(intent, snapshot)) {
        intentsChanged = true;
        continue;
      }
      const unconfirmed = intent.unconfirmed + 1;
      if (unconfirmed >= INTENT_ESCAPE_SNAPSHOTS) {
        escaped.push(intent);
        intentsChanged = true;
        continue;
      }
      intents.push({ ...intent, unconfirmed });
      intentsChanged = true;
    }
  }

  const openIntents = intentsChanged ? intents : entry.intents;
  const items = keepRows(entry.items, snapshot.items, openIntents);
  const next: SessionsEntry = {
    raw: [...snapshot.items],
    items,
    epoch: snapshot.epoch,
    revision: snapshot.revision,
    confirmed: true,
    intents: openIntents,
  };
  return {
    store: writeEntry(store, key, next),
    changed: items !== entry.items || !sameIntentIdentity(entry.intents, openIntents),
    escaped,
  };
}
