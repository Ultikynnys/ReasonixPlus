import { randomBytes } from "node:crypto";
import type { ToolSpec } from "./types.js";

/** OpenCode release the wire shape was copied from. Only the shape matters to the
 *  gateway, so this may lag the real release. */
export const OPENCODE_SPOOF_VERSION = "2.1.3";

/** `opencode/<channel>/<version>/<artifact>` — `App.useragent()` upstream. */
export const OPENCODE_USER_AGENT = `opencode/latest/${OPENCODE_SPOOF_VERSION}/cli`;

/** The build artifact the CLI reports as its app name, and in `x-opencode-client`. */
const OPENCODE_CLIENT = "cli";

/** Base62, in OpenCode's own character order. */
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Buffer): string {
  let out = "";
  for (const byte of bytes) out += ID_CHARS[byte % 62];
  return out;
}

/** One run's OpenCode request identity. Both values are fresh randomness, never
 *  derived from the conversation or the workspace, so no two runs can be linked. */
export interface OpencodeIdentity {
  /** `ses_<26>`: 12 hex chars then 14 base62, the shape upstream's generator emits. */
  readonly session: string;
  /** 40 hex chars, the shape upstream uses for a project id. */
  readonly project: string;
}

export function createOpencodeIdentity(): OpencodeIdentity {
  return {
    session: `ses_${randomBytes(6).toString("hex")}${base62(randomBytes(14))}`,
    project: randomBytes(20).toString("hex"),
  };
}

let current: OpencodeIdentity | undefined;

/** The identity this process sends. Created on first use and kept until the process
 *  exits or the gateway rejects it, so it lives exactly as long as the run does. */
export function opencodeIdentity(): OpencodeIdentity {
  current ??= createOpencodeIdentity();
  return current;
}

/** Replace the process identity after the gateway rejects the current one. */
export function rotateOpencodeIdentity(): OpencodeIdentity {
  current = createOpencodeIdentity();
  return current;
}

/** Every identity header one model request carries. */
export function opencodeIdentityHeaders(identity: OpencodeIdentity): Record<string, string> {
  return {
    "x-opencode-session-id": identity.session,
    "x-session-affinity": identity.session,
    "X-Session-Id": identity.session,
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-project": identity.project,
    "x-opencode-session": identity.session,
    "x-opencode-client": OPENCODE_CLIENT,
  };
}

/** Required by the free-tier gateway; the registry serves the same name. */
export const OPENCODE_REQUIRED_TOOL = "read";

export const OPENCODE_READ_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: OPENCODE_REQUIRED_TOOL,
    description: "Read a file. Relative paths resolve under the sandbox root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

/** Preserve caller tools and append the sole tool required by OpenCode's free
 *  tier only when it is absent. */
export function withOpencodeRequiredTool(tools: readonly ToolSpec[] = []): readonly ToolSpec[] {
  return tools.some((tool) => tool.function.name === OPENCODE_REQUIRED_TOOL)
    ? tools
    : [...tools, OPENCODE_READ_TOOL];
}
