import { describe, expect, it } from "vitest";
import { cssRules } from "../../../tests/support/css.js";

describe("model list CSS", () => {
  it("lets the browser skip off-screen model rows", () => {
    // A live catalog can list hundreds of ids while the box shows a handful, so the
    // rows past the fold must cost nothing to lay out. `auto` in both properties lets
    // the browser remember a rendered row's real size instead of trusting the guess.
    const bodies = cssRules(".provider-models-scroll > .mcard").join("\n");
    expect(bodies).toContain("content-visibility: auto");
    expect(bodies).toMatch(/contain-intrinsic-size:\s*auto\s+\d/);
  });
});
