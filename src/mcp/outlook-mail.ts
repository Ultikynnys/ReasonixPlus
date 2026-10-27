import { asRecord, messageOf } from "@reasonix/core-utils";
import type { OutlookSendPreview, PauseGate } from "../core/pause-gate.js";
import type { McpClient } from "./client.js";
import type { McpServerSpec } from "./spec.js";
import type { CallToolResult, McpContentBlock } from "./types.js";

export const OUTLOOK_MAIL_SERVER_NAME = "outlook_mail";
export const OUTLOOK_MAIL_PACKAGE = "@softeria/ms-365-mcp-server@0.85.0";
/** Operations the server may expose, matched by its own `--enabled-tools` regex. The package
 *  ships 124 tools (~600 KB of raw specs); condensed mail operations measure ~20 KB, so the
 *  list stays explicit and administrative folder/rule tools stay off it. */
export const OUTLOOK_MAIL_ENABLED_TOOLS: readonly string[] = [
  "list-mail-messages",
  "list-mail-folders",
  "list-mail-folder-messages",
  "get-mail-message",
  "update-mail-message",
  "delete-mail-message",
  "move-mail-message",
  "send-mail",
  "create-draft-email",
  "send-draft-message",
  "create-reply-draft",
  "create-reply-all-draft",
  "create-forward-draft",
  "get-mailbox-settings",
  "list-mail-attachments",
  "get-mail-attachment",
  "add-mail-attachment",
  "delete-mail-attachment",
  "create-mail-attachment-upload-session",
  // Hidden from the model (see OUTLOOK_MAIL_INTERNAL_TOOLS) but listed here on purpose:
  // the desktop login flow calls these directly, and `get-current-user` carries the
  // `User.Read` scope `verify-login` (GET /me) needs — without it every login reports
  // 403 and sends are blocked.
  "login",
  "logout",
  "verify-login",
  "list-accounts",
  "select-account",
  "remove-account",
  "get-current-user",
];

export const OUTLOOK_MAIL_ENABLED_TOOLS_FILTER = `^(${OUTLOOK_MAIL_ENABLED_TOOLS.join("|")})$`;

export const OUTLOOK_MAIL_ARGS = [
  "-y",
  OUTLOOK_MAIL_PACKAGE,
  "--enabled-tools",
  OUTLOOK_MAIL_ENABLED_TOOLS_FILTER,
] as const;

/** Force the shipped surface onto a bridged Outlook spec: the server reads `--enabled-tools`
 *  once at spawn, and the filter stored in config belongs to the install, not to this build. */
export function withOutlookMailSurface(spec: McpServerSpec): McpServerSpec {
  if (spec.transport !== "stdio" || !isOutlookMailSpec(spec)) return spec;
  const args: string[] = [];
  for (let index = 0; index < spec.args.length; index += 1) {
    const arg = spec.args[index]!;
    if (arg === "--enabled-tools") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--enabled-tools=")) continue;
    args.push(arg);
  }
  args.push("--enabled-tools", OUTLOOK_MAIL_ENABLED_TOOLS_FILTER);
  return { ...spec, args };
}

/** Enabled by the shipped list but never bridged: login and account mutation stay under the
 *  desktop user's control, and the rest could send or bypass the send gate. Keeping them
 *  here also guards a widened `--enabled-tools` list. */
export const OUTLOOK_MAIL_INTERNAL_TOOLS = new Set([
  "login",
  "verify-login",
  "logout",
  "list-accounts",
  "select-account",
  "remove-account",
  // Enabled only so the server requests the User.Read scope verify-login needs;
  // not a mail operation, so keep it off the model surface.
  "get-current-user",
  // These can send without carrying the complete final message in their arguments.
  // Keep them unavailable until Reasonix+ can fetch and bind an immutable preview.
  "reply-mail-message",
  "reply-all-mail-message",
  "forward-mail-message",
  // Generic Graph calls could bypass the dedicated send-mail confirmation gate.
  "graph-batch",
]);

export const OUTLOOK_MAIL_CONFIRMED_SEND_TOOL = "send-mail";
export const OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS = new Set(["send-mail", "send-draft-message"]);

export function isOutlookConfirmedSendTool(toolName: string): boolean {
  return OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS.has(toolName);
}

/** Administrative folder, inbox-rule and mailbox-configuration writes. The shipped enable
 *  list already excludes them, so this is the second guard for a widened surface and for a
 *  user who extends the list in Settings. */
export const OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS: readonly string[] = [
  "create-mail-child-folder",
  "create-mail-folder",
  "create-mail-rule",
  "delete-mail-folder",
  "delete-mail-rule",
  "list-mail-child-folders",
  "list-mail-rules",
  "update-mail-folder",
  "update-mail-rule",
  "update-mailbox-settings",
];

/** Model-facing pointer appended to every bridged Outlook tool description.
 *  Teaches the native attachment path so agents stop hand-encoding base64 (which
 *  is impossible for real files) or dumping a filesystem path into `contentBytes`. */
export const outlookAttachmentGuidance =
  "Attachments: to attach a local file, give its filesystem path in the attachment's `path` field " +
  "(or place the path in `contentBytes`). Reasonix+ reads the file and inlines the raw base64 " +
  "for you; never paste base64 yourself. Inline attachments are capped at 3 MB; larger files need " +
  "create-mail-attachment-upload-session.";

/** Fail-safe classifier for current and future upstream tools that can transmit mail. */
export function isOutlookSendCapableTool(toolName: string): boolean {
  return (
    toolName === "graph-batch" ||
    toolName === "reply-mail-message" ||
    toolName === "reply-all-mail-message" ||
    toolName === "forward-mail-message" ||
    /(^|-)send($|-)/.test(toolName)
  );
}

/** Verbs that mutate mail even when they read a message first (mark-as-read, flags). */
const OUTLOOK_MAIL_MUTATING_VERBS =
  /(^|-)(create|update|delete|add|remove|move|copy|mark|archive|flag|import|upload|set)(-|$)/;

/** Fail-safe read classifier: only list-/get-/search- verbs qualify, and never a
 *  send-capable, account-level, or mutating tool. Read-only mode dispatches these and
 *  refuses every other bridged tool, so an unknown upstream name can never send mail. */
export function isOutlookReadOnlyTool(toolName: string): boolean {
  if (OUTLOOK_MAIL_INTERNAL_TOOLS.has(toolName)) return false;
  if (isOutlookSendCapableTool(toolName)) return false;
  if (OUTLOOK_MAIL_MUTATING_VERBS.test(toolName)) return false;
  return /^(list|get|search)-/.test(toolName);
}

export function isOutlookMailSpec(spec: McpServerSpec): boolean {
  if (spec.transport !== "stdio" || spec.name !== OUTLOOK_MAIL_SERVER_NAME) return false;
  return spec.args.some((arg) => /^@softeria\/ms-365-mcp-server(?:@[A-Za-z0-9._-]+)?$/.test(arg));
}

/** Every Outlook tool the model must not reach: the internals, the default-off writes, and
 *  send-capable tools that are not yet able to produce a bound confirmation preview. */
export async function outlookMailHiddenTools(
  spec: McpServerSpec,
  client: Pick<McpClient, "listTools">,
): Promise<ReadonlySet<string>> {
  if (!isOutlookMailSpec(spec)) return new Set<string>();
  const hidden = new Set<string>([
    ...OUTLOOK_MAIL_INTERNAL_TOOLS,
    ...OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS,
  ]);
  const listed = await client.listTools();
  for (const tool of listed.tools) {
    if (!isOutlookConfirmedSendTool(tool.name) && isOutlookSendCapableTool(tool.name)) {
      hidden.add(tool.name);
    }
  }
  return hidden;
}

interface MailAddress {
  emailAddress?: { address?: unknown };
  EmailAddress?: { Address?: unknown };
  address?: unknown;
  Address?: unknown;
}

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string" && entry.length > 0) return entry;
      const m = entry as MailAddress;
      const addr = m?.emailAddress?.address ?? m?.EmailAddress?.Address ?? m?.address ?? m?.Address;
      return typeof addr === "string" && addr.length > 0 ? addr : null;
    })
    .filter((address): address is string => Boolean(address));
}

/** Shared body/subject/recipient/attachment extraction for the send and draft previews. */
function extractMailFields(
  src: Record<string, unknown>,
  /** Draft messages fall back to `bodyPreview` when the body is empty. */
  opts: { bodyPreviewFallback?: boolean } = {},
): Omit<OutlookSendPreview, "from" | "toolName"> {
  const bodyField = src.body ?? src.Body;
  const bodyContent =
    typeof bodyField === "string"
      ? bodyField
      : (asRecord(bodyField)?.content ??
        asRecord(bodyField)?.Content ??
        (opts.bodyPreviewFallback ? (src.bodyPreview ?? src.BodyPreview) : undefined));
  const subject = src.subject ?? src.Subject;
  const rawAttachments = src.attachments ?? src.Attachments;
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
        .map((attachment) => asRecord(attachment)?.name ?? asRecord(attachment)?.Name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return {
    to: addressList(src.toRecipients ?? src.ToRecipients),
    cc: addressList(src.ccRecipients ?? src.CcRecipients),
    bcc: addressList(src.bccRecipients ?? src.BccRecipients),
    subject: typeof subject === "string" ? subject : "",
    body: typeof bodyContent === "string" ? bodyContent : "",
    attachments,
  };
}

export function parseOutlookSendArgs(
  toolName: string,
  args: Record<string, unknown>,
): Omit<OutlookSendPreview, "from"> | null {
  if (toolName !== "send-mail") return null;
  const requestBody = asRecord(args.body) ?? asRecord(args.Body) ?? args;
  const message = asRecord(
    requestBody.message ?? requestBody.Message ?? args.message ?? args.Message ?? requestBody,
  );
  if (!message) return null;
  return { toolName, ...extractMailFields(message) };
}

export function extractOutlookMessageId(args: Record<string, unknown>): string | null {
  const body = asRecord(args.body) ?? asRecord(args.Body);
  const candidate =
    args.messageId ??
    args.MessageId ??
    args["message-id"] ??
    args.id ??
    args.Id ??
    body?.messageId ??
    body?.MessageId ??
    body?.["message-id"] ??
    body?.id ??
    body?.Id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

export function parseOutlookDraftMessage(
  toolName: string,
  draft: Record<string, unknown>,
): Omit<OutlookSendPreview, "from"> {
  return { toolName, ...extractMailFields(draft, { bodyPreviewFallback: true }) };
}

export async function confirmOutlookSend(opts: {
  toolName: string;
  args: Record<string, unknown>;
  client: McpClient;
  gate?: PauseGate;
}): Promise<string | null> {
  if (!isOutlookSendCapableTool(opts.toolName)) return null;

  if (!isOutlookConfirmedSendTool(opts.toolName)) {
    return JSON.stringify({
      error: `Outlook email operation blocked: ${opts.toolName} cannot be safely confirmed. Use send-mail or create a draft and send with send-draft-message.`,
      rejectedReason: "unsupported-send-tool",
    });
  }

  if (!opts.gate) {
    return JSON.stringify({
      error: "Outlook email send blocked: no interactive confirmation gate is available.",
      rejectedReason: "confirmation-unavailable",
    });
  }

  let partial: Omit<OutlookSendPreview, "from"> | null = null;

  if (opts.toolName === "send-mail") {
    partial = parseOutlookSendArgs(opts.toolName, opts.args);
  } else if (opts.toolName === "send-draft-message") {
    const messageId = extractOutlookMessageId(opts.args);
    if (!messageId) {
      return JSON.stringify({
        error: "Outlook email send blocked: messageId is required to send a draft.",
        rejectedReason: "incomplete-email-preview",
      });
    }

    try {
      let draftResult: CallToolResult;
      try {
        draftResult = await opts.client.callTool("get-mail-message", {
          messageId,
          expand: ["attachments"],
        });
      } catch {
        draftResult = await opts.client.callTool("get-mail-message", { messageId });
      }
      const draftText = mcpTextResult(draftResult).trim();
      const draft = JSON.parse(draftText) as Record<string, unknown>;
      if (draft.error) {
        return JSON.stringify({
          error: `Outlook email send blocked: draft message could not be loaded (${String(draft.error)}).`,
          rejectedReason: "draft-not-found",
        });
      }
      partial = parseOutlookDraftMessage(opts.toolName, draft);
      if (
        partial.attachments.length === 0 &&
        (draft.hasAttachments === true || draft.HasAttachments === true)
      ) {
        try {
          const attResult = await opts.client.callTool("list-mail-attachments", { messageId });
          const attText = mcpTextResult(attResult).trim();
          const parsedAtt = JSON.parse(attText) as Record<string, unknown>;
          const items = Array.isArray(parsedAtt)
            ? parsedAtt
            : Array.isArray(parsedAtt?.value)
              ? (parsedAtt.value as unknown[])
              : [];
          const names = items
            .map((att) => asRecord(att)?.name ?? asRecord(att)?.Name)
            .filter((name): name is string => typeof name === "string" && name.length > 0);
          if (names.length > 0) {
            partial.attachments = names;
          }
        } catch {
          // Non-fatal: if attachment listing fails, still proceed with draft's existing attachments
        }
      }
    } catch (err) {
      return JSON.stringify({
        error: `Outlook email send blocked: failed to inspect draft message before sending (${messageOf(err)}).`,
        rejectedReason: "draft-not-found",
      });
    }
  }

  if (!partial) {
    return JSON.stringify({
      error: "Outlook email send blocked: could not parse email preview.",
      rejectedReason: "incomplete-email-preview",
    });
  }

  if (partial.to.length === 0 || !partial.subject || !partial.body) {
    return JSON.stringify({
      error:
        "Outlook email send blocked: a complete preview requires at least one To recipient, subject, and body.",
      rejectedReason: "incomplete-email-preview",
    });
  }

  const login = parseOutlookLoginStatus(await opts.client.callTool("verify-login", {}));
  if (!login.success || !login.account) {
    return JSON.stringify({
      error: "Outlook email send blocked: the authenticated From address could not be verified.",
      rejectedReason: "sender-unverified",
    });
  }

  const verdict = await opts.gate.ask({
    kind: "outlook_send",
    payload: { ...partial, from: login.account },
  });
  if (verdict.type !== "run_once") {
    return JSON.stringify({
      error: "Outlook email send cancelled by the user. Nothing was sent.",
      rejectedReason: "user-denied",
    });
  }
  return null;
}

export function mcpTextResult(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<McpContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface OutlookLoginStatus {
  success: boolean;
  message: string;
  account?: string;
}

export function parseOutlookLoginStatus(result: CallToolResult | string): OutlookLoginStatus {
  const text = (typeof result === "string" ? result : mcpTextResult(result)).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { success: false, message: text || "Microsoft sign-in returned an empty response" };
  }
  const userData =
    parsed.userData && typeof parsed.userData === "object"
      ? (parsed.userData as Record<string, unknown>)
      : undefined;
  const account =
    typeof userData?.userPrincipalName === "string" ? userData.userPrincipalName : undefined;
  return {
    success: parsed.success === true,
    message:
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : "Microsoft sign-in status unavailable",
    ...(account ? { account } : {}),
  };
}

export interface OutlookDeviceCode {
  verificationUrl: string;
  userCode?: string;
  message: string;
}

const MICROSOFT_LOGIN_HOSTS = new Set([
  "microsoft.com",
  "www.microsoft.com",
  "login.microsoftonline.com",
]);

export function isTrustedMicrosoftLoginUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && MICROSOFT_LOGIN_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseOutlookDeviceCode(result: CallToolResult | string): OutlookDeviceCode | null {
  const text = (typeof result === "string" ? result : mcpTextResult(result)).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.error !== "device_code_required" || typeof parsed.message !== "string") return null;
  const message = parsed.message.trim();
  const url = message.match(/https:\/\/[^\s)]+/i)?.[0]?.replace(/[.,;]+$/, "");
  if (!url || !isTrustedMicrosoftLoginUrl(url)) return null;
  const explicitCode = message.match(/\bcode\s+(?:is\s+)?([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)/i)?.[1];
  return {
    verificationUrl: url,
    ...(explicitCode ? { userCode: explicitCode.toUpperCase() } : {}),
    message,
  };
}
