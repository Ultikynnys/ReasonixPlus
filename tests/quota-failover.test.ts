import { describe, expect, it } from "vitest";
import { isQuotaExhaustedError } from "../src/loop/errors.js";

/** The failover acts on exactly this predicate: true means "the same model cannot
 *  get past this, try the next one". False positives reroute healthy requests. */
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
    ["400 quota on the stream path", 'OpenCode 400: {"error":{"message":"weekly limit reached"}}'],
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
