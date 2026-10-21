/** web_search uses Bing (cn.bing.com — works from CN without proxy); web_fetch sniffs HTML to text. */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  SEARCH_ENGINE_SPECS,
  type SearchEngineFetchStrategy,
  type SearchEngineSpec,
  type SearchEngineStrategy,
  WEB_SEARCH_ENGINE_NAMES,
  type WebSearchEngineName,
  flattenText,
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
import { type EngineCopy, searchWithBrowser } from "./browser-search.js";

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
}

export interface WebFetchOptions {
  /** Max bytes of extracted text. Defaults to 32_000 to match tool-result cap. */
  maxChars?: number;
  /** Timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
  /** Config path for provider-specific keys. Defaults to ~/.reasonix/config.json. */
  configPath?: string;
  signal?: AbortSignal;
}

export interface WebSearchOptions {
  topK?: number;
  signal?: AbortSignal;
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
    parse: parseBingResults,
    topK,
    signal: opts.signal,
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
) => Promise<PageContent & { links?: string[] }>;

const FETCH_TRANSPORTS: ReadonlyMap<SearchEngineFetchStrategy, FetchTransport> = new Map<
  SearchEngineFetchStrategy,
  FetchTransport
>([
  ["http", (url: string, opts: WebFetchOptions) => webFetch(url, opts)],
  ["ollama", (url, opts, copy) => webFetchOllama(url, opts, copy)],
  ["deepseek", (url, opts, copy) => webFetchDeepseek(url, opts, copy)],
]);
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
  const unwrapped = unwrapBingUrl(href);
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

/** Organic SERP hits only: ads, tracking redirects, Bing's own chrome, duplicate targets
 *  and unreadable blocks are dropped so the caller gets destinations it can use. */
export function parseBingResults(html: string): SearchResult[] {
  // DOM walk rather than regex — `<li[^>]*\bclass\b[^>]*>` triggers
  // polynomial backtracking on adversarial input (CodeQL js/polynomial-redos).
  const root = parseHtml(html);
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
  if (!resp.ok) throw new Error(fetchStatusError(resp.status, url));
  const contentType = resp.headers.get("content-type") ?? "";
  // Pre-check Content-Length when the server provides it. Cheaper to
  // refuse upfront than to start streaming a 1GB ISO.
  const declaredLen = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > FETCH_MAX_BYTES) {
    throw new Error(t("webErrors.fetchTooLarge", { len: declaredLen, cap: FETCH_MAX_BYTES, url }));
  }
  const raw = await readBodyCapped(resp, FETCH_MAX_BYTES);
  const title = extractTitle(raw);
  const text = contentType.includes("text/html") ? htmlToText(raw) : raw;
  const capped = capText(text, maxChars);
  const finalText = capped.truncated
    ? `${capped.text}\n\n[… truncated ${text.length - maxChars} chars …]`
    : capped.text;
  return { url: currentUrl, title, text: finalText, truncated: capped.truncated };
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

interface WalkableNode {
  nodeType: number;
  rawText?: string;
  text?: string;
  rawTagName?: string;
  childNodes: WalkableNode[];
}

function walkExtract(node: WalkableNode, out: string[]): void {
  // nodeType 3 = TEXT_NODE; 1 = ELEMENT_NODE per node-html-parser.
  if (node.nodeType === 3) {
    out.push(node.rawText ?? node.text ?? "");
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
      },
      required: ["query"],
    },
    fn: async (args: { query: string; topK?: number }, ctx) => {
      // Read at call time, not registration time — the engine setting mutates config mid-session (#1309).
      const engine = loadWebSearchEngine(opts.configPath);
      const endpoint = loadWebSearchEndpoint(opts.configPath);
      const results = await webSearch(args.query, {
        topK: args.topK ?? defaultTopK,
        signal: ctx?.signal,
        engine,
        endpoint,
        configPath: opts.configPath,
      });
      if (results.length === 0) {
        consecutiveEmptySearches++;
      } else {
        consecutiveEmptySearches = 0;
      }
      let formatted = formatSearchResults(args.query, results, engine);
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
      "Download a URL and return its visible text content (HTML pages get scripts/styles/nav stripped). Truncated at the tool-result cap. Use after web_search when a snippet isn't enough.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http:// or https:// URL." },
      },
      required: ["url"],
    },
    fn: async (args: { url: string }, ctx) => {
      if (!/^https?:\/\//i.test(args.url)) {
        throw new Error(t("webErrors.fetchInvalidUrl"));
      }
      // Read at call time, not registration time — the engine setting mutates config mid-session (#1309).
      const engine = loadWebSearchEngine(opts.configPath);
      const spec = engine ? searchEngineSpec(engine) : undefined;
      if (!spec) throw new Error(NO_ENGINE_MESSAGE);
      // Declared, not branched: an engine that owns a fetch API names it in its JSON.
      const transport = FETCH_TRANSPORTS.get(spec.fetchStrategy);
      if (!transport) {
        throw new Error(
          `web_fetch: engine "${spec.id}" declares fetchStrategy "${spec.fetchStrategy}"`,
        );
      }
      const page = await transport(
        args.url,
        { maxChars: maxFetchChars, signal: ctx?.signal, configPath: opts.configPath },
        copyFor({ engine: spec.id as WebSearchEngineName }),
      );
      const header = page.title ? `${page.title}\n${page.url}` : page.url;
      const links = page.links?.length ? `\n\nlinks:\n${page.links.join("\n")}` : "";
      return `engine: ${engine}\n\n${header}\n\n${page.text}${links}`;
    },
  });

  return registry;
}

export function formatSearchResults(
  query: string,
  results: SearchResult[],
  engine?: string,
): string {
  const lines: string[] = [`query: ${query}`];
  if (engine) lines.push(`engine: ${engine}`);

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
