// @vitest-environment jsdom

import { PROVIDER_SPECS, SEARCH_ENGINE_SPECS, providerDeclared } from "@reasonix/core-utils";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../App";
import { t } from "../i18n";
import { MailProvider } from "../protocol";
import type {
  McpExtensionStatus,
  PlaywrightManagedBrowser,
  PlaywrightManagedBrowserInstallState,
} from "../protocol";
import { PLAYWRIGHT_MANAGED_BROWSERS } from "../protocol";
import { SettingsModal } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

/** Extension status carrying one managed build's install state, for the gated picker. */
function extensionStatusWith(
  browser: PlaywrightManagedBrowser,
  state: PlaywrightManagedBrowserInstallState["state"],
): McpExtensionStatus {
  return {
    storeUrl: "https://chromewebstore.google.com/detail/playwright-extension",
    server: {
      configured: false,
      mode: "chromium",
      hasExtensionArg: false,
      tokenPrefix: undefined,
      args: [],
    },
    installs: PLAYWRIGHT_MANAGED_BROWSERS.map((entry) => ({
      browser: entry,
      state: entry === browser ? state : entry === "msedge" ? "system" : "installed",
    })),
  };
}

/** A model card is identified by the value it toggles, not by its label: the
 *  label drops the provider prefix its card already names. */
function modelCard(container: HTMLElement, value: string): HTMLElement | null {
  return container.querySelector(`.mcard[data-model="${value}"]`);
}

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

  it("offers only API-key fields: a provider's base URL lives in JSON", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="models" />);
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    // An endpoint is declared in the provider file, so no card offers an input for it.
    expect(container.querySelectorAll(".setting-row-base-url")).toHaveLength(0);
    const declaredKeys = PROVIDER_SPECS.reduce(
      (count, spec) => count + spec.settings.filter((setting) => setting.kind === "secret").length,
      0,
    );
    expect(container.querySelectorAll(".setting-row-entry")).toHaveLength(declaredKeys);
  });

  it("uses stacked Save-only API key entries and refreshes catalogs without a button", () => {
    const onSave = vi.fn();
    const onRefreshOpencodeModels = vi.fn();
    const onRefreshOllamaModels = vi.fn();
    const onRefreshProviderCatalogs = vi.fn();
    const { container } = render(
      <SettingsModal
        {...baseProps}
        initialPage="models"
        onSave={onSave}
        onRefreshOpencodeModels={onRefreshOpencodeModels}
        onRefreshOllamaModels={onRefreshOllamaModels}
        onRefreshProviderCatalogs={onRefreshProviderCatalogs}
      />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(inputs.length).toBeGreaterThan(2);
    for (const input of inputs) {
      const row = input.closest(".setting-row-entry") as HTMLElement;
      expect(row).toBeTruthy();
      expect(row.firstElementChild?.className).toBe("l");
      expect(within(row).queryByRole("button", { name: "Clear" })).toBeNull();
      onSave.mockClear();
      fireEvent.click(within(row).getByRole("button", { name: "Save" }));
      const [patch] = onSave.mock.calls[0] as [
        { providerSettings?: Record<string, Record<string, string>> },
      ];
      expect(Object.values(patch.providerSettings ?? {})).toEqual([{ apiKey: "" }]);
    }
    // Opening the page re-queries every live catalog, so no card needs a button for it.
    expect(onRefreshOpencodeModels).toHaveBeenCalledTimes(1);
    expect(onRefreshOllamaModels).toHaveBeenCalledTimes(1);
    expect(onRefreshProviderCatalogs).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sync models" })).toBeNull();
  });

  it("renders and saves a declared key field for every provider that declares one", () => {
    const keyProviders = PROVIDER_SPECS.filter((spec) =>
      spec.settings.some((setting) => setting.kind === "secret"),
    );
    // No declared provider means nothing to render; the page shows its empty state.
    if (keyProviders.length === 0) return;
    const onSave = vi.fn();
    const { container } = render(
      <SettingsModal {...baseProps} onSave={onSave} initialPage="models" />,
    );
    for (const button of container.querySelectorAll<HTMLButtonElement>(".provider-head")) {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    }
    for (const spec of keyProviders) {
      const setting = spec.settings.find((candidate) => candidate.kind === "secret");
      if (!setting) continue;
      const label = setting.label ?? "";
      const card = Array.from(container.querySelectorAll(".provider-card")).find((candidate) =>
        candidate.textContent?.includes(label),
      );
      // A provider the picker hides may own no card; every other one must round-trip.
      if (!card) continue;
      expect(card.querySelectorAll(".setting-row-base-url")).toHaveLength(0);
      const input = card.querySelector('input[type="password"]') as HTMLInputElement;
      onSave.mockClear();
      fireEvent.change(input, { target: { value: "  declared-secret  " } });
      fireEvent.click(
        within(card as HTMLElement).getAllByRole("button", { name: "Save" })[0] as HTMLElement,
      );
      const [patch] = onSave.mock.calls[0] as [
        { providerSettings?: Record<string, Record<string, string>> },
      ];
      expect(Object.keys(patch.providerSettings ?? {})).toEqual([spec.id]);
      expect(Object.values(patch.providerSettings?.[spec.id] ?? {})).toEqual(["declared-secret"]);
    }
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
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "gpt-5.6-sol",
      "deepseek-v4-pro",
    ]);
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

  it("renders a whole live catalog without dropping rows", () => {
    // A discovery sync can list hundreds of ids (OpenRouter, the Experiential gateway).
    // Every one of them stays toggleable: the list only defers measuring labels.
    const catalog = Array.from({ length: 300 }, (_, index) => `gateway-model-${index}`);
    const { container } = render(
      <SettingsModal
        {...baseProps}
        settings={
          {
            ...baseSettings,
            enabledModels: catalog,
            providerCatalogs: { experiential: { models: catalog, source: "live" } },
          } as Settings
        }
        initialPage="models"
      />,
    );
    const head = Array.from(container.querySelectorAll<HTMLButtonElement>(".provider-head")).find(
      (button) => button.textContent?.includes("Experiential Labs"),
    );
    fireEvent.click(head!);
    const column = head?.closest(".provider-card")?.querySelector(".provider-col");
    // The card also keeps the provider's declared ids, so the live list is a floor.
    expect(column?.querySelectorAll(".mcard").length).toBeGreaterThanOrEqual(catalog.length);
    for (const id of ["gateway-model-0", "gateway-model-299"]) {
      expect(column?.querySelector(`.mcard[data-model="${id}"]`)).toBeTruthy();
    }
  });

  it("lists a provider's models without repeating the provider in each row", () => {
    const { container } = render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, enabledModels: ["ollama/beam"] }}
        ollamaModels={["beam", "clef:27b"]}
        initialPage="models"
      />,
    );
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });

    // The Ollama card is titled by the provider, so its rows drop the `ollama/` scheme.
    const row = modelCard(container, "ollama/clef:27b");
    expect(row?.querySelector(".model-name")?.textContent).toBe("clef:27b");
    const names = Array.from(container.querySelectorAll(".mcard .model-name")).map(
      (name) => name.textContent,
    );
    expect(names).not.toContain("ollama/clef:27b");
  });

  it("shows a hub id's own name, keeping the wire id on hover", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="models" />);
    container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
      if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
    });

    // Synthetic serves `hf:<owner>/<model>` and `syn:<tier>` ids: the label keeps the
    // model's own name, and the id it toggles stays one hover away.
    const row = modelCard(container, "hf:Qwen/Qwen3.8-27B");
    const label = row?.querySelector(".model-name");
    expect(label?.textContent).toBe("Qwen3.8-27B");
    expect(label?.getAttribute("title")).toBe("hf:Qwen/Qwen3.8-27B");
    expect(modelCard(container, "syn:large:text")?.querySelector(".model-name")?.textContent).toBe(
      "Large (text)",
    );
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

    const native = modelCard(container, "mimo-v2.6-pro");
    const qualified = modelCard(container, "opencode/mimo-v2.6-pro");
    expect(native).toBeTruthy();
    expect(qualified).toBeTruthy();
    // Each card names its own provider, so a row never repeats the prefix.
    expect(native?.querySelector(".model-name")?.textContent).toBe("mimo-v2.6-pro");
    expect(qualified?.querySelector(".model-name")?.textContent).toBe("mimo-v2.6-pro");

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

  it.skipIf(!providerDeclared("experiential"))(
    "toggles two later providers' shared id independently",
    () => {
      const onSave = vi.fn();
      const { container } = render(
        <SettingsModal
          {...baseProps}
          settings={{
            ...baseSettings,
            enabledModels: ["deepseek-v4.1-flash", "experiential/deepseek-v4.1-flash"],
            providerCatalogs: {
              experiential: { models: ["deepseek-v4.1-flash"], source: "live" },
            },
          }}
          opencodeModels={["deepseek-v4.1-flash"]}
          onSave={onSave}
          initialPage="models"
        />,
      );
      container.querySelectorAll<HTMLButtonElement>(".provider-head").forEach((button) => {
        if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
      });

      const opencodeRow = modelCard(container, "deepseek-v4.1-flash");
      const experientialRow = modelCard(container, "experiential/deepseek-v4.1-flash");
      expect(opencodeRow).toBeTruthy();
      expect(experientialRow).toBeTruthy();
      expect(
        within(opencodeRow as HTMLElement).getByRole("button", { name: "Disable" }),
      ).toBeTruthy();

      // Disabling the Experimental Labs row must leave the OpenCode row enabled.
      fireEvent.click(
        within(experientialRow as HTMLElement).getByRole("button", { name: "Disable" }),
      );
      expect(onSave).toHaveBeenCalledWith({ enabledModels: ["deepseek-v4.1-flash"] });
    },
  );

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

describe("Search tab", () => {
  afterEach(cleanup);

  it("renders the selected engine's declared fields", () => {
    const onSave = vi.fn();
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, webSearchEngine: "tavily" }}
        onSave={onSave}
        initialPage="search"
      />,
    );
    expect(screen.getByText("Tavily API key")).toBeTruthy();
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  tv-secret  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ searchSettings: { tavily: { apiKey: "tv-secret" } } });
  });

  it("shows a pointer note and no key input for an engine that reuses a provider key", () => {
    render(
      <SettingsModal
        {...baseProps}
        settings={{
          ...baseSettings,
          webSearchEngine: "zai",
          providerSettings: { zai: { apiKey: "z•••key" } },
        }}
        initialPage="search"
      />,
    );
    // The key is the model provider's: one variable, one input, on the Models tab.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText(/Models tab/)).toBeTruthy();
  });

  it("renders the SearXNG endpoint from the declaration", () => {
    render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, webSearchEngine: "searxng" }}
        initialPage="search"
      />,
    );
    expect(screen.getByText("SearXNG endpoint")).toBeTruthy();
    const input = document.querySelector(".setting-row-base-url input") as HTMLInputElement;
    expect(input.placeholder).toBe("http://localhost:8080");
  });

  const searchCards = (container: HTMLElement): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(".provider-card"));

  const cardFor = (container: HTMLElement, id: string): HTMLElement =>
    searchCards(container)[SEARCH_ENGINE_SPECS.findIndex((spec) => spec.id === id)]!;

  it("renders one card per declared engine, titled from the declarations", () => {
    const { container } = render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, webSearchEngine: "tavily" }}
        initialPage="search"
      />,
    );
    const titles = Array.from(container.querySelectorAll(".provider-head .provider-title"));
    expect(titles.map((title) => title.textContent)).toEqual(
      SEARCH_ENGINE_SPECS.map((spec) => spec.label),
    );
  });

  it("marks the active engine in its header and expands only that card", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="search" />);
    const bing = cardFor(container, "bing");
    // bing is the default engine: marked active, switch-to-self offered nowhere, card open.
    expect(within(bing).getByText("✓ Active")).toBeTruthy();
    expect(within(bing).queryByRole("button", { name: "Use this engine" })).toBeNull();
    expect(
      within(bing).getByText("No setup needed: this engine works without a key or endpoint."),
    ).toBeTruthy();
    // Every other engine's fields stay collapsed until its card is expanded.
    expect(screen.getAllByText("✓ Active")).toHaveLength(1);
    expect(container.querySelectorAll(".provider-body")).toHaveLength(1);
  });

  it("switches the active engine from another engine's card", () => {
    const onSave = vi.fn();
    const { container } = render(
      <SettingsModal {...baseProps} onSave={onSave} initialPage="search" />,
    );
    const bingIntl = cardFor(container, "bing-intl");
    fireEvent.click(within(bingIntl).getByRole("button", { name: "Use this engine" }));
    expect(onSave).toHaveBeenCalledWith({ webSearchEngine: "bing-intl" });
  });

  it("keeps a keyed engine unselectable until its key is set", () => {
    const { container } = render(<SettingsModal {...baseProps} initialPage="search" />);
    const tavily = cardFor(container, "tavily");
    const use = within(tavily).getByRole("button", { name: "Use this engine" });
    expect((use as HTMLButtonElement).disabled).toBe(true);
    expect(use.getAttribute("title")).toBe("Set this engine's key first");
    cleanup();

    const keyed = render(
      <SettingsModal
        {...baseProps}
        settings={{ ...baseSettings, searchSettings: { tavily: { apiKey: "tv-secret" } } }}
        initialPage="search"
      />,
    );
    const ready = within(cardFor(keyed.container, "tavily")).getByRole("button", {
      name: "Use this engine",
    });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a browser-driven engine unselectable until its managed build exists", () => {
    const missing = render(
      <SettingsModal
        {...baseProps}
        mcpExtensionStatus={extensionStatusWith("webkit", "missing")}
        initialPage="search"
      />,
    );
    const blocked = within(cardFor(missing.container, "playwright-webkit")).getByRole("button", {
      name: "Use this engine",
    });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    expect(blocked.getAttribute("title")).toBe("Install Managed WebKit on the MCP page first");
    cleanup();

    const installed = render(
      <SettingsModal
        {...baseProps}
        mcpExtensionStatus={extensionStatusWith("webkit", "installed")}
        initialPage="search"
      />,
    );
    const ready = within(cardFor(installed.container, "playwright-webkit")).getByRole("button", {
      name: "Use this engine",
    });
    expect((ready as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the engine card that becomes active", () => {
    function StatefulSearch() {
      const [settings, setSettings] = useState<Settings>(baseSettings);
      return (
        <SettingsModal
          {...baseProps}
          settings={settings}
          // A patch only carries keys it changes, so the merge is the state type;
          // asserted here because an empty declaration set widens the patch maps.
          onSave={(patch) => setSettings((current) => ({ ...current, ...patch }) as Settings)}
          initialPage="search"
        />
      );
    }

    const { container } = render(<StatefulSearch />);
    // Collapsed until it is chosen, then opened onto its own fields.
    expect(within(cardFor(container, "bing-intl")).queryByText(/No setup needed/)).toBeNull();
    fireEvent.click(
      within(cardFor(container, "bing-intl")).getByRole("button", { name: "Use this engine" }),
    );
    expect(within(cardFor(container, "bing-intl")).getByText("✓ Active")).toBeTruthy();
    expect(within(cardFor(container, "bing-intl")).getByText(/No setup needed/)).toBeTruthy();
  });

  it("expands an engine card without switching the active engine", () => {
    const onSave = vi.fn();
    const { container } = render(
      <SettingsModal {...baseProps} onSave={onSave} initialPage="search" />,
    );
    const tavily = cardFor(container, "tavily");
    fireEvent.click(within(tavily).getByRole("button", { name: "Tavily" }));
    expect(within(tavily).getByText("Tavily API key")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("declared-empty settings surfaces", () => {
  const PROVIDERS_BARREL = "../../../packages/core-utils/src/providers.generated.js";
  const ENGINES_BARREL = "../../../packages/core-utils/src/search-engines.generated.js";

  afterEach(() => {
    vi.doUnmock(PROVIDERS_BARREL);
    vi.doUnmock(ENGINES_BARREL);
    vi.resetModules();
    cleanup();
  });

  /** Makes every barrel empty for the next dynamic import. */
  function mockEmptyDeclarations(): void {
    vi.resetModules();
    vi.doMock(PROVIDERS_BARREL, async () => ({
      ...(await vi.importActual<Record<string, unknown>>(PROVIDERS_BARREL)),
      PROVIDER_DOCUMENTS: [],
      PROVIDER_IDS: [],
    }));
    vi.doMock(ENGINES_BARREL, async () => ({
      ...(await vi.importActual<Record<string, unknown>>(ENGINES_BARREL)),
      SEARCH_ENGINE_DOCUMENTS: [],
      SEARCH_ENGINE_NAMES: [],
    }));
  }

  /** Renders the modal against empty barrels: a tree with no declarations at all. */
  async function renderWithNoDeclarations(page: "models" | "search") {
    mockEmptyDeclarations();
    const { SettingsModal: EmptyDeclarationsSettings } = await import("./settings");
    return render(<EmptyDeclarationsSettings {...baseProps} initialPage={page} />);
  }

  it("tells the user where to add a provider when none is declared", async () => {
    const { container } = await renderWithNoDeclarations("models");
    expect(container.textContent).toContain(t("settings.noProvidersDeclared"));
  });

  it("tells the user where to add an engine when none is declared", async () => {
    const { container } = await renderWithNoDeclarations("search");
    expect(container.textContent).toContain(t("settings.noSearchEnginesDeclared"));
  });

  it("tells the user no model is available in the shared picker", async () => {
    mockEmptyDeclarations();
    const { ModelList } = await import("./composer");
    const { container } = render(<ModelList activeModel="" onPick={() => {}} />);
    expect(container.textContent).toContain(t("settings.modelListEmpty"));
  });
});
