import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, saveOpencodeOAuth, writeConfig } from "../src/config.js";
import { modelClientOptions } from "../src/model-client.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-model-client");
const CONFIG_PATH = join(TEST_DIR, "config.json");

describe("modelClientOptions — OpenCode credentials", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    Reflect.deleteProperty(process.env, "OPENCODE_API_KEY");
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    Reflect.deleteProperty(process.env, "OPENCODE_API_KEY");
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
});
