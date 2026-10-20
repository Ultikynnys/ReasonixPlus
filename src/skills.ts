/** Project scope wins over global. Only names+descriptions enter the prefix; bodies load lazily into the append-only log. */

import {
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { accessSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { clipIndexDescription } from "@reasonix/core-utils";
import { parseFrontmatter } from "./frontmatter.js";
import { t } from "./i18n/index.js";
import { truncateWithMarker } from "./memory/read-capped.js";
import { NEGATIVE_CLAIM_RULE, TUI_FORMATTING_RULES } from "./prompt-fragments.js";

export const SKILLS_DIRNAME = "skills";
export const SKILL_FILE = "SKILL.md";
/** Cap on the pinned skills-index block, mirrors memory-index cap. */
export const SKILLS_INDEX_MAX_CHARS = 4000;
/** Skill identifier shape — alnum + `_` + `-` + interior `.`, 1-64 chars. */
const VALID_SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type SkillScope = "project" | "custom" | "global" | "builtin";

export type SkillPathStatus = "ok" | "missing" | "not-directory" | "unreadable";

export interface Skill {
  /** Canonical name — sanitized, matches the directory / filename stem. */
  name: string;
  /** One-line description shown in the pinned index. */
  description: string;
  /** Full markdown body (post-frontmatter). Loaded on demand. */
  body: string;
  /** Which scope this skill was loaded from. */
  scope: SkillScope;
  /** Absolute path to the SKILL.md (or {name}.md) file, or "(builtin)" for shipped defaults. */
  path: string;
}

export interface SkillRoot {
  dir: string;
  scope: Exclude<SkillScope, "builtin">;
  status: SkillPathStatus;
  priority: number;
}

export interface SkillStoreOptions {
  /** Override `$HOME` — tests point this at a tmpdir. */
  homeDir?: string;
  /** Required for project-scope skills; omit to read only the global scope. */
  projectRoot?: string;
  customSkillPaths?: readonly string[];
  /** Suppress bundled built-ins — for tests asserting exact list contents. */
  disableBuiltins?: boolean;
}

/** Reject skill files that would silently disappear from the prefix index — `description:` is what `applySkillsIndex` keys on. */
export function validateSkillFrontmatter(raw: string): { ok: true } | { error: string } {
  const { data } = parseFrontmatter(raw);
  const desc = (data.description ?? "").trim();
  if (!desc) {
    return {
      error:
        'skill frontmatter is missing a non-empty "description:" line, without which the skill will not appear in the model\'s skills index',
    };
  }
  return { ok: true };
}

export function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME.test(name);
}

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface RawSkillDraft {
  name?: unknown;
  description?: unknown;
  body?: unknown;
}

/** Validate and normalize the persisted contract shared by all skill-authoring tools. */
export function parseSkillDraft(raw: RawSkillDraft): SkillDraft | { error: string } {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return { error: "skill requires a non-empty 'name'" };
  if (!isValidSkillName(name)) {
    return { error: `invalid skill name: ${JSON.stringify(name)} (use letters, digits, _, -, .)` };
  }
  const description =
    typeof raw.description === "string" ? raw.description.replace(/[\r\n]+/g, " ").trim() : "";
  if (!description) return { error: "skill requires a non-empty 'description'" };
  const body = typeof raw.body === "string" ? raw.body : "";
  if (!body.trim()) return { error: "skill requires a non-empty 'body'" };
  return { name, description, body };
}

/** Serialize canonical skill frontmatter and normalized body text. */
export function serializeSkill(draft: SkillDraft): string {
  const lines = ["---", `name: ${draft.name}`, `description: ${draft.description}`];
  lines.push("---", "");
  return `${lines.join("\n")}\n${draft.body.trim()}\n`;
}

/** Args shared by every skill-authoring tool handler (before per-tool arg-name mapping). */
export interface SkillToolArgs {
  name?: unknown;
  description?: unknown;
  body?: unknown;
  scope?: unknown;
}

/** Persist a validated draft: serialize to SKILL.md, then write it, returning the
 *  created path or a human-readable error. Shared by install_skill / create_skill. */
export function persistSkillDraft(
  store: SkillStore,
  draft: SkillDraft,
  scope: "project" | "global",
): { path: string } | { error: string } {
  return store.createWithContent(draft.name, scope, serializeSkill(draft));
}

export class SkillStore {
  private readonly homeDir: string;
  private readonly projectRoot: string | undefined;
  private readonly customSkillPaths: readonly string[];
  private readonly disableBuiltins: boolean;

  constructor(opts: SkillStoreOptions = {}) {
    this.homeDir = opts.homeDir ?? homedir();
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : undefined;
    const baseDir = this.projectRoot ?? process.cwd();
    this.customSkillPaths = dedupePaths(
      opts.customSkillPaths?.map((p) => resolveCustomSkillPath(p, baseDir, this.homeDir)) ?? [],
    );
    this.disableBuiltins = opts.disableBuiltins === true;
  }

  /** True iff this store was configured with a project root. */
  hasProjectScope(): boolean {
    return this.projectRoot !== undefined;
  }

  /** Project scope first so per-repo skill overrides custom/global entries with the same name. */
  roots(): SkillRoot[] {
    const out: Array<{ dir: string; scope: Exclude<SkillScope, "builtin"> }> = [];
    if (this.projectRoot) {
      out.push({
        dir: join(this.projectRoot, ".reasonix", SKILLS_DIRNAME),
        scope: "project",
      });
      // #870: pick up `.agents/skills` automatically — common convention shared
      // by skills.sh-style tooling, no config required.
      out.push({
        dir: join(this.projectRoot, ".agents", SKILLS_DIRNAME),
        scope: "project",
      });
      // Claude Code compatibility — a user's `.claude/skills/` folder works as-is.
      out.push({
        dir: join(this.projectRoot, ".claude", SKILLS_DIRNAME),
        scope: "project",
      });
    }
    for (const dir of this.customSkillPaths) out.push({ dir, scope: "custom" });
    out.push({ dir: join(this.homeDir, ".reasonix", SKILLS_DIRNAME), scope: "global" });
    out.push({ dir: join(this.homeDir, ".agents", SKILLS_DIRNAME), scope: "global" });
    out.push({ dir: join(this.homeDir, ".claude", SKILLS_DIRNAME), scope: "global" });
    return out.map((root, priority) => ({ ...root, priority, status: skillPathStatus(root.dir) }));
  }

  customRoots(): SkillRoot[] {
    return this.roots().filter((root) => root.scope === "custom");
  }

  /** Higher-priority root wins on collision (project > custom > global > builtin); sorted for stable prefix hash. */
  list(): Skill[] {
    const byName = new Map<string, Skill>();
    for (const { dir, scope, status } of this.roots()) {
      if (status !== "ok") continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const skill = this.readEntry(dir, scope, entry);
        if (!skill) continue;
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    // Builtins last so user/project files override on name collision.
    if (!this.disableBuiltins) {
      for (const skill of BUILTIN_SKILLS) {
        if (!byName.has(skill.name)) byName.set(skill.name, skill);
      }
    }
    return [...byName.values()].map((s) => s).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Scaffold a new skill stub at the chosen scope. Refuses to overwrite. */
  create(name: string, scope: "project" | "global"): { path: string } | { error: string } {
    return this.createWithContent(name, scope, skillStubBody(name));
  }

  /** Like `create` but writes caller-supplied file contents instead of the stub — used by the scaffold tool. */
  createWithContent(
    name: string,
    scope: "project" | "global",
    content: string,
  ): { path: string } | { error: string } {
    if (!isValidSkillName(name)) {
      return { error: `invalid skill name: "${name}" (use letters, digits, _, -, .)` };
    }
    if (scope === "project" && !this.projectRoot) {
      return { error: "project scope requires a workspace: open a project to use project scope" };
    }
    const root =
      scope === "project"
        ? join(this.projectRoot ?? "", ".reasonix", SKILLS_DIRNAME)
        : join(this.homeDir, ".reasonix", SKILLS_DIRNAME);
    const flat = join(root, `${name}.md`);
    const folder = join(root, name, SKILL_FILE);
    if (existsSync(folder)) {
      return { error: `skill "${name}" already exists at ${folder}` };
    }
    mkdirSync(dirname(flat), { recursive: true });
    try {
      writeFileSync(flat, content, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return { error: `skill "${name}" already exists at ${flat}` };
      }
      throw err;
    }
    return { path: flat };
  }

  /** Resolve one skill by name. Returns `null` if not found or malformed. */
  read(name: string): Skill | null {
    if (!isValidSkillName(name)) return null;
    for (const { dir, scope, status } of this.roots()) {
      if (status !== "ok") continue;
      const dirCandidate = join(dir, name, SKILL_FILE);
      if (existsSync(dirCandidate) && statSync(dirCandidate).isFile()) {
        return this.parse(dirCandidate, name, scope);
      }
      const flatCandidate = join(dir, `${name}.md`);
      if (existsSync(flatCandidate) && statSync(flatCandidate).isFile()) {
        return this.parse(flatCandidate, name, scope);
      }
    }
    if (!this.disableBuiltins) {
      for (const skill of BUILTIN_SKILLS) {
        if (skill.name === name) return skill;
      }
    }
    return null;
  }

  private readEntry(dir: string, scope: SkillScope, entry: import("node:fs").Dirent): Skill | null {
    if (entry.isDirectory()) {
      if (!isValidSkillName(entry.name)) return null;
      const file = join(dir, entry.name, SKILL_FILE);
      if (!existsSync(file)) return null;
      return this.parse(file, entry.name, scope);
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const stem = entry.name.slice(0, -3);
      if (!isValidSkillName(stem)) return null;
      return this.parse(join(dir, entry.name), stem, scope);
    }
    return null;
  }

  private parse(path: string, stem: string, scope: SkillScope): Skill | null {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    const { data, body } = parseFrontmatter(raw);
    const name = data.name && isValidSkillName(data.name) ? data.name : stem;
    const description = (data.description ?? "").trim();
    // Surface the silent-pin failure mode at parse time. Builtins always have
    // a description so user-authored files are the only ones that hit this.
    if (!description) {
      console.warn(
        `[skills] "${name}" at ${path} has no description, so it will be loaded but won't appear in the skills index.`,
      );
    }
    return {
      name,
      description,
      body: loadBodyWithReferences(path, body.trim()),
      scope,
      path,
    };
  }
}

function loadBodyWithReferences(skillFilePath: string, body: string): string {
  if (!skillFilePath.endsWith(SKILL_FILE)) return body;
  const refsDir = join(dirname(skillFilePath), "references");
  if (!existsSync(refsDir)) return body;
  let entries: string[];
  try {
    entries = readdirSync(refsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return body;
  }
  if (entries.length === 0) return body;
  const parts: string[] = [body];
  for (const entry of entries) {
    const slug = entry.slice(0, -3); // strip .md
    let content: string;
    try {
      content = readFileSync(join(refsDir, entry), "utf8").trim();
    } catch {
      continue;
    }
    if (content) parts.push(`\n\n## Reference: ${slug}\n\n${content}`);
  }
  return parts.join("");
}

function dedupePaths(paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function resolveCustomSkillPath(path: string, baseDir: string, homeDir: string): string {
  const trimmed = path.trim();
  const expanded =
    trimmed === "~"
      ? homeDir
      : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? join(homeDir, trimmed.slice(2))
        : trimmed;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDir, expanded));
}

export function skillPathStatus(dir: string): SkillPathStatus {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return "not-directory";
    accessSync(dir, constants.R_OK);
    return "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "missing";
    return "unreadable";
  }
}

/** Stub markdown for a new skill — minimal frontmatter + scaffolding the user fills in. */
function skillStubBody(name: string): string {
  return `---
name: ${name}
description: One-liner describing what this skill does.
---

# ${name}

Replace this body with the playbook the model should follow when this skill is invoked.

Tips:
- Reference tools by name (run_command, edit_file, search_content, ...)
`;
}

function skillDescription(s: Pick<Skill, "name" | "description" | "scope">): string {
  if (s.scope !== "builtin") return s.description;
  const key = s.name === "security-review" ? "securityReview" : s.name;
  return t(`builtinSkills.${key}`);
}

/** Tag goes after the name so a model copying the line still passes a bare identifier. */
function skillIndexLine(s: Pick<Skill, "name" | "description" | "scope">): string {
  const clipped = clipIndexDescription(skillDescription(s), s.name);
  return clipped ? `- ${s.name}: ${clipped}` : `- ${s.name}`;
}

const MISSING_DESCRIPTION_PLACEHOLDER =
  '(no description: frontmatter is missing a "description:" line; tell the user to add one)';

const SKILL_INDEX_RULE =
  'One-liner index. Each entry is either a built-in or a user-authored playbook. Call `run_skill({ name: "<skill-name>", arguments: "<task>" })`: the `name` is JUST the skill identifier, exactly as listed. The body is a playbook: it becomes a tool result you read and follow in this loop.';

/** Only appended for a session that actually owns the spawn tool. */
const SPAWN_HINT =
  "To run work in isolation, call `spawn_subagent({ task, tools })` with the whole instruction in `task`.";

/** Bodies stay out — prefix must stay short + cacheable; bodies load on demand.
 *  `subagents` decides whether the index may advertise `spawn_subagent`: a session
 *  minted without that tool must not be told it exists. */
export function applySkillsIndex(
  basePrompt: string,
  opts: SkillStoreOptions = {},
  subagents = false,
): string {
  const store = new SkillStore(opts);
  const skills = store.list();
  if (skills.length === 0) return basePrompt;
  const lines = skills.map((s) =>
    skillIndexLine(s.description ? s : { ...s, description: MISSING_DESCRIPTION_PLACEHOLDER }),
  );
  const joined = lines.join("\n");
  const truncated = truncateWithMarker(joined, SKILLS_INDEX_MAX_CHARS).content;
  return [
    basePrompt,
    "",
    "# Skills: playbooks you can invoke",
    "",
    `${SKILL_INDEX_RULE}${subagents ? ` ${SPAWN_HINT}` : ""} The user can also invoke a skill by name.`,
    "",
    "```",
    truncated,
    "```",
  ].join("\n");
}

const BUILTIN_TEST_BODY = `You are running as the parent agent: this skill is INLINED, not a subagent. The user asked you to run the tests and fix failures. Your job: run the project's test suite, diagnose any failure, propose fixes as SEARCH/REPLACE edit blocks, then re-run. Repeat until green or you hit a wall you should escalate.

How to operate:

1. **Detect the test command**.
   - Look for \`package.json\` → \`scripts.test\` first (most common: \`npm test\`, \`pnpm test\`, \`yarn test\`).
   - If no package.json or no test script: try \`pytest\`, \`go test ./...\`, \`cargo test\` based on what files exist (pyproject.toml/requirements.txt → pytest; go.mod → go test; Cargo.toml → cargo test).
   - If you can't tell, ASK the user for the command rather than guessing. One question, one tool call to confirm.

2. **Run it via run_command** (typical timeout 120s, bigger if the suite is large). Capture stdout + stderr.

3. **Read the failures**. Pull out: which test names failed, the actual error/traceback, the file + line that threw. Don't just paraphrase: locate the exact assertion or stack frame.

4. **Propose fixes**. For each distinct failure:
   - If the failure is in PRODUCTION code (test catches a real bug) → propose a SEARCH/REPLACE that fixes the production code.
   - If the failure is in TEST code (test is wrong, codebase is right) → propose a SEARCH/REPLACE that updates the test, AND say so explicitly: "This is a test bug, not a production bug, so I'm updating the assertion."
   - If the failure is environmental (missing dep, wrong node version, missing fixture file) → say so and stop. Don't try to install packages or change config without checking with the user.

5. **Apply + re-run**. After the user accepts the edit blocks, run the test command again. Iterate.

6. **Stop conditions**:
   - All tests pass → report green, summarize what changed.
   - Same test still failing after 2 fix attempts on the same line → STOP. Tell the user "I've tried twice, it's still failing: here's what I think is happening, want me to try a different angle?". Don't loop indefinitely.
   - 3+ unrelated failures → fix one at a time, smallest first, so each pass narrows the surface.

Don't:
- Run \`npm install\` / \`pip install\` / \`cargo update\` without asking: those mutate lockfiles and have global effects.
- Disable, skip, or delete failing tests to "make it green". If a test seems wrong, update its assertion with a one-sentence explanation, but never add \`.skip\` / \`it.skip\` / \`@pytest.mark.skip\`.
- Modify the test runner config (vitest.config, jest.config, etc.) to silence failures.

Lead each turn with a one-line status: "▸ running \`npm test\` ..." → "▸ 2 failures in tests/foo.test.ts: first is …" → so the user always knows where you are without scrolling tool output.`;

/** Fields every built-in skill shares: builtin scope, no file path. */
const BUILTIN_SKILL_BASE: Pick<Skill, "scope" | "path"> = {
  scope: "builtin",
  path: "(builtin)",
};

const BUILTIN_SKILLS: readonly Skill[] = Object.freeze([
  Object.freeze<Skill>({
    name: "test",
    description:
      "Run the project's test suite, diagnose failures, propose SEARCH/REPLACE fixes, re-run until green (or stop after 2 fix attempts on the same failure). Inlined: runs in the parent loop so you see the edit blocks and can apply them directly. Detects npm/pnpm/yarn/pytest/go/cargo.",
    body: BUILTIN_TEST_BODY,
    ...BUILTIN_SKILL_BASE,
  }),
]);
