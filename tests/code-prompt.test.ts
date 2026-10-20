/** codeSystemPrompt — gitignore injection + system-append composition. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_SYSTEM_PROMPT, codeSystemPrompt } from "../src/code/prompt.js";

describe("codeSystemPrompt", () => {
  let root: string;
  let cfgPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-prompt-"));
    // The base prompt now depends on `enableSubagents` (knowledge-level gate) —
    // pin it to a tmp config so containment assertions against the frozen
    // CODE_SYSTEM_PROMPT don't go machine-dependent on a dev's real
    // ~/.reasonix/config.json.
    cfgPath = join(root, "config.json");
    process.env.REASONIX_CONFIG = cfgPath;
  });
  afterEach(() => {
    // `defaultConfigPath()` treats unset/undefined the same (env?.trim()), so an
    // undefined assignment is enough to restore real-config resolution.
    process.env.REASONIX_CONFIG = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("does not append a .gitignore section when none exists", () => {
    // We can no longer assert raw equality with CODE_SYSTEM_PROMPT —
    // the bundled builtin skills (`explore`, `research`) always inject
    // a `# Skills` block via applySkillsIndex. Assert the absence of
    // the .gitignore-specific section instead.
    const out = codeSystemPrompt(root);
    expect(out).not.toMatch(/# Project \.gitignore/);
    expect(out).toContain(CODE_SYSTEM_PROMPT);
  });

  it("appends the .gitignore content as a fenced block", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n.env\n", "utf8");
    const out = codeSystemPrompt(root);
    expect(out.length).toBeGreaterThan(CODE_SYSTEM_PROMPT.length);
    expect(out).toMatch(/# Project \.gitignore/);
    expect(out).toContain("node_modules/");
    expect(out).toContain(".env");
  });

  it("truncates a .gitignore larger than 2000 chars", () => {
    // Baseline prompt with a tiny .gitignore — isolates the truncation
    // delta from unrelated, fixed-size additions (e.g. the builtin Skills
    // index), so the bound doesn't go stale as the prompt grows.
    writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const small = codeSystemPrompt(root);
    const huge = `${"# comment ".repeat(500)}\n`; // ~5000 chars
    writeFileSync(join(root, ".gitignore"), huge, "utf8");
    const out = codeSystemPrompt(root);
    expect(out).toMatch(/truncated \d+ chars/);
    // A 5 KB .gitignore must be capped near the 2000-char limit — only a
    // little larger than the tiny-.gitignore baseline, not 5 KB larger.
    expect(out.length).toBeLessThan(small.length + 2500);
  });

  it("reminds the model to skip dependency / build / VCS dirs", () => {
    // We don't enumerate specific names in the prompt anymore (too
    // ecosystem-biased); the principle is stated generically and the
    // pinned .gitignore block is the authoritative denylist.
    expect(CODE_SYSTEM_PROMPT).toMatch(/dependency.*build.*VCS|skip/i);
  });

  it("locks identity to this prompt — workspace files don't redefine the assistant", () => {
    // Issue #550: a Hermes / persona-platform data dir at the workspace
    // root used to make the model claim it was a sub-profile of that
    // host product. Names a few specific markers so the rule is
    // unambiguous on the model side.
    expect(CODE_SYSTEM_PROMPT).toMatch(/Identity is fixed by this prompt/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/SOUL\.md/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/not a sub-profile/);
  });

  it("strictly forbids silent turn endings and requires reasons to be stated", () => {
    expect(CODE_SYSTEM_PROMPT).toMatch(/NEVER end a turn silently without explaining why/i);
    expect(CODE_SYSTEM_PROMPT).toMatch(/Reason must ALWAYS be stated at the end/i);
  });

  it("uses direct, minimal, verifiable execution guidance", () => {
    expect(CODE_SYSTEM_PROMPT).toMatch(/# Execution policy/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/smallest sufficient sequence of tools/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/verify every mutation before claiming success/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/continue from the last verified state/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/Preserve every explicit requirement/);
  });

  it("keeps generated script tests near the script without making workspace-root cwd mandatory", () => {
    expect(CODE_SYSTEM_PROMPT).toMatch(/default.*directory where the script was written/i);
    expect(CODE_SYSTEM_PROMPT).toMatch(/do not assume.*input.*data.*directory.*cwd/i);
    expect(CODE_SYSTEM_PROMPT).toMatch(/pass data paths as arguments/i);
  });

  it("keeps comments minimal, honest, and free of narration", () => {
    expect(CODE_SYSTEM_PROMPT).toMatch(/# Comments: minimal/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/a second copy of intent/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/Why, not what/);
    expect(CODE_SYSTEM_PROMPT).toMatch(/keep block comments to 3 lines or fewer/i);
    expect(CODE_SYSTEM_PROMPT).toMatch(/correct or remove it in the same edit/i);
  });

  describe("audit-mode rails (#610)", () => {
    it("warns against theorizing on auto-preview output instead of reading the dispatch site", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/Auto-preview is for locating, not auditing/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/range:"A-B"/);
    });

    it("covers doc freshness and architectural-state claims, not just runtime behavior", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/runtime behavior, current architectural state/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/whether a plan doc is still accurate/);
    });

    it("requires a flag-to-consumer trace before claiming runtime behavior", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/Flag → consumer trace/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/parallelSafe\?: boolean/);
    });

    it("requires grep over enumeration for inventory claims (which tools have flag F?)", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/For inventory claims/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/grep the flag; don't enumerate from memory/);
    });

    it("forbids fabricated percentages without a measurement", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/No fabricated percentages/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/40-60% tokens/);
    });

    it("requires accounting for schema cost before proposing a new tool", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/Schema cost is real/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/tighten prompt \/ existing tool/);
    });

    it("treats MEMORY.md feedback as part of the design space", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/MEMORY\.md is part of the design space/);
    });

    it("flags promoting user-facing features to model tools as a category error", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/User-facing ≠ model-facing ≠ library-facing/);
    });

    it("calls out library exports as a fourth surface so they aren't mistaken for dead code", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/library exports \(`src\/index\.ts`\)/);
      expect(CODE_SYSTEM_PROMPT).toMatch(/Treating a library export as "dead code"/);
    });
  });

  describe("modelId interpolation (#582)", () => {
    it("defaults to flash when modelId is omitted (back-compat)", () => {
      const out = codeSystemPrompt(root);
      expect(out).toContain("`deepseek-v4-flash`");
      expect(out).toContain("If asked which model you are, answer `deepseek-v4-flash`");
    });

    it("interpolates the supplied modelId without adding self-escalation controls", () => {
      const out = codeSystemPrompt(root, { modelId: "deepseek-v4-pro" });
      expect(out).toContain("`deepseek-v4-pro`");
      expect(out).toContain("Deliver the strongest answer you can directly");
      expect(out).toContain("If asked which model you are, answer `deepseek-v4-pro`");
      expect(out).not.toContain("NEEDS_PRO");
      expect(out).not.toMatch(/running on `?deepseek-v4-flash`?/);
    });
  });

  describe("subagents — a per-session choice, off by default", () => {
    it("says nothing about subagents when the session was minted without them", () => {
      const out = codeSystemPrompt(root, { configPath: cfgPath });
      expect(out).not.toContain("spawn_subagent");
      expect(out).not.toContain("# Subagents");
    });

    it("does not read the config default: a live settings edit cannot shape this prompt", () => {
      writeFileSync(cfgPath, JSON.stringify({ enableSubagents: true }), "utf8");
      const out = codeSystemPrompt(root, { configPath: cfgPath });
      expect(out).not.toContain("spawn_subagent");
    });

    it("renders the usage and task-authoring guidance only for an opted-in session", () => {
      const out = codeSystemPrompt(root, { configPath: cfgPath, subagentsEnabled: true });
      expect(out).toContain("# Subagents");
      expect(out).toContain("spawn_subagent({ task, tools })");
      // Usage rule + how to write the brief, both load-bearing.
      expect(out).toContain("The task is the whole brief");
      expect(out).toContain("**Where to look**");
      expect(out).toContain("**Default: don't delegate.**");
    });

    it("keeps the disabled prompt free of the section's scar", () => {
      const off = codeSystemPrompt(root, { configPath: cfgPath });
      const on = codeSystemPrompt(root, { configPath: cfgPath, subagentsEnabled: true });
      expect(on.length).toBeGreaterThan(off.length);
      // The neighbours keep their single blank line; nothing is left collapsed or doubled.
      expect(off).toMatch(/approval\.\n\n# When to edit vs\. when to explore/);
      expect(off).not.toContain("__SUBAGENT_SECTION__");
    });

    it("lists a skill as a plain playbook identifier, subagent or not", () => {
      writeFileSync(cfgPath, JSON.stringify({ enableSubagents: false }), "utf8");
      const skillDir = join(root, ".reasonix", "skills", "my-audit");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: my-audit\ndescription: Run a custom audit\n---\n\nAudit body.\n",
        "utf8",
      );
      const out = codeSystemPrompt(root, { configPath: cfgPath });
      // A skill is instructions, not a spawner: the index stays the same either way,
      // and the old `[subagent]` tag decoration is gone.
      expect(out).toContain("- my-audit: Run a custom audit");
      expect(out).not.toContain("[subagent]");
    });
  });

  describe("system append", () => {
    it("does not add a User System Append section when neither option is provided", () => {
      const out = codeSystemPrompt(root);
      expect(out).not.toMatch(/# User System Append/);
    });

    it("preserves the base system prompt when appending", () => {
      const out = codeSystemPrompt(root, { systemAppend: "Extra rule." });
      expect(out).toContain(CODE_SYSTEM_PROMPT);
    });

    it("appends an inline systemAppend string under a # User System Append heading", () => {
      const out = codeSystemPrompt(root, {
        systemAppend: "Always inspect relevant files before editing.",
      });
      expect(out).toMatch(/# User System Append/);
      expect(out).toContain("Always inspect relevant files before editing.");
    });

    it("appends systemAppendFile contents under the # User System Append heading", () => {
      const out = codeSystemPrompt(root, { systemAppendFile: "Run tests before committing." });
      expect(out).toMatch(/# User System Append/);
      expect(out).toContain("Run tests before committing.");
    });

    it("appends inline prompt first, then file contents, when both are provided", () => {
      const out = codeSystemPrompt(root, {
        systemAppend: "First instruction.",
        systemAppendFile: "Second instruction.",
      });
      expect(out).toMatch(/# User System Append/);
      const appendIdx = out.indexOf("# User System Append");
      const firstIdx = out.indexOf("First instruction.", appendIdx);
      const secondIdx = out.indexOf("Second instruction.", appendIdx);
      expect(firstIdx).toBeGreaterThan(0);
      expect(secondIdx).toBeGreaterThan(firstIdx);
    });

    it("places the append section after the .gitignore section", () => {
      writeFileSync(join(root, ".gitignore"), "node_modules\n");
      const out = codeSystemPrompt(root, { systemAppend: "Post-gitignore instruction." });
      const gitignoreAt = out.indexOf("# Project .gitignore");
      const appendAt = out.indexOf("# User System Append");
      expect(gitignoreAt).toBeGreaterThan(0);
      expect(appendAt).toBeGreaterThan(gitignoreAt);
    });
  });

  describe("Permissions (live) block", () => {
    it("names the persisted edit-gate mode", () => {
      writeFileSync(cfgPath, JSON.stringify({ editMode: "never-ask" }), "utf8");
      const out = codeSystemPrompt(root);
      expect(out).toContain("# Permissions (live)");
      expect(out).toContain("Edit gate mode: **Never Ask** (`never-ask`)");
    });

    it("renders each of the three modes distinctly", () => {
      for (const [mode, label] of [
        ["read-only", "Read only"],
        ["follow", "Follow Rules"],
        ["never-ask", "Never Ask"],
      ] as const) {
        const out = codeSystemPrompt(root, { editMode: mode });
        expect(out).toContain(`Edit gate mode: **${label}** (\`${mode}\`)`);
      }
    });

    it("editMode option wins over the persisted config", () => {
      writeFileSync(cfgPath, JSON.stringify({ editMode: "never-ask" }), "utf8");
      const out = codeSystemPrompt(root, { editMode: "read-only" });
      expect(out).toContain("Edit gate mode: **Read only** (`read-only`)");
    });

    it("sits last, after the User System Append block", () => {
      writeFileSync(join(root, ".gitignore"), "node_modules\n");
      const out = codeSystemPrompt(root, { systemAppend: "Post-append instruction." });
      const appendAt = out.indexOf("# User System Append");
      const permsAt = out.indexOf("# Permissions (live)");
      expect(appendAt).toBeGreaterThan(0);
      expect(permsAt).toBeGreaterThan(appendAt);
      expect(out.indexOf("# Permissions (live)", permsAt + 1)).toBe(-1);
    });

    it("keeps the frozen CODE_SYSTEM_PROMPT a substring for every mode", () => {
      for (const mode of ["read-only", "follow", "never-ask"] as const) {
        expect(codeSystemPrompt(root, { editMode: mode })).toContain(CODE_SYSTEM_PROMPT);
      }
    });

    it("states the block is authoritative and tracks mid-session flips", () => {
      const out = codeSystemPrompt(root, { editMode: "follow" });
      expect(out).toMatch(/authoritative permission state/);
      expect(out).toMatch(/this block changes with it/i);
    });
  });

  describe("the static edit-gate section", () => {
    it("describes all three modes and defers to the live block", () => {
      expect(CODE_SYSTEM_PROMPT).toMatch(/# The edit gate/);
      expect(CODE_SYSTEM_PROMPT).toContain("**Read only**");
      expect(CODE_SYSTEM_PROMPT).toContain("**Follow Rules**");
      expect(CODE_SYSTEM_PROMPT).toContain("**Never Ask**");
      expect(CODE_SYSTEM_PROMPT).toMatch(/Permissions \(live\)/);
    });

    it("no longer hard-codes a single mode as the session's state", () => {
      // The bug: the template always headed the section "# Read only mode",
      // so the agent believed it was in Read only while the UI showed another mode.
      expect(CODE_SYSTEM_PROMPT).not.toMatch(/# Read only mode/);
      expect(CODE_SYSTEM_PROMPT).not.toMatch(/you don't see which is active/);
    });
  });

  describe("MCP bridges awareness", () => {
    it("does not include configured MCP state in the system prompt", () => {
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            blender: {
              command: "uvx.exe",
              args: ["--python", "3.11", "blender-mcp"],
              disabled: true,
            },
          },
        }),
        "utf8",
      );
      const out = codeSystemPrompt(root);
      expect(out).toContain("list_mcp_bridges");
      expect(out).toContain("treat its result as authoritative");
      expect(out).not.toContain("# Configured MCP bridges");
      expect(out).not.toContain("(stdio [disabled])");

      rmSync(join(root, ".mcp.json"));
      expect(out).toBe(codeSystemPrompt(root));
    });
  });
});
