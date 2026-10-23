/** Parity net: a registered tool is either named in the system prompt or deliberately listed as silent.
 *  A tool that is neither is invisible guidance — the model has its schema but no cue about when to use it. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { codeSystemPrompt } from "../src/code/prompt.js";
import { registerAllBuiltins } from "./support/full-toolset.js";

/** Tools whose usage is carried by the spec alone. Adding a name here is a deliberate choice, not a default. */
const PROMPT_SILENT_TOOLS = [
  "activate_plan",
  "add_mcp_server",
  "computer_use",
  "copy_file",
  "create_directory",
  "delete_directory",
  "delete_file",
  "directory_tree",
  "find_in_code",
  "forget",
  "forget_rule",
  "generate_image",
  "get_file_info",
  "get_symbols",
  "job_output",
  "list_directory",
  "list_rules",
  "move_file",
  "present_file",
  "read_file",
  "recall_memory",
  "remember_rule",
  "screen_capture",
  "see_image",
  "stop_job",
  "web_fetch",
  "web_search",
];

const root = mkdtempSync(join(tmpdir(), "reasonix-parity-"));
const { tools, jobs } = registerAllBuiltins(root);
const prompt = codeSystemPrompt(root, { subagentsEnabled: true });
const names = tools.specs().map((spec) => spec.function.name);

afterAll(async () => {
  await jobs.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe("tool to prompt parity", () => {
  it("every registered tool is named in the prompt or allowlisted as silent", () => {
    const silent = names.filter((name) => !prompt.includes(name)).sort();
    expect(silent).toEqual([...PROMPT_SILENT_TOOLS]);
  });

  it("keeps the silent allowlist a bounded share of the toolset", () => {
    // The prompt delegates routine tool semantics to the tool specification, so the
    // named set is smaller than the toolset. This floor is the guard: the prompt must
    // still describe a working core, and the allowlist cannot quietly swallow it.
    expect(names.length - PROMPT_SILENT_TOOLS.length).toBeGreaterThanOrEqual(20);
    expect(names.length).toBeGreaterThanOrEqual(51);
  });

  it("names the core workflow tools explicitly", () => {
    for (const name of [
      "search_content",
      "multi_edit",
      "run_command",
      "submit_plan",
      "ask_choice",
      "todo_write",
      "mark_step_complete",
      "spawn_subagent",
    ]) {
      expect(prompt).toContain(name);
    }
  });
});
