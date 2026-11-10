import { fireEvent, within } from "@testing-library/react";
import type { SessionInfo } from "../App";

/** A session row as the daemon lists it, with only the fields the sidebar reads. */
export function session(name: string, title = name, messageCount = 1): SessionInfo {
  return { name, title, summary: title, messageCount, mtime: "2026-01-01T00:00:00.000Z" };
}

/** The row for a session, found by the title it carries: a running row appends its
 *  own explanation after the name. */
export function rowOf(container: HTMLElement, name: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>(".session-item")).find((el) =>
    el.getAttribute("title")?.startsWith(name),
  );
  if (!row) throw new Error(`no sidebar row for ${name}`);
  return row;
}

/** Open a row's 3-dot menu the way the user does: one click on the row's button. */
export function openRowMenu(container: HTMLElement, name: string): void {
  fireEvent.click(within(rowOf(container, name)).getByRole("button", { name: "Session actions" }));
}

/** One entry of the open row menu, by the wording the user reads. */
export function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
  const menu = container.querySelector<HTMLElement>(".row-menu");
  if (!menu) throw new Error("no row menu is open");
  return within(menu).getByRole("menuitem", { name: label }) as HTMLButtonElement;
}

/** Inert entries are announced with aria-disabled, not `disabled`, so their reason
 *  still reaches the pointer: a disabled button swallows pointer events. */
export function inert(item: HTMLButtonElement): boolean {
  return item.getAttribute("aria-disabled") === "true";
}
