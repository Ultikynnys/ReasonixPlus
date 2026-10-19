import { describe, expect, it } from "vitest";
import { shouldDeferRestoredBuild } from "../src/cli/commands/desktop.js";

describe("restored channel toolset deferral", () => {
  it("defers a restored channel the user is not looking at", () => {
    expect(shouldDeferRestoredBuild({ restored: true, focused: false })).toBe(true);
    expect(shouldDeferRestoredBuild({ restored: true, focused: false, active: false })).toBe(true);
  });

  it("builds the focused channel now", () => {
    expect(shouldDeferRestoredBuild({ restored: true, focused: true })).toBe(false);
  });

  it("builds the channel the previous run had active", () => {
    expect(shouldDeferRestoredBuild({ restored: true, focused: false, active: true })).toBe(false);
  });

  it("never defers a fresh tab, which has nothing to restore", () => {
    expect(shouldDeferRestoredBuild({ restored: false, focused: false })).toBe(false);
  });

  it("builds a channel holding an MCP setup picker, which lists servers", () => {
    expect(
      shouldDeferRestoredBuild({ restored: true, focused: false, mcpSetupPending: true }),
    ).toBe(false);
  });
});
