import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSpecStatus } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeLegacySessionCapabilities,
  pluginPrefill,
  pluginServerInfos,
  sessionMcpOverrides,
  sessionSetupMeta,
} from "../src/cli/commands/desktop.js";
import { writeConfig } from "../src/config.js";
import { ensureSessionDir, loadSessionMeta, patchSessionMeta } from "../src/memory/session.js";

function tabWith(
  statuses: Record<string, { kind: McpSpecStatus; reason?: string; toolCount?: number }>,
) {
  return { mcpStatuses: new Map(Object.entries(statuses)) };
}

describe("pluginServerInfos", () => {
  it("reports the live bridge state of an active plugin server", () => {
    const infos = pluginServerInfos(
      tabWith({ notfair: { kind: "connected", toolCount: 7 } }),
      { notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" } },
      true,
    );
    expect(infos).toEqual([
      { name: "notfair", transport: "streamable-http", status: "connected", toolCount: 7 },
    ]);
  });

  it("surfaces a failed handshake with its reason", () => {
    const infos = pluginServerInfos(
      tabWith({ notfair: { kind: "failed", reason: "401 Unauthorized" } }),
      { notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" } },
      true,
    );
    expect(infos[0]).toMatchObject({ status: "failed", statusReason: "401 Unauthorized" });
  });

  it("marks every server disabled while this chat has not enabled the plugin", () => {
    const infos = pluginServerInfos(
      tabWith({ "local-tools-server": { kind: "connected", toolCount: 2 } }),
      {
        "local-tools-server": { command: "node", args: ["s.js"], plugin: "local-tools" },
      },
      false,
    );
    expect(infos).toEqual([
      {
        name: "local-tools-server",
        transport: "stdio",
        status: "disabled",
        disabled: true,
      },
    ]);
  });
});

describe("sessionSetupMeta", () => {
  it("freezes the MCP set, the plugin set and the subagent flag together", () => {
    const meta = sessionSetupMeta(["playwright", "github"], ["github"], true, [
      "notfair",
      "notfair",
    ]);
    expect(meta.mcp).toEqual({ disabledServers: ["playwright"] });
    expect(meta.plugins).toEqual(["notfair"]);
    expect(meta.subagents).toBe(true);
  });

  it("records an explicit empty plugin set when the chat picked none", () => {
    expect(sessionSetupMeta([], [], false, []).plugins).toEqual([]);
  });
});

describe("pluginPrefill", () => {
  const installed = [
    { slug: "notfair", displayName: "NotFair" },
    { slug: "other", displayName: "Other" },
  ];

  it("offers every installed plugin on for a new chat", () => {
    expect(pluginPrefill(installed, { subagents: false })).toEqual([
      { name: "notfair", displayName: "NotFair", enabled: true },
      { name: "other", displayName: "Other", enabled: true },
    ]);
  });

  it("pins a duplicate to its source session's frozen set", () => {
    expect(pluginPrefill(installed, { subagents: false, plugins: ["notfair"] })).toEqual([
      { name: "notfair", displayName: "NotFair", enabled: true },
      { name: "other", displayName: "Other", enabled: false },
    ]);
  });

  it("leaves everything off when the source chat picked none", () => {
    expect(pluginPrefill(installed, { subagents: false, plugins: [] })).toEqual([
      { name: "notfair", displayName: "NotFair", enabled: false },
      { name: "other", displayName: "Other", enabled: false },
    ]);
  });
});

describe("sessionMcpOverrides — plugin servers follow the session", () => {
  let home: string;
  let root: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-plugin-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-plugin-session-"));
    configPath = join(root, "config.json");
    vi.stubEnv("REASONIX_CONFIG", configPath);
    // Sessions live under the home state dir, so it must be the temp one.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
    writeConfig(
      {
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp"] },
          notfair: {
            url: "https://notfair.co/api/mcp/notfair",
            type: "http",
            plugin: "notfair",
          },
        },
      },
      configPath,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** A meta stamp only lands on a session that exists, so each case creates one. */
  function frozen(session: string, meta: Parameters<typeof patchSessionMeta>[1]): void {
    ensureSessionDir(session);
    patchSessionMeta(session, meta);
  }

  function overridesFor(session: string): ReadonlySet<string> | undefined {
    return sessionMcpOverrides({ rootDir: root, currentSession: session }).disabledServers;
  }

  it("bridges the plugin's servers for a chat that enabled it", () => {
    frozen("with-plugin", { mcp: {}, plugins: ["notfair"] });
    expect(overridesFor("with-plugin")).toEqual(new Set());
  });

  it("withholds them from a chat that picked none", () => {
    frozen("without-plugin", { mcp: {}, plugins: [] });
    expect(overridesFor("without-plugin")).toEqual(new Set(["notfair"]));
  });

  it("withholds them from a legacy chat that never answered the picker", () => {
    frozen("legacy", { mcp: {} });
    expect(overridesFor("legacy")).toEqual(new Set(["notfair"]));
  });

  it("keeps the chat's own server decisions alongside the plugin exclusion", () => {
    frozen("picky", { mcp: { disabledServers: ["playwright"] }, plugins: [] });
    expect(overridesFor("picky")).toEqual(new Set(["playwright", "notfair"]));
  });
});

describe("freezeLegacySessionCapabilities", () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-legacy-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-legacy-work-"));
    vi.stubEnv("REASONIX_CONFIG", join(root, "config.json"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function legacyTab(): { rootDir: string; mcpSetupPending: boolean } {
    return { rootDir: root, mcpSetupPending: false };
  }

  it("freezes an empty plugin set on a chat that predates plugins", () => {
    ensureSessionDir("legacy");
    freezeLegacySessionCapabilities(legacyTab(), "legacy");
    const meta = loadSessionMeta("legacy");
    expect(meta.mcp).toEqual({});
    expect(meta.plugins).toEqual([]);
  });

  it("never rewrites a plugin set the chat already froze", () => {
    ensureSessionDir("partly-frozen");
    patchSessionMeta("partly-frozen", { plugins: ["notfair"] });
    freezeLegacySessionCapabilities(legacyTab(), "partly-frozen");
    const meta = loadSessionMeta("partly-frozen");
    expect(meta.plugins).toEqual(["notfair"]);
    expect(meta.mcp).toEqual({});
  });

  it("leaves a confirmed chat alone", () => {
    ensureSessionDir("confirmed");
    patchSessionMeta("confirmed", { mcp: {}, plugins: ["notfair"] });
    freezeLegacySessionCapabilities(legacyTab(), "confirmed");
    expect(loadSessionMeta("confirmed").plugins).toEqual(["notfair"]);
  });

  it("skips a chat whose setup gate is still open", () => {
    ensureSessionDir("gated");
    freezeLegacySessionCapabilities({ rootDir: root, mcpSetupPending: true }, "gated");
    expect(loadSessionMeta("gated").mcp).toBeUndefined();
  });
});
