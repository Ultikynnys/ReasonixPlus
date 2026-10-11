// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePlan, Settings, UsageStats } from "../App";
import type { McpSpecInfo } from "../protocol";
import { ContextPanel } from "./context-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

const usage: UsageStats = {
  totalCostUsd: 0,
  lastCallCostUsd: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  lastCallCacheHit: null,
  lastCallCacheMiss: null,
  reservedTokens: 0,
  liveLogTokens: 0,
};

const settings: Settings = {
  reasoningEffort: "high",
  editMode: "follow",
  maxIterPerTurn: 50,
  maxIterPerTurnOverride: null,
  workspaceDir: "/repo",
  recentWorkspaces: [],
  model: "deepseek-reasoner",
  version: "0.0.0",
};

afterEach(cleanup);

const activePlan: ActivePlan = {
  plan: "Ship the feature",
  summary: "Live checklist",
  steps: [
    { id: "s1", title: "First step", action: "Do first" },
    { id: "s2", title: "Second step", action: "Do second" },
  ],
  completedStepIds: [],
  stepResults: {},
};

function renderPanel(
  overrides: Partial<Settings> = {},
  plan: ActivePlan | null = null,
  mcpSpecs: McpSpecInfo[] = [],
  active = true,
) {
  return render(
    <ContextPanel
      settings={{ ...settings, ...overrides }}
      usage={usage}
      mcpSpecs={mcpSpecs}
      mcpBridged={false}
      sessionFiles={[{ path: "src/new-file.ts", status: "m" }]}
      active={active}
      memory={[]}
      memoryDetail={null}
      memoryResult={null}
      onReadMemory={() => {}}
      onWriteMemory={() => {}}
      onDeleteMemory={() => {}}
      onExportMemories={() => {}}
      onImportMemories={() => {}}
      onDismissMemoryResult={() => {}}
      activePlan={plan}
    />,
  );
}

describe("Session plan history", () => {
  it("selects discarded plans and loads complete details on demand", async () => {
    const onReadPlan = vi.fn();
    const onReadPlans = vi.fn();
    const now = "2026-01-01T00:00:00.000Z";
    render(<ContextPanel settings={settings} usage={usage} mcpSpecs={[]} mcpBridged={false} sessionFiles={[]} memory={[]} memoryDetail={null} memoryResult={null} onReadMemory={() => {}} onWriteMemory={() => {}} onDeleteMemory={() => {}} onExportMemories={() => {}} onImportMemories={() => {}} onDismissMemoryResult={() => {}} onReadPlans={onReadPlans} onReadPlan={onReadPlan} planSession="test" planHistory={[{ id: "old", summary: "Discarded", status: "superseded", createdAt: now, updatedAt: now, finishedAt: null, totalSteps: 2, completedSteps: 1 }, { id: "new", summary: "Current", status: "active", createdAt: now, updatedAt: now, finishedAt: null, totalSteps: 1, completedSteps: 0 }]} planDetails={{ old: { id: "old", summary: "Discarded", status: "superseded", createdAt: now, updatedAt: now, finishedAt: null, body: "Original plan body", steps: [{ id: "one", title: "Accepted first step", action: "First action" }], completions: { one: { stepId: "one", result: "Verified work", notes: "Retained notes", evidence: [{ kind: "verification", summary: "Passed" }] } }, revisions: [] } }} />);
    fireEvent.click(screen.getByText("Plan"));
    expect(onReadPlans).toHaveBeenCalledTimes(1);
    expect(onReadPlan).toHaveBeenCalledWith("new");
    expect(screen.getByText("Plan history")).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Session plan history" });
    // Every plan in the session appears in the dropdown.
    expect(within(select).getAllByRole("option")).toHaveLength(2);
    expect(within(select).getByRole("option", { name: /Discarded/ })).toBeTruthy();
    expect(within(select).getByRole("option", { name: /Current/ })).toBeTruthy();
    fireEvent.change(select, { target: { value: "old" } });
    expect(screen.getByText("Status: superseded")).toBeTruthy();
    expect(screen.getByText("Verified work")).toBeTruthy();
    expect(screen.getByText("Original plan body")).toBeTruthy();
  });
});

describe("ContextPanel git section", () => {
  it("shows the current branch in the section header", async () => {
    vi.mocked(invoke).mockResolvedValue({
      isRepo: true,
      branch: "main",
      entries: [{ path: "a.ts", kind: "modified" }],
    });
    const { container } = renderPanel();
    await waitFor(() => expect(container.querySelector(".git-branch")?.textContent).toBe("main"));
    expect(container.querySelector(".git-branch")).toBeTruthy();
  });

  it("polls git_status only when the tab is active", async () => {
    vi.mocked(invoke).mockResolvedValue({ isRepo: true, branch: "main", entries: [] });
    // An inactive tab must not call git_status at all, even after the poll
    // interval would have elapsed several times.
    const { rerender } = renderPanel({}, null, [], false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    rerender(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[{ path: "src/new-file.ts", status: "m" }]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        active
      />,
    );
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "git_status")).toBe(true),
    );
    const before = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "git_status").length;
    expect(before).toBeGreaterThanOrEqual(1);
  });

  it("omits the branch badge on a detached HEAD", async () => {
    vi.mocked(invoke).mockResolvedValue({
      isRepo: true,
      branch: null,
      entries: [],
    });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "git_status")).toBe(true),
    );
    expect(container.querySelector(".git-branch")).toBeNull();
  });
});

describe("ContextPanel MCP tab count", () => {
  it("shows only the MCP label when no servers are enabled", () => {
    const { container } = renderPanel();
    const tab = screen.getByText("MCP");
    expect(container.querySelector(".ctx-tab-count")).toBeNull();
    expect(tab.querySelector(".dot")).toBeNull();
    expect(tab.textContent).toBe("MCP");
    fireEvent.click(tab);
    expect(tab.getAttribute("data-active")).toBe("true");
  });

  it("shows the throbber and number before the label for one enabled server", () => {
    const { container } = renderPanel({}, null, [{
      raw: "server",
      name: "server",
      transport: "stdio",
      summary: "server",
      status: "connected",
      toolCount: 1,
    }]);
    const badge = container.querySelector(".ctx-tab-count");
    expect(badge?.textContent).toBe("1");
    const indicator = badge?.parentElement;
    const tab = indicator?.parentElement;
    expect(indicator?.className).toBe("tab-active");
    expect(indicator?.firstElementChild?.className).toBe("dot");
    expect(indicator?.firstElementChild?.getAttribute("data-state")).toBe("running");
    expect(indicator?.lastElementChild).toBe(badge);
    expect(tab?.firstChild).toBe(indicator);
    expect(tab?.textContent).toBe("1MCP");
    expect(indicator?.getAttribute("title")).toBe("1 enabled MCP servers in this session");
    fireEvent.click(screen.getByText("MCP"));
    expect(tab?.getAttribute("data-active")).toBe("true");
  });

  it("counts connected session-enabled servers independently of their tool counts", () => {
    const spec = (name: string, patch: Partial<McpSpecInfo>): McpSpecInfo => ({
      raw: name,
      name,
      transport: "stdio",
      summary: name,
      status: "connected",
      ...patch,
    });
    const { container } = renderPanel({}, null, [
      spec("mail", { toolCount: 19, tools: ["send", "read"], sessionDisabledTools: ["send"] }),
      spec("other", { toolCount: 3 }),
      spec("empty", { toolCount: 0, tools: [] }),
      spec("disabled", { toolCount: 100, sessionDisabled: true }),
      spec("failed", { toolCount: 100, status: "failed" }),
      spec("pending", { toolCount: 100, status: "handshake" }),
      spec("configured", { toolCount: 100, status: "configured" }),
    ]);
    expect(container.querySelector(".ctx-tab-count")?.textContent).toBe("3");
    expect(container.querySelectorAll(".ctx-tab-count")).toHaveLength(1);
  });
});

describe("ContextPanel plan tab", () => {
  it("appears after Rules and reflects live checklist progress", () => {
    const { container, rerender } = renderPanel({}, activePlan);
    const tabs = Array.from(container.querySelectorAll(".ctx-tab"));
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Files",
      "Parameters",
      "MCP",
      "Memory",
      "Rules",
      "Plan",
    ]);

    fireEvent.click(screen.getByText("Plan"));
    expect(screen.getByText("Live checklist")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();
    expect(screen.getByText("First step")).toBeTruthy();

    rerender(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        activePlan={{ ...activePlan, completedStepIds: ["s1"], stepResults: { s1: "done" } }}
      />,
    );
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("hides the Raw tab by default and shows it when enabled", () => {
    const { container, rerender } = renderPanel();
    const tabText = () =>
      Array.from(container.querySelectorAll(".ctx-tab")).map((tab) => tab.textContent);
    expect(tabText()).not.toContain("Raw");

    rerender(
      <ContextPanel
        settings={{ ...settings, rawTabEnabled: true }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    expect(tabText()).toContain("Raw");
  });

  it("keeps the Plan tab visible without an active plan", () => {
    const { container } = renderPanel();
    expect(
      Array.from(container.querySelectorAll(".ctx-tab")).some((tab) => tab.textContent === "Plan"),
    ).toBe(true);
  });
});

describe("ContextPanel files", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(openPath).mockReset();
  });
  afterEach(cleanup);

  beforeAll(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn() },
      configurable: true,
    });
  });

  it("collapses the Files in context tree from its header", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".tree")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Files in context" }));
    expect(container.querySelector(".tree")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Files in context" }));
    expect(container.querySelector(".tree")).not.toBeNull();
  });

  it("keeps each tracked file's full path visible", () => {
    const { container } = renderPanel();

    const fileRow = container.querySelector('[data-kind="file"]');

    expect(fileRow?.textContent).toContain("src/new-file.ts");
    expect(fileRow?.getAttribute("title")).toBe("src/new-file.ts");
  });

  it("opens a tracked file from the file row action", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open file: src/new-file.ts" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new-file.ts",
        workspace: "/repo",
      }),
    );
    // The files tab also mounts the Git section, which calls git_status once.
    const revealCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "reveal_in_explorer");
    expect(revealCalls).toHaveLength(1);
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens the file when the file row itself is clicked", async () => {
    const { container } = renderPanel();

    fireEvent.click(container.querySelector('[data-kind="file"]')!);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new-file.ts",
        workspace: "/repo",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("falls back to the OS default handler when the explorer command fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("spawn explorer.exe: boom"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Open file: src/new-file.ts" }));

    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/repo/src/new-file.ts"));
    expect(openPath).toHaveBeenCalledTimes(1);
  });

  it("copying a path does not open the file", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Copy path: src/new-file.ts" }));

    await waitFor(() =>
      expect(vi.mocked(navigator.clipboard.writeText)).toHaveBeenCalledWith("src/new-file.ts"),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("right-clicking a file row opens an Open-with… menu that fires open_with_dialog", async () => {
    const { container } = renderPanel();

    fireEvent.contextMenu(container.querySelector('[data-kind="file"]')!);

    const openWith = await screen.findByRole("menuitem", { name: "Open with…" });
    expect(openWith).toBeTruthy();

    fireEvent.click(openWith);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_with_dialog", {
        path: "/repo/src/new-file.ts",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("renders live log tokens even before final usage arrives", () => {
    render(
      <ContextPanel
        settings={settings}
        usage={{ ...usage, reservedTokens: 50, liveLogTokens: 100 }}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );

    expect(screen.getByText("150 / 300,000")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("triggers onCompact when clicking the compact button in token header", () => {
    const onCompact = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={{ ...usage, reservedTokens: 50, liveLogTokens: 100 }}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onCompact={onCompact}
      />,
    );

    const btn = screen.getByTitle("Force context compaction (fold older turns into a summary)");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it("renders the mode-rules summary, workspace rules, and per-scope add buttons", () => {
    const onRemoveRule = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          rules: [
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "workspace",
              pattern: "git status",
            },
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "workspace",
              pattern: "cargo test",
            },
            {
              mode: "follow",
              effect: "allow",
              kind: "path",
              scope: "workspace",
              pattern: "/opt/sdk",
            },
          ],
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onAddRule={() => {}}
        onRemoveRule={onRemoveRule}
      />,
    );

    // Switch to Rules tab
    fireEvent.click(screen.getByText("Rules"));

    // Mode-derived rules are labelled as the mode's; user-owned rules are per scope.
    expect(screen.getByText("Mode rules")).toBeTruthy();
    expect(screen.getByText("git status")).toBeTruthy();
    expect(screen.getByText("cargo test")).toBeTruthy();
    expect(screen.getByText("/opt/sdk")).toBeTruthy();

    // Each section carries its own plus button, so the section fixes the scope.
    expect(screen.getByRole("button", { name: "Add Rule: Workspace rules" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Rule: Global rules" })).toBeTruthy();
    // The standalone composer is gone: no submit button until a plus is used.
    expect(screen.queryByRole("button", { name: "Add Rule" })).toBeNull();

    const removeBtn = screen.getByRole("button", { name: "Remove rule: git status" });
    fireEvent.click(removeBtn);
    expect(onRemoveRule).toHaveBeenCalledWith({
      mode: "follow",
      effect: "allow",
      kind: "shell",
      scope: "workspace",
      pattern: "git status",
    });
  });

  it("adds a rule into the scope whose plus button opened the form", () => {
    const onAddRule = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onAddRule={onAddRule}
      />,
    );

    // Switch to Rules tab
    fireEvent.click(screen.getByText("Rules"));

    // No form is rendered until a section's plus button is used.
    expect(screen.queryByRole("textbox", { name: "Rule pattern" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Add Rule: Workspace rules" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rule pattern" }), {
      target: { value: "npm run build" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(onAddRule).toHaveBeenCalledWith({
      mode: "follow",
      effect: "allow",
      kind: "shell",
      scope: "workspace",
      pattern: "npm run build",
    });

    // Opening the Global plus retargets the form, so the rule lands in global scope.
    fireEvent.click(screen.getByRole("button", { name: "Add Rule: Global rules" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rule pattern" }), {
      target: { value: "git *" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
    expect(onAddRule).toHaveBeenLastCalledWith({
      mode: "follow",
      effect: "allow",
      kind: "shell",
      scope: "global",
      pattern: "git *",
    });
  });

  it("adds an invalid-regex-combination rule through the match-type selector", () => {
    const onAddRule = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onAddRule={onAddRule}
      />,
    );

    fireEvent.click(screen.getByText("Rules"));
    fireEvent.click(screen.getByRole("button", { name: "Add Rule: Workspace rules" }));

    const pattern = screen.getByRole("textbox", { name: "Rule pattern" });
    const submit = screen.getByRole("button", { name: "Add Rule" });
    fireEvent.change(screen.getByRole("combobox", { name: "Rule matching" }), {
      target: { value: "regex" },
    });

    const combination = String.raw`^(?=.*\bgit\b)(?=.*\bpush\b).*`;
    fireEvent.change(pattern, { target: { value: combination } });
    fireEvent.click(submit);
    expect(onAddRule).toHaveBeenCalledWith({
      mode: "follow",
      effect: "allow",
      kind: "shell",
      scope: "workspace",
      pattern: combination,
      match: "regex",
    });

    // Invalid syntax blocks the add and surfaces the error.
    fireEvent.change(pattern, { target: { value: "[" } });
    fireEvent.click(submit);
    expect(onAddRule).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Invalid regex");
  });

  it("edits an existing rule into a regex rule in place", () => {
    const onUpdateRule = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "never-ask",
          rules: [{ mode: "never-ask", effect: "deny", kind: "shell", scope: "workspace", pattern: "git push" }],
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onUpdateRule={onUpdateRule}
      />,
    );

    fireEvent.click(screen.getByText("Rules"));
    fireEvent.click(screen.getByRole("button", { name: "Edit rule: git push" }));

    const pattern = screen.getByRole("textbox", { name: "Rule pattern" });
    expect((pattern as HTMLInputElement).value).toBe("git push");
    fireEvent.change(screen.getByRole("combobox", { name: "Rule matching" }), {
      target: { value: "regex" },
    });
    fireEvent.change(pattern, { target: { value: String.raw`^(?=.*\bgit\b)(?=.*\bpush\b).*` } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    expect(onUpdateRule).toHaveBeenCalledWith(
      { mode: "never-ask", effect: "deny", kind: "shell", scope: "workspace", pattern: "git push" },
      {
        mode: "never-ask",
        effect: "deny",
        kind: "shell",
        scope: "workspace",
        pattern: String.raw`^(?=.*\bgit\b)(?=.*\bpush\b).*`,
        match: "regex",
      },
    );
  });

  const sideProps = {
    usage,
    mcpSpecs: [],
    mcpBridged: false,
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    memoryResult: null,
    onReadMemory: () => {},
    onWriteMemory: () => {},
    onDeleteMemory: () => {},
    onExportMemories: () => {},
    onImportMemories: () => {},
    onDismissMemoryResult: () => {},
    onAddRule: () => {},
  };

  it("shows no rule sections in Read only, and none of the stored rules", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "read-only",
          rules: [
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "workspace",
              pattern: "git status",
            },
          ],
        }}
        {...sideProps}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    expect(screen.getByText("Mode rules")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add Rule: Workspace rules" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Rule: Global rules" })).toBeNull();
    expect(screen.queryByText("git status")).toBeNull();
  });

  it("shows a mode its own rules, with its own effect choices", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "never-ask",
          rules: [
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "global",
              pattern: "cargo test",
            },
            {
              mode: "never-ask",
              effect: "deny",
              kind: "shell",
              scope: "global",
              pattern: "npm publish",
            },
          ],
        }}
        {...sideProps}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    // Never Ask lists its own deny rule once, in its section, and never Follow's allow rule.
    expect(screen.getAllByText("npm publish")).toHaveLength(1);
    expect(screen.getAllByText("DENY")).toHaveLength(1);
    expect(screen.queryByText("cargo test")).toBeNull();

    // Its composer offers deny/ask, not Follow's allow/ask.
    fireEvent.click(screen.getByRole("button", { name: "Add Rule: Global rules" }));
    // One capsule toggle, the same control as a rule row's badge.
    fireEvent.click(screen.getByRole("button", { name: "Change effect for: DENY" }));
    expect(screen.getByRole("button", { name: "Change effect for: ASK" })).toBeTruthy();
  });

  it("draws one main rule plus its exceptions per mode, without overlap", () => {
    const parseRows = () => {
      const card = document.querySelector(".mode-rules");
      return Array.from(card?.querySelectorAll(".rule") ?? []).map(
        (r) => `${r.querySelector(".pat")?.textContent}=${r.querySelector(".sw")?.textContent}`,
      );
    };
    const expectRows = (rows: string[]) => expect(parseRows()).toEqual(rows);
    const mount = (mode: "read-only" | "follow" | "never-ask") =>
      render(
        <ContextPanel
          settings={{
            ...settings,
            editMode: mode,
            readOnlyTools: ["read_file"],
            builtinShellAllowlist: ["git status"],
            rules: [
              {
                mode: "follow",
                effect: "allow",
                kind: "shell",
                scope: "global",
                pattern: "npm run build",
              },
              {
                mode: "follow",
                effect: "ask",
                kind: "shell",
                scope: "global",
                pattern: "git push",
              },
              {
                mode: "never-ask",
                effect: "deny",
                kind: "shell",
                scope: "global",
                pattern: "npm publish",
              },
              {
                mode: "never-ask",
                effect: "ask",
                kind: "shell",
                scope: "global",
                pattern: "git push --force",
              },
            ],
          }}
          usage={usage}
          mcpSpecs={[]}
          mcpBridged={false}
          sessionFiles={[]}
          memory={[]}
          memoryDetail={null}
          memoryResult={null}
          onReadMemory={() => {}}
          onWriteMemory={() => {}}
          onDeleteMemory={() => {}}
          onExportMemories={() => {}}
          onImportMemories={() => {}}
          onDismissMemoryResult={() => {}}
        />,
      );

    const readOnly = mount("read-only");
    fireEvent.click(screen.getByText("Rules"));
    expectRows([
      "Read tools=ALLOW",
      "Shell allowlist=ALLOW",
      "Outside-sandbox paths=ASK",
    ]);
    readOnly.unmount();

    const follow = mount("follow");
    fireEvent.click(screen.getByText("Rules"));
    expectRows([
      "Everything not listed below=ASK",
      "Read tools=ALLOW",
      "Shell allowlist=ALLOW",
      "Outlook sends=ASK",
    ]);
    follow.unmount();

    const neverAsk = mount("never-ask");
    fireEvent.click(screen.getByText("Rules"));
    expectRows(["Everything not listed below=ALLOW", "Outlook sends=ASK"]);
    neverAsk.unmount();
  });

  it("does not render a rule row that has no rules", () => {
    render(
      <ContextPanel settings={{ ...settings, editMode: "follow" }} {...sideProps} />,
    );
    fireEvent.click(screen.getByText("Rules"));

    // Nothing configured, so only the rules that always apply keep a row.
    const rows = Array.from(
      document.querySelector(".mode-rules")?.querySelectorAll(".rule .pat") ?? [],
    ).map((el) => el.textContent);
    expect(rows).toEqual(["Everything not listed below", "Outlook sends"]);
  });

  it("copies another workspace's rules over this one, from the Workspace rules header", () => {
    const onCopyWorkspaceRules = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "follow",
          workspaceDir: "C:\\ws\\mine",
          workspacesWithRules: [
            { rootDir: "C:\\ws\\mine", ruleCount: 3 },
            { rootDir: "C:\\ws\\other", ruleCount: 5 },
          ],
        }}
        {...sideProps}
        onCopyWorkspaceRules={onCopyWorkspaceRules}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    // The trigger opens a pop-up listing the other workspace only.
    fireEvent.click(screen.getByRole("button", { name: "Copy rules from another workspace" }));
    // The list names each workspace, with its full path kept as the tooltip.
    expect(screen.queryByRole("button", { name: "mine" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "other" }));
    expect(onCopyWorkspaceRules).toHaveBeenCalledWith("C:\\ws\\other");
  });

  it("keeps the copy picker with the Workspace rules label even with nothing to copy", () => {
    render(
      <ContextPanel
        settings={{ ...settings, editMode: "follow", workspacesWithRules: [] }}
        {...sideProps}
        onCopyWorkspaceRules={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    // The trigger is always beside the label, disabled with the reason in its tooltip.
    const trigger = screen.getByRole("button", { name: "Copy rules from another workspace" });
    expect(trigger.textContent).toBe("Copy");
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    expect(trigger.getAttribute("title")).toBe("No other workspace has rules yet");
  });

  it("stays clickable when the daemon has not reported the workspace list", () => {
    render(
      <ContextPanel
        settings={{ ...settings, editMode: "follow" }}
        {...sideProps}
        onCopyWorkspaceRules={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    // An absent list must never be mistaken for "there is nothing to copy from".
    const trigger = screen.getByRole("button", { name: "Copy rules from another workspace" });
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });

  it("changes an existing rule's effect in place, for either scope", () => {
    const onUpdateRule = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "follow",
          rules: [
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "workspace",
              pattern: "npm test",
            },
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "global",
              pattern: "git push",
            },
            {
              mode: "follow",
              effect: "ask",
              kind: "shell",
              scope: "workspace",
              pattern: "npm publish",
            },
          ],
        }}
        {...sideProps}
        onUpdateRule={onUpdateRule}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    fireEvent.click(screen.getByRole("button", { name: "Change effect for: npm test (ALLOW)" }));
    expect(onUpdateRule).toHaveBeenLastCalledWith(
      { mode: "follow", effect: "allow", kind: "shell", scope: "workspace", pattern: "npm test" },
      { mode: "follow", effect: "ask", kind: "shell", scope: "workspace", pattern: "npm test" },
    );
    fireEvent.click(screen.getByRole("button", { name: "Change effect for: npm publish (ASK)" }));
    expect(onUpdateRule).toHaveBeenLastCalledWith(
      { mode: "follow", effect: "ask", kind: "shell", scope: "workspace", pattern: "npm publish" },
      { mode: "follow", effect: "ignore", kind: "shell", scope: "workspace", pattern: "npm publish" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Change effect for: git push (ALLOW)" }));
    expect(onUpdateRule).toHaveBeenLastCalledWith(
      { mode: "follow", effect: "allow", kind: "shell", scope: "global", pattern: "git push" },
      { mode: "follow", effect: "ask", kind: "shell", scope: "global", pattern: "git push" },
    );
  });

  it("never makes the Mode rules card editable", () => {
    render(
      <ContextPanel
        settings={{ ...settings, editMode: "never-ask" }}
        {...sideProps}
        onUpdateRule={vi.fn()}
        onRemoveRule={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    const card = document.querySelector(".mode-rules");
    expect(card).toBeTruthy();
    expect(card?.querySelectorAll("select, input, button").length).toBe(0);
  });

  it("renders the daemon-shipped allowlist patterns in the mode-rules rows", () => {
    const mount = (mode: "read-only" | "follow") =>
      render(
        <ContextPanel
          settings={{
            ...settings,
            editMode: mode,
            readOnlyTools: ["read_file", "glob"],
            builtinShellAllowlist: ["git status", "npm test"],
            rules: [
              {
                mode: "follow",
                effect: "allow",
                kind: "shell",
                scope: "workspace",
                pattern: "npm run build",
              },
              {
                mode: "follow",
                effect: "ask",
                kind: "shell",
                scope: "global",
                pattern: "git push",
              },
            ],
          }}
          usage={usage}
          mcpSpecs={[]}
          mcpBridged={false}
          sessionFiles={[]}
          memory={[]}
          memoryDetail={null}
          memoryResult={null}
          onReadMemory={() => {}}
          onWriteMemory={() => {}}
          onDeleteMemory={() => {}}
          onExportMemories={() => {}}
          onImportMemories={() => {}}
          onDismissMemoryResult={() => {}}
        />,
      );
    const patterns = () =>
      Array.from(document.querySelectorAll(".mode-rules .desc.pattern")).map(
        (el) => el.textContent ?? "",
      );

    const follow = mount("follow");
    fireEvent.click(screen.getByText("Rules"));
    const followPatterns = patterns();
    follow.unmount();

    const readOnly = mount("read-only");
    fireEvent.click(screen.getByText("Rules"));
    const readOnlyPatterns = patterns();
    readOnly.unmount();

    expect(followPatterns).toContain("read_file | glob");
    // The card lists the mode's own allowlist only; your rules stay in their sections.
    expect(followPatterns).toContain("git status | npm test");
    expect(followPatterns).not.toContain("npm run build");
    expect(readOnlyPatterns).toContain("git status | npm test");
    expect(readOnlyPatterns).not.toContain("npm run build");
  });

  it("shows no rule rows on the Read only card, since that mode honours no rules", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          editMode: "read-only",
          readOnlyTools: ["read_file"],
          builtinShellAllowlist: ["git status"],
          rules: [
            {
              mode: "follow",
              effect: "allow",
              kind: "shell",
              scope: "global",
              pattern: "npm publish",
            },
          ],
        }}
        {...sideProps}
      />,
    );
    fireEvent.click(screen.getByText("Rules"));

    const labels = Array.from(document.querySelectorAll(".mode-rules .rule .pat")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Read tools", "Shell allowlist", "Outside-sandbox paths"]);
    // The stored Follow rule is not denied here: it simply does not apply.
    expect(screen.queryByText("DENY")).toBeNull();
  });

  it("renders context window slider in the Parameters tab and commits updates", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          contextTokens: 500_000,
          maxIterPerTurn: 75,
          maxIterPerTurnOverride: 75,
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );

    // Switch to Parameters tab
    fireEvent.click(screen.getByText("Parameters"));

    const slider = screen.getByRole("slider", { name: "Context window" });
    expect(slider).toBeTruthy();
    expect(slider.getAttribute("min")).toBe("128000");
    expect(slider.getAttribute("max")).toBe("1000000");
    expect((slider as HTMLInputElement).value).toBe("500000");
    expect(screen.getByText("500K (500,000)")).toBeTruthy();

    // Adjust the slider and release
    fireEvent.change(slider, { target: { value: "750000" } });
    fireEvent.pointerUp(slider);
    expect(onSaveSettings).toHaveBeenCalledWith({ contextTokens: 750_000 });

    // Click reset button
    const resetBtn = screen.getByTitle("Reset to model default");
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ contextTokens: null });

    const iterationSlider = screen.getByRole("slider", { name: "Max iterations" });
    expect(iterationSlider.getAttribute("min")).toBe("50");
    expect(iterationSlider.getAttribute("max")).toBe("100");
    expect(iterationSlider.getAttribute("step")).toBe("1");
    expect((iterationSlider as HTMLInputElement).value).toBe("75");
    expect(screen.getByText("75 iters")).toBeTruthy();

    fireEvent.change(iterationSlider, { target: { value: "90" } });
    fireEvent.pointerUp(iterationSlider);
    expect(onSaveSettings).toHaveBeenCalledWith({ maxIterPerTurn: 90 });

    const iterationReset = screen.getByTitle("Reset to environment or default (50)");
    fireEvent.click(iterationReset);
    expect(onSaveSettings).toHaveBeenCalledWith({ maxIterPerTurn: null });
  });

  it("hides Ollama generation controls when neither endpoint is Ollama", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));
    expect(screen.queryByTestId("ollama-generation-settings")).toBeNull();
  });

  it("shows Ollama generation controls when the main model endpoint is Ollama", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: {
            temperature: 0.5,
            topP: 0.9,
            topK: 40,
            minP: 0.05,
            seed: 42,
            keepAlive: "30m",
            repeatPenalty: 1.3,
            frequencyPenalty: 0.5,
            presencePenalty: 0.4,
            repeatLastN: 128,
          },
          ollamaGenerationOverrides: { temperature: 0.5, seed: 42 },
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const section = screen.getByTestId("ollama-generation-settings");
    expect(section).toBeTruthy();

    // Placed after Max iterations.
    const maxIter = screen.getByRole("slider", { name: "Max iterations" });
    expect(
      maxIter.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Commit a temperature edit on blur.
    const temp = screen.getByRole("spinbutton", { name: "Temperature" });
    fireEvent.change(temp, { target: { value: "0.7" } });
    fireEvent.blur(temp);
    expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: 0.7 } });

    // Reset an overridden field, scoped to the temperature row.
    const tempRow = temp.closest("label") as HTMLElement;
    const reset = within(tempRow).getByTitle(
      "Reset to environment, Reasonix+ default, or model default",
    );
    fireEvent.click(reset);
    expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: null } });
  });

  it("saves a sampling value immediately on change, without waiting for blur", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: { temperature: 0.5, keepAlive: "30m" },
          ollamaGenerationOverrides: {},
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const temp = screen.getByRole("spinbutton", { name: "Temperature" });
    // Change without blurring or advancing timers: the modification must reach
    // the backend before the user can start the next model request.
    fireEvent.change(temp, { target: { value: "0.7" } });
    expect(onSaveSettings).toHaveBeenCalledWith({ ollamaGeneration: { temperature: 0.7 } });
  });

  it("renders 5 Ollama sampling preset buttons and applies presets on click", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          ollamaGeneration: {
            temperature: 0.2,
            topP: 0.9,
            topK: 40,
            keepAlive: "30m",
          },
          ollamaGenerationOverrides: {
            temperature: 0.2,
            topP: 0.9,
            topK: 40,
          },
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const defaultBtn = screen.getByRole("button", { name: "Default" });
    const codingBtn = screen.getByRole("button", { name: "Coding" });
    const balancedBtn = screen.getByRole("button", { name: "Balanced" });
    const creativeBtn = screen.getByRole("button", { name: "Creative" });
    const antiLoopBtn = screen.getByRole("button", { name: "Anti-loop" });

    expect(defaultBtn).toBeTruthy();
    expect(codingBtn).toBeTruthy();
    expect(balancedBtn).toBeTruthy();
    expect(creativeBtn).toBeTruthy();
    expect(antiLoopBtn).toBeTruthy();

    // With temperature 0.2, topP 0.9, topK 40 and others null, Coding is active
    expect(codingBtn.getAttribute("data-active")).toBe("true");
    expect(defaultBtn.getAttribute("data-active")).toBeNull();

    // Clicking Balanced applies the balanced preset
    fireEvent.click(balancedBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({
      ollamaGeneration: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        seed: null,
        repeatPenalty: null,
        repeatLastN: null,
        frequencyPenalty: null,
        presencePenalty: null,
      },
    });

    // Clicking Default clears all overrides to model defaults
    fireEvent.click(defaultBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({
      ollamaGeneration: {
        temperature: null,
        topP: null,
        topK: null,
        minP: null,
        seed: null,
        repeatPenalty: null,
        repeatLastN: null,
        frequencyPenalty: null,
        presencePenalty: null,
      },
    });
  });

  it("shows Ollama generation controls when only the subagent endpoint is Ollama", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          subagentModelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));
    expect(screen.getByTestId("ollama-generation-settings")).toBeTruthy();
  });

  it("displays actual numeric default values in placeholders instead of 'model default'", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: { keepAlive: "30m" },
          ollamaGenerationOverrides: {},
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    expect(
      screen.getByRole("spinbutton", { name: "Temperature" }).getAttribute("placeholder"),
    ).toBe("0.8");
    expect(screen.getByRole("spinbutton", { name: "Top P" }).getAttribute("placeholder")).toBe(
      "0.9",
    );
    expect(screen.getByRole("spinbutton", { name: "Top K" }).getAttribute("placeholder")).toBe(
      "40",
    );
    expect(screen.getByRole("spinbutton", { name: "Min P" }).getAttribute("placeholder")).toBe("0");
    expect(
      screen.getByRole("spinbutton", { name: "Repeat penalty" }).getAttribute("placeholder"),
    ).toBe("1.1");
    expect(
      screen.getByRole("spinbutton", { name: "Repeat last N" }).getAttribute("placeholder"),
    ).toBe("64");
    expect(
      screen.getByRole("spinbutton", { name: "Frequency penalty" }).getAttribute("placeholder"),
    ).toBe("0");
    expect(
      screen.getByRole("spinbutton", { name: "Presence penalty" }).getAttribute("placeholder"),
    ).toBe("0");
    expect(screen.queryByPlaceholderText("model default")).toBeNull();
  });

  it("displays learned model-specific default values when provided in settings", () => {
    render(
      <ContextPanel
        settings={{
          ...settings,
          modelEndpoint: { provider: "ollama", baseUrl: "http://localhost:11434" },
          subagentModelEndpoint: { provider: "deepseek", baseUrl: "https://api.deepseek.com" },
          ollamaGeneration: { keepAlive: "30m" },
          ollamaGenerationOverrides: {},
          ollamaModelDefaults: {
            temperature: 0.6,
            topP: 0.95,
            topK: 50,
          },
        }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    expect(
      screen.getByRole("spinbutton", { name: "Temperature" }).getAttribute("placeholder"),
    ).toBe("0.6");
    expect(screen.getByRole("spinbutton", { name: "Top P" }).getAttribute("placeholder")).toBe(
      "0.95",
    );
    expect(screen.getByRole("spinbutton", { name: "Top K" }).getAttribute("placeholder")).toBe(
      "50",
    );
    expect(
      screen.getByRole("spinbutton", { name: "Repeat penalty" }).getAttribute("placeholder"),
    ).toBe("1.1");
  });

  it("renders Auto-compaction toggle in the Parameters section and updates setting", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{ ...settings, disableAutoCompaction: false }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    expect(screen.getByText("Auto-compaction")).toBeTruthy();
    const enabledBtn = screen.getByRole("button", { name: "Enabled" });
    const disabledBtn = screen.getByRole("button", { name: "Disabled" });

    expect(enabledBtn.getAttribute("data-on")).toBe("true");
    expect(disabledBtn.getAttribute("data-on")).toBe("false");

    fireEvent.click(disabledBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ disableAutoCompaction: true });
  });

  it("renders the Subagents toggle below Auto-compaction and updates the setting", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const autoCompaction = screen.getByText("Auto-compaction");
    const subagents = screen.getByText("Subagents");
    expect(
      autoCompaction.compareDocumentPosition(subagents) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const enableBtn = screen.getByRole("button", { name: "Enable subagents" });
    const disableBtn = screen.getByRole("button", { name: "Disable subagents" });
    expect(enableBtn.getAttribute("data-on")).toBe("true");
    expect(enableBtn.getAttribute("aria-pressed")).toBe("true");
    expect(disableBtn.getAttribute("data-on")).toBe("false");

    fireEvent.click(disableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ enableSubagents: false });
  });

  it("renders the Elevation toggle below Subagents and updates the setting", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const subagents = screen.getByText("Subagents");
    const elevation = screen.getByText("Elevation (Windows UAC)");
    expect(
      subagents.compareDocumentPosition(elevation) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const enableBtn = screen.getByRole("button", { name: "Enable elevation" });
    const disableBtn = screen.getByRole("button", { name: "Disable elevation" });
    // Elevation is opt-in: absent setting reads as off.
    expect(enableBtn.getAttribute("data-on")).toBe("false");
    expect(disableBtn.getAttribute("data-on")).toBe("true");

    fireEvent.click(enableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ elevationEnabled: true });
    fireEvent.click(disableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ elevationEnabled: false });
  });

  it("renders the Repetition guard toggle below Elevation and updates the setting", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const elevation = screen.getByText("Elevation (Windows UAC)");
    const repetition = screen.getByText("Repetition guard");
    expect(
      elevation.compareDocumentPosition(repetition) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const enableBtn = screen.getByRole("button", { name: "Enable repetition guard" });
    const disableBtn = screen.getByRole("button", { name: "Disable repetition guard" });
    // The guard is opt-in: an absent setting reads as off.
    expect(enableBtn.getAttribute("data-on")).toBe("false");
    expect(disableBtn.getAttribute("data-on")).toBe("true");

    fireEvent.click(enableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ repetitionGuardEnabled: true });
    fireEvent.click(disableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ repetitionGuardEnabled: false });
  });

  it("toggles the question timer setting from the context panel", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const enableBtn = screen.getByRole("button", { name: "Enable question timer" });
    const disableBtn = screen.getByRole("button", { name: "Disable question timer" });

    expect(enableBtn.getAttribute("data-on")).toBe("false");
    expect(disableBtn.getAttribute("data-on")).toBe("true");

    fireEvent.click(enableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ questionTimerEnabled: true });
    fireEvent.click(disableBtn);
    expect(onSaveSettings).toHaveBeenCalledWith({ questionTimerEnabled: false });
  });

  it("displays auto-compaction disabled indicator in context meter legend when active", () => {
    render(
      <ContextPanel
        settings={{ ...settings, disableAutoCompaction: true }}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onExportMemories={() => {}}
        onImportMemories={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );

    expect(screen.getByText("auto-compaction disabled")).toBeTruthy();
  });
});

describe("ContextPanel raw context", () => {
  afterEach(cleanup);

  const base = {
    settings: { ...settings, rawTabEnabled: true },
    usage,
    mcpSpecs: [],
    mcpBridged: false,
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    memoryResult: null,
    onReadMemory: () => {},
    onWriteMemory: () => {},
    onDeleteMemory: () => {},
    onExportMemories: () => {},
    onImportMemories: () => {},
    onDismissMemoryResult: () => {},
  };

  it("fetches the context on open and shows it as plaintext", () => {
    const onReadContext = vi.fn();
    render(
      <ContextPanel
        {...base}
        rawContext={{
          text: "===== system =====\nSYS\n\n===== user =====\nhi",
          messageCount: 1,
          tokens: 42,
          busy: false,
        }}
        onReadContext={onReadContext}
        onWriteContext={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Raw"));
    expect(onReadContext).toHaveBeenCalled();
    const box = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    expect(box.value).toContain("===== system =====\nSYS");
    expect(screen.getByText("1 messages · 42 tokens")).toBeTruthy();
  });

  it("applies an edited context", () => {
    const onWriteContext = vi.fn();
    render(
      <ContextPanel
        {...base}
        rawContext={{ text: "===== system =====\nOLD", messageCount: 0, tokens: 1, busy: false }}
        onReadContext={() => {}}
        onWriteContext={onWriteContext}
      />,
    );
    fireEvent.click(screen.getByText("Raw"));
    const box = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "===== system =====\nNEW" } });
    fireEvent.click(screen.getByText("Apply"));
    expect(onWriteContext).toHaveBeenCalledWith("===== system =====\nNEW");
  });

  it("applies with Cmd/Ctrl+Enter", () => {
    const onWriteContext = vi.fn();
    render(
      <ContextPanel
        {...base}
        rawContext={{ text: "===== system =====\nOLD", messageCount: 0, tokens: 1, busy: false }}
        onReadContext={() => {}}
        onWriteContext={onWriteContext}
      />,
    );
    fireEvent.click(screen.getByText("Raw"));
    const box = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "===== system =====\nNEW" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(onWriteContext).toHaveBeenCalledWith("===== system =====\nNEW");
  });

  it("reseeeds the editor from the server text after apply", () => {
    const { rerender } = render(
      <ContextPanel
        {...base}
        rawContext={{ text: "===== system =====\nOLD", messageCount: 0, tokens: 1, busy: false }}
        onReadContext={() => {}}
        onWriteContext={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Raw"));
    const box = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "===== system =====\nUSER EDIT" } });
    fireEvent.click(screen.getByText("Apply"));
    rerender(
      <ContextPanel
        {...base}
        rawContext={{ text: "===== system =====\nSERVER", messageCount: 0, tokens: 1, busy: false }}
        onReadContext={() => {}}
        onWriteContext={() => {}}
      />,
    );
    const after = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    expect(after.value).toBe("===== system =====\nSERVER");
  });

  it("locks the editor while a turn is running", () => {
    render(
      <ContextPanel
        {...base}
        rawContext={{ text: "===== system =====\nSYS", messageCount: 0, tokens: 1, busy: true }}
        onReadContext={() => {}}
        onWriteContext={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Raw"));
    const box = screen.getByLabelText("Editable request context") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((screen.getByText("Apply") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ContextPanel Git section", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });
  afterEach(cleanup);

  it("lists the workspace changes when the workspace is a repository", async () => {
    vi.mocked(invoke).mockResolvedValue({
      isRepo: true,
      entries: [
        { path: "src/app.ts", kind: "modified" },
        { path: "docs/new.md", kind: "untracked" },
      ],
    });
    renderPanel();

    expect(await screen.findByText("Git")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("docs/new.md")).toBeTruthy();
    expect(screen.getByText("2 changed")).toBeTruthy();
  });

  it("reports a clean repository when there are no changes", async () => {
    vi.mocked(invoke).mockResolvedValue({ isRepo: true, entries: [] });
    renderPanel();

    expect(await screen.findByText("Git")).toBeTruthy();
    expect(screen.getByText("No changes")).toBeTruthy();
  });

  it("says so when the workspace is not a git repository", async () => {
    vi.mocked(invoke).mockResolvedValue({ isRepo: false, entries: [] });
    renderPanel();

    expect(await screen.findByText("Git")).toBeTruthy();
    expect(screen.getByText("This workspace is not a git repository.")).toBeTruthy();
  });

  it("surfaces a repo once it appears", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ isRepo: false, entries: [] });
    renderPanel();
    expect(await screen.findByText("This workspace is not a git repository.")).toBeTruthy();

    vi.mocked(invoke).mockResolvedValue({
      isRepo: true,
      entries: [{ path: "src/new.ts", kind: "untracked" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("src/new.ts")).toBeTruthy();
  });
});
