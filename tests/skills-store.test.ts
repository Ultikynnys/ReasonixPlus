import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../src/config.js";
import { loadGlobalPathAllowed } from "../src/config.js";
import { copyInstallSource } from "../src/install/source.js";
import {
  installSkills,
  listSkills,
  skillsById,
  skillsRoot,
  uninstallSkill,
} from "../src/skills/store.js";
import { writeSkillDir, writeSkillsTree } from "./support/skill-fixture.js";

let work: string;
let home: string;
let configPath: string;

function install(source: string, copy = copyInstallSource) {
  return installSkills(source, { homeDir: home, configPath, copy });
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "reasonix-skill-store-"));
  home = join(work, "home");
  configPath = join(work, "config.json");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("installSkills", () => {
  it("installs a single skill directory and grants read access", async () => {
    const source = join(work, "churn-analysis");
    writeSkillDir(source, { name: "churn-analysis", description: "Predicts churn." });

    const installed = await install(source);

    expect(installed.ids).toEqual(["churn-analysis"]);
    const [skill] = listSkills({ homeDir: home });
    expect(skill.name).toBe("churn-analysis");
    expect(skill.description).toBe("Predicts churn.");
    expect(existsSync(join(skillsRoot(home), "churn-analysis", "SKILL.md"))).toBe(true);
    expect(loadGlobalPathAllowed(configPath)).toContain(skill.dir);
  });

  it("installs every skill of a repository skills tree", async () => {
    const repo = join(work, "repo");
    writeSkillsTree(repo, ["meta-ads", "seo-analysis"]);

    const installed = await install(repo);

    expect(installed.ids).toEqual(["meta-ads", "seo-analysis"]);
    expect(listSkills({ homeDir: home }).map((skill) => skill.id)).toEqual([
      "meta-ads",
      "seo-analysis",
    ]);
  });

  it("keeps the store id filesystem-safe while showing the declared name", async () => {
    const source = join(work, "repo");
    writeSkillDir(join(source, "skills", "Meta Ads"), { name: "Meta Ads Pro" });

    const installed = await install(source);

    expect(installed.ids).toEqual(["meta-ads-pro"]);
    expect(listSkills({ homeDir: home })[0]).toMatchObject({
      id: "meta-ads-pro",
      name: "Meta Ads Pro",
    });
  });

  it("refuses a source with no SKILL.md and leaves nothing behind", async () => {
    const source = join(work, "not-a-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "README.md"), "# nothing here", "utf8");

    await expect(install(source)).rejects.toThrow(/no SKILL\.md/);
    expect(existsSync(skillsRoot(home)) ? listSkills({ homeDir: home }) : []).toEqual([]);
  });

  it("refuses an id that is already installed and installs none of the batch", async () => {
    const first = join(work, "first");
    writeSkillDir(join(first, "skills", "taken"), { name: "taken" });
    await install(first);

    const second = join(work, "second");
    writeSkillDir(join(second, "skills", "fresh"), { name: "fresh" });
    writeSkillDir(join(second, "skills", "taken"), { name: "taken" });

    await expect(install(second)).rejects.toThrow(/taken is already installed at/);
    expect(listSkills({ homeDir: home }).map((skill) => skill.id)).toEqual(["taken"]);
  });

  it("refuses two directories that declare the same name", async () => {
    const source = join(work, "dupes");
    writeSkillDir(join(source, "skills", "one"), { name: "same" });
    writeSkillDir(join(source, "skills", "two"), { name: "same" });

    await expect(install(source)).rejects.toThrow(/same appears twice/);
    expect(listSkills({ homeDir: home })).toEqual([]);
  });

  it("rolls back a moved skill when a later step fails", async () => {
    const source = join(work, "repo");
    writeSkillsTree(source, ["first", "second"]);
    let grants = 0;
    const spy = vi.spyOn(configModule, "addGlobalPathAllowed").mockImplementation(() => {
      grants += 1;
      if (grants === 2) throw new Error("config write failed");
      return 0;
    });
    try {
      await expect(install(source)).rejects.toThrow(/config write failed/);
    } finally {
      spy.mockRestore();
    }
    expect(listSkills({ homeDir: home })).toEqual([]);
  });
});

describe("listSkills", () => {
  it("skips a directory without a SKILL.md", () => {
    mkdirSync(join(skillsRoot(home), "stray"), { recursive: true });
    expect(listSkills({ homeDir: home })).toEqual([]);
  });

  it("skips a directory whose SKILL.md is not a file", () => {
    const dir = join(skillsRoot(home), "broken");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "SKILL.md"));
    expect(listSkills({ homeDir: home })).toEqual([]);
  });

  it("reads only the ids it is asked for", () => {
    writeSkillDir(join(skillsRoot(home), "wanted"), { name: "wanted" });
    writeSkillDir(join(skillsRoot(home), "other"), { name: "other" });
    expect(skillsById(["wanted"], { homeDir: home }).map((skill) => skill.id)).toEqual(["wanted"]);
  });

  it("ignores an id that would leave the skills root", () => {
    writeSkillDir(join(work, "escape"), { name: "escape" });
    expect(skillsById(["../escape"], { homeDir: home })).toEqual([]);
  });
});

describe("uninstallSkill", () => {
  it("removes the files and the read grant", async () => {
    const source = join(work, "gone");
    writeSkillDir(source, { name: "gone" });
    await install(source);
    const dir = join(skillsRoot(home), "gone");
    expect(loadGlobalPathAllowed(configPath)).toContain(dir);

    uninstallSkill("gone", { homeDir: home, configPath });

    expect(existsSync(dir)).toBe(false);
    expect(loadGlobalPathAllowed(configPath)).not.toContain(dir);
  });

  it("refuses a skill that is not installed", () => {
    expect(() => uninstallSkill("missing", { homeDir: home, configPath })).toThrow(
      /missing is not installed/,
    );
  });

  it("refuses an id that would leave the skills root", () => {
    expect(() => uninstallSkill("../escape", { homeDir: home, configPath })).toThrow(
      /is not installed/,
    );
  });
});
