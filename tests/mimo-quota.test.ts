/** MiMo subscription-usage adapter: console-cookie gated, defaults to
 *  `unsupported`, and never fabricates a percentage. */

import { describe, expect, it, vi } from "vitest";
import { fetchMiMoQuota, readMiMoConsoleSession } from "../src/mimo-quota.js";

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
