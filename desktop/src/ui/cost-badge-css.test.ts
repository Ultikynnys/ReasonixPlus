import { describe, expect, it } from "vitest";
import { cssRule, cssRules } from "../../../tests/support/css.js";

/** Class-selector count: the weight that decides which rule wins when a shared box and
 *  its variant both target the same element. */
function classWeight(selector: string): number {
  return (selector.match(/\.[\w-]+/g) ?? []).length;
}

/** The contexts a badge can render in: a picker row, a composer pill and a Settings
 *  model row. */
const CONTEXTS = [
  { box: ".popup-item .badge", cost: ".popup-item .badge.cost" },
  { box: ".model-pill .badge", cost: ".model-pill .badge.cost" },
  { box: ".mcard .nm .badge", cost: ".mcard .nm .badge.cost" },
];

describe("cost badge CSS", () => {
  it("outweighs the shared flag box in every context it renders in", () => {
    for (const { box, cost } of CONTEXTS) {
      // Equal-or-lower weight would let the violet flag paint survive, which is
      // exactly what rendered a purple multiple.
      expect(classWeight(cost), cost).toBeGreaterThan(classWeight(box));
      expect(cssRules(box).length, `${box} must style the shared box`).toBeGreaterThan(0);
    }
  });

  it("tints from the theme's own success and danger colours", () => {
    const ramp = CONTEXTS.map(({ cost }) => cssRules(cost).join("\n")).join("\n");
    expect(ramp).toContain("--cost-tone");
    expect(ramp).toMatch(/color-mix\(in srgb, var\(--danger\)/);
    expect(ramp).toContain("var(--success)");
    expect(ramp).toContain("color: var(--cost-tone)");
    // The tint must never fall back to the flag's violet.
    expect(ramp).not.toMatch(/var\(--violet/);
  });

  it("keeps the multiple on the same line as the model name", () => {
    const row = cssRule(".popup-item .nm.model-row");
    // A block name cell wrapped the badge under a long id; a flex row truncates the
    // name and holds the flag beside it. Only the model row does this: a quick-send
    // row stacks its description under the command.
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/gap:/);
    expect(cssRule(".popup-item .nm.model-row .cmd")).toMatch(/text-overflow:\s*ellipsis/);
    // The flag itself must not shrink or wrap away.
    expect(cssRule(".popup-item .badge")).toMatch(/flex:\s*none/);
  });
});
