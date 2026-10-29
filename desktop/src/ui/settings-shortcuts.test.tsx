// @vitest-environment jsdom

/** The Shortcuts page is where a user looks for a binding they were told about, so
 *  the composer's quick-send hotkeys have to be listed there — and read from the
 *  same grid the shell's own bindings use. */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { MailProvider } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

const settings: Settings = {
  version: "1.0.0",
  reasoningEffort: "high",
  editMode: "follow",
  workspaceDir: "/test",
  recentWorkspaces: [],
  model: "deepseek-v4-flash",
};

const baseProps = {
  settings,
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

/** The page is one `.kbd-grid` of name/keycap pairs — read it as the user sees it
 *  instead of matching text anywhere in the modal. */
function bindings(container: HTMLElement) {
  const grid = container.querySelector(".kbd-grid");
  if (!grid) throw new Error("no shortcut grid rendered");
  const cells = Array.from(grid.children);
  const out: { label: string; keys: string[] }[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    out.push({
      label: cells[i]?.textContent ?? "",
      keys: Array.from(cells[i + 1]?.querySelectorAll("kbd") ?? []).map((kbd) => kbd.textContent),
    });
  }
  return out;
}

describe("settings Shortcuts page", () => {
  it("is reachable from the nav and lists the quick-send hotkeys there", () => {
    const { container } = render(<SettingsModal {...baseProps} />);

    fireEvent.click(screen.getByText("Shortcuts"));

    expect(screen.getByText("Keyboard shortcuts overview")).toBeTruthy();
    expect(bindings(container)).toEqual(
      expect.arrayContaining([
        { label: "Quick send menu", keys: ["Ctrl", "Q"] },
        { label: "Queue quick send 1-9", keys: ["Ctrl", "1-9"] },
      ]),
    );
  });

  it("still lists the shell bindings next to them", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="shortcuts" />);

    expect(bindings(container)).toEqual(
      expect.arrayContaining([
        { label: "New chat", keys: ["Ctrl", "N"] },
        { label: "Focus composer", keys: ["Ctrl", "L"] },
        { label: "Settings", keys: ["Ctrl", ","] },
      ]),
    );
  });

  it("is its own page in the nav", () => {
    render(<SettingsModal {...baseProps} />);

    fireEvent.click(screen.getByText("Quick send"));

    expect(screen.getByText("Composer quick actions and their hotkeys")).toBeTruthy();
    expect(screen.getByPlaceholderText("Message sent to the model")).toBeTruthy();
  });

  it("shows the configured quick-send order as the Ctrl+1-9 order", () => {
    render(<SettingsModal {...baseProps} initialPage="quickSend" />);

    // The ordering the dropdown and the digits share is edited on the Quick send page,
    // so that page has to name the hotkey that consumes it.
    expect(screen.getByText(/Ctrl\+1-9|1-9/)).toBeTruthy();
  });
});
