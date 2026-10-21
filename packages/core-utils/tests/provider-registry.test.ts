import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_MODELS,
  DEFAULT_MODEL,
  KNOWN_MODELS,
  MIMO_SPEECH_MODELS,
  OPENCODE_GO_MODELS,
  OPENCODE_VISION_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  modelAcceptsImages,
} from "../src/models.js";
import {
  PROVIDER_IDS,
  PROVIDER_MODEL_PRECEDENCE,
  PROVIDER_REASONING_EFFORTS,
  PROVIDER_SPECS,
  type ProviderCredentialContext,
  type ProviderID,
  type ProviderSpec,
  ROUTABLE_PROVIDER_SPECS,
  parseProviderRegistry,
  providerCountsAsConfigured,
  providerReasoningEfforts,
  providerSettingSpec,
  providerShortLabel,
  providerSpec,
  providerString,
  providerUsable,
  providerVisionSpec,
  requireProviderSpec,
  resolveProviderEndpoint,
  specForProvider,
  usageMinIntervalMs,
} from "../src/provider-registry.js";
import { REASONING_EFFORT_ORDER } from "../src/reasoning-efforts.js";

function ctxFor(
  env: Record<string, string> = {},
  store: Record<string, string> = {},
): ProviderCredentialContext {
  return {
    env: (name) => env[name],
    setting: (path) => store[path],
  };
}

function endpointFor(
  id: string,
  env: Record<string, string> = {},
  config: Record<string, string> = {},
  tier?: string,
) {
  return resolveProviderEndpoint(requireProviderSpec(id), { ...ctxFor(env, config), tier });
}

/** A catalog-only provider described entirely in JSON — the shape a new
 *  embedded provider takes when it never routes a bare model id. */
const ACME = {
  id: "acme",
  providerId: null,
  label: "Acme",
  groupLabelKey: "settings.opencodeSection",
  order: 20,
  setupGate: ["apiKey"],
  precedence: null,
  defaultModel: "acme-1",
  knownCatalog: false,
  models: ["acme-1"],
  goModels: [],
  speechModels: [],
  vision: { patterns: ["^acme-"] },
  modelFilter: null,
  reasoningEfforts: ["high"],
  endpoint: { strategy: "standard", default: "https://api.acme.test/v1", tiers: {} },
  settings: [
    {
      key: "apiKey",
      kind: "secret",
      env: ["ACME_API_KEY"],
      configKey: "acmeApiKey",
      label: "Acme API key",
    },
    {
      key: "baseUrl",
      kind: "url",
      env: ["ACME_BASE_URL"],
      configKey: "acmeBaseUrl",
      label: "Acme base URL",
    },
  ],
  credentials: {
    publicKey: null,
    oauthConfig: null,
  },
  usable: { apiKey: true, keylessLocal: false, always: false },
  discovery: {
    strategy: "models-endpoint",
    listField: "assets",
    idField: "slug",
    excludeSpeech: false,
  },
  client: { auth: "api-key", transport: null, allowMissingKey: false },
};

describe("providers.json", () => {
  it("lists exactly the routable ProviderID union", () => {
    const declared = ROUTABLE_PROVIDER_SPECS.map((spec) => spec.providerId).sort();
    expect(declared).toEqual([...PROVIDER_IDS].sort());
  });

  it("keeps catalog ids unique and descriptive", () => {
    expect(new Set(PROVIDER_SPECS.map((spec) => spec.id)).size).toBe(PROVIDER_SPECS.length);
    for (const spec of PROVIDER_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.groupLabelKey).toContain(".");
      expect(Number.isFinite(spec.order)).toBe(true);
    }
  });

  it("tags every provider with a distinct short model prefix", () => {
    const tags = PROVIDER_SPECS.map((spec) => spec.shortLabel);
    for (const tag of tags) {
      expect(tag.length).toBeGreaterThan(0);
      // A tag prefixes a model id, so it must stay short enough to read inline.
      expect(tag.length).toBeLessThanOrEqual(5);
    }
    expect(new Set(tags).size).toBe(tags.length);
    expect(requireProviderSpec("deepseek").shortLabel).toBe("DS");
    expect(providerShortLabel("deepseek")).toBe("DS");
    expect(providerShortLabel("no-such-provider")).toBe("");
  });

  it("points every sign-up link at the provider's own host", () => {
    // A "get a key" link is data, so it goes stale silently. Pinning the host (not
    // the path) catches a wrong or copy-pasted vendor URL without freezing routes.
    for (const spec of PROVIDER_SPECS) {
      for (const setting of spec.settings) {
        if (setting.signupUrl === null) continue;
        const link = new URL(setting.signupUrl);
        expect(link.protocol).toBe("https:");
        expect(
          spec.errors.hosts.some(
            (suffix) => link.hostname === suffix || link.hostname.endsWith(`.${suffix}`),
          ),
        ).toBe(true);
      }
    }
    // The experienced bug: a path no longer served for this provider.
    expect(providerSettingSpec(requireProviderSpec("experiential"), "apiKey")?.signupUrl).toBe(
      "https://platform.experientiallabs.ai/settings/api-keys",
    );
  });

  it("declares a balance endpoint only where one exists", () => {
    // The ribbon reads this to decide whether a wallet chip can ever be filled;
    // a provider without one shows measured cost instead of an empty chip.
    expect(requireProviderSpec("deepseek").billing.balance).toEqual({
      url: "/user/balance",
      shape: "balance-infos",
    });
    // The gateway's credits ledger lives on another route of its host, so the
    // declaration carries an absolute URL and the shape that reply speaks.
    expect(requireProviderSpec("experiential").billing.balance).toEqual({
      url: "https://api.experientiallabs.ai/api/v1/credits",
      shape: "credits-usage",
    });
    expect(requireProviderSpec("synthetic").billing.balance).toBeNull();
    const declared = PROVIDER_SPECS.filter((spec) => spec.billing.balance !== null);
    expect(declared.map((spec) => spec.id).sort()).toEqual(["deepseek", "experiential"]);
  });

  it("declares where every probing provider publishes usage", () => {
    // The daemon reads these addresses instead of owning them, so a provider that
    // moves its usage route is a JSON edit. Pinning the declared contract (not the
    // vendor's path) keeps a new provider honest without freezing its routes.
    const probing = PROVIDER_SPECS.filter((spec) => spec.usage.probe !== null);
    expect(probing.map((spec) => spec.id).sort()).toEqual([
      "experiential",
      "gemini",
      "mimo",
      "ollama",
      "openai",
      "opencode",
      "synthetic",
      "zai",
    ]);
    for (const spec of probing) {
      expect(spec.usage.minIntervalSeconds).toBeGreaterThan(0);
      for (const url of spec.usage.urls) {
        if (url.startsWith("/")) continue;
        expect(new URL(url).protocol).toBe("https:");
      }
    }
    // Z.AI's 5-hour window is what its copy calls "{left}"; Codex answers weekly.
    expect(requireProviderSpec("zai").usage).toMatchObject({
      urls: ["/api/monitor/usage/quota/limit"],
      primaryWindow: "5h",
      resetsStyle: "absolute",
    });
    expect(requireProviderSpec("openai").usage).toMatchObject({
      primaryWindow: "wk",
      resetsStyle: "absolute",
    });
    // The free tier must never ask a custom proxy for usage: the address is gated
    // on the hosts this provider declares.
    expect(requireProviderSpec("opencode").usage.urlGate).toBe("declared-hosts");
    // Antigravity's reader composes its addresses from the declared endpoint RPCs.
    expect(requireProviderSpec("gemini").usage.urls).toEqual([]);
    // Experiential's reader walks these four in order, each step filling the next
    // one's placeholder, so a reordering here breaks the probe and must fail loudly.
    expect(requireProviderSpec("experiential").usage).toMatchObject({
      probe: "experiential-spend",
      primaryWindow: "day",
      urls: [
        "/api/whoami",
        "/api/gateway/usage/events?org_id={org_id}&limit=1000",
        "/api/gateway/keys/{api_key_id}/limits",
        "/api/gateway/usage/daily?org_id={org_id}&scope=org&group_by=day",
      ],
    });
    // Its wallet and its quota are separate routes, both declared.
    expect(requireProviderSpec("experiential").billing.balance).toEqual({
      url: "https://api.experientiallabs.ai/api/v1/credits",
      shape: "credits-usage",
    });
  });

  it("exposes each provider's declared refresh floor in ms, with one default", () => {
    // The daemon reads this instead of restating the number, so a spec's floor and
    // the fallback for an undeclared provider are the same arithmetic.
    for (const spec of PROVIDER_SPECS) {
      expect(usageMinIntervalMs(spec)).toBe(spec.usage.minIntervalSeconds * 1000);
    }
    expect(usageMinIntervalMs(undefined)).toBeGreaterThan(0);
    expect(usageMinIntervalMs(undefined) % 1000).toBe(0);
  });

  it("orders bare-id precedence exactly as declared", () => {
    // Derived, so deleting a provider file shrinks the order instead of failing.
    const declared = PROVIDER_SPECS.filter((spec) => spec.precedence !== null)
      .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
      .map((spec) => spec.id);
    expect(PROVIDER_MODEL_PRECEDENCE).toEqual(declared);
    expect(PROVIDER_SPECS.find((spec) => spec.id === "ollama")?.precedence ?? null).toBeNull();
  });

  it("declares canonical effort ladders once per routable provider", () => {
    expect(Object.keys(PROVIDER_REASONING_EFFORTS).sort()).toEqual([...PROVIDER_IDS].sort());
    for (const levels of Object.values(PROVIDER_REASONING_EFFORTS)) {
      for (const level of levels) expect(REASONING_EFFORT_ORDER).toContain(level);
    }
    expect(providerReasoningEfforts("mimo")).toEqual([]);
    expect(providerReasoningEfforts("experiential")).toEqual([]);
  });

  it("feeds every exported catalog", () => {
    expect(SUPPORTED_OFFICIAL_MODELS).toEqual(requireProviderSpec("deepseek").models);
    expect(ZAI_MODELS).toEqual(requireProviderSpec("zai").models);
    expect(OPENCODE_GO_MODELS).toEqual(requireProviderSpec("opencode").goModels);
    expect([...MIMO_SPEECH_MODELS]).toEqual(requireProviderSpec("mimo").speechModels);
    expect(ANTIGRAVITY_MODELS).toEqual(requireProviderSpec("gemini").models);
    expect([...OPENCODE_VISION_MODELS]).toEqual(
      requireProviderSpec("opencode").vision.models ?? [],
    );
  });

  it("builds KNOWN_MODELS from the knownCatalog entries in display order", () => {
    const expected = ROUTABLE_PROVIDER_SPECS.filter((spec) => spec.knownCatalog).flatMap(
      (spec) => spec.models,
    );
    expect(KNOWN_MODELS).toEqual(expected);
    const experiential = PROVIDER_SPECS.find((spec) => spec.id === "experiential");
    if (experiential) expect(KNOWN_MODELS).not.toContain(experiential.models[0]);
  });

  it("pins the install default model to DeepSeek's declared default", () => {
    expect(DEFAULT_MODEL).toBe(requireProviderSpec("deepseek").defaultModel);
  });
});

describe("resolveProviderEndpoint", () => {
  it("keeps a custom base URL's own key", () => {
    expect(
      endpointFor(
        "zai",
        { ZAI_API_KEY: "env-key" },
        { "zai.baseUrl": "https://proxy/v1", "zai.apiKey": "cfg" },
      ),
    ).toEqual({ baseUrl: "https://proxy/v1", apiKey: "cfg" });
  });

  it("lets an env base URL own the env key", () => {
    expect(
      endpointFor(
        "zai",
        { ZAI_BASE_URL: "https://env/v1", ZAI_API_KEY: "env-key" },
        { "zai.baseUrl": "https://proxy/v1", "zai.apiKey": "cfg" },
      ),
    ).toEqual({ baseUrl: "https://env/v1", apiKey: "env-key" });
  });

  it("falls back to the declared default endpoint and the resolved key", () => {
    expect(endpointFor("mimo", {}, { "mimo.apiKey": "cfg" })).toEqual({
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "cfg",
    });
  });

  it("declares no default for a provider that requires configuration", () => {
    expect(endpointFor("deepseek")).toEqual({ baseUrl: undefined, apiKey: undefined });
  });

  it("resolves Ollama's key through config even on an env base URL", () => {
    expect(
      endpointFor(
        "ollama",
        { OLLAMA_BASE_URL: "http://localhost:11434/v1" },
        { "ollama.apiKey": "cfg" },
      ),
    ).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: "cfg" });
  });

  it("switches OpenCode to its declared Go tier and keeps the public key", () => {
    expect(endpointFor("opencode", {}, {}, "go")).toEqual({
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "public",
    });
    expect(endpointFor("opencode")).toEqual({
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "public",
    });
  });

  it("keeps Gemini on its fixed endpoint with no static key", () => {
    expect(endpointFor("gemini", { GEMINI_BASE_URL: "https://ignored" })).toEqual({
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      apiKey: undefined,
    });
  });
});

describe("providerUsable", () => {
  const usable = (
    spec: ProviderSpec,
    context: ProviderCredentialContext,
    endpoint: {
      baseUrl: string | undefined;
      apiKey: string | undefined;
    },
  ) => providerUsable(spec, { ...context, endpoint });

  it("counts a keyless localhost daemon as runnable", () => {
    const spec = requireProviderSpec("ollama");
    expect(
      usable(spec, ctxFor(), { baseUrl: "http://localhost:11434/v1", apiKey: undefined }),
    ).toBe(true);
    expect(usable(spec, ctxFor(), { baseUrl: "https://ollama.com/v1", apiKey: undefined })).toBe(
      false,
    );
  });

  it("requires the sign-in for a quota-only provider", () => {
    const spec = requireProviderSpec("gemini");
    expect(usable(spec, ctxFor(), { baseUrl: "https://x", apiKey: undefined })).toBe(false);
    expect(
      usable(
        spec,
        { ...ctxFor(), oauthToken: () => "token" },
        {
          baseUrl: "https://x",
          apiKey: undefined,
        },
      ),
    ).toBe(true);
  });

  it("accepts either a key or a sign-in for OpenAI", () => {
    const spec = requireProviderSpec("openai");
    expect(usable(spec, ctxFor(), { baseUrl: "https://api.openai.com/v1", apiKey: "sk" })).toBe(
      true,
    );
    expect(
      usable(
        spec,
        { ...ctxFor(), oauthToken: () => "token" },
        {
          baseUrl: "https://api.openai.com/v1",
          apiKey: undefined,
        },
      ),
    ).toBe(true);
    expect(
      usable(spec, ctxFor(), { baseUrl: "https://api.openai.com/v1", apiKey: undefined }),
    ).toBe(false);
  });

  it("treats a public-key provider as always runnable", () => {
    expect(
      usable(requireProviderSpec("opencode"), ctxFor(), {
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: undefined,
      }),
    ).toBe(true);
  });
});

describe("providerCountsAsConfigured", () => {
  it("counts only the sources each provider gates setup on", () => {
    expect(
      providerCountsAsConfigured(
        requireProviderSpec("mimo"),
        ctxFor({}, { "mimo.baseUrl": "https://x" }),
      ),
    ).toBe(true);
    expect(
      providerCountsAsConfigured(
        requireProviderSpec("zai"),
        ctxFor({}, { "zai.baseUrl": "https://x" }),
      ),
    ).toBe(false);
    expect(
      providerCountsAsConfigured(
        requireProviderSpec("deepseek"),
        ctxFor({ DEEPSEEK_API_KEY: "sk" }),
      ),
    ).toBe(true);
    expect(
      providerCountsAsConfigured(requireProviderSpec("gemini"), {
        ...ctxFor(),
        oauthToken: () => "token",
      }),
    ).toBe(true);
  });
});

describe("vision rules", () => {
  it("inherits the DeepSeek catalog for Ollama tags", () => {
    const rule = providerVisionSpec("ollama");
    expect(rule.models).toEqual(requireProviderSpec("deepseek").vision.models);
    expect(rule.stripSchemeAndTag).toBe(true);
    expect(modelAcceptsImages("ollama/deepseek-v4.1-flash:cloud")).toBe(true);
  });

  it("matches declared patterns and rejects unknown ids", () => {
    expect(modelAcceptsImages("gpt-6-luna")).toBe(true);
    expect(modelAcceptsImages("glm-4.6v")).toBe(true);
    expect(modelAcceptsImages("some-unlisted-model")).toBe(false);
  });
});

describe("adding a provider", () => {
  it("needs only a providers.json entry for a catalog-only provider", () => {
    const parsed = parseProviderRegistry({ providers: [ACME] });
    expect(parsed).toHaveLength(1);
    const spec = parsed[0]!;
    expect(spec.providerId).toBeNull();
    expect(spec.discovery).toMatchObject({ listField: "assets", idField: "slug" });
    // Credentials are derived from the declared settings, never repeated.
    expect(spec.credentials).toEqual({
      baseUrlEnv: ["ACME_BASE_URL"],
      apiKeyEnv: ["ACME_API_KEY"],
      baseUrlSetting: "acme.baseUrl",
      apiKeySetting: "acme.apiKey",
      publicKey: null,
      oauthConfig: null,
    });
    expect(providerSettingSpec(spec, "apiKey")?.env).toEqual(["ACME_API_KEY"]);
    expect(resolveProviderEndpoint(spec, ctxFor())).toEqual({
      baseUrl: "https://api.acme.test/v1",
      apiKey: undefined,
    });
    expect(
      resolveProviderEndpoint(
        spec,
        ctxFor({ ACME_BASE_URL: "https://acme-proxy/v1", ACME_API_KEY: "k" }),
      ),
    ).toEqual({ baseUrl: "https://acme-proxy/v1", apiKey: "k" });
    expect(providerCountsAsConfigured(spec, ctxFor({}, { "acme.apiKey": "k" }))).toBe(true);
    expect(providerCountsAsConfigured(spec, ctxFor())).toBe(false);
  });

  it("rejects an undeclared endpoint strategy with the entry in the message", () => {
    const broken = { ...ACME, endpoint: { ...ACME.endpoint, strategy: "carrier-pigeon" } };
    expect(() => parseProviderRegistry({ providers: [broken] })).toThrow(
      /endpoint\.strategy: unsupported value "carrier-pigeon"/,
    );
  });

  it("rejects a usage address that would leak a key over plain http", () => {
    const broken = { ...ACME, usage: { probe: "zai-monitor", urls: ["http://usage.test/limit"] } };
    expect(() => parseProviderRegistry({ providers: [broken] })).toThrow(
      /usage\.urls\[0\]: expected a \/path or an https URL/,
    );
  });

  it("rejects an unknown usage url base, gate or reset style", () => {
    for (const [key, value] of [
      ["urlBase", "hostname"],
      ["urlGate", "own-host"],
      ["resetsStyle", "friendly"],
      ["primaryWindow", "1d"],
    ] as const) {
      const broken = { ...ACME, usage: { probe: "zai-monitor", [key]: value } };
      expect(() => parseProviderRegistry({ providers: [broken] })).toThrow(
        new RegExp(`usage\\.${key}: unsupported value "${value}"`),
      );
    }
  });

  it("rejects a refresh floor that is not a positive whole number of seconds", () => {
    for (const value of [0, -5, 1.5]) {
      const broken = { ...ACME, usage: { probe: "zai-monitor", minIntervalSeconds: value } };
      expect(() => parseProviderRegistry({ providers: [broken] })).toThrow(
        /usage\.minIntervalSeconds: expected a whole number of seconds above zero/,
      );
    }
  });

  it("rejects duplicate ids", () => {
    expect(() => parseProviderRegistry({ providers: [ACME, ACME] })).toThrow(/duplicate id/);
  });

  it("maps every routable provider to its own entry", () => {
    for (const id of PROVIDER_IDS) expect(specForProvider(id).providerId).toBe(id);
  });
});

describe("declared dispatches", () => {
  it("marks exactly one vision catalog as runtime-refreshable", () => {
    const refreshable = ROUTABLE_PROVIDER_SPECS.filter(
      (spec) => providerVisionSpec(spec.providerId as ProviderID).refreshable === true,
    );
    expect(refreshable.map((spec) => spec.providerId)).toEqual(["opencode"]);
  });

  it("replaces a refreshable catalog instead of merging it", () => {
    // `mimo-v2.5-free` is in the static OpenCode vision catalog.
    expect(modelAcceptsImages("mimo-v2.5-free")).toBe(true);
    expect(modelAcceptsImages("mimo-v2.5-free", null, new Set())).toBe(false);
    expect(modelAcceptsImages("mimo-v2.5-free", null, new Set(["mimo-v2.5-free"]))).toBe(true);
  });

  it("declares a picker group only when it differs from the provider id", () => {
    for (const spec of PROVIDER_SPECS) {
      if (spec.pickerGroup !== null) expect(spec.pickerGroup).not.toBe(spec.id);
    }
    expect(requireProviderSpec("gemini").pickerGroup).toBe("antigravity");
  });

  it("answers an unknown id without throwing where absence is allowed", () => {
    expect(providerSpec("nope")).toBeUndefined();
    expect(providerVisionSpec("nope" as ProviderID)).toEqual({});
    expect(() => requireProviderSpec("nope")).toThrow(/no entry for "nope"/);
    expect(() => specForProvider("nope" as ProviderID)).toThrow(/no routable entry for "nope"/);
  });
});

describe("providerString", () => {
  const spec = { strings: { greeting: "Hi {name}", blank: "" } } as unknown as ProviderSpec;

  it("fills declared placeholders", () => {
    expect(providerString(spec, "greeting", { name: "Sam" })).toBe("Hi Sam");
    expect(providerString("zai", "quotaLabel")).toBe("GLM usage");
  });

  it("keeps an unmatched placeholder literal instead of printing undefined", () => {
    expect(providerString(spec, "greeting", { other: "x" })).toBe("Hi {name}");
  });

  it("treats an undeclared provider, key or empty value as absent", () => {
    expect(providerString(spec, "missing")).toBeUndefined();
    expect(providerString(spec, "blank")).toBeUndefined();
    expect(providerString("no-such-provider", "greeting")).toBeUndefined();
    expect(providerString(undefined, "greeting")).toBeUndefined();
  });

  it("resolves an id and an already-resolved spec to the same copy", () => {
    const vars = { when: "3h" };
    expect(providerString("deepseek", "offPeakTitle", vars)).toBe(
      providerString(providerSpec("deepseek"), "offPeakTitle", vars),
    );
    expect(providerString("deepseek", "offPeakTitle", vars)).toContain("changes in 3h");
  });
});
