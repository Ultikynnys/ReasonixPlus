/** Context-overflow classification for servers that word the refusal their own way. */

import { describe, expect, it } from "vitest";
import {
  formatLoopError,
  isContextOverflowError,
  parseAvailableContextTokens,
} from "../src/loop/errors.js";

/** Captured verbatim from llama-server b11669 rejecting a 45,052-token request. */
const LLAMA_BODY =
  '{"error":{"code":400,"message":"request (45052 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":45052,"n_ctx":32768}}';
const LLAMA_MESSAGE =
  "request (45052 tokens) exceeds the available context size (32768 tokens), try increasing it";

describe("isContextOverflowError", () => {
  it("classifies llama.cpp's context-size refusal", () => {
    expect(isContextOverflowError(LLAMA_MESSAGE)).toBe(true);
    expect(isContextOverflowError(LLAMA_BODY)).toBe(true);
    expect(isContextOverflowError(new Error(`Upstream 400: ${LLAMA_BODY}`))).toBe(true);
  });

  it("keeps the existing provider phrasings", () => {
    expect(isContextOverflowError("Upstream 400: maximum context length exceeded")).toBe(true);
    expect(isContextOverflowError("prompt too long for this model")).toBe(true);
  });

  it("does not classify an unrelated 400", () => {
    expect(
      isContextOverflowError('Upstream 400: {"error":{"message":"Unsupported parameter: tools"}}'),
    ).toBe(false);
  });
});

describe("parseAvailableContextTokens", () => {
  it("reads the window a llama.cpp refusal states", () => {
    expect(parseAvailableContextTokens(LLAMA_MESSAGE)).toBe(32_768);
    expect(parseAvailableContextTokens(LLAMA_BODY)).toBe(32_768);
  });

  it("reads an OpenAI-style window", () => {
    expect(
      parseAvailableContextTokens(
        "This model's maximum context length is 8192 tokens, however you requested 9000 tokens",
      ),
    ).toBe(8_192);
  });

  it("falls through to a later phrasing when an earlier one has no usable number", () => {
    expect(
      parseAvailableContextTokens(
        "available context size (unknown), maximum context length is 8192 tokens",
      ),
    ).toBe(8_192);
  });

  it("returns undefined when the refusal names no window", () => {
    expect(parseAvailableContextTokens("prompt too long")).toBeUndefined();
    expect(parseAvailableContextTokens(new Error(""))).toBeUndefined();
  });
});

describe("formatLoopError", () => {
  it("reports the rejected request size for a llama.cpp overflow", () => {
    const formatted = formatLoopError(new Error(`Upstream 400: ${LLAMA_BODY}`));
    expect(formatted).toContain("45,052 tokens");
  });
});
