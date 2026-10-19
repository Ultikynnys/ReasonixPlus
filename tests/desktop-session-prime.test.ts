import { describe, expect, it } from "vitest";
import { sameSessionListItems, toSessionListItems } from "../src/desktop/session-listing.js";
import type { SessionInfo } from "../src/memory/session.js";

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

describe("session list priming", () => {
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

  it("treats a cached list that matches the scan as already on screen", () => {
    const cached = toSessionListItems([session("one"), session("two")]);
    const scanned = toSessionListItems([session("one"), session("two")]);
    expect(sameSessionListItems(cached, scanned)).toBe(true);
    expect(sameSessionListItems([], [])).toBe(true);
  });

  it("reports a difference for every field the sidebar can show", () => {
    const base = toSessionListItems([session("one")]);
    const differing: Array<[string, SessionInfo]> = [
      ["name", session("renamed")],
      ["messageCount", session("one", { messageCount: 3 })],
      ["mtime", session("one", { mtime: new Date("2026-01-02T03:04:06.000Z") })],
      [
        "updatedAt",
        session("one", {
          meta: { workspace: "C:\\ws", summary: "Title", updatedAt: 1_700_000_000_001 },
        }),
      ],
      ["createdAt", session("one", { createdAt: 1_600_000_000_001 })],
      [
        "summary",
        session("one", {
          meta: { workspace: "C:\\ws", summary: "Renamed", updatedAt: 1_700_000_000_000 },
        }),
      ],
      ["workspaceStatus", session("one", { workspaceStatus: "legacy_missing_meta" })],
    ];
    for (const [field, changed] of differing) {
      expect(sameSessionListItems(base, toSessionListItems([changed])), field).toBe(false);
    }
  });

  it("treats a dropped, added or reordered row as a change", () => {
    const two = toSessionListItems([session("one"), session("two")]);
    expect(sameSessionListItems(two, toSessionListItems([session("one")]))).toBe(false);
    expect(
      sameSessionListItems(
        two,
        toSessionListItems([session("one"), session("two"), session("three")]),
      ),
    ).toBe(false);
    expect(sameSessionListItems(two, toSessionListItems([session("two"), session("one")]))).toBe(
      false,
    );
  });
});
