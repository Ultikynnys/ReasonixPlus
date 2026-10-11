import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshEditModeKnowledge, refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import { codeSystemPrompt } from "../src/code/prompt.js";
import { patchSessionMeta } from "../src/memory/session.js";
import { ToolRegistry } from "../src/tools.js";

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

describe("refreshEditModeKnowledge", () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-desktop-editmode-"));
    configPath = join(root, "config.json");
    process.env.REASONIX_CONFIG = configPath;
  });

  afterEach(() => {
    process.env.REASONIX_CONFIG = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  function makeTab() {
    const tools = new ToolRegistry();
    const replaceSystem = vi.fn<(system: string) => boolean>().mockReturnValue(true);
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-flash",
      system: "stale",
      toolset: { semantic: { enabled: false }, tools },
      runtime: { loop: { prefix: { replaceSystem } } },
    };
    return { tab, tools, replaceSystem };
  }

  it("read-only closes the dispatch gate and rewrites the live block", () => {
    const { tab, tools, replaceSystem } = makeTab();
    refreshEditModeKnowledge(tab, "read-only");
    expect(tools.planMode).toBe(true);
    expect(tab.system).toContain("Edit gate mode: **Read only** (`read-only`)");
    expect(replaceSystem).toHaveBeenCalledWith(tab.system);
  });

  it("follow and never-ask keep the gate open and track the selection", () => {
    const { tab, tools, replaceSystem } = makeTab();
    refreshEditModeKnowledge(tab, "never-ask");
    expect(tools.planMode).toBe(false);
    expect(tab.system).toContain("Edit gate mode: **Never Ask** (`never-ask`)");

    refreshEditModeKnowledge(tab, "follow");
    expect(tab.system).toContain("Edit gate mode: **Follow Rules** (`follow`)");
    expect(tab.system).not.toContain("Edit gate mode: **Never Ask**");
    expect(replaceSystem).toHaveBeenCalledTimes(2);
  });

  it("refreshes the prompt even before a runtime exists", () => {
    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-flash",
      system: "stale",
      toolset: { semantic: { enabled: false }, tools: new ToolRegistry() },
      runtime: null,
    };
    refreshEditModeKnowledge(tab, "never-ask");
    expect(tab.system).toContain("Edit gate mode: **Never Ask** (`never-ask`)");
  });
});

describe("refreshTabSystemPrompt — session MCP overlay", () => {
  let home: string;
  let root: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reasonix-desktop-prompt-home-"));
    root = mkdtempSync(join(tmpdir(), "reasonix-desktop-prompt-"));
    configPath = join(root, "config.json");
    vi.stubEnv("REASONIX_CONFIG", configPath);
    vi.stubEnv("USERPROFILE", home); // Windows
    vi.stubEnv("HOME", home); // Unix
    // os.homedir() is cached per-process on some platforms — override via spy.
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the system prompt independent of MCP server state", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
      }),
      "utf8",
    );
    patchSessionMeta("sess-mcp", { mcp: { disabledServers: ["playwright"] } });

    const disabledTab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession: "sess-mcp",
      system: "stale",
      toolset: { semantic: { enabled: false } },
    };

    refreshTabSystemPrompt(disabledTab);
    const disabledPrompt = disabledTab.system;

    patchSessionMeta("sess-mcp2", { mcp: { disabledServers: [] } });
    const enabledTab = {
      ...disabledTab,
      currentSession: "sess-mcp2",
      system: "stale",
    };

    refreshTabSystemPrompt(enabledTab);

    expect(enabledTab.system).toBe(disabledPrompt);
    expect(enabledTab.system).not.toContain("playwright");
    expect(enabledTab.system).not.toContain("[disabled]");
  });
});
