import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const daemon = readFileSync(join(process.cwd(), "src/cli/commands/desktop.ts"), "utf8");
const emitSessions = daemon.slice(
  daemon.indexOf("async function emitSessions("),
  daemon.indexOf("function loadSessionIntoTab("),
);

describe("desktop — a listing that cannot revalidate degrades instead of alarming", () => {
  it("keeps the sidebar on the last list the daemon knows", () => {
    expect(emitSessions).toContain("listSessionsForWorkspaceLastKnown(");
    expect(emitSessions).toContain("stale: true");
    // A degraded paint still answers the mutation it was asked to report, or the row
    // the user deleted would keep its indicator forever.
    expect(emitSessions).toContain("...(answers === undefined ? {} : { answers })");
  });

  it("only reports an error when there is no list to show", () => {
    // The fallback has to be tried before the card, not beside it.
    expect(emitSessions.indexOf("listSessionsForWorkspaceLastKnown(")).toBeLessThan(
      emitSessions.indexOf('type: "$error"'),
    );
    expect(emitSessions).toContain('emitTabDiagnostic(tab, "sessions.list.degraded"');
  });

  it("publishes an unverified snapshot even without a fallback", () => {
    // An empty degraded paint still tells the client the workspace list is not verified,
    // which beats leaving whatever it held looking fresh.
    expect(emitSessions).toContain("lastKnown === null ? [] : toSessionListItems(lastKnown)");
    expect(
      emitSessions.indexOf('type: "$sessions"', emitSessions.indexOf("catch (err)")),
    ).toBeLessThan(emitSessions.indexOf('type: "$error"'));
  });

  it("opens one card per channel, not one per retry", () => {
    expect(emitSessions).toContain("if (sessionsListFailureNotified.has(tab.id)) return;");
    // A listing that succeeds again clears the gate for the next failure.
    expect(emitSessions).toContain("sessionsListFailureNotified.delete(tab.id);");
  });
});
