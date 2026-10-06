/** Modes × user rules through the real toolset: read only ignores rules, follow
 *  rules is the only mode rules affect, never ask runs everything. */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CodeToolset, applyPlanMode, buildCodeToolset } from "../src/code/setup.js";
import {
  addGlobalPathAllowed,
  addGlobalShellAllowed,
  loadEditMode,
  saveEditMode,
} from "../src/config.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";

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

const ALLOW: ConfirmationChoice = { type: "run_once" };
const DENY: ConfirmationChoice = { type: "deny" };

/** Not in the builtin allowlist, so only a user rule can widen it; safe and quick to run. */
const UNRULY = "git version";
/** In the builtin allowlist, so read only must keep running it with no rules at all. */
const BUILTIN_READ = "node --version";

describe("edit modes × user rules", () => {
  let root: string;
  let cfgPath: string;
  let toolset: CodeToolset;
  const previousConfig = process.env.REASONIX_CONFIG;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "reasonix-mode-rules-"));
    cfgPath = join(root, "config.json");
    // The shell tool's allowAll/extraAllowed closures read the default config path,
    // so point it at the temp file exactly as a real session would.
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

  function runCommand(command: string, gate: PauseGate): Promise<string> {
    return toolset.tools.dispatch("run_command", JSON.stringify({ command }), {
      confirmationGate: gate,
    });
  }

  function writeDir(path: string, gate: PauseGate): Promise<string> {
    return toolset.tools.dispatch("create_directory", JSON.stringify({ path }), {
      confirmationGate: gate,
    });
  }

  describe("read only ignores rules", () => {
    it("refuses a command its rule allows, and never prompts", async () => {
      addGlobalShellAllowed(UNRULY, cfgPath);
      useMode("read-only");
      const gate = new ScriptedGate(ALLOW);
      const out = await runCommand(UNRULY, gate);
      expect(JSON.parse(out).rejectedReason).toBe("read-only");
      expect(gate.kinds).toEqual([]);
    });

    it("still runs the builtin read-only allowlist", async () => {
      useMode("read-only");
      const gate = new ScriptedGate(ALLOW);
      const out = await runCommand(BUILTIN_READ, gate);
      expect(out).toMatch(/\[exit 0\]/);
      expect(gate.kinds).toEqual([]);
    });

    it("refuses a write tool instead of prompting", async () => {
      useMode("read-only");
      const gate = new ScriptedGate(ALLOW);
      const out = await writeDir("made-by-agent", gate);
      expect(JSON.parse(out).rejectedReason).toBe("read-only");
      expect(gate.kinds).toEqual([]);
      expect(existsSync(join(root, "made-by-agent"))).toBe(false);
    });
  });

  describe("follow rules uses rules", () => {
    it("auto-runs a ruled command with no prompt", async () => {
      addGlobalShellAllowed(UNRULY, cfgPath);
      useMode("follow");
      const gate = new ScriptedGate(ALLOW);
      const out = await runCommand(UNRULY, gate);
      expect(out).toMatch(/\[exit 0\]/);
      expect(gate.kinds).toEqual([]);
    });

    it("prompts for an unruly command and does not run it when denied", async () => {
      useMode("follow");
      const gate = new ScriptedGate(DENY);
      const out = await runCommand(UNRULY, gate);
      expect(gate.kinds).toEqual(["run_command"]);
      expect(out).toMatch(/denied/i);
    });

    it("prompts before a write, then applies it on allow", async () => {
      useMode("follow");
      const gate = new ScriptedGate(ALLOW);
      await writeDir("made-by-agent", gate);
      expect(gate.kinds).toEqual(["edit"]);
      expect(existsSync(join(root, "made-by-agent"))).toBe(true);
    });

    it("refuses the write when the prompt is denied", async () => {
      useMode("follow");
      const gate = new ScriptedGate(DENY);
      const out = await writeDir("made-by-agent", gate);
      expect(gate.kinds).toEqual(["edit"]);
      expect(out).toMatch(/rejected this edit/i);
      expect(existsSync(join(root, "made-by-agent"))).toBe(false);
    });
  });

  describe("never ask runs everything", () => {
    it("runs an unruly command with no rule and no prompt", async () => {
      useMode("never-ask");
      const gate = new ScriptedGate(DENY);
      const out = await runCommand(UNRULY, gate);
      expect(out).toMatch(/\[exit 0\]/);
      expect(gate.kinds).toEqual([]);
    });

    it("writes with no prompt", async () => {
      useMode("never-ask");
      const gate = new ScriptedGate(DENY);
      await writeDir("made-by-agent", gate);
      expect(gate.kinds).toEqual([]);
      expect(existsSync(join(root, "made-by-agent"))).toBe(true);
    });
  });

  describe("mode rules override configured rules", () => {
    let outside: string | null = null;

    /** A file outside the sandbox plus a persisted global rule covering its directory. */
    function outsideFileWithRule(): string {
      outside = mkdtempSync(join(tmpdir(), "reasonix-outside-"));
      const file = join(outside, "note.txt");
      writeFileSync(file, "hi");
      addGlobalPathAllowed(outside, cfgPath);
      return file;
    }

    function readFile(path: string, gate: PauseGate): Promise<string> {
      return toolset.tools.dispatch("read_file", JSON.stringify({ path }), {
        confirmationGate: gate,
      });
    }

    afterEach(() => {
      if (outside) rmSync(outside, { recursive: true, force: true });
    });

    it("read only ignores the path rule, so the outside read still prompts", async () => {
      const file = outsideFileWithRule();
      useMode("read-only");
      const gate = new ScriptedGate(DENY);
      const out = await readFile(file, gate);
      expect(gate.kinds).toEqual(["path_access"]);
      expect(out).toMatch(/denied/i);
    });

    it("follow rules honours the same path rule with no prompt", async () => {
      const file = outsideFileWithRule();
      useMode("follow");
      const gate = new ScriptedGate(DENY);
      const out = await readFile(file, gate);
      expect(gate.kinds).toEqual([]);
      expect(out).toContain("hi");
    });
  });
});
