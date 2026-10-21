import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The one managed build a search engine may drive. */
const BROWSER = "webkit" as const;

const RESULT_HTML = `
  <li class="b_algo"><h2><a href="https://example.com/a">Deepseek balance docs</a></h2>
    <div class="b_caption"><p>alpha snippet</p></div></li>
  <li class="b_algo"><h2><a href="https://example.com/b">Deepseek balance API</a></h2>
    <div class="b_caption"><p>beta snippet</p></div></li>`;

/** A query whose topic words appear in RESULT_HTML, so the reduced-SERP guard passes. */
const QUERY = "deepseek balance";

/** Real Bing markup captured from the managed WebKit build, trimmed to #b_results. */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf-8");

/** Assert one hit matches, naming the actual URLs when it does not. */
function expectHit(
  results: readonly BrowserSearchResult[],
  matcher: RegExp,
  description: string,
): void {
  const urls = results.map((result) => result.url);
  expect(
    urls.some((url) => matcher.test(url)),
    `expected ${description}, got:\n${urls.join("\n")}`,
  ).toBe(true);
}

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
    core: { webkit: browserType } as never,
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
    const results = await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 5 });
    expect(results).toEqual([
      { title: "Deepseek balance docs", url: "https://example.com/a", snippet: "alpha snippet" },
      { title: "Deepseek balance API", url: "https://example.com/b", snippet: "beta snippet" },
    ]);
    const goto = fake.calls.find((c) => c.kind === "goto")!.detail as string;
    expect(goto).toContain("bing.com/search?q=deepseek%20balance");
    // setlang/cc make Bing serve a script-rendered page with no result nodes.
    expect(goto).not.toContain("setlang");
    expect(goto).not.toContain("cc=");
    // Headless UA strings are what Bing withholds results from, so a real UA is required.
    const context = fake.calls.find((c) => c.kind === "context")!.detail as {
      userAgent: string;
      locale: string;
    };
    expect(context.locale).toBe("en-US");
    expect(context.userAgent).toContain("Safari/605");
    expect(context.userAgent).not.toContain("Headless");
  });

  it("honours topK", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    expect(results).toHaveLength(1);
  });

  it("reuses one launched browser across searches and closes on demand", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(1);
    // Contexts are per search, and each one is closed.
    expect(fake.calls.filter((c) => c.kind === "context")).toHaveLength(2);
    expect(fake.calls.filter((c) => c.kind === "close")).toHaveLength(2);
    await closeBrowserSearches();
    // A search after teardown launches a fresh browser.
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    expect(fake.calls.filter((c) => c.kind === "launch")).toHaveLength(2);
  });

  it("launches one browser for concurrent searches", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await Promise.all([
      searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 }),
      searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 }),
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
    const results = await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    expect(results).toHaveLength(1);
    expect(calls).toEqual(["dead"]);
    expect(launches).toBe(2);
  });

  it("resolves the managed build once, even when the browser is replaced", async () => {
    let resolutions = 0;
    let launches = 0;
    const fake = fakeBrowser();
    const flaky = {
      executablePath: () => "/fake/chrome",
      launch: async () => {
        launches += 1;
        const instance = await fake.browserType.launch();
        if (launches > 1) return instance;
        return {
          ...instance,
          newContext: async () => {
            throw new Error("Target page, context or browser has been closed");
          },
        };
      },
    };
    __setBrowserCoreLoaderForTests(() => {
      resolutions += 1;
      return coreOf(flaky);
    });
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    expect(launches).toBe(2);
    // A cached resolution means a replacement launch does not re-walk the npm cache.
    expect(resolutions).toBe(1);
  });

  it("closes a browser whose launch a teardown overtook", async () => {
    let closed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const browserType = {
      executablePath: () => "/fake/chrome",
      launch: async () => {
        await gate;
        return {
          newContext: async () => {
            throw new Error("unreachable");
          },
          close: async () => {
            closed += 1;
          },
        };
      },
    };
    __setBrowserCoreLoaderForTests(() => coreOf(browserType));
    const searching = searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    // Teardown while the launch is in flight: the browser that lands is nobody's.
    await closeBrowserSearches();
    release();
    await expect(searching).rejects.toThrow(/^cannotReach:.*search cancelled/);
    expect(closed).toBe(1);
  });

  it("stops promptly when the caller aborts", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const controller = new AbortController();
    controller.abort();
    await expect(
      searchWithBrowser("q", {
        browser: BROWSER,
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
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^notFound:.*"browser":"webkit".*"Browser":"WebKit"/);
  });

  it("reports a managed build that is not installed", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^notInstalled:.*"browser":"webkit".*"Browser":"WebKit"/);
  });

  it("surfaces a launch failure with the browser's message", async () => {
    __setBrowserCoreLoaderForTests(() => ({
      kind: "ok",
      core: {
        webkit: {
          executablePath: () => "/fake",
          launch: async () => {
            throw new Error("libnss3 missing");
          },
        },
      } as never,
      executablePath: "/fake",
    }));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^launchFailed:.*"Browser":"WebKit".*"message":"libnss3 missing"/);
  });

  it("reports an unreachable SERP", async () => {
    const fake = fakeBrowser({ gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^cannotReach:.*ERR_NAME_NOT_RESOLVED/);
  });

  it("reports a withheld SERP as a timeout when the result nodes never appear", async () => {
    const fake = fakeBrowser({
      html: "<html><body>nothing</body></html>",
      waitError: new Error("timeout"),
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^timeout:.*"ms":8000/);
  });

  it("reports a settled page with no parseable results as blocked", async () => {
    const fake = fakeBrowser({ html: "<html><body>consent</body></html>" });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parse, topK: 1 }),
    ).rejects.toThrow(/^blocked:.*"chars":\d+/);
  });

  it("rejects a reduced SERP that answers a different query", async () => {
    // Bing serves this shape to some clients: results unrelated to the request.
    const fake = fakeBrowser({
      html: `<li class="b_algo"><h2><a href="https://en.wikipedia.org/wiki/Z">Z - Wikipedia</a></h2>
        <div class="b_caption"><p>The last letter of the Latin alphabet.</p></div></li>`,
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("z.ai monitor usage quota endpoint", {
        browser: BROWSER,
        copy,
        parse,
        topK: 3,
      }),
    ).rejects.toThrow(/^mismatched:.*"first":"Z - Wikipedia"/);
    // One retry with a fresh context, then the failure — never the unrelated hits.
    expect(fake.calls.filter((c) => c.kind === "context")).toHaveLength(2);
  });

  it("accepts a SERP whose hits share a topic word with the query", async () => {
    const fake = fakeBrowser({
      html: `<li class="b_algo"><h2><a href="https://docs.z.ai/limits">Rate limits</a></h2>
        <div class="b_caption"><p>Quota per plan.</p></div></li>`,
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("z.ai quota endpoint", {
      browser: BROWSER,
      copy,
      parse,
      topK: 3,
    });
    // "quota" appears in the snippet, so the page is about the request.
    expect(results).toHaveLength(1);
    expect(fake.calls.filter((c) => c.kind === "context")).toHaveLength(1);
  });

  it("returns [] for a real empty-result page", async () => {
    const fake = fakeBrowser({
      html: "<html><body>Your search did not match any documents.</body></html>",
      waitError: new Error("timeout"),
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("zzyzx", { browser: BROWSER, copy, parse, topK: 1 }),
    ).resolves.toEqual([]);
    // No results is an answer, so it is not retried.
    expect(fake.calls.filter((c) => c.kind === "context")).toHaveLength(1);
  });

  it("waits for a result node, not for the results container", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 1 });
    // `#b_results` exists before any result renders, so waiting on it reads a mid-render DOM.
    expect(fake.calls.find((c) => c.kind === "wait")!.detail).toBe("li.b_algo");
  });

  it("retries once when the results never rendered, then answers", async () => {
    let contexts = 0;
    const browserType = {
      executablePath: () => "/fake/chrome",
      launch: async () => ({
        newContext: async () => {
          contexts += 1;
          const shell = contexts === 1;
          return {
            newPage: async () => ({
              goto: async () => ({ status: () => 200 }),
              waitForSelector: async () => {
                if (shell) throw new Error("Timeout 8000ms exceeded");
                return {};
              },
              content: async () => (shell ? "<html><body></body></html>" : RESULT_HTML),
            }),
            close: async () => undefined,
          };
        },
        close: async () => undefined,
      }),
    };
    __setBrowserCoreLoaderForTests(() => coreOf(browserType));
    const results = await searchWithBrowser(QUERY, { browser: BROWSER, copy, parse, topK: 2 });
    expect(results).toHaveLength(2);
    expect(contexts).toBe(2);
  });
});

/** What the engine is actually used for: reaching code, repo docs, and API references. */
describe("real captured SERPs", () => {
  async function searchFixture(name: string, query: string, topK = 10) {
    // The transport caches a launched browser, so drop it between different fixtures.
    await closeBrowserSearches();
    const fake = fakeBrowser({ html: fixture(name) });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(query, { browser: BROWSER, copy, parse, topK });
    return { results, fake };
  }

  it("returns repository documentation hits for a docs query", async () => {
    const { results } = await searchFixture(
      "github-docs",
      "github docs actions workflow syntax on push branches",
    );
    // The rendered docs site and the Markdown source of the same page both count.
    expectHit(results, /^https:\/\/docs\.github\.com\/en\/actions\//, "a GitHub docs page");
    expectHit(
      results,
      /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//,
      "a repository blob holding the docs source",
    );
  });

  it("returns API endpoint references for a service docs query", async () => {
    const { results } = await searchFixture(
      "api-endpoints",
      "ollama api chat endpoint request body documentation /api/chat",
    );
    expectHit(results, /^https:\/\/docs\.ollama\.com\/api\/chat/, "the /api/chat reference page");
    // The endpoint documented inside the repository is equally useful to navigate to.
    expectHit(
      results,
      /^https:\/\/github\.com\/ollama\/ollama\/blob\/main\/docs\/api\.md/,
      "api.md",
    );
  });

  it("returns the exact endpoint doc page, not just a service home page", async () => {
    const { results } = await searchFixture(
      "deepseek-endpoints",
      "deepseek api get user balance endpoint documentation",
    );
    expectHit(
      results,
      /^https:\/\/api-docs\.deepseek\.com\/api\/get-user-balance\//,
      "the get-user-balance reference",
    );
    // A home page alone would not answer "which endpoint and what does it take".
    expect(results[0]?.url).toBe("https://api-docs.deepseek.com/api/get-user-balance/");
  });

  it("keeps every hit navigable: no ads, no SERP chrome, no click tracking", async () => {
    const cases = [
      ["github-docs", "github docs actions workflow syntax on push branches"],
      ["api-endpoints", "ollama api chat endpoint request body documentation /api/chat"],
      ["deepseek-endpoints", "deepseek api get user balance endpoint documentation"],
    ] as const;
    for (const [name, query] of cases) {
      const { results } = await searchFixture(name, query);
      expect(results.length).toBeGreaterThan(3);
      for (const result of results) {
        expect(result.url, `${name}: ${result.url}`).toMatch(/^https?:\/\//);
        expect(result.url, `${name}: ${result.url}`).not.toContain("bing.com");
        expect(result.url, `${name}: ${result.url}`).not.toContain("/aclick");
        expect(result.url, `${name}: ${result.url}`).not.toMatch(/[?&]utm_/);
        expect(result.title.length, `${name}: empty title`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps a code-line anchor so a hit points at exact lines", async () => {
    const html = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://github.com/o/r/blob/main/src/app.ts#L120-L130">app.ts:120</a></h2>
          <div class="b_caption"><p>the slice helper code lines</p></div></li>
        <li class="b_algo"><h2><a href="https://github.com/o/r/blob/main/src/app.ts#L200">app.ts:200</a></h2>
          <div class="b_caption"><p>a different region of the same file</p></div></li>
      </ol>`;
    const fake = fakeBrowser({ html });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("app.ts slice helper code lines", {
      browser: BROWSER,
      copy,
      parse,
      topK: 5,
    });
    expect(results.map((result) => result.url)).toEqual([
      "https://github.com/o/r/blob/main/src/app.ts#L120-L130",
      "https://github.com/o/r/blob/main/src/app.ts#L200",
    ]);
  });
});

describe("live managed browser", () => {
  // Opt-in: this launches a real browser and hits the network.
  const enabled = process.env.REASONIX_LIVE_BROWSER_SEARCH === "1";
  const installed = enabled && __resolveBrowserCoreForTests(BROWSER).kind === "ok";

  it.skipIf(!installed)(
    "finds a repository source file for a code query",
    async () => {
      // Naming the file plus its package path is what makes Bing surface /blob/ hits.
      const results = await searchWithBrowser(
        "playwright browserContext.ts source code github blob packages playwright-core",
        { browser: BROWSER, copy, parse, topK: 10 },
      );
      expectHit(results, /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\//, "a repository blob URL");
    },
    90_000,
  );

  it.skipIf(!installed)(
    "finds documentation for a service's API endpoints",
    async () => {
      const results = await searchWithBrowser(
        "deepseek api get user balance endpoint documentation",
        { browser: BROWSER, copy, parse, topK: 10 },
      );
      expectHit(
        results,
        /^https:\/\/api-docs\.deepseek\.com\/api\/get-user-balance\//,
        "the get-user-balance reference page",
      );
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

    const resolution = __resolveBrowserCoreForTests(BROWSER);
    expect(resolution.kind).toBe("ok");
    if (resolution.kind === "ok") expect(resolution.executablePath).toBe(installed);
  });

  it("reports notInstalled when no candidate has a managed build", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "reasonix-npx-"));
    isolate(cacheRoot);
    fakeCore(cacheRoot, "stale", join(cacheRoot, "missing-browser", "chrome.exe"));
    expect(__resolveBrowserCoreForTests(BROWSER).kind).toBe("notInstalled");
  });

  it("reports notFound when there is no Playwright installation at all", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "reasonix-npx-"));
    isolate(cacheRoot);
    expect(__resolveBrowserCoreForTests(BROWSER).kind).toBe("notFound");
  });
});
