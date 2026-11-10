// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../App";
import { Sidebar } from "./sidebar";
import { inert, menuItem, openRowMenu, rowOf, session } from "./sidebar-test-fixtures";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

afterEach(cleanup);

const ACTIVE = "desktop-20260101000000-1";
const IDLE = "desktop-20260102000000-1";

function renderSidebar(
  over: {
    sessions?: SessionInfo[];
    activeName?: string;
    onRenameSession?: (name: string, title: string) => void;
    onDuplicateSession?: () => void;
    onExportSession?: () => void;
    activeSessionHasMessages?: boolean;
  } = {},
) {
  return render(
    <Sidebar
      sessions={over.sessions ?? [session(ACTIVE, "Active chat"), session(IDLE, "Idle chat")]}
      activeName={over.activeName ?? ACTIVE}
      onNewChat={() => {}}
      onLoadSession={() => {}}
      onDeleteSession={() => {}}
      onClearSessions={() => {}}
      onReorderSession={() => {}}
      onRenameSession={over.onRenameSession ?? (() => {})}
      onDuplicateSession={over.onDuplicateSession}
      onExportSession={over.onExportSession}
      activeSessionHasMessages={over.activeSessionHasMessages}
      onOpenWorkdir={() => {}}
      onOpenSettings={() => {}}
      onOpenAbout={() => {}}
    />,
  );
}

describe("sidebar row menu actions", () => {
  it("offers duplicate and export on the open session and reports each pick", () => {
    const onDuplicateSession = vi.fn();
    const onExportSession = vi.fn();
    const { container } = renderSidebar({ onDuplicateSession, onExportSession });

    openRowMenu(container, ACTIVE);
    const duplicate = menuItem(container, "Duplicate");
    expect(inert(duplicate)).toBe(false);
    fireEvent.click(duplicate);
    expect(onDuplicateSession).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".row-menu")).toBeNull();

    openRowMenu(container, ACTIVE);
    fireEvent.click(menuItem(container, "Export"));
    expect(onExportSession).toHaveBeenCalledTimes(1);
  });

  it("refuses duplicate and export on a row that is not the open session", () => {
    // Both read the transcript the tab holds, so an idle row has nothing to give
    // them: the entries stay visible but inert, with the reason on the pointer.
    const onDuplicateSession = vi.fn();
    const onExportSession = vi.fn();
    const { container } = renderSidebar({ onDuplicateSession, onExportSession });

    openRowMenu(container, IDLE);
    const duplicate = menuItem(container, "Duplicate");
    const exp = menuItem(container, "Export");
    expect(inert(duplicate)).toBe(true);
    expect(inert(exp)).toBe(true);
    expect(duplicate.title).toBe("Open this session first");

    fireEvent.click(duplicate);
    fireEvent.click(exp);
    expect(onDuplicateSession).not.toHaveBeenCalled();
    expect(onExportSession).not.toHaveBeenCalled();
  });

  it("locks duplicate and export on a session with nothing in it", () => {
    const { container } = renderSidebar({ sessions: [session(ACTIVE, "Empty chat", 0)] });
    openRowMenu(container, ACTIVE);
    expect(inert(menuItem(container, "Duplicate"))).toBe(true);
    expect(inert(menuItem(container, "Export"))).toBe(true);
  });

  it("keeps duplicate and export live through the first turn of the open session", () => {
    // The list's count lands when the turn ends, so the open row reads the tab's
    // transcript instead of a row that still says zero messages.
    const onDuplicateSession = vi.fn();
    const { container } = renderSidebar({
      sessions: [session(ACTIVE, "Fresh chat", 0)],
      activeSessionHasMessages: true,
      onDuplicateSession,
    });
    openRowMenu(container, ACTIVE);
    const duplicate = menuItem(container, "Duplicate");
    expect(inert(duplicate)).toBe(false);
    fireEvent.click(duplicate);
    expect(onDuplicateSession).toHaveBeenCalledTimes(1);
  });

  it("renames the open session from a double click on its title", () => {
    const onRenameSession = vi.fn();
    const { container } = renderSidebar({ onRenameSession });

    fireEvent.doubleClick(within(rowOf(container, ACTIVE)).getByText("Active chat"));
    const input = container.querySelector<HTMLInputElement>("input.title-edit");
    expect(input).not.toBeNull();
    expect(input!.value).toBe("Active chat");

    fireEvent.change(input!, { target: { value: "  Renamed   chat  " } });
    fireEvent.keyDown(input!, { key: "Enter" });

    expect(onRenameSession).toHaveBeenCalledWith(ACTIVE, "Renamed chat");
    expect(container.querySelector("input.title-edit")).toBeNull();
  });

  it("ignores a double click on a row that is not the open session", () => {
    const onRenameSession = vi.fn();
    const { container } = renderSidebar({ onRenameSession });

    fireEvent.doubleClick(within(rowOf(container, IDLE)).getByText("Idle chat"));
    expect(container.querySelector("input.title-edit")).toBeNull();
  });

  it("cancels the rename on Escape and keeps the old title", () => {
    const onRenameSession = vi.fn();
    const { container } = renderSidebar({ onRenameSession });

    fireEvent.doubleClick(within(rowOf(container, ACTIVE)).getByText("Active chat"));
    const input = container.querySelector<HTMLInputElement>("input.title-edit")!;
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRenameSession).not.toHaveBeenCalled();
    expect(container.querySelector("input.title-edit")).toBeNull();
    expect(screen.getByText("Active chat")).toBeTruthy();
  });

  it("opens the rename editor from the keyboard and hands focus back afterwards", () => {
    const { container } = renderSidebar();
    const title = within(rowOf(container, ACTIVE)).getByText("Active chat");

    title.focus();
    fireEvent.keyDown(title, { key: "F2" });
    expect(container.querySelector("input.title-edit")).not.toBeNull();

    fireEvent.keyDown(container.querySelector("input.title-edit")!, { key: "Escape" });
    expect(container.querySelector("input.title-edit")).toBeNull();
    expect(document.activeElement).toBe(within(rowOf(container, ACTIVE)).getByText("Active chat"));
  });

  it("takes focus into the menu so its entries are one arrow key away", () => {
    const { container } = renderSidebar();
    openRowMenu(container, ACTIVE);
    expect(document.activeElement).toBe(menuItem(container, "Move to top"));
    fireEvent.keyDown(menuItem(container, "Move to top"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItem(container, "Duplicate"));
  });

  it("hands focus back to the button that opened it when Escape closes the menu", () => {
    const { container } = renderSidebar();
    const trigger = within(rowOf(container, ACTIVE)).getByRole("button", {
      name: "Session actions",
    });
    trigger.focus();
    fireEvent.click(trigger);

    fireEvent.keyDown(menuItem(container, "Move to top"), { key: "Escape" });
    expect(container.querySelector(".row-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes itself when focus leaves the menu", () => {
    const { container } = renderSidebar();
    openRowMenu(container, ACTIVE);
    // Tabbing past the last entry is the one dismissal no click or Escape follows.
    fireEvent.focusOut(menuItem(container, "Delete session"), { relatedTarget: document.body });
    expect(container.querySelector(".row-menu")).toBeNull();
  });
});
