import { describe, expect, it } from "vitest";
import { cssRule } from "./support/css.js";

// A provider card's settings column is only half a card wide, so a description
// and a button sharing one row overflow it — the OpenCode "Sign in" button was
// clipped at the card edge. Any row with a button in that column must stack:
// description full width, controls on their own line below. jsdom has no layout
// engine, so pin the CSS contract the way the MCP-settings and composer layout
// tests do — deleting or un-stacking the rule fails here.
describe("desktop models settings layout", () => {
  const row = ".provider-col .setting-row:has(button)";

  it("stacks a description and a button so a button row never overflows the column", () => {
    expect(cssRule(row)).toContain("flex-direction: column");
    expect(cssRule(row)).toContain("align-items: stretch");
  });

  it("gives the description full width and drops the controls to their own line", () => {
    expect(cssRule(`${row} > .l`)).toContain("width: 100%");
    expect(cssRule(`${row} > :not(.l)`)).toContain("align-self: flex-start");
  });
});
