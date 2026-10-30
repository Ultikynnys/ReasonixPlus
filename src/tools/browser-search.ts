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
    opts: { waitUntil: "domcontentloaded" | "load"; timeout: number },
  ): Promise<PwResponse | null>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  waitForLoadState(state: "networkidle", opts?: { timeout: number }): Promise<void>;
  addInitScript(script: string): Promise<void>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(opts?: { type?: "png"; fullPage?: boolean }): Promise<Buffer>;
  evaluate<T>(expression: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  click(selector: string, opts?: { timeout: number }): Promise<void>;
  goBack(opts?: { timeout: number }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
}
interface PwContextOptions {
  userAgent: string;
  locale: string;
  viewport?: { width: number; height: number };
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(opts: PwContextOptions): Promise<PwContext>;
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
  /** One parser per SERP, so each page is read from the markup that produced it. */
  parsers: Record<SerpID, SerpParser>;
  topK: number;
  signal?: AbortSignal;
  /** Whole-search ceiling in ms, shared by every backend. Defaults to 60s. */
  budgetMs?: number;
  /** The agent's open page: the SERP is read through it, so search and fetch share one
   *  tab. Omitted, the search opens its own page and closes it. */
  session?: PageSession;
}

export type SerpParser = (html: string) => BrowserSearchResult[];

/** The search-result pages a managed browser may drive, in attempt order. */
export type SerpID = "duckduckgo" | "bing";

interface Serp {
  id: SerpID;
  /** Display name templated into the engine's copy, so a failure names its backend. */
  label: string;
  url: (query: string) => string;
  /** The result *node*, not the container: a container exists before any result
   *  renders, so waiting on it returns immediately and reads a mid-render DOM. */
  resultSelector: string;
  /** Text a real empty-results page carries, as opposed to one that never rendered. */
  empty: RegExp;
}

/** Attempt order. DuckDuckGo's no-JS endpoint answers a real browser in about a second
 *  with a server-rendered list; Bing is the fallback, since it intermittently serves an
 *  anti-bot interstitial or a reduced cluster but is reachable behind most networks. */
const SERPS: readonly Serp[] = [
  {
    id: "duckduckgo",
    label: "DuckDuckGo",
    url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    resultSelector: "a.result__a",
    empty: /no results/i,
  },
  {
    id: "bing",
    label: "Bing",
    // Do NOT add setlang/cc here — those switch Bing to a script-rendered variant
    // whose DOM carries no result nodes at domcontentloaded.
    url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    resultSelector: "li.b_algo",
    empty: /no results found|did not match any documents/i,
  },
];

/** Generous enough for a slow link: a 250 KB SERP needs 40s at 6 KB/s, and the
 *  result-node wait covers a page whose render scripts are still arriving. */
const NAV_TIMEOUT_MS = 40_000;
const RESULT_WAIT_MS = 20_000;
/** Whole-search ceiling across every backend, so a slow link gets real time without
 *  letting the fallback SERP run for minutes. */
const SEARCH_BUDGET_MS = 60_000;
/** Floor for one phase: a cold browser launch inside the budget must not leave the
 *  navigation behind it with no time at all. */
const MIN_PHASE_MS = 5_000;
/** A browser is expensive to launch and cheap to keep; drop it once searches stop. */
const IDLE_CLOSE_MS = 60_000;
/** Wall pages are not slowness: waiting out the full result window on one only delays
 *  the next backend. */
const SERP_WALL = /captcha|verify you are human|access denied|unusual traffic|anomaly|not a robot/i;
/** Display name of the one searchable managed build. Templated into the engine's copy so
 *  the wording lives in its JSON, not here. */
const BROWSER_LABEL = "WebKit";

/** Bind the engine copy to this browser: `{browser}` is the id, `{Browser}` the label.
 *  `{alternative}` is the engine's own suggestion, so the wording stays in its JSON. */
function copyForBrowser(browser: SearchEngineBrowser, copy: EngineCopy): EngineCopy {
  const bound = { browser, Browser: BROWSER_LABEL, alternative: copy("alternative") };
  return (key, params) => copy(key, { ...bound, ...params });
}

/** Bind one SERP's name too, so a failure says which backend answered nothing. */
function copyForSerp(copy: EngineCopy, serp: Serp): EngineCopy {
  return (key, params) => copy(key, { ...params, Serp: serp.label });
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
  /** Open page sessions; while any exist the idle timer stays off, since the page needs it. */
  pins: number;
  /** Bumped by a teardown, so a launch that finishes afterwards cannot resurrect a browser. */
  generation: number;
}

const states = new Map<SearchEngineBrowser, BrowserState>();

function stateOf(browser: SearchEngineBrowser): BrowserState {
  let state = states.get(browser);
  if (!state) {
    state = { generation: 0, pins: 0 };
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

/** Keep the browser alive while a page session is open on it. */
function pinBrowser(browser: SearchEngineBrowser): void {
  const state = stateOf(browser);
  state.pins += 1;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
  }
}

/** Release a pin; the last one restarts the idle close the page session suspended. */
function unpinBrowser(browser: SearchEngineBrowser): void {
  const state = stateOf(browser);
  state.pins = Math.max(0, state.pins - 1);
  if (state.pins === 0 && state.instance) state.idleTimer = startIdleTimer(browser);
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
    // A torn-down teardown drops every page session with its browser.
    state.pins = 0;
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
    // A pinned browser has no idle timer; a bare refresh must not resurrect one.
    if (state.pins === 0) state.idleTimer?.refresh?.();
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

async function openContext(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  options: PwContextOptions = CONTEXT_OPTIONS,
): Promise<PwContext> {
  const instance = await browserFor(browser, copy);
  try {
    return await instance.newContext(options);
  } catch (err) {
    // A dead or wedged browser is replaced once rather than failing every later search.
    await closeBrowser(browser);
    const replacement = await browserFor(browser, copy);
    try {
      return await replacement.newContext(options);
    } catch {
      throw new Error(copy("launchFailed", { message: messageOf(err) }));
    }
  }
}

/** Run `work` on a fresh page in a fresh context of the cached managed browser, then
 *  close the context. The SERP transport and the website probe share this path, so the
 *  install resolution, launch reuse and desktop UA have one home. */
/** A tool must never make noise, and a headless build still plays page audio, so every
 *  media element is muted and stopped before it can start. The same script is bundled as
 *  data/tooling/playwright/silence-media.js for the Playwright MCP server. */
export const SILENCE_MEDIA = `(() => {
  const silence = (el) => {
    try { el.muted = true; el.volume = 0; } catch (e) {}
    try { if (!el.paused) el.pause(); } catch (e) {}
  };
  const proto = window.HTMLMediaElement && HTMLMediaElement.prototype;
  if (proto && typeof proto.play === "function") {
    const play = proto.play;
    proto.play = function () {
      silence(this);
      return play.apply(this, arguments);
    };
  }
  const sweep = () => {
    for (const el of document.querySelectorAll("video,audio")) silence(el);
  };
  for (const type of ["play", "playing", "canplay", "loadeddata"]) {
    document.addEventListener(type, (e) => {
      const el = e.target;
      if (el && el.tagName && /^(VIDEO|AUDIO)$/i.test(el.tagName)) silence(el);
    }, true);
  }
  const root = document.documentElement;
  if (root) new MutationObserver(sweep).observe(root, { childList: true, subtree: true });
})();`;

async function silencePage(page: PwPage): Promise<void> {
  await page.addInitScript(SILENCE_MEDIA).catch(() => undefined);
}

export async function withManagedPage<T>(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  work: (page: PwPage) => Promise<T>,
): Promise<T> {
  const context = await openContext(browser, copyForBrowser(browser, copy));
  try {
    const page = await context.newPage();
    await silencePage(page);
    return await work(page);
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** A rendered page, as a transient window sees it. */
export interface RenderedPage {
  /** Final URL after redirects; the caller re-validates it before trusting it. */
  url: string;
  title: string;
  /** Rendered markup, for the caller's own text extraction. */
  html: string;
  /** PNG of the small viewport; absent when the capture itself failed. */
  preview?: Buffer;
}

export interface RenderOptions {
  /** Whole-render ceiling in ms. Defaults to 30s. */
  budgetMs?: number;
  signal?: AbortSignal;
}

/** Whole-render ceiling: a page fetch must not outlive its caller's patience. */
const RENDER_BUDGET_MS = 30_000;
/** The transient "small window": wide enough for a real layout, short enough to read. */
const RENDER_VIEWPORT = { width: 900, height: 1200 };
/** A page with pollers never goes quiet, so settling is best-effort and bounded. */
const RENDER_SETTLE_MS = 5_000;

/** A render that failed before the page was opened: a caller with another way to read
 *  the page can fall back from this, where a navigation failure is the page's fault. */
export class RenderUnavailableError extends Error {}

/** A render context for a call that may be stopped mid-launch. Racing the launch and the
 *  page creation is what makes a wedged browser a stopped call; a context that arrives
 *  after the stop is closed rather than leaked, and the stop keeps its abort identity. */
async function openRenderContext(
  browser: SearchEngineBrowser,
  bound: EngineCopy,
  signal: AbortSignal | undefined,
): Promise<PwContext> {
  const opening = openContext(browser, bound, {
    ...CONTEXT_OPTIONS,
    viewport: RENDER_VIEWPORT,
  });
  try {
    return await abortable(opening, signal);
  } catch (err) {
    void opening.then((context) => context.close()).catch(() => undefined);
    if (messageOf(err) === ABORTED) throw err;
    throw new RenderUnavailableError(messageOf(err));
  }
}

/** Render `url` in a transient small window of the managed browser: its own context,
 *  closed before this returns, so nothing accumulates between fetches. */
export async function renderManagedPage(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  url: string,
  opts: RenderOptions = {},
): Promise<RenderedPage> {
  const bound = copyForBrowser(browser, copy);
  if (opts.signal?.aborted) {
    throw new Error(bound("cannotReach", { message: ABORTED }));
  }
  const deadline = Date.now() + (opts.budgetMs ?? RENDER_BUDGET_MS);
  const context = await openRenderContext(browser, bound, opts.signal);
  try {
    const page = await abortable(context.newPage(), opts.signal);
    await silencePage(page);
    try {
      await abortable(
        page.goto(url, { waitUntil: "load", timeout: phaseTimeout(deadline, NAV_TIMEOUT_MS) }),
        opts.signal,
      );
    } catch (err) {
      if (messageOf(err) === ABORTED) throw new Error(bound("cannotReach", { message: ABORTED }));
      throw new Error(bound("cannotReach", { message: messageOf(err) }));
    }
    // Best effort: a page that never idles still has a usable document, and waiting on a
    // poller would burn the budget for nothing.
    await abortable(
      page.waitForLoadState("networkidle", { timeout: phaseTimeout(deadline, RENDER_SETTLE_MS) }),
      opts.signal,
    ).catch(() => undefined);
    const html = await page.content();
    const title = (await page.title().catch(() => "")).trim();
    const preview = await abortable(page.screenshot({ type: "png" }), opts.signal).catch(
      () => undefined,
    );
    return { url: page.url(), title, html, preview };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** One driven step (click, wait, back) must never hang a tool call. */
const SESSION_STEP_MS = 15_000;
/** More presses than any page needs to mount its sections. */
const SESSION_MAX_SCROLLS = 12;
/** Let newly mounted content arrive before measuring. */
const SCROLL_SETTLE_MS = 500;

/** Where the page is: enough for a caller to tell "more below" from "the end". */
export interface PageState {
  url: string;
  title: string;
  scrollY: number;
  docHeight: number;
  viewportHeight: number;
}

export interface PageSessionOptions {
  signal?: AbortSignal;
  /** Wait for this selector as part of the step, and report whether it appeared. */
  waitFor?: string;
  /** Extra settle in ms, clamped to the render settle ceiling. */
  waitMs?: number;
  /** Selectors whose presence the caller wants reported. */
  probes?: readonly string[];
}

export interface PageActionResult {
  state: PageState;
  html: string;
  preview?: Buffer;
  /** Probe selector -> present now. */
  present: Record<string, boolean>;
  /** The step found its target (element clicked, selector appeared). */
  acted: boolean;
  /** Text of the probed section itself, so a mounted region is readable without the rest
   *  of the page standing in front of it in the cap. */
  section?: { selector: string; text: string };
}

/** A page kept open between tool calls, so a site can be driven instead of one-shotted. */
export interface PageSession {
  navigate(url: string, opts?: PageSessionOptions): Promise<PageActionResult>;
  waitFor(selector: string, opts?: PageSessionOptions): Promise<PageActionResult>;
  scroll(times: number, opts?: PageSessionOptions): Promise<PageActionResult>;
  click(selector: string, opts?: PageSessionOptions): Promise<PageActionResult>;
  back(opts?: PageSessionOptions): Promise<PageActionResult>;
  read(opts?: PageSessionOptions & { fullPage?: boolean }): Promise<PageActionResult>;
  /** Position only: cheap enough to poll between steps. */
  status(opts?: PageSessionOptions): Promise<PageState>;
  close(): Promise<void>;
}

/** Text of one element, or null when the page has none. String expression, so nothing
 *  has to cross into the page. */
function sectionScript(selector: string): string {
  return `(() => {
    const name = ${JSON.stringify(selector)};
    let el = null;
    try { el = document.querySelector(name); } catch (e) { el = null; }
    if (!el) return null;
    const text = (el.innerText || el.textContent || "").trim();
    return { selector: name, text: text.slice(0, 24000) };
  })()`;
}

const PAGE_STATE_SCRIPT = `(() => {
  const doc = document.documentElement;
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY || 0),
    docHeight: doc ? doc.scrollHeight : 0,
    viewportHeight: Math.round(window.innerHeight || 0),
  };
})()`;

/** Presence of the caller's selectors. A string expression, because a transpiled closure
 *  cannot cross into the page. */
function presenceScript(selectors: readonly string[]): string {
  return `(() => {
    const out = {};
    for (const sel of ${JSON.stringify([...selectors])}) {
      try { out[sel] = Boolean(document.querySelector(sel)); } catch (e) { out[sel] = false; }
    }
    return out;
  })()`;
}

class ManagedPageSession implements PageSession {
  constructor(
    private readonly browser: SearchEngineBrowser,
    private readonly copy: EngineCopy,
    private readonly context: PwContext,
    private readonly page: PwPage,
  ) {}

  async navigate(url: string, opts: PageSessionOptions = {}): Promise<PageActionResult> {
    try {
      await abortable(
        this.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS }),
        opts.signal,
      );
    } catch (err) {
      const message = messageOf(err);
      throw new Error(this.copy("cannotReach", { message }));
    }
    return await this.snapshot(opts, false);
  }

  async waitFor(selector: string, opts: PageSessionOptions = {}): Promise<PageActionResult> {
    const appeared = await this.tryWaitFor(selector, opts);
    return await this.snapshot(opts, appeared);
  }

  async scroll(times: number, opts: PageSessionOptions = {}): Promise<PageActionResult> {
    const presses = Math.max(1, Math.min(Math.trunc(times) || 1, SESSION_MAX_SCROLLS));
    for (let press = 0; press < presses; press += 1) {
      await abortable(this.page.keyboard.press("End"), opts.signal);
      await abortable(this.page.waitForTimeout(SCROLL_SETTLE_MS), opts.signal).catch(
        () => undefined,
      );
    }
    return await this.snapshot(opts, true);
  }

  async click(selector: string, opts: PageSessionOptions = {}): Promise<PageActionResult> {
    const clicked = await abortable(
      this.page.click(selector, { timeout: SESSION_STEP_MS }),
      opts.signal,
    )
      .then(() => true)
      .catch((err: unknown) => {
        if (messageOf(err) === ABORTED) throw err;
        // A missing element is an answer, not a failure: the state reports what is there.
        return false;
      });
    return await this.snapshot({ ...opts, probes: [...(opts.probes ?? []), selector] }, clicked);
  }

  async back(opts: PageSessionOptions = {}): Promise<PageActionResult> {
    const went = await abortable(this.page.goBack({ timeout: SESSION_STEP_MS }), opts.signal)
      .then(() => true)
      .catch(() => false);
    return await this.snapshot(opts, went);
  }

  async read(opts: PageSessionOptions & { fullPage?: boolean } = {}): Promise<PageActionResult> {
    return await this.snapshot(opts, false);
  }

  /** Where the page stands, without reading it: no navigation, no markup, no screenshot. */
  async status(opts: PageSessionOptions = {}): Promise<PageState> {
    return await abortable(this.page.evaluate<PageState>(PAGE_STATE_SCRIPT), opts.signal).catch(
      () => this.blindState(),
    );
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    unpinBrowser(this.browser);
  }

  /** Wait for the caller's selector as part of a step, reporting whether it arrived. */
  private async tryWaitFor(selector: string, opts: PageSessionOptions): Promise<boolean> {
    return await abortable(
      this.page.waitForSelector(selector, { timeout: SESSION_STEP_MS }),
      opts.signal,
    )
      .then(() => true)
      .catch(() => false);
  }

  /** Settle, then report the page as it stands: markup, screenshot, position, probes. */
  private async snapshot(
    opts: PageSessionOptions & { fullPage?: boolean },
    acted: boolean,
  ): Promise<PageActionResult> {
    let hit = acted;
    if (opts.waitFor) hit = (await this.tryWaitFor(opts.waitFor, opts)) || hit;
    // Best effort: a page that never idles still has usable content.
    await abortable(
      this.page.waitForLoadState("networkidle", { timeout: RENDER_SETTLE_MS }),
      opts.signal,
    ).catch(() => undefined);
    const extra = Math.min(Math.max(opts.waitMs ?? 0, 0), RENDER_SETTLE_MS);
    if (extra > 0)
      await abortable(this.page.waitForTimeout(extra), opts.signal).catch(() => undefined);
    const state = await abortable(
      this.page.evaluate<PageState>(PAGE_STATE_SCRIPT),
      opts.signal,
    ).catch(() => this.blindState());
    const html = await abortable(this.page.content(), opts.signal);
    const preview = await abortable(
      this.page.screenshot({ type: "png", ...(opts.fullPage ? { fullPage: true } : {}) }),
      opts.signal,
    ).catch(() => undefined);
    const probes = opts.probes?.length ? opts.probes : [];
    const present = probes.length
      ? await abortable(
          this.page.evaluate<Record<string, boolean>>(presenceScript(probes)),
          opts.signal,
        ).catch(() => ({}) as Record<string, boolean>)
      : {};
    const section = probes.length
      ? ((await abortable(
          this.page.evaluate<{ selector: string; text: string } | null>(
            sectionScript(probes[0] as string),
          ),
          opts.signal,
        ).catch(() => null)) ?? undefined)
      : undefined;
    return { state, html, preview, present, acted: hit, ...(section ? { section } : {}) };
  }

  /** Position unknown (the page refused the probe), but the address is still good. */
  private blindState(): Promise<PageState> {
    return this.page.title().then(
      (title) => ({
        url: this.page.url(),
        title: title.trim(),
        scrollY: 0,
        docHeight: 0,
        viewportHeight: 0,
      }),
      () => ({ url: this.page.url(), title: "", scrollY: 0, docHeight: 0, viewportHeight: 0 }),
    );
  }
}

/** Open a page that stays open between calls. The browser is pinned while it lives, so the
 *  idle close cannot pull the page out from under the caller. */
export async function openPageSession(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  opts: { signal?: AbortSignal } = {},
): Promise<PageSession> {
  const bound = copyForBrowser(browser, copy);
  if (opts.signal?.aborted) throw new Error(bound("cannotReach", { message: ABORTED }));
  const context = await openRenderContext(browser, bound, opts.signal);
  pinBrowser(browser);
  try {
    const page = await abortable(context.newPage(), opts.signal);
    await silencePage(page);
    return new ManagedPageSession(browser, bound, context, page);
  } catch (err) {
    unpinBrowser(browser);
    await context.close().catch(() => undefined);
    if (messageOf(err) === ABORTED) throw err;
    throw new RenderUnavailableError(messageOf(err));
  }
}

/** One navigation + parse, in its own context so a retry looks like a brand-new
 *  visitor rather than a reload. */
interface SerpAttempt {
  serp: Serp;
  results: BrowserSearchResult[];
  html: string;
  status: number;
  /** The result node appeared, so an empty page is a real empty page. */
  settled: boolean;
  /** Engine copy for a navigation the browser could not complete. */
  error?: string;
  /** The navigation itself ran out of time, which points at the link, not the backend. */
  navTimedOut?: boolean;
  /** The window the result wait actually got, so the failure copy names it. */
  waitMs: number;
}

/** Time one phase may take: the ceiling, the floor, and whatever the search has left. */
function phaseTimeout(deadline: number, ceiling: number): number {
  return Math.max(MIN_PHASE_MS, Math.min(ceiling, deadline - Date.now()));
}

async function runSerp(
  browser: SearchEngineBrowser,
  copy: EngineCopy,
  serp: Serp,
  query: string,
  signal: AbortSignal | undefined,
  parse: SerpParser,
  deadline: number,
  session?: PageSession,
): Promise<SerpAttempt> {
  // A session page is the agent's own tab: the SERP is read through it, so a search and a
  // fetch share one page the way the MCP browser does.
  const context = session ? undefined : await openContext(browser, copy);
  try {
    const page = context ? await context.newPage() : undefined;
    if (page) await silencePage(page);
    let status = 0;
    let first: string;
    try {
      if (page) {
        const response = await abortable(
          page.goto(serp.url(query), {
            waitUntil: "domcontentloaded",
            timeout: phaseTimeout(deadline, NAV_TIMEOUT_MS),
          }),
          signal,
        );
        status = response?.status() ?? 0;
        first = await page.content();
      } else {
        first = (await session!.navigate(serp.url(query), { signal })).html;
      }
    } catch (err) {
      // A caller's Stop is final; an unreachable SERP leaves the next one to try.
      if (messageOf(err) === ABORTED) throw new Error(copy("cannotReach", { message: ABORTED }));
      const message = messageOf(err);
      return {
        serp,
        results: [],
        html: "",
        status,
        settled: false,
        error: copy("cannotReach", { message }),
        navTimedOut: /timeout|timed out/i.test(message),
        waitMs: 0,
      };
    }
    // What the document already carries decides whether waiting can help: a rendered
    // SERP answers now, and a wall or a real empty page will not improve with time.
    const arrived = parse(first);
    if (arrived.length > 0 || serp.empty.test(first) || SERP_WALL.test(first)) {
      return { serp, results: arrived, html: first, status, settled: true, waitMs: 0 };
    }
    const waitMs = phaseTimeout(deadline, RESULT_WAIT_MS);
    let settled = true;
    let html = first;
    try {
      if (page) {
        await abortable(page.waitForSelector(serp.resultSelector, { timeout: waitMs }), signal);
        html = await page.content();
      } else {
        html = (await session!.waitFor(serp.resultSelector, { signal })).html;
      }
    } catch (err) {
      // The caller giving up is not a withheld SERP; report it as the cancellation it is.
      if (messageOf(err) === ABORTED) throw new Error(copy("cannotReach", { message: ABORTED }));
      settled = false;
    }
    return { serp, results: parse(html), html, status, settled, waitMs };
  } finally {
    await context?.close().catch(() => undefined);
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

/** Search operators are request syntax, not topics: `site:` appears in no result, so
 *  counting it would make every site-scoped query unable to answer. */
const QUERY_OPERATOR = /\b(?:site|filetype|inurl|intitle|related)\s*:\s*/gi;
/** The host's own suffix is not a topic word either. */
const URL_NOISE_WORD = /^(?:www|com|org|net|html?)$/;

/** Topic words worth matching. CJK has no word boundaries, so a query with no ASCII
 *  tokens yields none and the guard stays out of its way instead of misfiring. */
function queryTokens(query: string): string[] {
  const text = query.replace(QUERY_OPERATOR, " ");
  const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  return [
    ...new Set(
      tokens.filter((token) => !QUERY_STOPWORDS.has(token) && !URL_NOISE_WORD.test(token)),
    ),
  ];
}

/** A mistyped query word is still that word: a five-character-or-longer token also counts
 *  when a hit carries its first four characters, so a typo never reads as an alien topic. */
function tokenPresent(token: string, haystack: string): boolean {
  if (haystack.includes(token)) return true;
  return token.length >= 5 && haystack.includes(token.slice(0, 4));
}

/** A reduced SERP answers some other query, so one stray hit repeating a single topic word
 *  must not pass the page off as an answer: a query of three words or fewer must match all
 *  of them across the hits, and a longer one tolerates a single miss. */
function serpAnswersQuery(
  results: readonly BrowserSearchResult[],
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return true;
  const haystack = results
    .map((result) => `${result.title} ${result.url} ${result.snippet}`.toLowerCase())
    .join(" ");
  const found = tokens.filter((token) => tokenPresent(token, haystack)).length;
  return found >= tokens.length - (tokens.length > 3 ? 1 : 0);
}

/** One browser-backed search: try each SERP in turn, reject a reduced page, and hand the
 *  HTML to that SERP's parser. A failed launch or an unanswerable page throws engine copy. */
export async function searchWithBrowser(
  query: string,
  opts: BrowserSearchOptions,
): Promise<BrowserSearchResult[]> {
  const { browser, parsers, topK, signal } = opts;
  const copy = copyForBrowser(browser, opts.copy);
  if (signal?.aborted) throw new Error(copy("cannotReach", { message: ABORTED }));
  const tokens = queryTokens(query);
  // One deadline for the whole search, so a slow link has room per phase without the
  // fallback backend stretching the call for minutes.
  const deadline = Date.now() + (opts.budgetMs ?? SEARCH_BUDGET_MS);

  /** The hits to return, `[]` for a page that legitimately has none, or null when the page
   *  did not answer this query (reduced, withheld, or read before it rendered). */
  const answerOf = (attempt: SerpAttempt): BrowserSearchResult[] | null => {
    if (attempt.results.length === 0) return attempt.serp.empty.test(attempt.html) ? [] : null;
    if (!serpAnswersQuery(attempt.results, tokens)) return null;
    return attempt.results.slice(0, topK);
  };

  let last: SerpAttempt | undefined;
  /** A page that answered some other query: the most informative thing to report. */
  let reduced: SerpAttempt | undefined;
  for (const serp of SERPS) {
    // The first backend always runs; a later one only gets what the budget has left.
    if (last && Date.now() >= deadline) break;
    const attempt = await runSerp(
      browser,
      copyForSerp(copy, serp),
      serp,
      query,
      signal,
      parsers[serp.id],
      deadline,
      opts.session,
    );
    const answer = answerOf(attempt);
    if (answer) return answer;
    last = attempt;
    if (attempt.results.length > 0) reduced ??= attempt;
    // A navigation that ran out of time is the link, not this backend: the next SERP is
    // a bigger download, so waiting on it would only repeat the same failure.
    if (attempt.navTimedOut) break;
  }

  if (reduced) {
    throw new Error(
      copyForSerp(copy, reduced.serp)("mismatched", { first: reduced.results[0]?.title ?? "" }),
    );
  }
  // SERPS is never empty, so an attempt ran and its failure is the reason to report.
  const failed = last!;
  const failedCopy = copyForSerp(copy, failed.serp);
  if (failed.error) throw new Error(failed.error);
  throw new Error(
    failed.settled
      ? failedCopy("blocked", { chars: failed.html.length })
      : failedCopy("timeout", { ms: failed.waitMs, status: failed.status }),
  );
}
