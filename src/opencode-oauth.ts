/** OpenCode Console device-flow OAuth, mirroring the OpenCode CLI's `opencode
 *  auth login`. The bearer token authenticates Zen + Go inference. */

import {
  type OpencodeOAuthCreds,
  clearOpencodeOAuth,
  defaultConfigPath,
  readConfig,
  saveOpencodeOAuth,
} from "./config.js";
import { singleFlight } from "./core/lazy.js";
import { OAUTH_FLOW_TIMEOUT_MS, envOr, fetchUserEmail, isTokenFresh } from "./oauth-shared.js";

export const OPENCODE_CONSOLE_DEFAULT_SERVER = "https://opencode.ai/console";
/** Public native client id the Console allowlists for the device flow. */
export const OPENCODE_OAUTH_CLIENT_ID = "opencode-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export function opencodeConsoleServer(): string {
  return envOr(OPENCODE_CONSOLE_DEFAULT_SERVER, "OPENCODE_CONSOLE_URL").replace(/\/+$/, "");
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  org_id?: string | null;
  error?: string;
}

interface ConsoleOrg {
  id: string;
  name: string;
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`OpenCode Console returned ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function getJson<T>(url: string, token: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenCode Console GET ${url} returned ${res.status}`);
  return (await res.json()) as T;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("OpenCode sign-in cancelled"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("OpenCode sign-in cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolve the active organization + account email from the Console. Best-effort:
 *  a failed lookup never blocks a successful sign-in. */
async function buildCreds(server: string, token: DeviceTokenResponse): Promise<OpencodeOAuthCreds> {
  const accessToken = token.access_token ?? "";
  const account = await fetchUserEmail(`${server}/api/user`, accessToken);
  let orgId: string | undefined;
  let orgName: string | undefined;
  try {
    const orgs = await getJson<ConsoleOrg[]>(`${server}/api/orgs`, accessToken);
    const chosen = token.org_id
      ? orgs.find((org) => org.id === token.org_id)
      : [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
    orgId = chosen?.id;
    orgName = chosen?.name;
  } catch {
    /* orgs are optional metadata */
  }
  return {
    accessToken,
    refreshToken: token.refresh_token ?? "",
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    account,
    orgId,
    orgName,
    server,
  };
}

export interface OpencodeDeviceFlow {
  /** Verification URL (already carries the user code) to open in the browser. */
  url: string;
  /** Short code shown to the user, for the manual-entry fallback. */
  userCode: string;
  /** Resolves with tokens; rejects on error / cancel / timeout. */
  done: Promise<OpencodeOAuthCreds>;
  cancel: () => void;
}

/** Start the Console device flow: request a device code, then poll the token
 *  endpoint until the user approves in the browser. */
export async function beginOpencodeDeviceFlow(
  opts: { server?: string; timeoutMs?: number } = {},
): Promise<OpencodeDeviceFlow> {
  const server = (opts.server ?? opencodeConsoleServer()).replace(/\/+$/, "");
  const device = await postJson<DeviceCodeResponse>(`${server}/auth/device/code`, {
    client_id: OPENCODE_OAUTH_CLIENT_ID,
    supports_org_scope: true,
  });
  if (!device.device_code || !device.user_code || !device.verification_uri_complete) {
    throw new Error("OpenCode Console returned an incomplete device-code response");
  }
  // verification_uri_complete is origin-relative ("/console/device?...") — resolve
  // it against the server origin so both dev and production stay correct.
  const url = new URL(device.verification_uri_complete, `${server}/`).href;
  const timeoutMs =
    opts.timeoutMs ?? (device.expires_in ? device.expires_in * 1000 : OAUTH_FLOW_TIMEOUT_MS);
  const controller = new AbortController();

  const done = new Promise<OpencodeOAuthCreds>((resolve, reject) => {
    void (async () => {
      const deadline = Date.now() + timeoutMs;
      let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
      try {
        while (Date.now() < deadline) {
          await sleep(intervalMs, controller.signal);
          const token = await postJson<DeviceTokenResponse>(`${server}/auth/device/token`, {
            grant_type: DEVICE_GRANT,
            device_code: device.device_code,
            client_id: OPENCODE_OAUTH_CLIENT_ID,
          });
          if (token.access_token) {
            resolve(await buildCreds(server, token));
            return;
          }
          if (token.error === "authorization_pending") continue;
          if (token.error === "slow_down") {
            intervalMs += 5_000;
            continue;
          }
          throw new Error(`OpenCode sign-in failed: ${token.error ?? "unknown error"}`);
        }
        throw new Error("OpenCode sign-in timed out — retry from settings");
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });

  return {
    url,
    userCode: device.user_code,
    done,
    cancel: () => controller.abort(),
  };
}

async function refreshOpencodeToken(
  creds: OpencodeOAuthCreds,
  path: string,
): Promise<OpencodeOAuthCreds> {
  const server = (creds.server ?? opencodeConsoleServer()).replace(/\/+$/, "");
  const token = await postJson<DeviceTokenResponse>(`${server}/auth/device/token`, {
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: OPENCODE_OAUTH_CLIENT_ID,
  });
  if (!token.access_token) {
    throw new Error(`OpenCode token refresh failed: ${token.error ?? "no access_token"}`);
  }
  const next: OpencodeOAuthCreds = {
    ...creds,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? creds.refreshToken,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
  };
  saveOpencodeOAuth(next, path);
  return next;
}

const refreshOpencodeOnce = singleFlight<string | undefined>();

/** A usable OpenCode access token — refreshes from the stored refresh token
 *  when expired or within 5 min of expiry. Undefined when no OAuth creds exist
 *  or refresh fails (callers fall back to their static key / public tier). */
export async function resolveOpencodeToken(
  path: string = defaultConfigPath(),
): Promise<string | undefined> {
  const creds = readConfig(path).opencodeOAuth;
  if (!creds?.accessToken) return undefined;
  if (isTokenFresh(creds.expiresAt, creds.refreshToken)) return creds.accessToken;
  return refreshOpencodeOnce(async () => {
    try {
      const next = await refreshOpencodeToken(creds, path);
      return next.accessToken;
    } catch (err) {
      console.warn(`reasonix: OpenCode OAuth refresh failed — ${(err as Error).message}`);
      return undefined;
    }
  });
}

/** True when a Console OAuth session is stored (an access token exists). Sync —
 *  gates the subscription catalog without a network refresh. */
export function hasOpencodeOAuthSession(path: string = defaultConfigPath()): boolean {
  return Boolean(readConfig(path).opencodeOAuth?.accessToken);
}

/** Sign-out drops the stored tokens. */
export async function signOutOpencode(path: string = defaultConfigPath()): Promise<void> {
  clearOpencodeOAuth(path);
}
