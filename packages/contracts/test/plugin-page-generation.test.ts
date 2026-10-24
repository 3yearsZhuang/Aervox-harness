import { describe, expect, it } from "vitest";
import { pluginConfigApi, pluginPageResponseSchema } from "../src/plugin-config-api.js";
import { pluginConfigUpdateRequestSchema, pluginManifestSchema, pluginPageSchema } from "../src/plugin-config-schemas.js";

const declaration = { id: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["config.read", "config.write"] };
const identity = { expectedPageId: "settings", expectedPageGeneration: "page-generation", expectedLifecycleGeneration: "plugin-generation" };

describe("Page generation contracts", () => {
  describe.each(["get", "reset"] as const)("%s configuration access query", operation => {
    it("preserves a complete captured identity and accepts ordinary management access", () => {
      const query = pluginConfigApi[operation].query;
      expect(query.parse(identity)).toEqual(identity);
      expect(query.parse({})).toEqual({});
      expect(query.parse({ expectedLifecycleGeneration: "plugin-generation" })).toEqual({ expectedLifecycleGeneration: "plugin-generation" });
    });

    it.each([
      { expectedPageId: "settings", expectedLifecycleGeneration: "plugin-generation" },
      { expectedPageGeneration: "page-generation", expectedLifecycleGeneration: "plugin-generation" },
      { expectedPageId: "settings", expectedPageGeneration: "page-generation" },
    ])("rejects an incomplete captured access identity %j", incomplete => {
      expect(pluginConfigApi[operation].query.safeParse(incomplete).success).toBe(false);
    });

    it.each([
      ["expectedPageId", [null, "", "../settings", "settings/other", "x".repeat(65), 7, [], {}]],
      ["expectedPageGeneration", [null, "", "x".repeat(129), 7, [], {}]],
      ["expectedLifecycleGeneration", [null, "", "x".repeat(129), 7, [], {}]],
    ])("rejects malformed %s in access queries", (field, invalidValues) => {
      for (const value of invalidValues) {
        expect(pluginConfigApi[operation].query.safeParse({ ...identity, [field]: value }).success, JSON.stringify({ field, value })).toBe(false);
      }
    });
  });

  it("preserves the host Page generation in the response and requires it independently of optional metadata", () => {
    expect(pluginPageResponseSchema.parse({ ...declaration, pageGeneration: "page-generation", description: null, checksum: null }))
      .toMatchObject({ pageGeneration: "page-generation", description: null, checksum: null });
    expect(pluginConfigApi.listPages.response.safeParse({ pages: [declaration] }).success).toBe(false);
  });

  it.each([[undefined], [null], [""], ["x".repeat(129)], [7], [[]], [{}]])("rejects a malformed Page generation %j in successful output", pageGeneration => {
    expect(pluginPageResponseSchema.safeParse({ ...declaration, pageGeneration }).success).toBe(false);
  });

  it("preserves the captured Page generation in a valid write and keeps ordinary management writes valid", () => {
    expect(pluginConfigUpdateRequestSchema.parse({ revision: 1, ...identity })).toMatchObject(identity);
    expect(pluginConfigUpdateRequestSchema.safeParse({ revision: 1 }).success).toBe(true);
    expect(pluginConfigUpdateRequestSchema.safeParse({ revision: 1, expectedLifecycleGeneration: "plugin-generation" }).success).toBe(true);
  });

  it.each([
    { expectedPageId: "settings", expectedLifecycleGeneration: "plugin-generation" },
    { expectedPageGeneration: "page-generation", expectedLifecycleGeneration: "plugin-generation" },
    { expectedPageId: "settings", expectedPageGeneration: "page-generation" },
  ])("rejects an incomplete captured Page identity %j", incomplete => {
    expect(pluginConfigUpdateRequestSchema.safeParse({ revision: 1, ...incomplete }).success).toBe(false);
  });

  it.each([[null], [""], ["x".repeat(129)], [7], [[]], [{}]])("rejects a malformed captured Page generation %j", expectedPageGeneration => {
    expect(pluginConfigUpdateRequestSchema.safeParse({ revision: 1, ...identity, expectedPageGeneration }).success).toBe(false);
  });

  it("keeps generation out of author Page declarations and Manifest Page input", () => {
    const input = { ...declaration, pageGeneration: "author-forged-generation" };
    expect(pluginPageSchema.parse(input)).not.toHaveProperty("pageGeneration");
    const manifest = pluginManifestSchema.parse({
      apiVersion: "aervox.dev/v1", kind: "PluginManifest",
      metadata: { id: "plugin", displayName: "Plugin", publisher: "author", version: "1.0.0" },
      spec: { pages: [input] },
    });
    expect(manifest.spec.pages?.[0]).not.toHaveProperty("pageGeneration");
  });
});
