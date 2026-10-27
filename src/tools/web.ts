/** web_search drives whichever engine the declaration names (scraped SERP, API, or a
 *  managed browser); web_fetch sniffs HTML to text. */

import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import {
  BROWSER_SEARCH_ENGINES,
  SEARCH_ENGINE_SPECS,
  type SearchEngineBrowser,
  type SearchEngineFetchStrategy,
  type SearchEngineSpec,
  type SearchEngineStrategy,
  WEB_SEARCH_ENGINE_NAMES,
  type WebSearchEngineName,
  flattenText,
  messageOf,
  requireSearchEngineError,
  searchEngineSpec,
  sliceAlignedToCodepoint,
} from "@reasonix/core-utils";
import { parse as parseHtml } from "node-html-parser";
import {
  loadBaiduApiKey,
  loadBraveApiKey,
  loadDeepseekApiKey,
  loadExaApiKey,
  loadMetasoApiKey,
  loadOllamaApiKey,
  loadPerplexityApiKey,
  loadTavilyApiKey,
  webSearchEndpoint as loadWebSearchEndpoint,
  webSearchEngine as loadWebSearchEngine,
  loadZaiApiKey,
} from "../config.js";
import { interpolate, t } from "../i18n/index.js";
import type { ToolRegistry } from "../tools.js";
import {
  type EngineCopy,
  type PageActionResult,
  type PageSession,
  type PageSessionOptions,
  RenderUnavailableError,
  openPageSession,
  renderManagedPage,
  searchWithBrowser,
} from "./browser-search.js";
import { mergeSignals } from "./jobs.js";
import { pruneScreenshots, screenshotDir } from "./screenshot-dir.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** AI-generated answer text — set by AI-native engines (Perplexity, Exa); undefined for traditional engines. */
  answer?: string;
}

export interface PageContent {
  url: string;
  title?: string;
  text: string;
  /** True when the extracted text was clipped to fit the cap. */
  truncated: boolean;
  /** A screenshot of the rendered page, for the desktop card to display. */
  previewPath?: string;
  /** Something the reader should know about how this page was obtained. */
  note?: string;
  /** Where the driven page stands, so a caller can decide whether to scroll more. */
  page?: {
    scrollY: number;
    docHeight: number;
    viewportHeight: number;
    acted: boolean;
  };
  /** Selectors the caller asked about, and whether the page has them now. */
  present?: Record<string, boolean>;
  /** Text of the probed element, so a mounted region can be read on its own. */
  section?: { selector: string; text: string };
  /** Source markup, when the reader has it, so a saved copy keeps its structure. */
  html?: string;
}

export interface WebFetchOptions {
  /** Max bytes of extracted text. Defaults to 32_000 to match tool-result cap. */
  maxChars?: number;
  /** Timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
  /** Config path for provider-specific keys. Defaults to ~/.reasonix/config.json. */
  configPath?: string;
  /** Workspace root, so a rendered page preview lands where the desktop can show it. */
  rootDir?: string;
  signal?: AbortSignal;
}

export interface WebSearchOptions {
  topK?: number;
  signal?: AbortSignal;
  /** The agent's open page, when the engine drives one: the search reads that page. */
  page?: PageSession;
  /** A page to read as a result list instead of a general SERP. `{q}`/`%s` takes the query. */
  url?: string;
  /** CSS selector for that page's result anchors. Defaults to every `a[href]`. */
  linkSelector?: string;
  /** Config path for provider-specific keys. Defaults to ~/.reasonix/config.json. */
  configPath?: string;
  /** Backend engine: "bing" (scrapes cn.bing.com HTML — default, works from CN without proxy), "bing-intl" (www.bing.com, indexes international sites), "searxng" (self-hosted SearXNG), "metaso" (Metaso API), "baidu" (Baidu AI Search API), "tavily" (LLM-friendly JSON API), "perplexity" (Perplexity AI), "exa" (Exa API), "brave" (Brave Search API), or "ollama" (Ollama cloud web search). */
  engine?: WebSearchEngineName;
  /** Base URL for SearXNG. Default http://localhost:8080. */
  endpoint?: string;
}

const DEFAULT_FETCH_MAX_CHARS = 32_000;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_TOPK = 5;
/** Timeout applied to every outbound search request — a blocked/slow engine must not hang the research step forever. */
const SEARCH_TIMEOUT_MS = 15_000;
/** Bytes cap applied before `resp.text()`: capped at 2.5 MB to avoid excessive bandwidth usage on metered or poor connections. */
const FETCH_MAX_BYTES = Math.floor(2.5 * 1024 * 1024);
// Real-browser UA. Most search backends gate obvious scraper UAs; a stock
// Chrome string clears the fast-path block.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// cn.bing.com over www.bing.com — CN endpoint returns raw URLs in the
// HTML; the international endpoint wraps them in `bing.com/ck/a?u=a1<base64>`
// click-tracking redirects we'd have to decode per result.
const BING_ENDPOINT = "https://cn.bing.com/search";
const BING_INTL_ENDPOINT = "https://www.bing.com/search";
const METASO_ENDPOINT = "https://metaso.cn/api/v1";
const BAIDU_AI_SEARCH_ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const EXA_ENDPOINT = "https://api.exa.ai/answer";
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const OLLAMA_WEB_SEARCH_ENDPOINT = "https://ollama.com/api/web_search";
const OLLAMA_WEB_FETCH_ENDPOINT = "https://ollama.com/api/web_fetch";
const ZAI_WEB_SEARCH_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";
const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";
/** Documented cap on the query field; longer text is rejected by the API itself. */
const DEEPSEEK_MAX_QUERY_CHARS = 128;
const FETCH_MAX_REDIRECTS = 5;

/** A backend failure: the engine could not answer. Config errors stay plain Errors. */
class SearchBackendError extends Error {}
/** The declaration behind this call — dispatchSearch has always pinned opts.engine. */
function specFor(opts: WebSearchOptions): SearchEngineSpec | undefined {
  const id = opts.engine ?? WEB_SEARCH_ENGINE_NAMES.at(0);
  return id ? searchEngineSpec(id) : undefined;
}

/** Copy accessor for the engine answering this call (dispatchSearch pins it). */
function copyFor(opts: WebSearchOptions): EngineCopy {
  const spec = specFor(opts);
  if (!spec) throw new Error(NO_ENGINE_MESSAGE);
  return (key, params) => interpolate(requireSearchEngineError(spec, key), params);
}

/** Pick the engine's status-specific message so the model gets an actionable hint
 *  written for that backend, not a generic status. */
function searchStatusError(copy: EngineCopy, status: number): string {
  if (status === 429) return copy("rateLimit");
  if (status === 403) return copy("forbidden");
  if (status >= 500 && status <= 599) return copy("serverError", { status });
  return copy("status", { status });
}

function fetchStatusError(status: number, url: string): string {
  if (status === 429) return t("webErrors.fetchRateLimit429", { url });
  if (status === 403) return t("webErrors.fetchForbidden403", { url });
  if (status >= 500 && status <= 599) return t("webErrors.fetchServerError5xx", { status, url });
  return t("webErrors.fetchStatus", { status, url });
}

/** Statuses a bot-gated host uses to refuse a plain read. A real browser usually passes. */
const BLOCKED_FETCH_STATUSES: ReadonlySet<number> = new Set([403, 406, 429, 503]);

/** A plain read was refused by a host that gates bots, so a render may still succeed. */
export class FetchBlockedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    // The refusal keeps the plain Error name, so a caller that reports it reads the same
    // sentence it did before the browser fallback existed.
    this.status = status;
  }
}

// Shared fetch helpers for JSON search APIs.

interface SearchApiErrorMap {
  authError: string;
  cannotReach: (endpoint: string) => string;
  rateLimitError: string;
  serverError: (status: number) => string;
}

/** Combine caller's abort signal with the per-request search timeout — an
 *  engine that neither responds nor respects the caller's abort (firewalled
 *  connections, dead hosts) gets cut off after SEARCH_TIMEOUT_MS. */
function searchSignal(callerSignal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, t]) : t;
}

/** fetch → TypeError→cannotReach → status→error map.  Returns the raw Response
 *  so callers can choose text()/json()/whatever. */
async function fetchSearchApi(
  endpoint: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  errMap: SearchApiErrorMap,
): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(endpoint, { ...init, signal: searchSignal(signal) });
  } catch (err) {
    if (err instanceof TypeError && (err as Error).message.includes("fetch")) {
      throw new SearchBackendError(errMap.cannotReach(endpoint));
    }
    throw err;
  }
  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) throw new Error(errMap.authError);
    if (resp.status === 429) throw new SearchBackendError(errMap.rateLimitError);
    throw new SearchBackendError(errMap.serverError(resp.status));
  }
  return resp;
}

/** Guarded `JSON.parse` — throws `engineParseError` on malformed JSON. */
function parseSearchJson<T>(raw: string, parseError: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(parseError);
  }
}

/** Merge AI answer + citations into SearchResult[] — shared by Perplexity and Exa.
 *  Citations without a url are skipped. */
function toAnswerFirstResults(
  answer: string,
  citations: Array<{ title?: string; url?: string; snippet?: string }>,
  topK: number,
): SearchResult[] {
  const results: SearchResult[] = [];
  if (answer) {
    results.push({ title: answer, url: "", snippet: "", answer });
  }
  const count = Math.min(citations.length, topK);
  for (let i = 0; i < count; i++) {
    const c = citations[i]!;
    if (!c.url) continue;
    results.push({
      title: c.title || `Source ${i + 1}`,
      url: c.url,
      snippet: c.snippet ?? "",
    });
  }
  return results;
}

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function ipv4InRange(value: number, base: string, bits: number): boolean {
  const parsed = parseIpv4(base);
  if (parsed === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (parsed & mask);
}

function isPrivateIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  return (
    ipv4InRange(value, "0.0.0.0", 8) ||
    ipv4InRange(value, "10.0.0.0", 8) ||
    ipv4InRange(value, "100.64.0.0", 10) ||
    ipv4InRange(value, "127.0.0.0", 8) ||
    ipv4InRange(value, "169.254.0.0", 16) ||
    ipv4InRange(value, "172.16.0.0", 12) ||
    ipv4InRange(value, "192.0.0.0", 24) ||
    ipv4InRange(value, "192.0.2.0", 24) ||
    ipv4InRange(value, "192.168.0.0", 16) ||
    ipv4InRange(value, "198.18.0.0", 15) ||
    ipv4InRange(value, "198.51.100.0", 24) ||
    ipv4InRange(value, "203.0.113.0", 24) ||
    ipv4InRange(value, "224.0.0.0", 4) ||
    ipv4InRange(value, "240.0.0.0", 4)
  );
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().replace(/(^|:)0+([0-9a-f])/g, "$1$2");
}

function isPrivateIpv6(address: string): boolean {
  const normalized = normalizeIpv6(address);
  const mapped = /^::ffff:(?:0+:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(normalized);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

/** DoH fallback for when system DNS returns Fake-IP (TUN proxies). */
interface DohAnswer {
  type: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

async function dohResolve(host: string): Promise<string[]> {
  const url = new URL("https://1.1.1.1/dns-query");
  url.searchParams.set("name", host);
  url.searchParams.set("type", "A");

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`DoH resolve failed: HTTP ${resp.status} for ${host}`);

  const data = (await resp.json()) as DohResponse;
  if (data.Status !== 0)
    throw new Error(`DoH resolve failed: DNS status ${data.Status} for ${host}`);

  const addresses = (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);

  if (addresses.length === 0) throw new Error(`DoH resolve returned no A records for ${host}`);
  return addresses;
}

async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`web_fetch refuses non-HTTP URL: ${url.protocol}`);
  }

  const host = url.hostname;
  const literal = isIP(host);
  if (literal) {
    if (isInternalAddress(host)) {
      throw new Error(`web_fetch refuses internal or reserved host: ${host}`);
    }
    return url;
  }

  // Primary: system DNS
  const sysAddrs = (await lookup(host, { all: true, verbatim: true })).map((e) => e.address);

  if (sysAddrs.length === 0) {
    throw new Error(`web_fetch refuses internal or reserved host: ${host}`);
  }

  if (sysAddrs.some(isInternalAddress)) {
    // System DNS returned fake/internal addresses (e.g. TUN Fake-IP) —
    // fall back to DoH to get the real public IPs
    const dohAddrs = await dohResolve(host).catch(() => null);
    if (!dohAddrs || dohAddrs.some(isInternalAddress)) {
      throw new Error(`web_fetch refuses internal or reserved host: ${host}`);
    }
    // DoH resolved to public IPs → host is legitimate
  }

  return url;
}

function redirectLocation(resp: Response, currentUrl: string): string | null {
  if (resp.status < 300 || resp.status > 399) return null;
  const location = resp.headers.get("location");
  if (!location) return null;
  return new URL(location, currentUrl).toString();
}

/** Transport per declared strategy, so a new engine needs no dispatch branch here. */
const SEARCH_TRANSPORTS: Readonly<
  Record<SearchEngineStrategy, (query: string, opts: WebSearchOptions) => Promise<SearchResult[]>>
> = {
  "bing-html": (query, opts) => searchBing(query, opts),
  "bing-intl": (query, opts) => searchBing(query, opts, BING_INTL_ENDPOINT),
  searxng: searchSearxng,
  metaso: searchMetaso,
  baidu: searchBaidu,
  tavily: searchTavily,
  perplexity: searchPerplexity,
  exa: searchExa,
  brave: searchBrave,
  ollama: searchOllama,
  zai: searchZai,
  deepseek: searchDeepseek,
  playwright: searchPlaywright,
};

/** Shown when no engine file exists, so the failure names its own fix. */
const NO_ENGINE_MESSAGE = "no web-search engine is declared — add a search-engines/<id>.json file";

/** Route to the engine named in `opts`, else the first declared engine. The configured
 *  engine is resolved by the caller, so this never reads config. Throws on backend failure. */
async function dispatchSearch(query: string, opts: WebSearchOptions): Promise<SearchResult[]> {
  const spec = (opts.engine ? searchEngineSpec(opts.engine) : undefined) ?? SEARCH_ENGINE_SPECS[0];
  if (!spec) throw new Error(NO_ENGINE_MESSAGE);
  return SEARCH_TRANSPORTS[spec.strategy](query, opts);
}

/** One attempt against the configured engine, and nothing else: a second index
 *  returns different results, so answering from another engine would present one
 *  provider's junk as this engine's answer. A failure here reaches the caller. */
export async function webSearch(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const engine = opts.engine ?? WEB_SEARCH_ENGINE_NAMES.at(0);
  if (!engine) throw new Error(NO_ENGINE_MESSAGE);
  // A supplied page is read as the result list: any site's search becomes searchable here,
  // which is the freedom a browser gives and a fixed SERP list does not.
  const url = opts.url;
  if (url) return (await webSearchByUrl(query, { ...opts, engine, url })).results;
  return dispatchSearch(query, { ...opts, engine });
}

async function searchBing(
  query: string,
  opts: WebSearchOptions = {},
  endpoint = BING_ENDPOINT,
): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: searchSignal(opts.signal),
      redirect: "follow",
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new SearchBackendError(copy("cannotReach", { endpoint }));
  }
  if (!resp.ok) throw new SearchBackendError(searchStatusError(copy, resp.status));
  const html = await resp.text();
  const results = parseBingResults(html).slice(0, topK);
  if (results.length === 0) {
    if (/no results found|did not match any documents/i.test(html)) return [];
    if (/captcha|verify you are human|access denied|forbidden/i.test(html)) {
      throw new SearchBackendError(copy("blocked"));
    }
    throw new SearchBackendError(
      copy("noResults", {
        chars: html.length,
        preview: flattenText(html.slice(0, 120)),
      }),
    );
  }
  return results;
}

/** Parse + validate a SearXNG endpoint. Returns origin (protocol + host). */
function normalizeSearxngEndpoint(raw: string, copy: EngineCopy): string {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    throw new Error(copy("invalidEndpoint", { endpoint: raw }));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(copy("endpointMustBeHttp", { protocol: url.protocol }));
  }
  return url.origin;
}

async function searchSearxng(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  const baseUrl = normalizeSearxngEndpoint(opts.endpoint ?? "http://localhost:8080", copy);

  // JSON API is often blocked by SearXNG's default limiter; HTML always works.
  const url = `${baseUrl}/search?format=html&q=${encodeURIComponent(query)}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      signal: searchSignal(opts.signal),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new SearchBackendError(
      copy("cannotReach", { endpoint: opts.endpoint ?? "http://localhost:8080" }),
    );
  }
  if (!resp.ok) throw new SearchBackendError(searchStatusError(copy, resp.status));
  const html = await resp.text();
  const results = parseSearxngHtmlResults(html).slice(0, topK);
  if (results.length === 0) {
    if (/no results found|did not match any documents/i.test(html)) return [];
    throw new SearchBackendError(copy("noResults", { chars: html.length }));
  }
  return results;
}

interface MetasoWebpage {
  title: string;
  link: string;
  snippet?: string;
  summary?: string;
  score?: string;
  position?: number;
  date?: string;
}

interface MetasoSearchResponse {
  credits?: number;
  total?: number;
  webpages?: MetasoWebpage[];
  code?: number;
  message?: string;
}

async function searchMetaso(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(100, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadMetasoApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    `${METASO_ENDPOINT}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ q: query, scope: "webpage", size: topK }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const raw = await resp.text();
  const data = parseSearchJson<MetasoSearchResponse>(
    raw,
    copy("parseError", { status: resp.status }),
  );

  if (data.code === 3003) {
    throw new Error(copy("dailyLimit"));
  }
  if (data.code === 2005) {
    throw new Error(copy("unauthorized"));
  }
  if (data.code && data.code !== 0) {
    throw new Error(copy("apiError", { code: data.code, message: data.message ?? "" }));
  }

  const webpages = data.webpages ?? [];
  if (webpages.length === 0) {
    return [];
  }

  return webpages.slice(0, topK).map((wp) => ({
    title: wp.title,
    url: wp.link,
    snippet: wp.snippet ?? wp.summary ?? "",
  }));
}

interface ZaiSearchItem {
  title?: string;
  content?: string;
  link?: string;
}

interface ZaiSearchResponse {
  search_result?: ZaiSearchItem[];
}

async function searchZai(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(50, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadZaiApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    ZAI_WEB_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en-US,en",
      },
      body: JSON.stringify({
        search_engine: "search-prime",
        search_query: query,
        count: topK,
      }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (status) => copy("serverError", { status }),
    },
  );

  const data = parseSearchJson<ZaiSearchResponse>(
    await resp.text(),
    copy("parseError", { status: resp.status }),
  );
  return (data.search_result ?? [])
    .filter((item) => typeof item.title === "string" && typeof item.link === "string")
    .slice(0, topK)
    .map((item) => ({
      title: item.title!,
      url: item.link!,
      snippet: item.content ?? "",
    }));
}

interface BaiduReference {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
}

interface BaiduSearchResponse {
  references?: BaiduReference[];
}

async function searchBaidu(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadBaiduApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  // fetchSearchApi classifies HTTP errors (401/403/429/5xx) BEFORE the JSON
  // parse below — error bodies are not JSON, so ordering matters.
  const resp = await fetchSearchApi(
    BAIDU_AI_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: query }],
      }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const raw = await resp.text();
  const data = parseSearchJson<BaiduSearchResponse>(
    raw,
    copy("parseError", { status: resp.status }),
  );

  return (data.references ?? [])
    .filter((r) => typeof r.title === "string" && typeof r.url === "string")
    .slice(0, topK)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: r.content ?? r.snippet ?? "",
    }));
}

interface TavilyResultItem {
  title: string;
  url: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilyResultItem[];
  // Tavily error responses use { detail: { error: "..." } } shape.
  detail?: { error?: string } | string;
}

async function searchTavily(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(20, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadTavilyApiKey();
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    TAVILY_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: topK,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  let data: TavilySearchResponse;
  try {
    data = (await resp.json()) as TavilySearchResponse;
  } catch {
    throw new Error(copy("parseError", { status: resp.status }));
  }

  const results = data.results ?? [];
  return results.slice(0, topK).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? "",
  }));
}

interface PerplexityChoice {
  message?: { content?: string };
}

interface PerplexityResponse {
  choices?: PerplexityChoice[];
  citations?: unknown[];
}

async function searchPerplexity(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(20, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadPerplexityApiKey();
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    PERPLEXITY_ENDPOINT,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar",
        messages: [{ role: "user", content: query }],
        max_tokens: 1024,
        return_related_questions: false,
      }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const raw = await resp.text();
  const data = parseSearchJson<PerplexityResponse>(
    raw,
    copy("parseError", { status: resp.status }),
  );

  const answer = data.choices?.[0]?.message?.content ?? "";
  // Perplexity citations may be plain URLs (string) or objects with .url/.title.
  const rawCitations = Array.isArray(data.citations) ? data.citations : [];
  const citations = rawCitations.map((c, i) => {
    if (typeof c === "string") return { url: c, title: `Source ${i + 1}` };
    if (c && typeof c === "object") {
      const item = c as Record<string, unknown>;
      return {
        url: typeof item.url === "string" ? item.url : undefined,
        title: typeof item.title === "string" ? (item.title as string) : `Source ${i + 1}`,
      };
    }
    return { url: undefined as string | undefined };
  });
  return toAnswerFirstResults(answer, citations, topK);
}

interface ExaCitation {
  url?: string;
  title?: string;
  text?: string;
  publishedDate?: string;
}

interface ExaAnswerResponse {
  answer?: string;
  citations?: ExaCitation[];
}

async function searchExa(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(20, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadExaApiKey();
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    EXA_ENDPOINT,
    {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, text: true }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const raw = await resp.text();
  const data = parseSearchJson<ExaAnswerResponse>(raw, copy("parseError", { status: resp.status }));

  return toAnswerFirstResults(
    data.answer ?? "",
    (data.citations ?? []).map((c) => ({ title: c.title, url: c.url, snippet: c.text })),
    topK,
  );
}

interface OllamaSearchItem {
  title?: string;
  url?: string;
  content?: string;
}

interface OllamaSearchResponse {
  results?: OllamaSearchItem[];
}

async function searchOllama(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadOllamaApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    OLLAMA_WEB_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, max_results: topK }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  let data: OllamaSearchResponse;
  try {
    data = (await resp.json()) as OllamaSearchResponse;
  } catch {
    throw new Error(copy("parseError", { status: resp.status }));
  }

  return (data.results ?? []).slice(0, topK).map((r, i) => ({
    title: r.title || `Result ${i + 1}`,
    url: r.url || "",
    snippet: r.content ?? "",
  }));
}

interface DeepseekSearchItem {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
}

interface DeepseekSearchResponse {
  results?: DeepseekSearchItem[];
}

/** DeepSeek's own Search API: a plain JSON endpoint with ranked results, unlike the
 *  hosted model-tool searches other providers expose. */
async function searchDeepseek(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(50, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadDeepseekApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  const resp = await fetchSearchApi(
    DEEPSEEK_SEARCH_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: sliceAlignedToCodepoint(query, DEEPSEEK_MAX_QUERY_CHARS),
        count: topK,
        need_content: false,
      }),
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const data = parseSearchJson<DeepseekSearchResponse>(
    await resp.text(),
    copy("parseError", { status: resp.status }),
  );

  return (data.results ?? [])
    .filter((r) => typeof r.title === "string" && typeof r.url === "string")
    .slice(0, topK)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: r.snippet ?? r.summary ?? "",
    }));
}

interface DeepseekFetchResponse {
  title?: string;
  content?: string;
}

/** DeepSeek's Fetch API returns the page as Markdown, so no HTML sniffing here. */
async function webFetchDeepseek(
  url: string,
  opts: WebFetchOptions,
  copy: EngineCopy,
): Promise<PageContent & { links?: string[] }> {
  const apiKey = loadDeepseekApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("fetchMissingKey"));
  return fetchEnginePage(url, {
    endpoint: DEEPSEEK_FETCH_ENDPOINT,
    apiKey,
    copy,
    maxChars: opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    signal: opts.signal,
  });
}

/** Local, key-less search through a Playwright-managed browser; the engine's own JSON
 *  names which build to drive, so adding a browser is a declaration, not a branch. */
async function searchPlaywright(
  query: string,
  opts: WebSearchOptions = {},
): Promise<SearchResult[]> {
  const browser = specFor(opts)?.browser;
  if (!browser) throw new Error(`web_search: engine "${opts.engine}" declares no browser`);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  return searchWithBrowser(query, {
    browser,
    copy: copyFor(opts),
    parsers: { duckduckgo: parseDuckDuckGoResults, bing: parseBingResults },
    topK,
    signal: opts.signal,
    ...(opts.page ? { session: opts.page } : {}),
  });
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

async function searchBrave(query: string, opts: WebSearchOptions = {}): Promise<SearchResult[]> {
  const copy = copyFor(opts);
  const topK = Math.max(1, Math.min(20, opts.topK ?? DEFAULT_TOPK));
  const apiKey = loadBraveApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("missingKey"));

  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${topK}`;

  const resp = await fetchSearchApi(
    url,
    {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    },
    opts.signal,
    {
      authError: copy("unauthorized"),
      cannotReach: (endpoint) => copy("cannotReach", { endpoint }),
      rateLimitError: copy("rateLimit"),
      serverError: (s) => copy("serverError", { status: s }),
    },
  );

  const raw = await resp.text();
  const data = parseSearchJson<BraveSearchResponse>(
    raw,
    copy("parseError", { status: resp.status }),
  );

  const results = data.web?.results ?? [];
  return results.slice(0, topK).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

interface EngineFetchPage {
  title?: string;
  content?: string;
  links?: string[];
}

/** The shape every engine-owned fetch API shares: POST `{url}`, bearer auth, and a
 *  JSON page back. One implementation so both (and the next one) map errors identically. */
interface EngineFetchRequest {
  endpoint: string;
  apiKey: string;
  copy: EngineCopy;
  maxChars: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Clip extracted text to the caller's cap, reporting whether anything was dropped. */
function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}

/** Clip to the cap and mark the cut in the text itself, so a reader knows it was cut. */
function finishPageText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const capped = capText(text, maxChars);
  return capped.truncated
    ? { text: `${capped.text}\n\n[… truncated ${text.length - maxChars} chars …]`, truncated: true }
    : capped;
}

async function fetchEnginePage(
  url: string,
  request: EngineFetchRequest,
): Promise<PageContent & { links?: string[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, ctrl.signal]) : ctrl.signal;

  let resp: Response;
  try {
    resp = await fetch(request.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (err) {
    if (request.signal?.aborted) throw err;
    if (ctrl.signal.aborted) {
      throw new Error(t("webErrors.fetchTimeout", { ms: request.timeoutMs, url }));
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403)
      throw new Error(request.copy("fetchUnauthorized"));
    if (resp.status === 429) throw new Error(request.copy("fetchRateLimit"));
    throw new Error(request.copy("fetchServerError", { status: resp.status, url }));
  }

  let data: EngineFetchPage;
  try {
    data = (await resp.json()) as EngineFetchPage;
  } catch {
    throw new Error(request.copy("fetchParseError", { url }));
  }

  const text = data.content ?? "";
  const capped = capText(text, request.maxChars);
  return {
    url,
    title: data.title,
    text: capped.text,
    truncated: capped.truncated,
    links: data.links,
  };
}

async function webFetchOllama(
  url: string,
  opts: WebFetchOptions,
  copy: EngineCopy,
): Promise<PageContent & { links?: string[] }> {
  const apiKey = loadOllamaApiKey(opts.configPath);
  if (!apiKey) throw new Error(copy("fetchMissingKey"));
  return fetchEnginePage(url, {
    endpoint: OLLAMA_WEB_FETCH_ENDPOINT,
    apiKey,
    copy,
    maxChars: opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    signal: opts.signal,
  });
}

/** `web_fetch` transport per declared fetch strategy. A strategy this map lacks is a
 *  declaration error, reported rather than silently served by the generic fetch. */
type FetchTransport = (
  url: string,
  opts: WebFetchOptions,
  copy: EngineCopy,
  spec: SearchEngineSpec,
) => Promise<PageContent & { links?: string[] }>;

/** Persist a rendered page's screenshot where the desktop card can display it. */
function savePagePreview(png: Buffer, rootDir: string | undefined): string | undefined {
  try {
    const dir = screenshotDir(rootDir);
    const path = join(dir, `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    writeFileSync(path, png);
    pruneScreenshots(dir, "page-");
    return path;
  } catch {
    return undefined;
  }
}

/** Render `url` in the engine's managed browser and shape it as a fetch result. */
async function renderPage(
  browser: SearchEngineBrowser,
  url: string,
  opts: WebFetchOptions,
  copy: EngineCopy,
): Promise<PageContent> {
  const rendered = await renderManagedPage(browser, copy, url, { signal: opts.signal });
  // A redirect must not turn a public fetch into a local one.
  const finalUrl = await assertPublicHttpUrl(rendered.url);
  return {
    url: finalUrl.toString(),
    title: rendered.title || extractTitle(rendered.html),
    ...finishPageText(htmlToText(rendered.html), opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS),
    previewPath: rendered.preview ? savePagePreview(rendered.preview, opts.rootDir) : undefined,
  };
}

/** Error copy for a browser-driven render, taken from the engine that owns that browser so
 *  the wording is the one its declaration authored. */
function browserRenderCopy(browser: SearchEngineBrowser): EngineCopy {
  const owner = SEARCH_ENGINE_SPECS.find((spec) => spec.browser === browser);
  return owner ? copyFor({ engine: owner.id as WebSearchEngineName }) : (key: string) => key;
}

/** `http` engines read the page directly, but a host that gates bots refuses a plain
 *  client while rendering for a real one, so those refusals retry in the managed browser. */
async function webFetchDirect(
  url: string,
  opts: WebFetchOptions,
): Promise<PageContent & { links?: string[] }> {
  try {
    return await webFetch(url, opts);
  } catch (err) {
    if (!(err instanceof FetchBlockedError)) throw err;
    for (const browser of BROWSER_SEARCH_ENGINES) {
      try {
        const page = await renderPage(browser, url, opts, browserRenderCopy(browser));
        return {
          ...page,
          note: `render: plain read refused (${err.status}); page rendered in the managed browser`,
        };
      } catch {
        // This build cannot render right now, so the refusal stands as the answer.
      }
    }
    throw err;
  }
}

/** Render the page in the engine's managed browser: text a plain read cannot see, plus a
 *  screenshot of the page as the card's preview. */
async function webFetchPlaywright(
  url: string,
  opts: WebFetchOptions,
  copy: EngineCopy,
  spec: SearchEngineSpec,
): Promise<PageContent & { links?: string[] }> {
  const browser = spec.browser;
  if (!browser) {
    throw new Error(`web_fetch: engine "${spec.id}" declares rendering with no browser`);
  }
  try {
    return await renderPage(browser, url, opts, copy);
  } catch (err) {
    if (!(err instanceof RenderUnavailableError)) throw err;
    // No usable managed browser: a plain read still answers the question, and the note
    // says the text may be missing script-rendered content.
    const page = await webFetch(url, opts);
    return { ...page, note: `render: unavailable (${messageOf(err)})` };
  }
}

const FETCH_TRANSPORTS: ReadonlyMap<SearchEngineFetchStrategy, FetchTransport> = new Map<
  SearchEngineFetchStrategy,
  FetchTransport
>([
  ["http", (url: string, opts: WebFetchOptions) => webFetchDirect(url, opts)],
  ["ollama", (url, opts, copy) => webFetchOllama(url, opts, copy)],
  ["deepseek", (url, opts, copy) => webFetchDeepseek(url, opts, copy)],
  ["playwright", (url, opts, copy, spec) => webFetchPlaywright(url, opts, copy, spec)],
]);

/** A page kept open for one agent session, so a site can be driven across tool calls. */
interface LivePage {
  session: PageSession;
  browser: SearchEngineBrowser;
}

/** One page per agent session: it lives until the agent closes it, the way a browser tab
 *  stays open between tool calls. No idle timer, because a later call must find the page
 *  it left, including after a long think. */
const livePages = new Map<string, LivePage>();

function pageKey(sessionName: string, browser: SearchEngineBrowser): string {
  return `${sessionName}\u0000${browser}`;
}

async function closeLivePage(key: string): Promise<void> {
  const entry = livePages.get(key);
  if (!entry) return;
  livePages.delete(key);
  await entry.session.close().catch(() => undefined);
}

/** Close every driven page (teardown and tests). */
export async function closeWebFetchPages(): Promise<void> {
  await Promise.all([...livePages.keys()].map((key) => closeLivePage(key)));
}

async function livePageFor(sessionName: string, browser: SearchEngineBrowser): Promise<LivePage> {
  const key = pageKey(sessionName, browser);
  const existing = livePages.get(key);
  if (existing) return existing;
  const session = await openPageSession(browser, browserRenderCopy(browser));
  const entry: LivePage = { session, browser };
  livePages.set(key, entry);
  return entry;
}

/** What a driven call asked the page to do. */
export interface WebFetchControl {
  url?: string;
  action?: "read" | "status" | "scroll" | "click" | "wait" | "back" | "close" | "reset";
  selector?: string;
  scrolls?: number;
  waitMs?: number;
  fullPage?: boolean;
  /** Save the page here instead of returning its whole body, for the file tools to read. */
  outFile?: string;
}

function drivenResult(
  result: PageActionResult,
  opts: WebFetchOptions & { fullPage?: boolean },
): PageContent {
  const text = htmlToText(result.html);
  const maxChars = opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS;
  return {
    url: result.state.url,
    title: result.state.title || undefined,
    ...finishPageText(text, maxChars),
    previewPath: result.preview ? savePagePreview(result.preview, opts.rootDir) : undefined,
    page: {
      scrollY: result.state.scrollY,
      docHeight: result.state.docHeight,
      viewportHeight: result.state.viewportHeight,
      acted: result.acted,
    },
    html: result.html,
    present: result.present,
    ...(result.section ? { section: result.section } : {}),
  };
}

/** One control step on an open page. */
function actOnPage(
  session: PageSession,
  control: WebFetchControl,
  step: PageSessionOptions,
): Promise<PageActionResult> {
  switch (control.action) {
    case "scroll":
      return session.scroll(control.scrolls ?? 1, step);
    case "click":
      return session.click(control.selector as string, step);
    case "wait":
      return session.waitFor(control.selector as string, step);
    case "back":
      return session.back(step);
    default:
      return session.read({ ...step, fullPage: control.fullPage });
  }
}

/** Page-gone errors: a crashed browser or a closed context, not a bad request. */
const DEAD_PAGE = /target page|has been closed|context was closed|browser has been closed/i;

/** Run `work` on the session page. A navigation may reopen once, since a dead browser is
 *  recoverable there; a step cannot, because a fresh page has nothing to step on. */
async function withLivePage<T>(
  sessionName: string,
  browser: SearchEngineBrowser,
  canReopen: boolean,
  work: (page: PageSession) => Promise<T>,
): Promise<T> {
  const entry = await livePageFor(sessionName, browser);
  try {
    return await work(entry.session);
  } catch (err) {
    if (!canReopen || !DEAD_PAGE.test(messageOf(err))) throw err;
    await closeLivePage(pageKey(sessionName, browser));
    const reopened = await livePageFor(sessionName, browser);
    return await work(reopened.session);
  }
}

/** Drive the session's page: navigate, act, then report what the page holds now. */
async function fetchDrivenPage(
  control: WebFetchControl,
  opts: WebFetchOptions,
  browser: SearchEngineBrowser,
  sessionName: string,
): Promise<PageContent & { links?: string[] }> {
  const action = control.action ?? "read";
  if (action === "close" || action === "reset") {
    await closeLivePage(pageKey(sessionName, browser));
    return {
      url: control.url ?? "",
      text: "page: closed; the next call opens a fresh page",
      truncated: false,
    };
  }
  if ((action === "click" || action === "wait") && !control.selector) {
    throw new Error(`web_fetch: action "${action}" needs a selector`);
  }
  const open = livePages.get(pageKey(sessionName, browser));
  if (action === "status") {
    // Inspecting the page must never fail: "nothing open" is a state, not an error.
    if (!open) {
      return { url: "", text: "page: closed; nothing is open in this session", truncated: false };
    }
    const at = await open.session.status({ signal: opts.signal });
    return {
      url: at.url,
      title: at.title || undefined,
      text: "",
      truncated: false,
      page: {
        scrollY: at.scrollY,
        docHeight: at.docHeight,
        viewportHeight: at.viewportHeight,
        acted: false,
      },
    };
  }
  if (!control.url && !open) {
    throw new Error(
      "web_fetch: no page is open in this session; pass a url to open one, then act on it",
    );
  }
  const step: PageSessionOptions = {
    signal: opts.signal,
    waitMs: control.waitMs,
    ...(control.selector ? { probes: [control.selector] } : {}),
  };
  const url = control.url;
  const result = await withLivePage(sessionName, browser, Boolean(url), async (page) => {
    const opened = url ? await page.navigate(url, step) : undefined;
    if (action !== "read") return await actOnPage(page, control, step);
    return opened ?? (await actOnPage(page, control, step));
  });
  return drivenResult(result, opts);
}
/** Parse SearXNG HTML search results using node-html-parser. */
export function parseSearxngHtmlResults(html: string): SearchResult[] {
  const root = parseHtml(html);
  const results: SearchResult[] = [];

  // Try <article class="result"> first (default SearXNG theme)
  const articles = root.querySelectorAll("article.result, div.result");
  if (articles.length > 0) {
    for (const article of articles) {
      const link = article.querySelector("h3 a, h4 a, a[href^='http']");
      if (!link) continue;
      const href = link.getAttribute("href");
      if (!href) continue;
      const title = link.textContent.trim();
      if (!title) continue;
      let snippet = "";
      for (const p of article.querySelectorAll("p")) {
        const text = p.textContent.trim();
        if (text.length > 10 && !text.includes(title)) {
          snippet = text;
          break;
        }
      }
      if (!snippet) {
        const cs = article.querySelector(".content, .result-content, [class*='snippet']");
        if (cs) snippet = cs.textContent.trim();
      }
      results.push({ title, url: href, snippet });
    }
    return results;
  }

  // Fallback: <h3><a href> pairs directly
  for (const a of root.querySelectorAll("h3 a[href]")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#")) continue;
    const title = a.textContent.trim();
    if (!title) continue;
    let snippet = "";
    const p = a.parentNode?.parentNode?.querySelector("p");
    if (p) snippet = p.textContent.trim();
    results.push({ title, url: href, snippet });
  }
  return results;
}

/** Decode Bing /ck/a click-tracking redirects to the real target. www.bing.com (bing-intl) emits
 *  these as root-relative `/ck/a?…` hrefs, so resolve against a base before parsing (a bare
 *  `new URL("/ck/a?…")` throws); the `u=a1…` value is base64url, often unpadded. */
function unwrapBingUrl(href: string): string {
  if (!/\/ck\/a\b/.test(href)) return href;
  try {
    const u = new URL(href, BING_INTL_ENDPOINT).searchParams.get("u");
    if (!u) return href;
    const b64 = u.startsWith("a1") ? u.slice(2) : u;
    const decoded = Buffer.from(b64, "base64url").toString("utf-8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // ignore decode errors and fall back to raw href
  }
  return href;
}

/** DuckDuckGo's HTML SERP wraps some destinations in `/l/?uddg=<encoded target>`; the
 *  wrapper is click bookkeeping, never a destination. */
function unwrapDuckDuckGoUrl(href: string): string {
  if (!/(?:^|\/\/)duckduckgo\.com\/l\//i.test(href)) return href;
  try {
    const target = new URL(href, "https://duckduckgo.com").searchParams.get("uddg");
    if (target && /^https?:\/\//i.test(target)) return target;
  } catch {
    // Fall through to the raw href rather than losing the hit.
  }
  return href;
}

/** Hosts that are the SERP's own shell (privacy, feedback, account), never a destination
 *  worth navigating to or citing. A real microsoft.com/learn docs hit is still kept. */
const SERP_NOISE_HOSTS = /(?:^|\.)bing\.com$|^go\.microsoft\.com$|^account\.microsoft\.com$/i;

/** Click bookkeeping, not page identity: stripped before dedupe and from the returned URL. */
const TRACKING_PARAMS: readonly string[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "msclkid",
  "form",
  "ref",
  "sp",
  "ghc",
  "ghsh",
  "guru",
];

/** Fragments that are click bookkeeping rather than a place in the target page. */
const TRACKING_FRAGMENT = /^#(?:utm_|mce_temp_url|_ga=)/i;

/** Snippet cap: a rich card can nest a whole stylesheet, and the model needs a line. */
const SERP_SNIPPET_MAX = 320;
/** Title cap: a drifted layout can hand back a whole sentence as an anchor's text. */
const SERP_TITLE_MAX = 200;

/** A navigable, de-tracked URL, or null when the anchor is not a destination at all. */ function cleanResultUrl(
  href: string,
): string | null {
  const unwrapped = unwrapDuckDuckGoUrl(unwrapBingUrl(href));
  let url: URL;
  try {
    url = new URL(unwrapped);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (SERP_NOISE_HOSTS.test(url.hostname)) return null;
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  // The fragment is a destination in its own right (`#L120-L130` code lines, `#auth` docs
  // sections), so only click bookkeeping is dropped, never the anchor.
  if (url.hash.length > 1 && TRACKING_FRAGMENT.test(url.hash)) url.hash = "";
  return url.toString();
}

/** A promoted block is an ad: marked by class, by an ad-click href, or by its label. */
function isPromotedBlock(block: ReturnType<typeof parseHtml>): boolean {
  const tokens = (block.getAttribute("class") ?? "").toLowerCase().split(/\s+/);
  if (
    tokens.some((token) => token === "b_ad" || token.startsWith("b_ad_") || token === "b_promoted")
  ) {
    return true;
  }
  if (block.querySelector("a[href*='/aclick']")) return true;
  return /sponsored|anzeige|gesponsert/i.test(block.getAttribute("aria-label") ?? "");
}

/** The slice of a parsed node the text walk reads. */
interface TextNode {
  nodeType: number;
  text?: string;
  rawTagName?: string;
  childNodes?: TextNode[];
}

/** Elements that end a line of text. A separator after anything else would split a word
 *  Bing bolded mid-token (`win<strong>dows</strong>`) or a URL broken across spans. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "tr",
  "ul",
]);

/** A node's text with block boundaries separated and style/script bodies dropped.
 *  `textContent` glues neighbours ("Rust Programming Languagehttps://…") and carries a
 *  nested `<style>` verbatim, so neither is a summary on its own. */
function readableText(node: ReturnType<typeof parseHtml>): string {
  const parts: string[] = [];
  const visit = (current: TextNode): void => {
    // 3 is TEXT_NODE; node-html-parser's `text` is the entity-decoded form.
    if (current.nodeType === 3) {
      parts.push(current.text ?? "");
      return;
    }
    const tag = current.rawTagName?.toLowerCase() ?? "";
    if (tag === "script" || tag === "style" || tag === "noscript") return;
    for (const child of current.childNodes ?? []) visit(child);
    if (BLOCK_TAGS.has(tag)) parts.push(" ");
  };
  visit(node as unknown as TextNode);
  return flattenText(parts.join(""));
}

/** A stylesheet or script body is not a summary: drop it rather than ship CSS. */
function isMarkupNoise(text: string): boolean {
  return /(?:^|[\s;])[.#][\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*\s*\{[^}]*\}/.test(text);
}

/** Clip at a word boundary without splitting a surrogate pair (issue #1970). */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = sliceAlignedToCodepoint(text, max);
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

/** Short, readable snippet: flattened, CSS/junk rejected, capped. */
function snippetText(raw: string): string {
  const text = flattenText(raw);
  if (!text || isMarkupNoise(text)) return "";
  return clipText(text, SERP_SNIPPET_MAX);
}

/** Readable summary of a hit: Bing's caption if present, else its own text minus the title. */
function serpSnippet(block: ReturnType<typeof parseHtml>, title: string): string {
  for (const selector of ["div.b_caption p", ".b_snippet", "[class*='b_lineclamp']", "p"]) {
    const found = block.querySelector(selector);
    const text = found ? snippetText(readableText(found)) : "";
    if (text) return text;
  }
  const blockText = snippetText(readableText(block));
  return (blockText.startsWith(title) ? blockText.slice(title.length) : blockText).trim();
}

/** Organic SERP hits only: ads, tracking redirects, the SERP's own chrome, duplicate
 *  targets and unreadable blocks are dropped so the caller gets usable destinations. */
function createSerpCollector(): {
  results: SearchResult[];
  add: (title: string, href: string, snippet: string) => void;
} {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const add = (title: string, href: string, snippet: string) => {
    const url = cleanResultUrl(href);
    const cleanTitle = snippetText(title);
    if (!url || !cleanTitle || seen.has(url)) return;
    seen.add(url);
    results.push({
      title: clipText(cleanTitle, SERP_TITLE_MAX),
      url,
      snippet: flattenText(snippet),
    });
  };
  return { results, add };
}

/** Bing's organic hits. Ads, tracking redirects, Bing's own chrome, duplicate targets
 *  and unreadable blocks are dropped so the caller gets destinations it can use. */
export function parseBingResults(html: string): SearchResult[] {
  // DOM walk rather than regex — `<li[^>]*\bclass\b[^>]*>` triggers
  // polynomial backtracking on adversarial input (CodeQL js/polynomial-redos).
  const root = parseHtml(html);
  const { results, add } = createSerpCollector();

  for (const block of root.querySelectorAll("li.b_algo")) {
    if (isPromotedBlock(block)) continue;
    const anchor = block.querySelector("h2 a[href]") ?? block.querySelector("a[href]");
    if (!anchor) continue;
    const title = anchor.textContent ?? "";
    add(title, anchor.getAttribute("href") ?? "", serpSnippet(block, flattenText(title)));
  }
  if (results.length > 0) return results;

  // Layout drift: no b_algo blocks at all. Harvest readable anchors from the results
  // container instead of reporting a withheld page.
  const container = root.querySelector("#b_results") ?? root;
  for (const anchor of container.querySelectorAll("a[href]")) {
    const title = readableText(anchor);
    // Chrome links ("All", "Images", "›") carry no destination worth keeping.
    if (title.length < 3) continue;
    const block = anchor.parentNode?.parentNode ?? anchor.parentNode;
    add(title, anchor.getAttribute("href") ?? "", block ? snippetText(readableText(block)) : "");
  }
  return results;
}

/** DuckDuckGo's no-JS SERP: each hit is a `.result` block whose `a.result__a` carries the
 *  title and destination, with its own `.result__snippet`. Sponsored blocks are marked
 *  `result--ad`, and DDG wraps some destinations in a `/l/?uddg=` redirect. */
export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const root = parseHtml(html);
  const { results, add } = createSerpCollector();
  for (const block of root.querySelectorAll(".result")) {
    const classes = block.getAttribute("class") ?? "";
    if (/(?:^|\s)result--ad(?:\s|$)/.test(classes)) continue;
    const anchor = block.querySelector("a.result__a[href]");
    if (!anchor) continue;
    const title = flattenText(readableText(anchor));
    const snippet = block.querySelector(".result__snippet");
    add(
      title,
      anchor.getAttribute("href") ?? "",
      snippet
        ? snippetText(readableText(snippet))
        : snippetText(readableText(block).replace(title, "")),
    );
  }
  return results;
}

export async function webFetch(url: string, opts: WebFetchOptions = {}): Promise<PageContent> {
  const maxChars = opts.maxChars ?? DEFAULT_FETCH_MAX_CHARS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const ctl = new AbortController();
  // Track whether the abort came from our internal timer vs the caller's
  // signal — only the timer-driven abort should produce a "timed out" hint.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  // Forward the caller's abort too so an Esc during a long fetch is respected.
  const cancel = () => ctl.abort();
  opts.signal?.addEventListener("abort", cancel, { once: true });
  let resp: Response;
  let currentUrl = url;
  try {
    for (let redirects = 0; ; redirects++) {
      const parsed = await assertPublicHttpUrl(currentUrl);
      if (ctl.signal.aborted) throw new DOMException("aborted", "AbortError");
      resp = await fetch(parsed, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain,*/*" },
        signal: ctl.signal,
        redirect: "manual",
      });
      const nextUrl = redirectLocation(resp, parsed.toString());
      if (!nextUrl) break;
      if (redirects >= FETCH_MAX_REDIRECTS) {
        throw new Error(`web_fetch redirect limit exceeded for ${url}`);
      }
      currentUrl = nextUrl;
    }
  } catch (err) {
    if (timedOut) {
      throw new Error(t("webErrors.fetchTimeout", { ms: timeoutMs, url }));
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
  }
  if (!resp.ok) {
    const message = fetchStatusError(resp.status, url);
    throw BLOCKED_FETCH_STATUSES.has(resp.status)
      ? new FetchBlockedError(message, resp.status)
      : new Error(message);
  }
  const contentType = resp.headers.get("content-type") ?? "";
  // Pre-check Content-Length when the server provides it. Cheaper to
  // refuse upfront than to start streaming a 1GB ISO.
  const declaredLen = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > FETCH_MAX_BYTES) {
    throw new Error(t("webErrors.fetchTooLarge", { len: declaredLen, cap: FETCH_MAX_BYTES, url }));
  }
  const raw = await readBodyCapped(resp, FETCH_MAX_BYTES);
  const title = extractTitle(raw);
  const isHtml = contentType.includes("text/html");
  const text = isHtml ? htmlToText(raw) : raw;
  return {
    url: currentUrl,
    title,
    ...finishPageText(text, maxChars),
    ...(isHtml ? { html: raw } : {}),
  };
}

/** Streams + caps so chunked responses (or servers lying about Content-Length) can't balloon the heap. */
async function readBodyCapped(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return await resp.text();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* already torn down */
        }
        throw new Error(t("webErrors.fetchBodyTooLarge", { cap: maxBytes, seen: total }));
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader already cancelled / released */
    }
  }
  return out;
}

/** Hard cap so the per-request HTML budget stays linear-time even on adversarial pages. */
const MAX_HTML_INPUT = 5 * 1024 * 1024;

const STRIP_BLOCK_TAGS = "script, style, noscript, nav, footer, aside, svg";

/** Block-level tags that should produce a paragraph break in the extracted text. */
const BLOCK_BREAK_TAGS = new Set([
  "p",
  "div",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "section",
  "article",
]);

export function htmlToText(html: string): string {
  const input = html.length > MAX_HTML_INPUT ? html.slice(0, MAX_HTML_INPUT) : html;
  // Real HTML parser — sidesteps the well-known regex anti-patterns
  // (`<X[\s\S]*?</X>`, `<[^>]+>`) CodeQL flags as bad-tag-filter and
  // incomplete-multi-character-sanitization.
  const root = parseHtml(input);
  for (const node of root.querySelectorAll(STRIP_BLOCK_TAGS)) node.remove();

  const out: string[] = [];
  walkExtract(root, out);
  let s = out.join("");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/** Saved copies keep headings, list items and links, so a file tool can outline and grep them. */
const MARKDOWN_HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export function htmlToMarkdown(html: string): string {
  const input = html.length > MAX_HTML_INPUT ? html.slice(0, MAX_HTML_INPUT) : html;
  const root = parseHtml(input);
  for (const node of root.querySelectorAll(STRIP_BLOCK_TAGS)) node.remove();
  const out: string[] = [];
  walkMarkdown(root, out, 0);
  return decodeHtmlEntities(out.join(""))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkMarkdown(node: WalkableNode, out: string[], depth: number): void {
  if (node.nodeType === 3) {
    const text = node.rawText ?? node.text ?? "";
    if (!/^\s*<[!?]/.test(text)) out.push(text);
    return;
  }
  const tag = node.rawTagName?.toLowerCase();
  const child = () => {
    for (const next of node.childNodes) walkMarkdown(next, out, depth + 1);
  };
  if (tag && MARKDOWN_HEADINGS.has(tag)) {
    out.push(`\n\n${"#".repeat(Number(tag[1]))} `);
    child();
    out.push("\n\n");
    return;
  }
  if (tag === "li") {
    out.push(`\n${"  ".repeat(Math.min(depth, 4))}- `);
    child();
    out.push("\n");
    return;
  }
  if (tag === "pre") {
    out.push("\n\n```\n");
    child();
    out.push("\n```\n\n");
    return;
  }
  if (tag === "a") {
    const href = nodeAttr(node, "href");
    if (href && /^https?:/i.test(href)) {
      out.push("[");
      child();
      out.push(`](${href})`);
      return;
    }
    child();
    return;
  }
  if (tag && BLOCK_BREAK_TAGS.has(tag)) {
    out.push("\n");
    child();
    out.push("\n");
    return;
  }
  child();
}

/** How much of a page may land on disk when the caller saves it. */
const SAVE_MAX_CHARS = 2_000_000;

/** How much of a saved page still comes back inline, so a caller can tell what it got. */
const SAVED_HEAD_CHARS = 1_500;

export interface SavedPage {
  path: string;
  chars: number;
  lines: number;
}

/** Write a page under the workspace so the file tools can read and search it. */
export function saveFetchedPage(page: PageContent, outFile: string, rootDir?: string): SavedPage {
  const root = resolve(rootDir ?? process.cwd());
  const wanted = resolve(root, outFile);
  const isDir = /[\\/]$/.test(outFile) || (existsSync(wanted) && statSync(wanted).isDirectory());
  const body = page.html ? htmlToMarkdown(page.html) : page.text;
  const ext = page.html ? "md" : "txt";
  const target = isDir ? join(wanted, `page-${Date.now()}-${slugFor(page)}.${ext}`) : wanted;
  const inside = relative(root, target);
  if (inside.startsWith("..")) {
    throw new Error(`web_fetch: outFile must stay inside the workspace (${outFile})`);
  }
  const heading = [`url: ${page.url}`];
  if (page.title) heading.push(`title: ${page.title}`);
  heading.push(`fetched: ${new Date().toISOString()}`);
  const section = page.section ? `\n\n## ${page.section.selector}\n\n${page.section.text}` : "";
  const content = `${heading.join("\n")}\n\n${body}${section}\n`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return {
    path: target,
    chars: content.length,
    lines: content.split("\n").length,
  };
}

function slugFor(page: PageContent): string {
  const source = page.title ?? page.url;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "page";
}

interface WalkableNode {
  nodeType: number;
  rawText?: string;
  text?: string;
  rawTagName?: string;
  childNodes: WalkableNode[];
}

/** Elements carry attributes, text nodes do not; the walk sees both. */
function nodeAttr(node: WalkableNode, name: string): string | null {
  const read = (node as { getAttribute?: (key: string) => string | null }).getAttribute;
  return typeof read === "function" ? read.call(node, name) : null;
}

function walkExtract(node: WalkableNode, out: string[]): void {
  // nodeType 3 = TEXT_NODE; 1 = ELEMENT_NODE per node-html-parser.
  if (node.nodeType === 3) {
    const text = node.rawText ?? node.text ?? "";
    // The parser reports a doctype as a text node; that is markup, not page content.
    if (!/^\s*<[!?]/.test(text)) out.push(text);
    return;
  }
  const tag = node.rawTagName?.toLowerCase();
  const isBreak = tag !== undefined && BLOCK_BREAK_TAGS.has(tag);
  if (isBreak) out.push("\n");
  for (const child of node.childNodes) walkExtract(child, out);
  if (isBreak) out.push("\n");
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Single-pass decode — the previous chained `replace`s decoded `&amp;lt;` into `<` because `&amp;` ran before `&lt;`. */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (raw, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    if (name.startsWith("#")) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : raw;
    }
    return HTML_ENTITIES[name.toLowerCase()] ?? raw;
  });
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  return flattenText(m[1]) || undefined;
}

export interface WebToolsOptions {
  /** Default top-K for `web_search` when the model doesn't specify. */
  defaultTopK?: number;
  /** Byte cap for `web_fetch` extracted text. */
  maxFetchChars?: number;
  /** Config path to read at tool-call time. Defaults to ~/.reasonix/config.json. */
  configPath?: string;
  /** Workspace root fallback for rendered page previews when the call has none. */
  rootDir?: string;
}

/** One line telling a caller where the page stands and what it can do next. */
export function formatPageState(page: PageContent): string {
  const at = page.page;
  if (!at) return "";
  const below = Math.max(0, at.docHeight - (at.scrollY + at.viewportHeight));
  const parts = [
    `acted=${at.acted ? "yes" : "no"}`,
    `scrollY=${at.scrollY}/${at.docHeight}`,
    `viewport=${at.viewportHeight}`,
    below > 0 ? `below=${below} (scroll for more)` : "below=0 (end of page)",
  ];
  const probes = Object.entries(page.present ?? {});
  const present = probes.length
    ? `\npresent: ${probes.map(([selector, there]) => `${selector}=${there ? "yes" : "no"}`).join(", ")}`
    : "";
  return `page: ${parts.join(" ")}${present}`;
}

/** Every `{q}`/`%s` in a template becomes the encoded query; a template without either is
 *  read as-is, so a fixed listing page works too. */
export function fillQueryTemplate(template: string, query: string): string {
  const encoded = encodeURIComponent(query);
  if (/\{q\}|%s/.test(template)) return template.replace(/\{q\}|%s/g, encoded);
  return template;
}

/** Anchors that are page furniture on a listing: counters, controls, and back-links. */
const ANCHOR_NOISE =
  /^(?:\d+\s*)?(?:comments?|likes?|points?|shares?|replies|save|share|upvotes?|downvotes?|back to top|next|previous|log ?in|sign ?up)$/i;

/** Anchors on a page, scored by how much of the query they carry. A site's own search page
 *  has no schema to parse, so relevance and de-duplication stand in for one. */
function parseAnchorResults(
  html: string,
  baseUrl: string,
  query: string,
  opts: { topK: number; linkSelector?: string },
): SearchResult[] {
  const root = parseHtml(html);
  const anchors = root.querySelectorAll(opts.linkSelector ?? "a[href]");
  const tokens = query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const seen = new Set<string>();
  const scored: Array<{ result: SearchResult; score: number }> = [];
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // A link back to this page is navigation, not a result.
    if (url.href === baseUrl) continue;
    const title = flattenText(anchor.textContent ?? "");
    if (!title) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const block = anchor.parentNode;
    const snippet = block
      ? flattenText((block.textContent ?? "").replace(title, "")).slice(0, 240)
      : "";
    const haystack = `${title} ${snippet}`.toLowerCase();
    const score = tokens.filter((token) => haystack.includes(token)).length;
    // Link farms and cards pad a page with counters and controls; those are not results.
    if (title.length < 3 || ANCHOR_NOISE.test(title)) continue;
    scored.push({ result: { title, url: url.href, snippet }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.topK).map((entry) => entry.result);
}

/** Read `opts.url` as a result list: the page is rendered, which is what reaches a site's
 *  own search instead of a fixed SERP. */
async function webSearchByUrl(
  query: string,
  opts: WebSearchOptions & { url: string },
): Promise<{ results: SearchResult[]; source: string }> {
  const target = fillQueryTemplate(opts.url, query);
  const topK = Math.max(1, Math.min(10, opts.topK ?? DEFAULT_TOPK));
  if (!/^https?:\/\//i.test(target)) throw new Error(t("webErrors.fetchInvalidUrl"));
  const signal = opts.signal;
  const page = opts.page;
  let opened: PageActionResult;
  let owned: PageSession | undefined;
  if (page) {
    opened = await page.navigate(target, { signal });
  } else {
    // A library caller has no session page: borrow one for this search and hand it back.
    const browser =
      (opts.engine ? searchEngineSpec(opts.engine)?.browser : null) ?? BROWSER_SEARCH_ENGINES[0];
    owned = await openPageSession(browser, browserRenderCopy(browser), { signal });
    try {
      opened = await owned.navigate(target, { signal });
    } catch (err) {
      await owned.close().catch(() => undefined);
      throw err;
    }
  }
  try {
    return {
      results: parseAnchorResults(opened.html, opened.state.url, query, {
        topK,
        ...(opts.linkSelector ? { linkSelector: opts.linkSelector } : {}),
      }),
      source: opened.state.url,
    };
  } finally {
    await owned?.close().catch(() => undefined);
  }
}

export function registerWebTools(registry: ToolRegistry, opts: WebToolsOptions = {}): ToolRegistry {
  const defaultTopK = opts.defaultTopK ?? DEFAULT_TOPK;
  const maxFetchChars = opts.maxFetchChars ?? DEFAULT_FETCH_MAX_CHARS;
  let consecutiveEmptySearches = 0;

  registry.register({
    name: "web_search",
    description:
      "Search the public web. Returns ranked results with title, url, and snippet. Call this when the answer's correctness depends on current state: anything that changes over time (events, prices, releases, status of a thing in the real world). Composing such answers from training memory invents stale numbers; search first, then ground the answer in the results. For evergreen / definitional questions you don't need this.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        topK: {
          type: "integer",
          description: `Number of results to return. Default ${defaultTopK}.`,
        },
        url: {
          type: "string",
          description:
            "Read this page as the result list instead of a general search engine: any site's own search or a fixed listing page. `{q}` or `%s` is replaced with the URL-encoded query, for example https://www.youtube.com/results?search_query={q}. The result names the page in a source: line.",
        },
        linkSelector: {
          type: "string",
          description:
            "CSS selector for that page's result anchors, when the default (every link) returns navigation instead of results.",
        },
      },
      required: ["query"],
    },
    fn: async (
      args: { query: string; topK?: number; url?: string; linkSelector?: string },
      ctx,
    ) => {
      // Read at call time, not registration time — the engine setting mutates config mid-session (#1309).
      const engine = loadWebSearchEngine(opts.configPath);
      const endpoint = loadWebSearchEndpoint(opts.configPath);
      const spec = engine ? searchEngineSpec(engine) : undefined;
      const browser = spec?.browser ?? null;
      const signal = mergeSignals(ctx?.signal, ctx?.cancelSignal);
      const sessionName = ctx?.sessionName ?? "default";
      // A browser engine reads the SERP through the agent's own page, so a search and a
      // fetch share one tab, as the MCP browser does. A cancelled call opens nothing, and a
      // direct-read engine opens nothing unless this call needs a page to read.
      const needsPage = browser !== null || Boolean(args.url);
      const live =
        needsPage && !signal?.aborted
          ? await livePageFor(sessionName, browser ?? BROWSER_SEARCH_ENGINES[0]).catch(
              () => undefined,
            )
          : undefined;
      let source: string | undefined;
      let results: SearchResult[];
      if (args.url) {
        if (!fillQueryTemplate(args.url, args.query).startsWith("http")) {
          throw new Error(t("webErrors.fetchInvalidUrl"));
        }
        const driven = await webSearchByUrl(args.query, {
          url: args.url,
          ...(args.linkSelector ? { linkSelector: args.linkSelector } : {}),
          topK: args.topK ?? defaultTopK,
          engine,
          endpoint,
          configPath: opts.configPath,
          signal,
          ...(live ? { page: live.session } : {}),
        });
        results = driven.results;
        source = driven.source;
        if (results.length === 0) {
          throw new Error(
            `web_search: no result links on ${source}${args.linkSelector ? ` matching "${args.linkSelector}"` : ""}; pass linkSelector to target that page's anchors`,
          );
        }
      } else {
        results = await webSearch(args.query, {
          topK: args.topK ?? defaultTopK,
          // A managed browser takes seconds to launch and load, so the per-call Stop has
          // to reach it too, not only the turn's Esc.
          signal,
          engine,
          endpoint,
          configPath: opts.configPath,
          ...(live ? { page: live.session } : {}),
        });
      }
      if (results.length === 0) {
        consecutiveEmptySearches++;
      } else {
        consecutiveEmptySearches = 0;
      }
      let formatted = formatSearchResults(args.query, results, engine, source);
      if (consecutiveEmptySearches >= 2) {
        formatted +=
          "\n\n[Directive] Consecutive web searches returned 0 results. STOP web searches for this issue. You must pivot to an alternative solution in the codebase or prompt the user for clarification.";
      }
      return formatted;
    },
  });

  registry.register({
    name: "web_fetch",
    description:
      "Read a web page as a browser sees it. Returns visible text (scripts/styles/nav stripped), truncated at the tool-result cap, plus a preview image of the page. Use after web_search when a snippet is not enough. One page stays open for the whole session, so drive it as a loop: action=scroll when content is below, action=click or action=wait to open and settle sections, a selector to read one element, action=back, then action=close. A new url replaces the page. Pass outFile to park a long page on disk and get only its head back.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Absolute http:// or https:// URL to navigate to. Omit to act on the page already open in this session.",
        },
        action: {
          type: "string",
          enum: ["read", "status", "scroll", "click", "wait", "back", "close"],
          description:
            "read (default) reports the page now; status reports whether a page is open and where it stands, cheaply; scroll moves down (see scrolls); click and wait need a selector; back goes to the previous page; close shuts the page, which otherwise stays open for the whole session.",
        },
        selector: {
          type: "string",
          description:
            "CSS selector to click, to wait for, or to report presence for. Its state appears as present: in the result.",
        },
        scrolls: {
          type: "integer",
          description: "For action=scroll: how many screens to move down. Default 1.",
        },
        waitMs: {
          type: "integer",
          description:
            "Extra settle in milliseconds after the step, capped at 5000. Use for a section that renders after its data request.",
        },
        fullPage: {
          type: "boolean",
          description:
            "Capture the whole page as the preview instead of the visible window. Costs more bandwidth on a long page.",
        },
        outFile: {
          type: "string",
          description:
            "Write the page to this file instead of returning its body, and return only a head of it. Headings, lists and links are kept, so reading and searching it with the file tools works. Relative paths resolve against the workspace; end the path with a separator to auto-name the file.",
        },
      },
    },
    fn: async (args: WebFetchControl, ctx) => {
      const signal = mergeSignals(ctx?.signal, ctx?.cancelSignal);
      if (args.url && !/^https?:\/\//i.test(args.url)) {
        throw new Error(t("webErrors.fetchInvalidUrl"));
      }
      if (!args.url && !args.action) {
        throw new Error(t("webErrors.fetchInvalidUrl"));
      }
      // Read at call time, not registration time — the engine setting mutates config mid-session (#1309).
      const engine = loadWebSearchEngine(opts.configPath);
      const spec = engine ? searchEngineSpec(engine) : undefined;
      if (!spec) throw new Error(NO_ENGINE_MESSAGE);
      const fetchOpts: WebFetchOptions = {
        // A saved page is parsed from disk, so the write needs the whole body.
        maxChars: args.outFile ? SAVE_MAX_CHARS : maxFetchChars,
        signal,
        configPath: opts.configPath,
        rootDir: ctx?.rootDir ?? opts.rootDir,
      };
      // Declared, not branched: an engine that owns a fetch API names it in its JSON.
      const transport = FETCH_TRANSPORTS.get(spec.fetchStrategy);
      if (!transport) {
        throw new Error(
          `web_fetch: engine "${spec.id}" declares fetchStrategy "${spec.fetchStrategy}"`,
        );
      }
      const sessionName = ctx?.sessionName ?? "default";
      const browser = spec.browser ?? BROWSER_SEARCH_ENGINES[0];
      // A browser engine always drives a page; a direct-read engine only when the call asks
      // for page control, so a plain read keeps its fast path.
      const driven =
        spec.browser !== null ||
        Boolean(args.action) ||
        Boolean(args.selector) ||
        Boolean(args.scrolls);
      let page: PageContent & { links?: string[] };
      if (driven) {
        try {
          page = await fetchDrivenPage(args, fetchOpts, browser, sessionName);
        } catch (err) {
          if (!(err instanceof RenderUnavailableError) || !args.url) throw err;
          // No usable browser: a plain read still answers, and the note says it did.
          page = {
            ...(await transport(
              args.url,
              fetchOpts,
              copyFor({ engine: spec.id as WebSearchEngineName }),
              spec,
            )),
            note: `render: unavailable (${messageOf(err)})`,
          };
        }
      } else {
        page = await transport(
          args.url as string,
          fetchOpts,
          copyFor({ engine: spec.id as WebSearchEngineName }),
          spec,
        );
      }
      const head = [`engine: ${engine}`];
      if (page.previewPath) head.push(`preview: ${page.previewPath}`);
      const header = page.title ? `${page.title}\n${page.url}` : page.url;
      const links = page.links?.length ? `\n\nlinks:\n${page.links.join("\n")}` : "";
      const note = page.note ? `\n\n[${page.note}]` : "";
      const state = page.page ? `\n\n${formatPageState(page)}` : "";
      // The probed element on its own: a mounted section is often past the text cap.
      const section = page.section
        ? `\n\nsection [${page.section.selector}]:\n${page.section.text.slice(0, maxFetchChars)}`
        : "";
      const noPage = args.action === "close" || args.action === "reset" || args.action === "status";
      if (args.outFile && !noPage) {
        // A long page belongs on disk: the file tools page through it without flooding
        // the transcript, and only a head comes back here as proof of what was saved.
        const saved = saveFetchedPage(page, args.outFile, fetchOpts.rootDir);
        head.push(`saved: ${saved.path} (${saved.chars} chars, ${saved.lines} lines)`);
        const body = page.text.slice(0, SAVED_HEAD_CHARS);
        return `${head.join("\n")}\n\n${header}\n\nhead (${body.length} of ${page.text.length} chars):\n${body}${links}${state}${note}`;
      }
      return `${head.join("\n")}\n\n${header}\n\n${page.text}${section}${links}${state}${note}`;
    },
  });

  return registry;
}

export function formatSearchResults(
  query: string,
  results: SearchResult[],
  engine?: string,
  /** The page that was read as a result list, when the search was a navigation. */
  source?: string,
): string {
  const lines: string[] = [`query: ${query}`];
  if (engine) lines.push(`engine: ${engine}`);
  if (source) lines.push(`source: ${source}`);

  // Check if the first result carries an AI answer (Perplexity/Exa)
  const hasAnswer = results.length > 0 && results[0]?.url === "" && results[0]?.answer;

  if (results.length === 0) {
    lines.push("\nresults (0): (no matches found)");
    lines.push(
      "\n[Guidance] Search returned 0 results. If looking up internal, mod-specific, or obscure identifiers, web search will likely not find them. Do not repeat searches for this topic: pivot to local code inspection, design around the missing detail (e.g. logging names instead of resolving internal numeric IDs), or ask the user.",
    );
    return lines.join("\n");
  }

  if (hasAnswer) {
    lines.push("\nanswer:");
    lines.push(`  ${results[0]!.answer}`);
    const sources = results.slice(1);
    lines.push(`\nsources (${sources.length}):`);
    sources.forEach((r, i) => {
      lines.push(`\n${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
  } else {
    lines.push(`\nresults (${results.length}):`);
    results.forEach((r, i) => {
      lines.push(`\n${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
    });
  }

  return lines.join("\n");
}
