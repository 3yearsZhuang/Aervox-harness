import { describe, expect, it } from "vitest";
import { checkPluginHostCompatibility, comparePluginVersions, PLUGIN_HOST_API_VERSION } from "../src/plugin-compatibility.js";
import { validatePluginBundleFiles, validatePluginConfigDefinition } from "../src/plugin-validation.js";
import { pluginManifestSchema } from "../src/plugin-config-schemas.js";

const manifest = { apiVersion: "aervox.dev/v1", kind: "PluginManifest", metadata: { id: "test-plugin", displayName: "Test", publisher: "author", version: "legacy-build" }, spec: {} };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const config = (fields: unknown[]) => ({ apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields });

describe("plugin author compatibility", () => {
  it("keeps old release labels valid while enforcing explicit host intervals", () => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true);
    expect(checkPluginHostCompatibility({}).compatible).toBe(true);
    expect(PLUGIN_HOST_API_VERSION).toBe("1.1.0");
    const ecosystemRange = { requires: { hostApiVersion: { min: "1.1.0", maxExclusive: "2.0.0" } } };
    expect(checkPluginHostCompatibility(ecosystemRange).compatible).toBe(true);
    expect(checkPluginHostCompatibility(ecosystemRange, "1.0.0").compatible).toBe(false);
    expect(checkPluginHostCompatibility({}, "2.0.0").compatible).toBe(false);
    const requires = { hostApiVersion: { min: "1.2.0", maxExclusive: "2.0.0" } };
    expect(checkPluginHostCompatibility({ requires }, "1.2.0").compatible).toBe(true);
    expect(checkPluginHostCompatibility({ requires }, "1.1.9").compatible).toBe(false);
    expect(checkPluginHostCompatibility({ requires }, "2.0.0").compatible).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...manifest, requires: { hostApiVersion: { min: "2.0.0", maxExclusive: "1.0.0" } } }).success).toBe(false);
    expect(checkPluginHostCompatibility({ requires }, "1.3.0-beta").compatible).toBe(false);
  });
  it("orders SemVer numerically including prereleases and never orders legacy labels", () => {
    expect(comparePluginVersions("1.10.0", "1.9.0")).toBe(1);
    expect(comparePluginVersions("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
    expect(comparePluginVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(comparePluginVersions("1.0.0+abc", "1.0.0+def")).toBe(0);
    expect(comparePluginVersions("legacy-build", "1.0.0")).toBeNull();
    expect(comparePluginVersions("1.0.0-01", "1.0.0")).toBeNull();
  });
});

describe("author config definitions", () => {
  it("rejects duplicate keys, secret defaults, malformed regex and invalid defaults", () => {
    const result = validatePluginConfigDefinition(config([
      { key: "x", label: "X", type: "integer", default: "5" },
      { key: "x", label: "X", type: "string", validation: { pattern: "[" } },
      { key: "token", label: "Token", type: "secret", default: "unsafe" },
      { key: "range", label: "Range", type: "number", validation: { min: 10, max: 2 } },
    ]));
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["CONFIG_DUPLICATE_KEY", "CONFIG_DEFAULT", "CONFIG_PATTERN", "CONFIG_RANGE"]));
  });
  it("rejects nested depth and object prototype keys", () => {
    let field: unknown = { key: "value", label: "Value", type: "string" };
    for (let depth = 0; depth < 5; depth++) field = { key: `level${depth}`, label: "Level", type: "object", children: [field] };
    expect(validatePluginConfigDefinition(config([field])).issues.some((issue) => issue.code === "CONFIG_DEPTH")).toBe(true);
    expect(validatePluginConfigDefinition(config([{ key: "__proto__", label: "Proto", type: "string" }])).issues[0]?.code).toBe("CONFIG_RESERVED_KEY");
  });
});

describe("bundle conformance", () => {
  it.each(["bad/name", "bad name", ".", "..", "技能"])("rejects unsafe explicit Skill names: %s", name => {
    const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec: { skills: [{ name, content: "# Example" }] } }) });
    expect(result.issues.some(issue => issue.code === "SKILL_NAME")).toBe(true);
  });
  it("checks discovered Skill directory names with the same host predicate", () => {
    const result = validatePluginBundleFiles({
      "plugin.manifest.json": bytes(manifest), "skills/bad name/SKILL.md": new TextEncoder().encode("# Example"),
    });
    expect(result.issues.some(issue => issue.code === "SKILL_NAME")).toBe(true);
  });
  it("checks manifest compatibility and rejects unknown executable entries before installation", () => {
    const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, requires: { hostApiVersion: { min: "2.0.0" } } }), "src/server.js": bytes("code") });
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["BUNDLE_ENTRY", "HOST_INCOMPATIBLE"]));
  });
  it("rejects missing Page/Skill resources and unknown capabilities", () => {
    const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec: { pages: [{ id: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["config.read"] }], skills: [{ name: "helper", entry: "skills/helper/SKILL.md" }] } }) });
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["ENTRY_MISSING", "PAGE_CONFIG"]));
    expect(validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec: { pages: [{ id: "settings", title: "Settings", entry: "pages/settings/index.html", capabilities: ["system.exec"] }] } }) }).issues[0]?.code).toBe("MANIFEST_SCHEMA");
  });
  it("rejects invalid UTF-8 in selected explicit and conventional skill entries", () => {
    const invalid = new Uint8Array([0xc3, 0x28]);
    const cases = [
      { entry: "skills/root/custom.md", spec: { skill: "skills/root/custom.md" } },
      { entry: "skills/named/custom.md", spec: { skills: [{ name: "named", entry: "skills/named/custom.md" }] } },
      { entry: "SKILL.md", spec: {} },
      { entry: "skill.md", spec: {} },
      { entry: "skills/discovered/SKILL.md", spec: {} },
      { entry: "skills/discovered/skill.md", spec: {} },
    ];
    for (const { entry, spec } of cases) {
      const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec }), [entry]: invalid });
      expect(result.issues.some((issue) => issue.code === "SKILL_ENCODING" && issue.path === entry)).toBe(true);
    }
    const shadowed = validatePluginBundleFiles({
      "plugin.manifest.json": bytes({ ...manifest, spec: { skill: "skills/root/custom.md" } }),
      "skills/root/custom.md": new TextEncoder().encode("Valid skill"), "SKILL.md": invalid,
    });
    expect(shadowed.issues).toEqual([]);
  });
  it("rejects tool ids that collide after plugin namespace normalization", () => {
    for (const ids of [["inspect", "inspect"], ["inspect", "test-plugin.inspect"]]) {
      const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec: { tools: [
        { name: "first", id: ids[0] }, { name: "second", id: ids[1] },
      ] } }) });
      expect(result.issues.some((issue) => issue.code === "TOOL_DUPLICATE_ID")).toBe(true);
    }
  });
  it("includes required tool permissions instead of treating safety labels as permission grants", () => {
    const result = validatePluginBundleFiles({ "plugin.manifest.json": bytes({ ...manifest, spec: { tools: [{ name: "inspect", requiredPermissions: ["sensor.read"] }] } }) });
    expect(result.issues).toEqual([]);
    expect(result.permissions).toEqual(["sensor.read"]);
  });
});
