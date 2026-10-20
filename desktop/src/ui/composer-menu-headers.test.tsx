// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";

/** Every composer dropdown: model, subagent model, reasoning effort, quick send. */
const MENU_TRIGGERS = [".model-pill", ".subagent-pill", ".effort-pill", ".quick-proceed-btn"];

describe("Composer dropdown headers", () => {
  it("shows the menu label alone, with no glyph chip beside it", () => {
    const { container } = render(
      <Composer
        {...makeComposerBaseProps({ supportedEfforts: ["low", "high"], subagentsEnabled: true })}
      />,
    );

    for (const selector of MENU_TRIGGERS) {
      const trigger = container.querySelector<HTMLButtonElement>(selector);
      expect(trigger, selector).not.toBeNull();
      fireEvent.click(trigger!);

      const header = container.querySelector(".popup .ph");
      expect(header, selector).not.toBeNull();
      // Trigger tooltip and header label come from one i18n key, so this pins
      // both to the plain label in any language. Any child would be a chip.
      expect(header?.textContent, selector).toBe(trigger?.getAttribute("title"));
      expect(header?.children.length, selector).toBe(0);

      fireEvent.click(trigger!);
      expect(container.querySelector(".popup .ph"), selector).toBeNull();
    }
  });

  it("hides the subagent picker on a session minted without the subagent tool", () => {
    // The capability is frozen at chat creation, so the pill is absent rather than
    // disabled: a disabled picker would imply a switch the session cannot have.
    const { container } = render(<Composer {...makeComposerBaseProps()} />);
    expect(container.querySelector(".subagent-pill")).toBeNull();
    expect(container.querySelector(".model-pill:not(.subagent-pill)")).not.toBeNull();
  });

  it("drops the open subagent menu when the session loses the capability", () => {
    // A session switch can take the pill away mid-interaction; the click that
    // reopened a chat with the tool must not find the old popup already showing.
    const props = makeComposerBaseProps({ subagentsEnabled: true });
    const { container, rerender } = render(<Composer {...props} />);
    fireEvent.click(container.querySelector(".subagent-pill")!);
    expect(container.querySelector(".popup")).not.toBeNull();

    rerender(<Composer {...makeComposerBaseProps()} />);
    expect(container.querySelector(".subagent-pill")).toBeNull();
    rerender(<Composer {...props} />);
    expect(container.querySelector(".popup")).toBeNull();
  });
});
