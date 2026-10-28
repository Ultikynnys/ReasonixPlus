/** Browser OAuth for HTTP MCP servers: protected-resource discovery, dynamic client
 *  registration, PKCE on a loopback port, and a per-request bearer resolver. */

import { createServer } from "node:http";
import type { McpOAuthCreds } from "../config.js";
import { defaultConfigPath, readConfig, saveMcpOAuth } from "../config.js";
import { singleFlight } from "../core/lazy.js";
import {
  type LocalhostOAuthFlow,
  type TokenResponse,
  beginLocalhostOAuthFlow,
  isTokenFresh,
  makePkcePair,
  postTokenForm,
} from "../oauth-shared.js";

/** Loopback port the callback server binds. Dynamic registration records the exact
 *  redirect URI, so the port has to be known before registration — a fixed one keeps
 *  the flow one-shot instead of re-registering per ephemeral port. */
export const MCP_OAUTH_CALLBACK_PORT = 8976;
export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";

const DISCOVERY_TIMEOUT_MS = 15_000;

/** Authorization-server metadata this client needs (RFC 8414 / OIDC discovery). */
export interface McpAuthorizationServerMetadata {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
}

export interface McpAuthDiscovery {
  /** Issuer base the metadata came from, e.g. `https://auth.example.com`. */
  authorizationServer: string;
  metadata: McpAuthorizationServerMetadata;
  /** The protected-resource document that pointed here, when one was found. */
  resourceMetadataUrl?: string;
  /** Scope the resource asked for, else the first the server supports. */
  scope?: string;
}

/** `resource_metadata` and `scope` out of a `WWW-Authenticate: Bearer ...` challenge. */
export function parseAuthChallenge(header: string | null | undefined): {
  resourceMetadata?: string;
  scope?: string;
} {
  if (!header) return {};
  const param = (name: string): string | undefined => {
    const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(header);
    if (quoted?.[1]) return quoted[1];
    const bare = new RegExp(`${name}\\s*=\\s*([^,\\s]+)`, "i").exec(header);
    return bare?.[1];
  };
  const out: { resourceMetadata?: string; scope?: string } = {};
  const resourceMetadata = param("resource_metadata");
  const scope = param("scope");
  if (resourceMetadata) out.resourceMetadata = resourceMetadata;
  if (scope) out.scope = scope;
  return out;
}

/** Protected-resource metadata candidates for one MCP endpoint, path-aware first
 *  (RFC 9728 §3.1), then the bare origin form. */
export function resourceMetadataCandidates(endpoint: string): string[] {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  const out = [`${url.origin}/.well-known/oauth-protected-resource${path}`];
  if (path) out.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return out;
}

/** Authorization-server metadata candidates. RFC 8414 inserts the well-known segment
 *  before an issuer path; OIDC discovery appends it. */
export function authorizationServerCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeAsMetadata(raw: unknown): McpAuthorizationServerMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Record<string, unknown>;
  const authorizationEndpoint = asString(doc.authorization_endpoint);
  const tokenEndpoint = asString(doc.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  const metadata: McpAuthorizationServerMetadata = { authorizationEndpoint, tokenEndpoint };
  const issuer = asString(doc.issuer);
  const registrationEndpoint = asString(doc.registration_endpoint);
  if (issuer) metadata.issuer = issuer;
  if (registrationEndpoint) metadata.registrationEndpoint = registrationEndpoint;
  if (Array.isArray(doc.scopes_supported)) {
    const scopes = doc.scopes_supported.filter((s): s is string => typeof s === "string" && !!s);
    if (scopes.length > 0) metadata.scopesSupported = scopes;
  }
  return metadata;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Ask the endpoint itself which authorization server protects it, by reading the
 *  challenge a bare `initialize` comes back with. */
async function probeAuthChallenge(
  endpoint: string,
): Promise<{ resourceMetadata?: string; scope?: string }> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "reasonix", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    return parseAuthChallenge(res.headers.get("www-authenticate"));
  } catch {
    return {};
  }
}

/** Resolve the authorization server and its endpoints for one MCP endpoint. The
 *  well-known document wins; the endpoint's own 401 challenge is the fallback. */
export async function discoverMcpAuth(
  endpoint: string,
  opts: { fetchJson?: (url: string) => Promise<unknown | null>; timeoutMs?: number } = {},
): Promise<McpAuthDiscovery> {
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const fetchJson = opts.fetchJson ?? ((url: string) => getJson(url, timeoutMs));
  let scope: string | undefined;
  let resourceMetadataUrl: string | undefined;
  let authorizationServers: string[] = [];

  for (const candidate of resourceMetadataCandidates(endpoint)) {
    const doc = await fetchJson(candidate);
    const servers = (doc as { authorization_servers?: unknown } | null)?.authorization_servers;
    if (Array.isArray(servers)) {
      const list = servers.filter((s): s is string => typeof s === "string" && !!s);
      if (list.length > 0) {
        resourceMetadataUrl = candidate;
        authorizationServers = list;
        const scopes = (doc as { scopes_supported?: unknown }).scopes_supported;
        if (Array.isArray(scopes)) {
          const first = scopes.find((s): s is string => typeof s === "string" && !!s);
          if (first) scope = first;
        }
        break;
      }
    }
  }

  if (authorizationServers.length === 0) {
    const challenge = await probeAuthChallenge(endpoint);
    if (challenge.resourceMetadata) {
      resourceMetadataUrl = challenge.resourceMetadata;
      const doc = await fetchJson(challenge.resourceMetadata);
      const servers = (doc as { authorization_servers?: unknown } | null)?.authorization_servers;
      if (Array.isArray(servers)) {
        authorizationServers = servers.filter((s): s is string => typeof s === "string" && !!s);
      }
    }
    if (!scope && challenge.scope) scope = challenge.scope;
  }

  if (authorizationServers.length === 0) {
    throw new Error(
      `${endpoint} does not advertise OAuth: no protected-resource metadata and no authorization server in its 401 challenge`,
    );
  }

  const authorizationServer = authorizationServers[0]!;
  for (const candidate of authorizationServerCandidates(authorizationServer)) {
    const metadata = normalizeAsMetadata(await fetchJson(candidate));
    if (!metadata) continue;
    if (!scope && metadata.scopesSupported?.[0]) scope = metadata.scopesSupported[0];
    return {
      authorizationServer,
      metadata,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    };
  }
  throw new Error(
    `no authorization-server metadata for ${authorizationServer} (tried ${authorizationServerCandidates(authorizationServer).join(", ")})`,
  );
}

/** The authorize URL for one connect attempt. Pure, so the shape is testable without a
 *  browser or a callback server. */
export function mcpAuthorizeUrl(p: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource?: string;
  scope?: string;
}): string {
  const url = new URL(p.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (p.scope) url.searchParams.set("scope", p.scope);
  if (p.resource) url.searchParams.set("resource", p.resource);
  return url.toString();
}

/** Register a public client for the loopback redirect (RFC 7591). The authorization
 *  server mints the id; nothing secret is stored, since PKCE carries the proof. */
export async function registerMcpClient(
  registrationEndpoint: string,
  redirectUri: string,
  opts: { clientName?: string; timeoutMs?: number } = {},
): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: opts.clientName ?? "Reasonix+",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: { client_id?: unknown; error_description?: unknown; error?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`client registration failed (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const reason = asString(body.error_description) ?? asString(body.error) ?? text.slice(0, 200);
    throw new Error(`client registration failed (${res.status}): ${reason}`);
  }
  const clientId = asString(body.client_id);
  if (!clientId) throw new Error("client registration returned no client_id");
  return clientId;
}

function toCreds(
  parsed: TokenResponse,
  base: Pick<McpOAuthCreds, "tokenEndpoint" | "clientId" | "scope" | "resource">,
  fallbackRefresh?: string,
): McpOAuthCreds {
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
  const creds: McpOAuthCreds = {
    accessToken: parsed.access_token as string,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0,
    tokenEndpoint: base.tokenEndpoint,
    clientId: base.clientId,
  };
  const refreshToken = parsed.refresh_token ?? fallbackRefresh;
  if (refreshToken) creds.refreshToken = refreshToken;
  if (base.scope) creds.scope = base.scope;
  if (base.resource) creds.resource = base.resource;
  return creds;
}

export interface McpOAuthFlow extends LocalhostOAuthFlow<McpOAuthCreds> {
  /** Authorization server the flow registered with, for diagnostics. */
  authorizationServer: string;
  /** Redirect URI that was registered. */
  redirectUri: string;
}

/** A loopback port that is free right now. Only used when a caller asks for an
 *  ephemeral one (`port: 0`); the default flow always uses the registered constant. */
async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const address = probe.address();
  const port = address && typeof address !== "string" ? address.port : MCP_OAUTH_CALLBACK_PORT;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Registration endpoint for a discovery result, or the reason there is none. */
function registrationEndpointOf(discovery: McpAuthDiscovery): string {
  const endpoint = discovery.metadata.registrationEndpoint;
  if (!endpoint) {
    throw new Error(
      `${discovery.authorizationServer} offers no dynamic client registration, so this server cannot be signed in from Settings`,
    );
  }
  return endpoint;
}

export interface BeginMcpOAuthOptions {
  /** Config file the credentials are written to after the exchange. */
  configPath?: string;
  /** Persist the result. Defaults to true; tests pass false to inspect the shape. */
  save?: boolean;
  /** Override the loopback port (tests). */
  port?: number;
  timeoutMs?: number;
  /** Injectable discovery/registration for tests. */
  discovery?: McpAuthDiscovery;
  clientId?: string;
  clientName?: string;
}

/** Start the browser flow for one MCP server. Resolves with credentials after the
 *  code exchange; `done` rejects on cancel, timeout, or a refused callback. */
export async function beginMcpOAuthFlow(
  serverName: string,
  endpoint: string,
  opts: BeginMcpOAuthOptions = {},
): Promise<McpOAuthFlow> {
  const port = opts.port === 0 ? await freeLoopbackPort() : (opts.port ?? MCP_OAUTH_CALLBACK_PORT);
  const redirectUri = `http://localhost:${port}${MCP_OAUTH_CALLBACK_PATH}`;
  const discovery = opts.discovery ?? (await discoverMcpAuth(endpoint));
  const clientId =
    opts.clientId ??
    (await registerMcpClient(registrationEndpointOf(discovery), redirectUri, {
      clientName: opts.clientName,
    }));
  const { verifier, challenge } = makePkcePair(64);
  const scope = discovery.scope;
  const resource = endpoint;
  const base = {
    tokenEndpoint: discovery.metadata.tokenEndpoint,
    clientId,
    ...(scope ? { scope } : {}),
    resource,
  };

  const flow = await beginLocalhostOAuthFlow<McpOAuthCreds>({
    callbackPath: MCP_OAUTH_CALLBACK_PATH,
    redirectUri,
    port,
    // The redirect URI is part of the registration, so it cannot move to another port.
    allowPortFallback: false,
    bindErrorMessage: `MCP sign-in needs port ${port} for its callback; free it and retry`,
    timeoutMs: opts.timeoutMs,
    successTitle: "Signed in",
    successHeading: `Signed in to ${serverName}`,
    stateMismatchMessage: "State mismatch - this sign-in attempt is invalid. Retry from Settings.",
    buildUrl: (uri, flowState) =>
      mcpAuthorizeUrl({
        authorizationEndpoint: discovery.metadata.authorizationEndpoint,
        clientId,
        redirectUri: uri,
        state: flowState,
        codeChallenge: challenge,
        resource,
        ...(scope ? { scope } : {}),
      }),
    exchange: async (code, uri) => {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: uri,
        code_verifier: verifier,
        resource,
      });
      const creds = toCreds(await postTokenForm(discovery.metadata.tokenEndpoint, body), base);
      if (opts.save !== false) saveMcpOAuth(serverName, creds, opts.configPath);
      return creds;
    },
    timeoutMessage: `MCP sign-in for ${serverName} timed out. Retry from Settings.`,
  });
  return { ...flow, authorizationServer: discovery.authorizationServer, redirectUri };
}

/** One refresh in flight per server. A single shared slot would hand one server's fresh
 *  token to whichever server asked next, so the flight is keyed by store path and name. */
type RefreshFlight = (run: () => Promise<McpOAuthCreds>) => Promise<McpOAuthCreds>;
const refreshFlights = new Map<string, RefreshFlight>();

function refreshFlight(serverName: string, configPath: string): RefreshFlight {
  const key = `${configPath}\u0000${serverName}`;
  let flight = refreshFlights.get(key);
  if (!flight) {
    flight = singleFlight<McpOAuthCreds>();
    refreshFlights.set(key, flight);
  }
  return flight;
}

/** Refresh one stored sign-in and persist it. Throws a re-connect prompt on refusal. */
async function refreshMcpOAuth(
  serverName: string,
  creds: McpOAuthCreds,
  configPath?: string,
): Promise<McpOAuthCreds> {
  if (!creds.refreshToken) {
    throw new Error(
      `${serverName} needs a new sign-in: the token expired and no refresh token was issued`,
    );
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    refresh_token: creds.refreshToken,
  });
  if (creds.resource) body.set("resource", creds.resource);
  let parsed: TokenResponse;
  try {
    parsed = await postTokenForm(creds.tokenEndpoint, body);
  } catch (err) {
    throw new Error(`${serverName} needs a new sign-in: ${(err as Error).message}`);
  }
  const next = toCreds(
    parsed,
    {
      tokenEndpoint: creds.tokenEndpoint,
      clientId: creds.clientId,
      ...(creds.scope ? { scope: creds.scope } : {}),
      ...(creds.resource ? { resource: creds.resource } : {}),
    },
    creds.refreshToken,
  );
  if (creds.account) next.account = creds.account;
  saveMcpOAuth(serverName, next, configPath);
  return next;
}

/** Per-request authorization header for one server, refreshed when near expiry. This is
 *  what `StreamableHttpTransport`'s `headersResolver` calls. */
export async function resolveMcpOAuthHeaders(
  serverName: string,
  configPath: string = defaultConfigPath(),
): Promise<Record<string, string>> {
  const creds = readConfig(configPath).mcpOAuth?.[serverName];
  if (!creds) throw new Error(`${serverName} needs a sign-in: no token is stored`);
  const fresh =
    creds.expiresAt === 0 || isTokenFresh(creds.expiresAt, creds.refreshToken)
      ? creds
      : await refreshFlight(
          serverName,
          configPath,
        )(() => refreshMcpOAuth(serverName, creds, configPath));
  return { authorization: `Bearer ${fresh.accessToken}` };
}

/** The cached token without any network call, for transports that only take static
 *  headers (SSE). Undefined when nothing is stored. */
export function cachedMcpOAuthHeaders(
  serverName: string,
  configPath: string = defaultConfigPath(),
): Record<string, string> | undefined {
  const creds = readConfig(configPath).mcpOAuth?.[serverName];
  return creds?.accessToken ? { authorization: `Bearer ${creds.accessToken}` } : undefined;
}

export type McpOAuthState = "none" | "connected" | "expired";

/** Sign-in state for Settings rows. Sync: it reads the store, never the network. */
export function mcpOAuthState(
  serverName: string,
  configPath: string = defaultConfigPath(),
): McpOAuthState {
  const creds = readConfig(configPath).mcpOAuth?.[serverName];
  if (!creds) return "none";
  const expired = creds.expiresAt > 0 && creds.expiresAt <= Date.now() && !creds.refreshToken;
  return expired ? "expired" : "connected";
}
