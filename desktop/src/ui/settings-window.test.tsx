// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { MailProvider } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const settings: Settings = {
  version: "1.0.0",
  reasoningEffort: "high",
  editMode: "follow",
  workspaceDir: "/test",
  recentWorkspaces: [],
  model: "deepseek-v4-flash",
  enabledModels: ["deepseek-v4-flash"],
  fallbackModels: [],
};

const baseProps = {
  settings,
  fontScale: "medium" as const,
  onSetFontScale: vi.fn(),
  fontFamily: "sans" as const,
  onSetFontFamily: vi.fn(),
  customFontFamily: "",
  onSetCustomFontFamily: vi.fn(),
  onResetWindowState: vi.fn(),
  mcpSpecs: [],
  mcpBridged: false,
  plugins: [],
  onInstallPlugin: vi.fn(),
  onUninstallPlugin: vi.fn(),
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
  oauthWaiting: false,
  onOAuthBegin: vi.fn(),
  onOAuthCancel: vi.fn(),
  onOAuthSignOut: vi.fn(),
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
  onTogglePlugin: vi.fn(),
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

afterEach(cleanup);

describe("Settings > General window state", () => {
  it("resets the window state from the button", () => {
    const onResetWindowState = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        onResetWindowState={onResetWindowState}
        initialPage="general"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset window state/i }));

    expect(onResetWindowState).toHaveBeenCalledTimes(1);
  });
});

describe("Settings frame", () => {
  it("keeps one share of the window at every font scale", () => {
    // The font scale is a `zoom` on the root, which multiplies `vw` and `vh` too. Without
    // dividing it back out the same window showed three frames: 840x563 at small, 960x643
    // at medium, 1080x724 at large. jsdom serves `import.meta.url` over http, so the sheet
    // is located from the test file's own path.
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
    const rule = /\.settings\s*\{([^}]*)\}/.exec(css);
    expect(rule, "styles.css has no .settings rule").not.toBeNull();
    const body = rule?.[1] ?? "";

    expect(body).toMatch(/width:\s*calc\(92vw\s*\/\s*var\(--ui-zoom,\s*1\)\)/);
    expect(body).toMatch(/height:\s*calc\(90vh\s*\/\s*var\(--ui-zoom,\s*1\)\)/);
    // A px cap is what made the frame follow the font scale.
    expect(body).not.toMatch(/(width|height):\s*min\(/);
    expect(body).not.toMatch(/(width|height):\s*\d+px/);
  });

  it("gives the category nav a fixed column, not a share of the frame", () => {
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
    const body = /\.settings\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    // A share of the frame would shrink the nav with the window; the panel gives way instead.
    expect(body).toMatch(/grid-template-columns:\s*224px\s+minmax\(0,\s*1fr\)/);
    expect(body).not.toMatch(/grid-template-columns:\s*\d+%/);
  });

  it("drops the margins when the window is narrower than 70% of the screen", () => {
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
    const rule = /\.settings\[data-full\]\s*\{([^}]*)\}/.exec(css);
    expect(rule, "styles.css has no full-bleed rule").not.toBeNull();
    const body = rule?.[1] ?? "";

    expect(body).toMatch(/width:\s*calc\(100vw\s*\/\s*var\(--ui-zoom,\s*1\)\)/);
    expect(body).toMatch(/height:\s*calc\(100vh\s*\/\s*var\(--ui-zoom,\s*1\)\)/);
    expect(body).toMatch(/border-radius:\s*0/);
  });
});
