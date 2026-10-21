import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserSearchResult,
  __resolveBrowserCoreForTests,
  __setBrowserCoreLoaderForTests,
  closeBrowserSearches,
  searchWithBrowser,
} from "../src/tools/browser-search.js";
import { parseBingResults } from "../src/tools/web.js";

/** Copy stub: returns the engine key plus its params, so tests assert the key chosen. */
const copy = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

const RESULT_HTML = `
  <li class="b_algo"><h2><a href="https://example.com/a">Alpha result</a></h2>
    <div class="b_caption"><p>alpha snippet</p></div></li>
  <li class="b_algo"><h2><a href="https://example.com/b">Beta result</a></h2>
    <div class="b_caption"><p>beta snippet</p></div></li>`;

interface FakeCall {
  kind: "launch" | "context" | "goto" | "wait" | "close";
  detail?: unknown;
}

/** A playwright-core stand-in: records what the transport asks of it. */
function fakeBrowser(
  opts: {
    html?: string;
    gotoError?: Error;
    waitError?: Error;
    status?: number;
  } = {},
) {
  const calls: FakeCall[] = [];
  const browserType = {
    executablePath: () => "/fake/chrome",
    launch: async () => {
      calls.push({ kind: "launch" });
      return {
        newContext: async (contextOpts: unknown) => {
          calls.push({ kind: "context", detail: contextOpts });
          return {
            newPage: async () => ({
              goto: async (url: string) => {
                calls.push({ kind: "goto", detail: url });
                if (opts.gotoError) throw opts.gotoError;
                return { status: () => opts.status ?? 200 };
              },
              waitForSelector: async (selector: string) => {
                calls.push({ kind: "wait", detail: selector });
                if (opts.waitError) throw opts.waitError;
                return {};
              },
              content: async () => opts.html ?? RESULT_HTML,
            }),
            close: async () => {
              calls.push({ kind: "close" });
            },
          };
        },
        close: async () => undefined,
      };
    },
  };
  return { browserType, calls };
}

function coreOf(browserType: unknown) {
  return {
    kind: "ok" as const,
    core: { chromium: browserType, firefox: browserType, webkit: browserType } as never,
    executablePath: "/fake/chrome",
  };
}

const parse = (html: string): BrowserSearchResult[] => parseBingResults(html);

afterEach(async () => {
  await closeBrowserSearches();
  __setBrowserCoreLoaderForTests(null);
});

describe("searchWithBrowser", () => {
  it("navigates an en-US Bing SERP with a desktop UA and maps the results", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("deep seek balance", {
      browser: "firefox",
      copy,
      parse,
      topK: 5,
    });
    expect(results).toEqual([
      { title: "Alpha result", url: "https://example.com/a", snippet: "alpha snippet" },
      { title: "Beta result", url: "https://example.com/b", snippet: "beta snippet" },
    ]);
    const goto = fake.calls.find((c) => c.kind === "goto")!.detail as string;
    expect(goto).toContain("bing.com/search?q=deep%20seek%20balance");
    // setlang/cc make Bing serve a script-rendered page with no result nodes.
    expect(goto).not.toContain("setlang");
    expect(goto).not.toContain("cc=");
    // Headless UA strings are what Bing withholds results from, so a real UA is required.
    const context = fake.calls.find((c) => c.kind === "context")!.detail as {
      userAgent: string;
      locale: string;
    };
    expect(context.locale).toBe("en-US");
    expect(context.userAgent).toContain("Firefox/121");
    expect(context.userAgent).not.toContain("Headless");
  });

  it("honours topK", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 });
    expect(results).toHaveLength(1);
  });

  it("reuses one launched browser across searches and closes on demand", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser("one", { browser: "chromium", copy, parse, topK: 1 });
    await searchWithBrowser("two", { browser: "chromium", copy, parse, topK: 1 });
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(1);
    // Contexts are per search, and each one is closed.
    expect(fake.calls.filter((c) => c.kind === "context")).toHaveLength(2);
    expect(fake.calls.filter((c) => c.kind === "close")).toHaveLength(2);
    await closeBrowserSearches();
    // A search after teardown launches a fresh browser.
    await searchWithBrowser("three", { browser: "chromium", copy, parse, topK: 1 });
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(2);
  });

  it("launches one browser for concurrent searches", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await Promise.all([
      searchWithBrowser("one", { browser: "chromium", copy, parse, topK: 1 }),
      searchWithBrowser("two", { browser: "chromium", copy, parse, topK: 1 }),
    ]);
    // A second launch would leak a browser process, so the pair shares one.
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(1);
  });

  it("replaces a dead browser once instead of failing every later search", async () => {
    const calls: string[] = [];
    let launches = 0;
    const fake = fakeBrowser();
    const flaky = {
      executablePath: () => "/fake/chrome",
      launch: async () => {
        launches += 1;
        const instance = await fake.browserType.launch();
        if (launches > 1) return instance;
        // The first browser dies the moment a context is requested.
        return {
          ...instance,
          newContext: async () => {
            calls.push("dead");
            throw new Error("Target page, context or browser has been closed");
          },
        };
      },
    };
    __setBrowserCoreLoaderForTests(() => coreOf(flaky));
    const results = await searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 });
    expect(results).toHaveLength(1);
    expect(calls).toEqual(["dead"]);
    expect(launches).toBe(2);
  });

  it("stops promptly when the caller aborts", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchWithBrowser("q", {
        browser: "chromium",
        copy,
        parse,
        topK: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/^cannotReach:.*search aborted/);
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(0);
  });

  it("reports a missing Playwright installation with the engine's own copy", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notFound" }));
    await expect(
      searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^notFound:.*"browser":"chromium".*"Browser":"Chromium"/);
  });

  it("reports a managed build that is not installed", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    await expect(
      searchWithBrowser("q", { browser: "webkit", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^notInstalled:.*"browser":"webkit".*"Browser":"WebKit"/);
  });

  it("surfaces a launch failure with the browser's message", async () => {
    __setBrowserCoreLoaderForTests(() => ({
      kind: "ok",
      core: {
        chromium: {
          executablePath: () => "/fake",
          launch: async () => {
            throw new Error("libnss3 missing");
          },
        },
      } as never,
      executablePath: "/fake",
    }));
    await expect(
      searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^launchFailed:.*"Browser":"Chromium".*"message":"libnss3 missing"/);
  });

  it("reports an unreachable SERP", async () => {
    const fake = fakeBrowser({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^cannotReach:.*ERR_NAME_NOT_RESOLVED/);
  });

  it("reports a withheld SERP as a timeout when the result nodes never appear", async () => {
    const fake = fakeBrowser({
      html: "<html><body>nothing</body></html>",
      waitError: new Error("timeout"),
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: "chromium", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^timeout:.*"ms":8000/);
  });

  it("reports a settled page with no parseable results as blocked", async () => {
    const fake = fakeBrowser({ html: "<html><body>consent</body></html>" });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: "firefox", copy, parse, topK: 1 }),
    ).rejects.toThrow(/^blocked:.*"chars":\d+/);
  });

  it("returns [] for a real empty-result page", async () => {
    const fake = fakeBrowser({
      html: "<html><body>Your search did not match any documents.</body></html>",
      waitError: new Error("timeout"),
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("zzyzx", { browser: "chromium", copy, parse, topK: 1 }),
    ).resolves.toEqual([]);
  });
});

describe("live managed browser", () => {
  // Opt-in: this launches a real browser and hits the network.
  const enabled = process.env.REASONIX_LIVE_BROWSER_SEARCH === "1";
  const installed = enabled && __resolveBrowserCoreForTests("firefox").kind === "ok";

  it.skipIf(!installed)(
    "searches through the managed Firefox build",
    async () => {
      const results = await searchWithBrowser("deepseek api get user balance", {
        browser: "firefox",
        copy: (key, params) => `${key}:${JSON.stringify(params ?? {})}`,
        parse: parseBingResults,
        topK: 3,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.url).toMatch(/^https?:\/\//);
    },
    90_000,
  );
});

describe("__resolveBrowserCoreForTests", () => {
  const dirs: string[] = [];
  const saved = {
    npm: process.env.npm_config_cache,
    local: process.env.LOCALAPPDATA,
    xdg: process.env.XDG_CACHE_HOME,
    home: process.env.HOME,
  };

  /** Point every cache root at the test's temp dirs so no real install leaks in. */
  function isolate(cacheRoot: string): void {
    const empty = mkdtempSync(join(tmpdir(), "reasonix-empty-cache-"));
    dirs.push(cacheRoot, empty);
    process.env.npm_config_cache = cacheRoot;
    process.env.LOCALAPPDATA = empty;
    process.env.XDG_CACHE_HOME = empty;
    process.env.HOME = empty;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore("npm_config_cache", saved.npm);
    restore("LOCALAPPDATA", saved.local);
    restore("XDG_CACHE_HOME", saved.xdg);
    restore("HOME", saved.home);
  });

  /** A fake @playwright/mcp npx install whose playwright-core points at `exe`. */
  function fakeCore(cacheRoot: string, npxDir: string, exe: string): void {
    const pkg = join(cacheRoot, "_npx", npxDir, "node_modules", "playwright-core");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "playwright-core", version: "0.0.0" }),
    );
    writeFileSync(
      join(pkg, "index.js"),
      `const bt = { executablePath: () => ${JSON.stringify(exe)}, launch: async () => { throw new Error("not used"); } };
       module.exports = { chromium: bt, firefox: bt, webkit: bt };`,
    );
  }

  it("skips a core whose managed build is absent and uses the one that is installed", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "reasonix-npx-"));
    isolate(cacheRoot);
    fakeCore(cacheRoot, "stale", join(cacheRoot, "missing-browser", "chrome.exe"));
    const installed = join(cacheRoot, "installed-browser", "chrome.exe");
    mkdirSync(join(installed, ".."), { recursive: true });
    writeFileSync(installed, "");
    fakeCore(cacheRoot, "current", installed);

    const resolution = __resolveBrowserCoreForTests("chromium");
    expect(resolution.kind).toBe("ok");
    if (resolution.kind === "ok") expect(resolution.executablePath).toBe(installed);
  });

  it("reports notInstalled when no candidate has a managed build", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "reasonix-npx-"));
    isolate(cacheRoot);
    fakeCore(cacheRoot, "stale", join(cacheRoot, "missing-browser", "chrome.exe"));
    expect(__resolveBrowserCoreForTests("chromium").kind).toBe("notInstalled");
  });

  it("reports notFound when there is no Playwright installation at all", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "reasonix-npx-"));
    isolate(cacheRoot);
    expect(__resolveBrowserCoreForTests("chromium").kind).toBe("notFound");
  });
});
