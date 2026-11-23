// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../App";
import { Sidebar } from "./sidebar";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

afterEach(cleanup);

const OWNER = "desktop-20260101000000-1";

function session(name: string): SessionInfo {
  return {
    name,
    title: "A recent PR from the audit",
    summary: "A recent PR from the audit",
    messageCount: 84,
    mtime: "2026-01-01T00:00:00.000Z",
  };
}

function renderSidebar(rates?: Map<string, number>) {
  return render(
    <Sidebar
      sessions={[session(OWNER)]}
      runningSessions={new Set(rates ? [OWNER] : [])}
      sessionRates={rates}
      onNewChat={() => {}}
      onLoadSession={() => {}}
      onDeleteSession={() => {}}
      onClearSessions={() => {}}
      onOpenWorkdir={() => {}}
      onOpenSettings={() => {}}
    />,
  );
}

/** The declarations of one rule, read from the sheet the app ships. */
function declarations(css: string, selector: string): string {
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`${quoted}\\s*\\{([^}]*)\\}`).exec(css);
  expect(rule, `styles.css has no rule for ${selector}`).not.toBeNull();
  return rule?.[1] ?? "";
}

function stylesheet(): string {
  const testPath = expect.getState().testPath;
  expect(testPath, "vitest must report the running test file").toBeTruthy();
  return readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
}

describe("session row height", () => {
  it("keeps the meta strip on one line, whatever the live rate adds to it", () => {
    // A wrapped strip is what made the row two rows tall and the list jump while a
    // session streamed, so the line is pinned and its parts ellipsize instead.
    const css = stylesheet();
    const meta = declarations(css, ".list-row .body .meta");
    expect(meta).toMatch(/white-space:\s*nowrap/);
    expect(meta).toMatch(/overflow:\s*hidden/);

    const text = declarations(css, ".list-row .body .meta > span:not(.sep):not(.rate)");
    expect(text).toMatch(/min-width:\s*0/);
    expect(text).toMatch(/text-overflow:\s*ellipsis/);

    // The figure keeps its width, so it is never the part that gives way.
    expect(declarations(css, ".list-row .body .meta .rate")).toMatch(/flex-shrink:\s*0/);
  });

  it("keeps the rate inside that strip rather than adding a line to the row", () => {
    const { container } = renderSidebar(new Map([[OWNER, 198]]));
    const body = container.querySelector(".session-item .body");
    expect(body?.children).toHaveLength(2);
    expect(Array.from(body?.children ?? []).map((child) => child.className)).toEqual([
      "title-row",
      "meta",
    ]);

    const metas = container.querySelectorAll(".session-item .meta");
    expect(metas).toHaveLength(1);
    expect(metas[0].querySelector(".rate")?.textContent).toBe("198 tok/s");
    // Every child is one of the three kinds the strip styles.
    for (const child of Array.from(metas[0].children)) {
      expect(["", "sep", "rate"]).toContain(child.getAttribute("class") ?? "");
    }
  });
});
