import { describe, expect, it } from "vitest";
import { toSessionListItems } from "../src/desktop/session-listing.js";
import type { SessionInfo } from "../src/memory/session.js";

// Priming is now subordinate on the wire (`$sessions.primed`), so it never needs a
// "did the cache match the scan?" comparison: the client ignores a primed payload
// once a workspace is confirmed. What still matters here is the projection itself.
function session(name: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name,
    path: `C:\\sessions\\${name}`,
    size: 10,
    messageCount: 2,
    mtime: new Date("2026-01-02T03:04:05.000Z"),
    meta: {
      workspace: "C:\\ws",
      summary: "Title",
      updatedAt: 1_700_000_000_000,
      createdAt: 1_600_000_000_000,
    },
    createdAt: 1_600_000_000_000,
    lastActive: 1_700_000_000_000,
    workspaceStatus: "matched",
    ...overrides,
  };
}

describe("session list projection", () => {
  it("projects sessions onto exactly the fields the sidebar renders", () => {
    const [item] = toSessionListItems([session("one")]);
    expect(item).toEqual({
      name: "one",
      messageCount: 2,
      mtime: "2026-01-02T03:04:05.000Z",
      updatedAt: 1_700_000_000_000,
      createdAt: 1_600_000_000_000,
      summary: "Title",
      workspaceStatus: "matched",
    });
    // Not a leak of the daemon-side record: paths, sizes and whole meta stay out.
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "createdAt",
      "messageCount",
      "mtime",
      "name",
      "summary",
      "updatedAt",
      "workspaceStatus",
    ]);
  });

  it("carries the meta stamps the sidebar sorts and labels by", () => {
    const [item] = toSessionListItems([
      session("one", {
        createdAt: 1_600_000_000_001,
        lastActive: 1_700_000_000_009,
        meta: {
          workspace: "C:\\ws",
          summary: "Title",
          updatedAt: 1_700_000_000_005,
          createdAt: 1_600_000_000_000,
        },
      }),
    ]);
    // Creation drives the order, meta.updatedAt the relative label.
    expect(item?.createdAt).toBe(1_600_000_000_001);
    expect(item?.updatedAt).toBe(1_700_000_000_005);
    // `lastActive` is a daemon-side record field and never crosses the wire.
    expect(item === undefined || "lastActive" in item).toBe(false);
  });
});
