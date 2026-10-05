import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import { codeSystemPrompt } from "../src/code/prompt.js";

describe("refreshTabSystemPrompt", () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-desktop-prompt-"));
    configPath = join(root, "config.json");
    process.env.REASONIX_CONFIG = configPath;
  });

  afterEach(() => {
    process.env.REASONIX_CONFIG = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("delegates prompt composition to the canonical builder", () => {
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      system: "stale",
      toolset: { semantic: { enabled: true } },
    };

    refreshTabSystemPrompt(tab);

    expect(tab.system).toBe(
      codeSystemPrompt(root, {
        hasSemanticSearch: true,
        modelId: "deepseek-v4-pro",
        configPath,
      }),
    );
  });

  it("does not mutate an uninitialized tab", () => {
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-flash",
      system: "stale",
      toolset: null,
    };

    refreshTabSystemPrompt(tab);

    expect(tab.system).toBe("stale");
  });

  it("tracks semantic-search capability changes", () => {
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-flash",
      system: "stale",
      toolset: { semantic: { enabled: false } },
    };

    refreshTabSystemPrompt(tab);
    expect(tab.system).not.toContain("# Search routing");

    tab.toolset.semantic.enabled = true;
    refreshTabSystemPrompt(tab);
    expect(tab.system).toContain("# Search routing");
  });
});
