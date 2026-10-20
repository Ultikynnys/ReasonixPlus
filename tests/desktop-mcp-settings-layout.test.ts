import { describe, expect, it } from "vitest";
import { cssRule } from "./support/css.js";

describe("desktop MCP settings layout", () => {
  it("keeps long MCP specs inside the card instead of widening the modal", () => {
    expect(cssRule(".scard .mcp-spec-body")).toContain("min-width: 0");
    expect(cssRule(".scard .mcp-spec-body")).toContain("flex: 1 1 auto");
    expect(cssRule(".scard .mcp-spec-summary")).toContain("overflow-wrap: anywhere");
    expect(cssRule(".scard .mcp-spec-summary")).toContain("word-break: break-word");
    expect(cssRule(".scard .mcp-remove")).toContain("flex: 0 0 auto");
  });
});
