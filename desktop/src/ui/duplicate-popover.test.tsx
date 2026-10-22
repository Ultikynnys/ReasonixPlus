// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MainHead } from "../App";

const rows = [
  { name: "alpha", enabled: true, builtin: false },
  { name: "beta", enabled: false, builtin: false },
];

/** The popover's own Duplicate button — the header trigger carries the same label. */
function confirmButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Duplicate" });
  return buttons[buttons.length - 1]!;
}

describe("duplicate popover", () => {
  afterEach(cleanup);

  function open({
    capabilityRows = rows,
    subagents = false,
  }: { capabilityRows?: typeof rows; subagents?: boolean } = {}) {
    const onDuplicate = vi.fn();
    render(
      <MainHead
        session="desktop-1"
        model="deepseek-flash"
        capabilityRows={capabilityRows}
        subagents={subagents}
        busy={false}
        hasMessages
        onExport={() => {}}
        onDuplicate={onDuplicate}
        onOpenWorkdir={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("Duplicate session"));
    return onDuplicate;
  }

  it("asks for capabilities instead of models", () => {
    open();
    expect(screen.getByRole("switch", { name: "Subagents" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "beta" })).toBeTruthy();
    expect(screen.queryByLabelText("Main model")).toBeNull();
    expect(screen.queryByLabelText("Sub agent model")).toBeNull();
  });

  it("pre-fills the toggles from the source chat's own set", () => {
    open({ subagents: true });
    expect(screen.getByRole("switch", { name: "alpha" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "beta" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Subagents" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("reports the chosen server set and subagent flag", () => {
    const onDuplicate = open();
    fireEvent.click(screen.getByRole("switch", { name: "beta" }));
    fireEvent.click(screen.getByRole("switch", { name: "Subagents" }));
    fireEvent.click(confirmButton());
    const [enabled, subagents] = onDuplicate.mock.calls[0] as [string[], boolean];
    expect([...enabled].sort()).toEqual(["alpha", "beta"]);
    expect(subagents).toBe(true);
  });

  it("still duplicates when every server is switched off", () => {
    const onDuplicate = open();
    fireEvent.click(screen.getByRole("switch", { name: "alpha" }));
    fireEvent.click(confirmButton());
    expect(onDuplicate).toHaveBeenCalledWith([], false);
  });

  it("says so plainly when no MCP server is configured", () => {
    open({ capabilityRows: [] });
    expect(screen.getByText(/No MCP servers configured/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Subagents" })).toBeTruthy();
  });
});
