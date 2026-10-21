/** One transport, one cache and one address resolver for provider usage reads, so no probe owns its own copy. */

import { createHash } from "node:crypto";
import { type ProviderSpec, messageOf } from "@reasonix/core-utils";

export const QUOTA_TIMEOUT_MS = 10_000;

/** How much of a refusing response body is kept for diagnostics. */
const QUOTA_FAILURE_DETAIL_CHARS = 200;

/** Provenance of a delivered snapshot: this caller hit the network, joined
 *  another caller's request, or replayed a cached reply. */
export type QuotaDelivery = "underlying" | "shared" | "cache";

export interface QuotaDeliveryResult<T> {
  value: T;
  delivery: QuotaDelivery;
  requestId: number;
  /** When the value was read (epoch-ms) — a cached or shared reply keeps the time
   *  its request actually ran, so a "last updated" figure never lies. */
  at: number;
}

export interface QuotaFetchObserver<T> {
  started?: (requestId: number) => void;
  succeeded?: (requestId: number, value: T) => void;
  failed?: (requestId: number, reason: string) => void;
}

/** How a settled reply reads. `hasData` drives the observers; `cacheable` decides
 *  whether the reply may be served again before the TTL, so a rate-limited account
 *  is not re-hammered by a burst of calls; `reason` names why there is no data. */
export interface QuotaOutcome<T> {
  hasData: (value: T) => boolean;
  cacheable?: (value: T) => boolean;
  reason?: (value: T) => string | null;
}

/** Coalesces concurrent reads onto one request and replays a fresh reply inside
 *  the TTL. One instance per (probe, endpoint, credential), never one global
 *  cache: switching account or endpoint must not serve the previous numbers. */
export class QuotaCoordinator<T> {
  private cached: { value: T; expiresAt: number; requestId: number; at: number } | null = null;
  private inflight: Promise<{ value: T; at: number }> | null = null;
  private inflightRequestId = 0;
  private nextRequestId = 1;

  constructor(
    private fetcher: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly outcome: QuotaOutcome<T>,
    private readonly now: () => number = Date.now,
    private readonly observer: QuotaFetchObserver<T> = {},
  ) {}

  /** Point the coordinator at the caller's current fetcher, so a credential that
   *  rotated since the entry was made is the one used, never the stale closure. */
  rebind(fetcher: () => Promise<T>): this {
    this.fetcher = fetcher;
    return this;
  }

  fetch(options: { force?: boolean } = {}): Promise<QuotaDeliveryResult<T>> {
    if (this.inflight) {
      const requestId = this.inflightRequestId;
      return this.inflight.then(({ value, at }) => ({ value, delivery: "shared", requestId, at }));
    }
    if (!options.force && this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve({
        value: this.cached.value,
        delivery: "cache",
        requestId: this.cached.requestId,
        at: this.cached.at,
      });
    }
    const requestId = this.nextRequestId++;
    this.inflightRequestId = requestId;
    this.observer.started?.(requestId);
    const request = this.fetcher()
      .then((value) => {
        const at = this.now();
        if (this.outcome.cacheable?.(value) !== false) {
          this.cached = { value, expiresAt: at + this.ttlMs, requestId, at };
        }
        if (this.outcome.hasData(value)) {
          this.observer.succeeded?.(requestId, value);
        } else {
          this.observer.failed?.(requestId, this.outcome.reason?.(value) ?? "no usage data");
        }
        return { value, at };
      })
      .catch((error) => {
        this.observer.failed?.(requestId, messageOf(error));
        throw error;
      })
      .finally(() => {
        if (this.inflight === request) this.inflight = null;
      });
    this.inflight = request;
    return request.then(({ value, at }) => ({ value, delivery: "underlying", requestId, at }));
  }

  invalidate(): void {
    this.cached = null;
  }
}

/** Live coordinators, keyed by probe + endpoint + credential fingerprint. */
const coordinators = new Map<string, QuotaCoordinator<unknown>>();

/** A long-lived daemon sees keys churn as credentials rotate, so the map is capped:
 *  an evicted entry only loses a warm cache, never correctness. */
const MAX_COORDINATORS = 32;

/** The coordinator for one usage source, created on first use. A new endpoint or
 *  credential is a new key (so it starts cold), and the fetcher is rebound on every
 *  lookup so a rotated credential is the one used. */
export function quotaCoordinator<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  outcome: QuotaOutcome<T>,
): QuotaCoordinator<T> {
  const existing = coordinators.get(key) as QuotaCoordinator<T> | undefined;
  if (existing) return existing.rebind(fetcher);
  if (coordinators.size >= MAX_COORDINATORS) {
    const oldest = coordinators.keys().next();
    if (!oldest.done) coordinators.delete(oldest.value);
  }
  const created = new QuotaCoordinator<T>(fetcher, ttlMs, outcome);
  coordinators.set(key, created as QuotaCoordinator<unknown>);
  return created;
}

/** Coordinators bound to an owner's lifetime, so a rebuilt client (new credential,
 *  model or endpoint) starts cold instead of replaying the previous one's money. */
const scopedCoordinators = new WeakMap<object, Map<string, QuotaCoordinator<unknown>>>();

/** The coordinator for one usage source owned by a live object. */
export function scopedQuotaCoordinator<T>(
  owner: object,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  outcome: QuotaOutcome<T>,
): QuotaCoordinator<T> {
  let byKey = scopedCoordinators.get(owner);
  if (!byKey) {
    byKey = new Map();
    scopedCoordinators.set(owner, byKey);
  }
  const existing = byKey.get(key);
  if (existing) return (existing as QuotaCoordinator<T>).rebind(fetcher);
  const created = new QuotaCoordinator<T>(fetcher, ttlMs, outcome);
  byKey.set(key, created as QuotaCoordinator<unknown>);
  return created;
}

/** Drop every cached reply (tests only: a credential change is a new key instead). */
export function resetQuotaCoordinators(): void {
  coordinators.clear();
}

/** Cache key for one usage source: the probe name, the endpoint and an opaque
 *  credential fingerprint — never the raw key. */
export function quotaCacheKey(probe: string, endpoint: string, credential: string): string {
  const fingerprint = credential
    ? createHash("sha256").update(credential).digest("hex").slice(0, 16)
    : "anonymous";
  return `${probe}|${endpoint}|${fingerprint}`;
}

/** Absolute addresses a provider's probe may GET, resolved against the tab's endpoint.
 *  Empty when it declares none, the base is not a URL, or `urlGate` bars the host (a
 *  proxy must never be handed the account's token) — so callers fetch what they get. */
export function usageUrls(spec: ProviderSpec | undefined, baseUrl: string): string[] {
  if (!spec || spec.usage.urls.length === 0) return [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  if (spec.usage.urlGate === "declared-hosts" && !hostDeclared(spec.errors.hosts, base.hostname)) {
    return [];
  }
  const root = spec.usage.urlBase === "endpoint" ? base.href.replace(/\/+$/, "") : base.origin;
  return spec.usage.urls.map((entry) => (/^https:\/\//.test(entry) ? entry : `${root}${entry}`));
}

/** Hostname match against a provider's declared hosts (`z.ai` matches
 *  `api.z.ai`, never `notz.ai`). */
export function hostDeclared(hosts: readonly string[], hostname: string): boolean {
  return hosts.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Why a read produced nothing, in one vocabulary every chip tooltip can show. */
export type QuotaFailure = "timeout" | "network" | "malformed-json" | `http-${number}`;

/** A refused read: the reason is what a chip tooltip shows, `status` is kept for
 *  the probes whose own state machine keys on it (a 401 console session is not the
 *  same answer as a 500), and `detail` is a capped body snippet for diagnostics. */
export type QuotaFailureReply = {
  ok: false;
  reason: string;
  status?: number;
  detail?: string;
};

export type QuotaReply = { ok: true; body: unknown } | QuotaFailureReply;

export interface QuotaRequest {
  urls: readonly string[];
  /** Headers the auth strategy stamps (bearer key, cookie session, OAuth token). */
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** GET the first declared address that answers with JSON. Never throws: a refusal,
 *  a malformed body, a timeout and a network error all degrade to "no data"
 *  plus a reason. */
export async function fetchQuotaJson(
  request: QuotaRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<QuotaReply> {
  const reasons: string[] = [];
  let last: QuotaFailureReply | null = null;
  for (const url of request.urls) {
    const reply = await fetchQuotaAddress(url, request, fetchImpl);
    if (reply.ok) return reply;
    last = reply;
    reasons.push(request.urls.length > 1 ? `${addressLabel(url)} ${reply.reason}` : reply.reason);
  }
  if (!last) return { ok: false, reason: "no-usage-url" };
  return { ...last, reason: reasons.join("; ") };
}

async function fetchQuotaAddress(
  url: string,
  request: QuotaRequest,
  fetchImpl: typeof fetch,
): Promise<QuotaReply> {
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", ...request.headers },
      signal: AbortSignal.timeout(request.timeoutMs ?? QUOTA_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const detail = await resp
        .text()
        .then((body) => body.slice(0, QUOTA_FAILURE_DETAIL_CHARS))
        .catch(() => "");
      return { ok: false, reason: `http-${resp.status}`, status: resp.status, detail };
    }
    try {
      return { ok: true, body: await resp.json() };
    } catch {
      return { ok: false, reason: "malformed-json" };
    }
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, reason: timedOut ? "timeout" : "network" };
  }
}

/** `chatgpt.com/backend-api/wham/usage` — enough to tell two declared routes apart
 *  in a tooltip, without the scheme and query noise. */
function addressLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** A probe's read: the parsed payload, or why there is none. */
export type QuotaRead<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A failed read with its reason. */
export function quotaFailure(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
