import { describe, expect, it } from "vitest";
import { reduce } from "../desktop/src/App.js";
import { baseAppState } from "./support/app-state.js";

// The session list is keyed by workspace in the store, so a channel can no longer
// hold another workspace's rows. What the reducer still owes on a workspace change
// is the transcript: a real switch resets it, a separator-only difference must not.
const WS_A = "C:\\proj";
const WS_B = "C:\\proj\\local";

function seededState(workspaceDir: string) {
  return baseAppState({
    currentSession: "desktop-A",
    messages: [{ kind: "user" as const, text: "hi" }],
    settings: {
      reasoningEffort: "high",
      editMode: "follow",
      workspaceDir,
      recentWorkspaces: [workspaceDir],
      model: "deepseek-v4-flash",
      version: "0.50.1",
    },
  });
}

const settingsEvent = (workspaceDir: string) => ({
  type: "$settings" as const,
  reasoningEffort: "high" as const,
  editMode: "follow" as const,
  quickSendId: "proceed",
  quickSends: [],
  workspaceDir,
  recentWorkspaces: [workspaceDir],
  model: "deepseek-v4-flash",
  version: "0.50.1",
});

describe("$settings — a workspace switch resets the transcript", () => {
  it("clears the transcript when the workspace actually changes", () => {
    const next = reduce(seededState(WS_A), { t: "incoming", event: settingsEvent(WS_B) });
    expect(next.messages).toEqual([]);
    expect(next.settings?.workspaceDir).toBe(WS_B);
  });

  it("does not treat a separator-only difference as a workspace change", () => {
    // The daemon re-emits settings freely; a trailing slash must not wipe the thread.
    const state = seededState(WS_A);
    const next = reduce(state, { t: "incoming", event: settingsEvent(`${WS_A}\\`) });
    expect(next.messages).toEqual(state.messages);
  });
});
