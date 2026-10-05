/** Agent-facing text (tool specs, built-in skills, MCP catalog) must contain no em (U+2014) or en
 *  (U+2013) dash, so the model does not imitate them. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";
import { MCP_CATALOG } from "../src/mcp/catalog.js";
import { SkillStore, applySkillsIndex } from "../src/skills.js";
import { resetTypesafeValidationCache } from "../src/tools/jev.js";

const EM_DASH = "\u2014";
const EN_DASH = "\u2013";

/** Deep-walk a schema/string value and return the first string containing an em/en dash, or null. */
function firstDash(value: unknown): string | null {
  if (typeof value === "string") {
    return value.includes(EM_DASH) || value.includes(EN_DASH) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = firstDash(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const hit = firstDash(item);
      if (hit) return hit;
    }
  }
  return null;
}

describe("agent-facing text is free of em/en dashes", () => {
  let tmpRoot: string;
  let home: string;
  let projectRoot: string;

  beforeEach(() => {
    resetTypesafeValidationCache();
    tmpRoot = mkdtempSync(join(tmpdir(), "reasonix-dash-"));
    home = join(tmpRoot, "home");
    projectRoot = join(tmpRoot, "proj");
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("every registered tool description and parameter description is dash-free", async () => {
    const toolset = await buildCodeToolset({
      rootDir: tmpRoot,
      configPath: join(tmpRoot, "config.json"),
    });
    try {
      const specs = toolset.tools.specs();
      expect(specs.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const spec of specs) {
        if (firstDash(spec.function.description))
          offenders.push(`${spec.function.name}.description`);
        if (firstDash(spec.function.parameters)) offenders.push(`${spec.function.name}.parameters`);
      }
      expect(offenders).toEqual([]);
    } finally {
      await toolset.jobs.shutdown();
    }
  });

  it("built-in skill bodies and descriptions are dash-free", () => {
    const store = new SkillStore({ homeDir: home, projectRoot });
    const builtins = store.list().filter((s) => s.scope === "builtin");
    expect(builtins.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const skill of builtins) {
      if (firstDash(skill.body)) offenders.push(`${skill.name}.body`);
      if (firstDash(skill.description)) offenders.push(`${skill.name}.description`);
    }
    expect(offenders).toEqual([]);
  });

  it("the pinned skills index is dash-free", () => {
    const index = applySkillsIndex("BASE PROMPT", { homeDir: home, projectRoot });
    expect(firstDash(index)).toBeNull();
  });

  it("the built-in MCP catalog summaries and notes are dash-free", () => {
    const offenders: string[] = [];
    for (const entry of MCP_CATALOG) {
      if (firstDash(entry.summary)) offenders.push(`${entry.name}.summary`);
      if (entry.note && firstDash(entry.note)) offenders.push(`${entry.name}.note`);
    }
    expect(offenders).toEqual([]);
  });
});
