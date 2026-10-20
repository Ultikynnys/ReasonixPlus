// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { MailProvider } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const RETIRED = "retired-model-id";

const baseSettings: Settings = {
  version: "1.0.0",
  reasoningEffort: "high",
  editMode: "follow",
  workspaceDir: "/test",
  recentWorkspaces: [],
  model: "deepseek-v4-flash",
  fallbackModels: ["deepseek-v4-flash", RETIRED],
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

function renderPage(settings: Settings, onSave: (patch: unknown) => void) {
  return render(
    <SettingsModal {...baseProps} settings={settings} onSave={onSave} initialPage="fallbacks" />,
  );
}

describe("PageFallbacks — backup-model list", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders one row per configured backup, in priority order", () => {
    renderPage(baseSettings, vi.fn());
    const first = screen.getByLabelText("Backup model 1") as HTMLSelectElement;
    const second = screen.getByLabelText("Backup model 2") as HTMLSelectElement;
    expect(first.value).toBe("deepseek-v4-flash");
    // A saved id the catalogs no longer serve keeps its row instead of blanking.
    expect(second.value).toBe(RETIRED);
  });

  it("is reachable as its own settings category", () => {
    renderPage(baseSettings, vi.fn());
    expect(screen.getAllByText("Backup models").length).toBeGreaterThan(0);
  });

  it("explains that failover is off until a backup is added", () => {
    renderPage({ ...baseSettings, fallbackModels: [] }, vi.fn());
    expect(screen.getByText(/No backup models yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Backup model 1")).toBeNull();
  });

  it("adds the first unused catalog model", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    fireEvent.click(screen.getByRole("button", { name: "Add a backup model" }));
    const patch = onSave.mock.calls[0]?.[0] as { fallbackModels: string[] };
    expect(patch.fallbackModels).toHaveLength(3);
    expect(patch.fallbackModels.slice(0, 2)).toEqual(["deepseek-v4-flash", RETIRED]);
    expect(patch.fallbackModels[2]).toBeTruthy();
    expect(patch.fallbackModels[2]).not.toBe(RETIRED);
  });

  it("removes a row", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    fireEvent.click(screen.getByRole("button", { name: `Remove backup model ${RETIRED}` }));
    expect(onSave).toHaveBeenCalledWith({ fallbackModels: ["deepseek-v4-flash"] });
  });

  it("reorders with the priority buttons", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    fireEvent.click(screen.getByRole("button", { name: `Give ${RETIRED} higher priority` }));
    expect(onSave).toHaveBeenCalledWith({ fallbackModels: [RETIRED, "deepseek-v4-flash"] });
  });

  it("cannot move the top row up or the bottom row down", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    const top = screen.getByRole("button", {
      name: "Give deepseek-v4-flash higher priority",
    }) as HTMLButtonElement;
    const bottom = screen.getByRole("button", {
      name: `Give ${RETIRED} lower priority`,
    }) as HTMLButtonElement;
    expect(top.disabled).toBe(true);
    expect(bottom.disabled).toBe(true);
    fireEvent.click(top);
    fireEvent.click(bottom);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the picked model into that row's slot", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    const first = screen.getByLabelText("Backup model 1") as HTMLSelectElement;
    // Any second option the picker offers; the picker groups by provider.
    const target = Array.from(first.options).find(
      (option) => option.value !== "deepseek-v4-flash" && !option.disabled,
    );
    expect(target).toBeTruthy();
    fireEvent.change(first, { target: { value: target!.value } });
    expect(onSave).toHaveBeenCalledWith({
      fallbackModels: [target!.value, RETIRED],
    });
  });

  it("disables a model that is already used by another row", () => {
    renderPage(
      { ...baseSettings, fallbackModels: ["deepseek-v4-flash", "deepseek-v4-pro"] },
      vi.fn(),
    );
    const first = screen.getByLabelText("Backup model 1") as HTMLSelectElement;
    const dup = Array.from(first.options).find((option) => option.value === "deepseek-v4-pro");
    expect(dup?.disabled).toBe(true);
  });
});
