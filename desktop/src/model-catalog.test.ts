import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_GROUP_LABELS, deriveModelCatalog } from "./model-catalog";

describe("deriveModelCatalog", () => {
  it("keeps every group label in the shared catalog definition", () => {
    expect(Object.keys(MODEL_CATALOG_GROUP_LABELS).sort()).toEqual([
      "antigravity",
      "deepseek",
      "experiential",
      "mimo",
      "openai",
      "opencode",
      "typesafe",
      "zai",
    ]);
  });

  it("centralizes discovered provider catalogs", () => {
    const catalog = deriveModelCatalog({
      discoveredAntigravityModels: ["gemini-account-model", "chat_internal"],
      opencodeModels: ["dynamic-free"],
      includeAntigravity: true,
    });

    expect(catalog.groups.find((group) => group.key === "opencode")?.models).toEqual([
      "dynamic-free",
    ]);
    expect(catalog.antigravityModelIds).toContain("gemini-account-model");
    expect(catalog.antigravityModelIds).not.toContain("chat_internal");
    expect(catalog.groups.map((group) => group.key)).not.toContain("custom");
  });

  it("merges provider-discovered models with the fallback catalog", () => {
    const catalog = deriveModelCatalog({
      providerCatalogs: {
        deepseek: { models: ["deepseek-live"], source: "live" },
      },
    });
    expect(catalog.groups.find((group) => group.key === "deepseek")?.models).toContain(
      "deepseek-live",
    );
  });

  it("uses dynamic OpenCode vision evidence", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["dynamic-vision-free"],
      opencodeVisionModels: new Set(["dynamic-vision-free"]),
    });

    expect(catalog.acceptsImages("dynamic-vision-free")).toBe(true);
    expect(catalog.acceptsImages("unknown-model")).toBe(false);
  });

  it("qualifies opencode ids that an earlier provider catalog serves", () => {
    const catalog = deriveModelCatalog({
      // Live-synced OpenCode list including ids other providers serve natively.
      opencodeModels: ["mimo-v2.6-pro", "gpt-6-luna", "glm-5.3", "big-pickle"],
    });

    const opencode = catalog.groups.find((group) => group.key === "opencode")!.models;
    // Colliding rows carry a distinct picker value; the bare id would route to
    // the native provider no matter which row the user clicks.
    expect(opencode).toContain("opencode/mimo-v2.6-pro");
    expect(opencode).toContain("opencode/gpt-6-luna");
    expect(opencode).toContain("opencode/glm-5.3");
    // OpenCode-exclusive ids stay bare.
    expect(opencode).toContain("big-pickle");
    expect(opencode).not.toContain("opencode/big-pickle");
  });

  it("keeps native catalog ids bare so bare and qualified rows coexist", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["mimo-v2.6-pro"],
    });

    // The XIAOMI group's row stays `mimo-v2.6-pro` — the bare id already
    // routes to mimo (catalog precedence) — so both rows are independent picks.
    expect(catalog.groups.find((group) => group.key === "mimo")!.models).toContain("mimo-v2.6-pro");
    expect(catalog.groups.find((group) => group.key === "mimo")!.models).not.toContain(
      "mimo/mimo-v2.6-pro",
    );
  });

  it("gives the two shared-id rows distinct vision verdicts from the wire id", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["mimo-v2.6-pro"],
    });

    // Both rows show the vision badge: capability checks strip the qualifier.
    expect(catalog.acceptsImages("mimo-v2.6-pro")).toBe(true);
    expect(catalog.acceptsImages("opencode/mimo-v2.6-pro")).toBe(true);
  });

  it("qualifies a later group's row when a later group also serves the id", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["deepseek-v4.1-flash", "space-bunny-free"],
      providerCatalogs: {
        experiential: { models: ["deepseek-v4.1-flash"], source: "live" },
      },
    });

    // OpenCode is reached before the Experiential gateway, so its row keeps the
    // bare id...
    expect(catalog.groups.find((group) => group.key === "opencode")!.models).toContain(
      "deepseek-v4.1-flash",
    );
    // ...and the Experimental Labs row must not reuse that value: the value is
    // also the `enabledModels` key, so a shared one toggled both providers.
    const experiential = catalog.groups.find((group) => group.key === "experiential")!.models;
    expect(experiential).toContain("experiential/deepseek-v4.1-flash");
    expect(experiential).not.toContain("deepseek-v4.1-flash");
  });

  it("never repeats a picker value across groups", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: [
        "mimo-v2.6-pro",
        "deepseek-v4.1-flash",
        "gemini-3.8-flash-tiered",
        "big-pickle",
      ],
      discoveredAntigravityModels: ["gemini-3.8-flash-tiered", "claude-sonnet-4-6"],
      includeAntigravity: true,
      providerCatalogs: {
        experiential: {
          models: ["deepseek-v4.1-flash", "gpt-5.6-luna", "big-pickle"],
          source: "live",
        },
      },
    });

    const values = catalog.groups.flatMap((group) => group.models);
    expect(values).toHaveLength(new Set(values).size);
    // The card a bare id routes to is the one that keeps it.
    expect(catalog.groups.find((group) => group.key === "antigravity")!.models).toContain(
      "gemini-3.8-flash-tiered",
    );
    expect(catalog.groups.find((group) => group.key === "openai")!.models).toContain(
      "gpt-5.6-luna",
    );
  });

  it("keeps a hidden provider's ownership stable", () => {
    const catalog = deriveModelCatalog({
      // Not signed into Antigravity, so its card is absent — but a bare
      // `claude-sonnet-4-6` still routes to it, so OpenCode must qualify.
      opencodeModels: ["claude-sonnet-4-6", "big-pickle"],
    });

    expect(catalog.groups.map((group) => group.key)).not.toContain("antigravity");
    const opencode = catalog.groups.find((group) => group.key === "opencode")!.models;
    expect(opencode).toContain("opencode/claude-sonnet-4-6");
    expect(opencode).not.toContain("claude-sonnet-4-6");
    // An OpenCode-exclusive id is still its own bare row.
    expect(opencode).toContain("big-pickle");
  });

  it("keeps every value unique when resellers and native catalogs overlap", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: [
        "gpt-5.6-luna",
        "glm-5.3",
        "mimo-v2.6-pro",
        "deepseek-v4-flash",
        "deepseek-v4.1-flash",
        "claude-sonnet-4-6",
        "big-pickle",
      ],
      discoveredAntigravityModels: ["claude-sonnet-4-6"],
      includeAntigravity: true,
      providerCatalogs: {
        // OpenCode and the Experiential gateway both resell ids the native
        // providers own, plus one id no native catalog lists.
        experiential: {
          models: ["gpt-5.6-luna", "glm-5.3", "mimo-v2.6-pro", "deepseek-v4.1-flash"],
          source: "live",
        },
        typesafe: { models: ["jev-latest"], source: "live" },
      },
    });

    const values = catalog.groups.flatMap((group) => group.models);
    expect(values).toHaveLength(new Set(values).size);
    const models = (key: string) => catalog.groups.find((group) => group.key === key)!.models;
    // The native catalog keeps the bare id...
    expect(models("openai")).toContain("gpt-5.6-luna");
    expect(models("zai")).toContain("glm-5.3");
    expect(models("mimo")).toContain("mimo-v2.6-pro");
    expect(models("deepseek")).toContain("deepseek-v4-flash");
    expect(models("antigravity")).toContain("claude-sonnet-4-6");
    // ...and each reseller carries its own qualified row.
    expect(models("opencode")).toContain("opencode/gpt-5.6-luna");
    expect(models("opencode")).toContain("opencode/glm-5.3");
    expect(models("opencode")).toContain("opencode/mimo-v2.6-pro");
    expect(models("opencode")).toContain("opencode/deepseek-v4-flash");
    expect(models("opencode")).toContain("opencode/claude-sonnet-4-6");
    expect(models("experiential")).toContain("experiential/gpt-5.6-luna");
    // An id no native catalog owns falls to OpenCode, the first reseller checked.
    expect(models("opencode")).toContain("deepseek-v4.1-flash");
    expect(models("experiential")).toContain("experiential/deepseek-v4.1-flash");
    // OpenCode-exclusive ids are untouched.
    expect(models("opencode")).toContain("big-pickle");
  });

  it("dedupes within a group after qualifying", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["mimo-v2.6-pro", "opencode/mimo-v2.6-pro", "mimo-v2.6-pro"],
    });

    const opencode = catalog.groups.find((group) => group.key === "opencode")!.models;
    expect(opencode.filter((id) => id === "opencode/mimo-v2.6-pro")).toHaveLength(1);
  });
});
