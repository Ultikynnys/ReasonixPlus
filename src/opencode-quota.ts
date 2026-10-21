/** OpenCode Go plan usage — the declared `/zen/go/v1/usage` route (same Bearer as chat). */

import { type OpencodeQuota, type OpencodeQuotaWindow, providerSpec } from "@reasonix/core-utils";
import { fetchQuotaJson, usageUrls } from "./desktop/quota.js";

/** Resolve the usage URL for a configured base URL. Only a declared host exposes
 *  the Go usage API, so a custom proxy resolves to none (undefined → no fetch). */
export function opencodeUsageUrl(baseUrl: string): string | undefined {
  const [url] = usageUrls(providerSpec("opencode"), baseUrl);
  return url;
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

/** Fetch OpenCode Go plan usage. Undefined on any failure (no credential, an
 *  undeclared host, a non-2xx such as the 403 a non-Go account gets, a malformed
 *  payload, or a network error). */
export async function fetchOpencodeQuota(
  baseUrl: string,
  token: string,
  timeoutMs = 10_000,
): Promise<Omit<OpencodeQuota, "fetchedAt"> | undefined> {
  const url = opencodeUsageUrl(baseUrl);
  if (!url || !token) return undefined;
  const reply = await fetchQuotaJson({
    urls: [url],
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs,
  });
  if (!reply.ok) return undefined;
  const data = reply.body as {
    usage?: { rolling?: unknown; weekly?: unknown; monthly?: unknown };
  } | null;
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const rolling = toWindow(usage.rolling);
  const weekly = toWindow(usage.weekly);
  const monthly = toWindow(usage.monthly);
  if (!rolling && !weekly && !monthly) return undefined;
  return { rolling, weekly, monthly };
}
