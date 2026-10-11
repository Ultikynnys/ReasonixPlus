/** Shared required-prop factory for the composer-* test suites — one place to
 *  update when the Composer required-prop surface changes. */
import type { ComponentProps } from "react";
import { vi } from "vitest";
import { Composer } from "./composer";

export function makeComposerBaseProps(
  overrides: Partial<ComponentProps<typeof Composer>> = {},
): ComponentProps<typeof Composer> {
  return {
    draft: "",
    setDraft: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    modelLabel: "deepseek-v4-flash",
    reasoningEffort: "high",
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    editMode: "follow",
    onEditModeChange: vi.fn(),
    onVoiceError: vi.fn(),
    textareaRef: { current: null },
    ...overrides,
  };
}
