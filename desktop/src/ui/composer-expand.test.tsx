// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));

afterEach(cleanup);

function renderComposer(over: { expanded?: boolean } = {}) {
  const onToggleExpanded = vi.fn();
  const textareaRef = createRef<HTMLTextAreaElement>();
  const { container } = render(
    <Composer
      {...makeComposerBaseProps()}
      textareaRef={textareaRef}
      expanded={over.expanded ?? false}
      onToggleExpanded={onToggleExpanded}
    />,
  );
  return { container, onToggleExpanded, textareaRef };
}

function expandButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".composer-expand-btn");
}

describe("composer expand toggle", () => {
  it("puts the control outside the text box, in the card's right margin", () => {
    const { container } = renderComposer();
    const btn = expandButton(container);
    const card = container.querySelector(".composer");
    expect(btn).not.toBeNull();
    // A child of the card so it anchors to it, but not of the textarea.
    expect(btn!.parentElement).toBe(card);
    expect(card!.querySelector("textarea")!.contains(btn)).toBe(false);
  });

  it("reports a click and names what it will do", () => {
    const { container, onToggleExpanded } = renderComposer();
    const btn = expandButton(container)!;
    expect(btn.getAttribute("aria-label")).toBe("Expand composer to full height");
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btn);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the textarea so the expanded composer is ready to type", () => {
    const { container, textareaRef } = renderComposer();
    fireEvent.click(expandButton(container)!);
    expect(document.activeElement).toBe(textareaRef.current);
    expect(textareaRef.current).toBe(container.querySelector("textarea"));
  });

  it("reads as pressed and offers the way back once expanded", () => {
    const { container } = renderComposer({ expanded: true });
    const btn = expandButton(container)!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Restore the composer");
    expect(btn.getAttribute("data-on")).toBe("true");
  });

  it("renders no control when the surface does not offer the toggle", () => {
    const { container } = render(<Composer {...makeComposerBaseProps()} />);
    expect(expandButton(container)).toBeNull();
  });
});
