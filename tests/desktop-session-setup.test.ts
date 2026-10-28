import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityPrefill, sessionSetupMeta } from "../src/cli/commands/desktop.js";
import {
  ensureSessionDir,
  loadSessionMeta,
  patchSessionMeta,
  sessionDir,
  sessionSubagentsEnabled,
} from "../src/memory/session.js";

const configured = ["ghidra", "blender", "playwright"];

describe("capabilityPrefill", () => {
  const specs = [
    { name: "ghidra", disabled: true },
    { name: "playwright", builtin: true },
    { name: "blender" },
  ];

  it("offers the Settings default when the chat pins no capability set (New chat)", () => {
    expect(capabilityPrefill(specs)).toEqual([
      { name: "ghidra", enabled: false, builtin: false },
      { name: "playwright", enabled: true, builtin: true },
      { name: "blender", enabled: true, builtin: false },
    ]);
  });

  it("replays the source session's frozen set instead of the Settings default (Duplicate)", () => {
    // ghidra is off in Settings but on in the source chat; playwright is the reverse.
    const rows = capabilityPrefill(specs, {
      mcp: { disabledServers: ["playwright"] },
      subagents: true,
    });
    expect(rows).toEqual([
      { name: "ghidra", enabled: true, builtin: false },
      { name: "playwright", enabled: false, builtin: true },
      { name: "blender", enabled: true, builtin: false },
    ]);
  });

  it("reads an empty frozen set as every server enabled, never as the default", () => {
    const rows = capabilityPrefill(specs, { mcp: {}, subagents: false });
    expect(rows.map((row) => row.enabled)).toEqual([true, true, true]);
  });

  it("round-trips: confirming the pre-fill freezes the set the pre-fill came from", () => {
    const seed = { mcp: { disabledServers: ["blender"] }, subagents: true };
    const rows = capabilityPrefill(specs, seed);
    const frozen = sessionSetupMeta(
      rows.map((row) => row.name),
      rows.filter((row) => row.enabled).map((row) => row.name),
      seed.subagents,
    );
    expect(frozen).toEqual({ mcp: { disabledServers: ["blender"] }, subagents: true, plugins: [] });
  });
});

describe("sessionSetupMeta", () => {
  it("records every configured server the user did not enable as disabled", () => {
    expect(sessionSetupMeta(configured, ["playwright"], true)).toEqual({
      mcp: { disabledServers: ["blender", "ghidra"] },
      subagents: true,
      plugins: [],
    });
  });

  it("freezes no disable entry when the whole server list is confirmed", () => {
    expect(sessionSetupMeta(configured, configured, false)).toEqual({
      mcp: {},
      subagents: false,
      plugins: [],
    });
  });

  it("freezes nothing when no server is configured", () => {
    expect(sessionSetupMeta([], [], false)).toEqual({ mcp: {}, subagents: false, plugins: [] });
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

  it("lands every capability in the session meta so a resume reads them back", () => {
    // The store resolves its directory per call, so the stub must be in force before
    // the first write. Assert it: a stray real-home write is the failure to avoid.
    expect(sessionDir("gated-chat").startsWith(home)).toBe(true);
    ensureSessionDir("gated-chat");
    patchSessionMeta("gated-chat", sessionSetupMeta(configured, ["ghidra"], true, ["notfair"]));

    const meta = loadSessionMeta("gated-chat");
    expect(meta.mcp).toEqual({ disabledServers: ["blender", "playwright"] });
    expect(meta.plugins).toEqual(["notfair"]);
    expect(sessionSubagentsEnabled(meta)).toBe(true);
  });

  it("reads a confirm that left subagents off as disabled, never as inherited", () => {
    ensureSessionDir("plain-chat");
    patchSessionMeta("plain-chat", sessionSetupMeta(configured, configured, false));

    const meta = loadSessionMeta("plain-chat");
    expect(sessionSubagentsEnabled(meta)).toBe(false);
    expect(meta.mcp).toEqual({});
    // A chat that answered the picker with no plugin is an answer, not a legacy meta.
    expect(meta.plugins).toEqual([]);
  });
});
