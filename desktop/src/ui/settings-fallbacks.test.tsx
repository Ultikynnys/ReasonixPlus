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
  // Backups are picked from the ENABLED allow-list, so the fixture must enable the
  // models the rows use — an empty list here would (correctly) offer nothing.
  enabledModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
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
    // A saved id outside the enabled list keeps its row instead of blanking, and says
    // so — it is no longer one of the offered choices.
    expect(second.value).toBe(RETIRED);
    const saved = Array.from(second.options).find((option) => option.value === RETIRED);
    expect(saved?.textContent).toBe(`${RETIRED} (not enabled)`);
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

  it("adds the first unused enabled model", () => {
    const onSave = vi.fn();
    renderPage(baseSettings, onSave);
    fireEvent.click(screen.getByRole("button", { name: "Add a backup model" }));
    const patch = onSave.mock.calls[0]?.[0] as { fallbackModels: string[] };
    expect(patch.fallbackModels).toEqual(["deepseek-v4-flash", RETIRED, "deepseek-v4-pro"]);
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

  it("offers only the ENABLED models, never the whole catalog", () => {
    renderPage(baseSettings, vi.fn());
    const first = screen.getByLabelText("Backup model 1") as HTMLSelectElement;
    const values = Array.from(first.options).map((option) => option.value);
    expect(values).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    // In the catalog, but switched off in Settings → Models, so not offered here.
    expect(values).not.toContain("deepseek-flash");
  });

  it("keeps an enabled model that no catalog places reachable under its own group", () => {
    renderPage(
      { ...baseSettings, enabledModels: [...baseSettings.enabledModels!, "hand-picked-model"] },
      vi.fn(),
    );
    const first = screen.getByLabelText("Backup model 1") as HTMLSelectElement;
    const labels = Array.from(first.querySelectorAll("optgroup")).map((group) => group.label);
    expect(labels).toContain("Other enabled models");
    expect(Array.from(first.options).map((option) => option.value)).toContain("hand-picked-model");
  });

  it("asks for enabled models first when none are switched on", () => {
    renderPage({ ...baseSettings, enabledModels: [], fallbackModels: [] }, vi.fn());
    expect(screen.getByText(/No models are enabled yet/)).toBeTruthy();
    expect(screen.queryByText(/No backup models yet/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Add a backup model" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps each backup on a single row: index, picker, then the buttons", () => {
    const { container } = renderPage(baseSettings, vi.fn());
    const row = container.querySelector(".fallback-row")!;
    // One line means the index and the controls live beside the picker, not above it.
    expect(row.querySelector(".fallback-index")?.textContent).toBe("1");
    const children = Array.from(row.children).map((el) => el.tagName.toLowerCase());
    expect(children).toEqual(["span", "select", "div"]);
    expect(row.querySelector("select.fallback-select")).toBeTruthy();
    expect(row.querySelectorAll(".fallback-actions button")).toHaveLength(3);
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
