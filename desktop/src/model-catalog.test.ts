import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_GROUP_LABELS, deriveModelCatalog } from "./model-catalog";

describe("deriveModelCatalog", () => {
  it("keeps every group label in the shared catalog definition", () => {
    expect(Object.keys(MODEL_CATALOG_GROUP_LABELS).sort()).toEqual([
      "antigravity",
      "deepseek",
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
    expect(catalog.groups.find((group) => group.key === "deepseek")?.models).toContain("deepseek-live");
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

  it("dedupes within a group after qualifying", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["mimo-v2.6-pro", "opencode/mimo-v2.6-pro", "mimo-v2.6-pro"],
    });

    const opencode = catalog.groups.find((group) => group.key === "opencode")!.models;
    expect(opencode.filter((id) => id === "opencode/mimo-v2.6-pro")).toHaveLength(1);
  });
});
