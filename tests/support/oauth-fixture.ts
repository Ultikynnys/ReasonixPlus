/** Test fixtures for MCP browser sign-in: a local authorization server double and a
 *  credential factory, so no test restates the same OAuth documents or token literal. */

import { type Server, createServer } from "node:http";
import type { McpOAuthCreds } from "../../src/config.js";

/** One stored sign-in: a fresh token against a fake authorization server. */
export function mcpCreds(overrides: Partial<McpOAuthCreds> = {}): McpOAuthCreds {
  return {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-1",
    ...overrides,
  };
}

export interface AuthFixtureOverrides {
  /** Scopes the protected-resource document advertises. */
  resourceScopes?: string[];
  /** Token endpoint reply, computed from the form it received. */
  token?: (form: URLSearchParams) => { status: number; body: unknown };
  /** Omit `registration_endpoint` from the metadata. */
  withRegistration?: boolean;
  registrationStatus?: number;
}

export interface AuthFixture {
  /** Loopback base URL, e.g. `http://127.0.0.1:51234`. */
  readonly base: string;
  /** Redirect URI the last client registration asked for. */
  readonly registeredRedirect: string | undefined;
  /** Form the token endpoint received most recently. */
  readonly lastTokenForm: URLSearchParams | undefined;
  close: () => Promise<void>;
}

/** Start the double: an MCP endpoint answering 401 with a challenge, the protected-resource
 *  document, authorization-server metadata, dynamic registration and a token endpoint. */
export async function startAuthFixture(overrides: AuthFixtureOverrides = {}): Promise<AuthFixture> {
  const state = {
    registeredRedirect: undefined as string | undefined,
    lastTokenForm: undefined as URLSearchParams | undefined,
  };
  let base = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const readBody = (done: (body: string) => void) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => done(body));
    };
    if (url.pathname === "/api/mcp/notfair") {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/challenge-meta"`,
      });
      res.end();
      return;
    }
    if (
      url.pathname === "/challenge-meta" ||
      url.pathname.startsWith("/.well-known/oauth-protected-resource")
    ) {
      json({
        resource: `${base}/api/mcp/notfair`,
        authorization_servers: [base],
        scopes_supported: overrides.resourceScopes ?? ["mcp"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(overrides.withRegistration === false
          ? {}
          : { registration_endpoint: `${base}/register` }),
        scopes_supported: ["mcp", "offline"],
      });
      return;
    }
    if (url.pathname === "/register") {
      readBody((body) => {
        const form = JSON.parse(body) as { redirect_uris?: string[] };
        state.registeredRedirect = form.redirect_uris?.[0];
        json({ client_id: "registered-client" }, overrides.registrationStatus ?? 201);
      });
      return;
    }
    if (url.pathname === "/token") {
      readBody((body) => {
        const form = new URLSearchParams(body);
        state.lastTokenForm = form;
        const reply = overrides.token?.(form) ?? {
          status: 200,
          body: { access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 },
        };
        json(reply.body, reply.status);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("auth fixture failed to bind a port");
  base = `http://127.0.0.1:${address.port}`;
  return {
    get base() {
      return base;
    },
    get registeredRedirect() {
      return state.registeredRedirect;
    },
    get lastTokenForm() {
      return state.lastTokenForm;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
