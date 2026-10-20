// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../App";
import type { SessionPlanLabel } from "../plan-labels";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

afterEach(cleanup);

const OWNER = "desktop-20260101000000-1";
const OTHER = "desktop-20260102000000-1";

function session(name: string, summary: string): SessionInfo {
  return { name, summary, messageCount: 0, mtime: "2026-01-01T00:00:00.000Z" };
}

/** The rendered rows keyed by title, so assertions never depend on sort order. */
function rowsByTitle(container: HTMLElement) {
  const rows = new Map<string, { plan: string; state: string | null }>();
  for (const row of Array.from(container.querySelectorAll(".session-item"))) {
    rows.set(row.querySelector(".title")?.textContent ?? "", {
      plan: row.querySelector(".plan-tag")?.textContent ?? "",
      state: row.querySelector(".plan-tag")?.getAttribute("data-plan") ?? null,
    });
  }
  return rows;
}

function renderSidebar(planLabels: Map<string, SessionPlanLabel> | undefined) {
  return render(
    <Sidebar
      sessions={[session(OWNER, "Working session"), session(OTHER, "Idle session")]}
      planLabels={planLabels}
      onNewChat={() => {}}
      onLoadSession={() => {}}
      onDeleteSession={() => {}}
      onClearSessions={() => {}}
      onOpenWorkdir={() => {}}
      onOpenSettings={() => {}}
      onOpenAbout={() => {}}
    />,
  );
}

describe("sidebar plan labels", () => {
  it("names the plan index a session owns and marks the ones without a plan", () => {
    const { container } = renderSidebar(
      new Map([[OWNER, { index: 3, status: "active", summary: "Ship it" }]]),
    );
    const rows = rowsByTitle(container);
    expect(rows.get("Working session")).toEqual({ plan: "Plan #3", state: "live" });
    expect(rows.get("Idle session")).toEqual({ plan: "No plan", state: "none" });
  });

  it("stays silent while the plan history has not loaded yet", () => {
    // An unloaded history is not the same fact as "this session owns no plan".
    const { container } = renderSidebar(undefined);
    expect(container.querySelector(".plan-tag")).toBeNull();
  });
});
