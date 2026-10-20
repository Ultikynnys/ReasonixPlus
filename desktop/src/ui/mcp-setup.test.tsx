// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSetupDialog } from "./mcp-setup";

afterEach(cleanup);

const servers = [
  { name: "playwright", enabled: true, builtin: true },
  { name: "blender", enabled: false, builtin: false },
];

describe("McpSetupDialog", () => {
  it("invokes onCancel from the top-right X", () => {
    const onCancel = vi.fn();
    render(<McpSetupDialog servers={servers} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("starts from the Settings defaults and reports the enabled set on confirm", () => {
    const onConfirm = vi.fn();
    render(<McpSetupDialog servers={servers} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Confirm and start"));
    expect(onConfirm).toHaveBeenCalledWith(["playwright"]);
  });

  it("adds a toggled server to the confirmed set", () => {
    const onConfirm = vi.fn();
    render(<McpSetupDialog servers={servers} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: "blender" }));
    fireEvent.click(screen.getByText("Confirm and start"));
    const enabled = onConfirm.mock.calls[0]?.[0] as string[];
    expect([...enabled].sort()).toEqual(["blender", "playwright"]);
  });

  it("greys out the confirm button and throbs while the session starts", () => {
    const onConfirm = vi.fn();
    render(<McpSetupDialog servers={servers} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const confirm = screen.getByRole("button", { name: /Confirm and start/ });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(confirm.querySelector(".btn-throbber")).toBeNull();

    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.querySelector(".spin.btn-throbber")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Starting session" })).toBeTruthy();
  });

  it("ignores extra confirm clicks while the session is starting", () => {
    const onConfirm = vi.fn();
    render(<McpSetupDialog servers={servers} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const confirm = screen.getByRole("button", { name: /Confirm and start/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
