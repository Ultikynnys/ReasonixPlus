// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
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
};

describe("PageModels default-model enum", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the enabled models and switching sets both main and subagent model", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, enabledModels: ["deepseek-v4-flash", "deepseek-v4-pro"] }}
        onSave={onSave}
        initialPage="models"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);

    fireEvent.change(select, { target: { value: "deepseek-v4-pro" } });
    expect(onSave).toHaveBeenCalledWith({
      model: "deepseek-v4-pro",
      subagentModel: "deepseek-v4-pro",
    });
  });

  it("keeps the active model selectable even when it is not in the allow-list", () => {
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, model: "gpt-5.6-sol", enabledModels: ["deepseek-v4-pro"] }}
        initialPage="models"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(select.value).toBe("gpt-5.6-sol");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["gpt-5.6-sol", "deepseek-v4-pro"]);
  });

  it("grays out and explains when no models are enabled", () => {
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, enabledModels: [] }}
        initialPage="models"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(within(select).getByText("No models have been enabled")).toBeTruthy();
  });
});
