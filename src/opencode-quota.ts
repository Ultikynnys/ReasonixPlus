/** OpenCode Go plan usage — its own `/zen/go/v1/usage` API (same Bearer as chat),
 *  returning 5-hour rolling, weekly and monthly windows with a consumed percent. */

import type { OpencodeQuota, OpencodeQuotaWindow } from "@reasonix/core-utils";

/** Go usage path relative to the Go endpoint origin (Go chat base is
 *  https://opencode.ai/zen/go/v1). */
export const OPENCODE_GO_USAGE_PATH = "/zen/go/v1/usage";

/** Fixed Go usage endpoint. */
export const OPENCODE_GO_USAGE_URL = `https://opencode.ai${OPENCODE_GO_USAGE_PATH}`;

/** Resolve the usage URL for a configured base URL. Only the public OpenCode
 *  hosts expose the Go usage API — a custom OPENCODE_BASE_URL proxy is left
 *  alone (undefined → no fetch), never a wrong number. */
export function opencodeUsageUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (!url.hostname.endsWith("opencode.ai")) return undefined;
    return `${url.origin}${OPENCODE_GO_USAGE_PATH}`;
  } catch {
    return undefined;
  }
}

function toWindow(raw: unknown): OpencodeQuotaWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as { status?: unknown; percent?: unknown; resetsAt?: unknown };
  if (typeof w.percent !== "number" || !Number.isFinite(w.percent)) return null;
  return {
    usagePct: w.percent,
    remainingPct: Math.max(0, 100 - w.percent),
    resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null,
    // The server flags an over-limit window as `status: "rate-limited"`.
    limited: w.status === "rate-limited",
  };
}

/** Fetch OpenCode Go plan usage — `GET {origin}/zen/go/v1/usage`. Undefined on
 *  any failure (no credential, non-2xx such as the 403 a non-Go account gets,
 *  malformed payload, or network error). */
export async function fetchOpencodeQuota(
  baseUrl: string,
  token: string,
  timeoutMs = 10_000,
): Promise<Omit<OpencodeQuota, "turnUsedPct" | "fetchedAt"> | undefined> {
  const url = opencodeUsageUrl(baseUrl);
  if (!url || !token) return undefined;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as {
      usage?: { rolling?: unknown; weekly?: unknown; monthly?: unknown };
    };
    const usage = data?.usage;
    if (!usage || typeof usage !== "object") return undefined;
    const rolling = toWindow(usage.rolling);
    const weekly = toWindow(usage.weekly);
    const monthly = toWindow(usage.monthly);
    if (!rolling && !weekly && !monthly) return undefined;
    return { rolling, weekly, monthly };
  } catch {
    return undefined;
  }
}
