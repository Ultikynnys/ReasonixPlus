// Consolidated from 9 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { providerSpec } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BalanceInfo, pickPrimaryBalance } from "../src/client.js";
import { parseCodexQuotaPayload } from "../src/codex-backend.js";
import { readConfig, saveOpencodeOAuth, writeConfig } from "../src/config.js";
import { isQuotaExhaustedError } from "../src/loop/errors.js";
import { beginMiMoLoginFlow, decryptMiMoCredential } from "../src/mimo-auth.js";
import { fetchMiMoQuota, readMiMoConsoleSession } from "../src/mimo-quota.js";
import { modelClientOptions } from "../src/model-client.js";
import {
  DEFAULT_NO_PROXY,
  _resetForTests,
  detectNoProxyRaw,
  detectProxyUrl,
  installProxyIfConfigured,
  matchesNoProxy,
  normalizeProxyUrl,
  parseNoProxy,
  redactProxyUrl,
  resolveBypassDeepSeekDirect,
  resolveNoProxy,
} from "../src/net/proxy.js";
import {
  OPENCODE_MODELS_CACHE_TTL_MS,
  fetchOpencodeModels,
  isDiscoveredOpencodeModel,
  isOpencodeFreeModel,
  isOpencodeGoModel,
  loadOpencodeModelsCache,
  opencodeModelsCachePath,
  opencodeUsagePlan,
  reasoningEffortsForModel,
  writeOpencodeModelsCache,
} from "../src/opencode-models.js";
import {
  OPENCODE_OAUTH_CLIENT_ID,
  beginOpencodeDeviceFlow,
  hasOpencodeOAuthSession,
  opencodeConsoleServer,
  resolveOpencodeToken,
  signOutOpencode,
} from "../src/opencode-oauth.js";
import { fetchOpencodeQuota, opencodeUsageUrl } from "../src/opencode-quota.js";

describe("opencode-models", () => {
  const TEST_DIR = join(process.cwd(), ".tmp-test-opencode-models");

  describe("opencode-models", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it("extracts free models and vision models keyless", async () => {
      const fakeData = {
        opencode: {
          models: {
            "new-free-model": {
              id: "new-free-model",
              name: "New Free Model",
              attachment: true,
              cost: { input: 0, output: 0 },
            },
            "paid-model": {
              id: "paid-model",
              name: "Paid Model",
              attachment: false,
              cost: { input: 1.5, output: 2.0 },
            },
          },
        },
      };

      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
        credentialed: false,
      });

      expect(snapshot.error).toBeUndefined();
      expect(snapshot.models).toContain("new-free-model");
      expect(snapshot.visionModels).toContain("new-free-model");
      expect(snapshot.models).not.toContain("paid-model");
      // Also contains static baseline models
      expect(snapshot.models).toContain("big-pickle");
    });

    it("includes paid Zen and Go models when credentialed", async () => {
      const fakeData = {
        opencode: {
          models: {
            "paid-zen": { cost: { input: 1.5, output: 2.0 } },
          },
        },
        "opencode-go": {
          models: {
            "go-only": { cost: { input: 0.5, output: 1 } },
            "go-free": { cost: { input: 0, output: 0 } },
          },
        },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
        credentialed: true,
      });

      expect(snapshot.models).toContain("paid-zen");
      expect(snapshot.models).toContain("go-only");
      expect(snapshot.models).toContain("go-free");

      // Go-only ids route to the Go endpoint; Zen ids do not.
      expect(isOpencodeGoModel("go-only", TEST_DIR)).toBe(true);
      expect(isOpencodeGoModel("paid-zen", TEST_DIR)).toBe(false);
      // Overlaps prefer Zen: a Zen id that also exists in Go is not Go-routed.
      expect(isOpencodeGoModel("paid-zen", TEST_DIR)).toBe(false);
    });

    it("drops paid models for a keyless caller but keeps them cached for a credentialed one", async () => {
      const fakeData = {
        opencode: { models: { "paid-zen": { cost: { input: 1 } } } },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const keyless = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
        credentialed: false,
      });
      expect(keyless.models).not.toContain("paid-zen");

      // A later credentialed read reuses the same cache without another fetch.
      const credentialed = await fetchOpencodeModels({ homeDir: TEST_DIR, credentialed: true });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(credentialed.models).toContain("paid-zen");
    });

    it("serves from cache when within TTL and force is false", async () => {
      writeOpencodeModelsCache(
        {
          models: ["cached-model"],
          freeModels: ["cached-model"],
          visionModels: ["cached-model"],
          goModels: [],
          reasoningEfforts: {},
          checkedAt: Date.now() - 1000,
        },
        TEST_DIR,
      );

      const fetchImpl = vi.fn();
      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: false,
        credentialed: false,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(snapshot.models).toContain("cached-model");
    });

    it("bypasses cache when force is true", async () => {
      writeOpencodeModelsCache(
        {
          models: ["old-cached-model"],
          freeModels: ["old-cached-model"],
          visionModels: [],
          goModels: [],
          reasoningEfforts: {},
          checkedAt: Date.now() - 1000,
        },
        TEST_DIR,
      );

      const fakeData = {
        opencode: {
          models: {
            "refreshed-free-model": {
              id: "refreshed-free-model",
              cost: { input: 0, output: 0 },
            },
          },
        },
      };

      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
        credentialed: false,
      });

      expect(fetchImpl).toHaveBeenCalled();
      expect(snapshot.models).toContain("refreshed-free-model");
    });

    it("normalizes the pre-Go cache schema so an upgrade stays warm", () => {
      const path = opencodeModelsCachePath(TEST_DIR);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ models: ["legacy-model"], visionModels: [], checkedAt: Date.now() }),
        "utf8",
      );
      const cached = loadOpencodeModelsCache(TEST_DIR);
      expect(cached?.models).toContain("legacy-model");
      expect(cached?.freeModels).toContain("legacy-model");
      expect(cached?.goModels).toEqual([]);
    });

    it("logs loudly to stderr on fetch failure and reports error in snapshot (AntiSilentFallback)", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const fetchImpl = vi.fn().mockRejectedValue(new Error("Network unreachable"));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
        credentialed: false,
      });

      expect(stderrSpy).toHaveBeenCalled();
      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("reasonix: failed to fetch models.dev");
      expect(snapshot.error).toContain("Network unreachable");
      // Still includes baseline models
      expect(snapshot.models).toContain("big-pickle");
    });

    it("isDiscoveredOpencodeModel checks static catalog and cached discovery", () => {
      expect(isDiscoveredOpencodeModel("big-pickle", TEST_DIR)).toBe(true);
      // Static Go ids are recognized too.
      expect(isDiscoveredOpencodeModel("glm-5.3", TEST_DIR)).toBe(true);
      expect(isDiscoveredOpencodeModel("unknown-model", TEST_DIR)).toBe(false);
      // Discovery membership matches the RAW id (it gates OpenCode-vs-`ollama/`
      // precedence), so a provider-qualified ref is not an OpenCode discovery id.
      expect(isDiscoveredOpencodeModel("opencode/big-pickle", TEST_DIR)).toBe(false);

      writeOpencodeModelsCache(
        {
          models: ["custom-discovered-model"],
          freeModels: ["custom-discovered-model"],
          visionModels: [],
          goModels: [],
          reasoningEfforts: {},
          checkedAt: Date.now(),
        },
        TEST_DIR,
      );

      expect(isDiscoveredOpencodeModel("custom-discovered-model", TEST_DIR)).toBe(true);
    });

    it("classifies free vs Go OpenCode models for the quota-type UI", () => {
      // A static free Zen id is free; static Go-only ids are Go, never free.
      expect(isOpencodeFreeModel("big-pickle", TEST_DIR)).toBe(true);
      expect(isOpencodeFreeModel("mimo-v2.6-pro", TEST_DIR)).toBe(false);
      expect(isOpencodeFreeModel("glm-5.3", TEST_DIR)).toBe(false);
    });

    it("resolves the usage plan on the wire id so a provider qualifier can't hide it", () => {
      // A shared id resold through OpenCode is the SAME Go model as the bare id,
      // so the qualifier must not demote it to a non-Go tier (the Xiaomi native id
      // shares the name but not the plan).
      expect(isOpencodeGoModel("opencode/mimo-v2.6-pro", TEST_DIR)).toBe(true);
      expect(isOpencodeFreeModel("opencode/mimo-v2.6-pro", TEST_DIR)).toBe(false);
      expect(opencodeUsagePlan("opencode/mimo-v2.6-pro", TEST_DIR)).toBe("go");
      expect(opencodeUsagePlan("mimo-v2.6-pro", TEST_DIR)).toBe("go");
      // A free Zen id stays free under its own qualifier and is never Go.
      expect(opencodeUsagePlan("opencode/big-pickle", TEST_DIR)).toBe("free");
      expect(opencodeUsagePlan("big-pickle", TEST_DIR)).toBe("free");
      // Paid Zen (neither Go nor free) resolves to no plan.
      expect(opencodeUsagePlan("some-paid-zen-id", TEST_DIR)).toBeUndefined();
    });

    it("classifies discovered free and Go models for the quota-type UI", () => {
      writeOpencodeModelsCache(
        {
          models: ["new-free-model", "go-only", "paid-zen"],
          freeModels: ["new-free-model"],
          visionModels: [],
          goModels: ["go-only"],
          reasoningEfforts: {},
          checkedAt: Date.now(),
        },
        TEST_DIR,
      );
      expect(isOpencodeFreeModel("new-free-model", TEST_DIR)).toBe(true);
      expect(isOpencodeFreeModel("go-only", TEST_DIR)).toBe(false);
      expect(isOpencodeFreeModel("paid-zen", TEST_DIR)).toBe(false);
    });

    it("uses the documented cache TTL", () => {
      expect(OPENCODE_MODELS_CACHE_TTL_MS).toBe(12 * 60 * 60 * 1000);
    });

    it("captures per-model reasoning effort values from models.dev", async () => {
      const fakeData = {
        opencode: {
          models: {
            "effort-free": {
              cost: { input: 0 },
              reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
            },
            "toggle-model": { cost: { input: 0 }, reasoning_options: [{ type: "toggle" }] },
            "noopts-model": { cost: { input: 0 } },
          },
        },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(snapshot.reasoningEfforts.opencode?.["effort-free"]).toEqual(["low", "high", "max"]);
      // Options exist but no effort ladder -> empty (toggle/budget-only).
      expect(snapshot.reasoningEfforts.opencode?.["toggle-model"]).toEqual([]);
      // No declared options -> key absent (provider default applies).
      expect(snapshot.reasoningEfforts.opencode?.["noopts-model"]).toBeUndefined();

      expect(reasoningEffortsForModel("opencode", "effort-free", TEST_DIR)).toEqual([
        "low",
        "high",
        "max",
      ]);
      expect(reasoningEffortsForModel("opencode", "toggle-model", TEST_DIR)).toEqual([]);
      expect(reasoningEffortsForModel("opencode", "unknown-model", TEST_DIR)).toBeUndefined();
    });

    it("captures reasoning options for native providers from the same sync", async () => {
      const fakeData = {
        opencode: { models: { "big-pickle": { reasoning_options: [{ type: "toggle" }] } } },
        deepseek: {
          models: {
            "deepseek-flash": {
              reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
            },
          },
        },
        zai: {
          models: {
            "glm-5.2": { reasoning_options: [{ type: "effort", values: ["high", "max"] }] },
            "glm-4.7": { reasoning_options: [{ type: "toggle" }] },
          },
        },
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

      const snapshot = await fetchOpencodeModels({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(snapshot.reasoningEfforts.deepseek?.["deepseek-flash"]).toEqual([
        "low",
        "high",
        "max",
      ]);
      expect(snapshot.reasoningEfforts.zai?.["glm-5.2"]).toEqual(["high", "max"]);
      expect(snapshot.reasoningEfforts.zai?.["glm-4.7"]).toEqual([]);
      // Native ids never leak into the OpenCode picker.
      expect(snapshot.models).not.toContain("deepseek-flash");

      expect(reasoningEffortsForModel("zai", "glm-5.2", TEST_DIR)).toEqual(["high", "max"]);
      // A provider mismatch resolves to undefined even when the id exists elsewhere.
      expect(reasoningEffortsForModel("opencode", "glm-5.2", TEST_DIR)).toBeUndefined();
    });
  });
});

describe("opencode-oauth", () => {
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
});

describe("opencode-quota", () => {
  function mockFetch(impl: () => Promise<Response> | Response) {
    const fn = vi.fn(impl);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  describe("opencode-quota", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("derives the Go usage URL only for opencode.ai hosts", () => {
      expect(opencodeUsageUrl("https://opencode.ai/zen/go/v1")).toBe(
        "https://opencode.ai/zen/go/v1/usage",
      );
      expect(opencodeUsageUrl("https://opencode.ai/zen/v1")).toBe(
        "https://opencode.ai/zen/go/v1/usage",
      );
      // A custom proxy (or a non-opencode host) must never be guessed at.
      expect(opencodeUsageUrl("https://my-gateway.example.com/v1")).toBeUndefined();
      expect(opencodeUsageUrl("not a url")).toBeUndefined();
      // The public Go address is the declared route on the declared Go tier, so a
      // provider file edit moves both ends together.
      const goTier = providerSpec("opencode")?.endpoint.tiers.go ?? "";
      expect(opencodeUsageUrl(goTier)).toBe("https://opencode.ai/zen/go/v1/usage");
    });

    it("parses the rolling/weekly/monthly windows into %-left windows", async () => {
      const fetchFn = mockFetch(
        () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: "ok", percent: 30, resetsAt: "2026-01-01T05:00:00.000Z" },
                weekly: { status: "ok", percent: 12.5, resetsAt: null },
                monthly: { status: "rate-limited", percent: 100 },
              },
            }),
            { status: 200 },
          ),
      );

      const quota = await fetchOpencodeQuota("https://opencode.ai/zen/go/v1", "tok");

      expect(fetchFn).toHaveBeenCalledWith(
        "https://opencode.ai/zen/go/v1/usage",
        expect.objectContaining({
          headers: { Authorization: "Bearer tok", Accept: "application/json" },
        }),
      );
      expect(quota).toEqual({
        rolling: {
          usagePct: 30,
          remainingPct: 70,
          resetsAt: "2026-01-01T05:00:00.000Z",
          limited: false,
        },
        weekly: { usagePct: 12.5, remainingPct: 87.5, resetsAt: null, limited: false },
        monthly: { usagePct: 100, remainingPct: 0, resetsAt: null, limited: true },
      });
    });

    it("never fetches against a custom base URL", async () => {
      const fetchFn = mockFetch(() => new Response("{}", { status: 200 }));
      expect(await fetchOpencodeQuota("https://my-gateway.example.com/v1", "tok")).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("returns undefined when there is no credential", async () => {
      const fetchFn = mockFetch(() => new Response("{}", { status: 200 }));
      expect(await fetchOpencodeQuota("https://opencode.ai/zen/go/v1", "")).toBeUndefined();
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("returns undefined on a non-2xx response (e.g. 403 without a Go plan)", async () => {
      mockFetch(
        () =>
          new Response(JSON.stringify({ type: "error", error: { type: "EntitlementError" } }), {
            status: 403,
          }),
      );
      expect(await fetchOpencodeQuota("https://opencode.ai/zen/go/v1", "tok")).toBeUndefined();
    });

    it("returns undefined on a malformed payload", async () => {
      mockFetch(() => new Response(JSON.stringify({ usage: {} }), { status: 200 }));
      expect(await fetchOpencodeQuota("https://opencode.ai/zen/go/v1", "tok")).toBeUndefined();
    });

    it("returns undefined when the request throws", async () => {
      mockFetch(() => Promise.reject(new Error("network down")));
      expect(await fetchOpencodeQuota("https://opencode.ai/zen/go/v1", "tok")).toBeUndefined();
    });
  });
});

// MiMo browser-authorization adapter: crypto + localhost-callback flow. The
// *  "encrypt" helper stands in for Xiaomi's X25519 + AES-256-GCM provisioning.
describe("mimo-auth", () => {
  const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

  /** Encrypt a credential for the flow identified by its base64url SPKI public key. */
  function encryptForFlow(pkBase64url: string, credential: object): string {
    const spki = Buffer.from(pkBase64url, "base64url");
    const flowPublicRaw = spki.subarray(spki.length - 32); // trailing 32 bytes = raw key
    const flowPublic = createPublicKey({
      key: Buffer.concat([X25519_SPKI_PREFIX, flowPublicRaw]),
      format: "der",
      type: "spki",
    });
    const ephemeral = generateKeyPairSync("x25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const privateKey = createPrivateKey({
      key: ephemeral.privateKey,
      format: "der",
      type: "pkcs8",
    });
    const secret = diffieHellman({ privateKey, publicKey: flowPublic });
    const aesKey = createHash("sha256").update(secret).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aesKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const ephemeralPublic = Buffer.from(ephemeral.publicKey);
    const ephemeralPublicRaw = ephemeralPublic.subarray(ephemeralPublic.length - 32);
    return Buffer.concat([ephemeralPublicRaw, nonce, ciphertext, tag]).toString("base64url");
  }

  function flowKeyPair() {
    return generateKeyPairSync("x25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
  }

  describe("decryptMiMoCredential", () => {
    it("round-trips a credential through X25519 + AES-256-GCM", () => {
      const flow = flowKeyPair();
      const pk = Buffer.from(flow.publicKey).toString("base64url");
      const encoded = encryptForFlow(pk, {
        sk: "sk-mimo-123",
        uid: "user-1",
        url: "https://token-plan-sgp.xiaomimimo.com/v1",
      });
      expect(decryptMiMoCredential(flow.privateKey, encoded)).toEqual({
        apiKey: "sk-mimo-123",
        uid: "user-1",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      });
    });

    it("omits baseUrl when the flow does not return one", () => {
      const flow = flowKeyPair();
      const pk = Buffer.from(flow.publicKey).toString("base64url");
      const encoded = encryptForFlow(pk, { sk: "sk-x", uid: "u" });
      expect(decryptMiMoCredential(flow.privateKey, encoded)).toEqual({ apiKey: "sk-x", uid: "u" });
    });

    it("rejects a malformed (short) payload", () => {
      const flow = flowKeyPair();
      expect(() => decryptMiMoCredential(flow.privateKey, "AAAA")).toThrow(
        /Invalid MiMo callback payload/,
      );
    });

    it("rejects a payload that decrypts but carries no key", () => {
      const flow = flowKeyPair();
      const pk = Buffer.from(flow.publicKey).toString("base64url");
      const encoded = encryptForFlow(pk, { uid: "u" });
      expect(() => decryptMiMoCredential(flow.privateKey, encoded)).toThrow(
        /did not return a valid API key/,
      );
    });
  });

  describe("beginMiMoLoginFlow", () => {
    it("builds the documented authorize URL and resolves the key from the callback", async () => {
      const flow = await beginMiMoLoginFlow({
        platform: "https://platform.xiaomimimo.com",
        keyName: "reasonix-test",
      });
      try {
        const url = new URL(flow.url);
        expect(url.origin).toBe("https://platform.xiaomimimo.com");
        expect(url.pathname).toBe("/authorize");
        expect(url.searchParams.get("kn")).toBe("mimocode");
        expect(url.searchParams.get("key_name")).toBe("reasonix-test");
        const pk = url.searchParams.get("pk");
        const redirectUri = url.searchParams.get("redirect_uri");
        expect(pk).toBeTruthy();
        expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/$/);

        const encoded = encryptForFlow(pk as string, { sk: "sk-issued", uid: "acct-9" });
        const cb = await fetch(`${redirectUri}?u=${encodeURIComponent(encoded)}`, {
          redirect: "manual",
        });
        expect(cb.status).toBe(302);
        expect(cb.headers.get("location")).toContain("/authorize/callback?status=success");
        const cred = await flow.done;
        expect(cred.apiKey).toBe("sk-issued");
        expect(cred.uid).toBe("acct-9");
      } finally {
        flow.cancel();
      }
    });

    it("rejects on cancel", async () => {
      const flow = await beginMiMoLoginFlow({ platform: "https://platform.xiaomimimo.com" });
      flow.cancel();
      await expect(flow.done).rejects.toThrow(/cancelled/);
    });
  });
});

// MiMo subscription-usage adapter: console-cookie gated, defaults to
// *  `unsupported`, and never fabricates a percentage.
describe("mimo-quota", () => {
  const SESSION = { serviceToken: "svc-token", userId: "user-1" };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  describe("fetchMiMoQuota", () => {
    it("reports unsupported with no console session (never a fabricated number)", async () => {
      expect(await fetchMiMoQuota(undefined)).toEqual({
        status: "unsupported",
        source: "none",
        reason: "no-console-session",
      });
    });

    it("parses a console-reported percentage into an available quota (cookie auth)", async () => {
      let init: RequestInit | undefined;
      const fetchImpl = vi.fn(async (_url: unknown, i?: RequestInit) => {
        init = i;
        return jsonResponse({
          usedPercent: 30,
          resetsAt: "2026-11-01T00:00:00Z",
          plan: "Token Plan",
        });
      }) as unknown as typeof fetch;
      const q = await fetchMiMoQuota(SESSION, { fetchImpl });
      expect(q.status).toBe("available");
      expect(q.source).toBe("console");
      expect(q.usedPercent).toBe(30);
      expect(q.remainingPercent).toBe(70);
      expect(q.plan).toBe("Token Plan");
      const cookie = (init?.headers as Record<string, string>).Cookie;
      expect(cookie).toContain("api-platform_serviceToken=svc-token");
      expect(cookie).toContain("userId=user-1");
    });

    it("maps 401/403 to authentication_required", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("nope", { status: 401 }),
      ) as unknown as typeof fetch;
      expect((await fetchMiMoQuota(SESSION, { fetchImpl })).status).toBe("authentication_required");
    });

    it("maps other non-2xx responses to error", async () => {
      const fetchImpl = vi.fn(
        async () => new Response("boom", { status: 500 }),
      ) as unknown as typeof fetch;
      expect((await fetchMiMoQuota(SESSION, { fetchImpl })).status).toBe("error");
    });

    it("maps an empty payload to error rather than inventing a percentage", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
      const q = await fetchMiMoQuota(SESSION, { fetchImpl });
      expect(q.status).toBe("error");
      expect(q.remainingPercent).toBeUndefined();
    });

    it("maps a network failure to error", async () => {
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      expect((await fetchMiMoQuota(SESSION, { fetchImpl })).status).toBe("error");
    });
  });

  describe("readMiMoConsoleSession", () => {
    it("returns undefined without both env values", () => {
      process.env.MIMO_CONSOLE_TOKEN = "";
      process.env.MIMO_CONSOLE_USER_ID = "";
      expect(readMiMoConsoleSession()).toBeUndefined();
    });

    it("reads both env values when set", () => {
      process.env.MIMO_CONSOLE_TOKEN = "svc";
      process.env.MIMO_CONSOLE_USER_ID = "uid";
      try {
        expect(readMiMoConsoleSession()).toEqual({ serviceToken: "svc", userId: "uid" });
      } finally {
        process.env.MIMO_CONSOLE_TOKEN = "";
        process.env.MIMO_CONSOLE_USER_ID = "";
      }
    });
  });
});

describe("model-client", () => {
  const TEST_DIR = join(process.cwd(), ".tmp-test-model-client");
  const CONFIG_PATH = join(TEST_DIR, "config.json");

  describe("modelClientOptions — OpenCode credentials", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true });
      Reflect.deleteProperty(process.env, "OPENCODE_API_KEY");
      Reflect.deleteProperty(process.env, "MIMO_API_KEY");
      Reflect.deleteProperty(process.env, "MIMO_BASE_URL");
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      Reflect.deleteProperty(process.env, "OPENCODE_API_KEY");
      Reflect.deleteProperty(process.env, "MIMO_API_KEY");
      Reflect.deleteProperty(process.env, "MIMO_BASE_URL");
    });

    it("wires x-opencode-org-id to the stored session org for opencode models", async () => {
      saveOpencodeOAuth(
        {
          accessToken: "access-1",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
          orgId: "org-1",
        },
        CONFIG_PATH,
      );

      const opts = modelClientOptions({ model: "glm-5-free", configPath: CONFIG_PATH });
      expect(await opts.opencodeOrgResolver?.()).toBe("org-1");
    });

    it("leaves the org resolver undefined for non-opencode providers", () => {
      const opts = modelClientOptions({ model: "deepseek-v4-flash", configPath: CONFIG_PATH });
      expect(opts.opencodeOrgResolver).toBeUndefined();
    });

    it("prefers the Go service key over a Console OAuth session", async () => {
      saveOpencodeOAuth(
        {
          accessToken: "session-access",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
        CONFIG_PATH,
      );
      const cfg = readConfig(CONFIG_PATH);
      cfg.opencodeApiKey = "oc_sk_service_key";
      writeConfig(cfg, CONFIG_PATH);

      const opts = modelClientOptions({ model: "deepseek-v4.1-flash", configPath: CONFIG_PATH });
      expect(await opts.apiKeyResolver?.()).toBe("oc_sk_service_key");
    });

    it("falls back to the Console OAuth token when no service key is set", async () => {
      saveOpencodeOAuth(
        {
          accessToken: "session-access",
          refreshToken: "refresh-1",
          expiresAt: Date.now() + 60 * 60 * 1000,
        },
        CONFIG_PATH,
      );

      const opts = modelClientOptions({ model: "deepseek-v4.1-flash", configPath: CONFIG_PATH });
      expect(await opts.apiKeyResolver?.()).toBe("session-access");
    });

    it("routes mimo models to the standard client with the MiMo endpoint and key", () => {
      writeConfig(
        { mimoApiKey: "mimo-key", mimoBaseUrl: "https://mimo.example.com/v1" },
        CONFIG_PATH,
      );
      const opts = modelClientOptions({ model: "mimo-v2.6-pro", configPath: CONFIG_PATH });
      expect(opts.baseUrl).toBe("https://mimo.example.com/v1");
      expect(opts.apiKey).toBe("mimo-key");
      // MiMo requires its own key (no keyless fallback) and needs no special transport.
      expect(opts.allowMissingKey).toBe(false);
      expect(opts.transportResolver).toBeUndefined();
      expect(opts.geminiAuthResolver).toBeUndefined();
      expect(opts.opencodeOrgResolver).toBeUndefined();
    });
  });
});

describe("pick-primary-balance", () => {
  describe("pickPrimaryBalance — issue #724", () => {
    it("returns null for an empty list", () => {
      expect(pickPrimaryBalance([])).toBeNull();
    });

    it("picks the only entry when there is just one wallet", () => {
      const only: BalanceInfo = { currency: "CNY", total_balance: "0.47" };
      expect(pickPrimaryBalance([only])).toBe(only);
    });

    it("picks the largest top-up wallet when USD + CNY both exist (issue #724 case)", () => {
      const usd: BalanceInfo = {
        currency: "USD",
        total_balance: "4.99",
        topped_up_balance: "4.99",
      };
      const cny: BalanceInfo = {
        currency: "CNY",
        total_balance: "0.47",
        topped_up_balance: "0.47",
      };
      expect(pickPrimaryBalance([cny, usd])).toBe(usd);
      expect(pickPrimaryBalance([usd, cny])).toBe(usd);
    });

    it("keeps CNY when USD has zero balance", () => {
      const usd: BalanceInfo = { currency: "USD", total_balance: "0" };
      const cny: BalanceInfo = { currency: "CNY", total_balance: "50" };
      expect(pickPrimaryBalance([usd, cny])).toBe(cny);
    });

    it("breaks ties by keeping the first entry (stable)", () => {
      const a: BalanceInfo = { currency: "USD", total_balance: "5" };
      const b: BalanceInfo = { currency: "CNY", total_balance: "5" };
      expect(pickPrimaryBalance([a, b])).toBe(a);
    });
  });
});

describe("quota-failover", () => {
  /** The subagent failover acts on exactly this predicate. A child re-spawns its whole
   *  task, so it stays quota-only; the main turn recovers from any model failure. */
  describe("isQuotaExhaustedError", () => {
    const accepted: Array<[string, string]> = [
      ["402 payment required", 'DeepSeek 402: {"error":{"message":"Insufficient Balance"}}'],
      [
        "429 insufficient_quota",
        'OpenAI 429: {"error":{"message":"You exceeded your current quota","code":"insufficient_quota"}}',
      ],
      ["429 plain rate limit", 'OpenAI 429: {"error":{"message":"Rate limit reached for gpt-5"}}'],
      ["429 resource package", 'Z.AI 429: {"error":{"message":"no resource package available"}}'],
      [
        "429 Gemini free-tier",
        'Antigravity 429: {"error":{"message":"RESOURCE_EXHAUSTED: free usage limit reached"}}',
      ],
      [
        "403 exhausted balance",
        'Upstream 403: {"error":{"message":"Insufficient credits remaining"}}',
      ],
      [
        "400 quota on the stream path",
        'OpenCode 400: {"error":{"message":"weekly limit reached"}}',
      ],
      ["MiMo weekly limit", 'MiMo 429: {"error":{"message":"weekly limit exceeded"}}'],
      ["Experiential out of credits", 'Experiential 402: {"error":{"message":"out of credits"}}'],
    ];

    for (const [label, message] of accepted) {
      it(`fails over on ${label}`, () => {
        expect(isQuotaExhaustedError(new Error(message))).toBe(true);
      });
    }

    const rejected: Array<[string, string]> = [
      ["auth failure", 'DeepSeek 401: {"error":{"message":"Authentication Fails"}}'],
      ["plain 403", 'Upstream 403: {"error":{"message":"Forbidden"}}'],
      [
        "context overflow",
        'DeepSeek 400: {"error":{"message":"maximum context length is 131072 tokens"}}',
      ],
      [
        "bare upstream refusal",
        "OpenCode 400: upstream request failed: [invalid_request_error] request could not be processed",
      ],
      ["provider 5xx", "OpenAI 500: internal server error"],
      ["network failure", "fetch failed"],
      ["unbranded error", "boom"],
      ["empty message", ""],
    ];

    for (const [label, message] of rejected) {
      it(`does NOT fail over on ${label}`, () => {
        expect(isQuotaExhaustedError(new Error(message))).toBe(false);
      });
    }

    it("accepts a raw message string as well as an Error", () => {
      expect(isQuotaExhaustedError('OpenAI 429: {"error":{"message":"insufficient_quota"}}')).toBe(
        true,
      );
      expect(isQuotaExhaustedError("fetch failed")).toBe(false);
    });

    it("tolerates non-error values", () => {
      expect(isQuotaExhaustedError(undefined)).toBe(false);
      expect(isQuotaExhaustedError({ message: "DeepSeek 402: nope" })).toBe(false);
    });
  });
});

describe("proxy", () => {
  describe("detectProxyUrl (issue #646)", () => {
    it("returns null when no proxy env var is set", () => {
      expect(detectProxyUrl({})).toBeNull();
    });

    it("returns null when the proxy var is whitespace only", () => {
      expect(detectProxyUrl({ HTTPS_PROXY: "   " })).toBeNull();
    });

    it("HTTPS_PROXY wins over HTTP_PROXY (curl-style precedence)", () => {
      expect(
        detectProxyUrl({
          HTTPS_PROXY: "http://https.example:8080",
          HTTP_PROXY: "http://http.example:8080",
        }),
      ).toBe("http://https.example:8080");
    });

    it("falls back to HTTP_PROXY when HTTPS_PROXY is absent", () => {
      expect(detectProxyUrl({ HTTP_PROXY: "http://http.example:8080" })).toBe(
        "http://http.example:8080",
      );
    });

    it("falls back to ALL_PROXY last", () => {
      expect(detectProxyUrl({ ALL_PROXY: "socks5://proxy.example:1080" })).toBe(
        "socks5://proxy.example:1080",
      );
    });

    it("upper-case wins over lower-case for the same family (HTTPS_PROXY beats https_proxy)", () => {
      expect(
        detectProxyUrl({
          HTTPS_PROXY: "http://upper.example:8080",
          https_proxy: "http://lower.example:8080",
        }),
      ).toBe("http://upper.example:8080");
    });

    it("uses lower-case https_proxy when upper-case isn't set", () => {
      expect(detectProxyUrl({ https_proxy: "http://lower.example:8080" })).toBe(
        "http://lower.example:8080",
      );
    });

    it("trims surrounding whitespace", () => {
      expect(detectProxyUrl({ HTTPS_PROXY: "  http://example:8080  " })).toBe(
        "http://example:8080",
      );
    });
  });

  describe("detectNoProxyRaw", () => {
    it("returns null when neither NO_PROXY nor no_proxy is set", () => {
      expect(detectNoProxyRaw({})).toBeNull();
    });

    it("uppercase NO_PROXY wins over lowercase", () => {
      expect(detectNoProxyRaw({ NO_PROXY: "a.com", no_proxy: "b.com" })).toBe("a.com");
    });

    it("falls back to lowercase no_proxy", () => {
      expect(detectNoProxyRaw({ no_proxy: "b.com" })).toBe("b.com");
    });
  });

  describe("parseNoProxy + matchesNoProxy", () => {
    it("returns [] for empty / null input", () => {
      expect(parseNoProxy(null)).toEqual([]);
      expect(parseNoProxy("")).toEqual([]);
      expect(parseNoProxy("   ")).toEqual([]);
    });

    it("`*` matches every host", () => {
      const p = parseNoProxy("*");
      expect(matchesNoProxy("api.deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("anything.example", p)).toBe(true);
    });

    it("bare hostname matches exact + dot-prefixed subdomain (curl compat)", () => {
      const p = parseNoProxy("deepseek.com");
      expect(matchesNoProxy("deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("api.deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("notdeepseek.com", p)).toBe(false);
    });

    it("`.suffix` matches subdomains only, NOT the bare apex", () => {
      const p = parseNoProxy(".deepseek.com");
      expect(matchesNoProxy("api.deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("deepseek.com", p)).toBe(false);
    });

    it("`*.suffix` matches subdomains AND apex", () => {
      const p = parseNoProxy("*.deepseek.com");
      expect(matchesNoProxy("api.deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("deepseek.com", p)).toBe(true);
      expect(matchesNoProxy("nondeepseek.com", p)).toBe(false);
    });

    it("case-insensitive matching", () => {
      const p = parseNoProxy("DEEPSEEK.COM");
      expect(matchesNoProxy("api.DeepSeek.com", p)).toBe(true);
    });

    it("strips `:port` suffix when present", () => {
      const p = parseNoProxy("api.deepseek.com:443");
      expect(matchesNoProxy("api.deepseek.com", p)).toBe(true);
    });

    it("comma-separated entries are merged", () => {
      const p = parseNoProxy("a.com, .b.com, *.c.com, 127.0.0.1");
      expect(matchesNoProxy("a.com", p)).toBe(true);
      expect(matchesNoProxy("foo.a.com", p)).toBe(true);
      expect(matchesNoProxy("foo.b.com", p)).toBe(true);
      expect(matchesNoProxy("b.com", p)).toBe(false);
      expect(matchesNoProxy("c.com", p)).toBe(true);
      expect(matchesNoProxy("127.0.0.1", p)).toBe(true);
      expect(matchesNoProxy("128.0.0.1", p)).toBe(false);
    });

    it("ignores blank entries between commas", () => {
      const p = parseNoProxy(",, foo.com , ,");
      expect(p).toHaveLength(1);
      expect(matchesNoProxy("foo.com", p)).toBe(true);
    });
  });

  describe("installProxyIfConfigured", () => {
    let writes: string[];
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      _resetForTests();
      writes = [];
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
        chunk: string | Uint8Array,
      ): boolean => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
      }) as typeof process.stderr.write);
    });
    afterEach(() => {
      stderrSpy.mockRestore();
      _resetForTests();
    });

    it("returns null when no proxy is configured (no global dispatcher change)", () => {
      expect(installProxyIfConfigured({})).toBeNull();
    });

    it("returns url + reinstalled=false + default NO_PROXY patterns on first install", () => {
      const result = installProxyIfConfigured({ HTTPS_PROXY: "http://example:8080" });
      expect(result?.url).toBe("http://example:8080/");
      expect(result?.reinstalled).toBe(false);
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      for (const expected of DEFAULT_NO_PROXY) {
        expect(raws).toContain(expected);
      }
    });

    it("merges user NO_PROXY entries onto the default whitelist", () => {
      const result = installProxyIfConfigured({
        HTTPS_PROXY: "http://example:8080",
        NO_PROXY: "internal.corp.example, .private.lan",
      });
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      expect(raws).toContain("api.deepseek.com");
      expect(raws).toContain("internal.corp.example");
      expect(raws).toContain(".private.lan");
    });

    it("layers REASONIX_NO_PROXY on top of system NO_PROXY (app-specific override)", () => {
      const result = installProxyIfConfigured({
        HTTPS_PROXY: "http://example:8080",
        NO_PROXY: "system.corp.example",
        REASONIX_NO_PROXY: "app.specific.example, .reasonix.lan",
      });
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      expect(raws).toContain("system.corp.example");
      expect(raws).toContain("app.specific.example");
      expect(raws).toContain(".reasonix.lan");
    });

    it("layers opts.extraNoProxy (config) on top of env-derived patterns", () => {
      const result = installProxyIfConfigured(
        { HTTPS_PROXY: "http://example:8080", NO_PROXY: "env.example" },
        { extraNoProxy: ["config.example", ".workspace.lan"] },
      );
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      expect(raws).toContain("env.example");
      expect(raws).toContain("config.example");
      expect(raws).toContain(".workspace.lan");
    });

    it("opts.disabled short-circuits — no install, no log", () => {
      const result = installProxyIfConfigured(
        { HTTPS_PROXY: "http://example:8080" },
        { disabled: true },
      );
      expect(result).toBeNull();
      expect(writes.join("")).not.toMatch(/\[proxy\]/);
    });

    it("logs the proxy decision to stderr at startup", () => {
      installProxyIfConfigured({ HTTPS_PROXY: "http://example:8080" });
      expect(writes.join("")).toMatch(/\[proxy\] using http:\/\/example:8080\//);
      expect(writes.join("")).toMatch(/NO_PROXY: .*api\.deepseek\.com/);
    });

    it("bypassDeepSeekDirect=false drops api.deepseek.com from the install-time NO_PROXY list (#1497)", () => {
      const result = installProxyIfConfigured(
        { HTTPS_PROXY: "http://example:8080" },
        { bypassDeepSeekDirect: false },
      );
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      expect(raws).not.toContain("api.deepseek.com");
      expect(raws).not.toContain("*.deepseek.com");
      expect(raws).toContain("localhost");
    });

    it("env REASONIX_PROXY_DEEPSEEK_DIRECT=0 drops deepseek even without config override (#1497)", () => {
      const result = installProxyIfConfigured({
        HTTPS_PROXY: "http://example:8080",
        REASONIX_PROXY_DEEPSEEK_DIRECT: "0",
      });
      const raws = result?.noProxy.map((p) => p.raw) ?? [];
      expect(raws).not.toContain("api.deepseek.com");
      expect(raws).toContain("127.0.0.1");
    });

    it("returns reinstalled=true on subsequent installs", () => {
      installProxyIfConfigured({ HTTPS_PROXY: "http://first:8080" });
      const second = installProxyIfConfigured({ HTTPS_PROXY: "http://second:8080" });
      expect(second?.reinstalled).toBe(true);
      expect(second?.url).toBe("http://second:8080/");
    });

    it("auto-prefixes http:// for bare host:port (issue #1034)", () => {
      const result = installProxyIfConfigured({ HTTPS_PROXY: "127.0.0.1:10888" });
      expect(result?.url).toBe("http://127.0.0.1:10888/");
    });

    it("does not throw on a malformed env value — warns to stderr and returns null", () => {
      expect(installProxyIfConfigured({ HTTPS_PROXY: "http://[invalid:::" })).toBeNull();
      expect(writes.join("")).toMatch(/ignoring proxy env value/);
    });

    it("opts.url (cfg.proxy.url) installs even when no env var is set — source=config (#1868)", () => {
      const result = installProxyIfConfigured({}, { url: "http://127.0.0.1:7897" });
      expect(result?.url).toBe("http://127.0.0.1:7897/");
      expect(result?.source).toBe("config");
      expect(writes.join("")).toMatch(/source: config/);
    });

    it("opts.url wins over HTTPS_PROXY env var (config beats env, #1868)", () => {
      const result = installProxyIfConfigured(
        { HTTPS_PROXY: "http://env.example:8080" },
        { url: "http://cfg.example:7897" },
      );
      expect(result?.url).toBe("http://cfg.example:7897/");
      expect(result?.source).toBe("config");
    });

    it("opts.url is normalized like env values (bare host:port → http://, #1868)", () => {
      const result = installProxyIfConfigured({}, { url: "127.0.0.1:7897" });
      expect(result?.url).toBe("http://127.0.0.1:7897/");
    });

    it("malformed opts.url is rejected with a config-flavored warning, not env (#1868)", () => {
      const result = installProxyIfConfigured({}, { url: "http://[invalid:::" });
      expect(result).toBeNull();
      expect(writes.join("")).toMatch(/ignoring proxy config value/);
    });

    it("whitespace-only opts.url falls back to env detection", () => {
      const result = installProxyIfConfigured(
        { HTTPS_PROXY: "http://env.example:8080" },
        { url: "   " },
      );
      expect(result?.url).toBe("http://env.example:8080/");
      expect(result?.source).toBe("env");
    });

    it("redacts credentials from stderr log when proxy includes auth", () => {
      installProxyIfConfigured({ HTTPS_PROXY: "http://alice:secret_password@proxy.example:8080" });
      const log = writes.join("");
      expect(log).toContain("[proxy] using");
      expect(log).toContain("REDACTED:REDACTED@proxy.example:8080");
      expect(log).not.toContain("secret_password");
      expect(log).not.toContain("alice");
    });
  });

  describe("redactProxyUrl", () => {
    it("masks username and password in proxy URL", () => {
      expect(redactProxyUrl("http://user:pass@proxy.example:8080")).toBe(
        "http://REDACTED:REDACTED@proxy.example:8080/",
      );
    });

    it("leaves URL without credentials untouched", () => {
      expect(redactProxyUrl("http://proxy.example:8080")).toBe("http://proxy.example:8080");
    });

    it("handles malformed URLs safely", () => {
      expect(redactProxyUrl("not a url")).toBe("not a url");
    });
  });

  describe("resolveNoProxy", () => {
    it("returns just defaults when no env vars or extra patterns are set", () => {
      const r = resolveNoProxy({});
      expect(r.defaults).toHaveLength(DEFAULT_NO_PROXY.length);
      expect(r.envSystem).toHaveLength(0);
      expect(r.envReasonix).toHaveLength(0);
      expect(r.extra).toHaveLength(0);
      expect(r.all.length).toBe(DEFAULT_NO_PROXY.length);
    });

    it("partitions patterns by source (defaults / env / REASONIX / extra)", () => {
      const r = resolveNoProxy(
        { NO_PROXY: "system.example", REASONIX_NO_PROXY: "app.example" },
        { extraNoProxy: ["config.example"] },
      );
      expect(r.defaults.map((p) => p.raw)).toContain("api.deepseek.com");
      expect(r.envSystem.map((p) => p.raw)).toEqual(["system.example"]);
      expect(r.envReasonix.map((p) => p.raw)).toEqual(["app.example"]);
      expect(r.extra.map((p) => p.raw)).toEqual(["config.example"]);
      expect(r.all.map((p) => p.raw)).toEqual([
        ...r.defaults.map((p) => p.raw),
        "system.example",
        "app.example",
        "config.example",
      ]);
    });

    it("api.deepseek.com matches the resolved list by default", () => {
      const r = resolveNoProxy({}, {});
      expect(matchesNoProxy("api.deepseek.com", r.all)).toBe(true);
    });

    it("config bypassDeepSeekDirect=false drops the DeepSeek bypass but keeps loopback (#1497)", () => {
      const r = resolveNoProxy({}, { bypassDeepSeekDirect: false });
      expect(matchesNoProxy("api.deepseek.com", r.all)).toBe(false);
      expect(matchesNoProxy("sub.deepseek.com", r.all)).toBe(false);
      expect(matchesNoProxy("localhost", r.all)).toBe(true);
      expect(matchesNoProxy("127.0.0.1", r.all)).toBe(true);
    });

    it("env REASONIX_PROXY_DEEPSEEK_DIRECT=0 drops the DeepSeek bypass (#1497)", () => {
      const r = resolveNoProxy({ REASONIX_PROXY_DEEPSEEK_DIRECT: "0" }, {});
      expect(matchesNoProxy("api.deepseek.com", r.all)).toBe(false);
      expect(matchesNoProxy("127.0.0.1", r.all)).toBe(true);
    });

    it("env REASONIX_PROXY_DEEPSEEK_DIRECT wins over config when set", () => {
      const r = resolveNoProxy(
        { REASONIX_PROXY_DEEPSEEK_DIRECT: "1" },
        { bypassDeepSeekDirect: false },
      );
      expect(matchesNoProxy("api.deepseek.com", r.all)).toBe(true);
    });
  });

  describe("resolveBypassDeepSeekDirect (#1497)", () => {
    it("defaults to true when neither env nor config is set", () => {
      expect(resolveBypassDeepSeekDirect({}, undefined)).toBe(true);
    });

    it("returns false when config is false and env is unset", () => {
      expect(resolveBypassDeepSeekDirect({}, false)).toBe(false);
    });

    it("env false-y values flip the default off", () => {
      for (const v of ["0", "false", "no", "off", "FALSE", "Off"]) {
        expect(resolveBypassDeepSeekDirect({ REASONIX_PROXY_DEEPSEEK_DIRECT: v }, undefined)).toBe(
          false,
        );
      }
    });

    it("env truthy values force the bypass back on (override config false)", () => {
      for (const v of ["1", "true", "yes", "on", "TRUE", "Yes"]) {
        expect(resolveBypassDeepSeekDirect({ REASONIX_PROXY_DEEPSEEK_DIRECT: v }, false)).toBe(
          true,
        );
      }
    });

    it("unrecognized env values fall through to config", () => {
      expect(resolveBypassDeepSeekDirect({ REASONIX_PROXY_DEEPSEEK_DIRECT: "maybe" }, false)).toBe(
        false,
      );
      expect(
        resolveBypassDeepSeekDirect({ REASONIX_PROXY_DEEPSEEK_DIRECT: "maybe" }, undefined),
      ).toBe(true);
    });
  });

  describe("normalizeProxyUrl (issue #1034)", () => {
    it("returns null for empty / whitespace input", () => {
      expect(normalizeProxyUrl("")).toBeNull();
      expect(normalizeProxyUrl("   ")).toBeNull();
    });

    it("auto-prefixes http:// when the scheme is missing", () => {
      expect(normalizeProxyUrl("127.0.0.1:10888")).toBe("http://127.0.0.1:10888/");
      expect(normalizeProxyUrl("proxy.example:8080")).toBe("http://proxy.example:8080/");
    });

    it("leaves an already-prefixed URL intact", () => {
      expect(normalizeProxyUrl("http://example:8080")).toBe("http://example:8080/");
      expect(normalizeProxyUrl("socks5://example:1080")).toBe("socks5://example:1080");
    });

    it("returns null for unparseable values", () => {
      expect(normalizeProxyUrl("http://[invalid:::")).toBeNull();
    });
  });
});

describe("codex quota payload", () => {
  // Captured live from `chatgpt.com/backend-api/wham/usage` for an account whose
  // 5-hour window is spent. The weekly percentage stays high, so only the payload's
  // own limit verdict says the plan is blocked.
  const SPENT_FIVE_HOUR = {
    plan_type: "plus",
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 100,
        limit_window_seconds: 18000,
        reset_after_seconds: 16562,
        reset_at: 1792655726,
      },
      secondary_window: {
        used_percent: 65,
        limit_window_seconds: 604800,
        reset_after_seconds: 446407,
        reset_at: 1793085571,
      },
    },
    rate_limit_reached_type: { type: "rate_limit_reached", details: "default" },
  };

  it("identifies the windows by length and carries the limit verdict", () => {
    const quota = parseCodexQuotaPayload(SPENT_FIVE_HOUR);
    expect(quota?.plan).toBe("plus");
    expect(quota?.fiveHour).toMatchObject({ windowMinutes: 300, remainingPercent: 0 });
    expect(quota?.weekly).toMatchObject({ windowMinutes: 10080, remainingPercent: 35 });
    expect(quota?.limitReached).toBe(true);
  });

  it("reads an unblocked payload as not limited", () => {
    const quota = parseCodexQuotaPayload({
      ...SPENT_FIVE_HOUR,
      rate_limit: {
        ...SPENT_FIVE_HOUR.rate_limit,
        allowed: true,
        limit_reached: false,
        primary_window: { ...SPENT_FIVE_HOUR.rate_limit.primary_window, used_percent: 12 },
      },
      rate_limit_reached_type: undefined,
    });
    expect(quota?.limitReached).toBe(false);
    expect(quota?.fiveHour?.remainingPercent).toBe(88);
  });

  it("accepts the nested envelope and the camelCase legacy window shape", () => {
    const quota = parseCodexQuotaPayload({
      rate_limits: {
        plan_type: "pro",
        rate_limit: {
          primaryWindow: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1792655726 },
          secondaryWindow: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null },
        },
      },
    });
    expect(quota?.plan).toBe("pro");
    expect(quota?.fiveHour?.remainingPercent).toBe(0);
    expect(quota?.weekly?.remainingPercent).toBe(80);
    // No limit flag in this shape: absence is "not reported", never "limited".
    expect(quota?.limitReached).toBe(false);
  });

  it("matches a bucket that reports a length a minute off its label", () => {
    // The server reports seconds and we round to minutes, so an exact equality would
    // drop the bucket and leave the chip with no 5-hour number at all.
    const quota = parseCodexQuotaPayload({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 100, limit_window_seconds: 17940 }, // 299 min
        secondary_window: { used_percent: 10, limit_window_seconds: 608400 }, // 10140 min
      },
    });
    expect(quota?.fiveHour?.remainingPercent).toBe(0);
    expect(quota?.weekly?.remainingPercent).toBe(90);
  });

  it("ignores a bucket that is neither window", () => {
    const quota = parseCodexQuotaPayload({
      rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 3600 } },
    });
    expect(quota).not.toBeNull();
    expect(quota?.fiveHour).toBeNull();
    expect(quota?.weekly).toBeNull();
  });

  it("reads the limit marker whether the payload spells it as a string or an object", () => {
    const window = { used_percent: 100, limit_window_seconds: 18000 };
    const withString = parseCodexQuotaPayload({
      rate_limit: {
        allowed: true,
        rate_limit_reached_type: "rate_limit_reached",
        primary_window: window,
      },
    });
    expect(withString?.limitReached).toBe(true);
    // `allowed: false` alone still counts: the server accepted nothing.
    const refused = parseCodexQuotaPayload({
      rate_limit: { allowed: false, primary_window: window },
    });
    expect(refused?.limitReached).toBe(true);
  });
});
