// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

afterEach(cleanup);

import { Composer, StoredComposer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";
import { createComposerDraft } from "./composer-draft";

const baseProps = makeComposerBaseProps();

// Shorthand and message differ so `getByText(shorthand)` targets only the
// dropdown row's command label, not its message line.
const QUICK_SENDS = [
  { id: "commit-and-push", message: "commit and push all changes", shorthand: "commit and push" },
  { id: "deploy", message: "deploy to production", shorthand: "deploy" },
];

describe("Composer quick send dropdown", () => {
  it("isolates real composer typing and sends the latest draft immediately", () => {
    const store = createComposerDraft();
    const parentRender = vi.fn();
    const sent = vi.fn();
    function Conversation() {
      parentRender();
      const textareaRef = useRef<HTMLTextAreaElement>(null);
      return <StoredComposer {...baseProps} draftStore={store} textareaRef={textareaRef}
        onSend={() => {
          sent(store.getSnapshot());
          store.setDraft("");
        }} />;
    }
    render(<Conversation />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    for (const value of ["a", "ab", "a long message"]) {
      fireEvent.change(textarea, { target: { value } });
    }
    expect(parentRender).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(sent).toHaveBeenCalledWith("a long message");
    expect(textarea.value).toBe("");
    act(() => store.setDraft("restored draft"));
    expect(textarea.value).toBe("restored draft");
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("a long message");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("restored draft");
    expect(parentRender).toHaveBeenCalledTimes(1);
  });

  it("renders the quick send button labelled 'Quick send'", () => {
    render(<Composer {...baseProps} />);

    const btn = screen.getByRole("button", { name: "Quick send" });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("title")).toBe("Quick send");
  });

  it("opens the dropdown without sending when clicked", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} quickSends={QUICK_SENDS} onSend={onSend} />);

    const btn = screen.getByRole("button", { name: "Quick send" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(btn);

    expect(onSend).not.toHaveBeenCalled();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("deploy")).toBeTruthy();
  });

  it("sends the picked quick send when a dropdown item is clicked", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} quickSends={QUICK_SENDS} onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    fireEvent.click(screen.getByText("deploy"));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith({ text: "deploy to production", echo: "deploy" });
  });

  it("marks the persisted default row active in the dropdown", () => {
    render(<Composer {...baseProps} quickSends={QUICK_SENDS} activeQuickSendId="deploy" />);

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    const active = Array.from(document.querySelectorAll<HTMLElement>(".popup-item")).filter(
      (row) => row.getAttribute("data-active") === "true",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toContain("deploy to production");
  });

  it("persists the picked row as the new default", () => {
    const onSend = vi.fn();
    const onPickQuickSend = vi.fn();
    render(
      <Composer
        {...baseProps}
        quickSends={QUICK_SENDS}
        activeQuickSendId="commit-and-push"
        onPickQuickSend={onPickQuickSend}
        onSend={onSend}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    fireEvent.click(screen.getByText("deploy"));

    expect(onPickQuickSend).toHaveBeenCalledWith("deploy");
    // Marking the default is a side effect; the pick still sends.
    expect(onSend).toHaveBeenCalledWith({ text: "deploy to production", echo: "deploy" });
  });

  it("clears the draft and echoes the shorthand when a quick send is picked", () => {
    const onSend = vi.fn();
    const setDraft = vi.fn();
    render(
      <Composer
        {...baseProps}
        draft="some unfinished text"
        setDraft={setDraft}
        quickSends={QUICK_SENDS}
        onSend={onSend}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    fireEvent.click(screen.getByText("commit and push"));

    expect(setDraft).toHaveBeenCalledWith("");
    expect(onSend).toHaveBeenCalledWith({
      text: "commit and push all changes",
      echo: "commit and push",
    });
  });

  it("falls back to a proceed option when no quick sends are supplied", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    // The fallback row renders "proceed" as both label and message.
    const options = screen.getAllByText("proceed");
    expect(options.length).toBeGreaterThanOrEqual(1);

    fireEvent.click(options[0]!);
    expect(onSend).toHaveBeenCalledWith({ text: "proceed", echo: "proceed" });
  });

  it("is enabled when draft is empty (unlike regular send button)", () => {
    render(<Composer {...baseProps} draft="" />);

    const btn = screen.getByRole("button", { name: "Quick send" });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("is disabled when disabled prop is true and does not open", () => {
    const onSend = vi.fn();
    render(<Composer {...baseProps} disabled quickSends={QUICK_SENDS} onSend={onSend} />);

    const btn = screen.getByRole("button", { name: "Quick send" });
    expect(btn.hasAttribute("disabled")).toBe(true);

    fireEvent.click(btn);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByText("deploy")).toBeNull();
  });

  it("queues the picked quick send while busy", () => {
    const onSend = vi.fn();
    const onQueueWhileBusy = vi.fn();
    render(
      <Composer
        {...baseProps}
        busy
        quickSends={QUICK_SENDS}
        onSend={onSend}
        onQueueWhileBusy={onQueueWhileBusy}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    fireEvent.click(screen.getByText("deploy"));

    expect(onSend).not.toHaveBeenCalled();
    expect(onQueueWhileBusy).toHaveBeenCalledTimes(1);
    expect(onQueueWhileBusy).toHaveBeenCalledWith({ text: "deploy to production", echo: "deploy" });
  });

  it("marks the configured quick send as the active row", () => {
    render(<Composer {...baseProps} quickSends={QUICK_SENDS} activeQuickSendId="deploy" />);

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));

    expect(screen.getByText("deploy").closest(".popup-item")?.getAttribute("data-active")).toBe(
      "true",
    );
    expect(
      screen.getByText("commit and push").closest(".popup-item")?.getAttribute("data-active"),
    ).toBe("false");
  });

  it("reports the picked row so the default can be persisted", () => {
    const onSend = vi.fn();
    const onPickQuickSend = vi.fn();
    render(
      <Composer
        {...baseProps}
        quickSends={QUICK_SENDS}
        activeQuickSendId="commit-and-push"
        onPickQuickSend={onPickQuickSend}
        onSend={onSend}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Quick send" }));
    fireEvent.click(screen.getByText("deploy"));

    expect(onPickQuickSend).toHaveBeenCalledWith("deploy");
    expect(onSend).toHaveBeenCalledWith({ text: "deploy to production", echo: "deploy" });
  });
});

describe("Composer voice button availability", () => {
  it("is enabled by default when voiceAvailable is omitted", () => {
    render(<Composer {...baseProps} />);

    const voiceBtn = screen.getByTitle("Voice input");
    expect(voiceBtn.hasAttribute("disabled")).toBe(false);
  });

  it("is disabled when no voice model is installed", () => {
    render(<Composer {...baseProps} voiceAvailable={false} />);

    const voiceBtn = screen.getByTitle(/No voice model installed/);
    expect(voiceBtn.hasAttribute("disabled")).toBe(true);
  });
});
