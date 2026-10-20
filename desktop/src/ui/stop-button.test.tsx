// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopButton, usePendingStop } from "./stop-button";

afterEach(cleanup);

describe("StopButton", () => {
  it("shows the label and a stop icon when idle", () => {
    const { container } = render(
      <StopButton label="Close" title="Close it" iconSize={10} onClick={() => {}} />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Close");
    expect(btn.querySelector(".btn-throbber")).toBeNull();
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("swaps its content for a throbber and locks out clicks while busy", () => {
    const onClick = vi.fn();
    const { container } = render(
      <StopButton label="Close" title="Close it" iconSize={10} busy onClick={onClick} />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.querySelector(".btn-throbber")).toBeTruthy();
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("invokes onClick once when idle", () => {
    const onClick = vi.fn();
    const { container } = render(<StopButton label="Stop" title="Stop it" onClick={onClick} />);
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

function HookHarness({ done }: { done: boolean }) {
  const [pending, start] = usePendingStop(done);
  return (
    <button type="button" onClick={start} data-pending={pending}>
      go
    </button>
  );
}

describe("usePendingStop", () => {
  it("flips pending on start and clears the moment the stop completes", () => {
    const { container, rerender } = render(<HookHarness done={false} />);
    const btn = () => container.querySelector("button")!;
    expect(btn().dataset.pending).toBe("false");
    fireEvent.click(btn());
    expect(btn().dataset.pending).toBe("true");
    rerender(<HookHarness done={true} />);
    expect(btn().dataset.pending).toBe("false");
  });
});
