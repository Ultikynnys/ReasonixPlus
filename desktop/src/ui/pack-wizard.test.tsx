// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackWizard } from "./pack-wizard";

/** Open the wizard on its second step with one sound already picked. */
function advance(onPickSound: () => Promise<string | null>, label = "Night Shift") {
  fireEvent.change(screen.getByLabelText("Pack name"), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  return onPickSound;
}

describe("PackWizard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders nothing while closed", () => {
    render(
      <PackWizard open={false} onClose={vi.fn()} onPickSound={vi.fn()} onCreate={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for the name first and will not advance without one", () => {
    render(<PackWizard open onClose={vi.fn()} onPickSound={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "New pack" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 2: name")).toBeTruthy();

    const next = screen.getByRole("button", { name: "Next" });
    expect(next.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Pack name"), { target: { value: "Night Shift" } });
    expect(next.hasAttribute("disabled")).toBe(false);
  });

  it("then asks which sound represents each cue", () => {
    render(<PackWizard open onClose={vi.fn()} onPickSound={vi.fn()} onCreate={vi.fn()} />);
    advance(vi.fn(async () => null));

    expect(screen.getByText("Step 2 of 2: sounds")).toBeTruthy();
    for (const cue of ["Input required", "Task complete", "Plan complete", "Repetition guard"]) {
      expect(screen.getByRole("button", { name: `Choose the sound for ${cue}` })).toBeTruthy();
    }
    expect(screen.getAllByText("no sound")).toHaveLength(4);
    // A pack with no audio would play nothing, so it cannot be created.
    expect(screen.getByRole("button", { name: "Create pack" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("submits the name and the picked file per cue, then closes", async () => {
    const onPickSound = vi.fn(async () => "/home/u/Music/done.ogg");
    const onCreate = vi.fn();
    const onClose = vi.fn();
    render(
      <PackWizard open onClose={onClose} onPickSound={onPickSound} onCreate={onCreate} />,
    );
    advance(onPickSound);

    fireEvent.click(screen.getByRole("button", { name: "Choose the sound for Task complete" }));
    await screen.findByText("done.ogg");

    fireEvent.click(screen.getByRole("button", { name: "Create pack" }));
    expect(onCreate).toHaveBeenCalledWith({
      label: "Night Shift",
      sounds: { taskComplete: "/home/u/Music/done.ogg" },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("clears a picked sound and drops that cue from the draft", async () => {
    const onPickSound = vi.fn(async () => "/home/u/Music/done.ogg");
    const onCreate = vi.fn();
    render(<PackWizard open onClose={vi.fn()} onPickSound={onPickSound} onCreate={onCreate} />);
    advance(onPickSound);

    fireEvent.click(screen.getByRole("button", { name: "Choose the sound for Task complete" }));
    await screen.findByText("done.ogg");
    fireEvent.click(screen.getByRole("button", { name: "Clear the sound for Task complete" }));

    expect(screen.getAllByText("no sound")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Create pack" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("goes back to the name step and keeps what was picked", async () => {
    const onPickSound = vi.fn(async () => "/home/u/Music/done.ogg");
    const onCreate = vi.fn();
    render(<PackWizard open onClose={vi.fn()} onPickSound={onPickSound} onCreate={onCreate} />);
    advance(onPickSound);

    fireEvent.click(screen.getByRole("button", { name: "Choose the sound for Plan complete" }));
    await screen.findByText("done.ogg");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    const name = screen.getByLabelText("Pack name") as HTMLInputElement;
    expect(name.value).toBe("Night Shift");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Create pack" }));
    expect(onCreate).toHaveBeenCalledWith({
      label: "Night Shift",
      sounds: { planComplete: "/home/u/Music/done.ogg" },
    });
  });

  it("closes on Escape and on a cancel click", () => {
    const onClose = vi.fn();
    render(<PackWizard open onClose={onClose} onPickSound={vi.fn()} onCreate={vi.fn()} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stays on the name step when the picker is cancelled", async () => {
    const onPickSound = vi.fn(async () => null);
    render(<PackWizard open onClose={vi.fn()} onPickSound={onPickSound} onCreate={vi.fn()} />);
    advance(onPickSound);

    fireEvent.click(screen.getByRole("button", { name: "Choose the sound for Task complete" }));
    await Promise.resolve();
    expect(screen.getAllByText("no sound")).toHaveLength(4);
  });
});
