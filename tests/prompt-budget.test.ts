/** Locks cache-prefix byte budget — every byte ships in every request. PRs that
 *  grow it must compress elsewhere or raise the constant with a commit-message reason. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_SYSTEM_PROMPT,
  SYSTEM_APPEND_MAX_CHARS,
  codeSystemPrompt,
} from "../src/code/prompt.js";
import { PROJECT_MEMORY_MAX_CHARS } from "../src/memory/project.js";
import { projectHash } from "../src/memory/user.js";
import type { ToolRegistry } from "../src/tools.js";
import { MAX_TOOL_SPEC_BYTES, specBytes, toolSpecBytes } from "../src/tools/spec-budget.js";
import { registerAllBuiltins } from "./support/full-toolset.js";

/** Base system prompt — no memory, no .gitignore, no skills index. */
const SYSTEM_PROMPT_BUDGET = 24_500;
/** Base + the live permissions tail `codeSystemPrompt` appends last. */
const SYSTEM_PROMPT_BUDGET_COMPOSED = 26_500;
/** Every layer at its cap measures 72,148 bytes, so this fails on roughly 2% growth. The per-layer
 *  caps are the real bound; this guards their combination. */
const COMPOSED_PROMPT_BUDGET_FULL = 73_500;
/** Full code-mode tool spec list — the same ceiling the runtime bridge enforces. */
const TOOL_LIST_BUDGET = MAX_TOOL_SPEC_BYTES;
/** Every built-in tools module registers in the shared helper. A new tool must land there. */
const EXPECTED_MIN_TOOLS = 51;

/** Per-tool bytes via the shared accounting, so this net cannot drift from the runtime ceiling. */
function toolBytes(tools: ToolRegistry): {
  total: number;
  perTool: Array<{ name: string; total: number; descBytes: number }>;
} {
  const perTool = tools.specs().map((spec) => ({
    name: spec.function.name,
    total: specBytes(spec),
    descBytes: spec.function.description.length,
  }));
  return { total: perTool.reduce((sum, t) => sum + t.total, 0), perTool };
}

function withToolset(fn: (tools: ToolRegistry) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "reasonix-budget-"));
  const { tools, jobs } = registerAllBuiltins(root);
  return Promise.resolve(fn(tools)).finally(async () => {
    rmSync(root, { recursive: true, force: true });
    await jobs.shutdown();
  });
}

describe("prompt budget — cache prefix size regression net", () => {
  it("system prompt stays under the byte budget", () => {
    const actual = CODE_SYSTEM_PROMPT.length;
    if (actual > SYSTEM_PROMPT_BUDGET) {
      throw new Error(
        `CODE_SYSTEM_PROMPT is ${actual} bytes — exceeds budget ${SYSTEM_PROMPT_BUDGET}. Either compress an equivalent section in src/code/prompt.ts OR raise SYSTEM_PROMPT_BUDGET in tests/prompt-budget.test.ts with a justification in the commit message.`,
      );
    }
    expect(actual).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET);
  });

  it("code-mode tool list stays under the byte budget", async () => {
    await withToolset((tools) => {
      const specs = tools.specs();
      const { total, perTool } = toolBytes(tools);
      expect(specs.length).toBeGreaterThanOrEqual(EXPECTED_MIN_TOOLS);
      // Both accounting paths must agree: this net and the runtime ceiling measure the same bytes.
      expect(total).toBe(toolSpecBytes(specs));
      if (total > TOOL_LIST_BUDGET) {
        const top = perTool
          .sort((a, b) => b.total - a.total)
          .slice(0, 5)
          .map((t) => `  ${t.name}: ${t.total} bytes`)
          .join("\n");
        throw new Error(
          `Tool spec list is ${total} bytes — exceeds budget ${TOOL_LIST_BUDGET}.\nTop 5 by size:\n${top}\nEither compress a description in src/tools/*.ts OR raise TOOL_LIST_BUDGET in tests/prompt-budget.test.ts with a justification.`,
        );
      }
      expect(total).toBeLessThanOrEqual(TOOL_LIST_BUDGET);
    });
  });

  it("no single tool description exceeds 8 KiB on its own", async () => {
    await withToolset((tools) => {
      const { perTool } = toolBytes(tools);
      const oversized = perTool.filter((t) => t.descBytes > 8 * 1024);
      if (oversized.length > 0) {
        const lines = oversized.map((t) => `  ${t.name}: ${t.descBytes} bytes`).join("\n");
        throw new Error(
          `Tools with descriptions over 8 KiB (every byte ships in every request):\n${lines}\nLong descriptions belong in tool error messages (shown on overrun) or the system prompt (where one copy serves the whole tool list), not in the tool spec.`,
        );
      }
      expect(oversized).toEqual([]);
    });
  });

  it("codeSystemPrompt with no memory stays under the budget too (defense in depth)", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-budget-"));
    try {
      const built = codeSystemPrompt(root);
      expect(built.length).toBeLessThanOrEqual(SYSTEM_PROMPT_BUDGET_COMPOSED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("composed prompt with every layer at its cap stays under the absolute ceiling", () => {
    const root = mkdtempSync(join(tmpdir(), "reasonix-composed-"));
    const home = mkdtempSync(join(tmpdir(), "reasonix-home-"));
    try {
      const bulk = PROJECT_MEMORY_MAX_CHARS * 4;
      // Repo layers.
      writeFileSync(join(root, "REASONIX.md"), "p".repeat(bulk));
      writeFileSync(join(root, ".gitignore"), "g".repeat(bulk));
      // Home layers, seeded past their caps so every reader truncates.
      const projectScope = join(home, ".reasonix", "memory", projectHash(root));
      const globalScope = join(home, ".reasonix", "memory", "global");
      mkdirSync(projectScope, { recursive: true });
      mkdirSync(globalScope, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".reasonix", "REASONIX.md"), "r".repeat(bulk));
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "c".repeat(bulk));
      writeFileSync(join(globalScope, "MEMORY.md"), "i".repeat(bulk));
      writeFileSync(join(projectScope, "MEMORY.md"), "j".repeat(bulk));
      writeFileSync(
        join(globalScope, "huge.md"),
        `---\nname: huge\ntype: project\ndescription: huge\npriority: high\n---\n${"b".repeat(bulk)}`,
      );

      const composed = codeSystemPrompt(root, {
        homeDir: home,
        editMode: "never-ask",
        systemAppend: "a".repeat(SYSTEM_APPEND_MAX_CHARS),
      });

      // Vacuousness guard: a fixture that silently reads nothing would pass the ceiling trivially.
      for (const marker of [
        "# Project memory",
        "# Global memory (~/.reasonix/REASONIX.md)",
        "# Global memory (~/.claude/CLAUDE.md)",
        "# User memory: global",
        "# User memory: this project",
        "# HIGH PRIORITY",
        "# Project .gitignore",
        "# User System Append",
        "# Permissions (live)",
      ]) {
        expect(composed).toContain(marker);
      }
      expect(composed.length).toBeLessThanOrEqual(COMPOSED_PROMPT_BUDGET_FULL);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
