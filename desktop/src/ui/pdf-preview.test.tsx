// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  const getPage = vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render }));
  const destroy = vi.fn(async () => {});
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ numPages: 2, getPage }), destroy }));
  return { render, getPage, getDocument, destroy };
});
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument: mocks.getDocument }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf-worker.mjs" }));
import { PdfPreview } from "./pdf-preview";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("PdfPreview", () => {
  it("renders pages, navigates, zooms and destroys the worker on unmount", async () => {
    const view = render(<PdfPreview src="http://asset.localhost/report.pdf" name="report.pdf" />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalled());
    expect(mocks.getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: "http://asset.localhost/report.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(mocks.getPage).toHaveBeenCalledWith(2));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(view.container.querySelector("canvas")?.style.width).toBe("750px"));
    expect(view.container.querySelector("iframe")).toBeNull();
    view.unmount();
    expect(mocks.destroy).toHaveBeenCalled();
  });
  it("reports document loading failures", async () => {
    mocks.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("bad PDF")), destroy: mocks.destroy }));
    render(<PdfPreview src="missing.pdf" name="missing.pdf" />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Preview could not be loaded"));
  });
});
