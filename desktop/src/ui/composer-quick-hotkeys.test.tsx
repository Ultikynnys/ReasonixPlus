// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";

// Ten rows so the ninth-row cap and the row beyond it are both observable.
const QUICK_SENDS = Array.from({ length: 10 }, (_, i) => ({
  id: `q${i + 1}`,
  shorthand: `action ${i + 1}`,
  message: `run action ${i + 1}`,
}));

// Shorter than the digit range, so the out-of-range branch is reachable.
const TWO_SENDS = QUICK_SENDS.slice(0, 2);

/** Ctrl+<key> against the window: the hotkeys are window-level on purpose, since
 *  the user is normally typing in the textarea when they fire them. */
function pressCtrl(key: string) {
  fireEvent.keyDown(window, { key, ctrlKey: true });
}

function openWithHotkey() {
  pressCtrl("q");
}

describe("Composer quick-send hotkeys", () => {
  it("opens the dropdown on Ctrl+Q without sending anything", () => {
    const onSend = vi.fn();
    render(<Composer {...makeComposerBaseProps({ onSend })} quickSends={QUICK_SENDS} />);

    expect(screen.queryByText("action 1")).toBeNull();
    openWithHotkey();

    expect(screen.getByText("action 1")).toBeTruthy();
    expect(screen.getByText("action 10")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("closes the dropdown on a second Ctrl+Q", () => {
    render(<Composer {...makeComposerBaseProps()} quickSends={QUICK_SENDS} />);

    openWithHotkey();
    expect(screen.queryByText("action 1")).toBeTruthy();
    pressCtrl("q");

    expect(screen.queryByText("action 1")).toBeNull();
  });

  it("sends the first row on Ctrl+1 and closes the dropdown", () => {
    const onSend = vi.fn();
    render(<Composer {...makeComposerBaseProps({ onSend })} quickSends={QUICK_SENDS} />);

    openWithHotkey();
    pressCtrl("1");

    expect(onSend).toHaveBeenCalledWith({ text: "run action 1" });
    expect(screen.queryByText("action 1")).toBeNull();
  });

  it("maps Ctrl+9 to the ninth row, ignoring the tenth", () => {
    const onSend = vi.fn();
    render(<Composer {...makeComposerBaseProps({ onSend })} quickSends={QUICK_SENDS} />);

    openWithHotkey();
    pressCtrl("9");

    expect(onSend).toHaveBeenCalledWith({ text: "run action 9" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("ignores Ctrl+0 and digits with no row behind them", () => {
    const onSend = vi.fn();
    render(<Composer {...makeComposerBaseProps({ onSend })} quickSends={TWO_SENDS} />);

    openWithHotkey();
    pressCtrl("0");
    pressCtrl("5");

    expect(onSend).not.toHaveBeenCalled();
    // The menu is a visible map of the digits, so it stays up for the retry.
    expect(screen.getByText("action 1")).toBeTruthy();
  });

  it("ignores digits while the dropdown is closed", () => {
    const onSend = vi.fn();
    render(<Composer {...makeComposerBaseProps({ onSend })} quickSends={QUICK_SENDS} />);

    pressCtrl("1");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("leaves the typed draft and the persisted default alone", () => {
    const onSend = vi.fn();
    const setDraft = vi.fn();
    const onPickQuickSend = vi.fn();
    render(
      <Composer
        {...makeComposerBaseProps({ onSend, setDraft, onPickQuickSend })}
        quickSends={QUICK_SENDS}
        draft="half-written thought"
      />,
    );

    openWithHotkey();
    pressCtrl("2");

    expect(onSend).toHaveBeenCalledWith({ text: "run action 2" });
    expect(setDraft).not.toHaveBeenCalled();
    expect(onPickQuickSend).not.toHaveBeenCalled();
  });

  it("stays mute for an inactive tab's composer", () => {
    const onSend = vi.fn();
    render(
      <Composer
        {...makeComposerBaseProps({ onSend })}
        quickSends={QUICK_SENDS}
        shortcutsActive={false}
      />,
    );

    openWithHotkey();

    expect(screen.queryByText("action 1")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not open while the composer is disabled", () => {
    render(<Composer {...makeComposerBaseProps()} quickSends={QUICK_SENDS} disabled />);

    openWithHotkey();

    expect(screen.queryByText("action 1")).toBeNull();
  });

  it("badges only the first nine rows with their digit", () => {
    render(<Composer {...makeComposerBaseProps()} quickSends={QUICK_SENDS} />);

    openWithHotkey();
    const row = (label: string) => screen.getByText(label).closest(".popup-item");
    const badge = (label: string) => row(label)?.querySelector(".kb")?.textContent;

    expect(badge("action 1")).toBe("1");
    expect(badge("action 9")).toBe("9");
    expect(badge("action 10")).toBeUndefined();
  });
});
