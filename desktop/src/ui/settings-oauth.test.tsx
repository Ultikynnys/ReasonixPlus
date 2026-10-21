// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISection } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("OpenAISection", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderCard(props: Partial<Parameters<typeof OpenAISection>[0]> = {}) {
    const onBegin = vi.fn();
    const onCancel = vi.fn();
    const onSignOut = vi.fn();
    render(
      <OpenAISection
        signedIn={false}
        account={undefined}
        waiting={false}
        onBegin={onBegin}
        onCancel={onCancel}
        onSignOut={onSignOut}
        {...props}
      />,
    );
    return { onBegin, onCancel, onSignOut };
  }

  it("shows the sign-in button when signed out", () => {
    renderCard();
    expect(screen.getByText("Sign in with OpenAI")).toBeTruthy();
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("starts the flow on click", () => {
    const { onBegin } = renderCard();
    fireEvent.click(screen.getByText("Sign in with OpenAI"));
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it("disables sign-in and shows Cancel while waiting", () => {
    const { onCancel } = renderCard({ waiting: true });
    expect(screen.getByText("Sign in with OpenAI").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the signed-in state with the masked account and signs out", () => {
    const { onSignOut } = renderCard({ signedIn: true, account: "u@example.com" });
    expect(screen.getByText(/u@example\.com/)).toBeTruthy();
    fireEvent.click(screen.getByText("Sign out"));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Sign in with OpenAI")).toBeNull();
  });

  it("leaves the API key field to the provider declaration", () => {
    renderCard();
    // The key input is rendered from providers/openai.json by the Models page, so the
    // panel itself owns only the sign-in affordances.
    expect(screen.queryByPlaceholderText("sk-…")).toBeNull();
    expect(screen.queryByText("Save")).toBeNull();
  });
});
