// @vitest-environment jsdom

import { type ChangelogRelease, groupReleases } from "@reasonix/core-utils";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChangelogState, PageChangelog } from "./changelog";

afterEach(cleanup);

const RELEASES: ChangelogRelease[] = groupReleases([
  { sha: "aaa1111", subject: "fix(desktop): center image zoom", date: "2026-01-05T00:00:00Z" },
  { sha: "bbb2222", subject: "chore(release): v1.0.27", date: "2026-01-04T00:00:00Z" },
  { sha: "ccc3333", subject: "feat(chat): add inline audio", date: "2026-01-03T00:00:00Z" },
  { sha: "ddd4444", subject: "chore: bump a dependency", date: "2026-01-02T00:00:00Z" },
]);

function state(over: Partial<ChangelogState> = {}): ChangelogState {
  return { releases: RELEASES, version: "1.0.27", error: null, loaded: true, ...over };
}

describe("PageChangelog", () => {
  it("fetches once on mount and not again on re-render", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
    expect(onRefresh).not.toHaveBeenCalled();

    rerender(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("fetches when nothing has loaded yet", () => {
    const onRefresh = vi.fn();
    render(<PageChangelog changelog={state({ loaded: false })} onRefresh={onRefresh} />);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Loading changelog…")).toBeTruthy();
  });

  it("groups commits under their release version, newest first", () => {
    render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);

    expect(screen.getByText("Unreleased")).toBeTruthy();
    expect(screen.getByText("v1.0.27")).toBeTruthy();
    expect(screen.getByText("center image zoom")).toBeTruthy();
    expect(screen.getByText("add inline audio")).toBeTruthy();
  });

  it("marks the installed version", () => {
    render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
    expect(screen.getAllByText("installed")).toHaveLength(1);
  });

  it("renders maintenance commits without a toggle", () => {
    render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("bump a dependency")).toBeTruthy();
    expect(screen.getByText("Maintenance")).toBeTruthy();
  });

  it("never renders a release marker as a change", () => {
    const { container } = render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
    expect(container.textContent).not.toContain("chore(release)");
  });

  it("collapses and expands a release on click", () => {
    render(<PageChangelog changelog={state()} onRefresh={vi.fn()} />);
    expect(screen.getByText("add inline audio")).toBeTruthy();

    fireEvent.click(screen.getByText("v1.0.27"));
    expect(screen.queryByText("add inline audio")).toBeNull();

    fireEvent.click(screen.getByText("v1.0.27"));
    expect(screen.getByText("add inline audio")).toBeTruthy();
  });

  it("forces a refetch from the refresh button", () => {
    const onRefresh = vi.fn();
    render(<PageChangelog changelog={state()} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledWith(true);
  });

  it("shows the failure and a retry when nothing could be loaded", () => {
    const onRefresh = vi.fn();
    render(
      <PageChangelog
        changelog={state({ releases: [], error: "Network unreachable", loaded: true })}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText(/Couldn't load the changelog: Network unreachable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledWith(true);
  });

  it("flags a stale cached copy while still showing its releases", () => {
    render(<PageChangelog changelog={state({ error: "offline" })} onRefresh={vi.fn()} />);
    expect(screen.getByText("Showing a cached copy")).toBeTruthy();
    expect(screen.getByText("center image zoom")).toBeTruthy();
  });
});