import { describe, expect, it } from "vitest";
import { cssRule, cssRules, stylesCss } from "./support/css.js";

/** Every rule in the sheet that sets an element's row height, with its body: the
 *  ones that participate in the shared `--scroll-rows` math. */
function rowHeightRules(): { selector: string; body: string }[] {
  const bare = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/^([^{}]+)\{([^}]*)\}/gm)].flatMap(([, selector, body]) =>
    (body ?? "").includes("--scroll-line")
      ? [{ selector: (selector ?? "").trim(), body: body ?? "" }]
      : [],
  );
}

// Every long card body (thinking, shell output, plan confirmation, subagent) is
// windowed to the same number of rows and scrolls itself. jsdom has no layout
// engine, so the contract is pinned on the real stylesheet: one shared rule owns
// the cap, and no card redeclares its own.
describe("desktop shared card row window", () => {
  it("caps the shared window at --scroll-rows rows of the box's line-height", () => {
    const rule = cssRule(".row-scroll");
    expect(rule).toContain("--scroll-rows: 6");
    expect(rule).toContain("max-height: calc(var(--scroll-rows) * var(--scroll-line) * 1em)");
  });

  it("derives the line-height from the same variable as the cap, so they cannot drift", () => {
    const rule = cssRule(".row-scroll");
    expect(rule).toContain("--scroll-line: 1.6");
    expect(rule).toContain("line-height: var(--scroll-line)");
  });

  it("scrolls the overflow instead of truncating it, with a pinned-tail friendly box", () => {
    const rule = cssRule(".row-scroll");
    expect(rule).toContain("overflow-y: auto");
    expect(rule).toContain("overscroll-behavior: contain");
    expect(rule).toContain("overflow-anchor: none");
    // Content-box keeps a card's padding outside the row cap.
    expect(rule).toContain("box-sizing: content-box");
  });

  it("leaves the thinking stream on the shared cap instead of its own pixel height", () => {
    const rule = cssRules(".reason .stream").join("\n");
    expect(rule).not.toContain("max-height");
    expect(rule).toContain("--scroll-line: 1.7");
  });

  it("leaves the shell stream on the shared cap instead of its own pixel height", () => {
    const rule = cssRules(".shell .stream").join("\n");
    expect(rule).not.toContain("max-height");
    expect(rule).not.toContain("line-height:");
  });

  it("gives an approval body the row cap and its line-height from one variable", () => {
    const rule = cssRule(".approval .ap-body");
    expect(rule).toContain("--scroll-line: 1.6");
    expect(rule).toContain("line-height: var(--scroll-line)");
  });

  it("keeps the auto-approve countdown on screen while a windowed body scrolls", () => {
    const rule = cssRule(".row-scroll .ap-timer");
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
  });

  // The guard that keeps the cap honest, and keeps itself current: whichever rule
  // sets a card's row height must take its line-height from the same variable the
  // cap multiplies. A literal line-height would silently show a different number
  // of rows than the rule claims.
  it("lets no card declare a line-height the cap does not follow", () => {
    const participants = rowHeightRules();
    expect(participants.map((p) => p.selector)).toEqual(
      expect.arrayContaining([".row-scroll", ".reason .stream", ".approval .ap-body"]),
    );
    for (const { selector, body } of participants) {
      for (const declaration of body.split(";")) {
        const trimmed = declaration.trim();
        if (!trimmed.startsWith("line-height:")) continue;
        expect(`${selector} ${trimmed}`).toBe(`${selector} line-height: var(--scroll-line)`);
      }
    }
  });
});
