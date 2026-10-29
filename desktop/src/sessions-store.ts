import { type SessionMutationAnswer, sortSessionsByCreationDescending } from "@reasonix/core-utils";
import type { SessionInfo, SessionMutation } from "./App";
import { normalizeWorkspacePath } from "./workspace-path";

/** The request a mutation intent was opened for, exactly as it went on the wire, so
 *  a retry re-sends the same ask instead of inventing a new one. */
export type SessionIntentRequest =
  | { kind: "delete"; name: string }
  | { kind: "clear"; names: readonly string[]; keep: readonly string[] }
  | { kind: "create"; origin: "new-chat" | "duplicate" };

/** A session-list mutation the user asked for and the daemon has not answered.
 *  Intents are the ONLY source of hidden rows, and only the daemon's answer to the
 *  request id below can retire one: no timer, no marker, no per-channel copy. */
export interface SessionIntent {
  /** The request id the daemon echoes in a snapshot's `answers`. */
  requestId: string;
  kind: SessionMutation["kind"];
  /** Names this intent keeps hidden until it settles (empty for a create). */
  hide: readonly string[];
  /** What was asked, so an unanswered request can be re-sent unchanged. */
  request: SessionIntentRequest;
  /** How many times the caller has re-sent it without an answer. */
  attempts: number;
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
  retiredEpochs: ReadonlySet<string>;
  intents: readonly SessionIntent[];
}

export interface SessionsStore {
  byWorkspace: ReadonlyMap<string, SessionsEntry>;
}

export interface SessionsSnapshot {
  epoch: string;
  revision: number;
  items: readonly SessionInfo[];
  /** A cache read, not a scan: it may only be the first word on a workspace. */
  primed?: boolean;
  stale?: boolean;
  /** The requests this snapshot answers. The daemon emits one per mutation. */
  answers?: readonly SessionMutationAnswer[];
}

export interface SnapshotResult {
  store: SessionsStore;
  /** False when nothing the sidebar renders changed, so the caller need not render. */
  changed: boolean;
  /** The intents this snapshot settled, each with the answer that settled it. */
  answered: readonly AnsweredSessionIntent[];
}

/** An intent this snapshot settled, and what the daemon said about it. */
export interface AnsweredSessionIntent {
  request: SessionIntentRequest;
  answer: SessionMutationAnswer;
}

/** One unanswered mutation, with the workspace its answer belongs to. */
export interface PendingSessionRequest {
  workspaceDir: string;
  requestId: string;
  request: SessionIntentRequest;
  attempts: number;
}

/** Minimum gap between focus-driven list reconciles. A window regaining focus is the one
 *  moment this app can notice a session removed outside it, and the throttle keeps a
 *  focus storm from walking the store once per event. */
export const FOCUS_REFRESH_THROTTLE_MS = 5_000;

/** True when a focus event is worth a reconcile: the first one, or one that arrives
 *  outside the throttle window. `lastAt` is 0 before any focus-driven refresh. */
export function focusRefreshDue(
  lastAt: number,
  now: number,
  windowMs: number = FOCUS_REFRESH_THROTTLE_MS,
): boolean {
  if (lastAt <= 0) return true;
  return now - lastAt >= windowMs;
}

/** How a clear-all splits the rows: the names it may delete, and the names the confirm
 *  dialog promises to keep. One rule for both, so the count the dialog shows and the
 *  list the request carries cannot disagree. */
export function clearPartition(
  sessions: readonly { name: string }[],
  running: ReadonlySet<string> | undefined = NO_SESSION_NAMES,
): { doomed: string[]; kept: string[] } {
  const doomed: string[] = [];
  const kept: string[] = [];
  for (const session of sessions) {
    if (running.has(session.name)) kept.push(session.name);
    else doomed.push(session.name);
  }
  return { doomed, kept };
}

const EMPTY_ENTRY: SessionsEntry = {
  raw: [],
  items: [],
  epoch: "",
  revision: 0,
  confirmed: false,
  retiredEpochs: new Set(),
  intents: [],
};

/** Shared "no session is running" set: one instance, so the default argument of a
 *  partition never allocates a set per call. */
const NO_SESSION_NAMES: ReadonlySet<string> = new Set();

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
  return { byWorkspace: new Map() };
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
  return latest === undefined ? null : { kind: latest.kind };
}

/** Every unanswered mutation in the store, oldest first, with the workspace its answer
 *  belongs to. This is the caller's whole retry queue: a request stays here exactly as
 *  long as the daemon has not answered it. */
export function pendingSessionRequests(store: SessionsStore): PendingSessionRequest[] {
  const pending: PendingSessionRequest[] = [];
  for (const [workspaceDir, entry] of store.byWorkspace) {
    for (const intent of entry.intents) {
      pending.push({
        workspaceDir,
        requestId: intent.requestId,
        request: intent.request,
        attempts: intent.attempts,
      });
    }
  }
  return pending;
}

/** Counts one unanswered re-send of `requestId`, so the caller can bound its retries
 *  without keeping a second copy of what is in flight. */
export function noteIntentAttempt(
  store: SessionsStore,
  workspaceDir: string,
  requestId: string,
): SessionsStore {
  return remapIntent(store, workspaceDir, requestId, (intent) => ({
    ...intent,
    attempts: intent.attempts + 1,
  }));
}

/** Retires a request the daemon never answered. The rows it hid come back: a client
 *  that cannot reach its backend cannot claim they are gone. Reports whether anything
 *  was dropped, so the caller only speaks up when it gave something up. */
export function abandonIntent(
  store: SessionsStore,
  workspaceDir: string,
  requestId: string,
): { store: SessionsStore; abandoned: boolean } {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = store.byWorkspace.get(key);
  if (entry === undefined || !entry.intents.some((intent) => intent.requestId === requestId)) {
    return { store, abandoned: false };
  }
  const intents = entry.intents.filter((intent) => intent.requestId !== requestId);
  const next: SessionsEntry = {
    ...entry,
    items: keepRows(entry.items, entry.raw, intents),
    intents,
  };
  return { store: writeEntry(store, key, next), abandoned: true };
}

/** Copy-on-write edit of ONE intent; every intent that is not `requestId` keeps its
 *  identity, so a rerender can still bail out on unchanged rows. */
function remapIntent(
  store: SessionsStore,
  workspaceDir: string,
  requestId: string,
  edit: (intent: SessionIntent) => SessionIntent,
): SessionsStore {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = store.byWorkspace.get(key);
  if (entry === undefined) return store;
  let touched = false;
  const intents = entry.intents.map((intent) => {
    if (intent.requestId !== requestId) return intent;
    touched = true;
    return edit(intent);
  });
  if (!touched) return store;
  return writeEntry(store, key, {
    ...entry,
    intents,
    items: keepRows(entry.items, entry.raw, intents),
  });
}

/** True while ANY workspace holds an open intent. App-global operators (forgetting a
 *  recent workspace, which closes every tab on that path) have no single channel to
 *  ask, so they read this instead of guessing per channel. */
export function hasOpenSessionIntent(store: SessionsStore): boolean {
  for (const entry of store.byWorkspace.values()) {
    if (entry.intents.length > 0) return true;
  }
  return false;
}

/** What the user asked a session mutation to do, before it has an id. `kind` decides
 *  which fields exist, so a delete cannot arrive without its name, a clear without the
 *  names it clears, and a create without saying which chat it opens. */
export type SessionMutationAsk =
  | { kind: "delete"; name: string }
  | { kind: "clear"; names: readonly string[]; keep?: readonly string[] }
  | { kind: "create"; origin: "new-chat" | "duplicate" };

/** The record an ask goes on the wire as. ONE definition: `beginIntent` stores what this
 *  returns and the click sends what this returns, so the request the user's click makes
 *  and the request a retry repeats cannot disagree. A clear records the names it dooms,
 *  already minus the ones it promised to keep. */
export function intentRecord(
  ask: SessionMutationAsk & { requestId: string },
): SessionIntentRequest {
  if (ask.kind === "delete") return { kind: "delete", name: ask.name };
  if (ask.kind === "clear") {
    const keep = new Set(ask.keep ?? []);
    return { kind: "clear", names: ask.names.filter((n) => !keep.has(n)), keep: [...keep] };
  }
  return { kind: "create", origin: ask.origin };
}

/** Records a mutation the user asked for, under the request id the daemon will answer.
 *  `delete` hides one name, `clear` hides every name the request dooms, `create` hides
 *  nothing and waits for its own answer. */
export function beginIntent(
  store: SessionsStore,
  workspaceDir: string | undefined,
  ask: SessionMutationAsk & { requestId: string },
): SessionsStore {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = entryFor(store, key);
  const request = intentRecord(ask);
  // Read off the record, never off the ask: what the sidebar hides and what the daemon
  // is told are the same list, so neither can be the odd one out.
  const hide =
    request.kind === "delete" ? [request.name] : request.kind === "clear" ? request.names : [];
  const intent: SessionIntent = {
    requestId: ask.requestId,
    kind: ask.kind,
    hide,
    request,
    attempts: 0,
  };
  const intents = [...entry.intents, intent];
  const next: SessionsEntry = {
    ...entry,
    items: keepRows(entry.items, entry.raw, intents),
    intents,
  };
  return writeEntry(store, key, next);
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

function sameIntentIdentity(a: readonly SessionIntent[], b: readonly SessionIntent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((intent, index) => intent === b[index]);
}

/** Folds one `$sessions` snapshot into the store. Only `answers` retires an intent: a
 *  listing that still holds a hidden name, or that happens to list a session nobody
 *  asked about, is some other request's truth, never this one's. */
export function applySessionsSnapshot(
  store: SessionsStore,
  workspaceDir: string | undefined,
  snapshot: SessionsSnapshot,
): SnapshotResult {
  const key = normalizeWorkspacePath(workspaceDir);
  const entry = entryFor(store, key);
  if (entry.retiredEpochs.has(snapshot.epoch)) return { store, changed: false, answered: [] };

  if (snapshot.primed === true) {
    if (entry.revision > 0 || (entry.epoch && entry.epoch !== snapshot.epoch)) {
      return { store, changed: false, answered: [] };
    }
    const items = keepRows(entry.items, snapshot.items, entry.intents);
    const sameEpoch = entry.epoch === snapshot.epoch;
    const sameRaw = sameSessionRows(entry.raw, snapshot.items);
    if (sameEpoch && sameRaw && items === entry.items) {
      return { store, changed: false, answered: [] };
    }
    const next: SessionsEntry = {
      ...entry,
      raw: [...snapshot.items],
      items,
      epoch: snapshot.epoch,
    };
    return { store: writeEntry(store, key, next), changed: items !== entry.items, answered: [] };
  }

  const epochChanged = entry.epoch !== snapshot.epoch;
  const answers = new Map((snapshot.answers ?? []).map((answer) => [answer.requestId, answer]));
  // A new daemon lifetime can never answer a request recorded against the old one.
  const answered: AnsweredSessionIntent[] = epochChanged
    ? []
    : entry.intents.flatMap((intent) => {
        const answer = answers.get(intent.requestId);
        return answer === undefined ? [] : [{ request: intent.request, answer }];
      });
  const newer = epochChanged || snapshot.revision > entry.revision;
  if (!newer && answered.length === 0) {
    return { store, changed: false, answered: [] };
  }

  const openIntents: SessionIntent[] = [];
  if (!epochChanged) {
    const settled = new Set(answered.map((entryAnswer) => entryAnswer.answer.requestId));
    for (const intent of entry.intents) {
      if (!settled.has(intent.requestId)) openIntents.push(intent);
    }
  }
  const useSnapshot = newer && (!snapshot.stale || entry.revision === 0 || epochChanged);
  const raw = useSnapshot ? [...snapshot.items] : entry.raw;
  const items = keepRows(entry.items, raw, openIntents);
  const confirmed = newer ? snapshot.stale !== true : entry.confirmed;
  const next: SessionsEntry = {
    raw,
    items,
    epoch: snapshot.epoch,
    revision: epochChanged ? snapshot.revision : Math.max(entry.revision, snapshot.revision),
    confirmed,
    retiredEpochs:
      epochChanged && entry.epoch
        ? new Set([...entry.retiredEpochs, entry.epoch])
        : entry.retiredEpochs,
    intents: openIntents,
  };
  return {
    store: writeEntry(store, key, next),
    changed:
      items !== entry.items ||
      entry.confirmed !== confirmed ||
      !sameIntentIdentity(entry.intents, openIntents),
    answered,
  };
}
