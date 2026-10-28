import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpTransportAuth } from "../src/cli/commands/mcp-runtime.js";
import { clearMcpOAuth, readConfig, saveMcpOAuth } from "../src/config.js";
import {
  MCP_OAUTH_CALLBACK_PATH,
  authorizationServerCandidates,
  beginMcpOAuthFlow,
  cachedMcpOAuthHeaders,
  discoverMcpAuth,
  mcpAuthorizeUrl,
  mcpOAuthState,
  parseAuthChallenge,
  registerMcpClient,
  resolveMcpOAuthHeaders,
} from "../src/mcp/oauth.js";
import type { McpServerSpec } from "../src/mcp/spec.js";
import { type AuthFixture, mcpCreds, startAuthFixture } from "./support/oauth-fixture.js";

describe("OAuth challenge parsing", () => {
  it("reads a quoted resource_metadata and scope", () => {
    expect(
      parseAuthChallenge(
        'Bearer resource_metadata="https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair", scope="mcp"',
      ),
    ).toEqual({
      resourceMetadata: "https://notfair.co/.well-known/oauth-protected-resource/api/mcp/notfair",
      scope: "mcp",
    });
  });

  it("reads a bare value and ignores anything else", () => {
    expect(parseAuthChallenge("Bearer resource_metadata=https://a.test/meta")).toEqual({
      resourceMetadata: "https://a.test/meta",
    });
    expect(parseAuthChallenge(null)).toEqual({});
    expect(parseAuthChallenge("Basic realm=x")).toEqual({});
  });
});

describe("metadata URLs", () => {
  it("puts the well-known segment before the endpoint path", () => {
    expect(authorizationServerCandidates("https://auth.example.com")).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/openid-configuration",
    ]);
    expect(authorizationServerCandidates("https://auth.example.com/tenant")[0]).toBe(
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant",
    );
  });

  it("builds an RFC 8707 authorize URL", () => {
    const url = new URL(
      mcpAuthorizeUrl({
        authorizationEndpoint: "https://auth.test/authorize",
        clientId: "client-1",
        redirectUri: "http://localhost:8976/mcp/oauth/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        resource: "https://notfair.co/api/mcp/notfair",
        scope: "mcp",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://notfair.co/api/mcp/notfair");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `http://localhost:8976${MCP_OAUTH_CALLBACK_PATH}`,
    );
  });
});

describe("discovery and sign-in", () => {
  let fixture: AuthFixture;
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    fixture = await startAuthFixture();
    dir = mkdtempSync(join(tmpdir(), "reasonix-mcp-oauth-"));
    configPath = join(dir, "config.json");
  });

  afterEach(async () => {
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discovers the authorization server from the protected-resource document", async () => {
    const discovery = await discoverMcpAuth(`${fixture.base}/api/mcp/notfair`);
    expect(discovery.authorizationServer).toBe(fixture.base);
    expect(discovery.metadata.authorizationEndpoint).toBe(`${fixture.base}/authorize`);
    expect(discovery.metadata.tokenEndpoint).toBe(`${fixture.base}/token`);
    expect(discovery.metadata.registrationEndpoint).toBe(`${fixture.base}/register`);
    expect(discovery.scope).toBe("mcp");
  });

  it("falls back to the endpoint's 401 challenge when the well-known document is absent", async () => {
    const endpoint = `${fixture.base}/api/mcp/notfair`;
    const discovered = await discoverMcpAuth(endpoint, {
      // Hide both well-known forms; the challenge is then the only way to the metadata.
      fetchJson: async (url) =>
        url.includes("/.well-known/oauth-protected-resource")
          ? null
          : await fetch(url)
              .then((res) => (res.ok ? (res.json() as Promise<unknown>) : null))
              .catch(() => null),
    });
    expect(discovered.resourceMetadataUrl).toBe(`${fixture.base}/challenge-meta`);
    expect(discovered.metadata.tokenEndpoint).toBe(`${fixture.base}/token`);
  });

  it("refuses an endpoint that advertises no OAuth at all", async () => {
    await expect(
      discoverMcpAuth("http://127.0.0.1:1/none", { fetchJson: async () => null, timeoutMs: 200 }),
    ).rejects.toThrow(/does not advertise OAuth/);
  });

  it("registers a public client for the loopback redirect", async () => {
    const redirect = `http://localhost:8976${MCP_OAUTH_CALLBACK_PATH}`;
    await expect(registerMcpClient(`${fixture.base}/register`, redirect)).resolves.toBe(
      "registered-client",
    );
    expect(fixture.registeredRedirect).toBe(redirect);
  });

  it("keeps a fresh token and refreshes an expired one", async () => {
    saveMcpOAuth(
      "notfair",
      mcpCreds({
        accessToken: "at-old",
        refreshToken: "rt-old",
        resource: `${fixture.base}/api/mcp/notfair`,
        tokenEndpoint: `${fixture.base}/token`,
      }),
      configPath,
    );
    expect(await resolveMcpOAuthHeaders("notfair", configPath)).toEqual({
      authorization: "Bearer at-old",
    });
    expect(fixture.lastTokenForm).toBeUndefined();

    saveMcpOAuth(
      "notfair",
      mcpCreds({
        accessToken: "at-stale",
        refreshToken: "rt-old",
        expiresAt: Date.now() - 1000,
        resource: `${fixture.base}/api/mcp/notfair`,
        tokenEndpoint: `${fixture.base}/token`,
      }),
      configPath,
    );
    expect(await resolveMcpOAuthHeaders("notfair", configPath)).toEqual({
      authorization: "Bearer at-new",
    });
    expect(fixture.lastTokenForm?.get("grant_type")).toBe("refresh_token");
    expect(readConfig(configPath).mcpOAuth?.notfair?.refreshToken).toBe("rt-new");
  });

  it("refreshes two servers side by side without handing one the other's token", async () => {
    const echoing = await startAuthFixture({
      token: (form) => ({
        status: 200,
        body: { access_token: `at-${form.get("refresh_token")}`, expires_in: 3600 },
      }),
    });
    try {
      for (const name of ["alpha", "beta"]) {
        saveMcpOAuth(
          name,
          mcpCreds({
            accessToken: "at-stale",
            refreshToken: `rt-${name}`,
            expiresAt: Date.now() - 1000,
            tokenEndpoint: `${echoing.base}/token`,
          }),
          configPath,
        );
      }
      const [alpha, beta] = await Promise.all([
        resolveMcpOAuthHeaders("alpha", configPath),
        resolveMcpOAuthHeaders("beta", configPath),
      ]);
      expect(alpha).toEqual({ authorization: "Bearer at-rt-alpha" });
      expect(beta).toEqual({ authorization: "Bearer at-rt-beta" });
    } finally {
      await echoing.close();
    }
  });

  it("asks for a new sign-in when the refresh token is refused", async () => {
    const refusing = await startAuthFixture({
      token: () => ({ status: 400, body: { error: "invalid_grant" } }),
    });
    try {
      saveMcpOAuth(
        "notfair",
        mcpCreds({
          accessToken: "at-stale",
          refreshToken: "rt-dead",
          expiresAt: Date.now() - 1000,
          tokenEndpoint: `${refusing.base}/token`,
        }),
        configPath,
      );
      await expect(resolveMcpOAuthHeaders("notfair", configPath)).rejects.toThrow(
        /notfair needs a new sign-in/,
      );
    } finally {
      await refusing.close();
    }
  });

  it("reports and clears sign-in state", () => {
    expect(mcpOAuthState("notfair", configPath)).toBe("none");
    saveMcpOAuth(
      "notfair",
      mcpCreds({ expiresAt: Date.now() + 3_600_000, tokenEndpoint: `${fixture.base}/token` }),
      configPath,
    );
    expect(mcpOAuthState("notfair", configPath)).toBe("connected");
    expect(cachedMcpOAuthHeaders("notfair", configPath)).toEqual({ authorization: "Bearer at" });
    expect(clearMcpOAuth("notfair", configPath)).toBe(true);
    expect(mcpOAuthState("notfair", configPath)).toBe("none");
    expect(cachedMcpOAuthHeaders("notfair", configPath)).toBeUndefined();
  });

  it("builds the browser flow against the discovered endpoints", async () => {
    const flow = await beginMcpOAuthFlow("notfair", `${fixture.base}/api/mcp/notfair`, {
      configPath,
      port: 0,
      save: false,
    });
    const url = new URL(flow.url);
    expect(url.origin + url.pathname).toBe(`${fixture.base}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("registered-client");
    expect(url.searchParams.get("resource")).toBe(`${fixture.base}/api/mcp/notfair`);
    expect(flow.redirectUri).toContain(MCP_OAUTH_CALLBACK_PATH);
    flow.cancel();
    await expect(flow.done).rejects.toThrow(/cancelled/);
  });

  it("refuses a server whose authorization server cannot register clients", async () => {
    const bare = await startAuthFixture({ withRegistration: false });
    try {
      await expect(
        beginMcpOAuthFlow("notfair", `${bare.base}/api/mcp/notfair`, { configPath, port: 0 }),
      ).rejects.toThrow(/no dynamic client registration/);
    } finally {
      await bare.close();
    }
  });
});

describe("transport auth wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-mcp-auth-"));
  const configPath = join(dir, "config.json");
  const httpSpec: McpServerSpec = {
    transport: "streamable-http",
    name: "notfair",
    url: "http://127.0.0.1:9/api/mcp/notfair",
  };
  const sseSpec: McpServerSpec = {
    transport: "sse",
    name: "notfair",
    url: "http://127.0.0.1:9/sse",
    headers: { "x-extra": "1" },
  };

  beforeEach(() => {
    saveMcpOAuth(
      "notfair",
      mcpCreds({ expiresAt: Date.now() + 3_600_000, tokenEndpoint: "http://127.0.0.1:9/token" }),
      configPath,
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds nothing for a server the user never signed in to", () => {
    expect(mcpTransportAuth({ ...httpSpec, name: "unsigned" }, configPath)).toEqual({});
  });

  it("resolves a bearer per request for streamable-http", async () => {
    const auth = mcpTransportAuth(httpSpec, configPath);
    expect(auth.headers).toBeUndefined();
    expect(await auth.headersResolver?.()).toEqual({ authorization: "Bearer at" });
  });

  it("hands SSE a static header beside the entry's own headers", () => {
    expect(mcpTransportAuth(sseSpec, configPath)).toEqual({
      headers: { "x-extra": "1", authorization: "Bearer at" },
    });
  });

  it("leaves stdio servers alone", () => {
    const stdio: McpServerSpec = {
      transport: "stdio",
      name: "notfair",
      command: "node",
      args: [],
    };
    expect(mcpTransportAuth(stdio, configPath)).toEqual({});
  });
});

describe("token store isolation", () => {
  it("keeps a hand-edited config valid when the token map is garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-mcp-oauth-raw-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ mcpOAuth: "nope" }));
      expect(readConfig(path).mcpOAuth).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
