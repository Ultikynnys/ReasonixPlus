import { describe, expect, it } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { makeFakeClient } from "./support/fake-client.js";

function makeLoop(model = "deepseek-reasoner") {
  return new CacheFirstLoop({
    client: makeFakeClient([{ content: "ok" }]).client,
    prefix: new ImmutablePrefix({ system: "s" }),
    model,
    stream: false,
  });
}

describe("reasoning survives a conversation replacement", () => {
  it("carries each turn's prior reasoning across a replace", () => {
    const loop = makeLoop();
    loop.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", reasoning_content: "kept thinking" },
    ]);
    loop.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);

    const assistant = loop.log.toMessages().find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("kept thinking");
  });

  it("backfills empty reasoning on a new turn for a thinking model", () => {
    const loop = makeLoop();
    loop.replaceConversation("s", [
      { role: "user", content: "q" },
      { role: "assistant", content: "brand new" },
    ]);

    const assistant = loop.log.toMessages().find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("");
  });
});
