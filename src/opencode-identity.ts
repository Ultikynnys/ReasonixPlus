import { createHash } from "node:crypto";
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

function base62(bytes: Buffer, from: number, length: number): string {
  let out = "";
  for (let i = from; i < from + length; i += 1) out += ID_CHARS[bytes[i]! % 62];
  return out;
}

/** A `ses_<26>` id for a conversation: 12 hex chars, then 14 base62, matching the
 *  shape upstream's descending identifier generator produces. */
export function opencodeSessionId(conversation: string): string {
  const digest = createHash("sha256").update(`reasonix-session:${conversation}`).digest();
  return `ses_${digest.toString("hex", 0, 6)}${base62(digest, 6, 14)}`;
}

/** A project id for a workspace directory — upstream hashes the directory too, so
 *  the value is a hash rather than an id we invent. */
export function opencodeProjectId(directory: string): string {
  return createHash("sha1").update(`directory:${directory}`).digest("hex");
}

/** Every identity header one model request carries. `session` must already be a
 *  session id from `opencodeSessionId`. */
export function opencodeIdentityHeaders(
  session: string,
  directory: string,
): Record<string, string> {
  return {
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "X-Session-Id": session,
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-project": opencodeProjectId(directory),
    "x-opencode-session": session,
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
