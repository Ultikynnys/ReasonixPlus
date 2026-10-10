import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_GO_USAGE_URL,
  fetchOpencodeQuota,
  opencodeUsageUrl,
} from "../src/opencode-quota.js";

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
    expect(OPENCODE_GO_USAGE_URL).toBe("https://opencode.ai/zen/go/v1/usage");
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
