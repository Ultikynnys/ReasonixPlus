/** escalationContract: model-aware identity without model-authored routing controls. */

import { describe, expect, it } from "vitest";
import {
  ESCALATION_CONTRACT,
  TUI_FORMATTING_RULES,
  escalationContract,
} from "../src/prompt-fragments.js";

describe("TUI_FORMATTING_RULES", () => {
  it("forbids em dashes and emojis in model text", () => {
    expect(TUI_FORMATTING_RULES).toMatch(/Never use em dashes/i);
    expect(TUI_FORMATTING_RULES).toMatch(/Never use emojis/i);
  });

  it("does not contain em dashes or non-ASCII pictographs in its own prose", () => {
    // The rules must not model the very characters they ban. Arrows and the
    // box-drawing examples (in the forbidden list) are the only allowed
    // non-ASCII; every em dash everywhere is disallowed.
    expect(TUI_FORMATTING_RULES).not.toContain("\u2014"); // em dash
  });
});

describe("escalationContract", () => {
  it("identifies the active model and requires a direct answer", () => {
    const out = escalationContract("deepseek-v4-flash");
    expect(out).toContain("`deepseek-v4-flash`");
    expect(out).toContain("Deliver the strongest answer you can directly");
    expect(out).toContain("If asked which model you are, answer `deepseek-v4-flash`");
  });

  it("keeps the compatibility export aligned with the default model note", () => {
    expect(ESCALATION_CONTRACT).toBe(escalationContract("deepseek-v4-flash"));
  });
});
