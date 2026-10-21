// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// vitest runs with globals:false — testing-library's auto-cleanup never
// registers, so unmount between tests to keep queries unambiguous.
afterEach(cleanup);

import type { QueuedSendItem } from "./composer";
import { Composer } from "./composer";
import { makeComposerBaseProps } from "./composer-test-fixtures";

const baseProps = makeComposerBaseProps();

function renderQueued({
  queuedSends,
  onDequeueSend,
  onEditQueuedSend,
  onSendQueuedNow,
}: {
  queuedSends?: QueuedSendItem[];
  onDequeueSend?: (index: number) => void;
  onEditQueuedSend?: (index: number) => void;
  onSendQueuedNow?: (index: number) => void;
}) {
  return render(
    <Composer
      {...baseProps}
      queuedSends={queuedSends ?? []}
      onDequeueSend={onDequeueSend}
      onEditQueuedSend={onEditQueuedSend}
      onSendQueuedNow={onSendQueuedNow}
    />,
  );
}

describe("Composer queued-sends row", () => {
  it("renders the queue label and one per-message chip each", () => {
    renderQueued({
      queuedSends: ["first message", "second message"],
      onDequeueSend: vi.fn(),
      onSendQueuedNow: vi.fn(),
    });

    expect(screen.getByText("queued 2")).toBeTruthy();
    expect(screen.getByText("first message")).toBeTruthy();
    expect(screen.getByText("second message")).toBeTruthy();
  });

  it("puts no whole-queue action in the row — sending now is per message", () => {
    renderQueued({
      queuedSends: ["first message", "second message"],
      onSendQueuedNow: vi.fn(),
      onDequeueSend: vi.fn(),
    });

    expect(document.querySelectorAll(".composer-queued button").length).toBe(0);
  });

  it("removing a chip calls onDequeueSend with its index", () => {
    const onDequeueSend = vi.fn();
    renderQueued({
      queuedSends: ["first message", "second message"],
      onDequeueSend,
      onSendQueuedNow: vi.fn(),
    });

    const removeButtons = document.querySelectorAll(".composer-queue-chip .x");
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[1]);
    expect(onDequeueSend).toHaveBeenCalledWith(1);
  });

  it("each chip's arrow sends only that queued message", () => {
    const onSendQueuedNow = vi.fn();
    renderQueued({
      queuedSends: ["first message", "second message"],
      onSendQueuedNow,
    });

    const arrows = document.querySelectorAll(".composer-queue-chip .send-now");
    expect(arrows.length).toBe(2);
    fireEvent.click(arrows[1]);
    expect(onSendQueuedNow).toHaveBeenCalledTimes(1);
    expect(onSendQueuedNow).toHaveBeenCalledWith(1);
  });

  it("the arrow sends without also pulling the message back for editing", () => {
    const onEditQueuedSend = vi.fn();
    const onSendQueuedNow = vi.fn();
    renderQueued({ queuedSends: ["only message"], onEditQueuedSend, onSendQueuedNow });

    fireEvent.click(document.querySelector(".composer-queue-chip .send-now")!);

    expect(onSendQueuedNow).toHaveBeenCalledWith(0);
    expect(onEditQueuedSend).not.toHaveBeenCalled();
  });

  it("omits the per-message send arrow when onSendQueuedNow is not wired", () => {
    renderQueued({ queuedSends: ["queued text"], onDequeueSend: vi.fn() });
    expect(document.querySelectorAll(".composer-queue-chip .send-now").length).toBe(0);
  });

  it("renders nothing when the queue is empty", () => {
    renderQueued({ queuedSends: [] });
    expect(screen.queryByText(/queued \d/)).toBeNull();
  });

  it("renders image thumbnails inside the queued chip when a message has images", () => {
    renderQueued({
      queuedSends: [
        {
          text: "describe this diagram",
          images: [
            { id: "img-1", thumbnail: "data:image/png;base64,ABC" },
            { id: "img-2", thumbnail: "data:image/png;base64,DEF" },
          ],
        },
      ],
    });

    const chip = document.querySelector(".composer-queue-chip");
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("title")).toBe("describe this diagram (2 images)");

    const images = chip?.querySelectorAll(".composer-queue-chip-img");
    expect(images?.length).toBe(2);
    expect(images?.[0]?.getAttribute("src")).toBe("data:image/png;base64,ABC");
    expect(images?.[1]?.getAttribute("src")).toBe("data:image/png;base64,DEF");
    expect(screen.getByText("describe this diagram")).toBeTruthy();
  });

  it("forwards pending images to onQueueWhileBusy when pressing Enter while busy", () => {
    const onQueueWhileBusy = vi.fn();
    const pendingImages = [{ id: "img-1", thumbnail: "data:image/png;base64,ABC" }];

    render(
      <Composer
        {...baseProps}
        busy={true}
        draft="check this image"
        pendingImages={pendingImages}
        onQueueWhileBusy={onQueueWhileBusy}
      />,
    );

    const textarea = document.querySelector("textarea")!;
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onQueueWhileBusy).toHaveBeenCalledTimes(1);
    expect(onQueueWhileBusy).toHaveBeenCalledWith("check this image", pendingImages);
  });

  it("renders the full queued message, never a quick-send shorthand", () => {
    renderQueued({ queuedSends: [{ text: "commit and push all changes" }] });

    expect(screen.getByText("commit and push all changes")).toBeTruthy();
    const chip = document.querySelector(".composer-queue-chip");
    expect(chip?.getAttribute("title")).toBe("commit and push all changes");
  });
});

describe("Composer queued-chip edit affordance", () => {
  it("has no pen button — the chip body is the edit affordance", () => {
    renderQueued({
      queuedSends: ["first message", "second message"],
      onEditQueuedSend: vi.fn(),
      onSendQueuedNow: vi.fn(),
    });

    expect(document.querySelectorAll(".composer-queue-chip .edit").length).toBe(0);
  });

  it("clicking a chip's text pulls that message back for editing", () => {
    const onEditQueuedSend = vi.fn();
    renderQueued({
      queuedSends: ["first message", "second message"],
      onEditQueuedSend,
    });

    fireEvent.click(screen.getByText("first message"));
    expect(onEditQueuedSend).toHaveBeenCalledWith(0);
  });

  it("omits the edit affordance when onEditQueuedSend is not wired", () => {
    renderQueued({ queuedSends: ["queued text"], onDequeueSend: vi.fn() });

    expect(screen.getByText("queued text").classList.contains("editable")).toBe(false);
  });
});
