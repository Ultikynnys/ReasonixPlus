// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { feedbackSounds } from "../feedback-sounds";
import { MailProvider } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const baseSettings: Settings = {
  version: "1.0.0",
  reasoningEffort: "high",
  editMode: "follow",
  workspaceDir: "/test",
  recentWorkspaces: [],
  model: "deepseek-v4-flash",
};

const baseProps = {
  settings: baseSettings,
  fontScale: "medium" as const,
  onSetFontScale: vi.fn(),
  fontFamily: "sans" as const,
  onSetFontFamily: vi.fn(),
  customFontFamily: "",
  onSetCustomFontFamily: vi.fn(),
  mcpSpecs: [],
  mcpBridged: false,
  onClose: vi.fn(),
  onSave: vi.fn(),
  onSaveApiKey: vi.fn(),
  oauthWaiting: false,
  onOAuthBegin: vi.fn(),
  onOAuthCancel: vi.fn(),
  onOAuthSignOut: vi.fn(),
  onSaveOpenAIApiKey: vi.fn(),
  antigravityOAuthWaiting: false,
  onAntigravityOAuthBegin: vi.fn(),
  onAntigravityOAuthCancel: vi.fn(),
  onAntigravityOAuthSignOut: vi.fn(),
  opencodeOAuthWaiting: false,
  onOpencodeOAuthBegin: vi.fn(),
  onOpencodeOAuthCancel: vi.fn(),
  onOpencodeOAuthSignOut: vi.fn(),
  mimoOAuthWaiting: false,
  onMiMoOAuthBegin: vi.fn(),
  onMiMoOAuthCancel: vi.fn(),
  onMiMoOAuthSignOut: vi.fn(),
  onAddMcpSpec: vi.fn(),
  onRemoveMcpSpec: vi.fn(),
  onToggleMcpServer: vi.fn(),
  onToggleMcpTool: vi.fn(),
  mcpExtensionStatus: null,
  mcpExtensionCheck: null,
  playwrightBrowserInstall: null,
  onRequestMcpExtensionStatus: vi.fn(),
  onConfigureMcpExtension: vi.fn(),
  onCheckMcpExtension: vi.fn(),
  onInstallPlaywrightBrowser: vi.fn(),
  onCancelPlaywrightBrowserInstall: vi.fn(),
  mailProvider: MailProvider.Outlook,
  mailAuth: null,
  onSetMailProvider: vi.fn(),
  onRequestMailStatus: vi.fn(),
  onConfigureMail: vi.fn(),
  onConnectMail: vi.fn(),
  onCancelMail: vi.fn(),
  onSignOutMail: vi.fn(),
  changelog: { releases: [], version: "", error: null, loaded: true },
  onRefreshChangelog: vi.fn(),
};

/** Locate the table row for a cue by its name cell. */
function cueRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for cue ${name}`);
  return row;
}

describe("Feedback cues table", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders every cue as a row with Sound / Volume / Notify / Test columns", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="general" />);
    const table = container.querySelector(".feedback-cues-table");
    expect(table).toBeTruthy();
    const headers = Array.from(table!.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toEqual(["Cue", "Sound", "Volume", "Notify", "Test"]);
    expect(table!.querySelectorAll("tbody tr")).toHaveLength(4);
    for (const name of ["Input required", "Task complete", "Plan complete", "Repetition guard"]) {
      expect(within(cueRow(name)).getAllByRole("button")).toHaveLength(5);
    }
  });

  it("enables a cue's sound from the Sound column, preserving volume/notify", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="general" />);
    fireEvent.click(
      within(cueRow("Input required")).getByRole("button", {
        name: "Enable sound for Input required",
      }),
    );
    expect(onSave).toHaveBeenCalledWith({
      feedbackCues: { inputRequired: { enabled: true, volume: 0.5, notify: false } },
    });
  });

  it("reflects stored state and patches volume and notify", () => {
    const onSave = vi.fn();
    const settings: Settings = {
      ...baseSettings,
      feedbackCues: { planComplete: { enabled: true, volume: 0.5, notify: false } },
    };
    render(
      <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="general" />,
    );
    const row = cueRow("Plan complete");

    // The enabled cue shows its On button pressed and its volume percent.
    expect(
      within(row)
        .getByRole("button", { name: "Enable sound for Plan complete" })
        .getAttribute("data-on"),
    ).toBe("true");
    expect(within(row).getByText("50%")).toBeTruthy();

    // Dragging updates a local draft; the value is committed on release.
    const slider = within(row).getByRole("slider", { name: "Volume for Plan complete" });
    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(onSave).toHaveBeenCalledWith({
      feedbackCues: { planComplete: { enabled: true, volume: 0.8, notify: false } },
    });

    // Notify on/off is a separate column.
    fireEvent.click(
      within(row).getByRole("button", { name: "Enable notifications for Plan complete" }),
    );
    expect(onSave).toHaveBeenLastCalledWith({
      feedbackCues: { planComplete: { enabled: true, volume: 0.5, notify: true } },
    });
  });

  it("plays a cue's sound from the Test column at its volume, even while the sound switch is off", () => {
    const play = vi.spyOn(feedbackSounds, "play").mockReturnValue(true);
    const settings: Settings = {
      ...baseSettings,
      feedbackCues: { guardTriggered: { enabled: false, volume: 0.8, notify: false } },
    };
    render(<SettingsModal {...baseProps} settings={settings} initialPage="general" />);
    fireEvent.click(
      within(cueRow("Repetition guard")).getByRole("button", {
        name: "Test the Repetition guard sound",
      }),
    );
    expect(play).toHaveBeenCalledWith("guardTriggered", 0.8);
  });
});
