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
      <Composer {...makeComposerBaseProps({ supportedEfforts: ["low", "high"] })} />,
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
});
