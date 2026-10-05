// First import — reject unsupported Node versions before heavier startup
// paths can turn an engine mismatch into an opaque crash.
import "./node-version-guard.js";

// Then re-exec with a bigger V8 heap when Node's stock 2 GiB cap is in force
// (issue #1011). Side-effect on module load, before any heavy import below runs.
import "./heap-limit-launch.js";

// Wrap stdout/stderr before any third-party lib gets a chance to emit BEL on
// Windows cmd, which would beep the system bell every render (#1786).
import "./strip-bel.js";

import { isReasoningEffort, loadProxyConfig, saveReasoningEffort } from "../config.js";
import { installProxyIfConfigured } from "../net/proxy.js";
import { resolveDefaults } from "./resolve.js";
import { markPhase } from "./startup-profile.js";

// HTTPS_PROXY / HTTP_PROXY only reach Node's fetch via undici's global
// dispatcher; install before any client (DeepSeek, web tools) constructs a
// fetch closure (#646). `--no-proxy` is read straight off argv (there is no CLI
// parser), so its position doesn't matter and we can honor it before any fetch
// closure captures the dispatcher.
const cliNoProxy = process.argv.includes("--no-proxy");
const cfgProxy = loadProxyConfig();
installProxyIfConfigured(process.env, {
  disabled: cliNoProxy || cfgProxy.disabled === true,
  url: cfgProxy.url,
  extraNoProxy: cfgProxy.noProxy,
  bypassDeepSeekDirect: cfgProxy.bypassDeepSeekDirect,
});

markPhase("cli_module_loaded");

function persistEffortFlag(flag: unknown): void {
  if (typeof flag !== "string") return;
  const v = flag.toLowerCase();
  if (!isReasoningEffort(v)) return;
  try {
    saveReasoningEffort(v);
  } catch {
    /* best-effort */
  }
}

/** Read `--flag <value>` or `--flag=value` from argv (there is no CLI parser). */
function readOption(name: string, alias?: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === name || (alias !== undefined && arg === alias)) return argv[i + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

// The desktop app is the only product surface. The Tauri shell spawns this
// entry as `node dist/cli/index.js desktop` and speaks JSON-RPC over stdio
// (desktop/src-tauri/src/rpc.rs). There is no user-facing CLI.
async function main(): Promise<void> {
  const effort = readOption("--effort");
  persistEffortFlag(effort);
  const defaults = resolveDefaults({
    model: readOption("--model", "-m"),
    mcp: [],
    effort,
    noConfig: false,
  });
  markPhase("desktop_import_started");
  const { desktopCommand } = await import("./commands/desktop.js");
  markPhase("desktop_import_completed");
  await desktopCommand({
    model: defaults.model,
    dir: readOption("--dir"),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
