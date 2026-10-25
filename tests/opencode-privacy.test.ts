/** Guards that OpenCode credentials and request identity never reach durable storage. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetOpencodeOAuth,
  opencodeOAuthSession,
  rememberOpencodeOAuth,
} from "../src/opencode-session.js";

const read = (relative: string): string => readFileSync(join(process.cwd(), relative), "utf8");

describe("opencode session store", () => {
  afterEach(() => {
    forgetOpencodeOAuth();
  });

  it("holds credentials only in memory", () => {
    expect(opencodeOAuthSession()).toBeUndefined();
    rememberOpencodeOAuth({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 1000 });
    expect(opencodeOAuthSession()?.accessToken).toBe("a");
    forgetOpencodeOAuth();
    expect(opencodeOAuthSession()).toBeUndefined();
  });

  it("imports no filesystem API", () => {
    const source = read("src/opencode-session.ts");
    expect(source).not.toMatch(/node:fs|writeFileSync|readFileSync/);
  });
});

describe("durable surfaces", () => {
  it("never dumps a request body to disk", () => {
    expect(read("src/client.ts")).not.toContain("opencode-error-request.json");
  });

  it("keeps auth and org values out of diagnostics", () => {
    const source = read("src/client.ts");
    expect(source).not.toContain("orgHeader");
    expect(source).not.toContain("authPrefix");
  });

  it("writes no opencode token through the config layer", () => {
    const source = read("src/config.ts");
    expect(source).not.toContain("cfg.opencodeOAuth =");
    expect(source).toContain("purgeOpencodeOAuth");
  });

  it("takes request identity from the single process-wide accessor", () => {
    const source = read("src/client.ts");
    expect(source).not.toContain("createOpencodeIdentity");
    expect(source).toContain("rotateOpencodeIdentity");
  });
});
