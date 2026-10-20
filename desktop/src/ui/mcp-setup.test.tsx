// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpSetupDialog } from "./mcp-setup";

afterEach(cleanup);

const servers = [
  { name: "playwright", enabled: true, builtin: true },
  { name: "blender", enabled: false, builtin: false },
];

function renderDialog({
  list = servers,
  subagents = false,
}: { list?: typeof servers; subagents?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <McpSetupDialog
      servers={list}
      subagents={subagents}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("McpSetupDialog", () => {
  it("invokes onCancel from the top-right X", () => {
    const { onCancel } = renderDialog();
    fireEvent.click(screen.getByLabelText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("starts from the Settings defaults and reports the enabled set on confirm", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByText("Confirm and start"));
    expect(onConfirm).toHaveBeenCalledWith(["playwright"], false);
  });

  it("adds a toggled server to the confirmed set", () => {
    const { onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("switch", { name: "blender" }));
    fireEvent.click(screen.getByText("Confirm and start"));
    const [enabled, subagents] = onConfirm.mock.calls[0] as [string[], boolean];
    expect([...enabled].sort()).toEqual(["blender", "playwright"]);
    expect(subagents).toBe(false);
  });

  it("pre-fills the subagent switch from the session default", () => {
    const { onConfirm } = renderDialog({ subagents: true });
    const toggle = screen.getByRole("switch", { name: "Subagents" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByText("Confirm and start"));
    expect(onConfirm).toHaveBeenCalledWith(["playwright"], true);
  });

  it("reports the subagent choice independently of the server set", () => {
    const { onConfirm } = renderDialog({ subagents: false });
    fireEvent.click(screen.getByRole("switch", { name: "Subagents" }));
    fireEvent.click(screen.getByText("Confirm and start"));
    const [enabled, subagents] = onConfirm.mock.calls[0] as [string[], boolean];
    expect(enabled).toEqual(["playwright"]);
    expect(subagents).toBe(true);
  });

  it("still offers the subagent switch when no MCP server is configured", () => {
    const { onConfirm } = renderDialog({ list: [], subagents: false });
    expect(screen.getByText(/None configured/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Subagents" }));
    fireEvent.click(screen.getByText("Confirm and start"));
    expect(onConfirm).toHaveBeenCalledWith([], true);
  });

  it("greys out the confirm button and throbs while the session starts", () => {
    const { onConfirm } = renderDialog();
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
    const { onConfirm } = renderDialog();
    const confirm = screen.getByRole("button", { name: /Confirm and start/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
