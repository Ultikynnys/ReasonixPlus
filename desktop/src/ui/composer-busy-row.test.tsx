// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";

function renderStatus(overrides: Parameters<typeof makeComposerBaseProps>[0] = {}) {
  const { container } = render(<Composer {...makeComposerBaseProps(overrides)} />);
  return container;
}

describe("Composer status row", () => {
  it("renders the busy label on its own row, outside the ellipsizing hint row", () => {
    const container = renderStatus({ busy: true, busyLabel: "Waiting for tool result…" });

    const statusRow = container.querySelector(".composer-busy-row");
    expect(statusRow?.textContent).toContain("Waiting for tool result…");
    // Own row: a direct child of the composer column, never nested in .hint-row.
    expect(statusRow?.parentElement?.className).toBe("composer-inner");
    expect(container.querySelector(".hint-row .composer-busy-label")).toBeNull();
    expect(container.querySelector(".hint-row .composer-busy-row")).toBeNull();
    expect(statusRow?.querySelector(".hint-row")).toBeNull();
    // The mode switch and key hints stay in the hint row.
    expect(statusRow?.querySelector(".mode-switch")).toBeNull();
    expect(container.querySelector(".hint-row .mode-switch")).toBeTruthy();
  });

  it("keeps the timer and stuck hint with the label, never in the hint row", () => {
    const container = renderStatus({
      busy: true,
      busyLabel: "Reasoning…",
      stuckLabel: {
        sinceMs: Date.now() - 120_000,
        render: (sec) => `Stuck: no response for ${sec}s`,
      },
    });

    const statusRow = container.querySelector(".composer-busy-row");
    expect(statusRow?.querySelector(".composer-busy-pip")).toBeTruthy();
    expect(statusRow?.querySelector(".composer-busy-time")).toBeTruthy();
    expect(statusRow?.querySelector(".composer-busy-stuck")?.textContent).toContain("Stuck:");
    expect(container.querySelector(".hint-row .composer-busy-stuck")).toBeNull();
  });

  it("flips the hint row to queue/interrupt together with the status row", () => {
    const busyHint =
      renderStatus({ busy: true, busyLabel: "Reasoning…" }).querySelector(".hint-row")
        ?.textContent ?? "";
    expect(busyHint).toContain("queue");
    expect(busyHint).toContain("stop");
    expect(busyHint).not.toContain("newline");

    const idleHint =
      renderStatus({ busy: false, busyLabel: "Reasoning…" }).querySelector(".hint-row")
        ?.textContent ?? "";
    expect(idleHint).toContain("send");
    expect(idleHint).toContain("newline");
    expect(idleHint).not.toContain("stop");
  });
});
