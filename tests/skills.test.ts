/** Skills store — temp homeDir / projectRoot per test, no real skill dirs touched. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore } from "../src/skills.js";

type SkillRoot = "project" | "global" | "custom";

function writeSkillDir(
  root: string,
  which: SkillRoot,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
  homeOrProject: string,
): string {
  const parent =
    which === "global"
      ? join(homeOrProject, ".reasonix", "skills")
      : which === "project"
        ? join(root, ".reasonix", "skills")
        : homeOrProject;
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) fmLines.push(`${k}: ${v}`);
  fmLines.push("---", "");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `${fmLines.join("\n")}${body}\n`, "utf8");
  return path;
}

function writeFlatSkill(
  dir: string,
  name: string,
  frontmatter: Record<string, string>,
  body: string,
): string {
  const skills = join(dir, ".reasonix", "skills");
  mkdirSync(skills, { recursive: true });
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) fmLines.push(`${k}: ${v}`);
  fmLines.push("---", "");
  const path = join(skills, `${name}.md`);
  writeFileSync(path, `${fmLines.join("\n")}${body}\n`, "utf8");
  return path;
}

describe("SkillStore", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skills-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-skills-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("returns an empty list when no skill dirs exist", () => {
    const store = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true });
    expect(store.list()).toEqual([]);
  });

  it("parses a SKILL.md dir-layout entry from the global scope", () => {
    writeSkillDir(
      projectRoot,
      "global",
      "review",
      { name: "review", description: "Review a pull request" },
      "Run `git diff` and summarize risks.",
      home,
    );
    const skills = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true }).list();
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("review");
    expect(skills[0]?.scope).toBe("global");
    expect(skills[0]?.body).toContain("git diff");
  });

  it("reads flat <name>.md files as well", () => {
    writeFlatSkill(home, "ship-it", { description: "Commit and push changes" }, "body");
    const skills = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true }).list();
    expect(skills.map((s) => s.name)).toEqual(["ship-it"]);
    expect(skills[0]?.description).toBe("Commit and push changes");
  });

  it("surfaces project-scope skills from <projectRoot>/.reasonix/skills", () => {
    writeSkillDir(
      projectRoot,
      "project",
      "deploy",
      { description: "Deploy to staging" },
      "Run the staging pipeline.",
      home,
    );
    const list = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true }).list();
    expect(list).toHaveLength(1);
    expect(list[0]?.scope).toBe("project");
    expect(list[0]?.path).toContain(projectRoot);
  });

  it("discovers .agents/skills as a default root (#870) — both project and global", () => {
    const projParent = join(projectRoot, ".agents", "skills");
    mkdirSync(projParent, { recursive: true });
    const projPath = join(projParent, "deploy", "SKILL.md");
    mkdirSync(join(projParent, "deploy"));
    writeFileSync(projPath, "---\ndescription: from .agents\n---\nbody\n", "utf8");

    const globParent = join(home, ".agents", "skills");
    mkdirSync(globParent, { recursive: true });
    const globPath = join(globParent, "review", "SKILL.md");
    mkdirSync(join(globParent, "review"));
    writeFileSync(globPath, "---\ndescription: glob agents\n---\nbody\n", "utf8");

    const store = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true });
    const names = store.list().map((s) => s.name);
    expect(names).toContain("deploy");
    expect(names).toContain("review");
  });

  it("project scope wins on a name collision with global", () => {
    writeSkillDir(projectRoot, "global", "review", { description: "global one" }, "G", home);
    writeSkillDir(projectRoot, "project", "review", { description: "project one" }, "P", home);
    const store = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true });
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.scope).toBe("project");
    expect(list[0]?.description).toBe("project one");
    expect(store.read("review")?.body).toBe("P");
  });

  it("without projectRoot the store only reads the global scope", () => {
    // Put a skill in the project dir and a skill in the global dir.
    writeSkillDir(projectRoot, "project", "deploy", { description: "proj" }, "P", home);
    writeSkillDir(projectRoot, "global", "review", { description: "glob" }, "G", home);
    const store = new SkillStore({ homeDir: home, disableBuiltins: true }); // no projectRoot
    const names = store.list().map((s) => s.name);
    expect(names).toEqual(["review"]);
  });

  it("rejects invalid skill names on read()", () => {
    const store = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true });
    expect(store.read("../etc/passwd")).toBeNull();
    expect(store.read("foo/bar")).toBeNull();
    expect(store.read("")).toBeNull();
  });

  it("skips dotfiles that would masquerade as skills", () => {
    writeSkillDir(projectRoot, "global", "ok", { description: "fine" }, "body", home);
    const dotDir = join(home, ".reasonix", "skills");
    writeFileSync(join(dotDir, ".hidden.md"), "---\ndescription: x\n---\nbody\n", "utf8");
    const list = new SkillStore({ homeDir: home, projectRoot, disableBuiltins: true }).list();
    expect(list.map((s) => s.name)).toEqual(["ok"]);
  });

  it("reads custom flat and dir-layout skills directly from configured roots", () => {
    const custom = mkdtempSync(join(tmpdir(), "reasonix-skills-custom-"));
    try {
      writeSkillDir(
        projectRoot,
        "custom",
        "custom-dir",
        { description: "custom dir" },
        "D",
        custom,
      );
      const flatPath = join(custom, "custom-flat.md");
      writeFileSync(flatPath, "---\ndescription: custom flat\n---\nF\n", "utf8");
      const list = new SkillStore({
        homeDir: home,
        projectRoot,
        customSkillPaths: [custom],
        disableBuiltins: true,
      }).list();
      expect(list.map((s) => `${s.scope}:${s.name}`)).toEqual([
        "custom:custom-dir",
        "custom:custom-flat",
      ]);
      expect(list.find((s) => s.name === "custom-flat")?.path).toBe(flatPath);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("deduplicates custom roots and preserves first priority", () => {
    const custom = mkdtempSync(join(tmpdir(), "reasonix-skills-custom-"));
    try {
      const roots = new SkillStore({
        homeDir: home,
        projectRoot,
        customSkillPaths: [custom, custom],
        disableBuiltins: true,
      }).customRoots();
      expect(roots.map((r) => r.dir)).toEqual([custom]);
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("resolves relative custom roots against projectRoot for discovery", () => {
    const relativeRoot = "skills-local";
    const custom = join(projectRoot, relativeRoot);
    writeSkillDir(projectRoot, "custom", "local-skill", { description: "local" }, "L", custom);
    const store = new SkillStore({
      homeDir: home,
      projectRoot,
      customSkillPaths: [relativeRoot, custom],
      disableBuiltins: true,
    });
    expect(store.customRoots().map((r) => r.dir)).toEqual([resolve(projectRoot, relativeRoot)]);
    expect(store.list().map((s) => s.name)).toEqual(["local-skill"]);
  });

  it("keeps priority project > custom > global on same-name collisions", () => {
    const custom = mkdtempSync(join(tmpdir(), "reasonix-skills-custom-"));
    try {
      writeSkillDir(projectRoot, "global", "same", { description: "global" }, "G", home);
      writeSkillDir(projectRoot, "custom", "same", { description: "custom" }, "C", custom);
      const customWinner = new SkillStore({
        homeDir: home,
        projectRoot,
        customSkillPaths: [custom],
        disableBuiltins: true,
      }).read("same");
      expect(customWinner?.scope).toBe("custom");
      writeSkillDir(projectRoot, "project", "same", { description: "project" }, "P", home);
      const projectWinner = new SkillStore({
        homeDir: home,
        projectRoot,
        customSkillPaths: [custom],
        disableBuiltins: true,
      }).read("same");
      expect(projectWinner?.scope).toBe("project");
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("reports invalid custom root status without throwing", () => {
    const missing = join(projectRoot, "missing-skills");
    const notDir = join(projectRoot, "file.txt");
    writeFileSync(notDir, "x", "utf8");
    const store = new SkillStore({
      homeDir: home,
      projectRoot,
      customSkillPaths: [missing, notDir],
      disableBuiltins: true,
    });
    expect(store.list()).toEqual([]);
    expect(store.customRoots().map((r) => r.status)).toEqual(["missing", "not-directory"]);
  });
});

describe("Claude SKILL.md aliases", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skills-claude-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeClaudeSkill(
    base: string,
    where: "global" | "project",
    name: string,
    frontmatter: Record<string, string>,
    body: string,
  ): void {
    const parent =
      where === "global" ? join(base, ".claude", "skills") : join(base, ".claude", "skills");
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    const fmLines = ["---"];
    for (const [k, v] of Object.entries(frontmatter)) fmLines.push(`${k}: ${v}`);
    fmLines.push("---", "");
    writeFileSync(join(dir, "SKILL.md"), `${fmLines.join("\n")}${body}\n`, "utf8");
  }

  it("reads skills from ~/.claude/skills/", () => {
    writeClaudeSkill(home, "global", "from-claude", { description: "lifted from Claude" }, "go");
    const store = new SkillStore({ homeDir: home, disableBuiltins: true });
    const skill = store.read("from-claude");
    expect(skill?.description).toBe("lifted from Claude");
    expect(skill?.scope).toBe("global");
  });

  it("reads skills from <project>/.claude/skills/", () => {
    const project = mkdtempSync(join(tmpdir(), "reasonix-skills-proj-"));
    try {
      writeClaudeSkill(project, "project", "proj-skill", { description: "from project" }, "go");
      const store = new SkillStore({
        homeDir: home,
        projectRoot: project,
        disableBuiltins: true,
      });
      const skill = store.read("proj-skill");
      expect(skill?.description).toBe("from project");
      expect(skill?.scope).toBe("project");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("Built-in skills", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skills-builtins-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("ships the test playbook as the only builtin", () => {
    const store = new SkillStore({ homeDir: home }); // builtins ON
    const names = store.list().map((s) => s.name);
    expect(names).toEqual(["test"]);
    const test = store.read("test");
    expect(test?.scope).toBe("builtin");
    expect(test?.body).toMatch(/run_command/);
    expect(test?.body).toMatch(/SEARCH\/REPLACE/);
  });

  it("user-authored skills override a builtin with the same name", () => {
    writeSkillDir(home, "global", "explore", { description: "my own" }, "custom body", home);
    const store = new SkillStore({ homeDir: home });
    const explore = store.read("explore");
    expect(explore?.scope).toBe("global");
    expect(explore?.body).toBe("custom body");
  });

  it("disableBuiltins hides them entirely", () => {
    const store = new SkillStore({ homeDir: home, disableBuiltins: true });
    expect(store.read("explore")).toBeNull();
    expect(store.list()).toEqual([]);
  });
});
