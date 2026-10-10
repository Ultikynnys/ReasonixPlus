import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveOpencodeOAuth } from "../src/config.js";
import { modelClientOptions } from "../src/model-client.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-model-client");
const CONFIG_PATH = join(TEST_DIR, "config.json");

describe("modelClientOptions — OpenCode Console session org", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
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
});
