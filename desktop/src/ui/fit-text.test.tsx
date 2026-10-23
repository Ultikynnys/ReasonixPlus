// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitText } from "./fit-text";

interface Box {
  available: number;
  natural: number;
}

/** jsdom reports no layout, so a fit measures nothing and logs nothing. These stubs
 *  supply metrics and record the order of every style read and layout read: the
 *  regression was one label's layout read per label, which re-laid the whole list
 *  out on each row. */
function stubLayout(log: string[], box: Box = { available: 100, natural: 400 }): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      log.push("layout");
      return box.available;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      log.push("layout");
      return box.natural;
    },
  });
  const original = globalThis.getComputedStyle;
  vi.stubGlobal("getComputedStyle", (el: Element) => {
    log.push("style");
    return original.call(globalThis, el);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
});

describe("FitText batching", () => {
  it("measures a whole list in one read pass instead of one layout per label", async () => {
    const log: string[] = [];
    stubLayout(log);
    const ids = Array.from({ length: 200 }, (_, index) => `openai/gpt-4o-mini-${index}`);
    render(
      <div>
        {ids.map((id) => (
          <FitText key={id} text={id} className="model-name" />
        ))}
      </div>,
    );
    await act(async () => {});

    // Every base size is read before the first layout read: one layout answers all
    // 200 labels, where the old per-label fit laid the list out 200 times.
    expect(log.filter((entry) => entry === "style")).toHaveLength(ids.length);
    expect(log.indexOf("layout")).toBe(ids.length);
  });

  it("shrinks an overflowing label to its floor", async () => {
    stubLayout([]);
    const { container } = render(<FitText text="a-very-long-model-id" minSize={7} />);
    await act(async () => {});

    expect(container.querySelector("span")?.style.fontSize).toBe("7px");
  });

  it("leaves a fitting label at its stylesheet size", async () => {
    stubLayout([], { available: 400, natural: 120 });
    const { container } = render(<FitText text="gpt-4o" />);
    await act(async () => {});

    // No inline size: the stylesheet (and any container query) keeps deciding.
    expect(container.querySelector("span")?.style.fontSize).toBe("");
  });

  it("keeps a deferred label unmeasured until it scrolls into view", async () => {
    const log: string[] = [];
    stubLayout(log);
    const callbacks: IntersectionObserverCallback[] = [];
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver as never);

    const { container } = render(
      <FitText text="a-very-long-model-id" minSize={7} deferUntilVisible />,
    );
    await act(async () => {});
    // Measuring a row the browser is skipping would lay it out, so nothing is read.
    expect(log).toHaveLength(0);
    expect(container.querySelector("span")?.style.fontSize).toBe("");

    await act(async () => {
      callbacks.at(-1)?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as never);
    });
    expect(container.querySelector("span")?.style.fontSize).toBe("7px");
  });
});
