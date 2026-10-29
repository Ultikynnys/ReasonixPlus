/** Shared OAuth plumbing for the OpenAI + Antigravity browser flows. */
import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { escapeHtml } from "@reasonix/core-utils";

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** POST an `x-www-form-urlencoded` body to the token endpoint and parse it,
 *  throwing a readable error on non-OK or error-bearing responses. */
export async function postTokenForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`OAuth token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.error) {
    throw new Error(
      `OAuth token exchange failed (${res.status}): ${parsed.error_description ?? parsed.error ?? text.slice(0, 200)}`,
    );
  }
  if (!parsed.access_token) throw new Error("OAuth token endpoint returned no access_token");
  return parsed;
}

/** HTML page served when the callback query carries an error state. */
export function errorPage(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui;max-width:34em;margin:4em auto;line-height:1.6">
<h2>Sign-in failed</h2><p>${escapeHtml(msg)}</p>
<p>You can close this window and retry from Reasonix+.</p></body></html>`;
}

/** HTML success page served after the code exchange. Title/heading are the
 *  only provider-specific parts. */
export function successPage(title: string, heading: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui;max-width:34em;margin:4em auto;line-height:1.6">
<h2>${escapeHtml(heading)}</h2><p>You can close this window and return to Reasonix+.</p></body></html>`;
}

/** Trimmed env override or the default. Shared by every OAuth endpoint/client-id lookup. */
export function envOr(def: string, name: string): string {
  const v = process.env[name]?.trim();
  return v ? v : def;
}

/** Default 10-minute browser-flow timeout shared by both providers. */
export const OAUTH_FLOW_TIMEOUT_MS = 10 * 60_000;
/** Refresh when the cached token is within 5 min of expiry. Shared by both providers. */
export const OAUTH_REFRESH_SLACK_MS = 5 * 60_000;

export function randomOAuthState(): string {
  return randomBytes(24).toString("hex");
}

/** RFC 7636 PKCE pair — verifier is `byteLength` random bytes, challenge is S256.
 *  OpenAI uses 64 bytes, Antigravity 32; the construction is identical. */
export function makePkcePair(byteLength: number): { verifier: string; challenge: string } {
  const verifier = randomBytes(byteLength).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** True when the cached token can be used as-is (no refresh needed). */
export function isTokenFresh(
  expiresAt: number,
  refreshToken: string | undefined,
  slackMs = OAUTH_REFRESH_SLACK_MS,
): boolean {
  return !refreshToken || expiresAt - Date.now() > slackMs;
}

/** Account email from an OIDC userinfo endpoint, for the settings card. Undefined on failure. */
export async function fetchUserEmail(
  userinfoUrl: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const info = (await res.json()) as { email?: string };
    return info.email;
  } catch {
    return undefined;
  }
}

export interface LocalhostOAuthFlow<TCreds> {
  /** Authorize URL to open in the system browser. */
  url: string;
  /** Redirect URI the callback server actually uses, which is what the client was
   *  registered for when the port was not the preferred one. */
  redirectUri: string;
  /** Resolves with exchanged tokens; rejects on error / cancel / timeout. */
  done: Promise<TCreds>;
  cancel: () => void;
}

/** Where a flow's redirect URI comes from: fixed before the server starts, or recomputed
 *  from the port it binds. Exactly one applies, so a caller cannot supply two answers. */
export type CallbackRedirect =
  | { redirectUri: string; redirectUriForPort?: undefined }
  | { redirectUri?: undefined; redirectUriForPort: (port: number) => string };

export type LocalhostOAuthFlowOptions<TCreds> = CallbackRedirect & {
  /** Callback path, e.g. "/auth/callback". */
  callbackPath: string;
  /** Port to bind the callback server on. */
  port: number;
  /** Bind host. Undefined = dual-stack bind (both localhost and 127.0.0.1). */
  host?: string;
  timeoutMs?: number;
  successTitle: string;
  successHeading: string;
  /** Full message shown when `state` mismatches, e.g. "State mismatch — ...". */
  stateMismatchMessage: string;
  /** True: fall back to an ephemeral port when `port` is taken (OpenAI, whose
   *  upstream allowlist is best-effort). False: throw a bind error instead
   *  (Antigravity, whose client only accepts its registered callback). */
  allowPortFallback: boolean;
  /** Build the authorize URL for the effective redirect URI + state. Async so a caller can
   *  register its client against the port the server actually bound. */
  buildUrl: (redirectUri: string, state: string) => string | Promise<string>;
  /** Exchange the callback code for credentials. */
  exchange: (code: string, redirectUri: string) => Promise<TCreds>;
  /** Message for the flow-timeout rejection. */
  timeoutMessage?: string;
  /** Error when the callback port can't bind and `allowPortFallback` is false. */
  bindErrorMessage?: string;
};

export interface OneShotCallbackFlow<TCreds> {
  /** Authorize URL to open in the system browser. */
  url: string;
  /** Redirect URI the callback server actually uses. */
  redirectUri: string;
  /** Resolves with the handled result; rejects on error / cancel / timeout. */
  done: Promise<TCreds>;
  cancel: () => void;
}

export type OneShotCallbackFlowOptions<TCreds> = CallbackRedirect & {
  /** Handle one callback request. Answer the response, then call `resolve` or
   *  `reject` exactly once — either closes the server after the response flushes. */
  handle: (
    req: IncomingMessage,
    res: ServerResponse,
    ctx: {
      url: URL;
      /** Effective redirect URI (recomputed from the bound port when asked). */
      redirectUri: string;
      resolve: (value: TCreds) => void;
      reject: (error: Error) => void;
    },
  ) => void;
  /** Authorize URL for the effective redirect URI (async: registering a client needs the
   *  port the server actually bound). */
  buildUrl: (redirectUri: string) => string | Promise<string>;
  /** Port to bind the callback server on. */
  port: number;
  /** Bind host. Undefined = dual-stack bind (both localhost and 127.0.0.1). */
  host?: string;
  /** True: fall back to an ephemeral port when `port` is taken. */
  allowPortFallback: boolean;
  timeoutMs?: number;
  /** Message for the flow-timeout rejection. */
  timeoutMessage?: string;
  /** Message for the cancel rejection. */
  cancelMessage?: string;
  /** Error when the callback port can't bind and `allowPortFallback` is false. */
  bindErrorMessage?: string;
};

/** One-shot localhost callback server skeleton shared by every browser flow:
 *  dual-stack bind with optional port fallback, exactly-once settle that closes
 *  the server after the response flushes, timeout, and cancel. */
export async function beginOneShotCallbackFlow<TCreds>(
  opts: OneShotCallbackFlowOptions<TCreds>,
): Promise<OneShotCallbackFlow<TCreds>> {
  const timeoutMs = opts.timeoutMs ?? OAUTH_FLOW_TIMEOUT_MS;
  const timeoutMessage = opts.timeoutMessage ?? "OAuth sign-in timed out. Retry from settings";
  const cancelMessage = opts.cancelMessage ?? "OAuth sign-in cancelled";
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (creds: TCreds) => void = () => {};
  let rejectDone: (err: Error) => void = () => {};
  const done = new Promise<TCreds>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
    // Close idle keep-alive sockets only — an in-flight response (the
    // success/error page) must reach the browser before the server closes.
    server.closeIdleConnections();
    server.close(() => {});
  };

  // Assigned below once the port binds (via redirectUriForPort); declared here
  // because the request handler closure must never observe it uninitialized.
  let boundRedirectUri = opts.redirectUri ?? "";

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    opts.handle(req, res, {
      url,
      redirectUri: boundRedirectUri,
      resolve: (value) => settle(() => resolveDone(value)),
      reject: (err) => settle(() => rejectDone(err)),
    });
  });
  server.on("error", () => {
    /* surfaced via the listening promise / settle-close */
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve();
      });
      if (opts.host === undefined) {
        // No host: dual-stack bind — both localhost (::1) and 127.0.0.1 reach it.
        server.listen(port);
      } else {
        server.listen(port, opts.host);
      }
    });

  try {
    await listen(opts.port);
  } catch {
    if (!opts.allowPortFallback) {
      throw new Error(
        opts.bindErrorMessage ?? `OAuth callback server failed to bind port ${opts.port}`,
      );
    }
    // Fixed port taken — fall back to an ephemeral port; the redirect URI is
    // recomputed from the actual port below (best-effort: the upstream
    // allowlist may only cover the fixed port).
    await listen(0);
  }
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error(opts.bindErrorMessage ?? "OAuth callback server failed to bind");
  }
  if (opts.redirectUriForPort) boundRedirectUri = opts.redirectUriForPort(addr.port);

  let url: string;
  try {
    url = await opts.buildUrl(boundRedirectUri);
  } catch (err) {
    // Nothing was handed to the caller, so the bound port is released instead of leaked.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    throw err as Error;
  }

  timer = setTimeout(() => {
    settle(() => rejectDone(new Error(timeoutMessage)));
  }, timeoutMs);

  return {
    url,
    redirectUri: boundRedirectUri,
    done,
    cancel: () => settle(() => rejectDone(new Error(cancelMessage))),
  };
}

/** One-shot localhost OAuth callback server shared by every OAuth browser flow:
 *  state check, `?error` handling, code exchange, success/error pages,
 *  timeout, and cancel. `done` rejects on error, cancel, or timeout. */
export async function beginLocalhostOAuthFlow<TCreds>(
  opts: LocalhostOAuthFlowOptions<TCreds>,
): Promise<LocalhostOAuthFlow<TCreds>> {
  const state = randomOAuthState();
  const redirectSource: CallbackRedirect = opts.redirectUriForPort
    ? { redirectUriForPort: opts.redirectUriForPort }
    : { redirectUri: opts.redirectUri as string };
  return beginOneShotCallbackFlow<TCreds>({
    ...redirectSource,
    port: opts.port,
    host: opts.host,
    allowPortFallback: opts.allowPortFallback,
    timeoutMs: opts.timeoutMs,
    timeoutMessage: opts.timeoutMessage,
    bindErrorMessage: opts.bindErrorMessage,
    buildUrl: (redirectUri) => opts.buildUrl(redirectUri, state),
    handle: (_req, res, { url, redirectUri, resolve, reject }) => {
      if (url.pathname !== opts.callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }
      const q = url.searchParams;
      if (q.get("error")) {
        const msg = q.get("error_description") ?? q.get("error") ?? "access_denied";
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage(msg));
        reject(new Error(`OAuth sign-in failed: ${msg}`));
        return;
      }
      const code = q.get("code");
      if (!code || q.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(errorPage(opts.stateMismatchMessage));
        reject(new Error("OAuth state mismatch"));
        return;
      }
      void opts
        .exchange(code, redirectUri)
        .then((creds) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(successPage(opts.successTitle, opts.successHeading));
          resolve(creds);
        })
        .catch((err: unknown) => {
          const msg = (err as Error).message;
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(errorPage(msg));
          reject(err as Error);
        });
    },
  });
}
