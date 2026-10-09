/** Approval rules: the structured store, and how each mode's effects reach the tools. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodeToolset, applyPlanMode, buildCodeToolset } from "../src/code/setup.js";
import {
  type ScopedRule,
  addGlobalShellAllowed,
  addProjectShellAllowed,
  addRule,
  copyWorkspaceRules,
  listWorkspacesWithRules,
  loadEditMode,
  loadGlobalShellAllowed,
  loadProjectShellAllowed,
  loadRules,
  removeRule,
  rulePatterns,
  saveEditMode,
  updateRule,
} from "../src/config.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";
import { coveredRuleScopes } from "../src/tools/shell/rule-scope.js";

/** Answers every gate with a fixed verdict and records the kinds it saw. */
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

const ALLOW: ConfirmationChoice = { type: "run_once" };
const DENY: ConfirmationChoice = { type: "deny" };
/** Not in the builtin allowlist, so only a rule can decide it. */
const RULED = "git version";

describe("approval rules store", () => {
  let root: string;
  let cfgPath: string;

  const rule = (over: Partial<ScopedRule>): ScopedRule => ({
    mode: "never-ask",
    effect: "deny",
    kind: "shell",
    scope: "global",
    pattern: "npm publish",
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-rules-"));
    cfgPath = join(root, "config.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stores global and workspace rules separately", () => {
    addRule(rule({}), root, cfgPath);
    addRule(rule({ scope: "workspace", pattern: "rm -rf" }), root, cfgPath);

    expect(loadRules(root, cfgPath)).toEqual([
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "global", pattern: "npm publish" },
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "workspace", pattern: "rm -rf" },
    ]);
    // Another workspace inherits the global rule but not this one's workspace rule.
    expect(loadRules(join(root, "elsewhere"), cfgPath)).toEqual([
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "global", pattern: "npm publish" },
    ]);
  });

  it("keeps mode, effect and kind apart, and dedupes", () => {
    addRule(rule({}), root, cfgPath);
    addRule(rule({}), root, cfgPath);
    addRule(rule({ effect: "ask" }), root, cfgPath);
    addRule(rule({ kind: "path", pattern: "/etc" }), root, cfgPath);
    addRule(rule({ mode: "follow", effect: "allow" }), root, cfgPath);

    // Four distinct rules: the repeated add is deduped, not counted twice.
    expect(loadRules(root, cfgPath)).toHaveLength(4);
    expect(rulePatterns("never-ask", "shell", root, cfgPath)).toEqual({
      allow: [],
      ask: ["npm publish"],
      deny: ["npm publish"],
    });
    expect(rulePatterns("never-ask", "path", root, cfgPath).deny).toEqual(["/etc"]);
  });

  it("keeps ignored rules stored but omits them from enforcement patterns", () => {
    const ignored = rule({ effect: "ignore", pattern: "git push" });
    addRule(ignored, root, cfgPath);

    expect(loadRules(root, cfgPath)).toContainEqual(ignored);
    expect(rulePatterns("never-ask", "shell", root, cfgPath)).toEqual({
      allow: [],
      ask: [],
      deny: [],
    });
  });

  it("removes only a whole-rule match", () => {
    addRule(rule({}), root, cfgPath);
    addRule(rule({ effect: "ask" }), root, cfgPath);

    expect(removeRule(rule({ effect: "ask" }), root, cfgPath)).toBe(true);
    expect(loadRules(root, cfgPath)).toHaveLength(1);
    expect(removeRule(rule({ effect: "ask" }), root, cfgPath)).toBe(false);
  });

  it("reads the pre-structured allow lists as Follow allow rules", () => {
    addGlobalShellAllowed("npm test", cfgPath);

    expect(loadRules(root, cfgPath)).toEqual([
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
    ]);
    expect(rulePatterns("follow", "shell", root, cfgPath).allow).toEqual(["npm test"]);

    addRule(rule({}), root, cfgPath);
    expect(loadRules(root, cfgPath)).toHaveLength(2);
  });

  it("changes a workspace rule's effect in place", () => {
    addRule(rule({ scope: "workspace", pattern: "rm -rf" }), root, cfgPath);

    expect(
      updateRule(
        rule({ scope: "workspace", pattern: "rm -rf" }),
        rule({ scope: "workspace", pattern: "rm -rf", effect: "ask" }),
        root,
        cfgPath,
      ),
    ).toBe(true);

    expect(loadRules(root, cfgPath)).toEqual([
      {
        mode: "never-ask",
        effect: "ask",
        kind: "shell",
        scope: "workspace",
        pattern: "rm -rf",
      },
    ]);
    // A rule that is not there is refused rather than silently written.
    expect(updateRule(rule({ pattern: "absent" }), rule({ pattern: "x" }), root, cfgPath)).toBe(
      false,
    );
  });

  it("changes a global rule's effect in place", () => {
    addRule(rule({ mode: "follow", effect: "allow", pattern: "npm test" }), root, cfgPath);

    expect(
      updateRule(
        rule({ mode: "follow", effect: "allow", pattern: "npm test" }),
        rule({ mode: "follow", effect: "ask", pattern: "npm test" }),
        root,
        cfgPath,
      ),
    ).toBe(true);

    expect(rulePatterns("follow", "shell", root, cfgPath)).toEqual({
      allow: [],
      ask: ["npm test"],
      deny: [],
    });
  });

  it("edits a rule that came from the pre-structured allow list", () => {
    addGlobalShellAllowed("npm test", cfgPath);

    expect(
      updateRule(
        { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
        { mode: "follow", effect: "ask", kind: "shell", scope: "global", pattern: "npm test" },
        root,
        cfgPath,
      ),
    ).toBe(true);

    // The flat entry is migrated, not left behind to keep allowing the command.
    expect(loadGlobalShellAllowed(cfgPath)).toEqual([]);
    expect(rulePatterns("follow", "shell", root, cfgPath)).toEqual({
      allow: [],
      ask: ["npm test"],
      deny: [],
    });
  });

  it("removes a rule that came from the pre-structured allow list", () => {
    addGlobalShellAllowed("npm test", cfgPath);
    addProjectShellAllowed(root, "cargo publish", cfgPath);

    expect(
      removeRule(
        { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
        root,
        cfgPath,
      ),
    ).toBe(true);
    expect(
      removeRule(
        {
          mode: "follow",
          effect: "allow",
          kind: "shell",
          scope: "workspace",
          pattern: "cargo publish",
        },
        root,
        cfgPath,
      ),
    ).toBe(true);

    // The flat entries go away, so the row cannot reappear after a delete click.
    expect(loadGlobalShellAllowed(cfgPath)).toEqual([]);
    expect(loadProjectShellAllowed(root, cfgPath)).toEqual([]);
    expect(rulePatterns("follow", "shell", root, cfgPath)).toEqual({
      allow: [],
      ask: [],
      deny: [],
    });
    // A rule that is not there is still refused.
    expect(
      removeRule(
        { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "absent" },
        root,
        cfgPath,
      ),
    ).toBe(false);
  });

  it("fully removes a rule stored both structured and in a flat allow list", () => {
    // The same signature can live in both stores; the panel shows it once, so one delete
    // must clear both or the row reappears from whichever store was left behind.
    addRule(
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
      root,
      cfgPath,
    );
    addGlobalShellAllowed("npm test", cfgPath);
    expect(loadRules(root, cfgPath)).toHaveLength(1);

    expect(
      removeRule(
        { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
        root,
        cfgPath,
      ),
    ).toBe(true);

    expect(loadRules(root, cfgPath)).toEqual([]);
    expect(loadGlobalShellAllowed(cfgPath)).toEqual([]);
    // A second delete is a clean no-op, not a crash or a partial rewrite.
    expect(
      removeRule(
        { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "npm test" },
        root,
        cfgPath,
      ),
    ).toBe(false);
  });

  it("reports the scope that already carries a rule for a command", () => {
    addRule(
      rule({
        mode: "follow",
        effect: "ask",
        kind: "shell",
        scope: "global",
        pattern: "git version",
      }),
      root,
      cfgPath,
    );
    addRule(
      rule({
        mode: "follow",
        effect: "allow",
        kind: "shell",
        scope: "workspace",
        pattern: "npm run dev",
      }),
      root,
      cfgPath,
    );

    expect(coveredRuleScopes("shell", "git version", root, cfgPath)).toEqual(["global"]);
    expect(coveredRuleScopes("shell", "npm run dev", root, cfgPath)).toEqual(["workspace"]);
    expect(coveredRuleScopes("shell", "cargo build", root, cfgPath)).toEqual([]);
  });

  it("counts a flat allow-list entry as a covering rule in never-ask", () => {
    addGlobalShellAllowed("git version", cfgPath);
    saveEditMode("never-ask", cfgPath);
    // The allow list is stored as Follow/allow but stays in force in never-ask.
    expect(coveredRuleScopes("shell", "git version", root, cfgPath)).toEqual(["global"]);
  });

  it("reports a covering path rule by directory containment", () => {
    addRule(
      rule({
        mode: "follow",
        effect: "ask",
        kind: "path",
        scope: "workspace",
        pattern: "/opt/sdk",
      }),
      root,
      cfgPath,
    );
    expect(coveredRuleScopes("path", "/opt/sdk/tools", root, cfgPath)).toEqual(["workspace"]);
    expect(coveredRuleScopes("path", "/opt/other", root, cfgPath)).toEqual([]);
  });

  it("copies another workspace's rules of the current mode, leaving other modes alone", () => {
    const other = join(root, "other-ws");
    // The source carries a structured rule and one from the pre-structured list.
    addRule(
      { mode: "follow", effect: "ask", kind: "shell", scope: "workspace", pattern: "git push" },
      other,
      cfgPath,
    );
    addProjectShellAllowed(other, "npm run build", cfgPath);
    // This workspace starts with a rule of its own that the copy has to replace.
    addRule(
      {
        mode: "never-ask",
        effect: "deny",
        kind: "shell",
        scope: "workspace",
        pattern: "rm -rf",
      },
      root,
      cfgPath,
    );

    // Mode-scoped on both sides: a workspace is a source only for the rules of that mode.
    expect(listWorkspacesWithRules(cfgPath, "follow")).toEqual([{ rootDir: other, ruleCount: 2 }]);
    expect(listWorkspacesWithRules(cfgPath, "never-ask")).toEqual([
      { rootDir: root, ruleCount: 1 },
    ]);
    expect(copyWorkspaceRules(other, root, cfgPath, "follow")).toBe(2);

    expect(loadRules(root, cfgPath).filter((r) => r.scope === "workspace")).toEqual([
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "workspace", pattern: "rm -rf" },
      { mode: "follow", effect: "ask", kind: "shell", scope: "workspace", pattern: "git push" },
      {
        mode: "follow",
        effect: "allow",
        kind: "shell",
        scope: "workspace",
        pattern: "npm run build",
      },
    ]);
    // The follow set is replaced, not merged: the old flat entry is gone.
    expect(loadProjectShellAllowed(root, cfgPath)).toEqual([]);
    expect(copyWorkspaceRules(root, root, cfgPath, "follow")).toBe(0);
  });
});

describe("rule effects reach the shell tool", () => {
  let root: string;
  let cfgPath: string;
  let toolset: CodeToolset;
  const previousConfig = process.env.REASONIX_CONFIG;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "reasonix-rule-effects-"));
    cfgPath = join(root, "config.json");
    process.env.REASONIX_CONFIG = cfgPath;
    toolset = await buildCodeToolset({ rootDir: root });
  });

  afterEach(async () => {
    await toolset.jobs.shutdown(500);
    // biome-ignore lint/performance/noDelete: the variable must be unset, not set to "undefined".
    if (previousConfig === undefined) delete process.env.REASONIX_CONFIG;
    else process.env.REASONIX_CONFIG = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  function useMode(mode: "read-only" | "follow" | "never-ask"): void {
    saveEditMode(mode, cfgPath);
    applyPlanMode(toolset.tools, loadEditMode(cfgPath));
  }

  function run(gate: PauseGate): Promise<string> {
    return toolset.tools.dispatch("run_command", JSON.stringify({ command: RULED }), {
      confirmationGate: gate,
    });
  }

  it("never-ask: a deny rule refuses outright, with no prompt", async () => {
    addRule(
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    useMode("never-ask");
    const gate = new ScriptedGate(ALLOW);
    const out = await run(gate);

    expect(out).toMatch(/Never Ask rules/);
    expect(gate.kinds).toEqual([]);
  });

  it("never-ask: an ask rule prompts instead of auto-running", async () => {
    addRule(
      { mode: "never-ask", effect: "ask", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    useMode("never-ask");
    const gate = new ScriptedGate(DENY);
    const out = await run(gate);

    expect(gate.kinds).toEqual(["run_command"]);
    expect(out).toMatch(/denied/i);
  });

  it("never-ask: an unruled command still auto-runs", async () => {
    useMode("never-ask");
    const gate = new ScriptedGate(DENY);
    const out = await run(gate);

    expect(out).toMatch(/\[exit 0\]/);
    expect(gate.kinds).toEqual([]);
  });

  it("follow: an allow rule runs silently, an ask rule carves out a prompt", async () => {
    addRule(
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    useMode("follow");
    const allowed = await run(new ScriptedGate(DENY));
    expect(allowed).toMatch(/\[exit 0\]/);

    addRule(
      { mode: "follow", effect: "ask", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    const gate = new ScriptedGate(DENY);
    const asked = await run(gate);
    // Ask beats allow: the earlier allow rule no longer runs it silently.
    expect(gate.kinds).toEqual(["run_command"]);
    expect(asked).toMatch(/denied/i);
  });

  it("read-only ignores every rule and refuses", async () => {
    addRule(
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    useMode("read-only");
    const gate = new ScriptedGate(ALLOW);
    const out = await run(gate);

    expect(JSON.parse(out).rejectedReason).toBe("read-only");
    expect(gate.kinds).toEqual([]);
    expect(existsSync(join(root, "never-written"))).toBe(false);
  });

  it("elevated runs are confirmed even with an allow rule", async () => {
    writeFileSync(cfgPath, JSON.stringify({ editMode: "follow", elevationEnabled: true }), "utf8");
    addRule(
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: RULED },
      root,
      cfgPath,
    );
    toolset = await buildCodeToolset({ rootDir: root, configPath: cfgPath });
    const gate = new ScriptedGate(DENY);
    const out = await toolset.tools.dispatch(
      "run_command",
      JSON.stringify({ command: RULED, elevate: true }),
      { confirmationGate: gate },
    );

    expect(gate.kinds).toEqual(["run_command"]);
    expect(out).toMatch(/denied/i);
  });
});
