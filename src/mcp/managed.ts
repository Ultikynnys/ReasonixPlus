/** Servers the app owns end to end (setup flow, auth) rather than the user's own config. */

import { isGmailMailSpec } from "./gmail-mail.js";
import { isOutlookMailSpec } from "./outlook-mail.js";
import { isPlaywrightSpec } from "./playwright-tooling.js";
import type { McpServerSpec } from "./spec.js";

export function isManagedMcpSpec(spec: McpServerSpec): boolean {
  return isPlaywrightSpec(spec) || isOutlookMailSpec(spec) || isGmailMailSpec(spec);
}
