/** Xiaomi MiMo subscription usage. The console API needs web-session cookies
 *  (a separate credential), so this defaults to `unsupported` and never guesses. */

import { type MiMoQuota, providerSpec } from "@reasonix/core-utils";
import { fetchQuotaJson, usageUrls } from "./desktop/quota.js";
import { mimoPlatform } from "./mimo-auth.js";

export interface MiMoConsoleSession {
  /** `api-platform_serviceToken` cookie value. */
  serviceToken: string;
  /** `userId` cookie value. */
  userId: string;
}

/** The console session from env (or undefined). Gates the console fetch so the
 *  default is a static plan chip, never a guessed number. */
export function readMiMoConsoleSession(): MiMoConsoleSession | undefined {
  const serviceToken = process.env.MIMO_CONSOLE_TOKEN?.trim();
  const userId = process.env.MIMO_CONSOLE_USER_ID?.trim();
  if (!serviceToken || !userId) return undefined;
  return { serviceToken, userId };
}

/** The console usage address on the platform origin, as the provider declares it. */
export function mimoConsoleUsageUrl(platform: string = mimoPlatform()): string | undefined {
  const [url] = usageUrls(providerSpec("mimo"), platform);
  return url;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Map the (undocumented) console payload defensively — accept common spellings
 *  and return null when nothing usable is present rather than inventing a value. */
function parseMiMoUsage(data: Record<string, unknown>): {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string | null;
  plan?: string | null;
} | null {
  const usage = (data.usage && typeof data.usage === "object" ? data.usage : {}) as Record<
    string,
    unknown
  >;
  const used =
    num(data.usedPercent) ??
    num(data.used_percent) ??
    num(usage.usedPercent) ??
    num(usage.used_percent);
  const remaining =
    num(data.remainingPercent) ??
    num(data.remaining_percent) ??
    (used != null ? 100 - used : undefined);
  const resetsAt = str(data.resetsAt) ?? str(data.reset_at) ?? str(data.renewAt) ?? null;
  const plan = str(data.plan) ?? str(data.planName) ?? str(data.tier) ?? null;
  if (used == null && remaining == null && plan == null) return null;
  return { usedPercent: used, remainingPercent: remaining, resetsAt, plan };
}

/** Fetch MiMo subscription usage. Without a console session → `unsupported`;
 *  401/403 → `authentication_required`; other failures → `error`. */
export async function fetchMiMoQuota(
  session: MiMoConsoleSession | undefined,
  opts: { platform?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<MiMoQuota> {
  if (!session) return { status: "unsupported", source: "none", reason: "no-console-session" };
  const url = mimoConsoleUsageUrl(opts.platform);
  if (!url) return { status: "error", source: "console", reason: "no-usage-url" };
  const reply = await fetchQuotaJson(
    {
      urls: [url],
      headers: {
        Cookie: `api-platform_serviceToken=${session.serviceToken}; userId=${session.userId}`,
      },
      timeoutMs: opts.timeoutMs,
    },
    opts.fetchImpl ?? fetch,
  );
  if (!reply.ok) {
    if (reply.status === 401 || reply.status === 403) {
      return { status: "authentication_required", source: "console", reason: "console-auth" };
    }
    if (reply.status)
      return { status: "error", source: "console", reason: `console-${reply.status}` };
    return { status: "error", source: "console", reason: reply.reason };
  }
  const data = (reply.body && typeof reply.body === "object" ? reply.body : {}) as Record<
    string,
    unknown
  >;
  const parsed = parseMiMoUsage(data);
  if (!parsed) return { status: "error", source: "console", reason: "unexpected-payload" };
  return { status: "available", source: "console", ...parsed };
}
