/** Playwright MCP extension — store URL, server-entry merge, status computation. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT_MANAGED_BROWSERS } from "@reasonix/core-utils";
import { describe, expect, it } from "vitest";
import { computeMcpExtensionStatus, interpretExtensionCheck } from "../src/cli/commands/desktop.js";
import { type ReasonixConfig, mergeMcpServerEntry, normalizeMcpConfig } from "../src/config.js";
import {
  DEFAULT_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT_MS,
  DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST,
  PLAYWRIGHT_BACKUP_DOWNLOAD_HOST,
  PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT_ENV,
  PLAYWRIGHT_DOWNLOAD_HOST_ENV,
  PLAYWRIGHT_DOWNLOAD_SOURCES,
  PLAYWRIGHT_EXTENSION_STORE_URL,
  PLAYWRIGHT_EXTENSION_TOKEN_ENV,
  carryOverLegacyManagedProfile,
  configurePlaywrightArgs,
  createPlaywrightProgressParser,
  installFromPlaywrightDownloadSources,
  isPlaywrightBrowserInstalled,
  isPlaywrightDownloadableBrowser,
  normalizeExtensionToken,
  parsePlaywrightConnection,
  parsePlaywrightDownloadProgress,
  playwrightBrowserInstallArgs,
  playwrightBrowserInstallEnv,
  playwrightInstallSources,
  playwrightWorkspaceProfileDir,
  resolvePlaywrightBrowsersDir,
  withPlaywrightWorkspaceProfile,
} from "../src/mcp/extension.js";
import { resolvePlaywrightTemplatePath } from "../src/mcp/playwright-tooling.js";
import { SILENCE_MEDIA } from "../src/tools/browser-search.js";

describe("Playwright extension store", () => {
  it("always points at the official Chrome Web Store listing", () => {
    expect(PLAYWRIGHT_EXTENSION_STORE_URL).toMatch(/^https:\/\/chromewebstore\.google\.com\//);
    expect(PLAYWRIGHT_EXTENSION_STORE_URL).toContain("mmlmfjhmonkocbjadbfplnigmagldckm");
  });
});

describe("mergeMcpServerEntry", () => {
  it("creates the entry when the name exists nowhere in config", () => {
    const cfg: ReasonixConfig = {};
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    expect(cfg.mcpServers?.playwright).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    const spec = normalizeMcpConfig(cfg).find((s) => s.name === "playwright")!;
    expect(spec.transport).toBe("stdio");
  });

  it("migrates a legacy spec-string entry and unions the args", () => {
    const cfg: ReasonixConfig = { mcp: ["playwright=npx -y @playwright/mcp"] };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    expect(cfg.mcp).toBeUndefined();
    expect(cfg.mcpServers?.playwright?.args).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("preserves a user's custom args and appends only the missing ones", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp@0.0.80", "--caps"],
        },
      },
    };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    });
    const entry = cfg.mcpServers?.playwright!;
    // User's args keep their order; only --extension is appended.
    expect(entry.args).toEqual(["-y", "@playwright/mcp@0.0.80", "--caps", "--extension"]);
    // Command/url untouched when already present.
    expect(entry.command).toBe("npx");
  });

  it("is idempotent — re-merging the same args adds no duplicates", () => {
    const cfg: ReasonixConfig = {};
    const partial = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    } as const;
    mergeMcpServerEntry(cfg, "playwright", partial);
    mergeMcpServerEntry(cfg, "playwright", partial);
    expect(cfg.mcpServers?.playwright?.args).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("fills missing env keys per-key and never clobbers stored ones", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          env: { [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "stored-token" },
        },
      },
    };
    mergeMcpServerEntry(cfg, "playwright", {
      transport: "stdio",
      command: "npx",
      args: ["--extension"],
      env: { OTHER_VAR: "x" },
    });
    expect(cfg.mcpServers?.playwright?.env).toEqual({
      [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "stored-token",
      OTHER_VAR: "x",
    });
  });
});

describe("playwrightBrowserInstallArgs", () => {
  it.each(PLAYWRIGHT_MANAGED_BROWSERS)(
    "builds the official managed-browser installer for %s",
    (browser) => {
      expect(playwrightBrowserInstallArgs(browser)).toEqual([
        "-y",
        "@playwright/mcp",
        "install-browser",
        browser,
      ]);
    },
  );

  it("preserves a safe pinned package and rejects non-managed values", () => {
    expect(playwrightBrowserInstallArgs("firefox", "@playwright/mcp@0.0.80")).toEqual([
      "-y",
      "@playwright/mcp@0.0.80",
      "install-browser",
      "firefox",
    ]);
    expect(() => playwrightBrowserInstallArgs("extension")).toThrow(/unsupported/);
    expect(() => playwrightBrowserInstallArgs("firefox && calc")).toThrow(/unsupported/);
  });
});

describe("Playwright browser download", () => {
  it("hardcodes timeout and source instead of trusting user environment overrides", () => {
    expect(PLAYWRIGHT_DOWNLOAD_SOURCES).toEqual([
      { source: "official", host: DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST },
      { source: "backup", host: PLAYWRIGHT_BACKUP_DOWNLOAD_HOST },
    ]);
    expect(
      playwrightBrowserInstallEnv(
        {
          OTHER_VAR: "x",
          [PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT_ENV]: "60000",
          [PLAYWRIGHT_DOWNLOAD_HOST_ENV]: "https://user-source.example.com",
        },
        PLAYWRIGHT_BACKUP_DOWNLOAD_HOST,
      ),
    ).toEqual({
      OTHER_VAR: "x",
      [PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT_ENV]: String(
        DEFAULT_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT_MS,
      ),
      [PLAYWRIGHT_DOWNLOAD_HOST_ENV]: PLAYWRIGHT_BACKUP_DOWNLOAD_HOST,
    });
  });

  it("tries the official source first and exposes the backup retry", async () => {
    const attempted: string[] = [];
    const result = await installFromPlaywrightDownloadSources(
      "firefox",
      async ({ source, host }) => {
        attempted.push(source);
        return source === "official" ? "network timeout" : null;
      },
    );
    expect(attempted).toEqual(["official", "backup"]);
    expect(result).toEqual({
      ok: true,
      failures: [`official source (${DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST}): network timeout`],
    });
  });

  it("retains diagnostics from both sources when neither succeeds", async () => {
    const result = await installFromPlaywrightDownloadSources("chromium", async ({ source }) => {
      return `${source} failed`;
    });
    expect(result).toEqual({
      ok: false,
      failures: [
        `official source (${DEFAULT_PLAYWRIGHT_DOWNLOAD_HOST}): official failed`,
        `backup source (${PLAYWRIGHT_BACKUP_DOWNLOAD_HOST}): backup failed`,
      ],
    });
  });

  it("parses Playwright non-TTY progress output", () => {
    expect(parsePlaywrightDownloadProgress("|■■■■                    |  30% of 91.2 MiB")).toEqual({
      downloadedBytes: Math.round((91.2 * 1024 * 1024 * 30) / 100),
      totalBytes: Math.round(91.2 * 1024 * 1024),
      percent: 30,
    });
    expect(parsePlaywrightDownloadProgress("Downloading Firefox")).toBeNull();
  });

  it("parses progress across arbitrary output chunks and flushes a final line", () => {
    const progress: Array<{ downloadedBytes: number; totalBytes: number; percent: number }> = [];
    const parser = createPlaywrightProgressParser((value) => progress.push(value));
    parser.push("Downloading Firefox\n|■■■■");
    parser.push("    |  50% of 2 MiB\nextracting\n|■■■■■■■■| 100% of 2 MiB");
    parser.flush();
    expect(progress).toEqual([
      { downloadedBytes: 1024 * 1024, totalBytes: 2 * 1024 * 1024, percent: 50 },
      { downloadedBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024, percent: 100 },
    ]);
  });
});

describe("managed profile carry-over", () => {
  const profilePath = (ws: string, ...parts: string[]) =>
    join(ws, ".reasonix", "playwright", "profiles", ...parts);

  const seedProfile = (ws: string, dir: string, marker = "signed-in") => {
    mkdirSync(profilePath(ws, dir, "Default"), { recursive: true });
    writeFileSync(profilePath(ws, dir, "Default", "Cookies"), marker);
  };

  it("moves a legacy chrome profile onto chromium so cookies and extensions survive", () => {
    const ws = mkdtempSync(join(tmpdir(), "reasonix-ws-"));
    seedProfile(ws, "chrome");
    carryOverLegacyManagedProfile(ws, "chromium");
    expect(readFileSync(profilePath(ws, "chromium", "Default", "Cookies"), "utf8")).toBe(
      "signed-in",
    );
    expect(existsSync(profilePath(ws, "chrome"))).toBe(false);
  });

  it("never clobbers a chromium profile that already exists", () => {
    const ws = mkdtempSync(join(tmpdir(), "reasonix-ws-"));
    seedProfile(ws, "chrome", "legacy");
    seedProfile(ws, "chromium", "current");
    carryOverLegacyManagedProfile(ws, "chromium");
    expect(readFileSync(profilePath(ws, "chromium", "Default", "Cookies"), "utf8")).toBe("current");
    expect(readFileSync(profilePath(ws, "chrome", "Default", "Cookies"), "utf8")).toBe("legacy");
  });

  it("leaves other managed profiles and unknown workspaces untouched", () => {
    const ws = mkdtempSync(join(tmpdir(), "reasonix-ws-"));
    seedProfile(ws, "chrome");
    carryOverLegacyManagedProfile(ws, "msedge");
    carryOverLegacyManagedProfile(ws, "firefox");
    expect(existsSync(profilePath(ws, "chrome", "Default", "Cookies"))).toBe(true);
    expect(existsSync(profilePath(ws, "chromium"))).toBe(false);
    expect(() => carryOverLegacyManagedProfile(undefined, "chromium")).not.toThrow();
  });

  it("carries the profile over when a legacy chrome spec is prepared for launch", () => {
    const ws = mkdtempSync(join(tmpdir(), "reasonix-ws-"));
    seedProfile(ws, "chrome");
    const spec = withPlaywrightWorkspaceProfile(
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--browser=chrome"],
      },
      ws,
    );
    expect(spec.args).toContain("--browser=chromium");
    expect(readFileSync(profilePath(ws, "chromium", "Default", "Cookies"), "utf8")).toBe(
      "signed-in",
    );
  });
});

describe("playwrightInstallSources", () => {
  it("retries only downloadable browsers across mirrors", () => {
    expect(playwrightInstallSources("chromium")).toEqual([...PLAYWRIGHT_DOWNLOAD_SOURCES]);
    expect(playwrightInstallSources("firefox")).toEqual([...PLAYWRIGHT_DOWNLOAD_SOURCES]);
    expect(playwrightInstallSources("msedge")).toEqual([PLAYWRIGHT_DOWNLOAD_SOURCES[0]]);
  });

  it("treats vendor channels as non-downloadable", () => {
    expect(isPlaywrightDownloadableBrowser("chromium")).toBe(true);
    expect(isPlaywrightDownloadableBrowser("firefox")).toBe(true);
    expect(isPlaywrightDownloadableBrowser("msedge")).toBe(false);
    expect(isPlaywrightDownloadableBrowser("chrome")).toBe(false);
  });
});

describe("Playwright connection configuration", () => {
  it.each(PLAYWRIGHT_MANAGED_BROWSERS)("configures and parses managed %s mode", (mode) => {
    const args = configurePlaywrightArgs(["-y", "@playwright/mcp@0.0.80", "--caps=vision"], mode);
    expect(args).toEqual([
      "-y",
      "@playwright/mcp@0.0.80",
      "--caps=vision",
      `--browser=${mode}`,
      `--user-data-dir=.reasonix/playwright/profiles/${mode}`,
    ]);
    expect(parsePlaywrightConnection(args)).toEqual({ mode });
  });

  it("switches conflicting connection modes without losing unrelated arguments", () => {
    expect(
      configurePlaywrightArgs(
        [
          "-y",
          "@playwright/mcp@0.0.80",
          "--browser",
          "firefox",
          "--extension",
          "--cdp-endpoint=http://localhost:9222",
          "--profile-dir-name=Profile 1",
          "--user-data-dir",
          "old-profile",
          "--caps=vision",
        ],
        "msedge",
      ),
    ).toEqual([
      "-y",
      "@playwright/mcp@0.0.80",
      "--caps=vision",
      "--browser=msedge",
      "--user-data-dir=.reasonix/playwright/profiles/msedge",
    ]);
  });

  it("configures extension mode to attach without pinning a managed profile", () => {
    expect(
      configurePlaywrightArgs(
        [
          "-y",
          "@playwright/mcp",
          "--browser=chrome",
          "--profile-dir-name",
          "Profile 2",
          "--user-data-dir=.reasonix/playwright/profiles/chrome",
        ],
        "extension",
      ),
    ).toEqual(["-y", "@playwright/mcp", "--extension"]);
  });

  it("targets Edge for the extension relay when asked", () => {
    const args = configurePlaywrightArgs(
      ["-y", "@playwright/mcp", "--extension"],
      "extension",
      undefined,
      "msedge",
    );
    expect(args).toEqual(["-y", "@playwright/mcp", "--browser=msedge", "--extension"]);
    expect(parsePlaywrightConnection(args)).toEqual({
      mode: "extension",
      extensionBrowser: "msedge",
    });
  });

  it("defaults the extension relay to Chrome when no browser is set", () => {
    expect(parsePlaywrightConnection(["-y", "@playwright/mcp", "--extension"])).toEqual({
      mode: "extension",
      extensionBrowser: "chrome",
    });
  });

  it("configures Chromium CDP and validates its endpoint", () => {
    const args = configurePlaywrightArgs(
      ["-y", "@playwright/mcp", "--browser=webkit"],
      "cdp",
      "http://localhost:9222",
    );
    expect(args).toEqual(["-y", "@playwright/mcp", "--cdp-endpoint=http://localhost:9222"]);
    expect(parsePlaywrightConnection(args)).toEqual({
      mode: "cdp",
      cdpEndpoint: "http://localhost:9222",
    });
    expect(() => configurePlaywrightArgs(args, "cdp", "")).toThrow(/endpoint is required/);
    expect(() => configurePlaywrightArgs(args, "cdp", "localhost:9222")).toThrow(/must use/);
  });

  it("uses one stable, browser-specific profile path under the workspace", () => {
    expect(playwrightWorkspaceProfileDir("chromium")).toBe(
      ".reasonix/playwright/profiles/chromium",
    );
    expect(playwrightWorkspaceProfileDir("firefox")).toBe(".reasonix/playwright/profiles/firefox");
    const configured = configurePlaywrightArgs(
      configurePlaywrightArgs(["-y", "@playwright/mcp"], "chromium"),
      "chromium",
    );
    expect(configured.filter((arg) => arg.startsWith("--user-data-dir="))).toEqual([
      "--user-data-dir=.reasonix/playwright/profiles/chromium",
    ]);
  });

  it("adds the persistent cookie profile to legacy managed specs at runtime", () => {
    expect(
      withPlaywrightWorkspaceProfile({
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp"],
      }),
    ).toEqual({
      transport: "stdio",
      name: "playwright",
      command: "npx",
      args: [
        "-y",
        "@playwright/mcp",
        "--browser=chromium",
        "--user-data-dir=.reasonix/playwright/profiles/chromium",
        expect.stringMatching(/^--init-script=.*silence-media\.js$/),
      ],
    });
  });

  it("mutes page media in the managed browser but never the user's own", () => {
    const managed = withPlaywrightWorkspaceProfile({
      transport: "stdio",
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--browser=webkit"],
    });
    const init = managed.args.find((arg) => arg.startsWith("--init-script="));
    expect(init).toBeTruthy();
    // The flag must point at a file that exists, or the server rejects the launch.
    expect(existsSync(init!.slice("--init-script=".length))).toBe(true);
    // A user-supplied init script is replaced, so the mute cannot be dropped by accident.
    const replaced = withPlaywrightWorkspaceProfile({
      transport: "stdio",
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--browser=webkit", "--init-script=mine.js"],
    });
    expect(replaced.args.filter((arg) => arg.includes("--init-script"))).toHaveLength(1);
    expect(replaced.args.join(" ")).not.toContain("mine.js");
  });

  it("ships the same mute script the browser tools inject", () => {
    // One behaviour, two carriers: the daemon injects the string, the MCP server loads the
    // file. Both must keep every muting step, so the check names the steps, not the text.
    const bundled = readFileSync(resolvePlaywrightTemplatePath("silence-media.js"), "utf8");
    for (const [carrier, script] of [
      ["bundled file", bundled],
      ["injected string", SILENCE_MEDIA],
    ] as const) {
      expect(script, carrier).toContain("muted = true");
      expect(script, carrier).toContain("volume = 0");
      expect(script, carrier).toContain("HTMLMediaElement.prototype");
      expect(script, carrier).toContain("MutationObserver");
      expect(script, carrier).toContain("pause()");
    }
  });

  it("does not rewrite extension, CDP, or remote Playwright specs", () => {
    const extension = {
      transport: "stdio" as const,
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp", "--extension"],
    };
    const cdp = {
      ...extension,
      args: ["-y", "@playwright/mcp", "--cdp-endpoint=http://localhost:9222"],
    };
    const remote = {
      transport: "sse" as const,
      name: "playwright",
      url: "https://browser.example.com/sse",
    };
    expect(withPlaywrightWorkspaceProfile(extension)).toBe(extension);
    expect(withPlaywrightWorkspaceProfile(cdp)).toBe(cdp);
    expect(withPlaywrightWorkspaceProfile(remote)).toBe(remote);
  });

  it("adds an absolute workspace output dir for every mode when a workspace is known", () => {
    const outputDir = `--output-dir=${join("/ws", ".playwright-mcp")}`;
    const managed = withPlaywrightWorkspaceProfile(
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--browser=chromium"],
      },
      "/ws",
    );
    expect(managed.args).toContain(outputDir);

    const extension = withPlaywrightWorkspaceProfile(
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--extension"],
      },
      "/ws",
    );
    expect(extension.args).toContain(outputDir);
    expect(extension.args).toContain("--extension");
  });

  it("replaces a user-supplied --output-dir with the workspace one", () => {
    const out = withPlaywrightWorkspaceProfile(
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", "--output-dir=elsewhere", "--browser=chrome"],
      },
      "/ws",
    );
    expect(out.args.filter((arg) => arg.startsWith("--output-dir="))).toEqual([
      `--output-dir=${join("/ws", ".playwright-mcp")}`,
    ]);
  });

  it("treats an unqualified Playwright server as managed Chromium", () => {
    expect(parsePlaywrightConnection(["-y", "@playwright/mcp"])).toEqual({ mode: "chromium" });
  });

  it.each(["chrome", "chrome-beta", "chrome-dev", "chrome-canary", "chrome-for-testing"])(
    "migrates a legacy %s system channel onto the hermetic Chromium build",
    (browser) => {
      expect(parsePlaywrightConnection(["-y", "@playwright/mcp", `--browser=${browser}`])).toEqual({
        mode: "chromium",
      });
      const rewritten = withPlaywrightWorkspaceProfile({
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp", `--browser=${browser}`],
      });
      expect(rewritten.args).toEqual([
        "-y",
        "@playwright/mcp",
        "--browser=chromium",
        "--user-data-dir=.reasonix/playwright/profiles/chromium",
        expect.stringMatching(/^--init-script=.*silence-media\.js$/),
      ]);
    },
  );
});

describe("normalizeExtensionToken", () => {
  it("accepts a bare token unchanged", () => {
    expect(normalizeExtensionToken("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE")).toBe(
      "K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
    );
  });

  it("strips the KEY= prefix that the connection dialog's copy button produces", () => {
    expect(
      normalizeExtensionToken(
        "PLAYWRIGHT_MCP_EXTENSION_TOKEN=K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
      ),
    ).toBe("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
    expect(
      normalizeExtensionToken(
        "playwright_mcp_extension_token=K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE",
      ),
    ).toBe("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
  });

  it("trims whitespace and strips wrapping quotes", () => {
    expect(normalizeExtensionToken('  "K3MM1pBelgctJOQe2"  ')).toBe("K3MM1pBelgctJOQe2");
    expect(normalizeExtensionToken("  'K3MM1pBelgctJOQe2'\n")).toBe("K3MM1pBelgctJOQe2");
  });

  it("leaves a token that merely contains the key name elsewhere untouched", () => {
    expect(normalizeExtensionToken("xPLAYWRIGHT_MCP_EXTENSION_TOKEN=y")).toBe(
      "xPLAYWRIGHT_MCP_EXTENSION_TOKEN=y",
    );
  });
});

describe("computeMcpExtensionStatus", () => {
  it("reads configured state and the extension flag from the entry", () => {
    const cfg: ReasonixConfig = {
      mcpServers: {
        playwright: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@playwright/mcp", "--extension", "--profile-dir-name=Profile 1"],
        },
      },
    };
    const status = computeMcpExtensionStatus(cfg);
    expect(status.storeUrl).toBe(PLAYWRIGHT_EXTENSION_STORE_URL);
    expect(status.server).toEqual({
      configured: true,
      mode: "extension",
      extensionBrowser: "chrome",
      hasExtensionArg: true,
      tokenPrefix: undefined,
      args: ["-y", "@playwright/mcp", "--extension", "--profile-dir-name=Profile 1"],
    });
  });

  it("reports a redacted relay token identifier without exposing the full token", () => {
    const withToken: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp", "--extension"],
          env: { [PLAYWRIGHT_EXTENSION_TOKEN_ENV]: "K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE" },
        },
      },
    };
    const server = computeMcpExtensionStatus(withToken).server;
    expect(server.tokenPrefix).toBe("K3MM1p…6VE");
    expect(JSON.stringify(server)).not.toContain("K3MM1pBelgctJOQe2_sMBQD5NJwrxUcCXgvbRHv-6VE");
    expect(computeMcpExtensionStatus({}).server.tokenPrefix).toBeUndefined();
  });

  it("reports unconfigured servers", () => {
    const status = computeMcpExtensionStatus({});
    expect(status.server.configured).toBe(false);
    expect(status.server.mode).toBe("chromium");
    expect(status.server.hasExtensionArg).toBe(false);
  });

  it("reports the install state of every managed build", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-playwright-"));
    mkdirSync(join(dir, "chromium-1248"));
    writeFileSync(join(dir, "chromium-1248", "INSTALLATION_COMPLETE"), "");
    const installs = computeMcpExtensionStatus({}, { PLAYWRIGHT_BROWSERS_PATH: dir }).installs;
    // Every mode is reported, so a picker can gate the ones it cannot offer.
    expect(installs.map((entry) => entry.browser)).toEqual([...PLAYWRIGHT_MANAGED_BROWSERS]);
    expect(installs).toEqual([
      { browser: "chromium", state: "installed" },
      { browser: "firefox", state: "missing" },
      { browser: "webkit", state: "missing" },
      { browser: "msedge", state: "system" },
    ]);
  });

  it("reports managed and CDP connection modes", () => {
    const managed: ReasonixConfig = {
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp", "--browser=firefox"] },
      },
    };
    expect(computeMcpExtensionStatus(managed).server.mode).toBe("firefox");

    const cdp: ReasonixConfig = {
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["-y", "@playwright/mcp", "--cdp-endpoint=http://localhost:9222"],
        },
      },
    };
    expect(computeMcpExtensionStatus(cdp).server).toMatchObject({
      configured: true,
      mode: "cdp",
      cdpEndpoint: "http://localhost:9222",
      hasExtensionArg: false,
    });
  });
});

describe("interpretExtensionCheck", () => {
  it("passes a successful tabs listing through as ok", () => {
    const raw = JSON.stringify({ tabs: [{ id: "t1", url: "https://example.com" }] });
    expect(interpretExtensionCheck(raw, 1200)).toEqual({ ok: true, reason: null, elapsedMs: 1200 });
  });

  it("maps a timeout to the wrong-token-or-no-supported-browser guidance", () => {
    const raw = JSON.stringify({
      error: "browser_tabs: This operation was aborted due to timeout",
    });
    const result = interpretExtensionCheck(raw, 25000);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no browser responded within 25s");
    expect(result.reason).toContain("token is likely wrong");
    expect(result.reason).toContain("Chrome or Edge");
  });

  it("maps an unregistered tool to the not-bridged guidance", () => {
    const raw = JSON.stringify({ error: "unknown tool: playwright_browser_tabs" });
    const result = interpretExtensionCheck(raw, 5);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not bridged");
  });

  it("surfaces the detail line of a tool-side error (### Error)", () => {
    const result = interpretExtensionCheck("### Error\nExtension not found", 900);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Extension not found");
  });

  it("surfaces an inline Error: message without the prefix", () => {
    const result = interpretExtensionCheck("Error: relay not connected", 900);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("relay not connected");
  });

  it("treats an empty probe result as a failure", () => {
    expect(interpretExtensionCheck(null, 0).ok).toBe(false);
    expect(interpretExtensionCheck("   ", 0).ok).toBe(false);
  });
});

describe("isPlaywrightBrowserInstalled", () => {
  it("treats the remaining system channel as installed", () => {
    expect(isPlaywrightBrowserInstalled("msedge")).toBe(true);
  });

  it("probes the browsers dir for the hermetic Chromium build", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-playwright-"));
    const env = { PLAYWRIGHT_BROWSERS_PATH: dir };
    expect(isPlaywrightBrowserInstalled("chromium", env)).toBe(false);
    // An interrupted download leaves a dir without Playwright's completion marker.
    mkdirSync(join(dir, "chromium-1248"));
    expect(isPlaywrightBrowserInstalled("chromium", env)).toBe(false);
    writeFileSync(join(dir, "chromium-1248", "INSTALLATION_COMPLETE"), "");
    expect(isPlaywrightBrowserInstalled("chromium", env)).toBe(true);
    // The headless shell is a separate dir and must not satisfy the probe.
    const shellOnly = mkdtempSync(join(tmpdir(), "reasonix-playwright-"));
    mkdirSync(join(shellOnly, "chromium_headless_shell-1248"));
    writeFileSync(join(shellOnly, "chromium_headless_shell-1248", "INSTALLATION_COMPLETE"), "");
    expect(isPlaywrightBrowserInstalled("chromium", { PLAYWRIGHT_BROWSERS_PATH: shellOnly })).toBe(
      false,
    );
  });

  it("returns false for unsupported browsers", () => {
    expect(isPlaywrightBrowserInstalled("opera")).toBe(false);
    expect(isPlaywrightBrowserInstalled(null)).toBe(false);
  });

  it("respects PLAYWRIGHT_BROWSERS_PATH when inspecting managed browsers", () => {
    const emptyDir = "C:/path/does/not/exist/for/playwright/test";
    expect(isPlaywrightBrowserInstalled("firefox", { PLAYWRIGHT_BROWSERS_PATH: emptyDir })).toBe(
      false,
    );
  });
});
