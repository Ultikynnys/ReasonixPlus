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

function renderSidebar(
  planLabels: Map<string, SessionPlanLabel> | undefined,
  running: string[] = [OWNER, OTHER],
) {
  return render(
    <Sidebar
      sessions={[session(OWNER, "Working session"), session(OTHER, "Idle session")]}
      runningSessions={new Set(running)}
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
  it("names the plan index a running session owns and marks the ones without a plan", () => {
    const { container } = renderSidebar(
      new Map([[OWNER, { index: 3, status: "active", summary: "Ship it" }]]),
    );
    const rows = rowsByTitle(container);
    expect(rows.get("Working session")).toEqual({ plan: "Plan #3", state: "live" });
    expect(rows.get("Idle session")).toEqual({ plan: "No plan", state: "none" });
  });

  it("leaves an idle session unchipped whatever plan it owns", () => {
    // A plan is in flight work, so a row for a session with no agent running must
    // not claim one — and must not flash "No plan" either, which is what made the
    // badge look unstable while switching sessions.
    const { container } = renderSidebar(
      new Map([[OWNER, { index: 3, status: "active", summary: "Ship it" }]]),
      [OTHER],
    );
    const rows = rowsByTitle(container);
    expect(rows.get("Working session")).toEqual({ plan: "", state: null });
    expect(rows.get("Idle session")).toEqual({ plan: "No plan", state: "none" });
  });

  it("drops and restores the chip as the session's run starts and ends", () => {
    // Liveness is the only thing the gate reads, so the same map must chip a
    // running owner, fall silent the moment it goes idle, and come back when it
    // runs again — no refetch of the plan history required.
    const planLabels = new Map([[OWNER, { index: 3, status: "active", summary: "Ship it" }]]);
    const title = "Working session";
    const first = renderSidebar(planLabels, [OWNER, OTHER]);
    expect(rowsByTitle(first.container).get(title)).toEqual({ plan: "Plan #3", state: "live" });
    first.unmount();

    const idle = renderSidebar(planLabels, [OTHER]);
    expect(rowsByTitle(idle.container).get(title)).toEqual({ plan: "", state: null });
    idle.unmount();

    const again = renderSidebar(planLabels, [OWNER, OTHER]);
    expect(rowsByTitle(again.container).get(title)).toEqual({ plan: "Plan #3", state: "live" });
  });

  it("stays silent while the plan history has not loaded yet", () => {
    // An unloaded history is not the same fact as "this session owns no plan".
    const { container } = renderSidebar(undefined);
    expect(container.querySelector(".plan-tag")).toBeNull();
  });
});
