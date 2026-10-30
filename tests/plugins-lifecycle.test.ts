import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capabilityRows,
  refreshTabSystemPrompt,
  sessionMcpOverrides,
  syncSessionCapabilities,
} from "../src/cli/commands/desktop.js";
import { applyMcpSessionOverrides } from "../src/cli/commands/mcp-runtime.js";
import { loadEffectiveMcpConfig, readConfig, writeConfig } from "../src/config.js";
import type { McpSpecOverrides } from "../src/mcp/spec.js";
import { ensureSessionDir, loadSessionMeta, patchSessionMeta } from "../src/memory/session.js";
import { installPlugin, uninstallPlugin } from "../src/plugins/store.js";
import { installSkills } from "../src/skills/store.js";
import { copyTree, stubPluginHome, writePluginTree } from "./support/plugin-fixture.js";
import { writeSkillDir } from "./support/skill-fixture.js";

let home: string;
let root: string;
let configPath: string;
let fixture: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "reasonix-plugin-lifecycle-home-"));
  root = mkdtempSync(join(tmpdir(), "reasonix-plugin-lifecycle-work-"));
  configPath = join(root, "config.json");
  fixture = join(root, "fixture");
  stubPluginHome(home, configPath);
  writePluginTree(fixture, { name: "notfair", version: "1.0.0" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function install(): Promise<unknown> {
  return installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
}

/** A chat that answered the picker with `plugins`. */
function chat(name: string, plugins: string[]): string {
  ensureSessionDir(name);
  patchSessionMeta(name, { mcp: {}, plugins, skills: [] });
  return name;
}

function tab(currentSession: string) {
  return {
    id: "tab-1",
    rootDir: root,
    mcpSetupPending: false,
    currentModel: "deepseek-v4-pro",
    currentSession,
    system: "",
    toolset: {},
  };
}

/** The servers the MCP runtime would see for this chat: config with its overlay applied.
 *  `disabled: true` means the runtime refuses to bridge and unregisters the tools. */
function servedServers(overrides: McpSpecOverrides | undefined) {
  return applyMcpSessionOverrides(loadEffectiveMcpConfig(root), overrides).map((spec) => ({
    name: spec.name,
    disabled: spec.disabled === true,
  }));
}

function promptOf(currentSession: string): string {
  const t = tab(currentSession);
  refreshTabSystemPrompt(t);
  return t.system;
}

describe("a plugin's skills and MCP servers share its lifetime", () => {
  it("enabling the plugin for a chat enables both", async () => {
    await install();
    chat("enabled", ["notfair"]);

    const prompt = promptOf("enabled");
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("- seo-analysis (notfair): Runs the seo-analysis workflow.");
    expect(servedServers(sessionMcpOverrides(tab("enabled")))).toEqual([
      { name: "notfair", disabled: false },
    ]);
  });

  it("withholding the plugin withholds both", async () => {
    await install();
    chat("other", []);

    expect(promptOf("other")).not.toContain("# Skills");
    expect(servedServers(sessionMcpOverrides(tab("other")))).toEqual([
      { name: "notfair", disabled: true },
    ]);
  });

  it("keeps one plugin's capabilities out of a chat that enabled a different one", async () => {
    await install();
    const second = join(root, "second");
    writePluginTree(second, { name: "other-plugin", servers: false });
    await installPlugin(second, { homeDir: home, configPath, copy: copyTree(() => second) });
    chat("picky", ["notfair"]);

    const prompt = promptOf("picky");
    expect(prompt).toContain("- seo-analysis (notfair)");
    expect(prompt).not.toContain("- other-plugin");
    // notfair's own server is the only one it may bridge; the second plugin ships none.
    expect(servedServers(sessionMcpOverrides(tab("picky")))).toEqual([
      { name: "notfair", disabled: false },
    ]);
  });

  it("installs and uninstalls the skills and servers in the same operation", async () => {
    await install();
    expect(Object.keys(readConfig(configPath).mcpServers ?? {})).toEqual(["notfair"]);
    expect(readConfig(configPath).plugins?.notfair?.version).toBe("1.0.0");
    chat("enabled", ["notfair"]);
    expect(promptOf("enabled")).toContain("# Skills");

    uninstallPlugin("notfair", { homeDir: home, configPath });

    expect(readConfig(configPath).mcpServers).toBeUndefined();
    expect(readConfig(configPath).plugins).toBeUndefined();
    expect(servedServers(sessionMcpOverrides(tab("enabled")))).toEqual([]);
    expect(promptOf("enabled")).not.toContain("# Skills");
  });
});

describe("removing a plugin orphans it in the chats that froze it", () => {
  it("drops the slug, and with it the skills and servers it granted", async () => {
    await install();
    chat("enabled", ["notfair"]);
    uninstallPlugin("notfair", { homeDir: home, configPath });

    syncSessionCapabilities(tab("enabled"), "enabled");

    expect(loadSessionMeta("enabled").plugins).toEqual([]);
    expect(servedServers(sessionMcpOverrides(tab("enabled")))).toEqual([]);
    expect(promptOf("enabled")).not.toContain("# Skills");
  });

  it("does not need the chat to be reopened for the grant to stop resolving", async () => {
    await install();
    chat("enabled", ["notfair"]);
    uninstallPlugin("notfair", { homeDir: home, configPath });

    // Nothing was reconciled yet; the frozen slug is still there, but it names a plugin
    // that no longer exists, so neither its skills nor its server can be reached.
    expect(loadSessionMeta("enabled").plugins).toEqual(["notfair"]);
    expect(servedServers(sessionMcpOverrides(tab("enabled")))).toEqual([]);
    expect(promptOf("enabled")).not.toContain("# Skills");
  });

  it("keeps a reinstall from reviving a grant the chat lost", async () => {
    await install();
    chat("enabled", ["notfair"]);
    uninstallPlugin("notfair", { homeDir: home, configPath });
    syncSessionCapabilities(tab("enabled"), "enabled");

    await install();

    expect(loadSessionMeta("enabled").plugins).toEqual([]);
    expect(servedServers(sessionMcpOverrides(tab("enabled")))).toEqual([
      { name: "notfair", disabled: true },
    ]);
    expect(promptOf("enabled")).not.toContain("# Skills");
  });
});

describe("capabilityRows", () => {
  it("projects the servers, the plugins and the standalone skills from one seed", async () => {
    writeConfig({ mcpServers: { github: { command: "npx", args: ["-y", "@scope/github"] } } });
    await install();
    const skillDir = join(root, "churn-analysis");
    writeSkillDir(skillDir, { name: "churn-analysis", description: "Predicts churn." });
    await installSkills(skillDir, { homeDir: home, configPath });

    const fresh = capabilityRows(root);
    // A plugin's own server is never a server row: it rides on the plugin row.
    expect(fresh.servers).toEqual([{ name: "github", enabled: true, builtin: false }]);
    expect(fresh.plugins).toEqual([{ name: "notfair", displayName: "NotFair", enabled: true }]);
    expect(fresh.skills).toEqual([
      { id: "churn-analysis", description: "Predicts churn.", source: skillDir, enabled: true },
    ]);

    // A seed that pins the source session's frozen set pre-fills every kind from it.
    const pinned = capabilityRows(root, { mcp: {}, plugins: [], skills: [], subagents: true });
    expect(pinned.plugins[0]?.enabled).toBe(false);
    expect(pinned.skills[0]?.enabled).toBe(false);
    expect(pinned.servers[0]?.enabled).toBe(true);
  });
});
