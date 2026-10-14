// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PIN_THRESHOLD, useStickyBottom } from "./useStickyBottom";

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(performance.now());
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sticky = useStickyBottom(containerRef, {
    scrollToBottom: (smooth) => {
      const el = containerRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    },
  });

  return (
    <div>
      <div ref={containerRef} data-testid="container" style={{ height: 400, overflowY: "auto" }}>
        <div style={{ height: 1000 }} />
      </div>
      <button type="button" data-testid="follow" onClick={() => sticky.follow()}>
        Follow
      </button>
      <button type="button" data-testid="pin" onClick={() => sticky.pin(true)}>
        Pin
      </button>
    </div>
  );
}

/** Give the container a scroll geometry, then return a spy on its scrollTo. */
function sizeContainer(top: number, height = 400, content = 1000) {
  const container = screen.getByTestId("container");
  const scrollToSpy = vi.fn();
  container.scrollTo = scrollToSpy;
  Object.defineProperty(container, "scrollTop", { value: top, writable: true, configurable: true });
  Object.defineProperty(container, "clientHeight", {
    value: height,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(container, "scrollHeight", {
    value: content,
    writable: true,
    configurable: true,
  });
  return { container, scrollToSpy };
}

describe("useStickyBottom", () => {
  it("follows to the bottom while pinned and suppresses while dragging the scrollbar", () => {
    render(<Harness />);
    const { container, scrollToSpy } = sizeContainer(600);

    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });

    // Start a scrollbar drag; follow must not rubber-band the thumb.
    fireEvent.pointerDown(container);
    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);
  });

  it("un-pins on wheel-up and re-pins only after reaching the bottom", () => {
    render(<Harness />);
    const { container, scrollToSpy } = sizeContainer(600);

    fireEvent.wheel(container, { deltaY: -30 });
    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).not.toHaveBeenCalled();

    // Scroll down to within the threshold of the bottom: re-pins.
    Object.defineProperty(container, "scrollTop", {
      value: 1000 - 400 - (DEFAULT_PIN_THRESHOLD - 1),
      writable: true,
      configurable: true,
    });
    fireEvent.wheel(container, { deltaY: 30 });

    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
  });

  it("re-pins when the scrollbar drag ends at the bottom", () => {
    render(<Harness />);
    const { container, scrollToSpy } = sizeContainer(200);

    fireEvent.pointerDown(container);
    // Drag up to un-pin, then to the very bottom, then release.
    Object.defineProperty(container, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(container);
    Object.defineProperty(container, "scrollTop", {
      value: 600,
      writable: true,
      configurable: true,
    });
    fireEvent.scroll(container);
    fireEvent.pointerUp(window);

    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
  });

  it("pin(smooth) jumps to the bottom and re-enables following", () => {
    render(<Harness />);
    const { container, scrollToSpy } = sizeContainer(200);

    // Un-pin first so pin() has a visible effect.
    fireEvent.wheel(container, { deltaY: -100 });
    scrollToSpy.mockClear();

    fireEvent.click(screen.getByTestId("pin"));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("follow"));
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
  });

  it("notifies onPinChange as the pin state flips", () => {
    const onPinChange = vi.fn();
    function NotifyHarness() {
      const containerRef = useRef<HTMLDivElement>(null);
      useStickyBottom(containerRef, { onPinChange, scrollToBottom: () => {} });
      return <div ref={containerRef} data-testid="container" />;
    }
    render(<NotifyHarness />);
    const { container } = sizeContainer(600);

    fireEvent.wheel(container, { deltaY: -30 });
    expect(onPinChange).toHaveBeenLastCalledWith(false);

    Object.defineProperty(container, "scrollTop", {
      value: 600,
      writable: true,
      configurable: true,
    });
    fireEvent.wheel(container, { deltaY: 30 });
    expect(onPinChange).toHaveBeenLastCalledWith(true);
  });

  it("uses the provided threshold for the bottom test", () => {
    let isAtBottom: () => boolean = () => false;
    function ThresholdHarness() {
      const containerRef = useRef<HTMLDivElement>(null);
      const sticky = useStickyBottom(containerRef, { threshold: 300, scrollToBottom: () => {} });
      isAtBottom = sticky.isAtBottom;
      return <div ref={containerRef} data-testid="container" />;
    }
    render(<ThresholdHarness />);
    const { container } = sizeContainer(400); // 400 + 400 = 800 >= 1000 - 300 => bottom

    expect(isAtBottom()).toBe(true);
    Object.defineProperty(container, "scrollTop", { value: 0, writable: true, configurable: true });
    expect(isAtBottom()).toBe(false);
  });
});
