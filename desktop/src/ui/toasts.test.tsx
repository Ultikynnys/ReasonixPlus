// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NoticeSeverity, noticeTone } from "./cards";
import {
  TOAST_LIMIT,
  TOAST_TTL_MS,
  type ToastNotice,
  ToastStack,
  dismissToast,
  pushToast,
} from "./toasts";

afterEach(cleanup);

function toast(id: number, text: string, severity: ToastNotice["severity"] = "error") {
  return { id, text, severity };
}

describe("toast list", () => {
  it("appends in order and keeps the severity", () => {
    const list = pushToast(pushToast([], "first", "error"), "second", "success");
    expect(list.map((entry) => [entry.text, entry.severity])).toEqual([
      ["first", "error"],
      ["second", "success"],
    ]);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(2);
  });

  it("replaces an identical toast instead of stacking a repeat", () => {
    const once = pushToast([], "install failed", "error");
    const twice = pushToast(once, "install failed", "error");
    expect(twice).toHaveLength(1);
    expect(twice[0]?.id).not.toBe(once[0]?.id);
  });

  it("keeps the same text of another severity apart", () => {
    const list = pushToast(pushToast([], "note", "warning"), "note", "error");
    expect(list).toHaveLength(2);
  });

  it("drops the oldest past the stack cap", () => {
    let list: readonly ToastNotice[] = [];
    for (let i = 0; i < TOAST_LIMIT + 2; i += 1) list = pushToast(list, `t${i}`, "info");
    expect(list.map((entry) => entry.text)).toEqual(
      Array.from({ length: TOAST_LIMIT }, (_, i) => `t${i + 2}`),
    );
  });

  it("hands back the same list for an empty message, so nothing re-renders", () => {
    const list = pushToast([], "kept", "error");
    expect(pushToast(list, "   ", "error")).toBe(list);
  });

  it("dismisses one toast by id, and is a no-op for an id already gone", () => {
    const list = [toast(1, "a"), toast(2, "b")];
    expect(dismissToast(list, 2).map((entry) => entry.id)).toEqual([1]);
    const kept = dismissToast(list, 99);
    expect(kept).toBe(list);
  });
});

describe("ToastStack", () => {
  it("renders every toast as a popover with the tone its severity paints", () => {
    render(
      <ToastStack
        toasts={[toast(1, "install failed", "error"), toast(2, "installed", "success")]}
        onDismiss={() => {}}
      />,
    );
    expect(document.querySelector(".toast-stack")).not.toBeNull();
    expect(screen.getByText("install failed")).toBeTruthy();
    expect(screen.getByText("installed")).toBeTruthy();
    const tones = Array.from(document.querySelectorAll(".toast")).map((node) =>
      node.getAttribute("data-tone"),
    );
    const severities: NoticeSeverity[] = ["error", "success"];
    expect(tones).toEqual(severities.map(noticeTone));
  });

  it("announces a failure, not a routine outcome", () => {
    render(
      <ToastStack
        toasts={[toast(1, "install failed", "error"), toast(2, "installed", "success")]}
        onDismiss={() => {}}
      />,
    );
    const roles = Array.from(document.querySelectorAll(".toast")).map((node) =>
      node.getAttribute("role"),
    );
    expect(roles).toEqual(["alert", "status"]);
  });

  it("renders nothing while there is nothing to say", () => {
    const { container } = render(<ToastStack toasts={[]} onDismiss={() => {}} />);
    expect(container.querySelector(".toast-stack")).toBeNull();
  });

  it("dismisses on the close button", () => {
    const onDismiss = vi.fn();
    render(<ToastStack toasts={[toast(7, "install failed")]} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledWith(7);
  });

  it("dismisses itself after its time on screen", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<ToastStack toasts={[toast(9, "install failed")]} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(TOAST_TTL_MS - 1);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledWith(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restart its timer when the parent re-renders", () => {
    vi.useFakeTimers();
    try {
      const late = vi.fn();
      const { rerender } = render(
        <ToastStack toasts={[toast(3, "install failed")]} onDismiss={() => {}} />,
      );
      vi.advanceTimersByTime(TOAST_TTL_MS / 2);
      rerender(<ToastStack toasts={[toast(3, "install failed")]} onDismiss={late} />);
      vi.advanceTimersByTime(TOAST_TTL_MS / 2);
      expect(late).toHaveBeenCalledWith(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
