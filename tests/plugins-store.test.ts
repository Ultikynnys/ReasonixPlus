import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGlobalPathAllowed, readConfig } from "../src/config.js";
import { unreadablePluginManifest } from "../src/plugins/manifest.js";
import {
  installPlugin,
  listPlugins,
  pluginSkills,
  pluginsRoot,
  syncPluginServers,
  uninstallPlugin,
} from "../src/plugins/store.js";
import type { PluginState } from "../src/plugins/store.js";
import { FIXTURE_SKILLS, copyTree, writePluginTree } from "./support/plugin-fixture.js";

let work: string;
let home: string;
let configPath: string;
let fixture: string;

/** Alphabetical, matching the indexer's sorted directory walk. */
const SKILLS = FIXTURE_SKILLS;

const copyFixture = copyTree(() => fixture);

/** Escape a literal path for use inside a RegExp assertion. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function install(source = fixture, copy = copyFixture) {
  return installPlugin(source, { homeDir: home, configPath, copy });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "reasonix-plugin-store-"));
  home = join(work, "home");
  configPath = join(work, "config.json");
  fixture = join(work, "fixture");
  writePluginTree(fixture);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("installPlugin", () => {
  it("installs into the plugin root and records provenance", async () => {
    const installed = await install();
    expect(installed.slug).toBe("notfair");
    expect(installed.dir).toBe(join(pluginsRoot(home), "notfair"));
    expect(existsSync(join(installed.dir, ".codex-plugin", "plugin.json"))).toBe(true);
    const cfg = readConfig(configPath);
    expect(cfg.plugins?.notfair?.source).toBe(fixture);
    expect(cfg.plugins?.notfair?.version).toBe("0.27.17");
    // Enablement is a session capability, so no global flag is written.
    expect(cfg.plugins?.notfair).not.toHaveProperty("enabled");
  });

  it("registers the plugin MCP server as an owned entry", async () => {
    await install();
    const cfg = readConfig(configPath);
    expect(cfg.mcpServers?.notfair).toEqual({
      url: "https://notfair.co/api/mcp/notfair",
      type: "http",
      plugin: "notfair",
    });
  });

  it("grants read access to the plugin directory", async () => {
    const installed = await install();
    expect(loadGlobalPathAllowed(configPath)).toContain(installed.dir);
  });

  it("leaves no staging directory and no record when the manifest is invalid", async () => {
    rmSync(fixture, { recursive: true, force: true });
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "plugin.json"), JSON.stringify({ version: "1.0.0" }), "utf8");
    await expect(install()).rejects.toThrow(/name/);
    const root = pluginsRoot(home);
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
    expect(readConfig(configPath).plugins).toBeUndefined();
  });

  it("refuses a second install of the same plugin", async () => {
    await install();
    await expect(install()).rejects.toThrow(/already installed/);
  });

  it("names where the plugin already lives when refusing a second install", async () => {
    const first = await install();
    await expect(install()).rejects.toThrow(new RegExp(escapeRegExp(first.dir)));
  });

  it("rolls the directory back when the install cannot be recorded", async () => {
    // A config path that cannot be written (it is a directory) fails after the move.
    const blocked = join(work, "blocked-config");
    mkdirSync(blocked, { recursive: true });
    await expect(
      installPlugin(fixture, { homeDir: home, configPath: blocked, copy: copyFixture }),
    ).rejects.toThrow();
    expect(existsSync(join(pluginsRoot(home), "notfair"))).toBe(false);
  });

  it("installs an Agent Plugins root manifest too", async () => {
    rmSync(fixture, { recursive: true, force: true });
    writePluginTree(fixture, { name: "rootform", rootManifest: true, servers: false });
    const installed = await install();
    expect(installed.slug).toBe("rootform");
    expect(Object.keys(readConfig(configPath).mcpServers ?? {})).toEqual([]);
  });
});

describe("listPlugins", () => {
  it("reports the manifest, category, skills and servers", async () => {
    await install();
    const plugins = listPlugins({ homeDir: home, configPath });
    expect(plugins).toHaveLength(1);
    const plugin = plugins[0]!;
    expect(plugin.error).toBeUndefined();
    expect(plugin.manifest.ui.category).toBe("Productivity");
    expect(plugin.skills.map((skill) => skill.name)).toEqual(SKILLS);
    expect(Object.keys(plugin.servers)).toEqual(["notfair"]);
  });

  it("returns nothing when no plugin is installed", () => {
    expect(listPlugins({ homeDir: home, configPath })).toEqual([]);
  });
});

describe("pluginSkills", () => {
  it("returns only the skills of the slugs a session froze", async () => {
    await install();
    writePluginTree(join(work, "second"), { name: "second", servers: false });
    await install(
      join(work, "second"),
      copyTree(() => join(work, "second")),
    );
    const chosen = pluginSkills({ homeDir: home, configPath, only: ["notfair"] });
    expect(chosen.map((skill) => skill.plugin)).toEqual(SKILLS.map(() => "notfair"));
    expect(chosen.map((skill) => skill.name)).toEqual(SKILLS);
  });

  it("returns nothing for a session that froze no plugin", async () => {
    await install();
    expect(pluginSkills({ homeDir: home, configPath, only: [] })).toEqual([]);
  });

  it("ignores a slug that is no longer installed", () => {
    expect(pluginSkills({ homeDir: home, configPath, only: ["gone"] })).toEqual([]);
  });

  it("never reads a plugin the session did not freeze, even a broken one", async () => {
    await install();
    writePluginTree(join(work, "broken"), { name: "broken", servers: false });
    await install(
      join(work, "broken"),
      copyTree(() => join(work, "broken")),
    );
    writeFileSync(join(pluginsRoot(home), "broken", ".codex-plugin", "plugin.json"), "{", "utf8");
    const chosen = pluginSkills({ homeDir: home, configPath, only: ["notfair"] });
    expect(chosen.map((skill) => skill.plugin)).toEqual(SKILLS.map(() => "notfair"));
    // The broken plugin is still listable, with its error attached, for the settings page.
    const broken = listPlugins({ homeDir: home, configPath }).find((p) => p.slug === "broken");
    expect(broken?.error).toBeTruthy();
  });
});

describe("uninstallPlugin", () => {
  it("removes the tree, the record, the servers and the read grant", async () => {
    const installed = await install();
    uninstallPlugin("notfair", { homeDir: home, configPath });
    expect(existsSync(installed.dir)).toBe(false);
    const cfg = readConfig(configPath);
    expect(cfg.plugins).toBeUndefined();
    expect(cfg.mcpServers).toBeUndefined();
    expect(loadGlobalPathAllowed(configPath)).not.toContain(installed.dir);
  });

  it("refuses a slug that is not installed", () => {
    expect(() => uninstallPlugin("ghost", { homeDir: home, configPath })).toThrow(/not installed/);
  });
});

describe("syncPluginServers", () => {
  function state(slug: string): PluginState {
    return {
      slug,
      dir: `/tmp/${slug}`,
      manifest: unreadablePluginManifest(slug),
      skills: [],
      servers: { [slug]: { url: "https://example.com/mcp", type: "http", plugin: slug } },
      record: undefined,
    };
  }

  it("keeps user servers and drops entries whose plugin is gone", () => {
    const cfg = {
      mcpServers: {
        playwright: { command: "npx", args: ["@playwright/mcp"] },
        dropped: { url: "https://gone.example/mcp", plugin: "dropped" },
      },
    };
    expect(syncPluginServers(cfg, [state("kept")])).toBe(true);
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["playwright", "kept"]);
  });

  it("registers declared servers without a per-plugin disabled flag", () => {
    const cfg = { mcpServers: {} };
    syncPluginServers(cfg, [state("kept")]);
    expect(cfg.mcpServers?.kept).toEqual({
      url: "https://example.com/mcp",
      type: "http",
      plugin: "kept",
    });
  });

  it("reports no change when the entries already match", () => {
    const cfg = {
      mcpServers: {
        kept: { url: "https://example.com/mcp", type: "http" as const, plugin: "kept" },
      },
    };
    expect(syncPluginServers(cfg, [state("kept")])).toBe(false);
  });
});
