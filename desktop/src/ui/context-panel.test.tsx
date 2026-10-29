// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivePlan, SessionInfo, Settings, UsageStats } from "../App";
import type { PlanDetail, PlanHistoryItem } from "@reasonix/core-utils";
import type { McpSpecInfo, PluginInfo, SkillInfo } from "../protocol";
import { I } from "../icons";
import { ContextPanel } from "./context-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

const usage: UsageStats = {
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
  usageStats: UsageStats = usage,
) {
  return render(
    <ContextPanel
      settings={{ ...settings, ...overrides }}
      usage={usageStats}
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
      onDismissMemoryResult={() => {}}
      activePlan={plan}
    />,
  );
}

describe("Session plan history", () => {
  const now = "2026-01-01T00:00:00.000Z";

  /** One plan-history row with the fields every case cares about defaulted. */
  function plan(overrides: Partial<PlanHistoryItem> & { id: string }): PlanHistoryItem {
    return {
      summary: "Plan",
      status: "active",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      totalSteps: 1,
      completedSteps: 0,
      ...overrides,
    };
  }

  type PlanPanelProps = {
    history?: PlanHistoryItem[];
    details?: Record<string, PlanDetail>;
    planSession?: string;
    sessions?: SessionInfo[];
    onReadPlans?: () => void;
    onReadPlan?: (id: string) => void;
    onRemovePlan?: (id: string) => void;
    onReorderPlan?: (id: string) => void;
    onClearPlans?: () => void;
  };

  function planPanel(props: PlanPanelProps) {
    return (
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
        onDismissMemoryResult={() => {}}
        planHistory={props.history ?? []}
        planDetails={props.details ?? {}}
        planSession={props.planSession}
        sessions={props.sessions}
        onReadPlans={props.onReadPlans}
        onReadPlan={props.onReadPlan}
        onRemovePlan={props.onRemovePlan}
        onReorderPlan={props.onReorderPlan}
        onClearPlans={props.onClearPlans}
      />
    );
  }

  function renderPlans(props: PlanPanelProps = {}) {
    const view = render(planPanel(props));
    fireEvent.click(screen.getByText("Plan"));
    return view;
  }

  function rows(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(".ctx-plan-row"));
  }

  function rowTitled(container: HTMLElement, title: string): HTMLElement {
    const row = rows(container).find((candidate) =>
      candidate.querySelector(".title")?.textContent?.includes(title),
    );
    if (!row) throw new Error(`no plan row titled ${title}`);
    return row;
  }

  /** What the left column currently shows as its plan title. */
  function shownPlan(container: HTMLElement): string | undefined {
    return (
      container.querySelector(".ctx-plan-current .ctx-section-title")?.textContent ?? undefined
    );
  }

  it("opens on the session's own plan and shows the plan a row selects", () => {
    const onReadPlan = vi.fn();
    const onReadPlans = vi.fn();
    const { container } = renderPlans({
      onReadPlan,
      onReadPlans,
      planSession: "test",
      history: [
        plan({ id: "new", summary: "Current", ownerSession: "test" }),
        plan({
          id: "old",
          summary: "Discarded",
          status: "superseded",
          totalSteps: 2,
          completedSteps: 1,
        }),
      ],
      details: {
        old: {
          id: "old",
          summary: "Discarded",
          status: "superseded",
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
          body: "Original plan body",
          steps: [{ id: "one", title: "Accepted first step", action: "First action" }],
          completions: {
            one: {
              stepId: "one",
              result: "Verified work",
              notes: "Retained notes",
              evidence: [{ kind: "verification", summary: "Passed" }],
            },
          },
          revisions: [],
        },
      },
    });
    expect(onReadPlans).toHaveBeenCalledTimes(1);
    // The left column opens on this session's plan and asks for its details.
    expect(shownPlan(container)).toBe("Current");
    expect(onReadPlan).toHaveBeenCalledWith("new");
    expect(screen.getByText("Plans")).toBeTruthy();
    // Every plan of the workspace is listed beside it.
    expect(rows(container)).toHaveLength(2);
    // Selecting a row shows that plan's checklist, not the raw plan body.
    fireEvent.click(rowTitled(container, "Discarded"));
    expect(shownPlan(container)).toBe("Discarded");
    expect(screen.getByText("Accepted first step")).toBeTruthy();
    expect(screen.getByText("Verified work")).toBeTruthy();
    expect(screen.queryByText("Original plan body")).toBeNull();
  });

  it("names another session on its row and trims the shown plan to the plan itself", () => {
    const { container } = renderPlans({
      planSession: "mine",
      sessions: [
        { name: "mine", summary: "My chat", messageCount: 1, mtime: now },
        { name: "theirs", summary: "Their chat", messageCount: 1, mtime: now },
      ],
      history: [
        plan({ id: "theirs-plan", summary: "Their work", ownerSession: "theirs" }),
        plan({ id: "mine-plan", summary: "My work", ownerSession: "mine" }),
        // Still claimed on disk, but finished: it owns nothing and names nobody.
        plan({ id: "done-plan", summary: "Done work", status: "completed", ownerSession: "mine" }),
        plan({ id: "orphan-plan", summary: "Orphan work" }),
      ],
    });
    // The section opens on the plan THIS session owns, even though a newer active plan
    // in the same workspace belongs to another session.
    expect(shownPlan(container)).toBe("My work");
    // The list beside it is the whole outline, so the shown plan carries no heading and
    // no ownership line of its own.
    expect(container.querySelector(".ctx-plan-owner")).toBeNull();
    expect(container.querySelector(".ctx-plan-current .list-head")).toBeNull();
    // A row names the session working it, so a plan can be matched by eye.
    expect(rowTitled(container, "Their work").textContent).toContain("Their chat");
    // This session's own plan needs no name, and a finished or unclaimed plan has none.
    expect(rowTitled(container, "My work").textContent).not.toContain("My chat");
    expect(rowTitled(container, "Done work").textContent).not.toContain("My chat");
    expect(rowTitled(container, "Orphan work").querySelector(".state")).toBeNull();
  });

  it("follows the session it switched to, and keeps the choice when that session owns none", () => {
    const history = [
      plan({ id: "a-plan", summary: "Work in A", ownerSession: "a" }),
      plan({ id: "b-plan", summary: "Work in B", ownerSession: "b" }),
      plan({ id: "c-plan", summary: "Work in C", ownerSession: "c" }),
    ];
    const view = renderPlans({ planSession: "b", history });
    expect(shownPlan(view.container)).toBe("Work in B");

    view.rerender(planPanel({ planSession: "a", history }));
    expect(shownPlan(view.container)).toBe("Work in A");

    // A session that owns no plan has nothing to follow, so the choice stands.
    view.rerender(planPanel({ planSession: "planless", history }));
    expect(shownPlan(view.container)).toBe("Work in A");

    // An empty workspace shows one column, and the plan arrives with the history.
    view.rerender(planPanel({ planSession: "c", history: [] }));
    expect(rows(view.container)).toHaveLength(0);
    expect(shownPlan(view.container)).toBeUndefined();
    view.rerender(planPanel({ planSession: "c", history }));
    expect(shownPlan(view.container)).toBe("Work in C");
  });

  it("dots the plans a live session is working and outlines this session's own", () => {
    const { container } = renderPlans({
      planSession: "mine",
      history: [
        plan({ id: "mine-plan", summary: "My work", ownerSession: "mine" }),
        plan({ id: "orphan-plan", summary: "Orphan work" }),
        plan({ id: "done-plan", summary: "Done work", status: "completed", ownerSession: "mine" }),
      ],
    });
    // The dot is the row's state element: only work a session holds right now has one.
    expect(rowTitled(container, "My work").querySelector(".state")).toBeTruthy();
    expect(rowTitled(container, "Orphan work").querySelector(".state")).toBeNull();
    expect(rowTitled(container, "Done work").querySelector(".state")).toBeNull();
    // The outline marks this session's plan, and no other row wears it.
    const outlined = rows(container).filter((row) => row.dataset.current === "true");
    expect(outlined).toHaveLength(1);
    expect(outlined[0]?.querySelector(".title")?.textContent).toContain("My work");
  });

  it("moves a plan to the top from its own row without changing what is shown", () => {
    const onReorderPlan = vi.fn();
    const { container } = renderPlans({
      planSession: "mine",
      history: [
        plan({ id: "mine-plan", summary: "My work", ownerSession: "mine" }),
        plan({ id: "older", summary: "Older work", status: "superseded" }),
      ],
      onReorderPlan,
    });
    fireEvent.click(
      within(rowTitled(container, "Older work")).getByRole("button", { name: "Move to top" }),
    );
    expect(onReorderPlan).toHaveBeenCalledWith("older");
    // The row control acts on its own plan only: the click does not select it.
    expect(shownPlan(container)).toBe("My work");
  });

  it("gives each plan the X and the whole list the trash", () => {
    const { container } = renderPlans({
      history: [plan({ id: "one", summary: "Only plan" })],
      onRemovePlan: vi.fn(),
      onClearPlans: vi.fn(),
    });
    const glyph = (root: ParentNode) => root.querySelector("path")?.getAttribute("d");
    const xGlyph = glyph(render(<I.x />).container);
    const trashGlyph = glyph(render(<I.trash />).container);
    const removeButton = within(rows(container)[0] as HTMLElement).getByRole("button", {
      name: "Remove plan",
    });
    expect(glyph(removeButton)).toBe(xGlyph);
    expect(glyph(screen.getByRole("button", { name: "Delete all plans" }))).toBe(trashGlyph);
  });

  it("keeps the plan when the remove confirm is cancelled", async () => {
    const onRemovePlan = vi.fn();
    vi.mocked(confirmDialog).mockResolvedValue(false);
    const { container } = renderPlans({
      planSession: "mine",
      history: [
        plan({ id: "mine-plan", summary: "My work", ownerSession: "mine" }),
        plan({ id: "doomed", summary: "Doomed plan", status: "superseded" }),
      ],
      onRemovePlan,
    });
    fireEvent.click(
      within(rowTitled(container, "Doomed plan")).getByRole("button", { name: "Remove plan" }),
    );
    // The row control acts on its own plan: removing it does not also select it.
    expect(shownPlan(container)).toBe("My work");
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        "Remove this plan permanently? This cannot be undone.",
      ),
    );
    expect(onRemovePlan).not.toHaveBeenCalled();
  });

  it("removes the plan only after the remove confirm resolves true", async () => {
    const onRemovePlan = vi.fn();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    const { container } = renderPlans({
      planSession: "mine",
      history: [
        plan({ id: "mine-plan", summary: "My work", ownerSession: "mine" }),
        plan({ id: "doomed", summary: "Doomed plan", status: "superseded" }),
      ],
      onRemovePlan,
    });
    fireEvent.click(
      within(rowTitled(container, "Doomed plan")).getByRole("button", { name: "Remove plan" }),
    );
    await waitFor(() => expect(onRemovePlan).toHaveBeenCalledWith("doomed"));
  });

  it("keeps every plan when the clear-all confirm is cancelled", async () => {
    const onClearPlans = vi.fn();
    vi.mocked(confirmDialog).mockResolvedValue(false);
    renderPlans({ history: [plan({ id: "doomed", summary: "Doomed plan" })], onClearPlans });
    fireEvent.click(screen.getByRole("button", { name: "Delete all plans" }));
    await waitFor(() =>
      expect(confirmDialog).toHaveBeenCalledWith(
        "Delete all 1 plan(s) in this workspace? This cannot be undone.",
      ),
    );
    expect(onClearPlans).not.toHaveBeenCalled();
  });

  it("clears every plan only after the clear-all confirm resolves true", async () => {
    const onClearPlans = vi.fn();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    renderPlans({ history: [plan({ id: "doomed", summary: "Doomed plan" })], onClearPlans });
    fireEvent.click(screen.getByRole("button", { name: "Delete all plans" }));
    await waitFor(() => expect(onClearPlans).toHaveBeenCalledTimes(1));
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
    const { container } = renderPanel({}, null, [
      {
        raw: "server",
        name: "server",
        transport: "stdio",
        summary: "server",
        status: "connected",
        toolCount: 1,
      },
    ]);
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
      spec("mail", { toolCount: 19 }),
      spec("other", { toolCount: 3 }),
      spec("empty", { toolCount: 0 }),
      spec("disabled", { toolCount: 100, sessionDisabled: true }),
      spec("failed", { toolCount: 100, status: "failed" }),
      spec("pending", { toolCount: 100, status: "handshake" }),
      spec("configured", { toolCount: 100, status: "configured" }),
    ]);
    expect(container.querySelector(".ctx-tab-count")?.textContent).toBe("3");
    expect(container.querySelectorAll(".ctx-tab-count")).toHaveLength(1);
  });
});

describe("ContextPanel memory counts", () => {
  it("shows global and project counts and updates them when entries change", () => {
    const props = {
      settings,
      usage,
      mcpSpecs: [],
      mcpBridged: false,
      sessionFiles: [],
      memoryDetail: null,
      memoryResult: null,
      onReadMemory: () => {},
      onWriteMemory: () => {},
      onDeleteMemory: () => {},
      onDismissMemoryResult: () => {},
    };
    const global = {
      kind: "global_file" as const,
      scope: "global" as const,
      name: "one",
      path: "/one",
      description: "one",
      type: "freeform",
    };
    const project = {
      kind: "structured" as const,
      scope: "project" as const,
      name: "two",
      path: "/two",
      description: "two",
      type: "project",
    };
    const { container, rerender } = render(
      <ContextPanel {...props} memory={[global, project, { ...project, path: "/three" }]} />,
    );
    const counts = container.querySelector(".ctx-memory-counts");
    expect(counts?.children[0]).toBe(screen.getByLabelText("global: 1"));
    expect(counts?.children[1]).toBe(screen.getByLabelText("project: 2"));
    fireEvent.click(counts as Element);
    expect(screen.getByText("one")).toBeTruthy();
    rerender(<ContextPanel {...props} memory={[]} />);
    expect(screen.getByLabelText("global: 0").textContent).toBe("0");
    expect(screen.getByLabelText("project: 0").textContent).toBe("0");
  });
});

describe("ContextPanel MCP list", () => {
  const spec = (name: string, patch: Partial<McpSpecInfo> = {}): McpSpecInfo => ({
    raw: name,
    name,
    transport: "stdio",
    summary: name,
    status: "connected",
    ...patch,
  });

  it("lists only the servers enabled for this session, hiding session-disabled ones", () => {
    const { container } = renderPanel({}, null, [
      spec("mail"),
      spec("other"),
      spec("hidden", { sessionDisabled: true }),
    ]);
    fireEvent.click(screen.getByText("MCP"));
    const names = Array.from(container.querySelectorAll(".mcp-row .n")).map((n) => n.textContent);
    expect(names).toEqual(["mail", "other"]);
  });

  it("tags each server with where it came from", () => {
    const { container } = renderPanel({}, null, [
      spec("mine"),
      spec("playwright", { builtin: true }),
      spec("relay", { plugin: "notfair" }),
    ]);
    fireEvent.click(screen.getByText("MCP"));
    const tags = Array.from(container.querySelectorAll(".mcp-row .ctx-tag")).map((tag) => ({
      kind: tag.getAttribute("data-k"),
      label: tag.textContent,
      title: tag.getAttribute("title"),
    }));
    expect(tags).toEqual([
      { kind: "standalone", label: "standalone", title: "standalone" },
      { kind: "builtin", label: "builtin", title: "builtin" },
      { kind: "plugin", label: "notfair", title: "plugin notfair" },
    ]);
  });
});

describe("ContextPanel skills and plugins tabs", () => {
  const skill = (id: string, patch: Partial<SkillInfo> = {}): SkillInfo => ({
    id,
    name: id,
    description: `${id} workflow`,
    path: `/skills/${id}/SKILL.md`,
    active: false,
    ...patch,
  });
  const plugin = (slug: string, patch: Partial<PluginInfo> = {}): PluginInfo => ({
    slug,
    name: slug,
    displayName: slug,
    category: "Plugins",
    capabilities: [],
    defaultPrompt: [],
    active: false,
    skills: [],
    servers: [],
    ...patch,
  });

  function renderInventories(skills: SkillInfo[], plugins: PluginInfo[]) {
    const onRequestSkills = vi.fn();
    const onRequestPlugins = vi.fn();
    const view = render(
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        skills={skills}
        plugins={plugins}
        onRequestSkills={onRequestSkills}
        onRequestPlugins={onRequestPlugins}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );
    return { ...view, onRequestSkills, onRequestPlugins };
  }

  it("requests both inventories on open and lists only the skills this chat runs", () => {
    const { container, onRequestSkills, onRequestPlugins } = renderInventories(
      [skill("review", { active: true }), skill("release")],
      [
        plugin("notfair", {
          active: true,
          skills: [{ name: "seo", description: "seo", path: "skills/seo/SKILL.md", root: "skills" }],
        }),
        plugin("rayfin", {
          skills: [
            { name: "brand", description: "brand", path: "skills/brand/SKILL.md", root: "skills" },
          ],
        }),
      ],
    );
    expect(onRequestSkills).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Skills"));
    expect(onRequestSkills).toHaveBeenCalledTimes(1);
    // Plugin skills ride the plugin snapshot, so the tab that lists them refreshes both.
    expect(onRequestPlugins).toHaveBeenCalledTimes(1);
    const names = Array.from(container.querySelectorAll(".mcp-row .n")).map((n) => n.textContent);
    expect(names).toEqual(["review", "seo"]);
    const tags = Array.from(container.querySelectorAll(".mcp-row .ctx-tag")).map((tag) => [
      tag.getAttribute("data-k"),
      tag.textContent,
    ]);
    expect(tags).toEqual([
      ["standalone", "standalone"],
      ["plugin", "notfair"],
    ]);
    // Every listed row is on, so no status dot competes with the source tag.
    expect(container.querySelectorAll(".mcp-row .status")).toHaveLength(0);
    expect(screen.getByText("2 on")).toBeTruthy();
  });

  it("scopes a large inventory to one source instead of one flat list", () => {
    const shipped = Array.from({ length: 25 }, (_, index) => ({
      name: `build-${index}`,
      description: "shipped",
      path: `skills/build-${index}/SKILL.md`,
      root: "skills",
    }));
    const { container } = renderInventories(
      [skill("review", { active: true })],
      [plugin("builder-skills", { displayName: "Builder Skills", active: true, skills: shipped })],
    );
    fireEvent.click(screen.getByText("Skills"));
    const select = screen.getByLabelText("Skill source") as HTMLSelectElement;
    // 26 rows is past a screenful, so the tab opens on the plugin that dominates the list.
    expect(select.value).toBe("builder-skills");
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual([
      "All sources (26)",
      "Standalone (1)",
      "Builder Skills (25)",
    ]);
    expect(container.querySelectorAll(".mcp-row")).toHaveLength(25);
    expect(screen.getByText("25 on")).toBeTruthy();
    // The picker already names the source, so no row repeats it in a tag.
    expect(container.querySelectorAll(".mcp-row .ctx-tag")).toHaveLength(0);

    fireEvent.change(select, { target: { value: "__standalone" } });
    const names = Array.from(container.querySelectorAll(".mcp-row .n")).map((n) => n.textContent);
    expect(names).toEqual(["review"]);
    expect(screen.getByText("1 on")).toBeTruthy();

    fireEvent.change(select, { target: { value: "__all" } });
    expect(container.querySelectorAll(".mcp-row")).toHaveLength(26);
    expect(container.querySelectorAll(".mcp-row .ctx-tag")).toHaveLength(26);
    expect(screen.getByText("26 on")).toBeTruthy();
  });

  it("requests the plugin inventory on open and shows what each running plugin ships", () => {
    const { container, onRequestPlugins } = renderInventories(
      [],
      [
        plugin("notfair", {
          displayName: "NotFair",
          version: "1.0.0",
          active: true,
          skills: [
            { name: "a", description: "a", path: "skills/a/SKILL.md", root: "skills" },
            { name: "b", description: "b", path: "skills/b/SKILL.md", root: "skills" },
          ],
          servers: [{ name: "relay", transport: "stdio", status: "connected" }],
        }),
        plugin("rayfin", { disabled: true }),
      ],
    );
    expect(onRequestPlugins).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Plugins"));
    expect(onRequestPlugins).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1 on")).toBeTruthy();
    expect(screen.getByText("Plugins - 1.0.0 - skills: 2, servers: 1")).toBeTruthy();
    const names = Array.from(container.querySelectorAll(".mcp-row .n")).map((n) => n.textContent);
    expect(names).toEqual(["NotFair"]);
    expect(container.querySelectorAll(".mcp-row .status")).toHaveLength(0);
  });

  it("says so when this chat runs no skill and no plugin", () => {
    renderInventories([skill("review")], [plugin("notfair", { skills: [] })]);

    fireEvent.click(screen.getByText("Skills"));
    expect(screen.getByText("No skills on in this chat")).toBeTruthy();
    expect(screen.queryByLabelText("Skill source")).toBeNull();

    fireEvent.click(screen.getByText("Plugins"));
    expect(screen.getByText("No plugins on in this chat")).toBeTruthy();
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
      "Skills",
      "Plugins",
      "Memory00",
      "Rules",
      "Plan",
      "Events",
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
        onDismissMemoryResult={() => {}}
        activePlan={{ ...activePlan, completedStepIds: ["s1"], stepResults: { s1: "done" } }}
      />,
    );
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
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
        onDismissMemoryResult={() => {}}
      />,
    );

    expect(screen.getByText("150 / 300,000")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("breaks the reserved bucket into skills, tools and the rest of the prompt", () => {
    renderPanel(undefined, null, [], true, {
      ...usage,
      reservedTokens: 15_975,
      skillTokens: 5_727,
      toolTokens: 8_000,
    });
    const breakdown = within(screen.getByTestId("ctx-reserved-breakdown"));
    expect(breakdown.getByText("skills")).toBeTruthy();
    expect(breakdown.getByText("5,727")).toBeTruthy();
    expect(breakdown.getByText("tools")).toBeTruthy();
    expect(breakdown.getByText("8,000")).toBeTruthy();
    expect(breakdown.getByText("prompt")).toBeTruthy();
    expect(breakdown.getByText("2,248")).toBeTruthy();
  });

  it("hides the breakdown until the daemon reports the parts", () => {
    renderPanel(undefined, null, [], true, { ...usage, reservedTokens: 15_975 });
    expect(screen.queryByTestId("ctx-reserved-breakdown")).toBeNull();
  });

  it("lists memory costs by scope inside the reserved row", () => {
    renderPanel(undefined, null, [], true, {
      ...usage,
      reservedTokens: 15_975,
      skillTokens: 5_727,
      toolTokens: 8_000,
      memoryTokens: { global: 400, project: 248, priority: 0 },
    });
    const breakdown = within(screen.getByTestId("ctx-reserved-breakdown"));
    expect(breakdown.queryByText("memory")).toBeNull();
    expect(breakdown.getByText("global")).toBeTruthy();
    expect(breakdown.getByText("400")).toBeTruthy();
    expect(breakdown.getByText("project")).toBeTruthy();
    expect(breakdown.getByText("248")).toBeTruthy();
    // Memory is charged against the prompt remainder, so the parts still sum to `reserved`.
    expect(breakdown.getByText("1,600")).toBeTruthy();
    expect(breakdown.queryByText("high priority")).toBeNull();
  });

  it("shows the high-priority memory layer only when it costs something", () => {
    renderPanel(undefined, null, [], true, {
      ...usage,
      reservedTokens: 15_975,
      skillTokens: 5_727,
      toolTokens: 8_000,
      memoryTokens: { global: 400, project: 248, priority: 120 },
    });
    const breakdown = within(screen.getByTestId("ctx-reserved-breakdown"));
    expect(breakdown.getByText("high priority")).toBeTruthy();
    expect(breakdown.getByText("120")).toBeTruthy();
    expect(breakdown.getByText("1,480")).toBeTruthy();
  });

  it("omits the memory scopes while they cost nothing", () => {
    renderPanel(undefined, null, [], true, {
      ...usage,
      reservedTokens: 15_975,
      skillTokens: 5_727,
      toolTokens: 8_000,
      memoryTokens: { global: 0, project: 0, priority: 0 },
    });
    const breakdown = within(screen.getByTestId("ctx-reserved-breakdown"));
    expect(breakdown.queryByText("global")).toBeNull();
    expect(breakdown.queryByText("project")).toBeNull();
    expect(breakdown.getByText("2,248")).toBeTruthy();
  });

  it("uses the configured context window as the meter denominator before the sidecar reports", () => {
    renderPanel({ contextTokens: 736_000 });

    expect(screen.getByText("0 / 736,000")).toBeTruthy();
  });

  it("prefers the sidecar context cap over the configured window", () => {
    render(
      <ContextPanel
        settings={{ ...settings, contextTokens: 736_000 }}
        usage={{ ...usage, ctxMax: 500_000 }}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[]}
        memoryDetail={null}
        memoryResult={null}
        onReadMemory={() => {}}
        onWriteMemory={() => {}}
        onDeleteMemory={() => {}}
        onDismissMemoryResult={() => {}}
      />,
    );

    expect(screen.getByText("0 / 500,000")).toBeTruthy();
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
          rules: [
            {
              mode: "never-ask",
              effect: "deny",
              kind: "shell",
              scope: "workspace",
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
          onDismissMemoryResult={() => {}}
        />,
      );

    const readOnly = mount("read-only");
    fireEvent.click(screen.getByText("Rules"));
    expectRows(["Read tools=ALLOW", "Shell allowlist=ALLOW", "Outside-sandbox paths=ASK"]);
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
    render(<ContextPanel settings={{ ...settings, editMode: "follow" }} {...sideProps} />);
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
      {
        mode: "follow",
        effect: "ignore",
        kind: "shell",
        scope: "workspace",
        pattern: "npm publish",
      },
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
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const section = screen.getByTestId("ollama-generation-settings");
    expect(section).toBeTruthy();

    // Placed after the last settings slider.
    const compactAt = screen.getByRole("slider", { name: "Auto-compact at" });
    expect(
      compactAt.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
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

  it("renders the Elevation toggle and updates the setting", () => {
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
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    // Subagents are decided by the session-start picker, so the parameters panel no
    // longer offers them.
    expect(screen.queryByText("Subagents")).toBeNull();

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

describe("Compact now button", () => {
  it("triggers the compaction callback from beside the context meter", () => {
    const onCompact = vi.fn();
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
        onDismissMemoryResult={() => {}}
        onCompact={onCompact}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("hides the button when no handler is wired", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Compact now" })).toBeNull();
  });
});

describe("Automatic compaction settings", () => {
  it("renders the automatic compaction toggle and updates the setting", () => {
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
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    expect(screen.getByText("Automatic compaction")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disable automatic compaction" }));
    expect(onSaveSettings).toHaveBeenCalledWith({ autoCompact: false });
    fireEvent.click(screen.getByRole("button", { name: "Enable automatic compaction" }));
    expect(onSaveSettings).toHaveBeenCalledWith({ autoCompact: true });
  });

  it("renders the auto-compact trigger slider and commits updates", () => {
    const onSaveSettings = vi.fn();
    render(
      <ContextPanel
        settings={{ ...settings, autoCompactTrigger: 0.6 }}
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
        onDismissMemoryResult={() => {}}
        onSaveSettings={onSaveSettings}
      />,
    );
    fireEvent.click(screen.getByText("Parameters"));

    const slider = screen.getByRole("slider", { name: "Auto-compact at" });
    expect(slider.getAttribute("min")).toBe("50");
    expect(slider.getAttribute("max")).toBe("95");
    expect((slider as HTMLInputElement).value).toBe("60");
    expect(screen.getByText("60% of window")).toBeTruthy();

    fireEvent.change(slider, { target: { value: "90" } });
    fireEvent.pointerUp(slider);
    expect(onSaveSettings).toHaveBeenCalledWith({ autoCompactTrigger: 0.9 });

    fireEvent.click(screen.getByTitle("Reset to default (80%)"));
    expect(onSaveSettings).toHaveBeenCalledWith({ autoCompactTrigger: null });
  });

  it("marks the auto-compaction threshold on the context meter", () => {
    renderPanel({ autoCompactTrigger: 0.8 });
    const marker = screen.getByTestId("compact-threshold");
    expect(marker.style.left).toBe("80%");
    expect(marker.style.width).toBe("20%");
    expect(marker.getAttribute("title")).toBe("Auto-compaction fires at 80% of the window");
  });

  it("hides the compaction threshold when automatic compaction is off", () => {
    renderPanel({ autoCompact: false });
    expect(screen.queryByTestId("compact-threshold")).toBeNull();
  });
});

describe("ContextPanel memory panel", () => {
  const info = {
    kind: "structured" as const,
    scope: "project" as const,
    name: "budget-cap",
    path: "/home/.reasonix/memory/project/budget-cap.md",
    description: "Cap the budget",
    type: "feedback",
    priority: "high" as const,
  };
  const detail = { ...info, body: "Keep spend under $50." };

  it("edits a structured memory in place, preserving its role and path", () => {
    const onReadMemory = vi.fn();
    const onWriteMemory = vi.fn();
    const panel = (shown: typeof detail | null) => (
      <ContextPanel
        settings={settings}
        usage={usage}
        mcpSpecs={[]}
        mcpBridged={false}
        sessionFiles={[]}
        memory={[info]}
        memoryDetail={shown}
        memoryResult={null}
        onReadMemory={onReadMemory}
        onWriteMemory={onWriteMemory}
        onDeleteMemory={() => {}}
        onDismissMemoryResult={() => {}}
      />
    );

    const { rerender } = render(panel(null));
    fireEvent.click(screen.getByText("Memory"));
    fireEvent.click(screen.getByText("Cap the budget"));
    expect(onReadMemory).toHaveBeenCalledWith(info.path);

    // The arriving detail prefills the composer for editing.
    rerender(panel(detail));
    fireEvent.change(screen.getByDisplayValue("Keep spend under $50."), {
      target: { value: "Keep spend under $100." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Scope + name are unchanged, so the edit rewrites in place and keeps the
    // entry's role (type) and priority; no originalPath is sent (no delete).
    expect(onWriteMemory).toHaveBeenCalledWith(
      "project",
      "budget-cap",
      "Cap the budget",
      "Keep spend under $100.",
      { type: "feedback", priority: "high" },
    );
  });
});
