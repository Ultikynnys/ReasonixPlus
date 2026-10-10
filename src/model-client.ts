import { resolveGeminiAuth } from "./antigravity-oauth.js";
import { DeepSeekClient, type DeepSeekClientOptions } from "./client.js";
import { resolveCodexTransport } from "./codex-backend.js";
import {
  DEFAULT_OPENCODE_CHAT_URL,
  DEFAULT_ZAI_RESPONSES_URL,
  isOpenAIStandardEndpoint,
  loadEndpointForModel,
  loadOpencodeApiKey,
  providerForModel,
  readConfig,
} from "./config.js";
import { resolveOpenAIToken } from "./oauth.js";
import { resolveOpencodeToken } from "./opencode-oauth.js";

export interface ResolvedModelClientOptions {
  model: string;
  configPath?: string;
  sessionId?: string;
}

/** Build endpoint-aware client options shared by primary and subagent runtimes. */
export function modelClientOptions(opts: ResolvedModelClientOptions): DeepSeekClientOptions {
  const endpoint = loadEndpointForModel(opts.model, opts.configPath);
  const provider = providerForModel(opts.model, opts.configPath);
  const openAIStandard = isOpenAIStandardEndpoint(opts.model, opts.configPath);

  return {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    sessionId: opts.sessionId,
    allowMissingKey: provider === "ollama" || provider === "opencode",
    apiKeyResolver: openAIStandard
      ? () => resolveOpenAIToken(opts.configPath)
      : provider === "opencode"
        ? // OpenCode Go / Go+ inference authenticates with the workspace service
          // key (`oc_sk…`) against the Go gateway. A Console OAuth session token
          // is a different credential and is rejected by the Go/Zen gateways
          // (401 "Invalid API key"), so it must only be a fallback when no
          // service key is configured.
          async () => loadOpencodeApiKey(opts.configPath) ?? resolveOpencodeToken(opts.configPath)
        : undefined,
    opencodeOrgResolver:
      provider === "opencode" ? () => readConfig(opts.configPath).opencodeOAuth?.orgId : undefined,
    transportResolver: openAIStandard
      ? () => resolveCodexTransport()
      : provider === "opencode" && opts.model.startsWith("muse-")
        ? async () => ({
            endpoint: `${endpoint.baseUrl ?? DEFAULT_OPENCODE_CHAT_URL}/responses`,
            headers: {
              Authorization: `Bearer ${
                (await resolveOpencodeToken(opts.configPath)) ?? endpoint.apiKey ?? "public"
              }`,
            },
            api: "responses" as const,
          })
        : provider === "zai"
          ? async () => ({
              endpoint: `${DEFAULT_ZAI_RESPONSES_URL}/responses`,
              headers: { Authorization: `Bearer ${endpoint.apiKey ?? ""}` },
              api: "responses" as const,
            })
          : undefined,
    geminiAuthResolver:
      provider === "gemini" ? () => resolveGeminiAuth(opts.configPath) : undefined,
  };
}

/** Construct a client using the canonical endpoint, auth, and transport policy. */
export function createModelClient(opts: ResolvedModelClientOptions): DeepSeekClient {
  return new DeepSeekClient(modelClientOptions(opts));
}
