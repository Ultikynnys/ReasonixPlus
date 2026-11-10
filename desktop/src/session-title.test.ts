import { describe, expect, it } from "vitest";
import { SESSION_TITLE_MAX, sessionTitle } from "./session-title";

describe("sessionTitle", () => {
  it("collapses whitespace so a pasted title cannot arrive one line per word", () => {
    expect(sessionTitle("  Quarterly\tplan\nfor the  audit  ")).toBe(
      "Quarterly plan for the audit",
    );
  });

  it("caps at the daemon's limit", () => {
    expect(sessionTitle("x".repeat(SESSION_TITLE_MAX + 40))).toHaveLength(SESSION_TITLE_MAX);
  });

  it("returns an empty string for a title that is only whitespace", () => {
    expect(sessionTitle("   \n\t ")).toBe("");
  });
});
