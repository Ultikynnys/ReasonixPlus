import {
  ANTIGRAVITY_MODELS,
  OPENAI_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  isUsableAntigravityModel,
  modelAcceptsImages,
} from "@reasonix/core-utils";

export type ModelCatalogGroupKey =
  | "deepseek"
  | "openai"
  | "zai"
  | "opencode"
  | "typesafe"
  | "antigravity";

export type ProviderCatalogKey = "deepseek" | "openai" | "zai" | "typesafe";

export interface ProviderCatalogView {
  models: readonly string[];
  source: "live" | "cache" | "fallback";
  error?: string;
}

export const MODEL_CATALOG_GROUP_LABELS = {
  deepseek: "composer.modelDeepSeekGroup",
  openai: "composer.modelOpenAIGroup",
  zai: "composer.modelZaiGroup",
  opencode: "composer.modelOpencodeGroup",
  typesafe: "settings.typesafeSection",
  antigravity: "composer.modelAntigravityGroup",
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
  const groups: ModelCatalogGroup[] = [
    { key: "deepseek", models: catalogFor("deepseek", SUPPORTED_OFFICIAL_MODELS) },
    { key: "openai", models: catalogFor("openai", OPENAI_MODELS) },
    { key: "zai", models: catalogFor("zai", ZAI_MODELS) },
    { key: "opencode", models: opencodeModels },
    ...(options.providerCatalogs?.typesafe
      ? [{ key: "typesafe" as const, models: catalogFor("typesafe", ["jev-latest"]) }]
      : []),
    ...(includeAntigravity ? [{ key: "antigravity" as const, models: antigravityModelIds }] : []),
  ];

  return {
    groups,
    antigravityModelIds,
    acceptsImages: (model) =>
      modelAcceptsImages(model, options.ollamaVisionModels, options.opencodeVisionModels),
  };
}
