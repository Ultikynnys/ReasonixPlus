// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

import { Composer } from "./composer";

const baseProps = {
  draft: "",
  setDraft: vi.fn(),
  onSend: vi.fn(),
  onAbort: vi.fn(),
  modelLabel: "big-pickle",
  reasoningEffort: "medium",
  onModelChange: vi.fn(),
  onEffortChange: vi.fn(),
  editMode: "follow",
  onEditModeChange: vi.fn(),
  onVoiceError: vi.fn(),
  textareaRef: { current: null },
} as const;

function menuLabels(): string[] {
  const menu = document.querySelector(".effort-menu-list");
  if (!menu) return [];
  return Array.from(menu.querySelectorAll(".popup-item")).map(
    (item) => item.querySelector(".cmd")?.textContent ?? "",
  );
}

describe("Composer reasoning-effort menu", () => {
  it("offers only the model's supported levels and shows the clamped value", () => {
    render(<Composer {...baseProps} supportedEfforts={["low", "high", "max"]} />);

    const pill = screen.getByTitle("Switch reasoning effort");
    // "medium" is unsupported -> clamps to the higher neighbour, "high".
    expect(pill.textContent).toContain("high");

    fireEvent.click(pill);
    expect(menuLabels()).toEqual(["low", "high", "max"]);
  });

  it("disables the pill when the model has no effort control", () => {
    render(<Composer {...baseProps} supportedEfforts={[]} />);
    const pill = screen.getByTitle("Switch reasoning effort");
    expect(pill.hasAttribute("disabled")).toBe(true);
  });

  it("calls onEffortChange with the picked level", () => {
    const onEffortChange = vi.fn();
    render(
      <Composer
        {...baseProps}
        reasoningEffort="low"
        supportedEfforts={["low", "high"]}
        onEffortChange={onEffortChange}
      />,
    );

    fireEvent.click(screen.getByTitle("Switch reasoning effort"));
    const menu = document.querySelector(".effort-menu-list")!;
    const high = Array.from(menu.querySelectorAll(".popup-item")).find(
      (item) => item.querySelector(".cmd")?.textContent === "high",
    )!;
    fireEvent.click(high);
    expect(onEffortChange).toHaveBeenCalledWith("high");
  });
});
