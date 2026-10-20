/** run_skill — temp homeDir / projectRoot so the tool never reads real skill dirs. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore } from "../src/skills.js";
import { ToolRegistry } from "../src/tools.js";
import { registerSkillTools, syncDedicatedSubagentTools } from "../src/tools/skills.js";

function writeSkill(baseDir: string, name: string, description: string, body: string): void {
  const dir = join(baseDir, ".reasonix", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

function writeSkillWithFrontmatter(
  baseDir: string,
  name: string,
  fm: Record<string, string>,
  body: string,
): void {
  const dir = join(baseDir, ".reasonix", "skills", name);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", `name: ${name}`];
  for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
  lines.push("---", "");
  writeFileSync(join(dir, "SKILL.md"), `${lines.join("\n")}${body}\n`, "utf8");
}

describe("run_skill tool", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-skilltool-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-skilltool-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("registers run_skill as a read-only tool", () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const tool = reg.get("run_skill");
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
  });

  it("returns the skill body when the name resolves (global scope)", async () => {
    writeSkill(home, "review", "Review a PR", "Step 1: diff. Step 2: comment.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "review" });
    expect(out).toContain("# Skill: review");
    expect(out).toContain("Review a PR");
    expect(out).toContain("scope: global");
    expect(out).toContain("Step 1: diff");
  });

  it("resolves project-scope skills when projectRoot is passed", async () => {
    writeSkill(projectRoot, "deploy", "Deploy to staging", "Run pipeline.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "deploy" });
    expect(out).toContain("scope: project");
    expect(out).toContain("Run pipeline");
  });

  it("returns a custom path skill when customSkillPaths is passed", async () => {
    const custom = mkdtempSync(join(tmpdir(), "reasonix-skilltool-custom-"));
    try {
      const dir = join(custom, "custom-run");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: custom-run\ndescription: Custom run\n---\n\nCustom body\n",
        "utf8",
      );
      const reg = new ToolRegistry();
      registerSkillTools(reg, { homeDir: home, customSkillPaths: [custom], disableBuiltins: true });
      const out = await reg.dispatch("run_skill", { name: "custom-run" });
      expect(out).toContain("scope: custom");
      expect(out).toContain("Custom body");
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("unknown skill available list includes custom skills", async () => {
    const custom = mkdtempSync(join(tmpdir(), "reasonix-skilltool-custom-"));
    try {
      const dir = join(custom, "custom-known");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        "---\nname: custom-known\ndescription: Custom known\n---\n\nbody\n",
        "utf8",
      );
      const reg = new ToolRegistry();
      registerSkillTools(reg, { homeDir: home, customSkillPaths: [custom], disableBuiltins: true });
      const out = await reg.dispatch("run_skill", { name: "missing" });
      expect(JSON.parse(out).available).toContain("custom-known");
    } finally {
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("appends a forwarded 'Arguments:' line when provided", async () => {
    writeSkill(home, "greet", "Greet someone", "Say hello to the name in args.");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "greet", arguments: "Alice" });
    expect(out).toContain("Arguments: Alice");
  });

  it("returns a structured error with available names on unknown skill", async () => {
    writeSkill(home, "review", "Review a PR", "...");
    writeSkill(home, "ship-it", "Push commit", "...");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "nope" });
    const parsed = JSON.parse(out);
    expect(parsed.error).toMatch(/unknown skill/);
    expect(parsed.available).toContain("review");
    expect(parsed.available).toContain("ship-it");
  });

  it("rejects an empty name", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("run_skill", { name: "" });
    expect(JSON.parse(out).error).toMatch(/requires a 'name'/);
  });

  it("normalizes decorated names (bracket tags) to the bare identifier", async () => {
    // Reproduces the bug where the model copied the `[subagent]` tag
    // from the Skills index into the `name` argument verbatim. The
    // tool strips leading non-word chars + anything past the first
    // whitespace token, so these all resolve to the same skill.
    writeSkill(home, "explore", "Look around", "body");
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });

    const cases = ["[subagent] explore", "  explore  ", "explore [subagent]"];
    for (const name of cases) {
      const out = await reg.dispatch("run_skill", { name });
      // Inline skills return the body (non-JSON markdown) on success;
      // an unknown-skill error returns JSON. Presence of the unknown-
      // skill text in the output is a guaranteed failure marker.
      expect(out, `case ${JSON.stringify(name)}`).not.toMatch(/unknown skill/i);
      expect(out, `case ${JSON.stringify(name)}`).toContain("Skill: explore");
    }
  });
});

describe("install_skill tool", () => {
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-installskill-"));
    projectRoot = mkdtempSync(join(tmpdir(), "reasonix-installskill-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("registers install_skill alongside run_skill", () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    expect(reg.get("install_skill")).toBeDefined();
    expect(reg.get("run_skill")).toBeDefined();
  });

  it("writes a project-scope skill file with valid frontmatter and returns its path", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "summarize-prs",
      description: "Summarize merged PRs from the last week",
      body: "Run gh pr list and group by author.",
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.scope).toBe("project");
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toContain(projectRoot);
    expect(existsSync(parsed.path)).toBe(true);
    const raw = readFileSync(parsed.path, "utf8");
    expect(raw).toContain("name: summarize-prs");
    expect(raw).toContain("description: Summarize merged PRs from the last week");
    expect(raw).toContain("Run gh pr list");
  });

  it("the newly-installed skill is immediately runnable via run_skill in the same registry", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    await reg.dispatch("install_skill", {
      name: "lint-fix",
      description: "Run linter and apply autofixes",
      body: "Step 1: npm run lint --fix.",
    });
    const out = await reg.dispatch("run_skill", { name: "lint-fix" });
    expect(out).toContain("# Skill: lint-fix");
    expect(out).toContain("Step 1: npm run lint --fix");
  });

  it("defaults scope to global when no projectRoot is set", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "everywhere",
      description: "Available in every project",
      body: "do a thing",
    });
    const parsed = JSON.parse(out);
    expect(parsed.scope).toBe("global");
    expect(parsed.path).toContain(home);
  });

  it("rejects scope=project when no workspace is configured", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "x",
      description: "y",
      body: "z",
      scope: "project",
    });
    expect(JSON.parse(out).error).toMatch(/requires a workspace/);
  });

  it("rejects an empty name / description / body", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    expect(
      JSON.parse(await reg.dispatch("install_skill", { name: "", description: "d", body: "b" }))
        .error,
    ).toMatch(/'name'/);
    expect(
      JSON.parse(await reg.dispatch("install_skill", { name: "ok", description: "", body: "b" }))
        .error,
    ).toMatch(/'description'/);
    expect(
      JSON.parse(await reg.dispatch("install_skill", { name: "ok", description: "d", body: "" }))
        .error,
    ).toMatch(/'body'/);
  });

  it("rejects invalid skill names", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "../etc/passwd",
      description: "d",
      body: "b",
    });
    expect(JSON.parse(out).error).toMatch(/invalid skill name/);
  });

  it("refuses to overwrite an existing skill", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    await reg.dispatch("install_skill", {
      name: "dup",
      description: "first",
      body: "first body",
    });
    const out = await reg.dispatch("install_skill", {
      name: "dup",
      description: "second",
      body: "second body",
    });
    expect(JSON.parse(out).error).toMatch(/already exists/);
  });

  it("fires onSkillInstalled with the name + scope + path", async () => {
    const reg = new ToolRegistry();
    const calls: Array<{ name: string; scope: string; path: string }> = [];
    registerSkillTools(reg, {
      homeDir: home,
      projectRoot,
      disableBuiltins: true,
      onSkillInstalled: (info) => calls.push(info),
    });
    await reg.dispatch("install_skill", {
      name: "watched",
      description: "trigger the hook",
      body: "noop",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("watched");
    expect(calls[0]?.scope).toBe("project");
    expect(calls[0]?.path).toContain(projectRoot);
  });

  it("never writes subagent-only frontmatter: a skill is just a playbook", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "plain",
      description: "inline skill",
      body: "do the thing",
    });
    const raw = readFileSync(JSON.parse(out).path, "utf8");
    expect(raw).not.toContain("runAs:");
    expect(raw).not.toContain("model:");
    expect(raw).not.toContain("allowed-tools:");
  });

  it("normalizes newlines in description to spaces (frontmatter is single-line per key)", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home, projectRoot, disableBuiltins: true });
    const out = await reg.dispatch("install_skill", {
      name: "multiline-desc",
      description: "first line\nsecond line\nthird",
      body: "x",
    });
    const raw = readFileSync(JSON.parse(out).path, "utf8");
    expect(raw).toContain("description: first line second line third");
    expect(raw).not.toMatch(/description: first line\n/);
  });
});

describe("only one tool spawns a child", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-builtin-subagent-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("registers no per-skill wrapper tools", () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home });
    for (const name of ["explore", "research", "review", "security_review"]) {
      expect(reg.has(name)).toBe(false);
    }
    // The playbook invoker is still there; spawning is spawn_subagent's job.
    expect(reg.has("run_skill")).toBe(true);
  });

  it("returns a playbook body inline instead of spawning", async () => {
    const reg = new ToolRegistry();
    registerSkillTools(reg, { homeDir: home });
    const out = await reg.dispatch("run_skill", { name: "test", arguments: "focus on lib/" });
    expect(out).toContain("# Skill: test");
    expect(out).toContain("Arguments: focus on lib/");
  });
});
