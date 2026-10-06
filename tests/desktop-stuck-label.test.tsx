// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StuckLabel } from "../desktop/src/ui/live";

afterEach(cleanup);

describe("StuckLabel", () => {
  it("shows nothing while the turn is quiet below the threshold, then appears without re-rendering its parent every tick", () => {
    vi.useFakeTimers();
    const base = Date.now();
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(base);
    const parentRender = vi.fn();
    function Conversation() {
      parentRender();
      const [busy, setBusy] = useState(true);
      return (
        <>
          <StuckLabel
            active={busy}
            sinceMs={base}
            afterSec={30}
            render={(sec) => <span>stuck {sec}s</span>}
          />
          <button type="button" onClick={() => setBusy(false)}>
            stop
          </button>
        </>
      );
    }
    render(<Conversation />);
    expect(screen.queryByText(/stuck/)).toBeNull();
    expect(parentRender).toHaveBeenCalledTimes(1);

    // 29 quiet seconds: still hidden, parent never re-rendered.
    dateSpy.mockReturnValue(base + 29_000);
    act(() => vi.advanceTimersByTime(29_000));
    expect(screen.queryByText(/stuck/)).toBeNull();
    expect(parentRender).toHaveBeenCalledTimes(1);

    // Crossing 30s flips the label once; further ticks mutate the seconds
    // without any additional parent render.
    dateSpy.mockReturnValue(base + 31_000);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText(/stuck 31s/)).toBeTruthy();
    const rendersAfterShow = parentRender.mock.calls.length;
    dateSpy.mockReturnValue(base + 35_000);
    act(() => vi.advanceTimersByTime(4_000));
    expect(parentRender.mock.calls.length).toBe(rendersAfterShow);

    // Turn end hides the label.
    act(() => {
      fireEvent.click(screen.getByText("stop"));
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.queryByText(/stuck/)).toBeNull();
    dateSpy.mockRestore();
    vi.useRealTimers();
  });
});
