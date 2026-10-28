import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import { SKILLS_MAX_CHARS, codeSystemPrompt } from "../src/code/prompt.js";
import { ensureSessionDir, patchSessionMeta } from "../src/memory/session.js";
import { installPlugin } from "../src/plugins/store.js";
import { installSkills } from "../src/skills/store.js";
import { copyTree, stubPluginHome, writePluginTree } from "./support/plugin-fixture.js";
import { writeSkillDir } from "./support/skill-fixture.js";

function entry(
  overrides: Partial<{
    owner: string | undefined;
    name: string;
    description: string;
    skillsRoot: string;
  }> = {},
) {
  return {
    owner: "notfair",
    name: "seo-analysis",
    description: "Full SEO audit combining Search Console and a technical crawl.",
    skillsRoot: "/plugins/notfair/skills",
    ...overrides,
  };
}

describe("skill index", () => {
  it("stays out of the prompt when the chat froze no skills", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    try {
      expect(codeSystemPrompt(root)).not.toContain("# Skills");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists each skill with its root, owner and summary", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    try {
      const prompt = codeSystemPrompt(root, { skills: [entry()] });
      expect(prompt).toContain("# Skills");
      expect(prompt).toContain("- notfair: `/plugins/notfair/skills`");
      expect(prompt).toContain(
        "- seo-analysis (notfair): Full SEO audit combining Search Console and a technical crawl.",
      );
      expect(prompt).toContain("read its SKILL.md completely and follow it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists a standalone skill under its own root, without an owner tag", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    try {
      const prompt = codeSystemPrompt(root, {
        skills: [
          entry({ owner: undefined, name: "churn-analysis", skillsRoot: "/home/skills" }),
          entry(),
        ],
      });
      expect(prompt).toContain("- standalone: `/home/skills`");
      expect(prompt).toContain("- churn-analysis: Full SEO audit");
      expect(prompt).toContain("- seo-analysis (notfair): Full SEO audit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names every skill root a plugin declares, not only the first", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    try {
      const prompt = codeSystemPrompt(root, {
        skills: [
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
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    const skills = Array.from({ length: 80 }, (_, index) =>
      entry({
        name: `skill-${index}`,
        description: "x".repeat(120),
      }),
    );
    try {
      const prompt = codeSystemPrompt(root, { skills });
      const section = prompt.slice(prompt.indexOf("# Skills"));
      const indexed = section.slice(0, section.indexOf("more skill(s)"));
      expect(indexed.length).toBeLessThan(SKILLS_MAX_CHARS + 400);
      expect(section).toMatch(/\d+ more skill\(s\) are not indexed here/);
      expect(section).not.toContain("skill-79");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refreshTabSystemPrompt with installed skills", () => {
  let home: string;
  let root: string;
  let configPath: string;
  let fixture: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skill-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-skill-work-"));
    configPath = join(root, "config.json");
    fixture = join(root, "fixture");
    stubPluginHome(home, configPath);
    writePluginTree(fixture, { name: "notfair", servers: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** A chat whose meta was frozen at its session-start confirm. */
  function frozenChat(name: string, plugins: string[], skills: string[] = []): string {
    ensureSessionDir(name);
    patchSessionMeta(name, { mcp: {}, plugins, skills });
    return name;
  }

  function tabFor(currentSession: string) {
    return {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession,
      system: "",
      toolset: {},
    };
  }

  async function installStandalone(name: string): Promise<void> {
    const dir = join(root, `src-${name}`);
    writeSkillDir(dir, { name, description: `Runs the ${name} workflow.` });
    await installSkills(dir, { homeDir: home, configPath });
  }

  it("advertises the skills of a plugin this chat enabled", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    const tab = tabFor(frozenChat("with-plugin", ["notfair"]));
    refreshTabSystemPrompt(tab);
    expect(tab.system).toContain("# Skills");
    expect(tab.system).toContain("- seo-analysis (notfair): Runs the seo-analysis workflow.");
    expect(tab.system).toContain(join(home, ".reasonix", "plugins", "notfair", "skills"));
  });

  it("advertises a standalone skill the chat froze", async () => {
    await installStandalone("churn-analysis");
    const tab = tabFor(frozenChat("with-skill", [], ["churn-analysis"]));
    refreshTabSystemPrompt(tab);
    expect(tab.system).toContain("- churn-analysis: Runs the churn-analysis workflow.");
    expect(tab.system).toContain(`- standalone: \`${join(home, ".reasonix", "skills")}\``);
  });

  it("keeps a frozen-out standalone skill out of the index", async () => {
    await installStandalone("churn-analysis");
    const tab = tabFor(frozenChat("without-skill", []));
    refreshTabSystemPrompt(tab);
    expect(tab.system).not.toContain("# Skills");
  });

  it("keeps the index out of a chat that enabled no plugin", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    const tab = tabFor(frozenChat("without-plugin", []));
    refreshTabSystemPrompt(tab);
    expect(tab.system).not.toContain("# Skills");
  });

  it("ignores a plugin skill named in the standalone set, so a skill cannot bypass its plugin", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    // "seo-analysis" ships with notfair; naming it as a standalone skill must not index
    // it while the plugin itself stays off for this chat.
    const tab = tabFor(frozenChat("skill-name-only", [], ["seo-analysis"]));
    refreshTabSystemPrompt(tab);
    expect(tab.system).not.toContain("# Skills");
  });
});
