/** The harness identity used for opencode.ai requests — shapes, randomness, header set. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPENCODE_READ_TOOL,
  OPENCODE_USER_AGENT,
  createOpencodeIdentity,
  opencodeIdentity,
  opencodeIdentityHeaders,
  rotateOpencodeIdentity,
  withOpencodeRequiredTool,
} from "../src/opencode-identity.js";

/** `ses_` + 12 hex chars + 14 base62, as upstream's identifier generator emits. */
const SESSION_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const PROJECT_SHAPE = /^[0-9a-f]{40}$/;

describe("createOpencodeIdentity", () => {
  it("builds ids in the shapes the gateway expects", () => {
    const identity = createOpencodeIdentity();
    expect(identity.session).toMatch(SESSION_SHAPE);
    expect(identity.project).toMatch(PROJECT_SHAPE);
  });

  it("shares nothing between two runs", () => {
    const first = createOpencodeIdentity();
    const second = createOpencodeIdentity();
    expect(first.session).not.toBe(second.session);
    expect(first.project).not.toBe(second.project);
  });

  it("never reproduces the retired conversation and directory derivations", () => {
    const conversation = "tab-a";
    const directory = "/work/one";
    const digest = createHash("sha256").update(`reasonix-session:${conversation}`).digest();
    const retiredSession = `ses_${digest.toString("hex", 0, 6)}`;
    const retiredProject = createHash("sha1").update(`directory:${directory}`).digest("hex");

    for (let draw = 0; draw < 32; draw += 1) {
      const identity = createOpencodeIdentity();
      expect(identity.session.startsWith(retiredSession)).toBe(false);
      expect(identity.project).not.toBe(retiredProject);
    }
  });
});

describe("opencodeIdentity", () => {
  it("keeps one identity for the life of the process", () => {
    expect(opencodeIdentity()).toBe(opencodeIdentity());
  });

  it("replaces it on rotation without returning to the previous value", () => {
    const before = opencodeIdentity();
    const rotated = rotateOpencodeIdentity();
    expect(rotated).not.toBe(before);
    expect(rotated.session).not.toBe(before.session);
    expect(rotated.project).not.toBe(before.project);
    expect(opencodeIdentity()).toBe(rotated);
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
    const identity = createOpencodeIdentity();
    expect(opencodeIdentityHeaders(identity)).toEqual({
      "x-opencode-session-id": identity.session,
      "x-session-affinity": identity.session,
      "X-Session-Id": identity.session,
      "User-Agent": OPENCODE_USER_AGENT,
      "x-opencode-project": identity.project,
      "x-opencode-session": identity.session,
      "x-opencode-client": "cli",
    });
  });

  it("identifies as the CLI, not as a bare SDK or a reasonix agent", () => {
    expect(OPENCODE_USER_AGENT).toMatch(/^opencode\/[a-z]+\/[\d.]+\/cli$/);
  });
});
