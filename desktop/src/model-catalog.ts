import {
  ANTIGRAVITY_MODELS,
  EXPERIENTIAL_MODELS,
  MIMO_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  PROVIDER_MODEL_PRECEDENCE,
  type ProviderID,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  isUsableAntigravityModel,
  modelAcceptsImages,
  qualifyModelRef,
  stripProviderQualifier,
} from "@reasonix/core-utils";

export type ModelCatalogGroupKey =
  | "deepseek"
  | "openai"
  | "zai"
  | "mimo"
  | "opencode"
  | "typesafe"
  | "antigravity"
  | "experiential";

export type ProviderCatalogKey =
  | "deepseek"
  | "openai"
  | "zai"
  | "mimo"
  | "typesafe"
  | "experiential";

export interface ProviderCatalogView {
  models: readonly string[];
  source: "live" | "cache" | "fallback";
  error?: string;
}

export const MODEL_CATALOG_GROUP_LABELS = {
  deepseek: "composer.modelDeepSeekGroup",
  openai: "composer.modelOpenAIGroup",
  zai: "composer.modelZaiGroup",
  mimo: "composer.modelMimoGroup",
  opencode: "composer.modelOpencodeGroup",
  typesafe: "settings.typesafeSection",
  antigravity: "composer.modelAntigravityGroup",
  experiential: "composer.modelExperientialGroup",
} as const satisfies Record<ModelCatalogGroupKey, string>;

export interface ModelCatalogGroup {
  key: ModelCatalogGroupKey;
  models: readonly string[];
}

export interface ModelCatalogOptions {
  providerCatalogs?: Partial<Record<ProviderCatalogKey, ProviderCatalogView>>;
  discoveredAntigravityModels?: readonly string[];
  opencodeModels?: readonly string[];
  includeAntigravity?: boolean;
  ollamaVisionModels?: ReadonlySet<string>;
  opencodeVisionModels?: ReadonlySet<string>;
}

export interface ModelCatalogView {
  groups: ModelCatalogGroup[];
  antigravityModelIds: string[];
  acceptsImages(model: string | undefined | null): boolean;
}

/** Derive model membership and capabilities once for every desktop picker.
 * Provider identity is never inferred from an id: Antigravity membership comes
 * only from the built-in catalog or daemon-discovered model ids. */
export function deriveModelCatalog(options: ModelCatalogOptions): ModelCatalogView {
  const antigravityModelIds = Array.from(
    new Set([
      ...(options.discoveredAntigravityModels?.filter(isUsableAntigravityModel) ?? []),
      ...ANTIGRAVITY_MODELS,
    ]),
  );
  const opencodeModels =
    options.opencodeModels && options.opencodeModels.length > 0
      ? options.opencodeModels
      : OPENCODE_MODELS;
  const includeAntigravity = options.includeAntigravity === true;
  const catalogFor = (key: ProviderCatalogKey, fallback: readonly string[]): readonly string[] =>
    options.providerCatalogs?.[key]
      ? [...new Set([...options.providerCatalogs[key]!.models, ...fallback])]
      : fallback;
  const groupProvider: Record<ModelCatalogGroupKey, ProviderID | null> = {
    deepseek: "deepseek",
    openai: "openai",
    zai: "zai",
    mimo: "mimo",
    opencode: "opencode",
    // JEV/TypeSafe models have no routable provider id, so they are never
    // qualified — and never take a bare id from a provider that does route.
    typesafe: null,
    antigravity: "gemini",
    experiential: "experiential",
  };
  // One list per group and one order, so the ownership pass and the rendered
  // cards can never disagree about a row's value. Every group contributes,
  // visible card or not: a card appearing (sign-in, live catalogs) must not
  // change the values already saved in `enabledModels`.
  const groupModels: Record<ModelCatalogGroupKey, readonly string[]> = {
    deepseek: catalogFor("deepseek", SUPPORTED_OFFICIAL_MODELS),
    openai: catalogFor("openai", OPENAI_MODELS),
    zai: catalogFor("zai", ZAI_MODELS),
    mimo: catalogFor("mimo", MIMO_MODELS),
    opencode: opencodeModels,
    typesafe: catalogFor("typesafe", ["jev-latest"]),
    experiential: catalogFor("experiential", EXPERIENTIAL_MODELS),
    antigravity: antigravityModelIds,
  };
  const GROUP_ORDER: readonly ModelCatalogGroupKey[] = [
    "deepseek",
    "openai",
    "zai",
    "mimo",
    "opencode",
    "typesafe",
    "experiential",
    "antigravity",
  ];
  // A row's value is also its `enabledModels` key, so it must be unique across
  // every card: OpenCode and the Experiential gateway both serve
  // `deepseek-v4.1-flash`, and while both rows carried that same bare value one
  // toggle hit both providers. Only the routing owner keeps the bare form; every
  // other provider serving the id gets its own `<provider>/<id>`.
  const rank = new Map(PROVIDER_MODEL_PRECEDENCE.map((provider, index) => [provider, index]));
  const rankOf = (provider: ProviderID): number => rank.get(provider) ?? Number.MAX_SAFE_INTEGER;
  const owner = new Map<string, ProviderID>();
  for (const key of GROUP_ORDER) {
    const provider = groupProvider[key];
    if (!provider) continue;
    for (const id of groupModels[key]) {
      const wire = stripProviderQualifier(id);
      const current = owner.get(wire);
      if (current === undefined || rankOf(provider) < rankOf(current)) owner.set(wire, provider);
    }
  }
  const distinctModels = (key: ModelCatalogGroupKey): readonly string[] => {
    const provider = groupProvider[key];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of groupModels[key]) {
      const ownsId = owner.get(stripProviderQualifier(id));
      const value =
        provider && ownsId !== undefined && ownsId !== provider
          ? qualifyModelRef(provider, id)
          : id;
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  };
  const visible = (key: ModelCatalogGroupKey): boolean =>
    key === "typesafe"
      ? options.providerCatalogs?.typesafe !== undefined
      : key === "experiential"
        ? options.providerCatalogs?.experiential !== undefined
        : key === "antigravity"
          ? includeAntigravity
          : true;
  const groups: ModelCatalogGroup[] = GROUP_ORDER.filter(visible).map((key) => ({
    key,
    models: distinctModels(key),
  }));

  return {
    groups,
    antigravityModelIds,
    acceptsImages: (model) =>
      modelAcceptsImages(model, options.ollamaVisionModels, options.opencodeVisionModels),
  };
}
