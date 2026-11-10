import { flattenText } from "@reasonix/core-utils";

/** Where the daemon stops a session title, and where the row's editor stops typing. */
export const SESSION_TITLE_MAX = 200;

/** THE session-title rule: whitespace collapsed to single spaces and trimmed, then
 *  capped. The row's inline editor and the rename patch share it, so the title the
 *  editor shows and the title the daemon stores cannot disagree. */
export function sessionTitle(input: string): string {
  return flattenText(input).slice(0, SESSION_TITLE_MAX);
}
