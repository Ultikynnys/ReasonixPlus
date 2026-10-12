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

describe("PageModels default-model enum", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stacks every provider base URL below its description and preserves saving", () => {
    const onSave = vi.fn();
    const { container } = render(
      <SettingsModal {...baseProps} onSave={onSave} initialPage="models" />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    expect(screen.queryByRole("button", { name: "Custom" })).toBeNull();
    expect(screen.queryByPlaceholderText("custom model id")).toBeNull();
    const rows = Array.from(container.querySelectorAll(".setting-row-base-url"));
    expect(rows).toHaveLength(4);
    const patchKeys = ["baseUrl", "mimoBaseUrl", "opencodeBaseUrl", "ollamaBaseUrl"];
    rows.forEach((row, index) => {
      expect(row.firstElementChild?.className).toBe("l");
      expect(row.firstElementChild?.querySelector(".h")).toBeTruthy();
      expect(row.classList.contains("setting-row-entry")).toBe(true);
      const input = row.querySelector("input") as HTMLInputElement;
      onSave.mockClear();
      fireEvent.change(input, { target: { value: " https://example.com/v1 " } });
      fireEvent.blur(input);
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Save" }));
      expect(onSave).toHaveBeenCalledWith({ [patchKeys[index]]: "https://example.com/v1" });
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Save" }));
      expect(onSave).toHaveBeenLastCalledWith({ [patchKeys[index]]: index === 0 ? "" : null });
    });
  });

  it("uses stacked Save-only API key entries and shared refresh wording", () => {
    const onSaveApiKey = vi.fn();
    const onSaveOpenAIApiKey = vi.fn();
    const onRefreshOpencodeModels = vi.fn();
    const onRefreshOllamaModels = vi.fn();
    const { container } = render(
      <SettingsModal {...baseProps} initialPage="models"
        onSaveApiKey={onSaveApiKey} onSaveOpenAIApiKey={onSaveOpenAIApiKey}
        onRefreshOpencodeModels={onRefreshOpencodeModels} onRefreshOllamaModels={onRefreshOllamaModels}
      />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(inputs.length).toBeGreaterThan(2);
    inputs.forEach((input) => {
      const row = input.closest(".setting-row-entry") as HTMLElement;
      expect(row).toBeTruthy();
      expect(row.firstElementChild?.className).toBe("l");
      expect(within(row).queryByRole("button", { name: "Clear" })).toBeNull();
      fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    });
    expect(onSaveApiKey).toHaveBeenCalledWith("");
    expect(onSaveOpenAIApiKey).toHaveBeenCalledWith("");
    const refresh = screen.getAllByRole("button", { name: "Refresh" });
    expect(refresh).toHaveLength(2);
    refresh.forEach((button) => fireEvent.click(button));
    expect(onRefreshOpencodeModels).toHaveBeenCalledWith(true);
    expect(onRefreshOllamaModels).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "Sync models" })).toBeNull();
  });

  it("keeps provider-column button rows where the stacking rule applies", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="models" />);
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    // The OpenCode/OpenAI "Sign in" and "Refresh" rows sit in the half-width
    // settings column, so `.provider-col .setting-row:has(button)` must match
    // them (and stack them) rather than the rule going stale against markup.
    const buttonRows = Array.from(
      container.querySelectorAll(".provider-col .setting-row:has(button)"),
    );
    expect(buttonRows.length).toBeGreaterThan(0);
    buttonRows.forEach((row) => {
      expect(row.firstElementChild?.className).toBe("l");
    });
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

  it("filters a provider's model list from a dedicated search row", () => {
    const { container } = render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, enabledModels: ["deepseek-v4-flash"] }}
        initialPage="models"
      />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    const searches = screen.getAllByPlaceholderText("Search models") as HTMLInputElement[];
    const search = searches.find(
      (input) => (input.closest(".provider-col")?.querySelector(".mcard") ?? null) !== null,
    );
    expect(search).toBeTruthy();
    // The search box sits on its own row, never inside the count / enable-all row.
    expect(search?.closest(".provider-models-search")).toBeTruthy();
    expect(search?.closest(".provider-models-head")).toBeNull();
    const col = search?.closest(".provider-col") as HTMLElement;
    expect(col.querySelectorAll(".mcard").length).toBeGreaterThan(0);
    fireEvent.change(search as HTMLInputElement, { target: { value: "zzz-no-such-model" } });
    expect(col.querySelectorAll(".mcard")).toHaveLength(0);
    expect(within(col).getByText("No models match your search.")).toBeTruthy();
  });
});

describe("PageModels shared-id identity (qualified refs)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const sharedIdSettings = {
    ...baseSettings,
    enabledModels: ["mimo-v2.6-pro", "opencode/mimo-v2.6-pro", "big-pickle"],
  };

  it("toggles the two shared-id rows independently via their distinct values", () => {
    const onSave = vi.fn();
    const { container } = render(
      <SettingsModal
        {...baseProps}
        settings={sharedIdSettings}
        opencodeModels={["mimo-v2.6-pro", "big-pickle"]}
        onSave={onSave}
        initialPage="models"
      />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });

    const cardFor = (name: string) =>
      Array.from(container.querySelectorAll(".mcard")).find(
        (card) => card.querySelector(".model-name")?.textContent === name,
      );
    const native = cardFor("mimo-v2.6-pro");
    const qualified = cardFor("opencode/mimo-v2.6-pro");
    expect(native).toBeTruthy();
    expect(qualified).toBeTruthy();

    // Disabling the OPENCODE row removes only the qualified identity.
    fireEvent.click(within(qualified as HTMLElement).getByRole("button", { name: "Disable" }));
    expect(onSave).toHaveBeenCalledWith({ enabledModels: ["mimo-v2.6-pro", "big-pickle"] });

    // Disabling the XIAOMI row removes only the bare id.
    onSave.mockClear();
    fireEvent.click(within(native as HTMLElement).getByRole("button", { name: "Disable" }));
    expect(onSave).toHaveBeenCalledWith({
      enabledModels: ["opencode/mimo-v2.6-pro", "big-pickle"],
    });
  });

  it("saves the qualified identity when the OPENCODE default model is selected", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={sharedIdSettings}
        opencodeModels={["mimo-v2.6-pro", "big-pickle"]}
        onSave={onSave}
        initialPage="models"
      />,
    );

    const select = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    // The active default (deepseek-v4-flash) isn't enabled here, so it is
    // prepended to the allow-list options to keep the select non-blank.
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "deepseek-v4-flash",
      "mimo-v2.6-pro",
      "opencode/mimo-v2.6-pro",
      "big-pickle",
    ]);
    fireEvent.change(select, { target: { value: "opencode/mimo-v2.6-pro" } });
    expect(onSave).toHaveBeenCalledWith({
      model: "opencode/mimo-v2.6-pro",
      subagentModel: "opencode/mimo-v2.6-pro",
    });
  });
});
