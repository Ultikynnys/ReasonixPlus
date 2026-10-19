import { describe, expect, it } from "vitest";
import { areWorkspacesLoaded, isWorkspaceRevealReady } from "../desktop/src/workspace-loading";

describe("desktop workspace loading lifecycle", () => {
  it("waits for every workspace UI to acknowledge initialization", () => {
    const expected = new Set(["tab-a", "tab-b"]);

    expect(areWorkspacesLoaded(expected, new Set())).toBe(false);
    expect(areWorkspacesLoaded(expected, new Set(["tab-a"]))).toBe(false);
    expect(areWorkspacesLoaded(expected, new Set(["tab-a", "tab-b"]))).toBe(true);
  });

  it("does not complete before the tabs snapshot defines the expected workspaces", () => {
    expect(areWorkspacesLoaded(null, new Set(["tab-a"]))).toBe(false);
  });

  it("allows an empty authoritative workspace snapshot to complete", () => {
    expect(areWorkspacesLoaded(new Set(), new Set())).toBe(true);
  });

  it("reveals the shell as soon as the focused tab acknowledges", () => {
    const expected = new Set(["tab-a", "tab-b", "tab-c"]);
    const initialized = new Set(["tab-b", "tab-c"]);

    expect(isWorkspaceRevealReady(expected, initialized, "tab-b")).toBe(true);
    expect(isWorkspaceRevealReady(expected, initialized, "tab-c")).toBe(true);
    expect(isWorkspaceRevealReady(expected, initialized, "tab-a")).toBe(false);
  });

  it("keeps waiting for every tab when no focused tab is known", () => {
    const expected = new Set(["tab-a", "tab-b"]);

    expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), null)).toBe(false);
    expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), "")).toBe(false);
    expect(isWorkspaceRevealReady(expected, new Set(["tab-a", "tab-b"]), null)).toBe(true);
  });

  it("ignores a focused id the snapshot does not describe", () => {
    const expected = new Set(["tab-a"]);

    expect(isWorkspaceRevealReady(expected, new Set(), "gone-tab")).toBe(false);
    expect(isWorkspaceRevealReady(expected, new Set(["tab-a"]), "gone-tab")).toBe(true);
  });

  it("never reveals before the tabs snapshot defines the expected workspaces", () => {
    expect(isWorkspaceRevealReady(null, new Set(["tab-a"]), "tab-a")).toBe(false);
  });
});
