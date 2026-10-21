/** Drives a Playwright-managed browser as a key-less search engine: no key, no service,
 *  no dependency — the playwright-core @playwright/mcp already installed is reused. */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchEngineBrowser } from "@reasonix/core-utils";

/** Engine message resolver — the strings live in the engine's JSON declaration. */
export type EngineCopy = (key: string, params?: Record<string, string | number>) => string;

/** Structurally a SearchResult; kept local so this module never imports the tool. */
export interface BrowserSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Only the playwright-core surface this module drives. */
interface PwResponse {
  status(): number;
}
interface PwPage {
  goto(
    url: string,
    opts: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<PwResponse | null>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  content(): Promise<string>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: { userAgent: string; locale: string }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwBrowserType {
  executablePath(): string;
  launch(opts: { headless: boolean }): Promise<PwBrowser>;
}
type PwCore = Record<SearchEngineBrowser, PwBrowserType>;

export interface BrowserSearchOptions {
  browser: SearchEngineBrowser;
  copy: EngineCopy;
  parse: (html: string) => BrowserSearchResult[];
  topK: number;
  signal?: AbortSignal;
}

/** Bing is the only SERP that serves parseable DOM to every managed browser: DDG and
 *  Mojeek answer 403 to the harness. Do NOT add setlang/cc here — those switch Bing to
 *  a script-rendered variant whose DOM carries no result nodes at domcontentloaded. */
const SERP_URL = "https://www.bing.com/search";
const RESULT_SELECTOR = "li.b_algo";
const NAV_TIMEOUT_MS = 25_000;
const RESULT_WAIT_MS = 8_000;
/** A browser is expensive to launch and cheap to keep; drop it once searches stop. */
const IDLE_CLOSE_MS = 60_000;

/** Display name per browser, so one declared message set serves all three engines. */
const BROWSER_LABELS: Readonly<Record<SearchEngineBrowser, string>> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

/** Bind the engine copy to this browser: `{browser}` is the id, `{Browser}` the label. */
function copyForBrowser(browser: SearchEngineBrowser, copy: EngineCopy): EngineCopy {
  const bound = { browser, Browser: BROWSER_LABELS[browser] };
  return (key, params) => copy(key, { ...bound, ...params });
}

/** Headless Chromium advertises "HeadlessChrome" and Bing answers it with a page that
 *  has no result nodes, so each browser sends a normal desktop UA. */
const USER_AGENTS: Readonly<Record<SearchEngineBrowser, string>> = {
  chromium:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  webkit:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0]! : String(err);
}

/** npm caches that can hold the @playwright/mcp install we borrow playwright-core from. */
function npmCacheRoots(): string[] {
  const roots: string[] = [];
  const configured = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (configured) roots.push(configured);
  if (process.platform === "win32") {
    roots.push(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache"));
  } else if (process.platform === "darwin") {
    roots.push(join(homedir(), ".npm"));
  } else {
    roots.push(join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "npm"));
  }
  return [...new Set(roots)];
}

/** Every installed playwright-core, @playwright/mcp's npx copies first. */
function coreCandidates(): string[] {
  const dirs: string[] = [];
  for (const root of npmCacheRoots()) {
    const npx = join(root, "_npx");
    if (!existsSync(npx)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(npx);
    } catch {
      continue;
    }
    for (const entry of entries) dirs.push(join(npx, entry, "node_modules", "playwright-core"));
  }
  try {
    const resolved = createRequire(import.meta.url).resolve("playwright-core");
    dirs.push(dirname(resolved));
  } catch {
    /* Not a dependency of ours — the npx copies above are the expected home. */
  }
  return dirs.filter((dir) => existsSync(join(dir, "package.json")));
}

function loadCore(dir: string): PwCore {
  return createRequire(join(dir, "noop.js"))("playwright-core") as PwCore;
}

export type CoreResolution =
  | { kind: "ok"; core: PwCore; executablePath: string }
  | { kind: "notFound" }
  | { kind: "notInstalled" };

/** A managed build is, by definition, the one this core's executablePath() points at —
 *  a core whose browser revision is absent is skipped, never pointed at a system browser. */
function resolveCore(browser: SearchEngineBrowser): CoreResolution {
  const candidates = coreCandidates();
  if (candidates.length === 0) return { kind: "notFound" };
  for (const dir of candidates) {
    let core: PwCore;
    try {
      core = loadCore(dir);
    } catch {
      continue;
    }
    let executablePath = "";
    try {
      executablePath = core[browser]?.executablePath() ?? "";
    } catch {
      continue;
    }
    if (!executablePath || !existsSync(executablePath)) continue;
    return { kind: "ok", core, executablePath };
  }
  return { kind: "notInstalled" };
}

interface RunningBrowser {
  browser: PwBrowser;
  idleTimer: NodeJS.Timeout;
}

const running = new Map<SearchEngineBrowser, RunningBrowser>();
/** In-flight launches: two concurrent searches share one browser instead of racing. */
const launching = new Map<SearchEngineBrowser, Promise<PwBrowser>>();
/** Successful resolutions only — an install that appears later must still be picked up. */
const resolvedOk = new Map<SearchEngineBrowser, CoreResolution>();

/** Injectable seam: tests hand in a fake playwright-core instead of launching one. */
type CoreLoader = (browser: SearchEngineBrowser) => CoreResolution;
let loadResolution: CoreLoader = resolveCore;

export function __setBrowserCoreLoaderForTests(next: CoreLoader | null): void {
  loadResolution = next ?? resolveCore;
  resolvedOk.clear();
}

/** Exposed for tests: the managed-install resolution the transport actually uses. */
export function __resolveBrowserCoreForTests(browser: SearchEngineBrowser): CoreResolution {
  return resolveCore(browser);
}

function resolutionFor(browser: SearchEngineBrowser): CoreResolution {
  const cached = resolvedOk.get(browser);
  if (cached) return cached;
  const resolution = loadResolution(browser);
  if (resolution.kind === "ok") resolvedOk.set(browser, resolution);
  return resolution;
}

function startIdleTimer(browser: SearchEngineBrowser): NodeJS.Timeout {
  const timer = setTimeout(() => {
    void closeBrowser(browser);
  }, IDLE_CLOSE_MS);
  // A pending browser must never hold the process open.
  timer.unref?.();
  return timer;
}

/** Close one browser and forget it; never throws. */
async function closeBrowser(browser: SearchEngineBrowser): Promise<void> {
  const entry = running.get(browser);
  running.delete(browser);
  launching.delete(browser);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  try {
    await entry.browser.close();
  } catch {
    /* Already gone — a stale child is not worth a tool failure. */
  }
}

/** Tear down every browser this module launched (teardown, tests). */
export async function closeBrowserSearches(): Promise<void> {
  await Promise.all([...running.keys()].map(closeBrowser));
  resolvedOk.clear();
}

async function launch(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwBrowser> {
  const resolution = resolutionFor(browser);
  if (resolution.kind !== "ok") throw new Error(copy(resolution.kind));
  let launched: PwBrowser;
  try {
    launched = await resolution.core[browser].launch({ headless: true });
  } catch (err) {
    // A failed launch may mean the cached install went stale; let the next call re-resolve.
    resolvedOk.delete(browser);
    throw new Error(copy("launchFailed", { message: messageOf(err) }));
  }
  running.set(browser, { browser: launched, idleTimer: startIdleTimer(browser) });
  return launched;
}

/** The browser for this engine, launching at most one even under concurrent searches. */
async function browserFor(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwBrowser> {
  const existing = running.get(browser);
  if (existing) {
    existing.idleTimer.refresh?.();
    return existing.browser;
  }
  const inFlight = launching.get(browser);
  if (inFlight) return inFlight;
  const pending = launch(browser, copy).finally(() => launching.delete(browser));
  launching.set(browser, pending);
  return pending;
}

/** Race an awaited browser step against the caller's abort, so Stop cancels a search. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new Error(ABORTED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const ABORTED = "search aborted";

async function openContext(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwContext> {
  const instance = await browserFor(browser, copy);
  try {
    return await instance.newContext({ userAgent: USER_AGENTS[browser], locale: "en-US" });
  } catch (err) {
    // A dead or wedged browser is replaced once rather than failing every later search.
    await closeBrowser(browser);
    const replacement = await browserFor(browser, copy);
    try {
      return await replacement.newContext({ userAgent: USER_AGENTS[browser], locale: "en-US" });
    } catch {
      throw new Error(copy("launchFailed", { message: messageOf(err) }));
    }
  }
}

/** One browser-backed search: navigate the SERP, wait for result nodes, hand the HTML
 *  to the engine's parser. A failed launch or an unparseable page throws engine copy. */
export async function searchWithBrowser(
  query: string,
  opts: BrowserSearchOptions,
): Promise<BrowserSearchResult[]> {
  const { browser, parse, topK, signal } = opts;
  const copy = copyForBrowser(browser, opts.copy);
  if (signal?.aborted) throw new Error(copy("cannotReach", { message: ABORTED }));
  const context = await openContext(browser, copy);
  try {
    const page = await context.newPage();
    const url = `${SERP_URL}?q=${encodeURIComponent(query)}`;
    let status = 0;
    try {
      const response = await abortable(
        page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }),
        signal,
      );
      status = response?.status() ?? 0;
    } catch (err) {
      throw new Error(copy("cannotReach", { message: messageOf(err) }));
    }
    let settled = true;
    try {
      await abortable(page.waitForSelector(RESULT_SELECTOR, { timeout: RESULT_WAIT_MS }), signal);
    } catch (err) {
      // The caller giving up is not a withheld SERP; report it as the cancellation it is.
      if (messageOf(err) === ABORTED) throw new Error(copy("cannotReach", { message: ABORTED }));
      settled = false;
    }
    const html = await page.content();
    const results = parse(html).slice(0, topK);
    if (results.length > 0) return results;
    // A real empty page is an answer; anything else means the SERP was withheld.
    if (/no results found|did not match any documents/i.test(html)) return [];
    throw new Error(
      settled
        ? copy("blocked", { chars: html.length })
        : copy("timeout", { ms: RESULT_WAIT_MS, status }),
    );
  } finally {
    await context.close().catch(() => undefined);
  }
}
