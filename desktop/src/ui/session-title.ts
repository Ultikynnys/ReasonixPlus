import { t } from "../i18n";

/** The one human label for a session, shared by the sidebar rows and the plan
 *  section's owner label so both surfaces name a session identically. */
export function sessionTitle(session: { name: string; summary?: string }): string {
  if (session.summary?.trim()) return session.summary.trim();
  // Session names are `desktop-<14-digit timestamp>-<tabCounter>` with an
  // optional `-N` dedupe suffix when two chats mint in the same second —
  // match the timestamp first, then let the trailing counters fall through.
  const m = session.name.match(
    /^desktop-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:\d{2})?-(\d+)(?:-\d+)?$/,
  );
  if (m) {
    const [, , month, day, hh, mm, tab] = m;
    return `${t("sidebarPanel.sessionTitle", {
      month,
      day,
      hour: hh,
      minute: mm,
    })}${tab && tab !== "1" ? ` · #${tab}` : ""}`;
  }
  return session.name.replace(/^desktop-/, "").replace(/[-_]+/g, " ");
}
