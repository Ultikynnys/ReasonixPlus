import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionSetupMeta } from "../src/cli/commands/desktop.js";
import {
  loadSessionMeta,
  patchSessionMeta,
  sessionDir,
  sessionSubagentsEnabled,
} from "../src/memory/session.js";

const configured = ["ghidra", "blender", "playwright"];

describe("sessionSetupMeta", () => {
  it("records every configured server the user did not enable as disabled", () => {
    expect(sessionSetupMeta(configured, ["playwright"], true)).toEqual({
      mcp: { disabledServers: ["blender", "ghidra"] },
      subagents: true,
    });
  });

  it("freezes no disable entry when the whole server list is confirmed", () => {
    expect(sessionSetupMeta(configured, configured, false)).toEqual({
      mcp: {},
      subagents: false,
    });
  });

  it("freezes nothing when no server is configured", () => {
    expect(sessionSetupMeta([], [], false)).toEqual({ mcp: {}, subagents: false });
  });

  it("ignores an enabled name the workspace does not configure", () => {
    expect(sessionSetupMeta(configured, ["nope"], true).mcp).toEqual({
      disabledServers: ["blender", "ghidra", "playwright"],
    });
  });

  it("de-duplicates and sorts the disabled list", () => {
    expect(sessionSetupMeta(["b", "a", "b"], [], false).mcp).toEqual({
      disabledServers: ["a", "b"],
    });
  });

  it("coerces anything but a literal true to a disabled subagent flag", () => {
    const coerced = sessionSetupMeta([], [], undefined as unknown as boolean);
    expect(coerced.subagents).toBe(false);
  });
});

describe("session-start freeze round trip", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-session-setup-"));
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("lands both capabilities in the session meta so a resume reads them back", () => {
    // The store resolves its directory per call, so the stub must be in force before
    // the first write. Assert it: a stray real-home write is the failure to avoid.
    expect(sessionDir("gated-chat").startsWith(home)).toBe(true);
    patchSessionMeta("gated-chat", sessionSetupMeta(configured, ["ghidra"], true));

    const meta = loadSessionMeta("gated-chat");
    expect(meta.mcp).toEqual({ disabledServers: ["blender", "playwright"] });
    expect(sessionSubagentsEnabled(meta)).toBe(true);
  });

  it("reads a confirm that left subagents off as disabled, never as inherited", () => {
    patchSessionMeta("plain-chat", sessionSetupMeta(configured, configured, false));

    const meta = loadSessionMeta("plain-chat");
    expect(sessionSubagentsEnabled(meta)).toBe(false);
    expect(meta.mcp).toEqual({});
  });
});
