import { describe, expect, it } from "vitest";
import type { McpClient } from "../src/mcp/client.js";
import { bridgeMcpTools, canonicalizeMcpToolForCache } from "../src/mcp/registry.js";
import { derefJsonSchema } from "../src/mcp/schema-deref.js";
import type { ListToolsResult } from "../src/mcp/types.js";
import { flattenSchema } from "../src/repair/flatten.js";
import type { JSONSchema } from "../src/types.js";

/** zod v4 `z.toJSONSchema()` output: root carries `$defs`, members point at it. */
const zodV4 = {
  type: "object",
  properties: {
    target: { type: "string" },
    options: { $ref: "#/$defs/__schema1" },
  },
  required: ["target"],
  $defs: {
    __schema1: { type: "object", properties: { depth: { type: "integer" } } },
  },
} as unknown as JSONSchema;

describe("derefJsonSchema", () => {
  it("inlines a member $ref and drops the dead $defs block", () => {
    const out = derefJsonSchema(zodV4);
    expect(out).toEqual({
      type: "object",
      properties: {
        target: { type: "string" },
        options: { type: "object", properties: { depth: { type: "integer" } } },
      },
      required: ["target"],
    });
    expect(JSON.stringify(out)).not.toContain("$ref");
    expect(JSON.stringify(out)).not.toContain("$defs");
  });

  it("collapses a root $ref into its object target (object-rooted result)", () => {
    const out = derefJsonSchema({
      $ref: "#/$defs/Root",
      $defs: { Root: { type: "object", properties: { a: { type: "string" } } } },
    } as unknown as JSONSchema);
    expect(out).toEqual({ type: "object", properties: { a: { type: "string" } } });
  });

  it("resolves draft-07 `definitions` too", () => {
    const out = derefJsonSchema({
      type: "object",
      properties: { x: { $ref: "#/definitions/X" } },
      definitions: { X: { type: "number" } },
    } as unknown as JSONSchema);
    expect(out.properties?.x).toEqual({ type: "number" });
  });

  it("merges sibling keywords over the resolved target", () => {
    const out = derefJsonSchema({
      type: "object",
      properties: { x: { $ref: "#/$defs/X", description: "override" } },
      $defs: { X: { type: "string", description: "base" } },
    } as unknown as JSONSchema);
    expect(out.properties?.x).toEqual({ type: "string", description: "override" });
  });

  it("drops an unresolvable / external $ref instead of shipping a dangling pointer", () => {
    const out = derefJsonSchema({
      type: "object",
      properties: { x: { $ref: "https://example.com/schema.json", description: "keep me" } },
    } as unknown as JSONSchema);
    expect(out.properties?.x).toEqual({ description: "keep me" });
    expect(JSON.stringify(out)).not.toContain("$ref");
  });

  it("terminates on a self-referential $defs and leaves no $ref behind", () => {
    const out = derefJsonSchema({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { value: { type: "string" }, next: { $ref: "#/$defs/Node" } },
        },
      },
    } as unknown as JSONSchema);
    expect(out.properties?.node).toEqual({
      type: "object",
      properties: { value: { type: "string" }, next: {} },
    });
    expect(JSON.stringify(out)).not.toContain("$ref");
    expect(JSON.stringify(out)).not.toContain("$defs");
  });

  it("leaves a schema with no refs structurally intact", () => {
    const plain = {
      type: "object",
      properties: { a: { type: "string" } },
    } as unknown as JSONSchema;
    expect(derefJsonSchema(plain)).toEqual(plain);
  });
});

describe("deref + flatten integration", () => {
  it("flattening a deref'd deep schema keeps no dangling pointer", () => {
    const deep = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: { b: { type: "object", properties: { c: { type: "string" } } } },
        },
        opt: { $ref: "#/$defs/__schema1" },
      },
      $defs: { __schema1: { type: "object", properties: { x: { type: "string" } } } },
    } as unknown as JSONSchema;
    const flat = flattenSchema(derefJsonSchema(deep));
    expect(JSON.stringify(flat)).not.toContain("$ref");
    expect(JSON.stringify(flat)).not.toContain("$defs");
    expect(flat.properties?.["a.b.c"]).toEqual({ type: "string" });
    expect(flat.properties?.["opt.x"]).toEqual({ type: "string" });
  });
});

describe("canonicalizeMcpToolForCache", () => {
  it("emits a self-contained schema with no $ref/$defs", () => {
    const canonical = canonicalizeMcpToolForCache({
      name: "analyze",
      description: "d",
      inputSchema: zodV4,
    });
    const wire = JSON.stringify(canonical.inputSchema);
    expect(wire).not.toContain("$ref");
    expect(wire).not.toContain("$defs");
    expect((canonical.inputSchema.properties as Record<string, JSONSchema>).options).toEqual({
      type: "object",
      properties: { depth: { type: "integer" } },
    });
  });

  it("keeps the bridged tool list cache-stable for the same ref-bearing schema", () => {
    const tool = { name: "t", inputSchema: zodV4 };
    expect(JSON.stringify(canonicalizeMcpToolForCache(tool))).toBe(
      JSON.stringify(canonicalizeMcpToolForCache(tool)),
    );
  });
});

describe("bridgeMcpTools with a $ref schema", () => {
  it("registers a self-contained spec that no longer references $defs", async () => {
    const client = {
      listTools: async (): Promise<ListToolsResult> => ({
        tools: [{ name: "ghidra_analyze_web_bundle", inputSchema: zodV4 }],
      }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    } as unknown as McpClient;

    const bridged = await bridgeMcpTools(client, {});
    const spec = bridged.registry
      .specs()
      .find((s) => s.function.name === "ghidra_analyze_web_bundle");
    expect(spec).toBeDefined();
    expect(JSON.stringify(spec?.function.parameters)).not.toContain("$defs");
    expect(JSON.stringify(spec?.function.parameters)).not.toContain("$ref");
  });
});
