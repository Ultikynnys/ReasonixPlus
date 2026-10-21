// Consolidated from 10 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ReasonixConfig, normalizeMcpConfig } from "../src/config.js";
import { supervisePlaywrightInstaller } from "../src/mcp/browser-installer.js";
import type { McpClient } from "../src/mcp/client.js";
import { classifyToolListDrift } from "../src/mcp/drift.js";
import {
  bridgeMcpTools,
  canonicalizeMcpToolForCache,
  canonicalizeSchemaForCache,
} from "../src/mcp/registry.js";
import { derefJsonSchema } from "../src/mcp/schema-deref.js";
import { compactDescription, pruneMcpToolSchema } from "../src/mcp/schema-prune.js";
import { shellSplit } from "../src/mcp/shell-split.js";
import { type McpServerSpec, parseMcpSpec } from "../src/mcp/spec.js";
import { SseTransport } from "../src/mcp/sse.js";
import { StdioTransport } from "../src/mcp/stdio.js";
import { StreamableHttpTransport } from "../src/mcp/streamable-http.js";
import { buildTransportFromSpec } from "../src/mcp/transport-from-spec.js";
import type { CallToolResult, ListToolsResult, McpTool } from "../src/mcp/types.js";
import { flattenSchema } from "../src/repair/flatten.js";
import { sanitizeWireToolName } from "../src/tool-name.js";
import { ToolRegistry } from "../src/tools.js";
import type { JSONSchema, ToolSpec } from "../src/types.js";

describe("mcp-normalize-config", () => {
  function names(specs: McpServerSpec[]): (string | null)[] {
    return specs.map((s) => s.name);
  }

  function findByName(specs: McpServerSpec[], name: string): McpServerSpec | undefined {
    return specs.find((s) => s.name === name);
  }

  describe("normalizeMcpConfig: legacy-only", () => {
    it("parses mcp: string[] into McpServerSpec[]", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs /tmp", "git=uvx mcp-server-git"],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(2);
      expect(names(result)).toEqual(["fs", "git"]);
      const fs = findByName(result, "fs")!;
      expect(fs.transport).toBe("stdio");
      if (fs.transport !== "stdio") throw new Error("unreachable");
      expect(fs.command).toBe("npx");
      expect(fs.args).toEqual(["-y", "@scope/fs", "/tmp"]);
      expect(fs.env).toBeUndefined();
      expect(fs.disabled).toBe(false);
    });

    it("parses anonymous legacy specs", () => {
      const cfg: ReasonixConfig = {
        mcp: ["npx -y @scope/fs /tmp"],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBeNull();
    });

    it("parses SSE legacy specs", () => {
      const cfg: ReasonixConfig = {
        mcp: ["remote=https://example.com/sse"],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.transport).toBe("sse");
    });

    it("parses streamable-http legacy specs", () => {
      const cfg: ReasonixConfig = {
        mcp: ["edge=streamable+https://edge.example.com/mcp"],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.transport).toBe("streamable-http");
    });

    it("skips invalid legacy specs silently", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs", "", "   "],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("fs");
    });
  });

  describe("normalizeMcpConfig: object-only", () => {
    it("parses mcpServers into McpServerSpec[]", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "ghp_abc" },
          },
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(2);
      expect(names(result)).toEqual(["github", "filesystem"]);
      const gh = findByName(result, "github")!;
      expect(gh.transport).toBe("stdio");
      if (gh.transport !== "stdio") throw new Error("unreachable");
      expect(gh.command).toBe("npx");
      expect(gh.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
      expect(gh.env).toEqual({ GITHUB_TOKEN: "ghp_abc" });
    });

    it("parses SSE mcpServers with headers", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer tok_abc" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      const spec = result[0]!;
      expect(spec.transport).toBe("sse");
      if (spec.transport !== "sse") throw new Error("unreachable");
      expect(spec.url).toBe("https://example.com/sse");
      expect(spec.headers).toEqual({ Authorization: "Bearer tok_abc" });
    });

    it("parses streamable-http mcpServers with headers", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          edge: {
            transport: "streamable-http",
            url: "https://edge.example.com/mcp",
            headers: { "X-API-Key": "key_xyz" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      const spec = result[0]!;
      expect(spec.transport).toBe("streamable-http");
      if (spec.transport !== "streamable-http") throw new Error("unreachable");
      expect(spec.url).toBe("https://edge.example.com/mcp");
      expect(spec.headers).toEqual({ "X-API-Key": "key_xyz" });
    });

    it("infers transport from url when transport is omitted", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          sseSvc: { url: "https://example.com/sse" },
          stdioSvc: { command: "npx", args: ["-y", "pkg"] },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(2);
      const sse = findByName(result, "sseSvc")!;
      expect(sse.transport).toBe("sse");
      const stdio = findByName(result, "stdioSvc")!;
      expect(stdio.transport).toBe("stdio");
    });

    it("strips streamable+ prefix from url when transport is omitted", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          edge: { url: "streamable+https://edge.example.com/mcp" },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      const spec = result[0]!;
      expect(spec.transport).toBe("streamable-http");
      if (spec.transport !== "streamable-http") throw new Error("unreachable");
      expect(spec.url).toBe("https://edge.example.com/mcp");
    });
  });

  describe("normalizeMcpConfig: merge with name conflict", () => {
    it("mcpServers wins silently when both sources have the same name", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs /tmp"],
        mcpServers: {
          fs: {
            command: "node",
            args: ["server.js"],
            env: { CUSTOM: "value" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      const spec = result[0]!;
      expect(spec.name).toBe("fs");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      // mcpServers wins: command and args from mcpServers
      expect(spec.command).toBe("node");
      expect(spec.args).toEqual(["server.js"]);
      expect(spec.env).toEqual({ CUSTOM: "value" });
    });

    it("mcpServers entry shadows legacy spec with same name", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs /tmp", "git=uvx mcp-server-git"],
        mcpServers: {
          fs: {
            transport: "sse",
            url: "https://mcp.internal/fs/sse",
            headers: { Authorization: "Bearer tok" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(2);
      const fs = findByName(result, "fs")!;
      // mcpServers wins: fs is now SSE, not stdio
      expect(fs.transport).toBe("sse");
      if (fs.transport !== "sse") throw new Error("unreachable");
      expect(fs.url).toBe("https://mcp.internal/fs/sse");
      expect(fs.headers).toEqual({ Authorization: "Bearer tok" });
      // git is still from legacy
      const git = findByName(result, "git")!;
      expect(git.transport).toBe("stdio");
    });
  });

  describe("normalizeMcpConfig: disabled handling", () => {
    it("honors disabled: true from mcpServers entry", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@scope/github"],
            disabled: true,
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.disabled).toBe(true);
    });

    it("honors disabled from legacy mcpDisabled array", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs /tmp"],
        mcpDisabled: ["fs"],
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.disabled).toBe(true);
    });

    it("combines both disabled sources", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs /tmp", "git=uvx mcp-server-git"],
        mcpDisabled: ["fs"],
        mcpServers: {
          db: {
            command: "npx",
            args: ["-y", "@scope/db"],
            disabled: true,
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(3);
      expect(findByName(result, "fs")!.disabled).toBe(true);
      expect(findByName(result, "git")!.disabled).toBe(false);
      expect(findByName(result, "db")!.disabled).toBe(true);
    });

    it("mcpServers disabled:true overrides legacy mcpDisabled for same name", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs"],
        mcpDisabled: [],
        mcpServers: {
          fs: { command: "node", args: ["srv.js"], disabled: true },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const fs = findByName(result, "fs")!;
      expect(fs.disabled).toBe(true);
    });
  });

  describe("normalizeMcpConfig: env and headers", () => {
    it("env from mcpServers is present on stdio specs", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@scope/github"],
            env: { GITHUB_TOKEN: "ghp_abc" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const spec = result[0]!;
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.env).toEqual({ GITHUB_TOKEN: "ghp_abc" });
    });

    it("env from legacy mcpEnv is present on stdio specs", () => {
      const cfg: ReasonixConfig = {
        mcp: ["github=npx -y @scope/github"],
        mcpEnv: { github: { GITHUB_TOKEN: "ghp_abc" } },
      };
      const result = normalizeMcpConfig(cfg);
      const spec = result[0]!;
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.env).toEqual({ GITHUB_TOKEN: "ghp_abc" });
    });

    it("headers from mcpServers are present on SSE specs", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer tok" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const spec = result[0]!;
      if (spec.transport !== "sse") throw new Error("unreachable");
      expect(spec.headers).toEqual({ Authorization: "Bearer tok" });
    });

    it("headers from mcpServers are present on streamable-http specs", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          edge: {
            transport: "streamable-http",
            url: "https://edge.example.com/mcp",
            headers: { "X-API-Key": "key_xyz" },
          },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const spec = result[0]!;
      if (spec.transport !== "streamable-http") throw new Error("unreachable");
      expect(spec.headers).toEqual({ "X-API-Key": "key_xyz" });
    });

    it("anonymous legacy spec has no env overlay", () => {
      const cfg: ReasonixConfig = {
        mcp: ["npx -y @scope/fs"],
        mcpEnv: { anon: { TOKEN: "val" } },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBeNull();
      if (result[0]!.transport !== "stdio") throw new Error("unreachable");
      expect(result[0]!.env).toBeUndefined();
    });
  });

  describe("normalizeMcpConfig: headers round-trip into transport", () => {
    it("headers on SSE spec are passed to SseTransport", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer tok" },
          },
        },
      };
      const specs = normalizeMcpConfig(cfg);
      const transport = buildTransportFromSpec(specs[0]!);
      expect(transport).toBeInstanceOf(SseTransport);
    });

    it("headers on streamable-http spec are passed to StreamableHttpTransport", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          edge: {
            transport: "streamable-http",
            url: "https://edge.example.com/mcp",
            headers: { "X-API-Key": "key_xyz" },
          },
        },
      };
      const specs = normalizeMcpConfig(cfg);
      const transport = buildTransportFromSpec(specs[0]!);
      expect(transport).toBeInstanceOf(StreamableHttpTransport);
    });

    it("stdio server with headers ignores headers", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          local: {
            command: "npx",
            args: ["-y", "@scope/local"],
            headers: { Authorization: "Bearer tok" },
          },
        },
      };
      const specs = normalizeMcpConfig(cfg);
      const spec = specs[0]!;
      if (spec.transport !== "stdio") throw new Error("unreachable");
      // headers should not be present on stdio spec
      expect((spec as Record<string, unknown>).headers).toBeUndefined();
      const transport = buildTransportFromSpec(spec);
      expect(transport).toBeInstanceOf(StdioTransport);
      void transport.close();
    });

    it("env on stdio spec is passed to StdioTransport", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          local: {
            command: "node",
            args: ["-e", "console.log('hi')"],
            env: { FOO: "bar" },
          },
        },
      };
      const specs = normalizeMcpConfig(cfg);
      const transport = buildTransportFromSpec(specs[0]!);
      expect(transport).toBeInstanceOf(StdioTransport);
      void transport.close();
    });
  });

  describe("normalizeMcpConfig: extraLegacy parameter", () => {
    it("extraLegacy replaces cfg.mcp when provided", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs"],
        mcpServers: {
          db: { command: "npx", args: ["-y", "@scope/db"] },
        },
      };
      const result = normalizeMcpConfig(cfg, ["cli=npx -y @scope/cli"]);
      expect(result).toHaveLength(2);
      expect(names(result)).toEqual(["cli", "db"]);
    });

    it("extraLegacy is empty array falls back to cfg.mcp", () => {
      const cfg: ReasonixConfig = {
        mcp: ["fs=npx -y @scope/fs"],
      };
      const result = normalizeMcpConfig(cfg, []);
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("fs");
    });
  });

  describe("normalizeMcpConfig: Claude .mcp.json compatibility", () => {
    it("accepts `type` as alias for `transport`", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          local: { type: "stdio", command: "node", args: ["server.js"] },
          events: { type: "sse", url: "https://example.com/sse" },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const local = findByName(result, "local")!;
      expect(local.transport).toBe("stdio");
      const events = findByName(result, "events")!;
      expect(events.transport).toBe("sse");
    });

    it('treats `type: "http"` as `streamable-http`', () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          gh: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        },
      };
      const result = normalizeMcpConfig(cfg);
      const gh = findByName(result, "gh")!;
      expect(gh.transport).toBe("streamable-http");
    });

    it("`transport` still wins when both transport and type are set", () => {
      const cfg: ReasonixConfig = {
        mcpServers: {
          odd: { transport: "stdio", type: "http", command: "node" },
        },
      };
      const result = normalizeMcpConfig(cfg);
      expect(result[0]!.transport).toBe("stdio");
    });
  });
});

describe("mcp-spec", () => {
  describe("parseMcpSpec: stdio", () => {
    it("parses a namespaced spec", () => {
      const spec = parseMcpSpec("fs=npx -y @scope/fs /tmp/dir");
      expect(spec.transport).toBe("stdio");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBe("fs");
      expect(spec.command).toBe("npx");
      expect(spec.args).toEqual(["-y", "@scope/fs", "/tmp/dir"]);
    });

    it("parses an anonymous spec (no name=)", () => {
      const spec = parseMcpSpec("npx -y @scope/fs /tmp/dir");
      expect(spec.transport).toBe("stdio");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBeNull();
      expect(spec.command).toBe("npx");
      expect(spec.args).toEqual(["-y", "@scope/fs", "/tmp/dir"]);
    });

    it("does NOT treat Windows drive letters as a namespace", () => {
      // `C:\...` matches the colon but NOT the identifier regex [a-zA-Z_]\w* =
      // So it stays anonymous with the whole path as command.
      const spec = parseMcpSpec("C:\\path\\to\\server.exe arg1");
      expect(spec.transport).toBe("stdio");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBeNull();
      expect(spec.command).toBe("C:\\path\\to\\server.exe");
      expect(spec.args).toEqual(["arg1"]);
    });

    it("handles quoted args in the body", () => {
      const spec = parseMcpSpec('myserver=cmd "path with spaces" --flag');
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBe("myserver");
      expect(spec.command).toBe("cmd");
      expect(spec.args).toEqual(["path with spaces", "--flag"]);
    });

    it("trims leading/trailing whitespace", () => {
      const spec = parseMcpSpec("  fs=npx pkg  ");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBe("fs");
      expect(spec.command).toBe("npx");
      expect(spec.args).toEqual(["pkg"]);
    });

    it("throws on empty input", () => {
      expect(() => parseMcpSpec("")).toThrow(/empty MCP spec/);
      expect(() => parseMcpSpec("   ")).toThrow(/empty MCP spec/);
    });

    it("throws when name is given but no command follows", () => {
      expect(() => parseMcpSpec("fs=")).toThrow(/has name but no command/);
      expect(() => parseMcpSpec("fs=   ")).toThrow(/has name but no command/);
    });

    it("allows underscores and digits in the name (but not leading digit)", () => {
      const ok = parseMcpSpec("my_fs2=cmd");
      expect(ok.name).toBe("my_fs2");
      // Leading digit → not a valid identifier → whole thing is command
      // (since `2fs` doesn't match identifier regex).
      const s = parseMcpSpec("2fs=cmd");
      if (s.transport !== "stdio") throw new Error("unreachable");
      expect(s.name).toBeNull();
      expect(s.command).toBe("2fs=cmd");
    });

    it("allows hyphens in the name (kebab-case is the MCP ecosystem norm)", () => {
      const spec = parseMcpSpec("sage-wiki=npx -y @scope/sage-wiki");
      if (spec.transport !== "stdio") throw new Error("unreachable");
      expect(spec.name).toBe("sage-wiki");
      expect(spec.command).toBe("npx");
      expect(spec.args).toEqual(["-y", "@scope/sage-wiki"]);
      // Leading hyphen → not a valid identifier → whole thing is command
      const lead = parseMcpSpec("-fs=cmd");
      if (lead.transport !== "stdio") throw new Error("unreachable");
      expect(lead.name).toBeNull();
      expect(lead.command).toBe("-fs=cmd");
    });
  });

  describe("parseMcpSpec: sse", () => {
    it("parses an anonymous https URL", () => {
      const spec = parseMcpSpec("https://example.com/sse");
      expect(spec.transport).toBe("sse");
      if (spec.transport !== "sse") throw new Error("unreachable");
      expect(spec.name).toBeNull();
      expect(spec.url).toBe("https://example.com/sse");
    });

    it("parses a namespaced http URL (localhost dev)", () => {
      const spec = parseMcpSpec("local=http://127.0.0.1:9000/sse");
      if (spec.transport !== "sse") throw new Error("unreachable");
      expect(spec.name).toBe("local");
      expect(spec.url).toBe("http://127.0.0.1:9000/sse");
    });

    it("is case-insensitive on the scheme", () => {
      const spec = parseMcpSpec("HTTPS://example.com/sse");
      expect(spec.transport).toBe("sse");
    });

    it("does not match ws:// as SSE (falls through to stdio)", () => {
      const spec = parseMcpSpec("ws://example.com/mcp");
      expect(spec.transport).toBe("stdio");
    });
  });

  describe("parseMcpSpec: streamable-http", () => {
    it("parses an anonymous streamable+https URL and strips the prefix", () => {
      const spec = parseMcpSpec("streamable+https://example.com/mcp");
      expect(spec.transport).toBe("streamable-http");
      if (spec.transport !== "streamable-http") throw new Error("unreachable");
      expect(spec.name).toBeNull();
      expect(spec.url).toBe("https://example.com/mcp");
    });

    it("parses a namespaced streamable+http URL (localhost dev)", () => {
      const spec = parseMcpSpec("local=streamable+http://127.0.0.1:9000/mcp");
      if (spec.transport !== "streamable-http") throw new Error("unreachable");
      expect(spec.name).toBe("local");
      expect(spec.url).toBe("http://127.0.0.1:9000/mcp");
    });

    it("is case-insensitive on the streamable+ prefix", () => {
      const spec = parseMcpSpec("STREAMABLE+HTTPS://example.com/mcp");
      expect(spec.transport).toBe("streamable-http");
    });

    it("plain https without `streamable+` still routes to SSE for back-compat", () => {
      const spec = parseMcpSpec("https://example.com/mcp");
      expect(spec.transport).toBe("sse");
    });
  });
});

describe("mcp-schema-deref", () => {
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
});

describe("mcp-schema-prune", () => {
  describe("MCP schema pruning and compression", () => {
    describe("compactDescription", () => {
      it("preserves short descriptions without modification", () => {
        expect(compactDescription("A concise tool description.")).toBe(
          "A concise tool description.",
        );
      });

      it("truncates multi-sentence descriptions to the first complete sentence", () => {
        const longDesc =
          "Creates a new mail message draft. This draft can be updated multiple times before sending. See Microsoft Graph documentation for details.";
        expect(compactDescription(longDesc, 80)).toBe("Creates a new mail message draft.");
      });

      it("clamps long single sentences with ellipsis", () => {
        const longSentence =
          "This is an extremely long single sentence description without any punctuation that goes on and on and explains every tiny detail of the field.";
        const compacted = compactDescription(longSentence, 50);
        expect(compacted.length).toBeLessThanOrEqual(50);
        expect(compacted.endsWith("...")).toBe(true);
      });
    });

    describe("pruneMcpToolSchema", () => {
      it("strips readOnly: true properties unless they are required", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            id: { type: "string", readOnly: true },
            name: { type: "string" },
            code: { type: "string", readOnly: true },
          },
          required: ["code"],
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.id).toBeUndefined();
        expect(pruned.properties?.name).toBeDefined();
        expect(pruned.properties?.code).toBeDefined();
        expect(pruned.required).toEqual(["code"]);
      });

      it("strips properties described as Read-only", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The unique identifier for an entity. Read-only.",
            },
            subject: { type: "string", description: "Subject of the email." },
          },
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.id).toBeUndefined();
        expect(pruned.properties?.subject).toBeDefined();
      });

      it("strips metadata property bags like ExtendedProperties and internetMessageHeaders", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            subject: { type: "string" },
            singleValueExtendedProperties: { type: "array", items: {} },
            multiValueExtendedProperties: { type: "array", items: {} },
            internetMessageHeaders: { type: "array", items: {} },
          },
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.subject).toBeDefined();
        expect(pruned.properties?.singleValueExtendedProperties).toBeUndefined();
        expect(pruned.properties?.multiValueExtendedProperties).toBeUndefined();
        expect(pruned.properties?.internetMessageHeaders).toBeUndefined();
      });

      it("strips non-required entity child collections", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            displayName: { type: "string" },
            messages: { type: "array", items: { type: "object" } },
            messageRules: { type: "array", items: { type: "object" } },
            childFolders: { type: "array", items: { type: "object" } },
          },
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.displayName).toBeDefined();
        expect(pruned.properties?.messages).toBeUndefined();
        expect(pruned.properties?.messageRules).toBeUndefined();
        expect(pruned.properties?.childFolders).toBeUndefined();
      });

      it("preserves child collections if they are explicitly marked as required", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            messages: { type: "array", items: { type: "object" } },
          },
          required: ["messages"],
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.messages).toBeDefined();
      });

      it("removes empty object stubs", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            subject: { type: "string" },
            dueDateTime: {},
            from: {},
          },
        };

        const pruned = pruneMcpToolSchema(schema);
        expect(pruned.properties?.subject).toBeDefined();
        expect(pruned.properties?.dueDateTime).toBeUndefined();
        expect(pruned.properties?.from).toBeUndefined();
      });

      it("recursively prunes nested object schemas and array items", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            message: {
              type: "object",
              properties: {
                subject: { type: "string" },
                id: { type: "string", readOnly: true },
                recipients: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      address: { type: "string" },
                      changeKey: {
                        type: "string",
                        description: "Identifies version. Read-only.",
                      },
                    },
                  },
                },
              },
            },
          },
        };

        const pruned = pruneMcpToolSchema(schema);
        const msg = pruned.properties?.message as JSONSchema;
        expect(msg.properties?.subject).toBeDefined();
        expect(msg.properties?.id).toBeUndefined();

        const recipients = msg.properties?.recipients as JSONSchema;
        const recItem = recipients.items as JSONSchema;
        expect(recItem.properties?.address).toBeDefined();
        expect(recItem.properties?.changeKey).toBeUndefined();
      });

      it("handles union keywords (oneOf, anyOf, allOf)", () => {
        const schema: JSONSchema = {
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: {
                typeA: { type: "string" },
                id: { type: "string", readOnly: true },
              },
            },
            {
              type: "object",
              properties: {
                typeB: { type: "string" },
              },
            },
          ],
        };

        const pruned = pruneMcpToolSchema(schema);
        const branches = pruned.oneOf as JSONSchema[];
        expect(branches[0]?.properties?.typeA).toBeDefined();
        expect(branches[0]?.properties?.id).toBeUndefined();
        expect(branches[1]?.properties?.typeB).toBeDefined();
      });

      it("produces deterministic output across multiple invocations", () => {
        const schema: JSONSchema = {
          type: "object",
          properties: {
            b: { type: "string", description: "Second property with text." },
            a: { type: "number", description: "First property. Extra documentation." },
            id: { type: "string", readOnly: true },
          },
        };

        const res1 = JSON.stringify(pruneMcpToolSchema(schema));
        const res2 = JSON.stringify(pruneMcpToolSchema(schema));
        expect(res1).toBe(res2);
      });
    });
  });
});

describe("mcp-cache-canonicalization", () => {
  function client(tools: ListToolsResult["tools"]): McpClient {
    return {
      listTools: async () => ({ tools }),
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    } as unknown as McpClient;
  }

  describe("MCP cache canonicalization", () => {
    it("sorts bridged tools by final registered name", async () => {
      const bridged = await bridgeMcpTools(
        client([
          { name: "zeta", inputSchema: { type: "object" } },
          { name: "alpha", inputSchema: { type: "object" } },
        ]),
        { namePrefix: "srv_" },
      );

      expect(bridged.registeredNames).toEqual(["srv_alpha", "srv_zeta"]);
      expect(bridged.registry.specs().map((spec) => spec.function.name)).toEqual([
        "srv_alpha",
        "srv_zeta",
      ]);
    });

    it("stabilizes object keys and required arrays while preserving enum order", () => {
      const canonical = canonicalizeSchemaForCache({
        required: ["b", "a"],
        properties: {
          b: { enum: ["z", "a"], type: "string" },
          a: { type: "string" },
        },
        type: "object",
      });

      expect(JSON.stringify(canonical)).toBe(
        JSON.stringify({
          properties: {
            a: { type: "string" },
            b: { enum: ["z", "a"], type: "string" },
          },
          required: ["a", "b"],
          type: "object",
        }),
      );
    });

    it("sorts dependentRequired inner arrays for cache stability", () => {
      const canonical = canonicalizeSchemaForCache({
        dependentRequired: {
          b: ["z", "a"],
          a: ["y", "x"],
        },
        type: "object",
      });

      expect(JSON.stringify(canonical)).toBe(
        JSON.stringify({
          dependentRequired: {
            a: ["x", "y"],
            b: ["a", "z"],
          },
          type: "object",
        }),
      );
    });

    it("handles nested arrays within dependentRequired", () => {
      const canonical = canonicalizeSchemaForCache({
        dependentRequired: {
          credit_card: ["number", "expiry", "cvv"],
          name: ["first", "last"],
        },
        type: "object",
      });

      const parsed = JSON.parse(JSON.stringify(canonical)) as {
        dependentRequired: Record<string, string[]>;
      };
      expect(Object.keys(parsed.dependentRequired)).toEqual(["credit_card", "name"]);
      expect(parsed.dependentRequired.credit_card).toEqual(["cvv", "expiry", "number"]);
      expect(parsed.dependentRequired.name).toEqual(["first", "last"]);
    });
  });
});

describe("mcp-tool-name-sanitize", () => {
  describe("sanitizeWireToolName", () => {
    it("leaves already-valid OpenAI function names untouched", () => {
      expect(sanitizeWireToolName("read_file")).toBe("read_file");
      expect(sanitizeWireToolName("srv-tool_2")).toBe("srv-tool_2");
    });

    it("replaces chars outside ^[a-zA-Z0-9_-] with underscores", () => {
      expect(sanitizeWireToolName("my.db.users.get")).toBe("my_db_users_get");
      expect(sanitizeWireToolName("GET /pets/{id}")).toBe("GET__pets__id_");
    });

    it("forces the first char to a letter or underscore", () => {
      expect(sanitizeWireToolName("2fa.login")).toBe("_2fa_login");
    });

    it("caps at 64 chars", () => {
      expect(sanitizeWireToolName("a".repeat(80))).toHaveLength(64);
    });

    it("is deterministic (cache-stable)", () => {
      expect(sanitizeWireToolName("a.b")).toBe(sanitizeWireToolName("a.b"));
    });
  });

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

  describe("bridgeMcpTools — OpenAI-safe tool names", () => {
    it("sanitizes a dotted server prefix + tool name to a valid wire name", async () => {
      const { registry, registeredNames, env } = await bridgeMcpTools(
        fakeClient([tool("users.get")]),
        {
          namePrefix: "my.db_",
        },
      );
      expect(registeredNames).toEqual(["my_db_users_get"]);
      expect(registry.has("my_db_users_get")).toBe(true);
      // Dispatch still reaches the REAL MCP tool name (the closure keeps it).
      expect(await registry.dispatch("my_db_users_get", "{}")).toContain("ran users.get");
      // The real bare name is recoverable for the per-tool toggle UI.
      expect(env.bareNames?.get("my_db_users_get")).toBe("users.get");
    });

    it("keeps two tools apart when they sanitize to the same name", async () => {
      const { registeredNames } = await bridgeMcpTools(
        fakeClient([tool("users.get"), tool("users_get")]),
        { namePrefix: "srv_" },
      );
      expect(new Set(registeredNames).size).toBe(2);
      expect(registeredNames).toContain("srv_users_get");
      expect(registeredNames.some((n) => n.startsWith("srv_users_get-"))).toBe(true);
    });

    it("does not rename already-valid tools (no cache churn)", async () => {
      const { registeredNames } = await bridgeMcpTools(fakeClient([tool("echo")]), {
        namePrefix: "demo_",
      });
      expect(registeredNames).toEqual(["demo_echo"]);
    });
  });
});

describe("mcp-shell-split", () => {
  describe("shellSplit", () => {
    it("splits a simple space-separated command", () => {
      expect(shellSplit("npx -y @scope/pkg /tmp")).toEqual(["npx", "-y", "@scope/pkg", "/tmp"]);
    });

    it("collapses runs of spaces and tabs", () => {
      expect(shellSplit("a   b\tc")).toEqual(["a", "b", "c"]);
    });

    it("respects double quotes around paths with spaces", () => {
      expect(shellSplit('npx pkg "my dir/with spaces"')).toEqual([
        "npx",
        "pkg",
        "my dir/with spaces",
      ]);
    });

    it("respects single quotes and keeps inner backslashes literal", () => {
      expect(shellSplit("cmd 'a\\b c'")).toEqual(["cmd", "a\\b c"]);
    });

    it("processes backslash escapes inside double quotes", () => {
      expect(shellSplit('cmd "a\\"b"')).toEqual(["cmd", 'a"b']);
    });

    it("passes backslashes through literally OUTSIDE quotes (so Windows paths don't mangle)", () => {
      // Critical for `reasonix chat --mcp "... C:\\path\\to\\dir"`. Users
      // who want to escape a space outside quotes can quote the arg.
      expect(shellSplit("cmd C:\\path\\to\\file.exe")).toEqual(["cmd", "C:\\path\\to\\file.exe"]);
    });

    it("throws on unterminated double quote", () => {
      expect(() => shellSplit('cmd "unterminated')).toThrow(/unterminated/);
    });

    it("throws on unterminated single quote", () => {
      expect(() => shellSplit("cmd 'still open")).toThrow(/unterminated/);
    });

    it("returns empty array on whitespace-only input", () => {
      expect(shellSplit("   ")).toEqual([]);
      expect(shellSplit("")).toEqual([]);
    });
  });
});

describe("mcp-drift", () => {
  function tool(name: string, description = "", params: object = { type: "object" }): ToolSpec {
    return {
      type: "function",
      function: { name, description, parameters: params },
    };
  }

  const A = tool("read");
  const B = tool("write");
  const C = tool("search");
  const D = tool("delete");

  describe("classifyToolListDrift", () => {
    it("identity: same length, same names, same content → identity", () => {
      const r = classifyToolListDrift([A, B, C], [A, B, C]);
      expect(r.kind).toBe("identity");
      expect(r.added).toEqual([]);
      expect(r.removed).toEqual([]);
      expect(r.edited).toEqual([]);
    });

    it("append: every before-tool unchanged, new tool appended", () => {
      const r = classifyToolListDrift([A, B, C], [A, B, C, D]);
      expect(r.kind).toBe("append");
      expect(r.added).toEqual(["delete"]);
      expect(r.removed).toEqual([]);
      expect(r.edited).toEqual([]);
    });

    it("append: multiple tools appended at the end", () => {
      const E = tool("touch");
      const r = classifyToolListDrift([A, B], [A, B, C, D, E]);
      expect(r.kind).toBe("append");
      expect(r.added).toEqual(["search", "delete", "touch"]);
    });

    it("edit: same names + same order, content of one tool changed", () => {
      const aEdited = tool("read", "now reads UTF-8 only");
      const r = classifyToolListDrift([A, B, C], [aEdited, B, C]);
      expect(r.kind).toBe("edit");
      expect(r.edited).toEqual(["read"]);
      expect(r.added).toEqual([]);
      expect(r.removed).toEqual([]);
    });

    it("edit: schema change on the same tool", () => {
      const aSchema = tool("read", "", {
        type: "object",
        properties: { path: { type: "string" }, encoding: { type: "string" } },
      });
      const r = classifyToolListDrift([A], [aSchema]);
      expect(r.kind).toBe("edit");
      expect(r.edited).toEqual(["read"]);
    });

    it("remove: a tool present in before is missing from after", () => {
      const r = classifyToolListDrift([A, B, C], [A, C]);
      expect(r.kind).toBe("remove");
      expect(r.removed).toEqual(["write"]);
      expect(r.added).toEqual([]);
    });

    it("remove dominates: even if other tools were added, removal makes it `remove`", () => {
      // before: A, B, C  → after: A, C, D  (B removed, D added)
      const r = classifyToolListDrift([A, B, C], [A, C, D]);
      expect(r.kind).toBe("remove");
      expect(r.removed).toEqual(["write"]);
      expect(r.added).toEqual(["delete"]);
    });

    it("reorder: same name set in a different order", () => {
      const r = classifyToolListDrift([A, B, C], [B, A, C]);
      expect(r.kind).toBe("reorder");
    });

    it("reorder: addition NOT at the end (cache-equivalent to a reorder)", () => {
      const r = classifyToolListDrift([A, B, C], [A, D, B, C]);
      expect(r.kind).toBe("reorder");
    });

    it("identity with empty lists", () => {
      expect(classifyToolListDrift([], []).kind).toBe("identity");
    });

    it("append onto an empty list", () => {
      const r = classifyToolListDrift([], [A, B]);
      expect(r.kind).toBe("append");
      expect(r.added).toEqual(["read", "write"]);
    });

    it("remove down to an empty list", () => {
      const r = classifyToolListDrift([A, B], []);
      expect(r.kind).toBe("remove");
      expect(r.removed).toEqual(["read", "write"]);
    });
  });
});

// Guards at the bridge seam: provenance, budget deferral, and the bookkeeping both leave behind.
describe("mcp-bridge-guards", () => {
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
});

describe("mcp-browser-installer", () => {
  class FakeChild extends EventEmitter {
    pid = 12345;
    kill = vi.fn(() => true);
  }

  function childProcess(fake: FakeChild): ChildProcess {
    return fake as unknown as ChildProcess;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("supervisePlaywrightInstaller", () => {
    it("returns the child exit code when installation completes", async () => {
      const child = new FakeChild();
      const supervisor = supervisePlaywrightInstaller(childProcess(child));
      child.emit("close", 0);
      await expect(supervisor.result).resolves.toEqual({ code: 0 });
    });

    it("settles and terminates a source attempt at its hard deadline", async () => {
      vi.useFakeTimers();
      const child = new FakeChild();
      const supervisor = supervisePlaywrightInstaller(childProcess(child), {
        attemptTimeoutMs: 100,
        terminateChild: () => child.kill("SIGKILL"),
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(supervisor.result).resolves.toMatchObject({
        code: null,
        error: expect.stringContaining("source deadline"),
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("settles a child that hangs after reporting 100 percent", async () => {
      vi.useFakeTimers();
      const child = new FakeChild();
      const supervisor = supervisePlaywrightInstaller(childProcess(child), {
        attemptTimeoutMs: 1_000,
        finalizeTimeoutMs: 100,
        terminateChild: () => child.kill("SIGKILL"),
      });
      supervisor.markDownloadComplete();
      await vi.advanceTimersByTimeAsync(100);
      await expect(supervisor.result).resolves.toMatchObject({
        code: null,
        error: expect.stringContaining("after download reached 100%"),
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });

    it("cancels immediately without waiting for the close event", async () => {
      const child = new FakeChild();
      const controller = new AbortController();
      const supervisor = supervisePlaywrightInstaller(childProcess(child), {
        signal: controller.signal,
        terminateChild: () => child.kill("SIGKILL"),
      });
      controller.abort();
      await expect(supervisor.result).resolves.toEqual({
        code: null,
        error: "installation cancelled",
        cancelled: true,
      });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });
});
