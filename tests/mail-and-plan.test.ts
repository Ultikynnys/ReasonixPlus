// Consolidated from 8 per-module test files; each source keeps its own
// describe() wrapper so its helpers stay file-scoped. Test bodies are unchanged.

import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangelogRelease } from "@reasonix/core-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRelease,
  groupReleases,
  groupSections,
  isMergeCommit,
  parseCommitSubject,
  releaseVersion,
  shortHash,
  toReleases,
} from "../packages/core-utils/src/changelog.js";
import {
  CHANGELOG_CACHE_TTL_MS,
  changelogCachePath,
  fetchChangelog,
  loadChangelogCache,
  writeChangelogCache,
} from "../src/changelog.js";
import { isManagedMcpSpec } from "../src/cli/commands/desktop.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";
import { EN } from "../src/i18n/EN.js";
import { t } from "../src/i18n/index.js";
import type { TranslationSchema } from "../src/i18n/types.js";
import {
  GMAIL_MCP_URL,
  GMAIL_OAUTH_REDIRECT_URI,
  GMAIL_SCOPES,
  buildGmailAuthorizeUrl,
  isGmailMailSpec,
} from "../src/mcp/gmail-mail.js";
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  hydrateOutlookAttachments,
  inferAttachmentContentType,
  looksLikeBase64,
  looksLikeFilePath,
} from "../src/mcp/outlook-attachments.js";
import {
  OUTLOOK_MAIL_ARGS,
  OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS,
  OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS,
  OUTLOOK_MAIL_ENABLED_TOOLS,
  OUTLOOK_MAIL_ENABLED_TOOLS_FILTER,
  OUTLOOK_MAIL_INTERNAL_TOOLS,
  confirmOutlookSend,
  extractOutlookMessageId,
  isOutlookConfirmedSendTool,
  isOutlookMailSpec,
  isOutlookReadOnlyTool,
  isOutlookSendCapableTool,
  isTrustedMicrosoftLoginUrl,
  outlookMailHiddenTools,
  parseOutlookDeviceCode,
  parseOutlookDraftMessage,
  parseOutlookLoginStatus,
  parseOutlookSendArgs,
  withOutlookMailSurface,
} from "../src/mcp/outlook-mail.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import { type McpServerSpec, parseMcpSpec } from "../src/mcp/spec.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";
import { ToolRegistry } from "../src/tools.js";
import { ChoiceRequestedError, registerChoiceTool } from "../src/tools/choice.js";
import {
  PlanProposedError,
  PlanRevisionProposedError,
  type StepCompletion,
  registerPlanTool,
} from "../src/tools/plan.js";

describe("gmail-mail-mcp", () => {
  describe("managed Gmail MCP", () => {
    it("recognizes only the managed named official Streamable HTTP endpoint", () => {
      expect(isGmailMailSpec(parseMcpSpec(`gmail_mail=streamable+${GMAIL_MCP_URL}`))).toBe(true);
      expect(isGmailMailSpec(parseMcpSpec(`other=streamable+${GMAIL_MCP_URL}`))).toBe(false);
      expect(isGmailMailSpec(parseMcpSpec("gmail_mail=streamable+https://example.com/mcp"))).toBe(
        false,
      );
    });

    it("builds a PKCE Google authorization request with the documented Gmail scopes", () => {
      const url = new URL(
        buildGmailAuthorizeUrl({
          clientId: "client.apps.googleusercontent.com",
          redirectUri: GMAIL_OAUTH_REDIRECT_URI,
          state: "state-value",
          codeChallenge: "challenge-value",
        }),
      );
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("client_id")).toBe("client.apps.googleusercontent.com");
      expect(url.searchParams.get("redirect_uri")).toBe(GMAIL_OAUTH_REDIRECT_URI);
      expect(url.searchParams.get("state")).toBe("state-value");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GMAIL_SCOPES]);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
    });
  });
});

describe("outlook-mail-mcp", () => {
  describe("managed Outlook Mail MCP", () => {
    it("recognizes only the managed named Softeria stdio server", () => {
      expect(
        isOutlookMailSpec(parseMcpSpec(`outlook_mail=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`)),
      ).toBe(true);
      expect(isOutlookMailSpec(parseMcpSpec(`other=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`))).toBe(
        false,
      );
      expect(isOutlookMailSpec(parseMcpSpec("outlook_mail=npx -y another-package"))).toBe(false);
    });

    it("classifies Outlook Mail as a managed built-in just like Playwright", () => {
      expect(
        isManagedMcpSpec(parseMcpSpec(`outlook_mail=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`)),
      ).toBe(true);
      expect(isManagedMcpSpec(parseMcpSpec("playwright=npx -y @playwright/mcp"))).toBe(true);
      expect(isManagedMcpSpec(parseMcpSpec("custom=npx -y custom-mcp"))).toBe(false);
    });

    it("spawns with a curated allow-list that keeps every gated tool", () => {
      const filter = OUTLOOK_MAIL_ARGS[OUTLOOK_MAIL_ARGS.indexOf("--enabled-tools") + 1]!;
      expect(filter).toBe(OUTLOOK_MAIL_ENABLED_TOOLS_FILTER);
      // Anchored: an unanchored alternation would also match future names that merely
      // contain one of these substrings.
      expect(filter.startsWith("^(")).toBe(true);
      expect(filter.endsWith(")$")).toBe(true);

      const enabled = new Set(OUTLOOK_MAIL_ENABLED_TOOLS);
      // The confirmation gate and the attachment hydration path call these by name.
      for (const required of [
        "send-mail",
        "send-draft-message",
        "create-reply-draft",
        "create-reply-all-draft",
        "create-forward-draft",
        "update-mail-message",
        "get-mail-message",
        "list-mail-attachments",
        "add-mail-attachment",
        "verify-login",
        "get-current-user",
      ]) {
        expect(enabled.has(required)).toBe(true);
      }
      // Send paths that carry no full message stay off the surface, and so do the
      // administrative folder/rule tools.
      for (const excluded of [
        "reply-mail-message",
        "reply-all-mail-message",
        "forward-mail-message",
        "graph-batch",
        "create-mail-folder",
        "update-mail-rule",
        "update-mailbox-settings",
      ]) {
        expect(enabled.has(excluded)).toBe(false);
      }
    });

    it("rewrites a stale enabled-tools filter before bridging", () => {
      const stdioArgs = (spec: McpServerSpec): string[] => {
        if (spec.transport !== "stdio") throw new Error("expected a stdio spec");
        return spec.args;
      };
      const stale = parseMcpSpec(
        "outlook_mail=npx -y @softeria/ms-365-mcp-server@0.85.0 --enabled-tools mail|attachment|draft|get-current-user",
      );
      const args = stdioArgs(withOutlookMailSurface(stale));
      expect(args.filter((arg) => arg === "--enabled-tools")).toHaveLength(1);
      expect(args[args.indexOf("--enabled-tools") + 1]).toBe(OUTLOOK_MAIL_ENABLED_TOOLS_FILTER);
      expect(args).not.toContain("mail|attachment|draft|get-current-user");

      const inline = parseMcpSpec(
        "outlook_mail=npx -y @softeria/ms-365-mcp-server --enabled-tools=mail",
      );
      const inlineArgs = stdioArgs(withOutlookMailSurface(inline));
      expect(inlineArgs).toContain(OUTLOOK_MAIL_ENABLED_TOOLS_FILTER);
      expect(inlineArgs.some((arg) => arg.startsWith("--enabled-tools="))).toBe(false);

      // Any other server keeps the args it was configured with.
      const other = parseMcpSpec("custom=npx -y custom-mcp --enabled-tools mail");
      expect(withOutlookMailSurface(other)).toEqual(other);
    });

    it("classifies every direct or indirect send-capable tool fail-safe", () => {
      expect(isOutlookSendCapableTool("send-mail")).toBe(true);
      expect(isOutlookSendCapableTool("send-draft-message")).toBe(true);
      expect(isOutlookSendCapableTool("reply-mail-message")).toBe(true);
      expect(isOutlookSendCapableTool("reply-all-mail-message")).toBe(true);
      expect(isOutlookSendCapableTool("forward-mail-message")).toBe(true);
      expect(isOutlookSendCapableTool("graph-batch")).toBe(true);
      expect(isOutlookSendCapableTool("list-mail-messages")).toBe(false);
    });

    it("classifies mail reads fail-safe for read-only mode", () => {
      expect(isOutlookReadOnlyTool("list-mail-messages")).toBe(true);
      expect(isOutlookReadOnlyTool("get-mail-message")).toBe(true);
      expect(isOutlookReadOnlyTool("search-mail-messages")).toBe(true);
      // Send-capable, account-level, and mutating verbs never pass as reads.
      expect(isOutlookReadOnlyTool("send-mail")).toBe(false);
      expect(isOutlookReadOnlyTool("send-draft-message")).toBe(false);
      expect(isOutlookReadOnlyTool("reply-mail-message")).toBe(false);
      expect(isOutlookReadOnlyTool("forward-mail-message")).toBe(false);
      expect(isOutlookReadOnlyTool("graph-batch")).toBe(false);
      expect(isOutlookReadOnlyTool("login")).toBe(false);
      expect(isOutlookReadOnlyTool("create-mail-folder")).toBe(false);
      expect(isOutlookReadOnlyTool("update-mailbox-settings")).toBe(false);
      expect(isOutlookReadOnlyTool("delete-mail-rule")).toBe(false);
      expect(isOutlookReadOnlyTool("add-mail-attachment")).toBe(false);
    });

    it("recognizes confirmed send tools", () => {
      expect(isOutlookConfirmedSendTool("send-mail")).toBe(true);
      expect(isOutlookConfirmedSendTool("send-draft-message")).toBe(true);
      expect(isOutlookConfirmedSendTool("reply-mail-message")).toBe(false);
      expect(isOutlookConfirmedSendTool("forward-mail-message")).toBe(false);
      expect(isOutlookConfirmedSendTool("list-mail-messages")).toBe(false);
      expect([...OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS].sort()).toEqual([
        "send-draft-message",
        "send-mail",
      ]);
    });

    it("keeps authentication and account mutation tools out of the model surface", () => {
      expect([...OUTLOOK_MAIL_INTERNAL_TOOLS].sort()).toEqual([
        "forward-mail-message",
        "get-current-user",
        "graph-batch",
        "list-accounts",
        "login",
        "logout",
        "remove-account",
        "reply-all-mail-message",
        "reply-mail-message",
        "select-account",
        "verify-login",
      ]);
    });

    it("parses the upstream body wrapper without omitting recipients or content", async () => {
      const gate = new PauseGate();
      let preview: unknown;
      gate.on((request) => {
        preview = request.payload;
        gate.resolve(request.id, { type: "deny" });
      });
      await confirmOutlookSend({
        toolName: "send-mail",
        args: {
          body: {
            message: {
              toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
              subject: "Wrapped",
              body: { content: "Wrapped body" },
            },
          },
        },
        client: {
          callTool: vi.fn(async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "ok",
                  userData: { userPrincipalName: "sender@outlook.com" },
                }),
              },
            ],
          })),
        } as never,
        gate,
      });
      expect(preview).toMatchObject({
        to: ["recipient@example.com"],
        subject: "Wrapped",
        body: "Wrapped body",
      });
    });

    it("requires immutable user confirmation before direct send-mail dispatch", async () => {
      const gate = new PauseGate();
      const callTool = vi.fn(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "ok",
              userData: { userPrincipalName: "sender@outlook.com" },
            }),
          },
        ],
      }));
      let preview: unknown;
      gate.on((request) => {
        preview = request.payload;
        gate.resolve(request.id, { type: "run_once" });
      });
      const result = await confirmOutlookSend({
        toolName: "send-mail",
        args: {
          message: {
            toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
            ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
            bccRecipients: [{ emailAddress: { address: "hidden@example.com" } }],
            subject: "Application",
            body: { contentType: "Text", content: "Complete body" },
            attachments: [{ name: "CV.pdf", contentBytes: "not-shown" }],
          },
        },
        client: { callTool } as never,
        gate,
      });
      expect(result).toBeNull();
      expect(preview).toEqual({
        toolName: "send-mail",
        from: "sender@outlook.com",
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        bcc: ["hidden@example.com"],
        subject: "Application",
        body: "Complete body",
        attachments: ["CV.pdf"],
      });
      expect(callTool).toHaveBeenCalledWith("verify-login", {});
    });

    it("fails closed without a gate, verified sender, or complete content", async () => {
      const authenticatedClient = {
        callTool: vi.fn(async () => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "ok",
                userData: { userPrincipalName: "sender@outlook.com" },
              }),
            },
          ],
        })),
      };
      const base = {
        toolName: "send-mail",
        args: {
          message: {
            toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
            subject: "Application",
            body: { content: "Complete body" },
          },
        },
        client: authenticatedClient as never,
      };
      expect(await confirmOutlookSend(base)).toContain("confirmation-unavailable");
      expect(
        await confirmOutlookSend({
          ...base,
          args: { message: { subject: "Application", body: { content: "Complete body" } } },
          gate: new PauseGate(),
        }),
      ).toContain("incomplete-email-preview");
    });

    it("blocks the send when the user rejects, including under any edit mode", async () => {
      const gate = new PauseGate();
      gate.on((request) => gate.resolve(request.id, { type: "deny" }));
      const result = await confirmOutlookSend({
        toolName: "send-mail",
        args: {
          message: {
            toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
            subject: "Application",
            body: { content: "Complete body" },
          },
        },
        client: {
          callTool: vi.fn(async () => ({
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "ok",
                  userData: { userPrincipalName: "sender@outlook.com" },
                }),
              },
            ],
          })),
        } as never,
        gate,
      });
      expect(result).toContain("user-denied");
    });

    it("parses sanitized connected account status", () => {
      expect(
        parseOutlookLoginStatus(
          JSON.stringify({
            success: true,
            message: "Login successful",
            userData: { displayName: "Ada", userPrincipalName: "ada@outlook.com" },
          }),
        ),
      ).toEqual({ success: true, message: "Login successful", account: "ada@outlook.com" });
    });

    it("extracts the Microsoft verification URL and user code", () => {
      expect(
        parseOutlookDeviceCode(
          JSON.stringify({
            error: "device_code_required",
            message:
              "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
          }),
        ),
      ).toEqual({
        verificationUrl: "https://microsoft.com/devicelogin",
        userCode: "ABCD-EFGH",
        message:
          "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
      });
    });

    it("accepts only HTTPS Microsoft login URLs", () => {
      expect(isTrustedMicrosoftLoginUrl("https://microsoft.com/devicelogin")).toBe(true);
      expect(isTrustedMicrosoftLoginUrl("http://microsoft.com/devicelogin")).toBe(false);
      expect(isTrustedMicrosoftLoginUrl("https://microsoft.com.evil.test/devicelogin")).toBe(false);
      expect(
        parseOutlookDeviceCode(
          JSON.stringify({
            error: "device_code_required",
            message: "Open https://evil.test and enter the code ABCD-EFGH",
          }),
        ),
      ).toBeNull();
    });

    it("does not mistake unrelated text for a device-code response", () => {
      expect(parseOutlookDeviceCode(JSON.stringify({ error: "denied", message: "No" }))).toBeNull();
    });

    it("lists all folder and rule administrative tools in OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS", () => {
      expect([...OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS].sort()).toEqual([
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
      ]);
    });

    it("hides internals, default-off writes, and send tools without a bound preview", async () => {
      const client = {
        listTools: async () => ({
          tools: [
            { name: "list-mail-messages" },
            { name: "send-mail" },
            { name: "send-mail-as" },
            { name: "login" },
            { name: "create-mail-folder" },
          ],
        }),
      };
      const spec = parseMcpSpec(`outlook_mail=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`);
      const hidden = await outlookMailHiddenTools(spec, client as never);
      // The static guards ship whole, whatever the server happens to list.
      for (const name of [...OUTLOOK_MAIL_INTERNAL_TOOLS, ...OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS]) {
        expect(hidden.has(name)).toBe(true);
      }
      // A send tool with no bound confirmation preview is hidden by the upstream scan.
      expect(hidden.has("send-mail-as")).toBe(true);
      // Ordinary reads and the one gated send stay callable.
      expect(hidden.has("list-mail-messages")).toBe(false);
      expect(hidden.has("send-mail")).toBe(false);
      const other = await outlookMailHiddenTools(
        parseMcpSpec("other=npx some-server"),
        client as never,
      );
      expect(other.size).toBe(0);
    });

    it("requires immutable user confirmation before send-draft-message dispatch", async () => {
      const gate = new PauseGate();
      const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "verify-login") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "ok",
                  userData: { userPrincipalName: "sender@outlook.com" },
                }),
              },
            ],
          };
        }
        if (tool === "get-mail-message") {
          expect(args.messageId).toBe("draft-123");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  id: "draft-123",
                  subject: "Draft Subject",
                  body: { contentType: "Text", content: "Draft Body Content" },
                  toRecipients: [{ emailAddress: { address: "draft-to@example.com" } }],
                  ccRecipients: [{ emailAddress: { address: "draft-cc@example.com" } }],
                  bccRecipients: [],
                  hasAttachments: true,
                  attachments: [{ name: "attachment.pdf" }],
                }),
              },
            ],
          };
        }
        throw new Error(`unexpected tool call: ${tool}`);
      });

      let preview: unknown;
      gate.on((request) => {
        preview = request.payload;
        gate.resolve(request.id, { type: "run_once" });
      });

      const result = await confirmOutlookSend({
        toolName: "send-draft-message",
        args: { messageId: "draft-123" },
        client: { callTool } as never,
        gate,
      });

      expect(result).toBeNull();
      expect(preview).toEqual({
        toolName: "send-draft-message",
        from: "sender@outlook.com",
        to: ["draft-to@example.com"],
        cc: ["draft-cc@example.com"],
        bcc: [],
        subject: "Draft Subject",
        body: "Draft Body Content",
        attachments: ["attachment.pdf"],
      });
      expect(callTool).toHaveBeenCalledWith("verify-login", {});
    });

    it("falls back to list-mail-attachments when draft hasAttachments is true but attachments array is unexpanded", async () => {
      const gate = new PauseGate();
      const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
        if (tool === "verify-login") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  message: "ok",
                  userData: { userPrincipalName: "sender@outlook.com" },
                }),
              },
            ],
          };
        }
        if (tool === "get-mail-message") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  id: "draft-456",
                  subject: "Draft With Attachments",
                  body: { content: "Draft body" },
                  toRecipients: [{ emailAddress: { address: "to@example.com" } }],
                  hasAttachments: true,
                }),
              },
            ],
          };
        }
        if (tool === "list-mail-attachments") {
          expect(args.messageId).toBe("draft-456");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  value: [{ name: "resume.pdf" }, { name: "portfolio.zip" }],
                }),
              },
            ],
          };
        }
        throw new Error(`unexpected tool call: ${tool}`);
      });

      let preview: unknown;
      gate.on((request) => {
        preview = request.payload;
        gate.resolve(request.id, { type: "run_once" });
      });

      const result = await confirmOutlookSend({
        toolName: "send-draft-message",
        args: { messageId: "draft-456" },
        client: { callTool } as never,
        gate,
      });

      expect(result).toBeNull();
      expect(preview).toMatchObject({
        attachments: ["resume.pdf", "portfolio.zip"],
      });
    });

    it("blocks send-draft-message when messageId is missing or draft cannot be found", async () => {
      const gate = new PauseGate();
      const client = {
        callTool: vi.fn(async (tool: string) => {
          if (tool === "verify-login") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: true,
                    message: "ok",
                    userData: { userPrincipalName: "sender@outlook.com" },
                  }),
                },
              ],
            };
          }
          throw new Error("404 Not Found");
        }),
      };

      const noId = await confirmOutlookSend({
        toolName: "send-draft-message",
        args: {},
        client: client as never,
        gate,
      });
      expect(noId).toContain("incomplete-email-preview");

      const notFound = await confirmOutlookSend({
        toolName: "send-draft-message",
        args: { messageId: "missing-id" },
        client: client as never,
        gate,
      });
      expect(notFound).toContain("draft-not-found");
    });

    it("blocks unconfirmed send-capable tools fail-closed", async () => {
      const gate = new PauseGate();
      const client = { callTool: vi.fn() };

      const replyBlocked = await confirmOutlookSend({
        toolName: "reply-mail-message",
        args: { messageId: "123", comment: "reply" },
        client: client as never,
        gate,
      });
      expect(replyBlocked).toContain("unsupported-send-tool");

      const forwardBlocked = await confirmOutlookSend({
        toolName: "forward-mail-message",
        args: { messageId: "123", comment: "fwd" },
        client: client as never,
        gate,
      });
      expect(forwardBlocked).toContain("unsupported-send-tool");
    });

    it("extracts messageId from various parameter shapes", () => {
      expect(extractOutlookMessageId({ messageId: "id-1" })).toBe("id-1");
      expect(extractOutlookMessageId({ "message-id": "id-2" })).toBe("id-2");
      expect(extractOutlookMessageId({ id: "id-3" })).toBe("id-3");
      expect(extractOutlookMessageId({ body: { messageId: "id-4" } })).toBe("id-4");
      expect(extractOutlookMessageId({})).toBeNull();
    });

    it("parses send-mail args with PascalCase or direct string bodies", () => {
      const parsed = parseOutlookSendArgs("send-mail", {
        Message: {
          Subject: "Hello",
          Body: "Direct string body",
          ToRecipients: [{ emailAddress: { address: "test@example.com" } }],
          Attachments: [{ Name: "file.txt" }],
        },
      });
      expect(parsed).toEqual({
        toolName: "send-mail",
        to: ["test@example.com"],
        cc: [],
        bcc: [],
        subject: "Hello",
        body: "Direct string body",
        attachments: ["file.txt"],
      });
    });
  });
});

describe("outlook-attachments", () => {
  const PDF_BYTES = Buffer.from("%PDF-1.4 reasonix attachment test");
  const PDF_B64 = PDF_BYTES.toString("base64");

  let dir: string;
  let pdfPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "reasonix-att-"));
    pdfPath = join(dir, "cv.pdf");
    await writeFile(pdfPath, PDF_BYTES);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function firstAttachment(args: Record<string, unknown>): Record<string, unknown> {
    const body = args.body as { message: { attachments: Record<string, unknown>[] } };
    return body.message.attachments[0]!;
  }

  describe("hydrateOutlookAttachments", () => {
    it("inlines a filesystem path dropped into contentBytes (send-mail)", async () => {
      const args = {
        body: {
          message: {
            toRecipients: [{ emailAddress: { address: "a@b.com" } }],
            subject: "s",
            body: { content: "c" },
            attachments: [{ contentBytes: pdfPath }],
          },
        },
      };
      const out = await hydrateOutlookAttachments("send-mail", args);
      const att = firstAttachment(out);
      expect(att.contentBytes).toBe(PDF_B64);
      expect(att.name).toBe("cv.pdf");
      expect(att.contentType).toBe("application/pdf");
      expect(att["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
      // Non-destructive: the caller's args are untouched.
      expect(firstAttachment(args).contentBytes).toBe(pdfPath);
    });

    it("hydrates an explicit path field and keeps a caller-supplied name", async () => {
      const out = await hydrateOutlookAttachments("send-mail", {
        body: { message: { attachments: [{ path: pdfPath, name: "CV_Ubeid.pdf" }] } },
      });
      const att = firstAttachment(out);
      expect(att.name).toBe("CV_Ubeid.pdf");
      expect(att.contentBytes).toBe(PDF_B64);
      expect(att.path).toBeUndefined();
    });

    it("resolves a workspace-relative path", async () => {
      const out = await hydrateOutlookAttachments(
        "send-mail",
        { body: { message: { attachments: [{ path: "cv.pdf" }] } } },
        { workspaceDir: dir },
      );
      expect(firstAttachment(out).contentBytes).toBe(PDF_B64);
    });

    it("hydrates add-mail-attachment's body attachment and preserves messageId", async () => {
      const out = await hydrateOutlookAttachments("add-mail-attachment", {
        messageId: "m1",
        body: { contentBytes: pdfPath },
      });
      expect((out.body as Record<string, unknown>).contentBytes).toBe(PDF_B64);
      expect(out.messageId).toBe("m1");
    });

    it("leaves a real base64 payload untouched (same reference)", async () => {
      const args = {
        body: {
          message: { attachments: [{ contentBytes: PDF_B64, name: "x.pdf" }] },
        },
      };
      expect(await hydrateOutlookAttachments("send-mail", args)).toBe(args);
    });

    it("ignores non-attachment tools", async () => {
      const args = { body: { attachments: [{ contentBytes: pdfPath }] } };
      expect(await hydrateOutlookAttachments("list-mail-messages", args)).toBe(args);
    });

    it("throws a clear error when the file is missing", async () => {
      await expect(
        hydrateOutlookAttachments("send-mail", {
          body: { message: { attachments: [{ path: join(dir, "nope.pdf") }] } },
        }),
      ).rejects.toThrow(/not found/);
    });

    it("refuses files above the inline cap", async () => {
      await expect(
        hydrateOutlookAttachments(
          "send-mail",
          { body: { message: { attachments: [{ path: pdfPath }] } } },
          { maxInlineBytes: 1 },
        ),
      ).rejects.toThrow(/capped at/);
    });

    it("infers content types by extension", () => {
      expect(inferAttachmentContentType("a.PDF")).toBe("application/pdf");
      expect(inferAttachmentContentType("a.zip")).toBe("application/zip");
      expect(inferAttachmentContentType("a.unknown")).toBe("application/octet-stream");
    });

    it("distinguishes paths from base64", () => {
      expect(looksLikeFilePath("C:\\x\\y.pdf")).toBe(true);
      expect(looksLikeFilePath("/home/x/y.pdf")).toBe(true);
      expect(looksLikeFilePath("aGVsbG8=")).toBe(false);
      expect(looksLikeBase64("aGVsbG8=")).toBe(true);
      expect(looksLikeBase64("C:\\x\\y.pdf")).toBe(false);
    });

    it("exposes the 3 MB inline cap", () => {
      expect(MAX_INLINE_ATTACHMENT_BYTES).toBe(3 * 1024 * 1024);
    });
  });

  function fakeSendMailClient(onCall: (args: Record<string, unknown>) => void) {
    const fake = {
      listTools: async () => ({
        tools: [
          {
            name: "send-mail",
            description: "send",
            inputSchema: { type: "object", properties: {} },
          } as McpTool,
        ],
      }),
      callTool: async (_name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        onCall(args);
        return { content: [{ type: "text", text: "OK!" }] };
      },
    };
    return fake as unknown as Parameters<typeof bridgeMcpTools>[0];
  }

  describe("bridge transformArgs hook", () => {
    it("replaces args with the hydrated version before the upstream call", async () => {
      let seen: Record<string, unknown> | undefined;
      const client = fakeSendMailClient((args) => {
        seen = args;
      });
      const { registry } = await bridgeMcpTools(client, {
        transformArgs: (toolName, args) => hydrateOutlookAttachments(toolName, args),
      });
      const out = await registry.dispatch(
        "send-mail",
        JSON.stringify({ body: { message: { attachments: [{ path: pdfPath }] } } }),
      );
      expect(out).toContain("OK!");
      const att = firstAttachment(seen as Record<string, unknown>);
      expect(att.contentBytes).toBe(PDF_B64);
    });

    it("turns a hydration error into a JSON error result without calling upstream", async () => {
      let called = false;
      const client = fakeSendMailClient(() => {
        called = true;
      });
      const { registry } = await bridgeMcpTools(client, {
        transformArgs: (toolName, args) => hydrateOutlookAttachments(toolName, args),
      });
      const out = await registry.dispatch(
        "send-mail",
        JSON.stringify({
          body: { message: { attachments: [{ path: join(dir, "missing.pdf") }] } },
        }),
      );
      expect(out).toContain("not found");
      expect(called).toBe(false);
    });
  });

  describe("bridge readOnlyTool hook", () => {
    it("marks classified mail reads read-only and leaves everything else alone", async () => {
      const names = ["list-mail-messages", "get-mail-message", "send-mail", "create-mail-folder"];
      const client = {
        listTools: async () => ({
          tools: names.map(
            (name) =>
              ({
                name,
                description: name,
                inputSchema: { type: "object", properties: {} },
              }) as McpTool,
          ),
        }),
        callTool: async (): Promise<CallToolResult> => ({
          content: [{ type: "text", text: "OK!" }],
        }),
      } as unknown as Parameters<typeof bridgeMcpTools>[0];
      const { registry } = await bridgeMcpTools(client, { readOnlyTool: isOutlookReadOnlyTool });
      expect(registry.get("list-mail-messages")?.readOnly).toBe(true);
      expect(registry.get("get-mail-message")?.readOnly).toBe(true);
      expect(registry.get("send-mail")?.readOnly).toBeUndefined();
      expect(registry.get("create-mail-folder")?.readOnly).toBeUndefined();
    });
  });
});

describe("changelog", () => {
  describe("releaseVersion", () => {
    it("matches the exact message the release workflow writes", () => {
      expect(releaseVersion("chore(release): v1.0.27")).toBe("1.0.27");
    });

    it("tolerates a missing v and a pre-release suffix", () => {
      expect(releaseVersion("chore(release): 1.0.28")).toBe("1.0.28");
      expect(releaseVersion("chore(release): v2.0.0-rc.5")).toBe("2.0.0-rc.5");
    });

    it("accepts the bare spellings a human might type", () => {
      expect(releaseVersion("release: v1.2.3")).toBe("1.2.3");
      expect(releaseVersion("chore: release v1.2.3")).toBe("1.2.3");
    });

    it("rejects ordinary commits and a partial version", () => {
      expect(releaseVersion("fix(desktop): render PDFs")).toBeNull();
      expect(releaseVersion("chore(release): v1.0")).toBeNull();
      expect(releaseVersion("chore(release): bump")).toBeNull();
    });
  });

  describe("parseCommitSubject", () => {
    it("splits type, scope and breaking marker", () => {
      expect(parseCommitSubject("feat(chat): add inline audio playback")).toEqual({
        kind: "feat",
        scope: "chat",
        text: "add inline audio playback",
        breaking: false,
      });
      expect(parseCommitSubject("fix(core)!: drop the legacy adapter")).toEqual({
        kind: "fix",
        scope: "core",
        text: "drop the legacy adapter",
        breaking: true,
      });
    });

    it("maps types onto changelog kinds", () => {
      expect(parseCommitSubject("perf: faster fold").kind).toBe("perf");
      expect(parseCommitSubject("refactor: extract reducer").kind).toBe("change");
      expect(parseCommitSubject("style: scrollbar corner").kind).toBe("change");
      expect(parseCommitSubject("chore: bump dep").kind).toBe("chore");
      expect(parseCommitSubject("docs: fix typo").kind).toBe("chore");
    });

    it("keeps the full text of a non-conventional subject", () => {
      expect(parseCommitSubject("Re-encode opaque PNGs as JPEG")).toEqual({
        kind: "other",
        text: "Re-encode opaque PNGs as JPEG",
        breaking: false,
      });
    });

    it("tolerates a missing scope", () => {
      expect(parseCommitSubject("fix: stop the stutter")).toEqual({
        kind: "fix",
        text: "stop the stutter",
        breaking: false,
      });
    });
  });

  describe("isMergeCommit", () => {
    it("detects merges so they can be dropped", () => {
      expect(isMergeCommit("Merge branch 'main' into fix")).toBe(true);
      expect(isMergeCommit("fix: merge the rules")).toBe(false);
    });
  });

  describe("groupReleases", () => {
    const commits = [
      { sha: "aaa1", subject: "fix(desktop): center image zoom", date: "2026-01-05" },
      { sha: "bbb2", subject: "chore(release): v1.0.27", date: "2026-01-04" },
      { sha: "ccc3", subject: "fix(desktop): render PDFs", date: "2026-01-03" },
      { sha: "ddd4", subject: "feat(chat): add audio playback", date: "2026-01-02" },
      { sha: "eee5", subject: "chore(release): v1.0.26", date: "2026-01-01" },
      { sha: "fff6", subject: "chore: bump dep", date: "2025-12-31" },
    ];

    it("puts each commit in the release marker below it", () => {
      const releases = groupReleases(commits);
      expect(releases.map((r) => r.version)).toEqual([null, "1.0.27", "1.0.26"]);
      expect(releases[1]!.entries.map((e) => e.text)).toEqual([
        "render PDFs",
        "add audio playback",
      ]);
      expect(releases[2]!.entries.map((e) => e.text)).toEqual(["bump dep"]);
    });

    it("matches the real repo history shape", () => {
      // The tag sits ON the release commit, so a commit above it landed after the
      // tag and is not part of that version.
      const releases = groupReleases([
        { sha: "a1bd13d", subject: "fix(desktop): center image zoom", date: "2026-01-09" },
        { sha: "18dbb16", subject: "chore(release): v1.0.27", date: "2026-01-08" },
        { sha: "37f6488", subject: "fix(desktop): render PDFs", date: "2026-01-07" },
      ]);
      expect(releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
      expect(releases[0]!.entries.map((e) => e.hash)).toEqual(["a1bd13d"]);
      expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["37f6488"]);
    });

    it("never lists a release marker as a change", () => {
      for (const release of groupReleases(commits)) {
        expect(release.entries.some((e) => releaseVersion(e.text) !== null)).toBe(false);
      }
    });

    it("collects commits newer than the newest marker as unreleased", () => {
      const unreleased = groupReleases(commits)[0]!;
      expect(unreleased.unreleased).toBe(true);
      expect(unreleased.version).toBeNull();
      expect(unreleased.date).toBe("2026-01-05");
      expect(unreleased.entries.map((e) => e.text)).toEqual(["center image zoom"]);
    });

    it("omits the unreleased group when the tip is a release marker", () => {
      const releases = groupReleases([commits[1]!, commits[2]!]);
      expect(releases).toHaveLength(1);
      expect(releases[0]!.unreleased).toBe(false);
    });

    it("drops merge commits", () => {
      const releases = groupReleases([
        { sha: "m1", subject: "Merge branch 'main'", date: "2026-01-05" },
        { sha: "x1", subject: "fix: real work", date: "2026-01-05" },
        { sha: "r1", subject: "chore(release): v1.0.27", date: "2026-01-04" },
        { sha: "x2", subject: "feat: older work", date: "2026-01-03" },
      ]);
      expect(releases[0]!.entries.map((e) => e.hash)).toEqual(["x1"]);
      expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["x2"]);
    });

    it("returns nothing for an empty history", () => {
      expect(groupReleases([])).toEqual([]);
    });
  });

  describe("groupSections", () => {
    it("buckets entries in the fixed order and drops empty sections", () => {
      const release = groupReleases([
        { sha: "a1", subject: "chore: bump dep", date: null },
        { sha: "a2", subject: "fix: a bug", date: null },
        { sha: "a3", subject: "feat: a thing", date: null },
        { sha: "a4", subject: "chore(release): v1.0.27", date: null },
      ])[0]!;
      expect(groupSections(release).map((s) => s.kind)).toEqual(["feat", "fix", "chore"]);
    });
  });

  describe("toReleases", () => {
    it("adapts a GitHub commits payload", () => {
      const releases = toReleases([
        {
          sha: "1234567890abcdef",
          commit: {
            message: "feat(chat): add audio\n\nlong body ignored",
            author: { date: "2026-01-05" },
          },
        },
        {
          sha: "bbbb",
          commit: { message: "chore(release): v1.0.27", committer: { date: "2026-01-04" } },
        },
        { sha: "cccc", commit: { message: "fix: older", committer: { date: "2026-01-03" } } },
      ]);
      expect(releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
      expect(releases[1]!.entries.map((e) => e.hash)).toEqual(["cccc"]);
      expect(releases[0]!.entries[0]).toEqual({
        hash: "1234567",
        kind: "feat",
        scope: "chat",
        text: "add audio",
        breaking: false,
      });
    });

    it("skips malformed entries instead of blanking the page", () => {
      const releases = toReleases([null, 42, {}, { commit: { message: "fix: no sha" } }, "nope"]);
      expect(releases).toEqual([]);
    });

    it("returns nothing for a non-array payload", () => {
      expect(toReleases({ message: "rate limited" })).toEqual([]);
    });
  });

  describe("shortHash", () => {
    it("shortens to the git log --oneline width", () => {
      expect(shortHash("1234567890abcdef")).toBe("1234567");
    });
  });

  describe("findRelease", () => {
    const releases = groupReleases([
      { sha: "a1", subject: "feat: new", date: null },
      { sha: "r1", subject: "chore(release): v1.0.27", date: null },
      { sha: "a2", subject: "fix: shipped", date: null },
    ]);

    it("matches with or without the v prefix", () => {
      expect(findRelease(releases, "1.0.27")?.version).toBe("1.0.27");
      expect(findRelease(releases, "v1.0.27")?.version).toBe("1.0.27");
    });

    it("returns null for an unknown or missing version", () => {
      expect(findRelease(releases, "9.9.9")).toBeNull();
      expect(findRelease(releases, undefined)).toBeNull();
    });
  });
});

describe("changelog-fetch", () => {
  const TEST_DIR = join(process.cwd(), ".tmp-test-changelog");

  const FAKE_PAYLOAD = [
    {
      sha: "aaa1111",
      commit: { message: "fix(desktop): center image zoom", author: { date: "2026-01-05" } },
    },
    {
      sha: "bbb2222",
      commit: { message: "chore(release): v1.0.27", committer: { date: "2026-01-04" } },
    },
    {
      sha: "ccc3333",
      commit: { message: "feat(chat): add audio", author: { date: "2026-01-03" } },
    },
  ];

  function cachedRelease(version: string): ChangelogRelease {
    return {
      version,
      date: "2026-01-04",
      entries: [{ hash: "deadbee", kind: "fix", text: "cached work", breaking: false }],
      unreleased: false,
    };
  }

  function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status: 200 });
  }

  describe("changelog fetch", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it("groups a fetched history into releases", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(fetchImpl).toHaveBeenCalled();
      expect(snapshot.error).toBeUndefined();
      expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
      expect(snapshot.releases[1]!.entries.map((e) => e.text)).toEqual(["add audio"]);
    });

    it("caches the result under the reasonix home", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

      await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      const cached = loadChangelogCache(TEST_DIR);
      expect(cached?.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
      expect(changelogCachePath(TEST_DIR)).toContain("changelog-cache.json");
    });

    it("serves from cache when within the TTL and force is false", async () => {
      writeChangelogCache({ releases: [cachedRelease("1.0.26")], checkedAt: Date.now() }, TEST_DIR);
      const fetchImpl = vi.fn();

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: false,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(snapshot.releases.map((r) => r.version)).toEqual(["1.0.26"]);
    });

    it("refetches once the cache goes stale", async () => {
      writeChangelogCache(
        { releases: [cachedRelease("1.0.26")], checkedAt: Date.now() - CHANGELOG_CACHE_TTL_MS - 1 },
        TEST_DIR,
      );
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: false,
      });

      expect(fetchImpl).toHaveBeenCalled();
      expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    });

    it("bypasses the cache when force is true", async () => {
      writeChangelogCache({ releases: [cachedRelease("1.0.26")], checkedAt: Date.now() }, TEST_DIR);
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(FAKE_PAYLOAD));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(fetchImpl).toHaveBeenCalled();
      expect(snapshot.releases.map((r) => r.version)).toEqual([null, "1.0.27"]);
    });

    it("falls back to the cache when the network fails, and says so", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      writeChangelogCache(
        { releases: [cachedRelease("1.0.26")], checkedAt: Date.now() - 1000 },
        TEST_DIR,
      );
      const fetchImpl = vi.fn().mockRejectedValue(new Error("Network unreachable"));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(stderrSpy).toHaveBeenCalled();
      const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("reasonix: failed to fetch the changelog");
      expect(snapshot.error).toContain("Network unreachable");
      expect(snapshot.releases.map((r) => r.version)).toEqual(["1.0.26"]);
    });

    it("reports an empty result when there is neither network nor cache", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(snapshot.releases).toEqual([]);
      expect(snapshot.error).toContain("offline");
    });

    it("treats an unparseable payload as a failure rather than an empty changelog", async () => {
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "rate limited" }));

      const snapshot = await fetchChangelog({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        homeDir: TEST_DIR,
        force: true,
      });

      expect(snapshot.releases).toEqual([]);
      expect(snapshot.error).toContain("no releases parsed");
    });
  });
});

// i18n resolution: the English dictionary is the schema, and every key must
// *  resolve through t() (a missing string echoes its path into the UI).
describe("i18n", () => {
  function flattenKeys(obj: unknown, prefix = ""): string[] {
    if (typeof obj !== "object" || obj === null) return [];
    const out: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push(path);
      else out.push(...flattenKeys(v, path));
    }
    return out;
  }

  describe("t() resolution", () => {
    it("resolves compaction strings with parameter substitution", () => {
      const compacted = t("loop.compacted", { method: "summary", before: "1,000", after: "400" });
      expect(compacted).toContain("summary");
      expect(compacted).toContain("1,000");
      expect(compacted).toContain("400");
      expect(compacted).not.toContain("{method}");

      const recovery = t("loop.compactedRecovery", { before: "9,000", after: "500" });
      expect(recovery).toContain("9,000");
      expect(recovery).toContain("500");
      expect(recovery).not.toContain("{before}");
    });

    it("echoes the path for unknown keys instead of throwing", () => {
      expect(t("loop.noSuchKey")).toBe("loop.noSuchKey");
      expect(t("nope.deeply.missing")).toBe("nope.deeply.missing");
    });

    it("every dictionary key resolves through t()", () => {
      const keys = flattenKeys(EN);
      expect(keys.length).toBeGreaterThan(100);
      const unresolved = keys.filter((k) => t(k) === k);
      expect(unresolved).toEqual([]);
    });

    it("EN satisfies the TranslationSchema shape", () => {
      // Type-level contract, checked at compile time; this guards the runtime
      // import so the two can never drift silently.
      const schema: TranslationSchema = EN;
      expect(schema.loop.compacted).toContain("{method}");
    });
  });
});

// Plan Mode — read-only dispatch gate + submit_plan tool's PlanProposedError → tool_result protocol.
describe("plan", () => {
  /** A PauseGate that auto-resolves with a pre-configured choice.  */
  class AutoGate extends PauseGate {
    private _choice: ConfirmationChoice | { type: string };
    lastAsk: { kind: string; payload?: unknown } | null = null;

    constructor(choice: ConfirmationChoice | { type: string }) {
      super();
      this._choice = choice;
    }

    override ask(opts: { kind: string; payload?: unknown }): Promise<any> {
      this.lastAsk = opts;
      return Promise.resolve(this._choice);
    }
  }

  describe("ToolRegistry plan mode", () => {
    it("starts with plan mode off by default", () => {
      const reg = new ToolRegistry();
      expect(reg.planMode).toBe(false);
    });

    it("setPlanMode toggles the flag", () => {
      const reg = new ToolRegistry();
      reg.setPlanMode(true);
      expect(reg.planMode).toBe(true);
      reg.setPlanMode(false);
      expect(reg.planMode).toBe(false);
    });

    it("blocks non-readOnly tools when plan mode is on", async () => {
      const reg = new ToolRegistry();
      let ran = false;
      reg.register({
        name: "mutate",
        // readOnly: undefined → treated as write
        fn: () => {
          ran = true;
          return "ok";
        },
      });
      reg.setPlanMode(true);
      const out = await reg.dispatch("mutate", "{}");
      expect(ran).toBe(false);
      const payload = JSON.parse(out);
      expect(payload.error).toMatch(/blocked in Read only mode/);
      expect(payload.error).toMatch(/submit_plan/);
    });

    it("allows readOnly tools when plan mode is on", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "read_thing",
        readOnly: true,
        fn: () => "the-thing",
      });
      reg.setPlanMode(true);
      const out = await reg.dispatch("read_thing", "{}");
      expect(out).toBe("the-thing");
    });

    it("honors readOnlyCheck taking the actual arguments into account", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "maybe_read",
        readOnlyCheck: (args: { kind?: string }) => args.kind === "read",
        fn: (args: { kind?: string }) => `did-${args.kind}`,
      });
      reg.setPlanMode(true);
      // Read call: allowed.
      const readOut = await reg.dispatch("maybe_read", '{"kind":"read"}');
      expect(readOut).toBe("did-read");
      // Write call: refused.
      const writeOut = await reg.dispatch("maybe_read", '{"kind":"write"}');
      expect(JSON.parse(writeOut).error).toMatch(/blocked in Read only mode/);
    });

    it("readOnlyCheck takes precedence over readOnly when both are set", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "mixed",
        readOnly: false,
        readOnlyCheck: () => true,
        fn: () => "ran",
      });
      reg.setPlanMode(true);
      const out = await reg.dispatch("mixed", "{}");
      expect(out).toBe("ran");
    });

    it("with plan mode off, readOnly flags don't interfere", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "normal",
        fn: () => "ran",
      });
      expect(reg.planMode).toBe(false);
      const out = await reg.dispatch("normal", "{}");
      expect(out).toBe("ran");
    });

    it("serializes errors via toToolResult when the thrown error implements it", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "structured_err",
        fn: () => {
          const err = new Error("oops") as Error & { toToolResult?: () => unknown };
          err.name = "StructuredError";
          err.toToolResult = () => ({
            error: "StructuredError: oops",
            extra: "pinned-out-of-band",
          });
          throw err;
        },
      });
      const out = await reg.dispatch("structured_err", "{}");
      const parsed = JSON.parse(out);
      expect(parsed.error).toBe("StructuredError: oops");
      expect(parsed.extra).toBe("pinned-out-of-band");
    });

    it("falls back to the default error shape when toToolResult throws", async () => {
      const reg = new ToolRegistry();
      reg.register({
        name: "broken_serializer",
        fn: () => {
          const err = new Error("base-message") as Error & { toToolResult?: () => unknown };
          err.name = "Broken";
          err.toToolResult = () => {
            throw new Error("serialization failed");
          };
          throw err;
        },
      });
      const out = await reg.dispatch("broken_serializer", "{}");
      expect(JSON.parse(out).error).toBe("Broken: base-message");
    });
  });

  describe("PlanProposedError", () => {
    it("carries the plan on the instance and in toToolResult()", () => {
      const err = new PlanProposedError("# Plan\n- step 1\n- step 2");
      expect(err.name).toBe("PlanProposedError");
      expect(err.plan).toBe("# Plan\n- step 1\n- step 2");
      const payload = err.toToolResult();
      expect(payload.plan).toBe("# Plan\n- step 1\n- step 2");
      expect(payload.error).toMatch(/^PlanProposedError:/);
      // Message tells the model to STOP so it doesn't keep calling tools.
      expect(payload.error).toMatch(/STOP/);
    });
  });

  describe("registerPlanTool + submit_plan", () => {
    it("registers submit_plan as readOnly so it passes the plan-mode gate", () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      expect(reg.has("submit_plan")).toBe(true);
      expect(reg.get("submit_plan")?.readOnly).toBe(true);
    });

    it("blocks on PauseGate when called with a plan (plan mode ON)", async () => {
      const reg = new ToolRegistry();
      const submitted: string[] = [];
      registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push(p) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan\n- A" }), {
        confirmationGate: gate,
      });
      expect(out).toBe("plan approved");
      expect(submitted).toEqual(["# Plan\n- A"]);
    });

    it("also fires the picker when plan mode is OFF — autonomous proposals", async () => {
      const reg = new ToolRegistry();
      const submitted: string[] = [];
      registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push(p) });
      // Plan mode intentionally NOT enabled.
      const gate = new AutoGate({ type: "approve" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "big refactor plan" }), {
        confirmationGate: gate,
      });
      expect(out).toBe("plan approved");
      expect(submitted).toEqual(["big refactor plan"]);
    });

    it("rejects an empty plan with a helpful message", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      reg.setPlanMode(true);
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "   \n\n  " }));
      const parsed = JSON.parse(out);
      expect(parsed.error).toMatch(/empty plan/);
      // Empty-plan is a regular Error, not PlanProposedError — so there's
      // no `plan` field.
      expect(parsed.plan).toBeUndefined();
    });

    it("trims surrounding whitespace from the plan", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ plan: string }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push({ plan: p }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch("submit_plan", JSON.stringify({ plan: "\n\n  trimmed  \n" }), {
        confirmationGate: gate,
      });
      expect(submitted[0]?.plan).toBe("trimmed");
    });

    it("carries an optional summary through to PauseGate", async () => {
      const reg = new ToolRegistry();
      const submitted: string[] = [];
      registerPlanTool(reg, { onPlanSubmitted: (p) => submitted.push(p) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      const out = await reg.dispatch(
        "submit_plan",
        JSON.stringify({ plan: "# Plan", summary: "Refactor auth into signed tokens" }),
        { confirmationGate: gate },
      );
      expect(out).toBe("plan approved");
      expect(submitted).toEqual(["# Plan"]);
    });

    it("carries the stable tool call id through to the plan approval request", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "approve" });

      await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan" }), {
        callId: "plan-call-42",
        confirmationGate: gate,
      });

      expect(gate.lastAsk).toMatchObject({
        kind: "plan_proposed",
        payload: { plan: "# Plan", callId: "plan-call-42" },
      });
    });

    it("omits summary when blank / whitespace-only", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ plan: string; summary?: string }> = [];
      registerPlanTool(reg, {
        onPlanSubmitted: (p, _s, summary) => submitted.push({ plan: p, summary }),
      });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan", summary: "   " }), {
        confirmationGate: gate,
      });
      expect(submitted[0]?.summary).toBeUndefined();
    });

    it("accepts an optional steps array and surfaces it in the tool result", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ plan: string; steps?: unknown }> = [];
      registerPlanTool(reg, {
        onPlanSubmitted: (plan, steps) => submitted.push({ plan, steps }),
      });
      reg.setPlanMode(true);
      const steps = [
        { id: "step-1", title: "Refactor auth", action: "Extract tokens into a module." },
        {
          id: "step-2",
          title: "Update tests",
          action: "Rewrite auth.test.ts to use the new module.",
        },
      ];
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan", steps }), {
        confirmationGate: gate,
      });
      expect(submitted[0]?.steps).toEqual(steps);
    });

    it("drops malformed step entries and omits steps entirely when none remain", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ steps?: unknown }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (_p, steps) => submitted.push({ steps }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch(
        "submit_plan",
        JSON.stringify({
          plan: "# Plan",
          steps: [
            { id: "", title: "missing id", action: "a" },
            { id: "x", title: "", action: "a" },
            { id: "y", title: "t", action: "" },
            "not-an-object",
            null,
          ],
        }),
        { confirmationGate: gate },
      );
      expect(submitted[0]?.steps).toBeUndefined();
    });

    it("accepts and preserves valid risk levels on steps", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ steps?: unknown }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (_p, steps) => submitted.push({ steps }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch(
        "submit_plan",
        JSON.stringify({
          plan: "# Plan",
          steps: [
            { id: "step-1", title: "safe", action: "local edit", risk: "low" },
            { id: "step-2", title: "medium", action: "multi-file edit", risk: "med" },
            { id: "step-3", title: "risky", action: "prod migration", risk: "high" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(submitted[0]?.steps).toEqual([
        { id: "step-1", title: "safe", action: "local edit", risk: "low" },
        { id: "step-2", title: "medium", action: "multi-file edit", risk: "med" },
        { id: "step-3", title: "risky", action: "prod migration", risk: "high" },
      ]);
    });

    it("accepts optional lifecycle metadata on steps", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ steps?: unknown }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (_p, steps) => submitted.push({ steps }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch(
        "submit_plan",
        JSON.stringify({
          plan: "# Plan",
          steps: [
            {
              id: "step-1",
              title: "refactor",
              action: "change tool gates",
              targets: ["src/tools.ts", "src/cli/ui/App.tsx"],
              acceptance: "high-risk mutations require an approved plan",
              verification: ["npm test tests/lifecycle.test.ts"],
            },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(submitted[0]?.steps).toEqual([
        {
          id: "step-1",
          title: "refactor",
          action: "change tool gates",
          targets: ["src/tools.ts", "src/cli/ui/App.tsx"],
          acceptance: "high-risk mutations require an approved plan",
          verification: ["npm test tests/lifecycle.test.ts"],
        },
      ]);
    });

    it("drops malformed risk values rather than letting them through", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ steps?: unknown }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (_p, steps) => submitted.push({ steps }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch(
        "submit_plan",
        JSON.stringify({
          plan: "# Plan",
          steps: [
            { id: "step-1", title: "a", action: "b", risk: "critical" },
            { id: "step-2", title: "c", action: "d", risk: 3 },
            { id: "step-3", title: "e", action: "f" },
          ],
        }),
        { confirmationGate: gate },
      );
      // "critical" and 3 are rejected → risk field omitted; step-3 had
      // no risk to begin with. All three steps survive (the step itself
      // was well-formed; only the bad risk got dropped).
      expect(submitted[0]?.steps).toEqual([
        { id: "step-1", title: "a", action: "b" },
        { id: "step-2", title: "c", action: "d" },
        { id: "step-3", title: "e", action: "f" },
      ]);
    });

    it("keeps only the well-formed steps when the array is mixed", async () => {
      const reg = new ToolRegistry();
      const submitted: Array<{ steps?: unknown }> = [];
      registerPlanTool(reg, { onPlanSubmitted: (_p, steps) => submitted.push({ steps }) });
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "approve" });
      await reg.dispatch(
        "submit_plan",
        JSON.stringify({
          plan: "# Plan",
          steps: [
            { id: "step-1", title: "good", action: "do thing" },
            { id: "", title: "bad", action: "x" },
            { id: "step-2", title: "also good", action: "do other thing" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(submitted[0]?.steps).toEqual([
        { id: "step-1", title: "good", action: "do thing" },
        { id: "step-2", title: "also good", action: "do other thing" },
      ]);
    });

    it("surfaces refine feedback in the tool error so the model sees what to fix (#533)", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "refine", feedback: "use sqlite, not postgres" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan" }), {
        confirmationGate: gate,
      });
      expect(JSON.parse(out).error).toMatch(/user requested refinement: use sqlite, not postgres/);
    });

    it("falls back to bare 'user requested refinement' when no feedback is supplied", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "refine" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan" }), {
        confirmationGate: gate,
      });
      expect(JSON.parse(out).error).toMatch(/user requested refinement$/);
    });

    it("surfaces approve feedback as additional instructions in the tool result", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "approve", feedback: "skip the migration step for now" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan" }), {
        confirmationGate: gate,
      });
      expect(out).toBe(
        "plan approved. user's additional instructions: skip the migration step for now",
      );
    });

    it("surfaces cancel feedback in the tool error so the model knows the why", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "cancel", feedback: "out of scope for this branch" });
      const out = await reg.dispatch("submit_plan", JSON.stringify({ plan: "# Plan" }), {
        confirmationGate: gate,
      });
      expect(JSON.parse(out).error).toMatch(/plan cancelled: out of scope for this branch/);
    });
  });

  describe("registerPlanTool + mark_step_complete", () => {
    it("registers mark_step_complete as readOnly (safe during plan mode)", () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      expect(reg.has("mark_step_complete")).toBe(true);
      expect(reg.get("mark_step_complete")?.readOnly).toBe(true);
    });

    it("blocks on PauseGate on step complete and returns compact payload on continue", async () => {
      const reg = new ToolRegistry();
      const seen: StepCompletion[] = [];
      registerPlanTool(reg, { onStepCompleted: (u) => seen.push(u) });
      const gate = new AutoGate({ type: "continue" });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({
          stepId: "step-1",
          title: "Refactor auth",
          result: "Moved tokens into src/auth/tokens.ts.",
          notes: "Had to rename one export.",
        }),
        { confirmationGate: gate },
      );
      const parsed = JSON.parse(out);
      expect(parsed.kind).toBe("step_completed");
      expect(parsed.stepId).toBe("step-1");
      expect(parsed.result).toBe("Moved tokens into src/auth/tokens.ts.");
      expect(parsed.title).toBeUndefined();
      expect(parsed.notes).toBeUndefined();
      // No error wrapper — gate returns the structured payload directly
      expect(parsed.error).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.stepId).toBe("step-1");
      expect(seen[0]?.title).toBe("Refactor auth");
      expect(seen[0]?.notes).toBe("Had to rename one export.");
    });

    it("omits optional fields when empty", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "continue" });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "step-1", result: "done" }),
        { confirmationGate: gate },
      );
      const parsed = JSON.parse(out);
      expect(parsed.title).toBeUndefined();
      expect(parsed.notes).toBeUndefined();
      expect(parsed.result).toBe("done");
      expect(parsed.error).toBeUndefined();
    });

    it("keeps full evidence host-side but returns a compact model payload", async () => {
      const reg = new ToolRegistry();
      const seen: StepCompletion[] = [];
      registerPlanTool(reg, { onStepCompleted: (u) => seen.push(u) });
      const gate = new AutoGate({ type: "continue" });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({
          stepId: "step-1",
          result: "updated lifecycle guard",
          evidence: [
            {
              kind: "verification",
              summary: "targeted tests passed",
              command: "npm test tests/lifecycle.test.ts",
              paths: ["tests/lifecycle.test.ts"],
            },
          ],
        }),
        { confirmationGate: gate },
      );
      const parsed = JSON.parse(out);

      expect(seen[0]?.evidence).toEqual([
        {
          kind: "verification",
          summary: "targeted tests passed",
          command: "npm test tests/lifecycle.test.ts",
          paths: ["tests/lifecycle.test.ts"],
        },
      ]);
      expect(parsed).toMatchObject({
        kind: "step_completed",
        stepId: "step-1",
        result: "updated lifecycle guard",
        evidenceSummary: "verification: targeted tests passed",
      });
      expect(parsed.evidence).toBeUndefined();
      expect(out).not.toContain("npm test tests/lifecycle.test.ts");
      expect(out).not.toContain("tests/lifecycle.test.ts");
    });

    it("rejects completion without evidence when the host requires it", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg, {
        requireStepEvidence: () => "step touched high-risk code",
      });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "step-1", result: "updated lifecycle guard" }),
      );

      expect(JSON.parse(out).error).toMatch(/evidence required/);
      expect(JSON.parse(out).error).toMatch(/high-risk code/);
    });

    it("rejects an empty stepId", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "  ", result: "done" }),
      );
      expect(JSON.parse(out).error).toMatch(/stepId is required/);
    });

    it("rejects an empty result with a pointer at what to write", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "step-1", result: "   " }),
      );
      expect(JSON.parse(out).error).toMatch(/result is required/);
    });

    it("surfaces revise feedback in the tool result when gate resolves with feedback", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({
        type: "revise",
        feedback: "skip step 3 and add auth middleware",
      });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "step-2", result: "added tests" }),
        { confirmationGate: gate },
      );
      // Not JSON — the tool returns a plain string when feedback is present
      expect(out).toBe("revision requested: skip step 3 and add auth middleware");
    });

    it("throws user requested revision when revise has no feedback", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const gate = new AutoGate({ type: "revise" });
      const out = await reg.dispatch(
        "mark_step_complete",
        JSON.stringify({ stepId: "step-3", result: "finished wiring" }),
        { confirmationGate: gate },
      );
      expect(JSON.parse(out).error).toMatch(/user requested revision at checkpoint/);
    });
  });

  describe("PlanRevisionProposedError", () => {
    it("carries reason / remainingSteps / summary on the instance and in toToolResult()", () => {
      const err = new PlanRevisionProposedError(
        "User asked to skip cookie migration.",
        [
          { id: "step-3", title: "Skip migration", action: "Document the skip", risk: "low" },
          { id: "step-4", title: "Update tests", action: "Adjust suite", risk: "med" },
        ],
        "Refactor without prod migration",
      );
      expect(err.name).toBe("PlanRevisionProposedError");
      expect(err.remainingSteps).toHaveLength(2);
      const payload = err.toToolResult();
      expect(payload.reason).toBe("User asked to skip cookie migration.");
      expect(payload.summary).toBe("Refactor without prod migration");
      expect(payload.remainingSteps).toHaveLength(2);
      expect(payload.error).toMatch(/^PlanRevisionProposedError:/);
      expect(payload.error).toMatch(/STOP/);
    });

    it("omits summary from toToolResult when not provided", () => {
      const err = new PlanRevisionProposedError("a reason", [{ id: "x", title: "y", action: "z" }]);
      expect(err.toToolResult().summary).toBeUndefined();
    });
  });

  describe("registerPlanTool + revise_plan", () => {
    it("registers revise_plan as readOnly (it only emits a proposal, no side effects)", () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      expect(reg.has("revise_plan")).toBe(true);
      expect(reg.get("revise_plan")?.readOnly).toBe(true);
    });

    it("blocks on PauseGate when revising — returns accepted verdict", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ reason: string; steps: number }> = [];
      registerPlanTool(reg, {
        onPlanRevisionProposed: (reason, steps) => seen.push({ reason, steps: steps.length }),
      });
      const gate = new AutoGate({ type: "accepted" });
      const out = await reg.dispatch(
        "revise_plan",
        JSON.stringify({
          reason: "User asked to skip step 3.",
          remainingSteps: [
            { id: "step-3", title: "skip", action: "do nothing", risk: "low" },
            { id: "step-4", title: "tests", action: "update", risk: "med" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(out).toBe("revision accepted");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.steps).toBe(2);
    });

    it("rejects empty reason", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const out = await reg.dispatch(
        "revise_plan",
        JSON.stringify({
          reason: "  ",
          remainingSteps: [{ id: "x", title: "y", action: "z" }],
        }),
      );
      expect(JSON.parse(out).error).toMatch(/reason is required/);
    });

    it("rejects empty remainingSteps array", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const out = await reg.dispatch(
        "revise_plan",
        JSON.stringify({ reason: "skip everything", remainingSteps: [] }),
      );
      expect(JSON.parse(out).error).toMatch(/non-empty array/);
    });

    it("rejects when sanitization drops all steps", async () => {
      const reg = new ToolRegistry();
      registerPlanTool(reg);
      const out = await reg.dispatch(
        "revise_plan",
        JSON.stringify({
          reason: "ok",
          remainingSteps: [
            { id: "", title: "no id", action: "x" },
            { id: "x", title: "", action: "x" },
            { id: "y", title: "z", action: "" },
            "not-an-object",
          ],
        }),
      );
      expect(JSON.parse(out).error).toMatch(/non-empty array/);
    });

    it("preserves valid risk levels through revision", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ steps: Array<{ id: string; risk?: string }> }> = [];
      registerPlanTool(reg, {
        onPlanRevisionProposed: (_, steps) => seen.push({ steps }),
      });
      const gate = new AutoGate({ type: "accepted" });
      await reg.dispatch(
        "revise_plan",
        JSON.stringify({
          reason: "tighten",
          remainingSteps: [
            { id: "a", title: "t", action: "a", risk: "high" },
            { id: "b", title: "t", action: "a", risk: "low" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(seen[0]?.steps[0]?.risk).toBe("high");
      expect(seen[0]?.steps[1]?.risk).toBe("low");
    });

    it("includes an optional summary when provided", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ summary?: string }> = [];
      registerPlanTool(reg, {
        onPlanRevisionProposed: (_, __, summary) => seen.push({ summary }),
      });
      const gate = new AutoGate({ type: "accepted" });
      await reg.dispatch(
        "revise_plan",
        JSON.stringify({
          reason: "ok",
          remainingSteps: [{ id: "x", title: "y", action: "z" }],
          summary: "Refactor without migration",
        }),
        { confirmationGate: gate },
      );
      expect(seen[0]?.summary).toBe("Refactor without migration");
    });
  });
});

// ask_choice — schema, sanitization, ChoiceRequestedError → tool_result protocol.
describe("choice", () => {
  class AutoGate extends PauseGate {
    private _choice: { type: string; optionId?: string; text?: string };
    lastPayload: unknown;
    constructor(choice: { type: string; optionId?: string; text?: string }) {
      super();
      this._choice = choice;
    }
    override ask(_opts: { kind: string; payload?: unknown }): Promise<any> {
      this.lastPayload = _opts.payload;
      return Promise.resolve(this._choice);
    }
  }

  describe("ChoiceRequestedError", () => {
    it("carries the question / options / allowCustom on the instance and in toToolResult()", () => {
      const err = new ChoiceRequestedError(
        "Which framework?",
        [
          { id: "A", title: "Vitest" },
          { id: "B", title: "Jest", summary: "familiar to most" },
        ],
        true,
      );
      expect(err.name).toBe("ChoiceRequestedError");
      expect(err.question).toBe("Which framework?");
      expect(err.options).toHaveLength(2);
      expect(err.allowCustom).toBe(true);
      const payload = err.toToolResult();
      expect(payload.question).toBe("Which framework?");
      expect(payload.options).toEqual([
        { id: "A", title: "Vitest" },
        { id: "B", title: "Jest", summary: "familiar to most" },
      ]);
      expect(payload.allowCustom).toBe(true);
      expect(payload.error).toMatch(/^ChoiceRequestedError:/);
      // STOP instruction — same pattern as PlanProposedError so flash
      // doesn't race past the picker with more tool calls.
      expect(payload.error).toMatch(/STOP/);
    });
  });

  describe("registerChoiceTool + ask_choice", () => {
    it("registers ask_choice as readOnly (safe during plan mode too)", () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      expect(reg.has("ask_choice")).toBe(true);
      expect(reg.get("ask_choice")?.readOnly).toBe(true);
    });

    it("blocks on PauseGate and returns the user's pick", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ question: string; options: unknown }> = [];
      registerChoiceTool(reg, {
        onChoiceRequested: (q, o) => seen.push({ question: q, options: o }),
      });
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Pick a route.",
          options: [
            { id: "A", title: "Deepen demo" },
            { id: "B", title: "Start UE5", summary: "fresh engine" },
          ],
          allowCustom: true,
        }),
        { confirmationGate: gate },
      );
      expect(out).toBe("user picked: A");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.question).toBe("Pick a route.");
    });

    it("defaults allowCustom to true so free-text input is always available", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Which one?",
          options: [
            { id: "A", title: "one" },
            { id: "B", title: "two" },
          ],
        }),
        { confirmationGate: gate },
      );
      // Tool works without error — custom input is on by default
      expect(out).toBe("user picked: A");
      expect((gate.lastPayload as { allowCustom?: boolean }).allowCustom).toBe(true);
    });

    it("allowCustom: false explicitly hides the custom input", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Which one?",
          options: [
            { id: "A", title: "one" },
            { id: "B", title: "two" },
          ],
          allowCustom: false,
        }),
        { confirmationGate: gate },
      );
      expect(out).toBe("user picked: A");
      expect((gate.lastPayload as { allowCustom?: boolean }).allowCustom).toBe(false);
    });

    it("drops malformed option entries (DeepSeek sometimes misses fields)", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ options: { id: string; title: string }[] }> = [];
      registerChoiceTool(reg, {
        onChoiceRequested: (_q, opts) => seen.push({ options: opts as any }),
      });
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Pick.",
          options: [
            { id: "A", title: "good" },
            { id: "", title: "no id" },
            { id: "B", title: "" },
            "not-an-object",
            null,
            { id: "C", title: "also good" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(seen[0]?.options).toEqual([
        { id: "A", title: "good" },
        { id: "C", title: "also good" },
      ]);
    });

    it("deduplicates options with the same id (first one wins)", async () => {
      const reg = new ToolRegistry();
      const seen: Array<{ question: string; options: unknown }> = [];
      registerChoiceTool(reg, {
        onChoiceRequested: (q, o) => seen.push({ question: q, options: o }),
      });
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Pick.",
          options: [
            { id: "A", title: "first" },
            { id: "A", title: "dup" },
            { id: "B", title: "second" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(seen[0]?.options).toEqual([
        { id: "A", title: "first" },
        { id: "B", title: "second" },
      ]);
    });

    it("rejects an empty question", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "  ",
          options: [
            { id: "A", title: "one" },
            { id: "B", title: "two" },
          ],
        }),
      );
      expect(JSON.parse(out).error).toMatch(/question is required/);
    });

    it("rejects when fewer than 2 well-formed options remain", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Pick.",
          options: [{ id: "A", title: "only one" }],
        }),
      );
      expect(JSON.parse(out).error).toMatch(/at least 2 well-formed options/);
    });

    it("rejects runaway option lists (>6 entries)", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      const options = Array.from({ length: 7 }, (_, i) => ({
        id: `opt-${i}`,
        title: `option ${i}`,
      }));
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({ question: "too many", options }),
      );
      expect(JSON.parse(out).error).toMatch(/too many options/);
    });

    it("keeps the tool passable in plan mode (branching questions can fire mid-plan)", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      reg.setPlanMode(true);
      const gate = new AutoGate({ type: "pick", optionId: "A" });
      const out = await reg.dispatch(
        "ask_choice",
        JSON.stringify({
          question: "Which branch?",
          options: [
            { id: "A", title: "a" },
            { id: "B", title: "b" },
          ],
        }),
        { confirmationGate: gate },
      );
      expect(out).toBe("user picked: A");
    });

    it("marks ask_choice with userIntervention: true and tracks pending in PauseGate", async () => {
      const reg = new ToolRegistry();
      registerChoiceTool(reg);
      expect(reg.isUserIntervention("ask_choice")).toBe(true);

      const gate = new PauseGate();
      gate.on(() => {
        // listener registered so ask does not throw
      });
      expect(gate.hasPending()).toBe(false);
      const promise = gate.ask({
        kind: "choice",
        payload: {
          question: "Wait?",
          options: [{ id: "1", title: "one" }],
          allowCustom: true,
        },
      });
      expect(gate.hasPending()).toBe(true);
      gate.resolve(0, { type: "pick", optionId: "1" });
      const verdict = await promise;
      expect(verdict.type).toBe("pick");
      expect(gate.hasPending()).toBe(false);
    });
  });
});
