/** add_mcp_server / remove_mcp_server / list_mcp_bridges — temp configPath so the tool never
 *  touches the real config. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, saveMcpOAuth, writeConfig } from "../src/config.js";
import { ToolRegistry } from "../src/tools.js";
import { registerScaffoldTools } from "../src/tools/scaffold.js";
import { mcpCreds } from "./support/oauth-fixture.js";

interface Setup {
  home: string;
  projectRoot: string;
  configPath: string;
  reg: ToolRegistry;
}

function setup(): Setup {
  const home = mkdtempSync(join(tmpdir(), "reasonix-scaffold-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "reasonix-scaffold-proj-"));
  const configPath = join(home, "config.json");
  const reg = new ToolRegistry();
  registerScaffoldTools(reg, { projectRoot, configPath });
  return { home, projectRoot, configPath, reg };
}

function teardown(s: Setup): void {
  rmSync(s.home, { recursive: true, force: true });
  rmSync(s.projectRoot, { recursive: true, force: true });
}

async function call(reg: ToolRegistry, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await reg.dispatch(name, JSON.stringify(args));
  return JSON.parse(out);
}

describe("add_mcp_server", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("registers a stdio server in cfg.mcp", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "myserver",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(r.success).toBe(true);
    expect(r.transport).toBe("stdio");
    expect(r.spec).toBe("myserver=node server.js");
    const cfg = readConfig(s.configPath);
    expect(cfg.mcp).toEqual(["myserver=node server.js"]);
  });

  it("registers a streamable-http server with the streamable+ prefix", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "remote",
      transport: "streamable-http",
      url: "https://example.com/mcp",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("remote=streamable+https://example.com/mcp");
  });

  it("registers an SSE server", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "events",
      transport: "sse",
      url: "https://example.com/events",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("events=https://example.com/events");
  });

  it("fills command + args from the catalog when from_catalog is set", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "memory",
      from_catalog: "memory",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("memory=npx -y @modelcontextprotocol/server-memory");
  });

  it("resolves the playwright catalog entry with no required user args", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "pw",
      from_catalog: "playwright",
    });
    expect(r.success).toBe(true);
    expect(r.spec).toBe("pw=npx -y @playwright/mcp");
    // The catalog note must distinguish supported extension and Chromium CDP setup.
    expect(r.install_note).toContain("--extension");
    expect(r.install_note).toContain("Chrome/Edge");
    expect(r.install_note).toContain("--cdp-endpoint");
  });

  it("requires user-args for catalog entries that need them", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "fs",
      from_catalog: "filesystem",
    });
    expect(r.error).toMatch(/needs <dir>/);
  });

  it("preflights the filesystem sandbox and refuses missing directories", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "fs",
      from_catalog: "filesystem",
      args: [join(tmpdir(), "definitely-does-not-exist-xyz-12345")],
    });
    expect(r.error).toMatch(/does not exist/);
  });

  it("rejects a name collision with an existing entry", async () => {
    await call(s.reg, "add_mcp_server", {
      name: "dup",
      transport: "stdio",
      command: "node",
      args: ["a.js"],
    });
    const r = await call(s.reg, "add_mcp_server", {
      name: "dup",
      transport: "stdio",
      command: "node",
      args: ["b.js"],
    });
    expect(r.error).toMatch(/already registered/);
  });

  it("rejects a non-http url", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "bad",
      transport: "sse",
      url: "ftp://example.com",
    });
    expect(r.error).toMatch(/http/);
  });

  it("rejects an unknown catalog entry", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "x",
      from_catalog: "not-a-real-server",
    });
    expect(r.error).toMatch(/unknown catalog/);
  });

  it("requires transport when from_catalog is absent", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "x",
    });
    expect(r.error).toMatch(/transport/);
  });

  it("rejects collision against mcpServers object format", async () => {
    writeConfig(
      {
        mcpServers: {
          existing: {
            command: "uvx",
            args: ["blender-mcp"],
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "add_mcp_server", {
      name: "existing",
      transport: "stdio",
      command: "node",
      args: ["test.js"],
    });
    expect(r.error).toMatch(/already registered/);
  });
});

describe("list_mcp_bridges", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("returns empty bridges list when no servers configured", async () => {
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(0);
    expect(r.bridges).toEqual([]);
  });

  it("lists configured servers from cfg.mcp and cfg.mcpServers", async () => {
    writeConfig(
      {
        mcp: ["legacy=node legacy.js"],
        mcpServers: {
          blender: {
            command: "uvx.exe",
            args: ["--python", "3.11", "blender-mcp"],
          },
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(3);
    const names = r.bridges.map((b: any) => b.name).sort();
    expect(names).toEqual(["blender", "legacy", "remote"]);

    const blender = r.bridges.find((b: any) => b.name === "blender");
    expect(blender).toMatchObject({
      name: "blender",
      transport: "stdio",
      status: "configured",
      disabled: false,
      command: "uvx.exe",
      args: ["--python", "3.11", "blender-mcp"],
      tool_count: 0,
      tools: [],
    });
  });

  it("lists project-level .mcp.json servers", async () => {
    writeFileSync(
      join(s.projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          project_srv: {
            command: "npx",
            args: ["-y", "proj-mcp"],
          },
        },
      }),
      "utf8",
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    expect(r.bridges[0].name).toBe("project_srv");
  });

  it("reflects connected status and bridged tools when registered in tool registry", async () => {
    writeConfig(
      {
        mcpServers: {
          blender: {
            command: "uvx",
            args: ["blender-mcp"],
          },
        },
      },
      s.configPath,
    );

    // Simulate bridged tools in registry
    s.reg.register({
      name: "blender_render_scene",
      description: "Render current scene in Blender",
      parameters: { type: "object" },
      fn: async () => "rendered",
    });
    s.reg.register({
      name: "blender_get_objects",
      description: "Get scene objects",
      parameters: { type: "object" },
      fn: async () => "objects",
    });

    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    const blender = r.bridges[0];
    expect(blender.status).toBe("connected");
    expect(blender.tool_count).toBe(2);
    expect(blender.tools).toEqual([
      { name: "blender_render_scene", description: "Render current scene in Blender" },
      { name: "blender_get_objects", description: "Get scene objects" },
    ]);
  });

  it("reflects disabled status when marked disabled", async () => {
    writeConfig(
      {
        mcpServers: {
          disabled_srv: {
            command: "node",
            args: ["srv.js"],
            disabled: true,
          },
        },
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.count).toBe(1);
    expect(r.bridges[0].status).toBe("disabled");
    expect(r.bridges[0].disabled).toBe(true);
  });

  it("stays available in Read only because it only reads", async () => {
    s.reg.setPlanMode(true);
    const r = await call(s.reg, "list_mcp_bridges", {});
    expect(r.error).toBeUndefined();
    expect(typeof r.count).toBe("number");
  });

  it("filters by exact bridge name", async () => {
    writeConfig(
      {
        mcp: ["a=node a.js", "b=node b.js"],
      },
      s.configPath,
    );
    const r = await call(s.reg, "list_mcp_bridges", { name: "b" });
    expect(r.count).toBe(1);
    expect(r.bridges[0].name).toBe("b");
  });

  it("uses getMcpSpecs so live tools win over the config default", async () => {
    writeConfig(
      {
        mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } },
      },
      s.configPath,
    );
    const live = new ToolRegistry();
    registerScaffoldTools(live, {
      projectRoot: s.projectRoot,
      configPath: s.configPath,
      getMcpSpecs: () => [
        {
          transport: "stdio",
          name: "blender",
          command: "uvx",
          args: ["blender-mcp"],
          disabled: true,
        },
      ],
    });
    live.register({
      name: "blender_render",
      description: "Render",
      parameters: { type: "object" },
      fn: async () => "ok",
    });

    const r = await call(live, "list_mcp_bridges", {});

    expect(r.bridges[0].disabled).toBe(true);
    expect(r.bridges[0].status).toBe("connected");
    expect(r.bridges[0].tool_count).toBe(1);
  });
});

describe("remove_mcp_server", () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(() => {
    teardown(s);
  });

  it("drops a legacy mcp spec entry", async () => {
    writeConfig({ mcp: ["a=node a.js", "b=node b.js"] }, s.configPath);

    const r = await call(s.reg, "remove_mcp_server", { name: "a" });

    expect(r.success).toBe(true);
    expect(r.removed).toEqual(["mcp spec"]);
    expect(readConfig(s.configPath).mcp).toEqual(["b=node b.js"]);
  });

  it("drops the object entry with its env overlay, flag and sign-in", async () => {
    writeConfig(
      {
        mcpServers: { blender: { command: "uvx", args: ["blender-mcp"], disabled: true } },
        mcpDisabled: ["blender"],
        mcpEnv: { blender: { TOKEN: "t" } },
      },
      s.configPath,
    );
    saveMcpOAuth("blender", mcpCreds(), s.configPath);

    const r = await call(s.reg, "remove_mcp_server", { name: "blender" });

    expect(r.success).toBe(true);
    expect(r.removed).toEqual(["mcpServers entry", "env overlay", "sign-in", "disabled flag"]);
    const cfg = readConfig(s.configPath);
    expect(cfg.mcpServers).toBeUndefined();
    expect(cfg.mcpEnv).toBeUndefined();
    expect(cfg.mcpOAuth).toBeUndefined();
    expect(cfg.mcpDisabled).toBeUndefined();
  });

  it("keeps the other servers and their sign-ins", async () => {
    writeConfig(
      {
        mcpServers: {
          keep: { command: "node", args: ["keep.js"] },
          drop: { command: "node", args: ["drop.js"] },
        },
      },
      s.configPath,
    );
    saveMcpOAuth("keep", mcpCreds({ accessToken: "keep-token" }), s.configPath);
    saveMcpOAuth("drop", mcpCreds({ accessToken: "drop-token" }), s.configPath);

    await call(s.reg, "remove_mcp_server", { name: "drop" });

    const cfg = readConfig(s.configPath);
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["keep"]);
    expect(cfg.mcpOAuth?.drop).toBeUndefined();
    expect(cfg.mcpOAuth?.keep?.accessToken).toBe("keep-token");
  });

  it("names the configured servers when the name is unknown", async () => {
    writeConfig({ mcp: ["a=node a.js"] }, s.configPath);

    const r = await call(s.reg, "remove_mcp_server", { name: "ghost" });

    expect(r.error).toMatch(/no MCP server named "ghost"/);
    expect(r.error).toMatch(/Configured: a/);
    expect(readConfig(s.configPath).mcp).toEqual(["a=node a.js"]);
  });

  it("says nothing is configured when the config is empty", async () => {
    const r = await call(s.reg, "remove_mcp_server", { name: "ghost" });
    expect(r.error).toMatch(/None are configured/);
  });

  it("points at the config for a spec with no name prefix", async () => {
    writeConfig({ mcp: ["node anon.js"] }, s.configPath);

    const r = await call(s.reg, "remove_mcp_server", { name: "ghost" });

    expect(r.error).toMatch(/no name prefix cannot be removed by name/);
  });

  it("treats an inherited object key as no server at all", async () => {
    writeConfig(
      { mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } },
      s.configPath,
    );

    const r = await call(s.reg, "remove_mcp_server", { name: "__proto__" });

    expect(r.error).toMatch(/no MCP server named "__proto__"/);
    expect(readConfig(s.configPath).mcpServers?.blender).toBeDefined();
  });

  it("refuses a server the project .mcp.json declares", async () => {
    writeFileSync(
      join(s.projectRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: { project_srv: { command: "npx", args: ["-y", "proj"] } } }),
      "utf8",
    );

    const r = await call(s.reg, "remove_mcp_server", { name: "project_srv" });

    expect(r.error).toMatch(/\.mcp\.json/);
    expect(existsSync(s.configPath)).toBe(false);
  });

  it("refuses an app-managed integration", async () => {
    writeConfig(
      {
        mcpServers: { pw: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] } },
      },
      s.configPath,
    );

    const r = await call(s.reg, "remove_mcp_server", { name: "pw" });

    expect(r.error).toMatch(/Settings/);
    expect(Object.keys(readConfig(s.configPath).mcpServers ?? {})).toEqual(["pw"]);
  });

  it("refuses a server a plugin declares", async () => {
    writeConfig(
      {
        mcpServers: {
          notfair: { url: "https://notfair.co/api/mcp/notfair", type: "http", plugin: "notfair" },
        },
      },
      s.configPath,
    );

    const r = await call(s.reg, "remove_mcp_server", { name: "notfair" });

    expect(r.error).toMatch(/uninstall_plugin/);
    expect(readConfig(s.configPath).mcpServers?.notfair).toBeDefined();
  });

  it("requires a name", async () => {
    const r = await call(s.reg, "remove_mcp_server", { name: "  " });
    expect(r.error).toMatch(/requires 'name'/);
  });

  it("tells a host to refresh after the write", async () => {
    writeConfig({ mcp: ["a=node a.js"] }, s.configPath);
    const changes: string[] = [];
    const live = new ToolRegistry();
    registerScaffoldTools(live, {
      projectRoot: s.projectRoot,
      configPath: s.configPath,
      onCapabilitiesChanged: (kind, change) => changes.push(`${kind}:${change}`),
    });

    await call(live, "remove_mcp_server", { name: "a" });
    await call(live, "add_mcp_server", { name: "b", transport: "stdio", command: "node" });

    expect(changes).toEqual(["mcp:removed", "mcp:installed"]);
  });

  it("promises the new server to a new chat, never to this one", async () => {
    const r = await call(s.reg, "add_mcp_server", {
      name: "later",
      transport: "stdio",
      command: "node",
    });

    expect(r.success).toBe(true);
    expect(r.enabled_in_this_chat).toBe(false);
    expect(r.note).toMatch(/chats created after this one/);
  });

  it("is refused in Read only mode because it writes the config", async () => {
    writeConfig({ mcp: ["a=node a.js"] }, s.configPath);
    s.reg.setPlanMode(true);

    const r = await call(s.reg, "remove_mcp_server", { name: "a" });

    expect(r.rejectedReason).toBe("read-only");
    expect(readConfig(s.configPath).mcp).toEqual(["a=node a.js"]);
  });
});
