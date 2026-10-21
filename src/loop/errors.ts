import {
  type ProviderErrorI18nPrefix,
  providerForErrorBrand,
  providerForErrorHost,
  providerSpec,
  sleep,
} from "@reasonix/core-utils";
import type { DeepSeekClient } from "../client.js";
import type { ModelProvider } from "../config.js";
import { PROVIDER_ERROR_BRANDS, isAbortError } from "../core/retry-shared.js";
import { t } from "../i18n/index.js";

export interface DeepSeekProbeResult {
  reachable: boolean;
}

export interface FormatLoopErrorOptions {
  /** Authoritative provider selected from the request model. */
  provider?: ModelProvider;
  /** Compatibility fallback for external callers that do not supply provider. */
  upstreamHost?: string;
}

/** The message of a thrown value or of a wire field: the classifiers below accept
 *  either, so a caller can screen `errorDetail.message` without re-wrapping it. */
function errorText(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : "";
}

/** Every phrasing a provider has used for "the request is bigger than the window". */
const CONTEXT_OVERFLOW_RE =
  /maximum context length|context window|prompt too long|reduce the length/i;

export function formatLoopError(
  err: Error,
  probe?: DeepSeekProbeResult,
  opts?: FormatLoopErrorOptions,
): string {
  const msg = err.message ?? "";
  const match = new RegExp(`^(${PROVIDER_ERROR_BRANDS}) (\\d{3}):\\s*([\\s\\S]*)$`).exec(msg);
  const provider = resolveErrorProvider(opts?.provider, match?.[1], opts?.upstreamHost);
  if (
    match &&
    (msg.includes("maximum context length") || /context window|prompt too long/i.test(msg))
  ) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : t("errors.contextOverflowTooMany");
    return providerMessage(provider, "context", { requested, inner: msg });
  }
  if (!match) {
    if (/timed out after/i.test(msg)) return providerMessage(provider, "timeout", { inner: msg });
    return msg;
  }

  const status = match[2]!;
  const inner = extractProviderErrorMessage(match[3]!);
  if (status === "400" || status === "413" || status === "422") {
    if (CONTEXT_OVERFLOW_RE.test(inner)) {
      return providerMessage(provider, "context", {
        requested: t("errors.contextOverflowTooMany"),
        inner,
      });
    }
    // An image-heavy body over the provider's cap (Ollama daemon:
    // `http: request body too large`) reads as an image problem, not a
    // generic parameter problem — point the agent at smaller/cropped images.
    if (
      /request body too large|payload too large|entity too large|body size exceeds/i.test(inner)
    ) {
      return t("errors.imagePayloadTooLarge", { inner });
    }
    return providerMessage(provider, "request", { inner });
  }
  if (status === "401") return providerMessage(provider, "auth", { inner });
  if (status === "402") return providerMessage(provider, "credits", { inner });
  if (status === "403") return providerMessage(provider, "permission", { inner });
  if (status === "404") return providerMessage(provider, "notFound", { inner });
  if (status === "408") return providerMessage(provider, "timeout", { inner });
  if (status === "429") {
    return providerMessage(provider, isOutOfCredits429(inner) ? "credits" : "rate", { inner });
  }
  if (is5xxStatus(status)) {
    const spec = providerSpec(provider);
    if (spec?.errors.serverReport === "balance-probe") {
      return formatBalanceProbe5xx(spec.errors.i18nPrefix, status, probe);
    }
    return providerMessage(provider, "server", { inner, status });
  }
  return msg;
}

const PROVIDER_ERROR_PREFIX = `(?:${PROVIDER_ERROR_BRANDS})`;

export function is5xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return new RegExp(`^${PROVIDER_ERROR_PREFIX} 5\\d{2}:`).test(err.message ?? "");
}

export function is4xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return new RegExp(`^${PROVIDER_ERROR_PREFIX} 4\\d{2}:`).test(err.message ?? "");
}

/** True when a provider refused the call because the account's quota, credits or
 *  rate allowance is spent: replaying the same model cannot get past it, so the
 *  only way to keep an unattended run alive is a different model. */
export function isQuotaExhaustedError(err: unknown): boolean {
  const match = new RegExp(`^(${PROVIDER_ERROR_BRANDS}) (\\d{3}):\\s*([\\s\\S]*)$`).exec(
    errorText(err),
  );
  if (!match) return false;
  const status = match[2]!;
  const inner = extractProviderErrorMessage(match[3]!);
  // 402 means "payment required" by definition; 429 covers both a spent quota and
  // a per-key rate limit. Neither is fixed by re-sending the same request to the
  // same model, so both are failover-eligible.
  if (status === "402" || status === "429") return true;
  // Some gateways report an exhausted balance as a plain 403 (access denied) or a
  // 400 on the stream-failure path instead of a 402/429.
  if (status === "403" || status === "400") return OUT_OF_CREDITS_429.test(inner);
  return false;
}

/** True when the provider rejected the request for exceeding the context
 *  window. Recoverable by compaction; mirrors the message patterns that
 *  formatLoopError classifies as the "context" error kind. */
export function isContextOverflowError(err: unknown): boolean {
  return CONTEXT_OVERFLOW_RE.test(errorText(err));
}

/** A gateway that refuses the whole body without naming a field: OpenCode Zen/Go
 *  relays its upstream's bare `invalid_request_error` this way (`param: null`).
 *  The text points at no field, so a smaller prompt is worth a retry. */
const UPSTREAM_BARE_REFUSAL_RE =
  /upstream request failed:\s*\[invalid_request_error\]\s*request could not be processed/i;

/** True when a 4xx names no offending field, so replaying the identical payload
 *  is not guaranteed to fail again. Shared by the loop's recovery ladder. */
export function isUpstreamBareRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (!is4xxError(err)) return false;
  return UPSTREAM_BARE_REFUSAL_RE.test(err.message ?? "");
}

/** DeepSeek's thinking-mode contract: the assistant turns in the request must
 *  carry `reasoning_content` back. A single bare turn fails the WHOLE request,
 *  so replaying the byte-identical payload can only fail again. */
const REASONING_ROUND_TRIP_RE =
  /reasoning_content[\s\S]{0,80}?(?:must be (?:(?:passed|sent|returned|echoed) back|included|provided|replayed)|is required|not (?:allowed|permitted) to be (?:empty|dropped|omitted))|reasoning_content[\s\S]{0,30}?(?:必须|需要)回传/i;

/** True when a provider rejected the request because an assistant turn came
 *  back without `reasoning_content`. Recoverable by back-filling the field. */
export function isReasoningRoundTripError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return REASONING_ROUND_TRIP_RE.test(err.message ?? "");
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_ERROR_MESSAGE_RE =
  /fetch failed|network error|socket hang up|connection (?:reset|refused|closed|timeout)|econnreset|enotfound|eai_again|etimedout|terminated before the `done` completion frame/i;

export function isNetworkConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (isAbortError(err)) return false;
  if (is4xxError(err)) return false;

  const code = ("code" in err && typeof err.code === "string" ? err.code : "").toUpperCase();
  if (code === "UND_ERR_ABORTED") return false;

  const msg = err.message ?? "";
  if (NETWORK_ERROR_MESSAGE_RE.test(msg) || NETWORK_ERROR_CODES.has(code)) {
    return true;
  }

  if ("cause" in err && err.cause instanceof Error) {
    return isNetworkConnectionError(err.cause);
  }

  return false;
}

export interface WaitForReconnectionOptions {
  targetUrl?: string;
  signal?: AbortSignal;
  maxWaitMs?: number;
  initialDelayMs?: number;
  probeIntervalMs?: number;
  probeFn?: (url: string, signal?: AbortSignal) => Promise<boolean>;
}

export async function probeConnectivity(
  url: string,
  signal?: AbortSignal,
  timeoutMs = 3000,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const probeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const resp = await fetch(url, { method: "HEAD", signal: probeSignal }).catch(async (err) => {
      if (probeSignal.aborted) throw err;
      return await fetch(url, { method: "GET", signal: probeSignal });
    });
    return resp !== undefined;
  } catch (err) {
    if (signal?.aborted) throw err;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForReconnection(opts: WaitForReconnectionOptions): Promise<boolean> {
  const isVitest = process.env.VITEST === "true";
  const defaultMaxWait = isVitest ? 500 : 300_000;
  const defaultInitialDelay = isVitest ? 10 : 1500;
  const defaultProbeInterval = isVitest ? 50 : 3000;

  const {
    targetUrl,
    signal,
    maxWaitMs = defaultMaxWait,
    initialDelayMs = defaultInitialDelay,
    probeIntervalMs = defaultProbeInterval,
    probeFn = probeConnectivity,
  } = opts;

  if (!targetUrl) return true;

  if (initialDelayMs > 0) {
    try {
      await sleep(initialDelayMs, signal);
    } catch {
      if (signal?.aborted) return false;
    }
  }

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (signal?.aborted) return false;
    try {
      const connected = await probeFn(targetUrl, signal);
      if (connected) return true;
    } catch {
      // probe failed, continue waiting
    }
    try {
      await sleep(probeIntervalMs, signal);
    } catch {
      if (signal?.aborted) return false;
    }
  }

  return false;
}

/** Read structured metadata off thrown errors without resorting to `as any`. */
export function errorMeta(err: unknown): {
  code?: string;
  phase?: string;
  partialDelivered?: boolean;
  timedOut?: boolean;
} {
  if (!(err instanceof Error)) return {};
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  const phase = "phase" in err && typeof err.phase === "string" ? err.phase : undefined;
  const partialDelivered = "partialDelivered" in err && err.partialDelivered === true;
  const timedOut = "timedOut" in err && err.timedOut === true;
  return {
    code,
    phase,
    ...(partialDelivered ? { partialDelivered } : {}),
    ...(timedOut ? { timedOut } : {}),
  };
}

export async function probeDeepSeekReachable(
  client: DeepSeekClient,
  timeoutMs = 1500,
): Promise<DeepSeekProbeResult> {
  const balance = await client.getBalance({ signal: AbortSignal.timeout(timeoutMs) });
  return { reachable: balance !== null };
}

/** Only a provider that declares a bespoke 5xx report gets the balance-probe wording. */
export function isDeepSeekHost(baseUrl: string | undefined | null): boolean {
  const owner = providerForErrorHost(baseUrl);
  return owner !== undefined && providerSpec(owner)?.errors.serverReport === "balance-probe";
}

type ErrorKind =
  | "auth"
  | "credits"
  | "permission"
  | "notFound"
  | "request"
  | "context"
  | "timeout"
  | "rate"
  | "server";

const ERROR_KIND_SUFFIX = {
  auth: "Auth",
  credits: "Credits",
  permission: "Permission",
  notFound: "NotFound",
  request: "Request",
  context: "Context",
  timeout: "Timeout",
  rate: "Rate",
  server: "Server",
} as const satisfies Record<ErrorKind, string>;

/** The i18n prefix a provider declares for its messages; `custom` when it declares none. */
function errorI18nPrefix(provider: string): ProviderErrorI18nPrefix {
  return providerSpec(provider)?.errors.i18nPrefix ?? "custom";
}

function providerMessage(provider: string, kind: ErrorKind, vars: Record<string, string>): string {
  return t(`errors.${errorI18nPrefix(provider)}${ERROR_KIND_SUFFIX[kind]}`, vars);
}

function resolveErrorProvider(
  configured: ModelProvider | undefined,
  prefix: string | undefined,
  upstreamHost: string | undefined,
): string {
  if (configured) return configured;
  const byBrand = prefix === undefined ? undefined : providerForErrorBrand(prefix);
  if (byBrand) return byBrand;
  return providerForErrorHost(upstreamHost) ?? "upstream";
}

function is5xxStatus(status: string): boolean {
  return status === "500" || status === "502" || status === "503" || status === "504";
}

const OUT_OF_CREDITS_429 =
  /no credits? remaining|insufficient (?:credits?|balance)|out of credits|usage limit|current quota|insufficient_quota|no resource package|resource package|weekly limit|monthly limit|quota exceeded|resource_exhausted|freeusagelimit|free.?usage|rate_limit_exceeded/i;

function isOutOfCredits429(inner: string): boolean {
  return OUT_OF_CREDITS_429.test(inner);
}

function formatBalanceProbe5xx(
  prefix: ProviderErrorI18nPrefix,
  status: string,
  probe?: DeepSeekProbeResult,
): string {
  const key = (suffix: string) => `errors.${prefix}5xx${suffix}` as Parameters<typeof t>[0];
  const head = t(key("Head"), { status });
  const probeNote =
    probe === undefined ? "" : probe.reachable ? t(key("Reachable")) : t(key("Unreachable"));
  const action = probe?.reachable === false ? t(key("ActionNetwork")) : t(key("ActionRetry"));
  return `${head}${probeNote}${action}`;
}

function extractProviderErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return t("errors.innerNoMessage");
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as {
        error?: { message?: unknown };
        message?: unknown;
        // FastAPI-style envelope (e.g. the ChatGPT codex backend's
        // {"detail":"Unsupported parameter: messages"}).
        detail?: unknown;
      };
      if (obj.error && typeof obj.error.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.detail === "string") return obj.detail;
    }
  } catch {
    /* not JSON — fall through */
  }
  return trimmed;
}
