import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTabSystemPrompt } from "../src/cli/commands/desktop.js";
import { codeSystemPrompt } from "../src/code/prompt.js";
import { patchSessionMeta } from "../src/memory/session.js";

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

  it("marks a config-enabled server disabled when the session overlay disables it", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp"] } },
      }),
      "utf8",
    );
    patchSessionMeta("sess-mcp", { mcp: { disabledServers: ["playwright"] } });

    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession: "sess-mcp",
      system: "stale",
      toolset: { semantic: { enabled: false } },
    };

    refreshTabSystemPrompt(tab);

    expect(tab.system).toContain("- playwright (stdio [disabled]): npx -y @playwright/mcp");
  });

  it("leaves a session-enabled server unmarked even when config disables it", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["-y", "@playwright/mcp"], disabled: true },
        },
      }),
      "utf8",
    );
    // Session owns its set outright — an empty overlay overrides the config default.
    patchSessionMeta("sess-mcp2", { mcp: { disabledServers: [] } });

    const tab = {
      rootDir: root,
      currentModel: "deepseek-v4-pro",
      currentSession: "sess-mcp2",
      system: "stale",
      toolset: { semantic: { enabled: false } },
    };

    refreshTabSystemPrompt(tab);

    expect(tab.system).toContain("- playwright (stdio): npx -y @playwright/mcp");
    expect(tab.system).not.toContain("- playwright (stdio [disabled])");
  });
});
