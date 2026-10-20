// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CardHead } from "./card-head";

afterEach(cleanup);

// The name slot ellipsises by default; `wrapName` is how a card opts out of that
// (approval cards put the whole ask_choice question there).
describe("CardHead name wrapping", () => {
  const headFor = (props: { wrapName?: boolean } = {}) =>
    render(
      <CardHead
        icon={null}
        kind="tool"
        name="A very long card name"
        open
        onToggle={() => {}}
        {...props}
      />,
    ).container.querySelector(".card-head");

  it("keeps the name on one line by default", () => {
    expect(headFor()?.hasAttribute("data-wrap")).toBe(false);
  });

  it("marks the head as wrapping when asked", () => {
    expect(headFor({ wrapName: true })?.getAttribute("data-wrap")).toBe("true");
  });
});
