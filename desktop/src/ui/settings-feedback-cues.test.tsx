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
  plugins: [],
  onInstallPlugin: vi.fn(),
  onUninstallPlugin: vi.fn(),
  onTogglePlugin: vi.fn(),
  onRequestPlugins: vi.fn(),
  skills: [],
  onInstallSkill: vi.fn(),
  onUninstallSkill: vi.fn(),
  onRequestSkills: vi.fn(),
  onPickSound: vi.fn(async () => null),
  onCreateSoundPack: vi.fn(),
  onRemoveSoundPack: vi.fn(),
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
  mcpAuth: null,
  onConnectServer: vi.fn(),
  onCancelServerSignIn: vi.fn(),
  onDisconnectServer: vi.fn(),
  changelog: { releases: [], version: "", error: null, loaded: true },
  onRefreshChangelog: vi.fn(),
};

/** A pack the wizard would create: no folder in the bundle, audio in the user's store. */
const userPack = {
  id: "night-shift",
  label: "Night Shift",
  sounds: { taskComplete: "/home/u/.reasonix/sound-packs/night-shift/done.ogg" },
};

/** Locate a pack's card by its header title. */
function packCard(label: string): HTMLElement {
  const card = screen.getByText(label).closest(".provider-card");
  if (!card) throw new Error(`no card for pack ${label}`);
  return card as HTMLElement;
}

/** The cue table inside one pack's card. A card that is not the selected pack starts
 *  collapsed, so expand it first the way a user would. */
function packTable(label: string): HTMLElement {
  const card = packCard(label);
  if (!card.querySelector(".feedback-cues-table")) {
    const toggle = card.querySelector(".provider-head-toggle");
    if (toggle) fireEvent.click(toggle);
  }
  const table = card.querySelector(".feedback-cues-table");
  if (!table) throw new Error(`no cue table in pack ${label}`);
  return table as HTMLElement;
}

/** Locate a cue row within a table by its name cell. */
function cueRow(table: HTMLElement, name: string): HTMLElement {
  const row = within(table).getByText(name).closest("tr");
  if (!row) throw new Error(`no row for cue ${name}`);
  return row;
}

describe("Sound settings page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("is the page the sound settings live on, not the General page", () => {
    const { unmount } = render(<SettingsModal {...baseProps} initialPage="general" />);
    expect(screen.queryByRole("button", { name: /New pack/ })).toBeNull();
    unmount();

    render(<SettingsModal {...baseProps} initialPage="sound" />);
    expect(screen.getByRole("button", { name: /New pack/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sound" })).toBeTruthy();
  });

  it("lists the silent pack first, active on a fresh install, with no cue table", () => {
    render(<SettingsModal {...baseProps} initialPage="sound" />);
    const nothing = packCard("Nothing");
    expect(within(nothing).getByText(/Active/)).toBeTruthy();
    expect(nothing.querySelector(".feedback-cues-table")).toBeNull();
    expect(
      within(packCard("Default Pack")).getByRole("button", { name: "Use this pack" }),
    ).toBeTruthy();
  });

  it("selects a pack persistently through onSave", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="sound" />);
    fireEvent.click(within(packCard("Halo")).getByRole("button", { name: "Use this pack" }));
    expect(onSave).toHaveBeenCalledWith({ soundPackId: "halo" });
  });

  it("marks the stored selection active instead of the silent pack", () => {
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, soundPackId: "halo" }}
        initialPage="sound"
      />,
    );
    expect(within(packCard("Halo")).getByText(/Active/)).toBeTruthy();
    expect(
      within(packCard("Nothing")).getByRole("button", { name: "Use this pack" }),
    ).toBeTruthy();
  });

  it("gives every folder pack its own Sound / Volume / Test table", () => {
    render(<SettingsModal {...baseProps} initialPage="sound" />);
    for (const label of ["Default Pack", "Halo"]) {
      const headers = Array.from(packTable(label).querySelectorAll("th")).map(
        (th) => th.textContent,
      );
      expect(headers).toEqual(["Cue", "Sound", "Volume", "Test"]);
      expect(packTable(label).querySelectorAll("tbody tr")).toHaveLength(4);
    }
  });

  it("stores a cue's sound and volume on the pack it belongs to", () => {
    const onSave = vi.fn();
    render(<SettingsModal {...baseProps} onSave={onSave} initialPage="sound" />);

    fireEvent.click(
      within(cueRow(packTable("Halo"), "Input required")).getByRole("button", {
        name: "Enable sound for Input required",
      }),
    );
    expect(onSave).toHaveBeenCalledWith({
      feedbackAudio: { halo: { inputRequired: { enabled: true, volume: 0.5 } } },
    });

    const slider = within(cueRow(packTable("Halo"), "Task complete")).getByRole("slider", {
      name: "Volume for Task complete",
    });
    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(slider);
    expect(onSave).toHaveBeenLastCalledWith({
      feedbackAudio: { halo: { taskComplete: { enabled: false, volume: 0.8 } } },
    });
  });

  it("keeps one pack's settings from overwriting another's", () => {
    const onSave = vi.fn();
    const settings: Settings = {
      ...baseSettings,
      feedbackAudio: { default: { taskComplete: { enabled: true, volume: 0.7 } } },
    };
    render(
      <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="sound" />,
    );
    const row = cueRow(packTable("Halo"), "Task complete");
    expect(
      within(row).getByRole("button", { name: "Enable sound for Task complete" }).getAttribute(
        "data-on",
      ),
    ).toBe("false");

    fireEvent.click(
      within(row).getByRole("button", { name: "Enable sound for Task complete" }),
    );
    expect(onSave).toHaveBeenCalledWith({
      feedbackAudio: {
        default: { taskComplete: { enabled: true, volume: 0.7 } },
        halo: { taskComplete: { enabled: true, volume: 0.5 } },
      },
    });
  });

  it("tests a cue through the pack on that card", () => {
    const play = vi.spyOn(feedbackSounds, "play").mockReturnValue(true);
    const settings: Settings = {
      ...baseSettings,
      feedbackAudio: { halo: { taskComplete: { enabled: true, volume: 0.7 } } },
    };
    render(<SettingsModal {...baseProps} settings={settings} initialPage="sound" />);
    fireEvent.click(
      within(cueRow(packTable("Halo"), "Task complete")).getByRole("button", {
        name: "Play the Task complete line from Halo",
      }),
    );
    expect(play).toHaveBeenCalledWith("taskComplete", 0.7, "halo");
  });

  it("offers no second cue matrix: one Off/On per pack per cue, nothing global", () => {
    const onSave = vi.fn();
    const settings: Settings = {
      ...baseSettings,
      feedbackAudio: { halo: { planComplete: { enabled: true, volume: 0.4 } } },
    };
    render(
      <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="sound" />,
    );

    // The pack's own switch is the only per-cue toggle set: no table carries a Notify column
    // and no copy promises a notification list above the packs.
    const halo = packTable("Halo");
    expect(Array.from(halo.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "Cue",
      "Sound",
      "Volume",
      "Test",
    ]);
    for (const table of screen.getAllByRole("table")) {
      expect(table.textContent ?? "").not.toContain("Notify");
    }
    expect(screen.queryByRole("button", { name: /notifications for/ })).toBeNull();

    // And the switch that remains is the notification gate, so flipping it is the only
    // thing there is to flip.
    fireEvent.click(
      within(cueRow(halo, "Plan complete")).getByRole("button", {
        name: "Disable sound for Plan complete",
      }),
    );
    expect(onSave).toHaveBeenCalledWith({
      feedbackAudio: { halo: { planComplete: { enabled: false, volume: 0.4 } } },
    });
  });

  it("opens the pack wizard from the New pack button", () => {
    render(<SettingsModal {...baseProps} initialPage="sound" />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /New pack/ }));
    expect(screen.getByRole("dialog", { name: "New pack" })).toBeTruthy();
    expect(screen.getByText("Step 1 of 2: name")).toBeTruthy();
  });

  it("lists a pack the user created, and offers Remove only for that one", () => {
    const onRemoveSoundPack = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, soundPacks: [userPack] }}
        onRemoveSoundPack={onRemoveSoundPack}
        initialPage="sound"
      />,
    );

    for (const shipped of ["Nothing", "Default Pack", "Halo"]) {
      expect(
        within(packCard(shipped)).queryByRole("button", { name: "Remove" }),
        `${shipped} must not be removable`,
      ).toBeNull();
    }

    const card = packCard("Night Shift");
    // A created pack edits its own cue audio like the shipped ones.
    expect(packTable("Night Shift").querySelectorAll("tbody tr")).toHaveLength(4);
    fireEvent.click(within(card).getByRole("button", { name: "Remove" }));
    expect(onRemoveSoundPack).toHaveBeenCalledWith("night-shift");
  });

  it("falls back to the silent pack when the active pack is removed", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, soundPackId: "night-shift", soundPacks: [userPack] }}
        onSave={onSave}
        initialPage="sound"
      />,
    );

    fireEvent.click(within(packCard("Night Shift")).getByRole("button", { name: "Remove" }));
    expect(onSave).toHaveBeenCalledWith({ soundPackId: "nothing" });
  });

  it("stores audio settings for a created pack under its own id", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, soundPacks: [userPack] }}
        onSave={onSave}
        initialPage="sound"
      />,
    );

    fireEvent.click(
      within(cueRow(packTable("Night Shift"), "Task complete")).getByRole("button", {
        name: "Enable sound for Task complete",
      }),
    );
    expect(onSave).toHaveBeenCalledWith({
      feedbackAudio: { "night-shift": { taskComplete: { enabled: true, volume: 0.5 } } },
    });
  });
});