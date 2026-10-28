// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../protocol";
import { PagePlugins } from "./settings";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

afterEach(cleanup);

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    slug: "notfair",
    name: "notfair",
    displayName: "NotFair",
    category: "Productivity",
    version: "0.27.17",
    description: "Ads, analytics, SEO and GEO skills.",
    author: "NotFair",
    license: "MIT",
    source: "https://github.com/nowork-studio/notfair-plugin",
    capabilities: ["Interactive", "Write"],
    defaultPrompt: ["Audit my Google Ads account."],
    active: true,
    skills: [
      { name: "seo-analysis", description: "Full SEO audit.", path: "skills/seo-analysis/SKILL.md" },
      { name: "meta-ads", description: "Meta Ads review.", path: "skills/meta-ads/SKILL.md" },
    ],
    servers: [
      {
        name: "notfair",
        transport: "streamable-http",
        status: "connected",
        toolCount: 12,
      },
    ],
    ...overrides,
  };
}

function renderPage(plugins: PluginInfo[], overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const handlers = {
    onInstall: vi.fn(),
    onUninstall: vi.fn(),
    onRequest: vi.fn(),
    ...overrides,
  };
  const utils = render(<PagePlugins plugins={plugins} {...handlers} />);
  return { ...utils, ...handlers };
}

describe("PagePlugins", () => {
  it("asks the daemon for the inventory when it opens", () => {
    const { onRequest } = renderPage([]);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("explains the empty state", () => {
    renderPage([]);
    expect(screen.getByText(/No plugin installed yet/)).toBeTruthy();
    expect(screen.getByText("Installed plugins (0)")).toBeTruthy();
  });

  it("renders a plugin's category, skills and server state", () => {
    renderPage([plugin()]);
    expect(screen.getByText("NotFair")).toBeTruthy();
    expect(screen.getByText(/Productivity - 0\.27\.17/)).toBeTruthy();
    expect(screen.getByText("Ads, analytics, SEO and GEO skills.")).toBeTruthy();
    expect(screen.getByText("Skills (2)")).toBeTruthy();
    expect(screen.getByText("seo-analysis")).toBeTruthy();
    expect(screen.getByText("Full SEO audit.")).toBeTruthy();
    expect(screen.getByText("MCP servers (1)")).toBeTruthy();
    expect(screen.getByText("server connected · 12 tools live")).toBeTruthy();
    expect(screen.getByText(/github\.com\/nowork-studio\/notfair-plugin/)).toBeTruthy();
  });

  it("installs from the source field", () => {
    const { onInstall } = renderPage([]);
    const field = screen.getByLabelText("Source");
    fireEvent.change(field, { target: { value: "  nowork-studio/notfair-plugin  " } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(onInstall).toHaveBeenCalledWith("nowork-studio/notfair-plugin");
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("keeps the install button disabled until a source is typed", () => {
    renderPage([]);
    const button = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("removes the installed plugin by slug", () => {
    const { onUninstall } = renderPage([plugin()]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onUninstall).toHaveBeenCalledWith("notfair");
  });

  it("marks a plugin this chat enabled, and leaves the rest unmarked", () => {
    renderPage([plugin({ active: true }), plugin({ slug: "other", displayName: "Other", active: false })]);
    expect(screen.getAllByText(/on in this chat/)).toHaveLength(1);
  });

  it("says that enablement is chosen per chat", () => {
    renderPage([]);
    expect(screen.getByText(/chosen when that chat starts/)).toBeTruthy();
  });

  it("shows a manifest error instead of hiding the card", () => {
    renderPage([plugin({ error: "no .codex-plugin/plugin.json or plugin.json" })]);
    expect(screen.getByText(/manifest error: no \.codex-plugin/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("says when a plugin ships nothing", () => {
    renderPage([plugin({ skills: [], servers: [] })]);
    expect(screen.getByText("This plugin ships no skills.")).toBeTruthy();
    expect(screen.getByText("This plugin declares no MCP servers.")).toBeTruthy();
  });
});
