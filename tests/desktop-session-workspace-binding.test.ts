import { describe, expect, it } from "vitest";
import { adoptableRestoredSession, channelServingSession } from "../src/cli/commands/desktop.js";

// The reported bug: a `local`-workspace tab held a session that its own meta
// stamped to another workspace, so clicking that session in its real workspace
// re-focused the local tab instead (six times in the user's diagnostics log).
const LOCAL = "/proj/local";
const PROJECT = "/proj";

/** Inject the matcher so the rule is testable on any platform (the default
 *  resolver normalizes real filesystem paths). */
const sameDir = (a: string, b: string) => a === b;

describe("channelServingSession — a session is served only by its own workspace", () => {
  it("ignores a channel holding the session from another workspace", () => {
    const channels = [
      { id: "t590", currentSession: "desktop-1", rootDir: LOCAL },
      { id: "t594", currentSession: "desktop-2", rootDir: PROJECT },
    ];
    expect(channelServingSession(channels, "desktop-1", PROJECT, sameDir)).toBeUndefined();
    expect(channelServingSession(channels, "desktop-1", LOCAL, sameDir)?.id).toBe("t590");
  });

  it("still finds the channel when the session is open where it belongs", () => {
    const channels = [
      { id: "t1", currentSession: "desktop-1", rootDir: PROJECT },
      { id: "t2", currentSession: "desktop-2", rootDir: PROJECT },
    ];
    expect(channelServingSession(channels, "desktop-2", PROJECT, sameDir)?.id).toBe("t2");
  });

  it("returns nothing for a session no channel holds", () => {
    const channels = [{ id: "t1", currentSession: "desktop-1", rootDir: PROJECT }];
    expect(channelServingSession(channels, "desktop-9", PROJECT, sameDir)).toBeUndefined();
  });

  it("normalizes the paths with its default matcher", () => {
    // The default matcher is the daemon's own comparison, so a trailing or
    // duplicated separator must not make an owned session look foreign.
    const channels = [{ id: "t1", currentSession: "desktop-1", rootDir: "/proj" }];
    expect(channelServingSession(channels, "desktop-1", "/proj/")?.id).toBe("t1");
    expect(channelServingSession(channels, "desktop-1", "/proj//")?.id).toBe("t1");
    expect(channelServingSession(channels, "desktop-1", "/other")?.id).toBeUndefined();
  });
});

describe("adoptableRestoredSession — restore never resurrects a foreign binding", () => {
  const deps = {
    exists: (name: string) => name !== "deleted",
    // Undefined = the session predates workspace stamps.
    workspaceOf: (name: string) =>
      name === "foreign" ? LOCAL : name === "legacy" ? undefined : PROJECT,
  };

  it("adopts a session this workspace owns", () => {
    expect(adoptableRestoredSession("owned", PROJECT, deps)).toBe("owned");
  });

  it("refuses a session another workspace owns", () => {
    // Adopting it again would re-persist the crossed pair on every boot.
    expect(adoptableRestoredSession("foreign", PROJECT, deps)).toBeUndefined();
  });

  it("adopts an unstamped legacy session", () => {
    // Pre-workspace-stamp sessions are claimed by the tab that loads them.
    expect(adoptableRestoredSession("legacy", PROJECT, deps)).toBe("legacy");
  });

  it("refuses a session that no longer exists", () => {
    expect(adoptableRestoredSession("deleted", PROJECT, deps)).toBeUndefined();
    expect(adoptableRestoredSession(undefined, PROJECT, deps)).toBeUndefined();
  });
});
