// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
      {
        name: "seo-analysis",
        description: "Full SEO audit.",
        path: "skills/seo-analysis/SKILL.md",
        root: "skills",
      },
      {
        name: "meta-ads",
        description: "Meta Ads review.",
        path: "skills/meta-ads/SKILL.md",
        root: "skills",
      },
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

function renderPage(
  plugins: PluginInfo[],
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
) {
  const handlers = {
    onInstall: vi.fn(),
    onUninstall: vi.fn(),
    onToggle: vi.fn(),
    onRequest: vi.fn(),
    onConnectServer: vi.fn(),
    onCancelServerSignIn: vi.fn(),
    onDisconnectServer: vi.fn(),
    ...overrides,
  };
  const utils = render(<PagePlugins plugins={plugins} mcpAuth={null} {...handlers} />);
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

  it("insets the skills and server lists on their own darker surface", () => {
    const { container } = renderPage([plugin()]);
    const panels = [...container.querySelectorAll(".plugin-subpanel")];
    // Skills first, servers second: the two sub-sections of one plugin card.
    expect(panels).toHaveLength(2);
    // Only the skills list is clamped, so only it carries the scroll class.
    expect(panels.map((panel) => panel.classList.contains("plugin-subpanel-scroll"))).toEqual([
      true,
      false,
    ]);
    expect(within(panels[1] as HTMLElement).getByText("notfair")).toBeTruthy();
  });

  it("folds a plugin's skills into folder headings, not one row per skill", () => {
    const { container } = renderPage([
      plugin({
        skills: [
          { name: "top-level", description: "Sits at the root.", path: "SKILL.md", root: "" },
          {
            name: "audit",
            description: "Sits under a folder.",
            path: "skills/seo-agent/audit/SKILL.md",
            root: "skills/seo-agent",
          },
          {
            name: "meta-ads",
            description: "Meta Ads review.",
            path: "skills/meta-ads/SKILL.md",
            root: "skills",
          },
        ],
      }),
    ]);
    const roots = [...container.querySelectorAll(".skill-root")].map((el) => el.textContent);
    expect(roots).toEqual(["Plugin root", "skills", "skills/seo-agent"]);
    expect(screen.getByText("Skills (3)")).toBeTruthy();
    expect(screen.getByText("top-level")).toBeTruthy();
    expect(screen.getByText("audit")).toBeTruthy();
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

  it("edits the Settings default from the card, the way an MCP server card does", () => {
    const { onToggle } = renderPage([plugin()]);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(onToggle).toHaveBeenLastCalledWith("notfair", true);
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(onToggle).toHaveBeenLastCalledWith("notfair", false);
  });

  it("marks the segment the stored default selects", () => {
    renderPage([plugin({ disabled: true, active: false })]);
    expect(screen.getByRole("button", { name: "Disable" }).getAttribute("data-on")).toBe("true");
    expect(screen.getByRole("button", { name: "Enable" }).getAttribute("data-on")).toBe("false");
  });

  it("sends the slug of the card that was clicked, not the first one", () => {
    const { onToggle, container } = renderPage([
      plugin({ slug: "notfair", displayName: "NotFair" }),
      plugin({ slug: "other", displayName: "Other" }),
    ]);
    const cards = container.querySelectorAll(".provider-card");
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: "Disable" }));
    expect(onToggle).toHaveBeenLastCalledWith("other", true);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("says a plugin is off by default", () => {
    renderPage([plugin({ disabled: true, active: false })]);
    expect(screen.getByText(/off by default/)).toBeTruthy();
    expect(screen.queryByText(/on in this chat/)).toBeNull();
  });

  it("marks a plugin this chat enabled, and leaves the rest unmarked", () => {
    renderPage([
      plugin({ active: true }),
      plugin({ slug: "other", displayName: "Other", active: false }),
    ]);
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

  it("offers a sign-in on an HTTP server that has none yet", () => {
    const { onConnectServer } = renderPage([
      plugin({
        servers: [
          { name: "notfair", transport: "streamable-http", status: "failed", auth: "none" },
        ],
      }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onConnectServer).toHaveBeenCalledWith("notfair");
  });

  it("shows the stored sign-in and offers sign-out", () => {
    const { onDisconnectServer } = renderPage([
      plugin({
        servers: [
          { name: "notfair", transport: "streamable-http", status: "connected", auth: "connected" },
        ],
      }),
    ]);
    expect(screen.getByText("Signed in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onDisconnectServer).toHaveBeenCalledWith("notfair");
  });

  it("marks an expired sign-in and offers a fresh one", () => {
    renderPage([
      plugin({
        servers: [
          { name: "notfair", transport: "streamable-http", status: "failed", auth: "expired" },
        ],
      }),
    ]);
    expect(screen.getByText("Sign-in expired")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("offers no sign-in for a stdio server", () => {
    renderPage([
      plugin({
        servers: [{ name: "local-tools", transport: "stdio", status: "connected", toolCount: 3 }],
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
