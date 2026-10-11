/** Xiaomi MiMo subscription usage. The console API needs web-session cookies
 *  (a separate credential), so this defaults to `unsupported` and never guesses. */

import type { MiMoQuota } from "@reasonix/core-utils";
import { mimoPlatform } from "./mimo-auth.js";

/** Console usage path (relative to the platform origin). */
export const MIMO_CONSOLE_USAGE_PATH = "/api/v1/tokenPlan/usage";

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

export function mimoConsoleUsageUrl(platform: string = mimoPlatform()): string {
  return `${platform.replace(/\/+$/, "")}${MIMO_CONSOLE_USAGE_PATH}`;
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
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const resp = await doFetch(mimoConsoleUsageUrl(opts.platform), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: `api-platform_serviceToken=${session.serviceToken}; userId=${session.userId}`,
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (resp.status === 401 || resp.status === 403) {
      return { status: "authentication_required", source: "console", reason: "console-auth" };
    }
    if (!resp.ok) return { status: "error", source: "console", reason: `console-${resp.status}` };
    const data = (await resp.json()) as Record<string, unknown>;
    const parsed = parseMiMoUsage(data);
    if (!parsed) return { status: "error", source: "console", reason: "unexpected-payload" };
    return { status: "available", source: "console", ...parsed };
  } catch {
    return { status: "error", source: "console", reason: "network" };
  }
}
