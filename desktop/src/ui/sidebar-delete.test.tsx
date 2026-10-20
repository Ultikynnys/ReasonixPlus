// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../App";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

afterEach(cleanup);

const RUNNING = "desktop-20260101000000-1";
const IDLE = "desktop-20260102000000-1";

function session(name: string): SessionInfo {
  return { name, summary: name, messageCount: 1, mtime: "2026-01-01T00:00:00.000Z" };
}

function renderSidebar(
  over: {
    sessions?: SessionInfo[];
    running?: string[];
    sessionMutation?: { kind: "delete" } | { kind: "clear" } | { kind: "create" } | null;
    onDeleteSession?: (name: string) => void;
  } = {},
) {
  return render(
    <Sidebar
      sessions={over.sessions ?? [session(IDLE), session(RUNNING)]}
      runningSessions={new Set(over.running ?? [RUNNING])}
      sessionMutation={over.sessionMutation ?? null}
      onNewChat={() => {}}
      onLoadSession={() => {}}
      onDeleteSession={over.onDeleteSession ?? (() => {})}
      onClearSessions={() => {}}
      onOpenWorkdir={() => {}}
      onOpenSettings={() => {}}
      onOpenAbout={() => {}}
    />,
  );
}

/** The delete operator as the user sees it: a disabled state plus the wording that
 *  explains it, keyed off whether the row's agent is running. */
function deleteButtons(container: HTMLElement): {
  idle?: HTMLButtonElement;
  running?: HTMLButtonElement;
} {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>(".session-item .delete-btn"),
  );
  return {
    idle: buttons.find((b) => b.getAttribute("aria-label") === "Delete session"),
    running: buttons.find(
      (b) => b.getAttribute("aria-label") === "Stop this session's agent to delete it",
    ),
  };
}

describe("sidebar delete operators", () => {
  it("locks the delete button of a running session and says why", () => {
    const { container } = renderSidebar();
    const { idle, running } = deleteButtons(container);
    expect(running?.disabled).toBe(true);
    expect(idle?.disabled).toBe(false);
    expect(running?.title).toBe("Stop this session's agent to delete it");
  });

  it("names the running state on the row itself", () => {
    // A disabled button is pointer-events:none, so its own tooltip never opens.
    const { container } = renderSidebar();
    const titles = Array.from(container.querySelectorAll(".session-item")).map((row) =>
      row.getAttribute("title"),
    );
    expect(titles).toContain(`${RUNNING} · running, delete disabled`);
    expect(titles).toContain(IDLE);
  });

  it("opens the confirmation for a deletable session and reports the pick", () => {
    const onDeleteSession = vi.fn();
    const { container } = renderSidebar({ onDeleteSession });
    const { idle } = deleteButtons(container);
    fireEvent.click(idle!);
    const confirm = container.querySelector<HTMLButtonElement>(
      ".session-delete-popover button.confirm",
    );
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);
    expect(onDeleteSession).toHaveBeenCalledWith(IDLE);
  });

  it("locks every delete operator while a delete is in flight", () => {
    const { container } = renderSidebar({ sessionMutation: { kind: "delete" } });
    const { idle, running } = deleteButtons(container);
    expect(running?.disabled).toBe(true);
    expect(idle?.disabled).toBe(true);
    const clearAll = screen.getByRole("button", { name: "Clear all sessions" });
    expect((clearAll as HTMLButtonElement).disabled).toBe(true);
  });

  it("tells the user how many running sessions a clear-all keeps", () => {
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Clear all sessions" }));
    const popover = container.querySelector(".session-delete-popover");
    expect(popover?.querySelector(".name")?.textContent).toBe("1 session(s) for this workspace");
    expect(popover?.querySelector(".note")?.textContent).toBe(
      "1 running session(s) will be kept",
    );
  });

  it("disables clear-all when every session is running", () => {
    renderSidebar({ sessions: [session(RUNNING)], running: [RUNNING] });
    const clearAll = screen.getByRole("button", { name: "Clear all sessions" });
    expect((clearAll as HTMLButtonElement).disabled).toBe(true);
  });

  it("locks New chat while a session is being created", () => {
    // Creation is a one-at-a-time mutation like a delete: the second click must
    // not stack a session, so the operator goes inert for the duration.
    const idle = renderSidebar().container.querySelector<HTMLButtonElement>(".new-btn");
    expect(idle?.disabled).toBe(false);
    cleanup();

    const creating = renderSidebar({ sessionMutation: { kind: "create" } });
    expect(creating.container.querySelector<HTMLButtonElement>(".new-btn")?.disabled).toBe(true);
  });

  it("locks the workspace switch control while a session mutation runs", () => {
    // Switching mid-mutation re-targets the channel waiting for its settled
    // session list, so the picker must not even open.
    const idle = renderSidebar().container.querySelector<HTMLButtonElement>(".workspace-btn");
    expect(idle?.disabled).toBe(false);
    cleanup();

    const busy = renderSidebar({ sessionMutation: { kind: "clear" } });
    expect(busy.container.querySelector<HTMLButtonElement>(".workspace-btn")?.disabled).toBe(true);
  });
});
