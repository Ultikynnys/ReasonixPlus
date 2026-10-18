import {
  ANTIGRAVITY_MODELS,
  EXPERIENTIAL_MODELS,
  MIMO_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  type ProviderID,
  isUsableAntigravityModel,
  modelAcceptsImages,
  needsProviderQualifier,
  qualifyModelRef,
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
  // Picker identity for cross-provider ids: an id an earlier provider catalog also
  // serves resolves to that provider when sent bare, so this group's row carries a
  // `<provider>/<id>` qualifier (mimo-v2.6-pro under OPENCODE → opencode/…).
  const groupProvider: Record<ModelCatalogGroupKey, ProviderID | null> = {
    deepseek: "deepseek",
    openai: "openai",
    zai: "zai",
    mimo: "mimo",
    opencode: "opencode",
    typesafe: null,
    antigravity: null,
    experiential: "experiential",
  };
  const distinctModels = (
    key: ModelCatalogGroupKey,
    models: readonly string[],
  ): readonly string[] => {
    const provider = groupProvider[key];
    if (!provider) return models;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of models) {
      const value = needsProviderQualifier(provider, id) ? qualifyModelRef(provider, id) : id;
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  };
  const rawGroups: ModelCatalogGroup[] = [
    { key: "deepseek", models: catalogFor("deepseek", SUPPORTED_OFFICIAL_MODELS) },
    { key: "openai", models: catalogFor("openai", OPENAI_MODELS) },
    { key: "zai", models: catalogFor("zai", ZAI_MODELS) },
    { key: "mimo", models: catalogFor("mimo", MIMO_MODELS) },
    { key: "opencode", models: opencodeModels },
    ...(options.providerCatalogs?.typesafe
      ? [{ key: "typesafe" as const, models: catalogFor("typesafe", ["jev-latest"]) }]
      : []),
    ...(options.providerCatalogs?.experiential
      ? [{ key: "experiential" as const, models: catalogFor("experiential", EXPERIENTIAL_MODELS) }]
      : []),
    ...(includeAntigravity ? [{ key: "antigravity" as const, models: antigravityModelIds }] : []),
  ];
  const groups: ModelCatalogGroup[] = rawGroups.map((group) => ({
    key: group.key,
    models: distinctModels(group.key, group.models),
  }));

  return {
    groups,
    antigravityModelIds,
    acceptsImages: (model) =>
      modelAcceptsImages(model, options.ollamaVisionModels, options.opencodeVisionModels),
  };
}
