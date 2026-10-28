import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailProvider } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearGmailOAuth,
  clearMcpOAuth,
  readConfig,
  saveGmailOAuth,
  saveMailProvider,
  saveMcpOAuth,
} from "../src/config.js";
import { mcpCreds } from "./support/oauth-fixture.js";

describe("managed mail provider config", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-mail-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the selected provider enum value", () => {
    saveMailProvider(MailProvider.Gmail, path);
    expect(readConfig(path).mailProvider).toBe("gmail");
    saveMailProvider(MailProvider.Outlook, path);
    expect(readConfig(path).mailProvider).toBe("outlook");
  });

  it("drops an unrecognized provider id during sanitization", () => {
    writeFileSync(path, JSON.stringify({ mailProvider: "hotmail" }));
    expect(readConfig(path).mailProvider).toBeUndefined();
  });

  it("round-trips Gmail OAuth credentials and clears them independently", () => {
    saveGmailOAuth(
      {
        clientId: "id.apps.googleusercontent.com",
        clientSecret: "shh",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
        account: "ada@gmail.com",
      },
      path,
    );
    expect(readConfig(path).gmailOAuth?.account).toBe("ada@gmail.com");
    clearGmailOAuth(path);
    expect(readConfig(path).gmailOAuth).toBeUndefined();
  });
});

describe("MCP server sign-in store", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-mcp-oauth-"));
    path = join(dir, "config.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const creds = mcpCreds({
    accessToken: "at-1",
    refreshToken: "rt-1",
    scope: "mcp",
    resource: "https://notfair.co/api/mcp/notfair",
    account: "ada@example.com",
  });

  it("keeps one entry per server name and replaces a re-connect", () => {
    saveMcpOAuth("notfair", creds, path);
    saveMcpOAuth("notfair", { ...creds, accessToken: "at-2" }, path);
    saveMcpOAuth("other", creds, path);
    expect(readConfig(path).mcpOAuth?.notfair?.accessToken).toBe("at-2");
    expect(Object.keys(readConfig(path).mcpOAuth ?? {})).toEqual(["notfair", "other"]);
  });

  it("survives a rewrite of the server entry itself", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          notfair: { type: "http", url: "https://notfair.co/api/mcp/notfair", plugin: "notfair" },
        },
        mcpOAuth: { notfair: creds },
      }),
    );
    expect(readConfig(path).mcpOAuth?.notfair?.resource).toBe(creds.resource);
  });

  it("clears one server without touching the others", () => {
    saveMcpOAuth("notfair", creds, path);
    saveMcpOAuth("other", creds, path);
    expect(clearMcpOAuth("notfair", path)).toBe(true);
    expect(readConfig(path).mcpOAuth?.notfair).toBeUndefined();
    expect(readConfig(path).mcpOAuth?.other?.accessToken).toBe("at-1");
    expect(clearMcpOAuth("notfair", path)).toBe(false);
  });

  it("drops an entry that cannot be refreshed", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpOAuth: {
          good: creds,
          noToken: { ...creds, accessToken: "" },
          noEndpoint: { ...creds, tokenEndpoint: undefined },
          noClient: { ...creds, clientId: 5 },
        },
      }),
    );
    expect(Object.keys(readConfig(path).mcpOAuth ?? {})).toEqual(["good"]);
  });
});
