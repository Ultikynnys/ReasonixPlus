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

// The title and its `sub` prose must never share one row: a long summary takes a
// full-width row below (styled by `.card-head .sub`) instead of squeezing the
// title slot to nothing. A short `meta` chip stays on the title line.
describe("CardHead sub row", () => {
  const headFor = (sub?: string) =>
    render(
      <CardHead icon={null} kind="plan" name="Start plan" sub={sub} open onToggle={() => {}} />,
    ).container.querySelector(".card-head");

  it("renders no sub row when there is nothing to say", () => {
    expect(headFor()?.querySelector(".sub")).toBeNull();
  });

  it("keeps the sub outside the title line so it wraps on its own", () => {
    const sub = headFor("Bound the frontend at ten workspaces")?.querySelector(".sub");
    expect(sub?.textContent).toBe("Bound the frontend at ten workspaces");
    expect(sub?.closest(".card-head-top")).toBeNull();
  });

  it("keeps a chip on the title line while the prose drops below it", () => {
    const head = render(
      <CardHead
        icon={null}
        kind="plan"
        name="Start plan"
        meta="2 options"
        sub="A plan summary"
        open
        onToggle={() => {}}
      />,
    ).container.querySelector(".card-head");
    expect(head?.querySelector(".card-head-top .meta")?.textContent).toBe("2 options");
    expect(head?.querySelector(".card-head-top .sub")).toBeNull();
    expect(head?.querySelector(".sub")?.textContent).toBe("A plan summary");
  });
});
