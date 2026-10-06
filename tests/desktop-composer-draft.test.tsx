// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React, { useState, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreAbortedDraft } from "../desktop/src/abort-draft";
import { createComposerDraft } from "../desktop/src/ui/composer-draft";

afterEach(cleanup);

describe("composer draft isolation", () => {
  it("updates the input without rerendering its conversation parent", () => {
    const parentRender = vi.fn();
    const sent = vi.fn();
    const store = createComposerDraft();
    function Input() {
      const draft = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return (
        <textarea
          aria-label="draft"
          value={draft}
          onChange={(event) => store.setDraft(event.target.value)}
        />
      );
    }
    function Conversation() {
      parentRender();
      const [, setTick] = useState(0);
      return (
        <>
          <Input />
          <button type="button" onClick={() => sent(store.getSnapshot())}>
            Send
          </button>
          <button type="button" onClick={() => setTick((tick) => tick + 1)}>
            Update
          </button>
        </>
      );
    }
    const view = render(<Conversation />);
    for (const value of ["a", "ab", "abc", "abc\nlong draft"]) {
      fireEvent.change(view.getByLabelText("draft"), { target: { value } });
    }
    expect(parentRender).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByText("Send"));
    expect(sent).toHaveBeenCalledWith("abc\nlong draft");
    fireEvent.click(view.getByText("Update"));
    expect((view.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("abc\nlong draft");
    act(() => store.setDraft(""));
    expect((view.getByLabelText("draft") as HTMLTextAreaElement).value).toBe("");
  });

  it("applies functional attachments and replacements to the latest text synchronously", () => {
    const store = createComposerDraft();
    store.setDraft("typed");
    store.setDraft((current) => `${current} file.ts`);
    store.setDraft((current) => `${current} voice`);
    expect(store.getSnapshot()).toBe("typed file.ts voice");
    expect(restoreAbortedDraft(store.getSnapshot(), "sent text")).toBeNull();
    for (const restored of ["queued text", "retry text", "history text", ""]) {
      store.setDraft(restored);
      expect(store.getSnapshot()).toBe(restored);
    }
  });

  it("notifies only for changes and stops notifying after unsubscribe", () => {
    const store = createComposerDraft();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setDraft("text");
    store.setDraft("text");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.setDraft("");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
