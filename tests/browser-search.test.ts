import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserSearchResult,
  __resolveBrowserCoreForTests,
  __setBrowserCoreLoaderForTests,
  closeBrowserSearches,
  renderManagedPage,
  searchWithBrowser,
} from "../src/tools/browser-search.js";
import { parseBingResults, parseDuckDuckGoResults } from "../src/tools/web.js";

/** Copy stub: returns the engine key plus its params, so tests assert the key chosen. */
const copy = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key;

/** The one managed build a search engine may drive. */
const BROWSER = "webkit" as const;

/** The parsers the web_search transport hands in, one per SERP. */
const PARSERS = { duckduckgo: parseDuckDuckGoResults, bing: parseBingResults };

/** DuckDuckGo's no-JS markup for the same two hits as the Bing block below. */
const DDG_RESULT_HTML = `
  <div class="result results_links web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/a">Deepseek balance docs</a></h2>
    <a class="result__snippet" href="https://example.com/a">alpha snippet</a>
  </div>
  <div class="result results_links web-result">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.com/b">Deepseek balance API</a></h2>
    <a class="result__snippet" href="https://example.com/b">beta snippet</a>
  </div>`;

const RESULT_HTML = `
  <li class="b_algo"><h2><a href="https://example.com/a">Deepseek balance docs</a></h2>
    <div class="b_caption"><p>alpha snippet</p></div></li>
  <li class="b_algo"><h2><a href="https://example.com/b">Deepseek balance API</a></h2>
    <div class="b_caption"><p>beta snippet</p></div></li>`;

/** A query whose topic words appear in both result blocks, so the reduced-SERP guard passes. */
const QUERY = "deepseek balance";

const EXPECTED = [
  { title: "Deepseek balance docs", url: "https://example.com/a", snippet: "alpha snippet" },
  { title: "Deepseek balance API", url: "https://example.com/b", snippet: "beta snippet" },
];

/** Real markup captured from the managed WebKit build, trimmed to the results container. */
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
  kind: "launch" | "context" | "goto" | "wait" | "settle" | "shot" | "close";
  detail?: unknown;
  /** The timeout the transport asked for, so slow-link budgets can be asserted. */
  timeout?: number;
  /** The waitUntil the transport asked for, so rendering can be told from SERP reads. */
  waitUntil?: string;
}

interface SerpBehavior {
  html?: string;
  /** The document after the result wait, for a page that renders late. */
  htmlAfterWait?: string;
  gotoError?: Error;
  waitError?: Error;
  status?: number;
  settleError?: Error;
  screenshotError?: Error;
  title?: string;
  finalUrl?: string;
}

/** A playwright-core stand-in: records what the transport asks of it, per SERP. */
function fakeBrowser(behavior: { duckduckgo?: SerpBehavior; bing?: SerpBehavior } = {}): {
  browserType: unknown;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let current: Required<Pick<SerpBehavior, "html">> & SerpBehavior = { html: "" };
  let waited = false;
  const behaviorFor = (url: string): Required<Pick<SerpBehavior, "html">> & SerpBehavior =>
    url.includes("duckduckgo")
      ? { html: DDG_RESULT_HTML, ...behavior.duckduckgo }
      : { html: RESULT_HTML, ...behavior.bing };
  const browserType = {
    executablePath: () => "/fake/chrome",
    launch: async () => {
      calls.push({ kind: "launch" });
      return {
        newContext: async (contextOpts: unknown) => {
          calls.push({ kind: "context", detail: contextOpts });
          return {
            newPage: async () => ({
              goto: async (url: string, opts: { timeout?: number; waitUntil?: string }) => {
                calls.push({
                  kind: "goto",
                  detail: url,
                  timeout: opts?.timeout,
                  waitUntil: opts?.waitUntil,
                });
                current = behaviorFor(url);
                waited = false;
                if (current.gotoError) throw current.gotoError;
                return { status: () => current.status ?? 200 };
              },
              waitForSelector: async (selector: string, opts: { timeout?: number }) => {
                calls.push({ kind: "wait", detail: selector, timeout: opts?.timeout });
                if (current.waitError) throw current.waitError;
                waited = true;
                return {};
              },
              waitForLoadState: async (state: string, opts?: { timeout?: number }) => {
                calls.push({ kind: "settle", detail: state, timeout: opts?.timeout });
                if (current.settleError) throw current.settleError;
              },
              title: async () => current.title ?? "Fake title",
              url: () => current.finalUrl ?? "https://example.com/",
              screenshot: async () => {
                calls.push({ kind: "shot" });
                if (current.screenshotError) throw current.screenshotError;
                return Buffer.from("fake-png");
              },
              content: async () =>
                waited ? (current.htmlAfterWait ?? current.html) : current.html,
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

/** Every URL the transport navigated to, in order. */
function visited(calls: readonly FakeCall[]): string[] {
  return calls.filter((call) => call.kind === "goto").map((call) => String(call.detail));
}

const contextCount = (calls: readonly FakeCall[]): number =>
  calls.filter((call) => call.kind === "context").length;

const launchCount = (calls: readonly FakeCall[]): number =>
  calls.filter((call) => call.kind === "launch").length;

afterEach(async () => {
  await closeBrowserSearches();
  __setBrowserCoreLoaderForTests(null);
});

describe("renderManagedPage", () => {
  it("renders in a small transient window and closes it", async () => {
    const fake = fakeBrowser({
      bing: {
        title: "Example",
        finalUrl: "https://example.com/final",
        html: "<p>rendered body</p>",
      },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const page = await renderManagedPage(BROWSER, copy, "https://example.com/");

    expect(page.title).toBe("Example");
    expect(page.url).toBe("https://example.com/final");
    expect(page.html).toContain("rendered body");
    expect(page.preview).toBeInstanceOf(Buffer);

    const context = fake.calls.find((call) => call.kind === "context")!.detail as {
      viewport?: { width: number; height: number };
    };
    expect(context.viewport).toEqual({ width: 900, height: 1200 });
    // A page render waits for the document, not for a result node.
    expect(fake.calls.filter((call) => call.kind === "wait")).toHaveLength(0);
    expect(fake.calls.find((call) => call.kind === "goto")!.waitUntil).toBe("load");
    // The window is gone by the time the render resolves.
    expect(fake.calls.at(-1)!.kind).toBe("close");
  });

  it("keeps the render when the page never goes quiet", async () => {
    const fake = fakeBrowser({
      bing: { settleError: new Error("networkidle timeout"), html: "<p>still rendering</p>" },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const page = await renderManagedPage(BROWSER, copy, "https://example.com/");

    expect(page.html).toContain("still rendering");
    // Settling is bounded on its own, so a poller cannot eat the render budget.
    const settle = fake.calls.find((call) => call.kind === "settle")!;
    expect(settle.timeout).toBeLessThanOrEqual(5_000);
  });

  it("keeps the render when the screenshot fails", async () => {
    const fake = fakeBrowser({
      bing: { screenshotError: new Error("capture failed"), html: "<p>body</p>" },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const page = await renderManagedPage(BROWSER, copy, "https://example.com/");

    expect(page.preview).toBeUndefined();
    expect(page.html).toContain("body");
  });

  it("never launches a browser for an already-cancelled render", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));

    await expect(
      renderManagedPage(BROWSER, copy, "https://example.com/", { signal: controller.signal }),
    ).rejects.toThrow(/cannotReach/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("searchWithBrowser", () => {
  it("searches DuckDuckGo's no-JS SERP with a desktop UA and maps the results", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 5,
    });
    expect(results).toEqual(EXPECTED);
    const [first] = visited(fake.calls);
    expect(first).toContain("html.duckduckgo.com/html/?q=deepseek%20balance");
    // setlang/cc make Bing serve a script-rendered page with no result nodes.
    expect(first).not.toContain("setlang");
    expect(first).not.toContain("cc=");
    // Headless UA strings are what these SERPs withhold results from, so a real UA is required.
    const context = fake.calls.find((call) => call.kind === "context")!.detail as {
      userAgent: string;
      locale: string;
    };
    expect(context.locale).toBe("en-US");
    expect(context.userAgent).toContain("Safari/605");
    expect(context.userAgent).not.toContain("Headless");
    // The first SERP answered, so Bing was never touched.
    expect(visited(fake.calls)).toHaveLength(1);
  });

  it("honours topK", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 1,
    });
    expect(results).toHaveLength(1);
  });

  it("reuses one launched browser across searches and closes on demand", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
    expect(launchCount(fake.calls)).toBe(1);
    // Contexts are per search, and each one is closed.
    expect(contextCount(fake.calls)).toBe(2);
    expect(fake.calls.filter((call) => call.kind === "close")).toHaveLength(2);
    await closeBrowserSearches();
    // A search after teardown launches a fresh browser.
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
    expect(launchCount(fake.calls)).toBe(2);
  });

  it("launches one browser for concurrent searches", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await Promise.all([
      searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
      searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ]);
    // A second launch would leak a browser process, so the pair shares one.
    expect(launchCount(fake.calls)).toBe(1);
  });

  it("replaces a dead browser once instead of failing every later search", async () => {
    const calls: string[] = [];
    let launches = 0;
    const fake = fakeBrowser();
    const flaky = {
      executablePath: () => "/fake/chrome",
      launch: async () => {
        launches += 1;
        const instance = await (fake.browserType as { launch(): Promise<unknown> }).launch();
        if (launches > 1) return instance;
        // The first browser dies the moment a context is requested.
        return {
          ...(instance as object),
          newContext: async () => {
            calls.push("dead");
            throw new Error("Target page, context or browser has been closed");
          },
        };
      },
    };
    __setBrowserCoreLoaderForTests(() => coreOf(flaky));
    const results = await searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 1,
    });
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
        const instance = await (fake.browserType as { launch(): Promise<unknown> }).launch();
        if (launches > 1) return instance;
        return {
          ...(instance as object),
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
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
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
    const searching = searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 1,
    });
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
        parsers: PARSERS,
        topK: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/^cannotReach:.*search aborted/);
    expect(launchCount(fake.calls)).toBe(0);
  });

  it("reports a missing Playwright installation with the engine's own copy", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notFound" }));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^notFound:.*"browser":"webkit".*"Browser":"WebKit"/);
  });

  it("reports a managed build that is not installed", async () => {
    __setBrowserCoreLoaderForTests(() => ({ kind: "notInstalled" }));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
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
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^launchFailed:.*"Browser":"WebKit".*"message":"libnss3 missing"/);
  });

  it("reports an unreachable SERP when no backend resolves", async () => {
    const fake = fakeBrowser({
      duckduckgo: { gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") },
      bing: { gotoError: new Error("net::ERR_NAME_NOT_RESOLVED") },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^cannotReach:.*ERR_NAME_NOT_RESOLVED.*"Serp":"Bing"/);
    // A dead backend must not stop the search: both were tried.
    expect(visited(fake.calls)).toHaveLength(2);
  });

  it("falls back to Bing when DuckDuckGo withholds its results", async () => {
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body>challenge</body></html>", waitError: new Error("timeout") },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 2,
    });
    expect(results).toEqual(EXPECTED);
    expect(visited(fake.calls)[1]).toContain("bing.com/search");
  });

  it("reports a withheld SERP as a timeout naming the backend", async () => {
    const withheld = {
      html: "<html><body>nothing</body></html>",
      waitError: new Error("timeout"),
    };
    const fake = fakeBrowser({ duckduckgo: withheld, bing: withheld });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^timeout:.*"ms":20000.*"Serp":"Bing"/);
  });

  it("gives a slow link a long navigation and a long result window", async () => {
    const fake = fakeBrowser();
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
    const goto = fake.calls.find((call) => call.kind === "goto")!;
    expect(goto.timeout).toBe(40_000);
    // The common page answers from its first document, so no result window is spent.
    expect(fake.calls.some((call) => call.kind === "wait")).toBe(false);
  });

  it("waits out a page whose results render after the document", async () => {
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body>loading</body></html>", htmlAfterWait: DDG_RESULT_HTML },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(QUERY, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 2,
    });
    expect(results).toEqual(EXPECTED);
    const wait = fake.calls.find((call) => call.kind === "wait")!;
    expect(wait.timeout).toBe(20_000);
  });

  it("does not wait out a wall page, which time cannot fix", async () => {
    const wall = { html: "<html><body>Verify you are human</body></html>" };
    const fake = fakeBrowser({ duckduckgo: wall, bing: wall });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^blocked:.*"Serp":"Bing"/);
    expect(fake.calls.filter((call) => call.kind === "wait")).toHaveLength(0);
  });

  it("stops after one backend when the navigation itself times out", async () => {
    const stalled = { gotoError: new Error("page.goto: Timeout 40000ms exceeded.") };
    const fake = fakeBrowser({ duckduckgo: stalled, bing: stalled });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/Timeout 40000ms exceeded/);
    // A slow link cannot download the bigger SERP either, so it is not attempted.
    expect(visited(fake.calls)).toHaveLength(1);
  });

  it("floors each phase and skips the next backend once the search budget is spent", async () => {
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body>nothing</body></html>", waitError: new Error("timeout") },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", {
        browser: BROWSER,
        copy,
        parsers: PARSERS,
        topK: 1,
        budgetMs: 0,
      }),
    ).rejects.toThrow(/^timeout:/);
    // The one attempt still gets a usable window instead of a zero timeout.
    expect(fake.calls.find((call) => call.kind === "goto")!.timeout).toBe(5_000);
    expect(fake.calls.find((call) => call.kind === "wait")!.timeout).toBe(5_000);
    expect(visited(fake.calls)).toHaveLength(1);
  });

  it("reports a settled page with no parseable results as blocked", async () => {
    const consent = { html: "<html><body>consent</body></html>" };
    const fake = fakeBrowser({ duckduckgo: consent, bing: consent });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("q", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).rejects.toThrow(/^blocked:.*"chars":\d+/);
  });

  it("does not treat a search operator as a topic word", async () => {
    // `site:` never appears in a result: counting it left site-scoped queries unable to
    // answer, because it consumed the whole tolerance on its own.
    const fake = fakeBrowser({
      duckduckgo: {
        html: `<div class="result results_links web-result">
          <a class="result__a" href="https://www.youtube.com/playlist?list=PL1">Substance Quixel channel</a>
          <a class="result__snippet">Designer playlists from the Substance team.</a></div>`,
      },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("site:youtube.com substance designer quixel", {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 3,
    });
    expect(results).toHaveLength(1);
  });

  it("accepts a page that answers a misspelled query", async () => {
    const fake = fakeBrowser({
      duckduckgo: {
        html: `<div class="result results_links web-result">
          <a class="result__a" href="https://example.com/bunny">Big Buck Bunny official film</a>
          <a class="result__snippet">Blender Foundation short.</a></div>`,
      },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    // "bunnny" is the request's typo, not a different topic.
    const results = await searchWithBrowser("big buck bunnny", {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 3,
    });
    expect(results).toHaveLength(1);
  });

  it("rejects a reduced SERP that answers a different query", async () => {
    // WebKit is served this shape by some clients: results unrelated to the request.
    const reduced = {
      html: `<div class="result results_links web-result">
        <a class="result__a" href="https://en.wikipedia.org/wiki/Z">Z - Wikipedia</a>
        <a class="result__snippet">The last letter of the Latin alphabet.</a></div>
        <li class="b_algo"><h2><a href="https://en.wikipedia.org/wiki/Z">Z - Wikipedia</a></h2>
        <div class="b_caption"><p>The last letter of the Latin alphabet.</p></div></li>`,
    };
    const fake = fakeBrowser({ duckduckgo: reduced, bing: reduced });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("z.ai monitor usage quota endpoint", {
        browser: BROWSER,
        copy,
        parsers: PARSERS,
        topK: 3,
      }),
    ).rejects.toThrow(/^mismatched:.*"first":"Z - Wikipedia".*"Serp":"DuckDuckGo"/);
    // One attempt per backend, then the failure — never the unrelated hits.
    expect(contextCount(fake.calls)).toBe(2);
  });

  it("accepts a SERP whose hits cover every topic word of the query", async () => {
    const fake = fakeBrowser({
      duckduckgo: {
        html: `<div class="result results_links web-result">
          <a class="result__a" href="https://docs.z.ai/api/quota">Quota endpoint</a>
          <a class="result__snippet">Quota per plan, per endpoint.</a></div>`,
      },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("z.ai quota endpoint", {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK: 3,
    });
    expect(results).toHaveLength(1);
    expect(contextCount(fake.calls)).toBe(1);
  });

  it("rejects a stray hit that repeats only one word of a phrase query", async () => {
    // The reported shape: a quoted phrase answered with an unrelated cluster that
    // happens to mention one of its words.
    const reduced = {
      html: `<div class="result results_links web-result">
        <a class="result__a" href="https://example.com/music">Why the app was down</a>
        <a class="result__snippet">Downtime notes from an artist on the app.</a></div>`,
    };
    const fake = fakeBrowser({ duckduckgo: reduced, bing: reduced });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser('"material artist"', {
        browser: BROWSER,
        copy,
        parsers: PARSERS,
        topK: 5,
      }),
    ).rejects.toThrow(/^mismatched:.*"first":"Why the app was down"/);
  });

  it("returns [] for a real empty-result page", async () => {
    const fake = fakeBrowser({
      duckduckgo: {
        html: '<html><body><div class="no-results">No results found for zzyzx</div></body></html>',
        waitError: new Error("timeout"),
      },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await expect(
      searchWithBrowser("zzyzx", { browser: BROWSER, copy, parsers: PARSERS, topK: 1 }),
    ).resolves.toEqual([]);
    // No results is an answer, so the fallback backend is not asked.
    expect(contextCount(fake.calls)).toBe(1);
  });

  it("waits for a result node, not for the results container", async () => {
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body>loading</body></html>", htmlAfterWait: DDG_RESULT_HTML },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 1 });
    // A container exists before any result renders, so waiting on it reads a mid-render DOM.
    expect(fake.calls.find((call) => call.kind === "wait")!.detail).toBe("a.result__a");
  });

  it("searching again after a fallback launch reuses the same browser", async () => {
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body></body></html>", waitError: new Error("timeout") },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    await searchWithBrowser(QUERY, { browser: BROWSER, copy, parsers: PARSERS, topK: 2 });
    expect(launchCount(fake.calls)).toBe(1);
    expect(contextCount(fake.calls)).toBe(2);
  });
});

/** What the engine is actually used for: reaching code, repo docs, and API references. */
describe("real captured SERPs", () => {
  /** The captured Bing pages, reached the way the transport reaches them: after
   *  DuckDuckGo withheld its results. */
  async function searchFixture(name: string, query: string, topK = 10) {
    // The transport caches a launched browser, so drop it between different fixtures.
    await closeBrowserSearches();
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body></body></html>", waitError: new Error("timeout") },
      bing: { html: fixture(name) },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(query, {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
      topK,
    });
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

  it("reads the captured DuckDuckGo SERP without touching Bing", async () => {
    await closeBrowserSearches();
    const fake = fakeBrowser({ duckduckgo: { html: fixture("duckduckgo-endpoints") } });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser(
      "deepseek api get user balance endpoint documentation",
      { browser: BROWSER, copy, parsers: PARSERS, topK: 10 },
    );
    expect(results[0]?.url).toBe("https://api-docs.deepseek.com/api/get-user-balance/");
    expect(results.length).toBeGreaterThan(5);
    expect(visited(fake.calls)).toHaveLength(1);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.url).not.toContain("duckduckgo.com");
      expect(result.url).not.toMatch(/[?&]utm_/);
      expect(result.title.length).toBeGreaterThan(0);
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
    const fake = fakeBrowser({
      duckduckgo: { html: "<html><body></body></html>", waitError: new Error("timeout") },
      bing: { html },
    });
    __setBrowserCoreLoaderForTests(() => coreOf(fake.browserType));
    const results = await searchWithBrowser("app.ts slice helper code lines", {
      browser: BROWSER,
      copy,
      parsers: PARSERS,
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
      // Naming the file plus its package path is what makes a SERP surface /blob/ hits.
      const results = await searchWithBrowser(
        "playwright browserContext.ts source code github blob packages playwright-core",
        { browser: BROWSER, copy, parsers: PARSERS, topK: 10 },
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
        { browser: BROWSER, copy, parsers: PARSERS, topK: 10 },
      );
      expectHit(
        results,
        /^https:\/\/api-docs\.deepseek\.com\/api\/get-user-balance\//,
        "the get-user-balance reference page",
      );
    },
    90_000,
  );

  it.skipIf(!installed)(
    "finds a specific video for an exact title",
    async () => {
      const results = await searchWithBrowser(
        "Big Buck Bunny 60fps 4K Official Blender Foundation Short Film",
        { browser: BROWSER, copy, parsers: PARSERS, topK: 10 },
      );
      expectHit(results, /^https:\/\/www\.youtube\.com\/watch\?v=/, "a YouTube watch URL");
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
