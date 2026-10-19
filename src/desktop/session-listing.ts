import type { SessionsEvent } from "@reasonix/core-utils";
import type { SessionInfo } from "../memory/session.js";

/** One row of the sidebar's session list, exactly as it crosses the wire. */
export type SessionListItem = SessionsEvent["items"][number];

/** Projects workspace sessions onto the wire shape the sidebar renders. */
export function toSessionListItems(sessions: readonly SessionInfo[]): SessionListItem[] {
  return sessions.map((session) => ({
    name: session.name,
    messageCount: session.messageCount,
    mtime: session.mtime.toISOString(),
    updatedAt: session.meta.updatedAt,
    createdAt: session.createdAt,
    summary: session.meta.summary,
    workspaceStatus: session.workspaceStatus,
  }));
}

/** True when the cache-primed list already carries the authoritative values, so a
 *  second revision would only churn the sidebar. Order counts: the list is sorted. */
export function sameSessionListItems(
  a: readonly SessionListItem[],
  b: readonly SessionListItem[],
): boolean {
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
