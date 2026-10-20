import { describe, expect, it } from "vitest";
import { cssRule } from "./support/css.js";

// The ask_choice card puts the agent's whole question in the shared `.card-head`
// name slot, where it used to ellipsis-truncate to a single line and hide the
// question. Wrapping is opt-in per heading (`data-wrap`), so the compact tool and
// thinking rows keep their one-line name.
describe("desktop card heading name slot", () => {
  it("wraps a heading that opts in instead of truncating it", () => {
    const name = cssRule('.card-head[data-wrap="true"] .name');
    expect(name).toContain("white-space: normal");
    expect(name).toContain("overflow-wrap: anywhere");
  });

  it("top-aligns a wrapped heading so the icon stays beside the first line", () => {
    expect(cssRule('.card-head[data-wrap="true"]')).toContain("align-items: flex-start");
  });

  it("leaves every other heading on a single ellipsised line", () => {
    const name = cssRule(".card-head .name");
    expect(name).toContain("white-space: nowrap");
    expect(name).toContain("text-overflow: ellipsis");
  });
});
