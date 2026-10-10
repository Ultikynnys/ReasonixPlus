import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, saveOpencodeOAuth } from "../src/config.js";
import {
  OPENCODE_OAUTH_CLIENT_ID,
  beginOpencodeDeviceFlow,
  hasOpencodeOAuthSession,
  opencodeConsoleServer,
  resolveOpencodeToken,
  signOutOpencode,
} from "../src/opencode-oauth.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-opencode-oauth");
const CONFIG_PATH = join(TEST_DIR, "config.json");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("opencode-oauth", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(process.env, "OPENCODE_CONSOLE_URL");
  });

  it("defaults to the production Console and honors an env override", () => {
    expect(opencodeConsoleServer()).toBe("https://opencode.ai/console");
    process.env.OPENCODE_CONSOLE_URL = "https://console.example.com/base/";
    expect(opencodeConsoleServer()).toBe("https://console.example.com/base");
  });

  it("runs the device flow and returns Console credentials", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith("/auth/device/code")) {
        expect(body.client_id).toBe(OPENCODE_OAUTH_CLIENT_ID);
        return jsonResponse({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 0,
        });
      }
      if (url.endsWith("/auth/device/token")) {
        expect(body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
        return jsonResponse({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          org_id: "org-1",
        });
      }
      if (url.endsWith("/api/user")) return jsonResponse({ id: "u1", email: "me@example.com" });
      if (url.endsWith("/api/orgs")) return jsonResponse([{ id: "org-1", name: "Acme" }]);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const flow = await beginOpencodeDeviceFlow({ server: "https://opencode.ai/console" });
    expect(flow.url).toBe("https://opencode.ai/console/device?user_code=ABCD-EFGH");
    expect(flow.userCode).toBe("ABCD-EFGH");
    const creds = await flow.done;

    expect(creds.accessToken).toBe("access-1");
    expect(creds.refreshToken).toBe("refresh-1");
    expect(creds.account).toBe("me@example.com");
    expect(creds.orgId).toBe("org-1");
    expect(creds.orgName).toBe("Acme");
    expect(calls.some((u) => u.endsWith("/auth/device/token"))).toBe(true);
  });

  it("returns a fresh stored access token without a network call", async () => {
    saveOpencodeOAuth(
      {
        accessToken: "fresh-token",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      CONFIG_PATH,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(hasOpencodeOAuthSession(CONFIG_PATH)).toBe(true);
    expect(await resolveOpencodeToken(CONFIG_PATH)).toBe("fresh-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the rotated pair", async () => {
    saveOpencodeOAuth(
      {
        accessToken: "old-token",
        refreshToken: "refresh-old",
        expiresAt: Date.now() - 1000,
        server: "https://opencode.ai/console",
      },
      CONFIG_PATH,
    );
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://opencode.ai/console/auth/device/token");
      const body = JSON.parse(String(init?.body));
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("refresh-old");
      return jsonResponse({
        access_token: "new-token",
        refresh_token: "refresh-new",
        expires_in: 3600,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveOpencodeToken(CONFIG_PATH)).toBe("new-token");
    const stored = readConfig(CONFIG_PATH).opencodeOAuth;
    expect(stored?.accessToken).toBe("new-token");
    expect(stored?.refreshToken).toBe("refresh-new");
  });

  it("sign-out clears the stored session", async () => {
    saveOpencodeOAuth(
      { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1000 },
      CONFIG_PATH,
    );
    expect(hasOpencodeOAuthSession(CONFIG_PATH)).toBe(true);
    await signOutOpencode(CONFIG_PATH);
    expect(hasOpencodeOAuthSession(CONFIG_PATH)).toBe(false);
  });
});
