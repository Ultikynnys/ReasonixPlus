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
