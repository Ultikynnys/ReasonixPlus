/** install_skill / uninstall_skill / install_plugin / uninstall_plugin / list_capabilities:
 *  every store is pinned to a temp home so nothing touches the real `~/.reasonix`. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGlobalPathAllowed, readConfig, writeConfig } from "../src/config.js";
import { pluginsRoot } from "../src/plugins/store.js";
import { skillsRoot } from "../src/skills/store.js";
import { ToolRegistry } from "../src/tools.js";
import { type CapabilityToolsOptions, registerCapabilityTools } from "../src/tools/capabilities.js";
import { FIXTURE_SKILLS, writePluginTree } from "./support/plugin-fixture.js";
import { writeSkillDir, writeSkillsTree } from "./support/skill-fixture.js";

interface Setup {
  work: string;
  home: string;
  configPath: string;
  reg: ToolRegistry;
}

let s: Setup;

/** Every temp work dir this file minted, so one teardown removes them all. */
const workDirs: string[] = [];

function setup(opts: CapabilityToolsOptions = {}): Setup {
  const work = mkdtempSync(join(tmpdir(), "reasonix-capabilities-"));
  workDirs.push(work);
  const home = join(work, "home");
  const configPath = join(work, "config.json");
  const reg = new ToolRegistry();
  registerCapabilityTools(reg, { homeDir: home, configPath, ...opts });
  return { work, home, configPath, reg };
}

beforeEach(() => {
  s = setup();
});

afterEach(() => {
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function call(reg: ToolRegistry, name: string, args: Record<string, unknown> = {}) {
  return JSON.parse(await reg.dispatch(name, JSON.stringify(args)));
}

/** A local skill directory ready to install under `work`. */
function skillSource(id: string): string {
  const source = join(s.work, id);
  writeSkillDir(source, { name: id, description: `Runs the ${id} workflow.` });
  return source;
}

describe("install_skill", () => {
  it("installs a local skill directory into the store", async () => {
    const source = skillSource("churn-analysis");

    const r = await call(s.reg, "install_skill", { source });

    expect(r.success).toBe(true);
    expect(r.installed).toEqual([
      {
        id: "churn-analysis",
        path: join(skillsRoot(s.home), "churn-analysis", "SKILL.md"),
      },
    ]);
    expect(existsSync(join(skillsRoot(s.home), "churn-analysis", "SKILL.md"))).toBe(true);
    expect(loadGlobalPathAllowed(s.configPath)).toContain(
      join(skillsRoot(s.home), "churn-analysis"),
    );
  });

  it("installs every skill of a repository skills tree", async () => {
    const repo = join(s.work, "repo");
    writeSkillsTree(repo, ["meta-ads", "seo-analysis"]);

    const r = await call(s.reg, "install_skill", { source: repo });

    expect(r.installed.map((entry: { id: string }) => entry.id)).toEqual([
      "meta-ads",
      "seo-analysis",
    ]);
  });

  it("reports a source with no SKILL.md instead of throwing", async () => {
    const source = join(s.work, "not-a-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# nothing", "utf8");

    const r = await call(s.reg, "install_skill", { source });

    expect(r.error).toMatch(/no SKILL\.md/);
    expect(existsSync(skillsRoot(s.home))).toBe(true);
  });

  it("requires a source", async () => {
    const r = await call(s.reg, "install_skill", { source: "   " });
    expect(r.error).toMatch(/requires 'source'/);
  });

  it("tells the model the skill waits for a new chat", async () => {
    const r = await call(s.reg, "install_skill", { source: skillSource("later") });
    expect(r.enabled_in_this_chat).toBe(false);
    expect(r.note).toMatch(/chats created after this one/);
  });
});

describe("uninstall_skill", () => {
  it("removes the files and the read grant", async () => {
    const source = skillSource("churn-analysis");
    await call(s.reg, "install_skill", { source });
    const dir = join(skillsRoot(s.home), "churn-analysis");
    expect(loadGlobalPathAllowed(s.configPath)).toContain(dir);

    const r = await call(s.reg, "uninstall_skill", { id: "churn-analysis" });

    expect(r.success).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(loadGlobalPathAllowed(s.configPath)).not.toContain(dir);
  });

  it("resolves a declared skill name to its store id", async () => {
    await call(s.reg, "install_skill", { source: skillSource("churn-analysis") });

    const r = await call(s.reg, "uninstall_skill", { id: "churn-analysis" });

    expect(r.id).toBe("churn-analysis");
  });

  it("names the plugin that ships the skill", async () => {
    writePluginTree(join(s.work, "plugin"));
    await call(s.reg, "install_plugin", { source: join(s.work, "plugin") });

    const r = await call(s.reg, "uninstall_skill", { id: FIXTURE_SKILLS[0] });

    expect(r.error).toMatch(/ships with the notfair plugin/);
    expect(r.error).toMatch(/uninstall_plugin/);
  });

  it("lists the installed ids when the name is unknown", async () => {
    await call(s.reg, "install_skill", { source: skillSource("known") });

    const r = await call(s.reg, "uninstall_skill", { id: "ghost" });

    expect(r.error).toMatch(/no standalone skill named "ghost"/);
    expect(r.error).toMatch(/Installed: known/);
  });

  it("says none are installed when the store is empty", async () => {
    const r = await call(s.reg, "uninstall_skill", { id: "ghost" });
    expect(r.error).toMatch(/None are installed/);
  });
});

describe("install_plugin", () => {
  it("installs the plugin tree with its skills and servers", async () => {
    const source = join(s.work, "plugin");
    writePluginTree(source);

    const r = await call(s.reg, "install_plugin", { source });

    expect(r.success).toBe(true);
    expect(r.slug).toBe("notfair");
    expect(r.name).toBe("NotFair");
    expect(r.version).toBe("0.27.17");
    expect(r.skills).toEqual(FIXTURE_SKILLS);
    expect(r.servers).toEqual(["notfair"]);
    expect(r.dir).toBe(join(pluginsRoot(s.home), "notfair"));
    const cfg = readConfig(s.configPath);
    expect(cfg.plugins?.notfair?.source).toBe(source);
    expect(cfg.mcpServers?.notfair).toMatchObject({ plugin: "notfair" });
  });

  it("tells the model the plugin waits for a new chat", async () => {
    writePluginTree(join(s.work, "plugin"));
    const r = await call(s.reg, "install_plugin", { source: join(s.work, "plugin") });
    expect(r.enabled_in_this_chat).toBe(false);
    expect(r.note).toMatch(/the user chooses what each chat may use/);
  });

  it("reports an invalid manifest instead of throwing", async () => {
    const source = join(s.work, "broken");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({ version: "1.0.0" }), "utf8");

    const r = await call(s.reg, "install_plugin", { source });

    expect(r.error).toMatch(/name/);
    expect(existsSync(join(pluginsRoot(s.home), "broken"))).toBe(false);
  });

  it("requires a source", async () => {
    const r = await call(s.reg, "install_plugin", { source: "  " });
    expect(r.error).toMatch(/requires 'source'/);
  });
});

describe("uninstall_plugin", () => {
  it("removes the tree, the record and the declared servers", async () => {
    writePluginTree(join(s.work, "plugin"));
    await call(s.reg, "install_plugin", { source: join(s.work, "plugin") });

    const r = await call(s.reg, "uninstall_plugin", { slug: "notfair" });

    expect(r.success).toBe(true);
    expect(r.removed_servers).toEqual(["notfair"]);
    expect(existsSync(join(pluginsRoot(s.home), "notfair"))).toBe(false);
    const cfg = readConfig(s.configPath);
    expect(cfg.plugins).toBeUndefined();
    expect(cfg.mcpServers).toBeUndefined();
  });

  it("reports a slug nothing is installed under", async () => {
    const r = await call(s.reg, "uninstall_plugin", { slug: "ghost" });
    expect(r.error).toMatch(/not installed/);
  });

  it("requires a slug", async () => {
    const r = await call(s.reg, "uninstall_plugin", { slug: " " });
    expect(r.error).toMatch(/requires 'slug'/);
  });
});

describe("list_capabilities", () => {
  function withSession(): Setup {
    return setup({
      getSessionPlugins: () => ["notfair"],
      getSessionSkills: () => ["churn-analysis"],
      getMcpSpecs: () => [
        {
          transport: "stdio",
          name: "blender",
          command: "uvx",
          args: ["blender-mcp"],
          disabled: false,
        },
        { transport: "sse", name: "remote", url: "https://example.com/sse", disabled: true },
      ],
    });
  }

  it("reports every installed plugin, skill and server", async () => {
    const live = withSession();
    writePluginTree(join(live.work, "plugin"));
    await call(live.reg, "install_plugin", { source: join(live.work, "plugin") });
    await call(live.reg, "install_skill", { source: skillSource("churn-analysis") });

    const r = await call(live.reg, "list_capabilities");

    expect(r.counts).toEqual({ plugins: 1, skills: 1, servers: 2 });
    expect(r.plugins[0]).toMatchObject({
      slug: "notfair",
      name: "NotFair",
      version: "0.27.17",
      enabled_here: true,
      disabled_by_default: false,
      dir: join(live.home, ".reasonix", "plugins", "notfair"),
      skills: FIXTURE_SKILLS,
      servers: ["notfair"],
    });
    expect(r.skills[0]).toMatchObject({
      id: "churn-analysis",
      name: "churn-analysis",
      enabled_here: true,
    });
    // A reported path is one the agent can open, not a guess at the store's layout.
    expect(existsSync(r.skills[0].path)).toBe(true);
    expect(r.servers).toEqual([
      {
        name: "blender",
        transport: "stdio",
        status: "configured",
        enabled_here: true,
        tool_count: 0,
      },
      {
        name: "remote",
        transport: "sse",
        status: "disabled",
        enabled_here: false,
        tool_count: 0,
      },
    ]);
    expect(r.session_reported).toBeUndefined();
  });

  it("reports enablement as false for a capability this chat did not take", async () => {
    const live = setup({
      getSessionPlugins: () => [],
      getSessionSkills: () => [],
    });
    await call(live.reg, "install_skill", { source: skillSource("churn-analysis") });

    const r = await call(live.reg, "list_capabilities", { kind: "skills" });

    expect(r.skills[0].enabled_here).toBe(false);
  });

  it("flags a host that reports no session state instead of claiming none is enabled", async () => {
    const r = await call(s.reg, "list_capabilities");

    expect(r.session_reported).toBe(false);
    expect(r.skills).toEqual([]);
    expect(r.plugins).toEqual([]);
  });

  it("filters one dimension at a time", async () => {
    writeConfig(
      { mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } },
      s.configPath,
    );

    const r = await call(s.reg, "list_capabilities", { kind: "mcp" });

    expect(r.plugins).toBeUndefined();
    expect(r.skills).toBeUndefined();
    expect(r.counts).toEqual({ servers: 1 });
    expect(r.servers[0]).toMatchObject({ name: "blender", status: "configured" });
  });

  it("marks an app-managed server and a plugin-owned one", async () => {
    writeConfig(
      {
        mcpServers: {
          pw: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
          notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" },
        },
      },
      s.configPath,
    );

    const r = await call(s.reg, "list_capabilities", { kind: "mcp" });

    expect(r.servers[0]).toMatchObject({ name: "pw", builtin: true });
    expect(r.servers[1]).toMatchObject({ name: "notfair", plugin: "notfair" });
    expect(r.servers[1].builtin).toBeUndefined();
  });

  it("counts the tools bridged behind a server", async () => {
    writeConfig(
      { mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } },
      s.configPath,
    );
    s.reg.register({
      name: "blender_render",
      description: "Render",
      parameters: { type: "object" },
      fn: async () => "ok",
    });

    const r = await call(s.reg, "list_capabilities", { kind: "mcp" });

    expect(r.servers[0]).toMatchObject({ status: "connected", tool_count: 1 });
  });

  it("rejects an unknown kind", async () => {
    const r = await call(s.reg, "list_capabilities", { kind: "agents" });
    expect(r.error).toMatch(/unknown kind/);
  });

  it("stays available in Read only while the install tools are refused", async () => {
    s.reg.setPlanMode(true);

    const listed = await call(s.reg, "list_capabilities");
    expect(listed.error).toBeUndefined();

    const refused = await call(s.reg, "install_skill", { source: skillSource("churn-analysis") });
    expect(refused.rejectedReason).toBe("read-only");
    expect(existsSync(skillsRoot(s.home))).toBe(false);
  });
});

describe("host refresh", () => {
  it("names the kind and the direction of every store write", async () => {
    const changes: string[] = [];
    const live = setup({
      onCapabilitiesChanged: (kind, change) => changes.push(`${kind}:${change}`),
    });
    writePluginTree(join(live.work, "plugin"));
    await call(live.reg, "install_plugin", { source: join(live.work, "plugin") });
    await call(live.reg, "install_skill", { source: skillSource("churn-analysis") });
    await call(live.reg, "uninstall_skill", { id: "churn-analysis" });
    await call(live.reg, "uninstall_plugin", { slug: "notfair" });

    expect(changes).toEqual([
      "plugin:installed",
      "skill:installed",
      "skill:removed",
      "plugin:removed",
    ]);
  });

  it("stays silent when a write fails", async () => {
    const changes: string[] = [];
    const live = setup({
      onCapabilitiesChanged: (kind, change) => changes.push(`${kind}:${change}`),
    });

    await call(live.reg, "uninstall_plugin", { slug: "ghost" });

    expect(changes).toEqual([]);
  });

  it("reports a completed install even when the host refresh throws", async () => {
    const live = setup({
      onCapabilitiesChanged: () => {
        throw new Error("projection blew up");
      },
    });

    const r = await call(live.reg, "install_skill", { source: skillSource("churn-analysis") });

    expect(r.success).toBe(true);
    expect(r.error).toBeUndefined();
    expect(existsSync(join(skillsRoot(live.home), "churn-analysis", "SKILL.md"))).toBe(true);
  });
});
