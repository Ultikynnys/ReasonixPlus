// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FitText, fitFontSize } from "./fit-text";

afterEach(cleanup);

describe("fitFontSize", () => {
  it("keeps the base size when the text already fits", () => {
    expect(fitFontSize({ available: 200, natural: 120, base: 14, min: 9 })).toBe(14);
    expect(fitFontSize({ available: 120, natural: 120, base: 14, min: 9 })).toBe(14);
  });

  it("scales down in proportion to the overflow", () => {
    expect(fitFontSize({ available: 300, natural: 420, base: 14, min: 9 })).toBe(10);
  });

  it("never goes below the floor, where the box's own ellipsis takes over", () => {
    expect(fitFontSize({ available: 60, natural: 600, base: 14, min: 9 })).toBe(9);
  });

  it("keeps the base size without layout metrics (jsdom, a hidden panel)", () => {
    expect(fitFontSize({ available: 0, natural: 0, base: 14, min: 9 })).toBe(14);
    expect(fitFontSize({ available: 0, natural: 400, base: 14, min: 9 })).toBe(14);
  });
});

describe("FitText", () => {
  it("renders the whole label and offers it as the hover title", () => {
    const { container } = render(<FitText text="DS · deepseek-v4-flash" />);
    const span = container.querySelector("span")!;

    expect(span.textContent).toBe("DS · deepseek-v4-flash");
    expect(span.title).toBe("DS · deepseek-v4-flash");
  });

  it("honours a caller's own title and class without layout", () => {
    const { container } = render(
      <FitText text="OC · big-pickle" title="OpenCode model" className="pill-label" />,
    );
    const span = container.querySelector("span")!;

    expect(span.title).toBe("OpenCode model");
    expect(span.className).toBe("pill-label");
    // No layout in jsdom: the text must still render at the fallback size.
    expect(span.textContent).toBe("OC · big-pickle");
  });
});
