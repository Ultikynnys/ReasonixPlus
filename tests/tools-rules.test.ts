/** remember_rule / forget_rule / list_rules through the ToolRegistry, plus live
 *  enforcement: a rule the model remembers must gate the very next run_command. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodeToolset, buildCodeToolset } from "../src/code/setup.js";
import { addGlobalShellAllowed, loadRules, saveEditMode } from "../src/config.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";
import { ToolRegistry } from "../src/tools.js";
import { registerRulesTools } from "../src/tools/rules.js";

/** Answers every gate with a fixed verdict and records the kinds it saw. Registers
 *  a listener so gates consulting `hasListeners()` see an interactive surface. */
class ScriptedGate extends PauseGate {
  readonly kinds: string[] = [];
  private readonly choice: ConfirmationChoice;
  constructor(choice: ConfirmationChoice) {
    super();
    this.choice = choice;
    this.on(() => {});
  }
  override ask = ((opts: { kind: string }) => {
    this.kinds.push(opts.kind);
    return Promise.resolve(this.choice);
  }) as PauseGate["ask"];
}

const DENY: ConfirmationChoice = { type: "deny" };
/** Not in the builtin allowlist, so only a user rule can widen it; safe and quick to run. */
const UNRULY = "git version";

describe("rules tools (registry-level)", () => {
  let root: string;
  let cfgPath: string;
  let reg: ToolRegistry;
  let changes: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-rules-tools-"));
    cfgPath = join(root, "config.json");
    changes = 0;
    reg = registerRulesTools(new ToolRegistry(), {
      rootDir: root,
      configPath: cfgPath,
      onRulesChanged: () => {
        changes += 1;
      },
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("remember_rule", () => {
    it("writes a workspace rule under the mode in force and fires onRulesChanged", async () => {
      const out = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(out).toMatch(/RULE SAVED \(workspace shell\/allow\): npm test/);
      expect(loadRules(root, cfgPath)).toEqual([
        { mode: "follow", effect: "allow", kind: "shell", scope: "workspace", pattern: "npm test" },
      ]);
      expect(changes).toBe(1);
    });

    it("writes a global rule into the top-level rules list", async () => {
      await reg.dispatch("remember_rule", {
        kind: "path",
        effect: "ask",
        pattern: "/etc",
        scope: "global",
      });
      const rules = loadRules(root, cfgPath);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        mode: "follow",
        effect: "ask",
        kind: "path",
        scope: "global",
        pattern: "/etc",
      });
    });

    it("treats a duplicate add as a no-op (no second rule, no changed event)", async () => {
      const args = { kind: "shell", effect: "deny", pattern: "rm -rf", scope: "global" };
      await reg.dispatch("remember_rule", args);
      const out = await reg.dispatch("remember_rule", args);
      expect(out).toMatch(/Already present/);
      expect(loadRules(root, cfgPath)).toHaveLength(1);
      expect(changes).toBe(1);
    });

    it("returns JSON errors for an empty pattern and an invalid enum", async () => {
      const empty = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "   ",
        scope: "workspace",
      });
      expect(JSON.parse(empty).error).toMatch(/pattern is empty/);

      const badEffect = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "sometimes",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(JSON.parse(badEffect).error).toMatch(/effect/);
      expect(changes).toBe(0);
    });

    it("rejects malformed typed args instead of coercing them", async () => {
      // String(["shell"]) === "shell" would let this pass and persist a corrupted rule.
      const arrayKind = await reg.dispatch("remember_rule", {
        kind: ["shell"],
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(JSON.parse(arrayKind).error).toMatch(/kind must be one of/);

      const numberPattern = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: 42,
        scope: "workspace",
      });
      expect(JSON.parse(numberPattern).error).toMatch(/pattern must be a string/);
      expect(loadRules(root, cfgPath)).toEqual([]);
      expect(changes).toBe(0);
    });

    it("a throwing onRulesChanged listener does not fail the write", async () => {
      const throwing = registerRulesTools(new ToolRegistry(), {
        rootDir: root,
        configPath: cfgPath,
        onRulesChanged: () => {
          throw new Error("listener boom");
        },
      });
      const out = await throwing.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(out).toMatch(/RULE SAVED/);
      expect(loadRules(root, cfgPath)).toHaveLength(1);
    });

    it("surfaces regex validation failures as JSON errors, not throws", async () => {
      const invalid = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "[",
        scope: "workspace",
        match: "regex",
      });
      expect(JSON.parse(invalid).error).toMatch(/Invalid regex/);

      const pathRegex = await reg.dispatch("remember_rule", {
        kind: "path",
        effect: "allow",
        pattern: "/etc",
        scope: "workspace",
        match: "regex",
      });
      expect(JSON.parse(pathRegex).error).toMatch(/Regex is only supported for command rules/);
      expect(loadRules(root, cfgPath)).toEqual([]);
      expect(changes).toBe(0);
    });
  });

  describe("forget_rule", () => {
    it("removes an existing rule and fires onRulesChanged", async () => {
      await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      const out = await reg.dispatch("forget_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(out).toMatch(/RULE REMOVED \(workspace shell\/allow\): npm test/);
      expect(loadRules(root, cfgPath)).toEqual([]);
      expect(changes).toBe(2);
    });

    it("reports a missing rule without firing onRulesChanged", async () => {
      const out = await reg.dispatch("forget_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "ghost",
        scope: "workspace",
      });
      expect(out).toMatch(/No matching rule/);
      expect(changes).toBe(0);
    });

    it("only matches the rule set of the given mode, defaulting to the mode in force", async () => {
      await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      // The rule was stored follow-mode; with never-ask in force a mode-less
      // forget must miss, and the explicit mode pins the removal.
      saveEditMode("never-ask", cfgPath);
      const miss = await reg.dispatch("forget_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(miss).toMatch(/No matching rule/);
      const hit = await reg.dispatch("forget_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
        mode: "follow",
      });
      expect(hit).toMatch(/RULE REMOVED/);
      expect(loadRules(root, cfgPath)).toEqual([]);
    });
  });

  describe("list_rules", () => {
    it("says so when no rules are in force", async () => {
      const out = await reg.dispatch("list_rules", {});
      expect(out).toMatch(/No permission rules are in force/);
    });

    it("renders workspace rules, global rules, and legacy allow lists with scope tags", async () => {
      addGlobalShellAllowed("git status", cfgPath);
      await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      await reg.dispatch("remember_rule", {
        kind: "path",
        effect: "deny",
        pattern: "/etc",
        scope: "global",
      });
      const out = await reg.dispatch("list_rules", {});
      expect(out).toContain("- [workspace] follow/allow shell: npm test");
      expect(out).toContain("- [global] follow/deny path: /etc");
      expect(out).toContain("- [global] follow/allow shell: git status");
    });
  });

  describe("registration and gates", () => {
    it("registers all three tools; only list_rules is readOnly", () => {
      expect(reg.has("list_rules")).toBe(true);
      expect(reg.has("remember_rule")).toBe(true);
      expect(reg.has("forget_rule")).toBe(true);
      expect(reg.get("list_rules")?.readOnly).toBe(true);
      expect(reg.get("remember_rule")?.readOnly).not.toBe(true);
      expect(reg.get("forget_rule")?.readOnly).not.toBe(true);
    });

    it("remember_rule is refused in read-only mode", async () => {
      reg.setPlanMode(true);
      const out = await reg.dispatch("remember_rule", {
        kind: "shell",
        effect: "allow",
        pattern: "npm test",
        scope: "workspace",
      });
      expect(JSON.parse(out).rejectedReason).toBe("read-only");
      expect(loadRules(root, cfgPath)).toEqual([]);
    });
  });
});

describe("rules tools through buildCodeToolset (live enforcement)", () => {
  let root: string;
  let cfgPath: string;
  let toolset: CodeToolset;
  const previousConfig = process.env.REASONIX_CONFIG;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "reasonix-rules-live-"));
    cfgPath = join(root, "config.json");
    // The shell tool's enforcement closures read the default config path, so
    // point it at the temp file exactly as a real session would.
    process.env.REASONIX_CONFIG = cfgPath;
    toolset = await buildCodeToolset({ rootDir: root, configPath: cfgPath });
  });

  afterEach(async () => {
    await toolset.jobs.shutdown(500);
    // biome-ignore lint/performance/noDelete: the variable must be unset, not set to "undefined".
    if (previousConfig === undefined) delete process.env.REASONIX_CONFIG;
    else process.env.REASONIX_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  it("a remembered allow rule gates the next run_command with no prompt", async () => {
    const gate = new ScriptedGate(DENY);
    const before = await toolset.tools.dispatch(
      "run_command",
      { command: UNRULY },
      { confirmationGate: gate },
    );
    expect(before).toMatch(/denied/i);
    expect(gate.kinds).toEqual(["run_command"]);

    const saved = await toolset.tools.dispatch("remember_rule", {
      kind: "shell",
      effect: "allow",
      pattern: UNRULY,
      scope: "workspace",
    });
    expect(saved).toMatch(/RULE SAVED/);

    const after = await toolset.tools.dispatch(
      "run_command",
      { command: UNRULY },
      { confirmationGate: gate },
    );
    expect(after).toMatch(/\[exit 0\]/);
    expect(gate.kinds).toEqual(["run_command"]);
  });
});
