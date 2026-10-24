import {
  ANTIGRAVITY_MODELS,
  OPENCODE_MODELS,
  PROVIDER_MODEL_PRECEDENCE,
  type ProviderID,
  type ProviderSpec,
  isUsableAntigravityModel,
  modelAcceptsImages,
  providerSpec,
  providerSpecsInOrder,
  stripProviderQualifier,
} from "@reasonix/core-utils";

import type { TKey } from "./i18n";

export type ModelCatalogGroupKey =
  | "local"
  | "deepseek"
  | "openai"
  | "zai"
  | "mimo"
  | "opencode"
  | "antigravity"
  | "experiential"
  | "synthetic"
  | "openrouter"
  // The Gemini API provider (API key) is a picker group of its own, separate
  // from the Antigravity-served `gemini` catalog.
  | "gemini-api"
  // Ollama owns a settings card without being a picker group: its models come
  // from the runtime probe, so the picker never lists them.
  | "ollama";

/** Catalog keys the daemon publishes live discovery snapshots under. */
export type ProviderCatalogKey =
  | "local"
  | "deepseek"
  | "openai"
  | "zai"
  | "mimo"
  | "experiential"
  | "synthetic"
  | "openrouter";

export interface ProviderCatalogView {
  models: readonly string[];
  /** Ids the provider's own catalogue declared image-capable (`visionField`). */
  visionModels?: readonly string[];
  source: "live" | "cache" | "fallback";
  error?: string;
}

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

/** Desktop picker groups — the UI contract every `pickerGroup` must name. */
const GROUP_KEYS: ReadonlySet<string> = new Set<ModelCatalogGroupKey>([
  "local",
  "deepseek",
  "openai",
  "zai",
  "mimo",
  "opencode",
  "antigravity",
  "experiential",
  "synthetic",
  "openrouter",
  "gemini-api",
]);

interface CatalogGroupEntry {
  key: ModelCatalogGroupKey;
  spec: ProviderSpec;
}

/** The composer's group key for a provider: its declared `pickerGroup`, else its id. */
function groupKeyFor(spec: ProviderSpec): ModelCatalogGroupKey {
  const key = spec.pickerGroup ?? spec.id;
  if (!GROUP_KEYS.has(key)) {
    throw new Error(`provider "${spec.id}": pickerGroup "${key}" has no desktop group`);
  }
  return key as ModelCatalogGroupKey;
}

/** Groups in display order, straight from providers.json `order`.
 *  A provider whose models the picker never lists (Ollama: runtime probe only)
 *  declares `picker: false` and is skipped. */
const GROUP_ENTRIES: readonly CatalogGroupEntry[] = providerSpecsInOrder()
  .filter((spec) => spec.picker)
  .map((spec) => ({ key: groupKeyFor(spec), spec }));

/** Display labels per group, keyed by the i18n key each provider declares. */
export const MODEL_CATALOG_GROUP_LABELS = Object.fromEntries(
  GROUP_ENTRIES.map((entry) => [entry.key, entry.spec.groupLabelKey]),
) as Record<ModelCatalogGroupKey, TKey>;

/** Groups a declared provider actually fills, in display order. Empty when no provider
 *  file exists, which is how the settings pages know to show their empty state. */
export const MODEL_CATALOG_GROUP_KEYS: readonly ModelCatalogGroupKey[] = GROUP_ENTRIES.map(
  (entry) => entry.key,
);

/** True when at least one provider file is declared, which is what the settings pages test
 *  before showing their "no providers" empty state. */
export const HAS_DECLARED_PROVIDERS = providerSpecsInOrder().length > 0;

/** The provider that fills a group, whether or not the picker lists it: Ollama is
 *  disabled in the picker but still owns a settings card. */
export function providerForModelGroup(key: ModelCatalogGroupKey): ProviderSpec | undefined {
  return providerSpecsInOrder().find((spec) => (spec.pickerGroup ?? spec.id) === key);
}
export function modelCatalogGroupLabel(key: ModelCatalogGroupKey): TKey | undefined {
  // A JSON declaration widens this to string; the bundle is the authority on which
  // keys exist, so the two are bridged here rather than at every call site.
  const label = GROUP_ENTRIES.find((entry) => entry.key === key)?.spec.groupLabelKey;
  return label as TKey | undefined;
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
  // One list per group and one order, so the ownership pass and the rendered
  // cards can never disagree about a row's value. Every group contributes,
  // visible card or not: a card appearing (sign-in, live catalogs) must not
  // change the values already saved in `enabledModels`.
  const modelsFor = (spec: ProviderSpec): readonly string[] => {
    // Each group's list comes from the channel its provider declares: a live
    // models.dev sync, an OAuth quota probe, or the published discovery catalog.
    switch (spec.discovery.strategy) {
      case "models.dev":
        return opencodeModels;
      case "oauth-quota":
        return antigravityModelIds;
      case "models-endpoint":
        return catalogFor(spec.id as ProviderCatalogKey, spec.models);
      default:
        return spec.models;
    }
  };
  // A row's value is also its `enabledModels` key, so it must be unique across
  // every card: OpenCode and the Experiential gateway both serve
  // `deepseek-v4.1-flash`, and while both rows carried that same bare value one
  // toggle hit both providers. Only the routing owner keeps the bare form; every
  // other provider serving the id gets its own `<provider>/<id>`.
  const rank = new Map(PROVIDER_MODEL_PRECEDENCE.map((provider, index) => [provider, index]));
  const rankOf = (provider: ProviderID): number => rank.get(provider) ?? Number.MAX_SAFE_INTEGER;
  const owner = new Map<string, ProviderID>();
  for (const { spec } of GROUP_ENTRIES) {
    const provider = spec.providerId;
    if (!provider) continue;
    for (const id of modelsFor(spec)) {
      const wire = stripProviderQualifier(id);
      const current = owner.get(wire);
      if (current === undefined || rankOf(provider) < rankOf(current)) owner.set(wire, provider);
    }
  }
  const distinctModels = (spec: ProviderSpec): readonly string[] => {
    const provider = spec.providerId;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of modelsFor(spec)) {
      const ownsId = owner.get(stripProviderQualifier(id));
      // Prepend rather than rewrite through parseModelRef: a `vendor/model` id's
      // prefix reads as a provider qualifier, so rewriting would drop the vendor
      // from a wire id the endpoint then rejects.
      const value =
        provider && (spec.routing.qualifyModels || (ownsId !== undefined && ownsId !== provider))
          ? id.startsWith(`${provider}/`)
            ? id
            : `${provider}/${id}`
          : id;
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
    return out;
  };
  // A group waits for its live catalog, or for the sign-in its ids require.
  const visible = ({ key, spec }: CatalogGroupEntry): boolean => {
    if (spec.pickerGate === "catalog") {
      return options.providerCatalogs?.[key as ProviderCatalogKey] !== undefined;
    }
    if (spec.pickerGate === "signin") return includeAntigravity;
    return true;
  };
  const groups: ModelCatalogGroup[] = GROUP_ENTRIES.filter(visible).map((entry) => ({
    key: entry.key,
    models: distinctModels(entry.spec),
  }));
  // Built once: a provider card asks `acceptsImages` for every row it renders, and
  // OpenRouter's catalog alone is several hundred ids.
  const visionModelIds = catalogVisionModelIds(options.providerCatalogs);

  return {
    groups,
    antigravityModelIds,
    acceptsImages: (model) =>
      modelAcceptsImages(
        model,
        options.ollamaVisionModels,
        options.opencodeVisionModels,
        visionModelIds,
      ),
  };
}

/** Image-capable ids every published catalog reported, unioned. Capability belongs
 *  to a model name, so one catalog's evidence stands for the id everywhere. */
export function catalogVisionModelIds(
  catalogs: Partial<Record<ProviderCatalogKey, ProviderCatalogView>> | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const view of Object.values(catalogs ?? {})) {
    for (const id of view?.visionModels ?? []) ids.add(id);
  }
  return ids;
}

/** Live catalogs by provider id, for `modelDisplayLabel`: the ids a discovery
 *  sync added beyond the static catalog. Twin of `deriveModelCatalog`'s
 *  discovery switch (rows there, tags here); an undeclared provider adds none. */
export function modelProviderHints(sources: {
  providerCatalogs?: Partial<Record<ProviderCatalogKey, ProviderCatalogView>>;
  discoveredAntigravityModels?: readonly string[];
  opencodeModels?: readonly string[];
}): Record<string, readonly string[]> {
  const hints: Record<string, readonly string[]> = {};
  // Keyed by provider id (not the catalog id a source is named by), since that is
  // the key the registry-side resolver reads.
  const add = (catalogId: string, models: readonly string[] | undefined): void => {
    const provider = providerSpec(catalogId)?.providerId;
    if (provider && models && models.length > 0) hints[provider] = models;
  };
  for (const [catalogId, view] of Object.entries(sources.providerCatalogs ?? {})) {
    add(catalogId, view?.models);
  }
  add("opencode", sources.opencodeModels);
  add("gemini", sources.discoveredAntigravityModels);
  return hints;
}
