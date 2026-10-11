/** Canonical on-disk layout of a session: one folder per chat under `~/.reasonix/sessions/<name>/` (pure path math, shared by the sync core and the async index). */

import { join } from "node:path";
import { sanitizeFilename } from "@reasonix/core-utils";
import { reasonixHome } from "../reasonix-home.js";

/** Chat transcript (JSONL, append-only) — a folder without it (or with an empty
 *  one) is an empty session and is invisible to listings. */
export const SESSION_MESSAGES_FILENAME = "messages.jsonl";
/** Per-session metadata (workspace, cost, model prefs, …). */
export const SESSION_META_FILENAME = "meta.json";
/** Per-session event sidecar log. */
export const SESSION_EVENTS_FILENAME = "events.jsonl";
/** UI annotation cards (notice + warning) persisted so no transcript card is
 *  transient — a single JSON array replaced on every notices_sync. */
export const SESSION_NOTICES_FILENAME = "notices.json";
/** Legacy per-session plan file — read once to migrate into plans/history.json. */
export const SESSION_PLAN_FILENAME = "plan.json";
/** Plan storage: holds the unified `history.json` plus legacy `.done.json` archives. */
export const SESSION_PLANS_DIRNAME = "plans";

export function sessionsRootDir(): string {
  return join(reasonixHome(), "sessions");
}

/** Historical name for the sessions root — kept because every caller (session.ts,
 *  the plan repository, tests) already imports it by this name. */
export function sessionsDir(): string {
  return sessionsRootDir();
}

export function sanitizeName(name: string): string {
  return sanitizeFilename(name, { max: 64, fallback: "default", allowCjk: true });
}

/** The session's folder — everything about one chat lives inside it. */
export function sessionDir(name: string): string {
  return join(sessionsRootDir(), sanitizeName(name));
}

export function sessionMessagesPath(name: string): string {
  return join(sessionDir(name), SESSION_MESSAGES_FILENAME);
}

export function sessionMetaPath(name: string): string {
  return join(sessionDir(name), SESSION_META_FILENAME);
}

export function sessionEventsPath(name: string): string {
  return join(sessionDir(name), SESSION_EVENTS_FILENAME);
}

export function sessionNoticesPath(name: string): string {
  return join(sessionDir(name), SESSION_NOTICES_FILENAME);
}

export function sessionPlanPath(name: string): string {
  return join(sessionDir(name), SESSION_PLAN_FILENAME);
}

export function sessionPlansDir(name: string): string {
  return join(sessionDir(name), SESSION_PLANS_DIRNAME);
}
