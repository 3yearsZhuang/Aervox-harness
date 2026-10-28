import { describe, expect, it } from "vitest";
import {
  comparePluginReleaseChanges, parsePluginReleaseTag, pluginCatalogSchema,
  pluginReleaseAssetName, pluginReleaseTag, pluginVersionHistorySchema,
} from "../src/plugin-ecosystem.js";
import { isPluginSkillName, isStandardPluginId, PLUGIN_CATEGORIES, pluginSkillDirectoryName, pluginSkillNameFromDirectoryName } from "../src/plugin-identity.js";
import { pluginManifestSchema } from "../src/plugin-config-schemas.js";
import { validatePluginBundleFiles } from "../src/plugin-validation.js";
import { skillNameSchema } from "../src/schemas.js";

const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
function manifest(version = "1.0.0") {
  return {
    apiVersion: "aervox.dev/v1", kind: "PluginManifest",
    metadata: { id: "ap-tool-example", displayName: "Example", publisher: "author", version, category: "tool", tags: ["example"], breaking: false },
    requires: { hostApiVersion: { min: "1.1.0", maxExclusive: "2.0.0" } },
    spec: {
      config: { schemaVersion: 1, entry: "config.schema.json" },
      tools: [{ name: "example_inspect", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: [] as string[] } }],
    },
  };
}
function config(fields: unknown[] = [{ key: "message", label: "Message", type: "string", default: "hello" }]) {
  return { apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields };
}
const resource = { downloadUrl: "https://github.com/example/plugins/releases/download/ap-tool-example%40v1.0.0/ap-tool-example-v1.0.0.aervox-plugin", sha256: "a".repeat(64), size: 120 };

describe("ecosystem identities and release coordinates", () => {
  it("enforces all seven immutable primary categories without admitting malformed slugs", () => {
    for (const category of PLUGIN_CATEGORIES) expect(isStandardPluginId(`ap-${category}-example`)).toBe(true);
    for (const value of ["tool-example", "ap-tools-example", "ap-bot-", "ap-ui--example", "ap-tool-UPPER", "ap-ui-a.b", `ap-ui-${"x".repeat(60)}`]) {
      expect(isStandardPluginId(value), value).toBe(false);
    }
  });
  it("keeps channel, prerelease and build metadata in the single SemVer coordinate", () => {
    const version = "2.1.0-rc.10+build.7";
    expect(pluginReleaseTag("ap-tool-example", version)).toBe(`ap-tool-example@v${version}`);
    expect(pluginReleaseAssetName("ap-tool-example", version)).toBe(`ap-tool-example-v${version}.aervox-plugin`);
    expect(parsePluginReleaseTag(`ap-tool-example@v${version}`)).toEqual({ id: "ap-tool-example", version });
    for (const tag of ["ap-tool-example@v1.0.0-01", "ap-tool-example@v01.0.0", "old@v1.0.0", "ap-tool-example@v1.0.0@v2.0.0", "ap-tool-example@v1.0"]) {
      expect(parsePluginReleaseTag(tag), tag).toBeNull();
    }
  });
  it("accepts legacy v1 identity/version labels while validating new metadata and standard ID category agreement", () => {
    const legacy = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: { id: "legacy-id", displayName: "Legacy", publisher: "author", version: "legacy-build" }, spec: {} };
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes(legacy) }).issues).toEqual([]);
    const current = manifest();
    expect(pluginManifestSchema.parse(current).metadata.category).toBe("tool");
    const mismatch = structuredClone(current);
    mismatch.metadata.category = "bot";
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes(mismatch) }).issues.some(issue => issue.code === "PLUGIN_ID")).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...current, metadata: { ...current.metadata, category: "tools" } }).success).toBe(false);
  });
});

describe("namespaced logical Skills and portable paths", () => {
  it("separates colon identities from cross-platform storage paths without collisions", () => {
    expect(isPluginSkillName("ap-tool-example:inspect")).toBe(true);
    expect(skillNameSchema.parse("ap-tool-example:inspect")).toBe("ap-tool-example:inspect");
    expect(pluginSkillDirectoryName("ap-tool-example:inspect")).toBe("ap-tool-example%3Ainspect");
    expect(pluginSkillDirectoryName("legacy-skill")).toBe("legacy-skill");
    expect(pluginSkillNameFromDirectoryName("ap-tool-example%3Ainspect")).toBe("ap-tool-example:inspect");
    expect(pluginSkillNameFromDirectoryName("legacy-skill")).toBe("legacy-skill");
    for (const path of ["%2E%2E", "a%3ainspect", "a%3Ab%3Ac", "a:inspect", "a%2Finspect"]) expect(pluginSkillNameFromDirectoryName(path)).toBeNull();
    for (const value of ["a:b:c", "a:", "../escape", "a:..", "a:%3Ab", "a:trailing.", "CON", "a:NUL.txt"]) {
      expect(isPluginSkillName(value), value).toBe(false);
      expect(() => pluginSkillDirectoryName(value)).toThrow();
    }
  });
  it("validates explicit namespace ownership and rejects colon in archive paths", () => {
    const current = { ...manifest(), spec: { skills: [{ name: "ap-tool-example:inspect", entry: "skills/inspect/SKILL.md" }] } };
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes(current), "skills/inspect/SKILL.md": bytes("Read-only instructions") }).issues).toEqual([]);
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...current, spec: {} }), "skills/ap-tool-example%3Ainspect/SKILL.md": bytes("Read-only instructions") }).issues).toEqual([]);
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...current, spec: {} }), "skills/ap-bot-other%3Ainspect/SKILL.md": bytes("Instructions") }).issues.some(issue => issue.code === "SKILL_NAMESPACE")).toBe(true);
    const mismatch = { ...current, spec: { skills: [{ name: "ap-bot-other:inspect", content: "Instructions" }] } };
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes(mismatch) }).issues.some(issue => issue.code === "SKILL_NAMESPACE")).toBe(true);
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...current, spec: {} }), "skills/a:b/SKILL.md": bytes("Instructions") }).issues.some(issue => issue.code === "BUNDLE_ENTRY")).toBe(true);
  });
  it("admits only explicit new root resources while preserving fail-closed executable entry rejection", () => {
    const input = { "plugin.manifest.json": bytes({ ...manifest(), spec: {} }), "icon.svg": bytes("<svg/>"), LICENSE: bytes("AGPL-3.0-or-later"), NOTICE: bytes("Copyright"), "CHANGELOG.md": bytes("# Changes") };
    expect(validatePluginBundleFiles(input).issues).toEqual([]);
    expect(validatePluginBundleFiles({ ...input, "server.js": bytes("throw new Error()") }).issues.some(issue => issue.code === "BUNDLE_ENTRY")).toBe(true);
  });
});

describe("registry and immutable release snapshots", () => {
  const item = () => ({ ...resource, id: "ap-tool-example", displayName: "Example", category: "tool", latestVersion: "1.0.0", description: "Example", publisher: "author", breaking: false });
  it("validates HTTPS, complete checksums, exact sizes and category/identity consistency", () => {
    const catalog = { version: 1, updatedAt: "2026-10-29T00:00:00Z", plugins: [item()] };
    expect(pluginCatalogSchema.safeParse(catalog).success).toBe(true);
    for (const change of [{ category: "bot" }, { downloadUrl: "not a URL" }, { downloadUrl: "http://example.org/a.zip" }, { downloadUrl: "https://user:secret@example.org/a.zip" }, { sha256: "short" }, { size: 21 * 1024 * 1024 }, { latestVersion: "legacy" }]) {
      expect(pluginCatalogSchema.safeParse({ ...catalog, plugins: [{ ...item(), ...change }] }).success, JSON.stringify(change)).toBe(false);
    }
    expect(pluginCatalogSchema.safeParse({ ...catalog, plugins: [item(), item()] }).success).toBe(false);
  });
  it("binds each history record to its exact manifest/config/compatibility snapshot", () => {
    const record = { ...resource, version: "1.0.0", tag: "ap-tool-example@v1.0.0", breaking: false, requires: manifest().requires, manifest: manifest(), config: config() };
    const history = { version: 1, id: "ap-tool-example", versions: [record] };
    expect(pluginVersionHistorySchema.safeParse(history).success).toBe(true);
    for (const change of [{ version: "1.1.0" }, { tag: "ap-tool-other@v1.0.0" }, { breaking: true }, { config: undefined }, { requires: { hostApiVersion: { min: "1.2.0", maxExclusive: "2.0.0" } } }]) {
      expect(pluginVersionHistorySchema.safeParse({ ...history, versions: [{ ...record, ...change }] }).success, JSON.stringify(change)).toBe(false);
    }
    expect(pluginVersionHistorySchema.safeParse({ ...history, versions: [record, record] }).success).toBe(false);
  });
});

describe("declared release compatibility gate", () => {
  const compare = (nextManifest: unknown, nextConfig = config(), previousConfig = config()) => comparePluginReleaseChanges({ previousManifest: manifest(), nextManifest, previousConfig, nextConfig });
  it("allows compatible optional additions but forbids a changed contract under the same version", () => {
    const nextConfig = config([{ key: "message", label: "Message", type: "string", default: "hello" }, { key: "optional", label: "Optional", type: "integer" }]);
    expect(compare(manifest("1.1.0"), nextConfig)).toMatchObject({ breaking: false, validVersionBump: true });
    expect(compare(manifest("1.0.1"), nextConfig)).toMatchObject({ breaking: false, requiredBump: "minor", validVersionBump: false });
    expect(compare(manifest(), nextConfig)).toMatchObject({ validVersionBump: false });
  });
  it.each([
    { name: "removed field", next: config([]) },
    { name: "changed field type", next: config([{ key: "message", label: "Message", type: "number" }]) },
    { name: "required field", next: config([{ key: "message", label: "Message", type: "string", required: true }]) },
    { name: "tightened constraint", next: config([{ key: "message", label: "Message", type: "string", validation: { maxLength: 5 } }]) },
    { name: "new required field", next: config([{ key: "message", label: "Message", type: "string" }, { key: "required", label: "Required", type: "string", required: true }]) },
  ])("requires MAJOR and explicit marker for $name", ({ next }) => {
    expect(compare(manifest("1.1.0"), next)).toMatchObject({ breaking: true, requiresMajorBump: true, validVersionBump: false });
    const major = manifest("2.0.0"); major.metadata.breaking = true;
    expect(compare(major, next)).toMatchObject({ breaking: true, validVersionBump: true });
  });
  it("detects nested option removal and array element schema changes", () => {
    const oldConfig = config([{ key: "entries", label: "Entries", type: "array", items: { key: "entry", label: "Entry", type: "object", children: [{ key: "choice", label: "Choice", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] } }]);
    const nextConfig = config([{ key: "entries", label: "Entries", type: "array", items: { key: "entry", label: "Entry", type: "object", children: [{ key: "choice", label: "Choice", type: "select", options: [{ value: "a", label: "A" }] }] } }]);
    expect(compare(manifest("1.1.0"), nextConfig, oldConfig).reasons.some(reason => reason.includes("option removed"))).toBe(true);
  });
  it("detects removed tools, required parameters, nested input narrowing and incompatible host intervals", () => {
    const removed = { ...manifest("1.1.0"), spec: { config: manifest().spec.config, tools: [] } };
    expect(compare(removed).reasons.some(reason => reason.includes("Tool removed"))).toBe(true);
    const required = manifest("1.1.0"); required.spec.tools[0]!.inputSchema.required = ["query"];
    expect(compare(required).reasons.some(reason => reason.includes("required parameter"))).toBe(true);
    const narrowed = manifest("1.1.0");
    (narrowed.spec.tools[0]!.inputSchema.properties.query as Record<string, unknown>).maxLength = 3;
    expect(compare(narrowed).reasons.some(reason => reason.includes("tightened maxLength"))).toBe(true);
    const host = manifest("1.1.0"); host.requires.hostApiVersion.min = "1.2.0";
    expect(compare(host).reasons).toContain("Host API compatibility interval narrowed");
  });
  it("never guesses invalid snapshots, non-SemVer order, identity changes or undeclared implementation breakage", () => {
    expect(comparePluginReleaseChanges({ previousManifest: {}, nextManifest: manifest() }).validVersionBump).toBe(false);
    expect(compare(manifest("legacy")).validVersionBump).toBe(false);
    expect(compare(manifest("0.9.0")).validVersionBump).toBe(false);
    const identity = manifest("2.0.0"); identity.metadata.id = "ap-tool-other";
    expect(compare(identity).issues.some(issue => issue.includes("identity"))).toBe(true);
    const category = manifest("2.0.0"); category.metadata.category = "bot"; category.metadata.breaking = true;
    expect(compare(category).issues.some(issue => issue.includes("immutable primary category"))).toBe(true);
    const author = manifest("1.1.0"); author.metadata.breaking = true;
    expect(compare(author).validVersionBump).toBe(false);
  });
});
