import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parsePluginManifest,
  pluginManifestPath,
  pluginSlug,
  readPluginManifest,
  resolvePluginRelativePath,
} from "../src/plugins/manifest.js";
import { pluginServerConfigs, pluginServerName } from "../src/plugins/servers.js";
import { indexPluginSkills, skillSummary } from "../src/plugins/skills.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reasonix-plugin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/** The Codex layout, trimmed to what notfair-plugin actually declares. */
function codexManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "notfair",
    version: "0.27.17",
    description: "Ads, analytics, SEO and GEO skills.",
    author: { name: "NotFair", url: "https://notfair.co" },
    homepage: "https://notfair.co",
    repository: "https://github.com/nowork-studio/notfair-plugin",
    license: "MIT",
    keywords: ["seo", "geo"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "NotFair",
      category: "Productivity",
      capabilities: ["Interactive", "Write"],
      defaultPrompt: ["Audit my Google Ads account."],
    },
    ...overrides,
  };
}

describe("readPluginManifest", () => {
  it("reads the Codex manifest under .codex-plugin", () => {
    writeJson(join(root, ".codex-plugin", "plugin.json"), codexManifest());
    const manifest = readPluginManifest(root);
    expect(manifest.name).toBe("notfair");
    expect(manifest.version).toBe("0.27.17");
    expect(manifest.authorName).toBe("NotFair");
    expect(manifest.skillsDirs).toEqual(["skills"]);
    expect(manifest.mcpServersFile).toBe(".mcp.json");
    expect(manifest.ui.category).toBe("Productivity");
    expect(manifest.ui.displayName).toBe("NotFair");
    expect(manifest.ui.capabilities).toEqual(["Interactive", "Write"]);
    expect(manifest.manifestPath.endsWith("plugin.json")).toBe(true);
  });

  it("falls back to the Agent Plugins root plugin.json extension block", () => {
    writeJson(join(root, "plugin.json"), {
      name: "notfair",
      version: "0.27.17",
      extensions: {
        "com.openai": {
          interface: { displayName: "NotFair", category: "Productivity" },
        },
      },
    });
    const manifest = readPluginManifest(root);
    expect(manifest.skillsDirs).toEqual(["skills"]);
    expect(manifest.mcpServersFile).toBeUndefined();
    expect(manifest.ui.category).toBe("Productivity");
  });

  it("prefers the Codex manifest when both layouts exist", () => {
    writeJson(join(root, ".codex-plugin", "plugin.json"), codexManifest({ name: "codex-one" }));
    writeJson(join(root, "plugin.json"), { name: "root-one" });
    expect(readPluginManifest(root).name).toBe("codex-one");
    expect(pluginManifestPath(root)?.includes(".codex-plugin")).toBe(true);
  });

  it("reports the offending field of an invalid manifest", () => {
    writeJson(join(root, ".codex-plugin", "plugin.json"), { version: "1.0.0" });
    expect(() => readPluginManifest(root)).toThrow(/name/);
  });

  it("refuses a directory with no manifest", () => {
    expect(() => readPluginManifest(root)).toThrow(/no \.codex-plugin/);
  });

  it("reads inline mcpServers instead of a file", () => {
    const manifest = parsePluginManifest({
      name: "inline",
      mcpServers: { Inline: { type: "http", url: "https://example.com/mcp" } },
    });
    expect(manifest.mcpServersFile).toBeUndefined();
    expect(manifest.inlineMcpServers).toBeDefined();
  });
});

describe("plugin paths", () => {
  it("slugs a display name into a directory key", () => {
    expect(pluginSlug("NotFair Plugin")).toBe("notfair-plugin");
    expect(pluginSlug("  ")).toBe("plugin");
  });

  it("refuses a relative path that leaves the plugin directory", () => {
    expect(resolvePluginRelativePath("./skills/", "skills")).toBe("skills");
    expect(() => resolvePluginRelativePath("../vendor/skills", "skills")).toThrow(/leave/);
    expect(() => resolvePluginRelativePath("C:/plugins/skills", "skills")).toThrow(/relative/);
  });

  it("rejects a manifest whose skills path escapes", () => {
    expect(() => parsePluginManifest({ name: "x", skills: "../../etc" })).toThrow(/leave/);
  });
});

describe("indexPluginSkills", () => {
  function writeSkill(id: string, body: string): void {
    const dir = join(root, "skills", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  }

  it("reads frontmatter names and folded descriptions", () => {
    writeSkill(
      "seo-analysis",
      [
        "---",
        "name: seo-analysis",
        "description: >",
        "  Full SEO audit combining Search Console,",
        "  a technical crawl and metadata checks.",
        "  Extra detail that is not the first sentence.",
        "---",
        "",
        "# Workflow",
        "",
        "Read the workflow file.",
      ].join("\n"),
    );
    writeSkill("no-frontmatter", "Plain instructions only.\n");
    const manifest = readPluginManifestOr({ skills: "./skills/" });
    const skills = indexPluginSkills(root, manifest);
    expect(skills.map((skill) => skill.name)).toEqual(["no-frontmatter", "seo-analysis"]);
    const seo = skills.find((skill) => skill.name === "seo-analysis")!;
    expect(seo.description).toBe(
      "Full SEO audit combining Search Console, a technical crawl and metadata checks.",
    );
    expect(seo.relPath).toBe("skills/seo-analysis/SKILL.md");
    expect(seo.skillsRoot).toBe(join(root, "skills"));
    expect(skills.find((skill) => skill.name === "no-frontmatter")!.description).toBe(
      "Plain instructions only.",
    );
  });

  it("indexes every declared skill root and reports each one", () => {
    writeSkill("main-skill", "---\nname: main-skill\ndescription: From the main root.\n---\n");
    mkdirSync(join(root, "vendor-skills", "vendor-skill"), { recursive: true });
    writeFileSync(
      join(root, "vendor-skills", "vendor-skill", "SKILL.md"),
      "---\nname: vendor-skill\ndescription: From the vendor root.\n---\n",
      "utf8",
    );
    const skills = indexPluginSkills(root, { skillsDirs: ["skills", "vendor-skills"] });
    expect(skills.map((skill) => skill.name)).toEqual(["main-skill", "vendor-skill"]);
    expect(skills.map((skill) => skill.skillsRoot)).toEqual([
      join(root, "skills"),
      join(root, "vendor-skills"),
    ]);
  });

  it("returns nothing when the skills directory is absent", () => {
    expect(indexPluginSkills(root, { skillsDirs: ["skills"] })).toEqual([]);
  });

  it("caps a long summary and keeps it on one line", () => {
    const long = `${"word ".repeat(60)}end`;
    const summary = skillSummary(long, 40);
    expect(summary.length).toBeLessThanOrEqual(43);
    expect(summary.endsWith("...")).toBe(true);
    expect(summary).not.toContain("\n");
  });
});

function readPluginManifestOr(fields: Record<string, unknown>) {
  return parsePluginManifest({ name: "notfair", ...fields });
}

describe("pluginServerConfigs", () => {
  it("maps the declared .mcp.json block into owned entries", () => {
    writeJson(join(root, ".codex-plugin", "plugin.json"), codexManifest());
    writeJson(join(root, ".mcp.json"), {
      mcpServers: {
        NotFair: { type: "http", url: "https://notfair.co/api/mcp/notfair" },
      },
    });
    const manifest = readPluginManifest(root);
    const servers = pluginServerConfigs(root, manifest);
    expect(Object.keys(servers)).toEqual(["notfair"]);
    expect(servers.notfair).toEqual({
      url: "https://notfair.co/api/mcp/notfair",
      type: "http",
      plugin: "notfair",
    });
  });

  it("namespaces a server that does not carry the plugin name", () => {
    expect(pluginServerName("notfair", "NotFair")).toBe("notfair");
    expect(pluginServerName("notfair", "Analytics")).toBe("notfair-analytics");
  });

  it("keeps stdio env and drops entries with neither command nor url", () => {
    const servers = pluginServerConfigs(root, {
      name: "local-tools",
      keywords: [],
      skillsDirs: ["skills"],
      inlineMcpServers: {
        server: { type: "stdio", command: "node", args: ["s.js", 3], env: { TOKEN: "x" } },
        broken: { type: "http" },
      },
      ui: {},
      manifestPath: "plugin.json",
    });
    expect(Object.keys(servers)).toEqual(["local-tools-server"]);
    expect(servers["local-tools-server"]).toEqual({
      command: "node",
      args: ["s.js"],
      transport: "stdio",
      env: { TOKEN: "x" },
      plugin: "local-tools",
    });
  });

  it("fails loudly when the declared mcpServers file is missing", () => {
    const manifest = parsePluginManifest({ name: "x", mcpServers: "./missing.json" });
    expect(() => pluginServerConfigs(root, manifest)).toThrow(/missing/);
  });
});
