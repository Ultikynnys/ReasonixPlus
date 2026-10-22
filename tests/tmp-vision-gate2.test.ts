import { describe, expect, it } from "vitest";

import { modelAcceptsImages } from "../packages/core-utils/src/models.js";

describe("experiential vision gate, real catalog ids", () => {
  it("prints the verdict for ids the gateway actually serves", () => {
    const ids = [
      "experiential/deepseek-v4.1-flash-1017",
      "experiential/claude-opus-5",
      "experiential/claude-fable-5",
      "experiential/gemini-3.5-flash",
      "experiential/gpt-6-luna",
      "experiential/glm-5v-turbo",
      "experiential/qwen3.8-27b",
      "experiential/mimo-v2.6-pro",
    ];
    for (const id of ids) console.log(id.padEnd(42), modelAcceptsImages(id));
    expect(ids.length).toBe(8);
  });
});
