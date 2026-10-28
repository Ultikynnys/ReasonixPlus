import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import { PLUGIN_SKILLS_MAX_CHARS, codeSystemPrompt } from "../src/code/prompt.js";
import { ensureSessionDir, patchSessionMeta } from "../src/memory/session.js";
import { installPlugin } from "../src/plugins/store.js";
import { copyTree, writePluginTree, writeSkill } from "./support/plugin-fixture.js";

function entry(
  overrides: Partial<{
    plugin: string;
    name: string;
    description: string;
    skillsRoot: string;
  }> = {},
) {
  return {
    plugin: "notfair",
    name: "seo-analysis",
    description: "Full SEO audit combining Search Console and a technical crawl.",
    skillsRoot: "/plugins/notfair/skills",
    ...overrides,
  };
}

describe("plugin skill index", () => {
  it("stays out of the prompt when no plugin is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-plugin-prompt-"));
    try {
      expect(codeSystemPrompt(root)).not.toContain("# Plugin skills");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists each skill with its root, plugin and summary", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-plugin-prompt-"));
    try {
      const prompt = codeSystemPrompt(root, { pluginSkills: [entry()] });
      expect(prompt).toContain("# Plugin skills");
      expect(prompt).toContain("- notfair: `/plugins/notfair/skills`");
      expect(prompt).toContain(
        "- seo-analysis (notfair): Full SEO audit combining Search Console and a technical crawl.",
      );
      expect(prompt).toContain("read its SKILL.md completely and follow it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names every skill root a plugin declares, not only the first", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-plugin-prompt-"));
    try {
      const prompt = codeSystemPrompt(root, {
        pluginSkills: [
          entry({ name: "first", skillsRoot: "/plugins/notfair/skills" }),
          entry({ name: "second", skillsRoot: "/plugins/notfair/vendor-skills" }),
        ],
      });
      expect(prompt).toContain(
        "- notfair: `/plugins/notfair/skills`, `/plugins/notfair/vendor-skills`",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps the index and names the skills it left out", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-plugin-prompt-"));
    const skills = Array.from({ length: 80 }, (_, index) =>
      entry({
        name: `skill-${index}`,
        description: "x".repeat(120),
      }),
    );
    try {
      const prompt = codeSystemPrompt(root, { pluginSkills: skills });
      const section = prompt.slice(prompt.indexOf("# Plugin skills"));
      const indexed = section.slice(0, section.indexOf("more skill(s)"));
      expect(indexed.length).toBeLessThan(PLUGIN_SKILLS_MAX_CHARS + 400);
      expect(section).toMatch(/\d+ more skill\(s\) are not indexed here/);
      expect(section).not.toContain("skill-79");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshTabSystemPrompt with an installed plugin", () => {
  let home: string;
  let root: string;
  let configPath: string;
  let fixture: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-plugin-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-plugin-work-"));
    configPath = join(root, "config.json");
    fixture = join(root, "fixture");
    vi.stubEnv("REASONIX_CONFIG", configPath);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
    writePluginTree(fixture, { name: "notfair", servers: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** A chat whose meta was frozen at its session-start confirm. */
  function sessionFrozenAt(name: string, plugins: string[]): string {
    ensureSessionDir(name);
    patchSessionMeta(name, { mcp: {}, plugins });
    return name;
  }

  it("advertises the skills of a plugin this chat enabled", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession: sessionFrozenAt("with-plugin", ["notfair"]),
      system: "",
      toolset: {},
    };
    refreshTabSystemPrompt(tab);
    expect(tab.system).toContain("# Plugin skills");
    expect(tab.system).toContain("- seo-analysis (notfair): Runs the seo-analysis workflow.");
    expect(tab.system).toContain(join(home, ".reasonix", "plugins", "notfair", "skills"));
  });

  it("keeps the index out of a chat that enabled no plugin", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession: sessionFrozenAt("without-plugin", []),
      system: "",
      toolset: {},
    };
    refreshTabSystemPrompt(tab);
    expect(tab.system).not.toContain("# Plugin skills");
  });
});
