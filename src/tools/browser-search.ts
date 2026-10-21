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
/** A real empty SERP, as opposed to one whose results never rendered. */
const EMPTY_SERP = /no results found|did not match any documents/i;
/** The result *node*, not the container: `#b_results` exists before any result renders,
 *  so waiting on it returns immediately and reads a mid-render DOM. The container is
 *  still where a drifted layout is harvested from, but only after this wait gives up. */
const RESULT_SELECTOR = "li.b_algo";
const NAV_TIMEOUT_MS = 25_000;
const RESULT_WAIT_MS = 8_000;
/** A browser is expensive to launch and cheap to keep; drop it once searches stop. */
const IDLE_CLOSE_MS = 60_000;
/** Display name of the one searchable managed build. Templated into the engine's copy so
 *  the wording lives in its JSON, not here. */
const BROWSER_LABEL = "WebKit";

/** Bind the engine copy to this browser: `{browser}` is the id, `{Browser}` the label.
 *  `{alternative}` is the engine's own suggestion, so the wording stays in its JSON. */
function copyForBrowser(browser: SearchEngineBrowser, copy: EngineCopy): EngineCopy {
  const bound = { browser, Browser: BROWSER_LABEL, alternative: copy("alternative") };
  return (key, params) => copy(key, { ...bound, ...params });
}

/** Headless Chromium advertises "HeadlessChrome" and Bing answers it with a page that
 *  has no result nodes, so the browser sends a normal desktop UA. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";

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

/** Everything known about one browser: the resolution cache, the in-flight launch and the
 *  live instance live in one record so they cannot disagree about which build is running. */
interface BrowserState {
  /** Cached managed-build resolution; absent while unknown or known-bad. */
  core?: CoreResolution;
  instance?: PwBrowser;
  idleTimer?: NodeJS.Timeout;
  /** In-flight launch, so concurrent searches share one browser instead of racing. */
  launching?: Promise<PwBrowser>;
  /** Bumped by a teardown, so a launch that finishes afterwards cannot resurrect a browser. */
  generation: number;
}

const states = new Map<SearchEngineBrowser, BrowserState>();

function stateOf(browser: SearchEngineBrowser): BrowserState {
  let state = states.get(browser);
  if (!state) {
    state = { generation: 0 };
    states.set(browser, state);
  }
  return state;
}

/** Injectable seam: tests hand in a fake playwright-core instead of launching one. */
type CoreLoader = (browser: SearchEngineBrowser) => CoreResolution;
let loadResolution: CoreLoader = resolveCore;

export function __setBrowserCoreLoaderForTests(next: CoreLoader | null): void {
  loadResolution = next ?? resolveCore;
  for (const state of states.values()) state.core = undefined;
}

/** Exposed for tests: the managed-install resolution the transport actually uses. */
export function __resolveBrowserCoreForTests(browser: SearchEngineBrowser): CoreResolution {
  return resolveCore(browser);
}

function resolutionFor(browser: SearchEngineBrowser): CoreResolution {
  const state = stateOf(browser);
  const cached = state.core;
  if (cached) return cached;
  const resolution = loadResolution(browser);
  if (resolution.kind === "ok") state.core = resolution;
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

/** Close one browser and forget it; never throws. It does not cancel an in-flight launch:
 *  a search replacing a dead instance still wants the replacement that launch is making. */
async function closeBrowser(browser: SearchEngineBrowser): Promise<void> {
  const state = states.get(browser);
  if (!state) return;
  const { instance, idleTimer } = state;
  state.instance = undefined;
  state.idleTimer = undefined;
  if (idleTimer) clearTimeout(idleTimer);
  if (!instance) return;
  try {
    await instance.close();
  } catch {
    /* Already gone — a stale child is not worth a tool failure. */
  }
}

/** Tear down every browser this module launched (teardown, tests). */
export async function closeBrowserSearches(): Promise<void> {
  // Cancels launches still in flight: one that lands after this must close itself rather
  // than register a browser nobody will ever hand back or reap. Clearing the in-flight
  // slot lets the next search launch immediately instead of awaiting the doomed one.
  for (const state of states.values()) {
    state.generation += 1;
    state.launching = undefined;
  }
  await Promise.all([...states.keys()].map(closeBrowser));
  for (const state of states.values()) state.core = undefined;
}

async function launch(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwBrowser> {
  const resolution = resolutionFor(browser);
  if (resolution.kind !== "ok") throw new Error(copy(resolution.kind));
  const state = stateOf(browser);
  const generation = state.generation;
  let launched: PwBrowser;
  try {
    launched = await resolution.core[browser].launch({ headless: true });
  } catch (err) {
    // A failed launch may mean the cached install went stale; let the next call re-resolve.
    state.core = undefined;
    throw new Error(copy("launchFailed", { message: messageOf(err) }));
  }
  if (state.generation !== generation) {
    await launched.close().catch(() => undefined);
    throw new Error(copy("cannotReach", { message: CANCELLED }));
  }
  state.instance = launched;
  state.idleTimer = startIdleTimer(browser);
  return launched;
}

/** The browser for this engine, launching at most one even under concurrent searches. */
async function browserFor(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwBrowser> {
  const state = stateOf(browser);
  if (state.instance) {
    state.idleTimer?.refresh?.();
    return state.instance;
  }
  if (state.launching) return state.launching;
  const pending = launch(browser, copy).finally(() => {
    if (state.launching === pending) state.launching = undefined;
  });
  state.launching = pending;
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
/** A launch that a teardown overtook; the caller lost its browser, not the network. */
const CANCELLED = "search cancelled";

/** Same shape for the first try and the post-replacement retry. */
const CONTEXT_OPTIONS = { userAgent: USER_AGENT, locale: "en-US" } as const;

async function openContext(browser: SearchEngineBrowser, copy: EngineCopy): Promise<PwContext> {
  const instance = await browserFor(browser, copy);
  try {
    return await instance.newContext(CONTEXT_OPTIONS);
  } catch (err) {
    // A dead or wedged browser is replaced once rather than failing every later search.
    await closeBrowser(browser);
    const replacement = await browserFor(browser, copy);
    try {
      return await replacement.newContext(CONTEXT_OPTIONS);
    } catch {
      throw new Error(copy("launchFailed", { message: messageOf(err) }));
    }
  }
}

/** One navigation + parse. Each attempt gets its own context so a retry looks like a
 *  brand-new visitor rather than a reload. */
interface SerpAttempt {
  results: BrowserSearchResult[];
  html: string;
  status: number;
  settled: boolean;
}

async function runSerp(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  url: string,
  signal: AbortSignal | undefined,
  parse: (html: string) => BrowserSearchResult[],
): Promise<SerpAttempt> {
  const context = await openContext(browser, copy);
  try {
    const page = await context.newPage();
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
    return { results: parse(html), html, status, settled };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Filler that carries no topic, so a reduced SERP cannot "match" on it alone. */
const QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "that",
  "from",
  "into",
  "your",
  "you",
  "are",
  "can",
]);

/** Topic words worth matching. CJK has no word boundaries, so a query with no ASCII
 *  tokens yields none and the guard stays out of its way instead of misfiring. */
function queryTokens(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [...new Set(tokens.filter((token) => !QUERY_STOPWORDS.has(token)))];
}

/** A reduced SERP answers some other query. When not one topic word of the request
 *  appears anywhere in the hits, reporting them would be worse than failing. */
function serpAnswersQuery(
  results: readonly BrowserSearchResult[],
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return true;
  const haystack = results
    .map((result) => `${result.title} ${result.url} ${result.snippet}`.toLowerCase())
    .join(" ");
  return tokens.some((token) => haystack.includes(token));
}

/** One browser-backed search: navigate the SERP, reject a reduced page, hand the HTML to
 *  the engine's parser. A failed launch or an unparseable page throws engine copy. */
export async function searchWithBrowser(
  query: string,
  opts: BrowserSearchOptions,
): Promise<BrowserSearchResult[]> {
  const { browser, parse, topK, signal } = opts;
  const copy = copyForBrowser(browser, opts.copy);
  if (signal?.aborted) throw new Error(copy("cannotReach", { message: ABORTED }));
  const url = `${SERP_URL}?q=${encodeURIComponent(query)}`;
  const tokens = queryTokens(query);

  /** The hits to return, `[]` for a page that legitimately has none, or null when the page
   *  did not answer this query (reduced, withheld, or read before it rendered). */
  const answerOf = (serp: SerpAttempt): BrowserSearchResult[] | null => {
    if (serp.results.length === 0) return EMPTY_SERP.test(serp.html) ? [] : null;
    if (!serpAnswersQuery(serp.results, tokens)) return null;
    return serp.results.slice(0, topK);
  };

  let serp = await runSerp(browser, copy, url, signal, parse);
  let answer = answerOf(serp);
  if (!answer) {
    // A fresh context is usually not served the reduced variant.
    serp = await runSerp(browser, copy, url, signal, parse);
    answer = answerOf(serp);
  }
  if (answer) return answer;
  if (serp.results.length > 0) {
    throw new Error(copy("mismatched", { first: serp.results[0]?.title ?? "" }));
  }
  throw new Error(
    serp.settled
      ? copy("blocked", { chars: serp.html.length })
      : copy("timeout", { ms: RESULT_WAIT_MS, status: serp.status }),
  );
}
