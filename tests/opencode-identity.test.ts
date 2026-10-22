/** The harness identity used for opencode.ai requests — shapes, stability, header set. */

import { describe, expect, it } from "vitest";
import {
  OPENCODE_READ_TOOL,
  OPENCODE_USER_AGENT,
  opencodeIdentityHeaders,
  opencodeProjectId,
  opencodeSessionId,
  withOpencodeRequiredTool,
} from "../src/opencode-identity.js";

/** `ses_` + 12 hex chars + 14 base62, as upstream's identifier generator emits. */
const SESSION_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe("opencodeSessionId", () => {
  it("shapes any conversation id into a session id", () => {
    expect(opencodeSessionId("desktop-17123456789012-3")).toMatch(SESSION_SHAPE);
  });

  it("is stable for one conversation so routing and caching stay pinned", () => {
    expect(opencodeSessionId("tab-a")).toBe(opencodeSessionId("tab-a"));
    expect(opencodeSessionId("tab-a")).not.toBe(opencodeSessionId("tab-b"));
  });
});

describe("opencodeProjectId", () => {
  it("is a hash of the workspace, stable per directory", () => {
    expect(opencodeProjectId("/work/one")).toMatch(/^[0-9a-f]{40}$/);
    expect(opencodeProjectId("/work/one")).toBe(opencodeProjectId("/work/one"));
    expect(opencodeProjectId("/work/one")).not.toBe(opencodeProjectId("/work/two"));
  });
});

describe("withOpencodeRequiredTool", () => {
  const readFile = {
    type: "function" as const,
    function: { name: "read_file", description: "Read", parameters: { type: "object" } },
  };

  it("adds the required real read tool without dropping caller tools", () => {
    expect(withOpencodeRequiredTool([readFile])).toEqual([readFile, OPENCODE_READ_TOOL]);
  });

  it("returns a supplied read tool unchanged without duplication", () => {
    const read = { ...OPENCODE_READ_TOOL, function: { ...OPENCODE_READ_TOOL.function } };
    expect(withOpencodeRequiredTool([read])).toEqual([read]);
  });
});

describe("opencodeIdentityHeaders", () => {
  it("sends the full identity OpenCode's own client sends", () => {
    const sessionago = opencodeSessionId("tab-a");
    expect(opencodeIdentityHeaders(sessionago, "/work/one")).toEqual({
      "x-opencode-session-id": sessionago,
      "x-session-affinity": sessionago,
      "X-Session-Id": sessionago,
      "User-Agent": OPENCODE_USER_AGENT,
      "x-opencode-project": opencodeProjectId("/work/one"),
      "x-opencode-session": sessionago,
      "x-opencode-client": "cli",
    });
  });

  it("identifies as the CLI, not as a bare SDK or a reasonix agent", () => {
    expect(OPENCODE_USER_AGENT).toMatch(/^opencode\/[a-z]+\/[\d.]+\/cli$/);
  });
});
