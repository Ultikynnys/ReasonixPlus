import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpSpecInfo, McpSpecStatus } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CapabilityAnswer,
  labelPluginServers,
  orphanedCapabilityPatch,
  pluginPrefill,
  pluginServerInfos,
  sessionMcpOverrides,
  sessionSetupMeta,
  syncSessionCapabilities,
} from "../src/cli/commands/desktop.js";
import { saveMcpOAuth, writeConfig } from "../src/config.js";
import { ensureSessionDir, loadSessionMeta, patchSessionMeta } from "../src/memory/session.js";
import { mcpCreds } from "./support/oauth-fixture.js";
import { stubPluginHome } from "./support/plugin-fixture.js";

function tabWith(
  statuses: Record<string, { kind: McpSpecStatus; reason?: string; toolCount?: number }>,
) {
  return { mcpStatuses: new Map(Object.entries(statuses)) };
}

describe("pluginServerInfos", () => {
  let home: string;
  let root: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-plugin-server-info-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-plugin-server-info-work-"));
    configPath = join(root, "config.json");
    stubPluginHome(home, configPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const signedIn = () =>
    saveMcpOAuth(
      "notfair",
      mcpCreds({ expiresAt: Date.now() + 60_000, tokenEndpoint: "https://auth.example.com/token" }),
      configPath,
    );

  it("reports the live bridge state of an active plugin server", () => {
    signedIn();
    const infos = pluginServerInfos(
      tabWith({ notfair: { kind: "connected", toolCount: 7 } }),
      { notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" } },
      true,
    );
    expect(infos).toEqual([
      {
        name: "notfair",
        transport: "streamable-http",
        status: "connected",
        toolCount: 7,
        auth: "connected",
      },
    ]);
  });

  it("says an HTTP server still needs a sign-in when no token is stored", () => {
    const infos = pluginServerInfos(
      tabWith({ notfair: { kind: "failed", reason: "401 Unauthorized" } }),
      { notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" } },
      true,
    );
    expect(infos[0]).toMatchObject({ auth: "none", statusReason: "401 Unauthorized" });
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

describe("labelPluginServers", () => {
  const row = (name: string | null): McpSpecInfo => ({
    raw: name ?? "",
    name,
    transport: "stdio",
    summary: name ?? "",
    status: "connected",
  });

  it("tags the rows a plugin declared with its slug", () => {
    const rows = labelPluginServers(
      [row("notfair"), row("github")],
      new Map([["notfair", "notfair"]]),
    );
    expect(rows).toEqual([{ ...row("notfair"), plugin: "notfair" }, row("github")]);
  });

  it("leaves anonymous rows unlabeled", () => {
    const [anonymous] = labelPluginServers([row(null)], new Map([["", "notfair"]]));
    expect(anonymous.plugin).toBeUndefined();
  });
});

describe("sessionSetupMeta", () => {
  const answer = (overrides: Partial<CapabilityAnswer> = {}): CapabilityAnswer => ({
    configuredServers: [],
    servers: [],
    plugins: [],
    skills: [],
    subagents: false,
    ...overrides,
  });

  it("freezes the MCP set, the plugins, the skills and the subagent flag together", () => {
    const meta = sessionSetupMeta(
      answer({
        configuredServers: ["playwright", "github"],
        servers: ["github"],
        plugins: ["notfair", "notfair"],
        skills: ["churn-analysis"],
        subagents: true,
      }),
    );
    expect(meta.mcp).toEqual({ disabledServers: ["playwright"] });
    expect(meta.plugins).toEqual(["notfair"]);
    expect(meta.skills).toEqual(["churn-analysis"]);
    expect(meta.subagents).toBe(true);
  });

  it("records explicit empty sets when the chat picked none", () => {
    const meta = sessionSetupMeta(answer());
    expect(meta.plugins).toEqual([]);
    expect(meta.skills).toEqual([]);
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
    // Sessions live under the home state dir, so it must be the temp one.
    stubPluginHome(home, configPath);
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

describe("orphanedCapabilityPatch", () => {
  const installed = {
    servers: new Set(["playwright", "github"]),
    plugins: new Set(["notfair"]),
    skills: new Set(["churn-analysis"]),
  };

  it("drops a plugin and a skill that are no longer installed", () => {
    expect(
      orphanedCapabilityPatch(
        { mcp: {}, plugins: ["notfair", "gone"], skills: ["churn-analysis", "gone"] },
        installed,
      ),
    ).toEqual({ plugins: ["notfair"], skills: ["churn-analysis"] });
  });

  it("drops a disabled server the workspace no longer configures", () => {
    expect(
      orphanedCapabilityPatch({ mcp: { disabledServers: ["github", "gone"] } }, installed),
    ).toEqual({ mcp: { disabledServers: ["github"] } });
  });

  it("leaves an empty disable list as empty rather than undefined", () => {
    expect(orphanedCapabilityPatch({ mcp: { disabledServers: ["gone"] } }, installed)).toEqual({
      mcp: {},
    });
  });

  it("reports nothing when every frozen name is installed", () => {
    expect(
      orphanedCapabilityPatch(
        { mcp: { disabledServers: ["github"] }, plugins: ["notfair"], skills: ["churn-analysis"] },
        installed,
      ),
    ).toBeUndefined();
  });

  it("never adds a list the chat did not freeze", () => {
    expect(orphanedCapabilityPatch({ mcp: {} }, installed)).toBeUndefined();
  });
});

describe("syncSessionCapabilities", () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-sync-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-sync-work-"));
    stubPluginHome(home, join(root, "config.json"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function tab(pending = false) {
    return { id: "tab-1", rootDir: root, mcpSetupPending: pending };
  }

  function chat(name: string, meta: Record<string, unknown>): string {
    ensureSessionDir(name);
    patchSessionMeta(name, meta);
    return name;
  }

  it("snapshots the Settings default on a chat that predates the frozen model", () => {
    writeConfig({ mcpServers: { ghidra: { command: "npx", args: ["ghidra"], disabled: true } } });
    chat("legacy", {});
    syncSessionCapabilities(tab(), "legacy");
    const meta = loadSessionMeta("legacy");
    expect(meta.mcp).toEqual({ disabledServers: ["ghidra"] });
    expect(meta.plugins).toEqual([]);
    expect(meta.skills).toEqual([]);
  });

  it("drops a plugin that is no longer installed from a confirmed chat", () => {
    chat("orphaned", { mcp: {}, plugins: ["gone"], skills: [] });
    syncSessionCapabilities(tab(), "orphaned");
    expect(loadSessionMeta("orphaned").plugins).toEqual([]);
  });

  it("drops a skill that is no longer installed from a confirmed chat", () => {
    chat("orphaned", { mcp: {}, plugins: [], skills: ["gone"] });
    syncSessionCapabilities(tab(), "orphaned");
    expect(loadSessionMeta("orphaned").skills).toEqual([]);
  });

  it("drops a disabled server the workspace no longer configures", () => {
    chat("orphaned", { mcp: { disabledServers: ["gone"] }, plugins: [], skills: [] });
    syncSessionCapabilities(tab(), "orphaned");
    expect(loadSessionMeta("orphaned").mcp).toEqual({});
  });

  it("writes nothing when the chat frozen set is intact", () => {
    writeConfig({ mcpServers: { ghidra: { command: "npx", args: ["ghidra"] } } });
    chat("intact", { mcp: { disabledServers: ["ghidra"] }, plugins: [], skills: [] });
    const before = loadSessionMeta("intact");
    syncSessionCapabilities(tab(), "intact");
    expect(loadSessionMeta("intact")).toEqual(before);
  });

  it("leaves a chat whose setup gate is still open alone", () => {
    chat("gated", { mcpPending: true });
    syncSessionCapabilities(tab(true), "gated");
    syncSessionCapabilities(tab(), "gated");
    expect(loadSessionMeta("gated").mcp).toBeUndefined();
    expect(loadSessionMeta("gated").mcpPending).toBe(true);
  });
});
