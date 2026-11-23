// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  textSizePx: 14,
  themeStyle: "graphite" as const,
  onSetThemeStyle: vi.fn(),
  onSetTextSize: vi.fn(),
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

describe("Settings > Customization > Appearance", () => {
  it("resets the window state from the button", () => {
    const onResetWindowState = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        onResetWindowState={onResetWindowState}
        initialPage="customization"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset window state/i }));

    expect(onResetWindowState).toHaveBeenCalledTimes(1);
  });
});

describe("Settings font family", () => {
  it("offers the four faces, system first, and picks one from the menu", () => {
    const onSetFontFamily = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        onSetFontFamily={onSetFontFamily}
        initialPage="customization"
      />,
    );

    const button = screen.getByRole("button", { name: "Font family" });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    const rows = Array.from(document.querySelectorAll(".font-family-menu [role='menuitemradio']"));
    expect(rows.map((row) => row.textContent)).toEqual(["System", "Sans", "Serif", "Custom"]);

    fireEvent.click(rows[2]!);

    expect(onSetFontFamily).toHaveBeenCalledWith("serif");
    // Picking closes the menu and hands focus back to the control.
    expect(document.querySelector(".font-family-menu")).toBeNull();
  });
});

describe("Settings > Customization > Themes", () => {
  it("lists every style once and marks the one in force", () => {
    const onSetThemeStyle = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        themeStyle="obsidian"
        onSetThemeStyle={onSetThemeStyle}
        initialPage="customization"
      />,
    );

    const cards = Array.from(document.querySelectorAll(".theme-grid [aria-checked]"));
    expect(cards).toHaveLength(15);
    expect(cards.every((card) => card.getAttribute("role") === "radio")).toBe(true);
    expect(new Set(cards.map((card) => card.getAttribute("data-style"))).size).toBe(15);
    // Light styles come first, then dark: the label each card carries is the split.
    const groups = cards.map((card) => card.querySelector(".md")?.textContent);
    expect(groups).toEqual([...Array(8).fill("light"), ...Array(7).fill("dark")]);
    expect(cards.filter((card) => card.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(
      cards
        .find((card) => card.getAttribute("aria-checked") === "true")
        ?.getAttribute("data-style"),
    ).toBe("obsidian");

    fireEvent.click(cards.find((card) => card.getAttribute("data-style") === "sandstone")!);
    expect(onSetThemeStyle).toHaveBeenCalledWith("sandstone");
  });
});

describe("Settings > About", () => {
  it("holds the version, the shortcut list and the changelog as one page's sections", () => {
    render(<SettingsModal {...baseProps} initialPage="about" />);

    const sections = Array.from(document.querySelectorAll(".settings-body [data-section]")).map(
      (section) => section.getAttribute("data-section"),
    );
    expect(sections).toEqual(["version", "shortcuts", "changelog"]);

    // The version section speaks the settings vocabulary: one row per fact, label left.
    const version = document.querySelector<HTMLElement>('[data-section="version"]');
    expect(version).toBeTruthy();
    expect(
      Array.from(version?.querySelectorAll(".setting-row .n") ?? []).map((name) =>
        (name.textContent ?? "").trim(),
      ),
    ).toEqual(["Installed version", "Repository", "Updates"]);
    expect(within(version as HTMLElement).getByText("0.0.0-test")).toBeTruthy();
    expect(
      within(version as HTMLElement).getByRole("button", { name: /Ultikynnys\/ReasonixPlus/ }),
    ).toBeTruthy();
    expect(
      within(version as HTMLElement).getByRole("button", { name: /Check for updates/ }),
    ).toBeTruthy();

    // The other two sections carry the lists that used to be pages of their own.
    expect(screen.getByRole("heading", { name: "Shortcuts" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Changelog" })).toBeTruthy();
  });

  it("is the only place the nav reaches them, since About replaced both pages", () => {
    render(<SettingsModal {...baseProps} initialPage="about" />);

    const nav = Array.from(document.querySelectorAll(".settings-side .row:not(.kid)")).map((row) =>
      (row.textContent ?? "").trim(),
    );
    expect(nav).toContain("About");
    expect(nav).not.toContain("Shortcuts");
    expect(nav).not.toContain("Changelog");

    const index = Array.from(document.querySelectorAll(".settings-side .row.kid")).map((row) =>
      (row.textContent ?? "").trim(),
    );
    expect(index).toEqual(["Version", "Shortcuts", "Changelog"]);
  });
});

describe("Settings section index", () => {
  it("shows a page's index only while that page is open", () => {
    render(<SettingsModal {...baseProps} initialPage="customization" />);
    const parent = screen.getByTitle("Customization");
    const kids = parent.parentElement?.querySelector(".kids");
    expect(kids, "the open page renders no index").toBeTruthy();
    expect(
      Array.from(kids?.querySelectorAll(".row.kid") ?? []).map((row) => row.textContent),
    ).toEqual(["Appearance", "Themes", "Sound cues"]);
    // The category row is reachable and activatable from the keyboard.
    expect(parent.getAttribute("role")).toBe("button");
    expect(parent.getAttribute("tabindex")).toBe("0");
    // No other page shows one: the index belongs to the page it lists.
    expect(document.querySelectorAll(".settings-side .kids")).toHaveLength(1);
    // The page is the page: its title is the page's, not a section's.
    expect(screen.getByRole("heading", { name: "Customization" })).toBeTruthy();
  });

  it("lands each index row on a section of the same page", () => {
    const scrollTo = vi.fn();
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
    try {
      render(<SettingsModal {...baseProps} initialPage="customization" />);
      const rows = Array.from(document.querySelectorAll<HTMLElement>(".settings-side .row.kid"));
      expect(rows).toHaveLength(3);

      for (const row of rows) {
        // Every row must have a section to land on, or the index has a dead entry.
        expect(document.querySelectorAll(".settings-body [data-section]").length).toBe(3);
        fireEvent.click(row);
      }
      expect(scrollTo).toHaveBeenCalledTimes(3);
      expect(scrollTo.mock.calls.map((call) => (call[0] as ScrollToOptions).top)).toEqual([
        0, 0, 0,
      ]);
    } finally {
      Element.prototype.scrollTo = original;
    }
  });
});

describe("Settings frame", () => {
  it("keeps one share of the window, with nothing multiplying it", () => {
    // The type scale is a root font size now, so the frame needs no divisor: it was a `zoom`
    // that made `vw`/`vh` grow with the text. jsdom serves `import.meta.url` over http, so
    // the sheet is located from the test file's own path.
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
    const rule = /\.settings\s*\{([^}]*)\}/.exec(css);
    expect(rule, "styles.css has no .settings rule").not.toBeNull();
    const body = rule?.[1] ?? "";

    expect(body).toMatch(/width:\s*92vw/);
    expect(body).toMatch(/height:\s*90vh/);
    expect(body).not.toMatch(/--ui-zoom/);
    // A px cap or a calc would let something other than the window decide the frame.
    expect(body).not.toMatch(/(width|height):\s*min\(/);
    expect(body).not.toMatch(/(width|height):\s*\d+px/);
    expect(body).not.toMatch(/(width|height):\s*calc\(/);
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

    expect(body).toMatch(/width:\s*100vw/);
    expect(body).toMatch(/height:\s*100vh/);
    expect(body).not.toMatch(/--ui-zoom/);
    expect(body).toMatch(/border-radius:\s*0/);
  });

  it("rides the text size readout above the knob, out of the row's flow", () => {
    const testPath = expect.getState().testPath;
    expect(testPath, "vitest must report the running test file").toBeTruthy();
    const css = readFileSync(resolve(dirname(testPath ?? ""), "../styles.css"), "utf8");
    const readout = /\.text-size-value\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

    // Absolute, anchored to the knob's share of the track, and hidden until the row is used.
    expect(readout).toMatch(/position:\s*absolute/);
    expect(readout).toMatch(/left:\s*clamp\([^)]*var\(--knob/);
    expect(readout).toMatch(/opacity:\s*0/);
    expect(css).toMatch(/\.text-size-control:hover \.text-size-value[\s\S]{0,240}opacity:\s*1/);
    // Not plain focus: a click leaves the slider focused, and the chip would stay up after
    // the pointer left. Keyboard focus still reveals it through `:focus-visible`.
    expect(css).not.toMatch(/:focus-within \.text-size-value/);
    expect(css).toMatch(/input:focus-visible ~ \.text-size-value/);
    // One width token drives the slider, the picker and the reset button, so the three line up.
    expect(css).toMatch(/--settings-control-width:\s*12\.75rem/);
    expect(css).toMatch(
      /\.page-customization \.setting-row \.text-size-control,\s*\n\.page-customization \.setting-row \.font-family-picker \{[\s\S]{0,120}flex:\s*0 0 var\(--settings-control-width\)/,
    );
    expect(css).toMatch(/\.window-reset \{[\s\S]{0,80}width:\s*var\(--settings-control-width\)/);
  });
});
