import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import {
  PLUGINS_MAX_CHARS,
  SKILLS_MAX_CHARS,
  codeSystemPrompt,
  compactRoots,
} from "../src/code/prompt.js";
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

  it("names one root for a plugin whose skills sit in sibling directories", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-skill-prompt-"));
    try {
      const skills = Array.from({ length: 20 }, (_, index) =>
        entry({ name: `skill-${index}`, skillsRoot: `/plugins/unifapi/skills/group-${index}` }),
      );
      const prompt = codeSystemPrompt(root, { skills });
      const rootLine = prompt.split("\n").find((row) => row.startsWith("- notfair: "));
      expect(rootLine).toBe("- notfair: `/plugins/unifapi/skills`");
      expect(prompt).toContain(
        "Skill roots (a directory of skill directories, or a single skill directory)",
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

describe("plugin inventory in the prompt", () => {
  const root = () => mkdtempSync(join(tmpdir(), "reasonix-plugin-prompt-"));

  it("stays out of the prompt when nothing is installed", () => {
    const dir = root();
    try {
      expect(codeSystemPrompt(dir)).not.toContain("# Plugins");
      expect(codeSystemPrompt(dir, { plugins: [] })).not.toContain("# Plugins");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names each installed plugin, what it ships and whether this chat enabled it", () => {
    const dir = root();
    try {
      const prompt = codeSystemPrompt(dir, {
        plugins: [
          {
            name: "notfair",
            displayName: "NotFair",
            version: "0.27.17",
            skillsRoots: ["/plugins/notfair/skills"],
            skillCount: 48,
            enabled: true,
          },
          {
            name: "other",
            displayName: "Other",
            skillsRoots: [],
            skillCount: 0,
            enabled: false,
          },
        ],
      });
      expect(prompt).toContain("# Plugins");
      expect(prompt).toContain("Settings > Plugins");
      expect(prompt).toContain("- NotFair (notfair) 0.27.17 - enabled here. Ships 48 skills");
      expect(prompt).toContain("`/plugins/notfair/skills`");
      expect(prompt).toContain("- Other (other) - not enabled here. Ships 0 skills.");
      expect(prompt).toContain("usable only in a chat whose start enabled it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps the inventory and names how many it left out", () => {
    const dir = root();
    const plugins = Array.from({ length: 40 }, (_, index) => ({
      name: `plugin-${index}`,
      displayName: `Plugin ${index}`,
      version: "1.0.0",
      skillsRoots: ["/plugins/some/much/longer/skills/root/path"],
      skillCount: 12,
      enabled: false,
    }));
    try {
      const prompt = codeSystemPrompt(dir, { plugins });
      const section = prompt.slice(prompt.indexOf("# Plugins"));
      const listed = section.slice(0, section.indexOf("more plugin(s)"));
      expect(listed.length).toBeLessThan(PLUGINS_MAX_CHARS + 200);
      expect(section).toMatch(/\d+ more plugin\(s\) installed/);
      expect(section).not.toContain("Plugin 39");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacts a plugin that lists one directory per skill into its common parent", () => {
    const dir = root();
    const roots = Array.from(
      { length: 24 },
      (_, index) => `/plugins/unifapi/skills/agent-${index}`,
    ).concat("/plugins/unifapi/skills");
    try {
      const prompt = codeSystemPrompt(dir, {
        plugins: [
          {
            name: "unifapi",
            displayName: "UnifAPI",
            version: "1.0.0",
            skillsRoots: roots,
            skillCount: 47,
            enabled: false,
          },
          {
            name: "rayfin",
            displayName: "Rayfin",
            version: "0.4.2",
            skillsRoots: ["/plugins/rayfin/skills"],
            skillCount: 1,
            enabled: false,
          },
        ],
      });
      const lines = prompt.split("\n").filter((row) => row.startsWith("- "));
      const unifapi = lines.find((row) => row.includes("(unifapi)"))!;
      expect(unifapi).toContain("`/plugins/unifapi/skills`");
      expect(unifapi).not.toContain("agent-1");
      expect(unifapi.length).toBeLessThan(160);
      // The second plugin still gets its own line: one long plugin cannot hide the rest.
      expect(lines.some((row) => row.includes("(rayfin)"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps unrelated roots apart and nested ones folded", () => {
    expect(
      compactRoots([join("/p", "skills"), join("/p", "skills", "one"), join("/p", "vendor")]),
    ).toEqual([join("/p", "skills"), join("/p", "vendor")]);
    // A hand-written manifest can mix separators; both count as nesting.
    expect(compactRoots(["/p/skills", "/p/skills/one", "/p/vendor"])).toEqual([
      "/p/skills",
      "/p/vendor",
    ]);
    expect(compactRoots(Array.from({ length: 9 }, (_, i) => `/p/skills/g${i}`))).toEqual([
      "/p/skills",
    ]);
    expect(compactRoots([])).toEqual([]);
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

  it("tells a chat about a plugin it did not enable, and withholds its skills", async () => {
    await installPlugin(fixture, { homeDir: home, configPath, copy: copyTree(() => fixture) });
    const tab = tabFor(frozenChat("inventory-only", []));
    refreshTabSystemPrompt(tab);
    expect(tab.system).toContain("# Plugins");
    expect(tab.system).toContain("- NotFair (notfair) 0.27.17 - not enabled here. Ships 3 skills");
    expect(tab.system).toContain(join(home, ".reasonix", "plugins", "notfair", "skills"));
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
