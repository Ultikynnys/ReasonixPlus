import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ScopedRule,
  addRule,
  copyWorkspaceRules,
  loadRules,
  regexRulePatterns,
  removeRule,
  rulePatterns,
  updateRule,
} from "../src/config.js";
import { matchesAnyRulePattern } from "../src/tools/shell/parse.js";
import { matchesRuleRegex } from "../src/tools/shell/rule-regex.js";

const combination = String.raw`^(?=.*\bgit\b)(?=.*\bpush\b).*`;
const root = mkdtempSync(join(tmpdir(), "regex-rules-"));
const config = join(root, "config.json");
afterEach(() => rmSync(config, { force: true }));
const rule: ScopedRule = {
  mode: "never-ask",
  effect: "deny",
  kind: "shell",
  scope: "workspace",
  match: "regex",
  pattern: combination,
};

describe("regex command rules", () => {
  it("requires both separate words, allowing intervening arguments and chains", () => {
    for (const cmd of [
      "git push",
      "git -C project push origin main",
      "git status && git push",
      "GIT PUSH",
      "push git",
    ]) {
      expect(matchesRuleRegex(cmd, combination)).toBe(true);
    }
    for (const cmd of ["git status", "push", "git stash", "git pushy", "legit push"]) {
      expect(matchesRuleRegex(cmd, combination)).toBe(false);
    }
  });
  it("interrupts pathological patterns and fails closed", () => {
    expect(() => matchesRuleRegex(`${"a".repeat(10000)}!`, "^(a+)+$")).toThrow("execution limit");
    expect(() => matchesRuleRegex("git push", "[")).toThrow("Invalid regex");
  });
  it("persists, copies, edits and removes regex without mixing legacy patterns", () => {
    addRule(rule, root, config);
    addRule({ ...rule, match: undefined }, root, config);
    expect(loadRules(root, config)).toHaveLength(2);
    expect(regexRulePatterns("never-ask", root, config).deny).toEqual([combination]);
    expect(rulePatterns("never-ask", "shell", root, config).deny).toEqual([combination]);
    const other = join(root, "other");
    copyWorkspaceRules(root, other, config, "never-ask");
    expect(loadRules(other, config)).toContainEqual(rule);
    expect(updateRule(rule, { ...rule, effect: "ask" }, root, config)).toBe(true);
    expect(regexRulePatterns("never-ask", root, config).ask).toEqual([combination]);
    expect(removeRule({ ...rule, effect: "ask" }, root, config)).toBe(true);
    expect(loadRules(root, config)).toHaveLength(1);
  });
  it("keeps ignored regex rules stored but omits them from enforcement patterns", () => {
    const ignored = { ...rule, effect: "ignore" as const };
    addRule(ignored, root, config);

    expect(loadRules(root, config)).toContainEqual(ignored);
    expect(regexRulePatterns("never-ask", root, config)).toEqual({
      allow: [],
      ask: [],
      deny: [],
    });
  });

  it("rejects invalid syntax and path regex before writing", () => {
    expect(() => addRule({ ...rule, pattern: "[" }, root, config)).toThrow("Invalid regex");
    expect(() => addRule({ ...rule, kind: "path" }, root, config)).toThrow("command rules");
    expect(loadRules(root, config)).toEqual([]);
  });

  it("keeps the simple git * format matching every git command, unmixed with regex", () => {
    addRule({ ...rule, match: undefined, pattern: "git *" }, root, config);
    for (const cmd of ["git push", "git status", "git -C project push origin main"]) {
      expect(
        matchesAnyRulePattern(cmd, rulePatterns("never-ask", "shell", root, config).deny),
      ).toBe(true);
    }
    expect(
      matchesAnyRulePattern("npm publish", rulePatterns("never-ask", "shell", root, config).deny),
    ).toBe(false);
    // The same text in a regex rule means something different: `*` is a regex quantifier
    // there, not a glob. Both kinds coexist; neither rewrites the other's meaning.
    addRule({ ...rule, pattern: "git *" }, root, config);
    expect(matchesRuleRegex("git status", "git *")).toBe(true);
    expect(matchesRuleRegex("npm status", "git *")).toBe(false);
    expect(regexRulePatterns("never-ask", root, config).deny).toEqual(["git *"]);
  });
});
