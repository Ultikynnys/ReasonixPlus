// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ZoomableImage } from "./image-preview";
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
describe("ZoomableImage", () => {
  it("opens, zooms, resets and closes with focus restoration", () => {
    render(<ZoomableImage src="chart.png" alt="chart.png" />);
    const trigger = screen.getByRole("button", { name: "View image: chart.png" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.src).toContain("chart.png");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("dismisses on the native Escape cancel event", () => {
    render(<ZoomableImage src="chart.png" />);
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("retains thumbnail error handling and reports full image errors", () => {
    const onError = vi.fn();
    const view = render(<ZoomableImage src="missing.png" onError={onError} />);
    fireEvent.error(view.container.querySelector("img")!);
    expect(onError).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View image" }));
    fireEvent.error(screen.getByRole("dialog").querySelector("img")!);
    expect(screen.getByRole("alert").textContent).toContain("Image could not be loaded");
  });
});
