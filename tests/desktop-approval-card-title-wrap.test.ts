import { describe, expect, it } from "vitest";
import { cssRule, cssRules } from "./support/css.js";

// The ask_choice card puts the agent's whole question in the shared `.card-head`
// name slot, where it used to ellipsis-truncate to a single line and hide the
// question. Wrapping is opt-in per heading (`data-wrap`), so the compact tool and
// thinking rows keep their one-line name.
describe("desktop card heading name slot", () => {
  it("wraps a heading that opts in instead of truncating it", () => {
    const name = cssRules('.card-head[data-wrap="true"] .name').join("\n");
    expect(name).toContain("white-space: normal");
    expect(name).toContain("overflow-wrap: anywhere");
  });

  it("top-aligns a wrapped heading so the icon stays beside the first line", () => {
    expect(cssRule('.card-head[data-wrap="true"] .card-head-top')).toContain(
      "align-items: flex-start",
    );
  });

  it("leaves every other heading on a single ellipsised line", () => {
    const name = cssRule(".card-head .name");
    expect(name).toContain("white-space: nowrap");
    expect(name).toContain("text-overflow: ellipsis");
  });
});

// A plan-confirmation summary used to ride the title row as a nowrap chip: it
// clipped at the card edge and squeezed the title to nothing. Prose now owns a
// wrapping row of its own, and only a short chip stays on the title row.
describe("desktop card heading prose row", () => {
  it("wraps prose on its own row instead of clipping it", () => {
    const sub = cssRules(".card-head .sub").join("\n");
    expect(sub).toContain("white-space: normal");
    expect(sub).toContain("overflow-wrap: anywhere");
    expect(sub).toContain("min-width: 0");
  });

  it("indents the prose row from the head's icon tokens, not a copy of their width", () => {
    expect(cssRules(".card-head .sub").join("\n")).toContain(
      "padding-left: calc(var(--head-icon) + var(--head-gap))",
    );
    expect(cssRule(".card-head .ico")).toContain("width: var(--head-icon)");
    expect(cssRule(".card-head-top")).toContain("gap: var(--head-gap)");
  });

  it("keeps a long chip from pushing the title and chevron off the card", () => {
    const meta = cssRule(".card-head .meta");
    expect(meta).toContain("min-width: 0");
    expect(meta).not.toContain("flex-shrink: 0");
  });
});
