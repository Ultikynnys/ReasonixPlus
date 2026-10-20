import { describe, expect, it } from "vitest";
import { reduce } from "../desktop/src/App.js";
import { baseAppState } from "./support/app-state.js";

// A session list belongs to exactly one workspace. The reducer used to keep the
// previous workspace's rows after a switch (like `messages` it was never reset),
// so one click could open a foreign session in the new workspace — and the daemon
// then persisted a channel bound across workspaces.
const WS_A = "C:\\proj";
const WS_B = "C:\\proj\\local";

const sessionRow = (name: string) => ({
  name,
  messageCount: 2,
  mtime: new Date(1).toISOString(),
});

function seededState(workspaceDir: string) {
  return baseAppState({
    currentSession: "desktop-A",
    sessions: [sessionRow("desktop-A"), sessionRow("desktop-B")],
    sessionsEpoch: "e1",
    sessionsRevision: 4,
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

describe("$settings — the sidebar list never outlives its workspace", () => {
  it("drops the previous workspace's sessions when the workspace changes", () => {
    const next = reduce(seededState(WS_A), {
      t: "incoming",
      event: settingsEvent(WS_B),
    });
    expect(next.sessions).toEqual([]);
    expect(next.settings?.workspaceDir).toBe(WS_B);
  });

  it("keeps the list when the same workspace is re-emitted", () => {
    const state = seededState(WS_A);
    const next = reduce(state, { t: "incoming", event: settingsEvent(WS_A) });
    expect(next.sessions).toEqual(state.sessions);
  });

  it("does not treat a separator-only difference as a workspace change", () => {
    // The daemon re-emits settings freely; a trailing slash must not wipe the
    // sidebar or the transcript.
    const state = { ...seededState(WS_A), messages: [{ kind: "user" as const, text: "hi" }] };
    const next = reduce(state, { t: "incoming", event: settingsEvent(`${WS_A}\\`) });
    expect(next.sessions).toEqual(state.sessions);
    expect(next.messages).toEqual(state.messages);
  });

  it("seeds nothing on the first $settings of a channel", () => {
    // prevWs === undefined: there is no previous workspace to be stale against,
    // and blanking here would wipe the mount-time seed the sidebar depends on.
    const state = { ...seededState(WS_A), settings: null };
    const next = reduce(state, { t: "incoming", event: settingsEvent(WS_A) });
    expect(next.sessions).toEqual(state.sessions);
  });
});
