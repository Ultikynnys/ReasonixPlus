/** Guards at the bridge seam: provenance, budget deferral, and the bookkeeping both leave behind. */

import { describe, expect, it, vi } from "vitest";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";

function fakeClient(tools: McpTool[]): Parameters<typeof bridgeMcpTools>[0] {
  const fake = {
    listTools: async () => ({ tools }),
    callTool: async (name: string): Promise<CallToolResult> => ({
      content: [{ type: "text", text: `ran ${name}` }],
    }),
  };
  return fake as unknown as Parameters<typeof bridgeMcpTools>[0];
}

function tool(name: string): McpTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}

describe("bridge provenance", () => {
  it("records the server origin on each bridged tool", async () => {
    const { registry } = await bridgeMcpTools(fakeClient([tool("ping")]), {
      namePrefix: "srv_",
      serverName: "srv",
    });
    expect(registry.get("srv_ping")?.origin).toBe("mcp:srv");
  });

  it("honors an explicit origin override", async () => {
    const { registry } = await bridgeMcpTools(fakeClient([tool("ping")]), {
      namePrefix: "srv_",
      serverName: "srv",
      origin: "custom:origin",
    });
    expect(registry.get("srv_ping")?.origin).toBe("custom:origin");
  });

  it("refuses a wire name a built-in already owns, and reports it", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const registry = new ToolRegistry();
      registry.register({
        name: "web_search",
        description: "built-in search",
        fn: () => "builtin",
      });
      const result = await bridgeMcpTools(fakeClient([tool("search")]), {
        namePrefix: "web_",
        serverName: "web",
        registry,
      });
      // A server named "web" exposing "search" would have shadowed web_search.
      expect(result.registeredNames).toEqual([]);
      expect(registry.get("web_search")?.description).toBe("built-in search");
      expect(result.skipped[0]?.reason).toMatch(/another origin/);
      // The toggle map must not advertise a tool that was never registered.
      expect(result.env.bareNames?.has("web_search")).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("allows a reconnect to replace its own tools", async () => {
    const registry = new ToolRegistry();
    const first = await bridgeMcpTools(fakeClient([tool("ping")]), {
      namePrefix: "srv_",
      serverName: "srv",
      registry,
    });
    const second = await bridgeMcpTools(fakeClient([tool("ping")]), {
      namePrefix: "srv_",
      serverName: "srv",
      registry,
    });
    expect(first.registeredNames).toEqual(["srv_ping"]);
    expect(second.registeredNames).toEqual(["srv_ping"]);
    expect(second.skipped).toEqual([]);
  });
});

describe("bridge spec budget", () => {
  it("defers every tool when the budget leaves no room, and leaves no stale toggle entry", async () => {
    const { registry, registeredNames, skipped, env } = await bridgeMcpTools(
      fakeClient([tool("one"), tool("two")]),
      { namePrefix: "srv_", serverName: "srv", specBudgetBytes: 1 },
    );
    expect(registeredNames).toEqual([]);
    expect(skipped.map((s) => s.reason).every((r) => r.includes("deferred"))).toBe(true);
    expect(registry.size).toBe(0);
    expect(env.bareNames?.size).toBe(0);
  });

  it("registers everything when the budget is generous", async () => {
    const result = await bridgeMcpTools(fakeClient([tool("one"), tool("two")]), {
      namePrefix: "srv_",
      serverName: "srv",
      specBudgetBytes: 1_000_000,
    });
    expect(result.registeredNames).toEqual(["srv_one", "srv_two"]);
    expect(result.skipped).toEqual([]);
  });

  it("keeps the accepted set deterministic across identical bridges", async () => {
    const opts = { namePrefix: "srv_", serverName: "srv", specBudgetBytes: 700 };
    const a = await bridgeMcpTools(fakeClient([tool("a"), tool("b"), tool("c")]), opts);
    const b = await bridgeMcpTools(fakeClient([tool("a"), tool("b"), tool("c")]), opts);
    expect(a.registeredNames).toEqual(b.registeredNames);
    expect(a.skipped.map((s) => s.name)).toEqual(b.skipped.map((s) => s.name));
    expect(a.registeredNames.length).toBeGreaterThan(0);
    expect(a.skipped.length).toBeGreaterThan(0);
  });
});
