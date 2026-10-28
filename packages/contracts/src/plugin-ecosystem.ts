/** AVX-PLUG-002 release, registry and bounded compatibility contracts. */
import { z } from "zod";
import { pluginConfigSchema, pluginHostRequirementSchema, pluginManifestSchema, type PluginConfigField } from "./plugin-config-schemas.js";
import { comparePluginVersions, PLUGIN_VERSION_PATTERN } from "./plugin-compatibility.js";
import { isStandardPluginId, pluginCategorySchema, pluginEcosystemIdSchema } from "./plugin-identity.js";

export const pluginReleaseVersionSchema = z.string().max(64).regex(PLUGIN_VERSION_PATTERN);
const httpsUrlSchema = z.string().max(2048).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, { message: "Registry resource URLs require HTTPS without credentials or fragments" });

/** The channel is already part of SemVer; never append it twice. */
export function pluginReleaseAssetName(id: string, version: string): string {
  pluginEcosystemIdSchema.parse(id);
  pluginReleaseVersionSchema.parse(version);
  return `${id}-v${version}.aervox-plugin`;
}

export function pluginReleaseTag(id: string, version: string): string {
  pluginReleaseAssetName(id, version);
  return `${id}@v${version}`;
}

export function parsePluginReleaseTag(tag: string): { id: string; version: string } | null {
  const separator = tag.indexOf("@v");
  if (separator < 0) return null;
  const id = tag.slice(0, separator);
  const version = tag.slice(separator + 2);
  return isStandardPluginId(id) && PLUGIN_VERSION_PATTERN.test(version) && version.length <= 64 ? { id, version } : null;
}

const releaseResourceSchema = z.object({
  downloadUrl: httpsUrlSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(20 * 1024 * 1024),
});

export const pluginCatalogItemSchema = releaseResourceSchema.extend({
  id: pluginEcosystemIdSchema,
  displayName: z.string().min(1).max(128),
  category: pluginCategorySchema,
  latestVersion: pluginReleaseVersionSchema,
  description: z.string().max(2000),
  publisher: z.string().min(1).max(128),
  icon: httpsUrlSchema.optional(),
  license: z.string().max(128).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  breaking: z.boolean(),
  requires: pluginHostRequirementSchema.optional(),
  capabilities: z.object({
    hasConfig: z.boolean(), sensorsCount: z.number().int().nonnegative(), triggersCount: z.number().int().nonnegative(),
    toolsCount: z.number().int().nonnegative(), skillsCount: z.number().int().nonnegative(), pagesCount: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict().refine(item => item.id.startsWith(`ap-${item.category}-`), { message: "Catalog category must match the immutable primary category in id" });

export const pluginCatalogSchema = z.object({
  version: z.literal(1),
  updatedAt: z.iso.datetime({ offset: true }),
  plugins: z.array(pluginCatalogItemSchema).max(10000),
}).strict().superRefine((catalog, ctx) => {
  const ids = new Set<string>();
  for (const [index, item] of catalog.plugins.entries()) {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: ["plugins", index, "id"], message: "Duplicate registry plugin id" });
    ids.add(item.id);
  }
});

export const pluginReleaseRecordSchema = releaseResourceSchema.extend({
  iconPath: z.enum(["icon.svg", "icon.png"]).optional(),
  version: pluginReleaseVersionSchema,
  tag: z.string().max(132),
  breaking: z.boolean(),
  requires: pluginHostRequirementSchema.optional(),
  /** Snapshots belong to the release, rather than a mutable source branch. */
  manifest: pluginManifestSchema,
  config: pluginConfigSchema.optional(),
}).strict();

export const pluginVersionHistorySchema = z.object({
  version: z.literal(1),
  id: pluginEcosystemIdSchema,
  versions: z.array(pluginReleaseRecordSchema).max(10000),
}).strict().superRefine((history, ctx) => {
  const versions = new Set<string>();
  for (const [index, record] of history.versions.entries()) {
    const at = ["versions", index];
    if (versions.has(record.version)) ctx.addIssue({ code: "custom", path: [...at, "version"], message: "Duplicate release version" });
    versions.add(record.version);
    if (record.tag !== `${history.id}@v${record.version}`) ctx.addIssue({ code: "custom", path: [...at, "tag"], message: "Release tag must match plugin id and version" });
    if (record.manifest.metadata.id !== history.id || record.manifest.metadata.version !== record.version) {
      ctx.addIssue({ code: "custom", path: [...at, "manifest"], message: "Release snapshot identity/version must match history" });
    }
    if (record.breaking !== (record.manifest.metadata.breaking ?? false)) {
      ctx.addIssue({ code: "custom", path: [...at, "breaking"], message: "Release breaking marker must match manifest" });
    }
    if (stableJson(record.requires) !== stableJson(record.manifest.requires)) {
      ctx.addIssue({ code: "custom", path: [...at, "requires"], message: "Release compatibility must match manifest snapshot" });
    }
    if (Boolean(record.manifest.spec.config) !== Boolean(record.config)) {
      ctx.addIssue({ code: "custom", path: [...at, "config"], message: "Config snapshot must match the manifest declaration" });
    }
  }
});

export type PluginCatalog = z.infer<typeof pluginCatalogSchema>;
export type PluginCatalogItem = z.infer<typeof pluginCatalogItemSchema>;
export type PluginVersionHistory = z.infer<typeof pluginVersionHistorySchema>;
export type PluginReleaseRecord = z.infer<typeof pluginReleaseRecordSchema>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export interface PluginReleaseComparison {
  breaking: boolean;
  reasons: string[];
  requiresMajorBump: boolean;
  requiredBump: "major" | "minor" | "patch" | "none";
  validVersionBump: boolean;
  issues: string[];
}

/** Static declared-contract comparison; arbitrary implementation semantics require author review. */
export function comparePluginReleaseChanges(input: {
  previousManifest: unknown; nextManifest: unknown; previousConfig?: unknown; nextConfig?: unknown;
}): PluginReleaseComparison {
  const beforeResult = pluginManifestSchema.safeParse(input.previousManifest);
  const afterResult = pluginManifestSchema.safeParse(input.nextManifest);
  const reasons = new Set<string>();
  let featureAdded = false;
  const issues: string[] = [];
  if (!beforeResult.success || !afterResult.success) {
    return { breaking: false, reasons: [], requiresMajorBump: false, requiredBump: "none", validVersionBump: false, issues: ["Release comparison needs two valid manifest snapshots"] };
  }
  const before = beforeResult.data;
  const after = afterResult.data;
  const add = (reason: string) => { reasons.add(reason); };
  if (before.metadata.id !== after.metadata.id) issues.push("A release cannot change persistent plugin identity; use the explicit migration process");
  if (before.metadata.category !== after.metadata.category) {
    add("Primary category changed");
    issues.push("A release cannot change the immutable primary category; evolve capability tags instead");
  }
  if (after.metadata.breaking && (before.metadata.version !== after.metadata.version
    || stableJson(before) !== stableJson(after) || stableJson(input.previousConfig) !== stableJson(input.nextConfig))) {
    add("Author declared a breaking change");
  }
  const oldRange = before.requires?.hostApiVersion ?? { min: "1.0.0", maxExclusive: "2.0.0" };
  const newRange = after.requires?.hostApiVersion ?? { min: "1.0.0", maxExclusive: "2.0.0" };
  if (comparePluginVersions(newRange.min, oldRange.min) === 1
    || (newRange.maxExclusive !== undefined && (oldRange.maxExclusive === undefined
      || comparePluginVersions(newRange.maxExclusive, oldRange.maxExclusive) === -1))) add("Host API compatibility interval narrowed");

  const readConfig = (value: unknown, declared: boolean, side: string): PluginConfigField[] => {
    if (!declared && value === undefined) return [];
    const parsed = pluginConfigSchema.safeParse(value);
    if (!parsed.success) { issues.push(`${side} config snapshot is missing or invalid`); return []; }
    return parsed.data.fields;
  };
  const oldFields = readConfig(input.previousConfig, Boolean(before.spec.config), "Previous");
  const newFields = readConfig(input.nextConfig, Boolean(after.spec.config), "Next");
  if (!before.spec.config && after.spec.config) featureAdded = true;
  const compareFields = (oldList: PluginConfigField[], newList: PluginConfigField[], parent: string) => {
    const newer = new Map(newList.map(field => [field.key, field]));
    for (const field of oldList) {
      const at = parent + field.key;
      const next = newer.get(field.key);
      if (!next) { add(`Config field removed or renamed: ${at}`); continue; }
      if (field.type !== next.type) { add(`Config field type changed: ${at}`); continue; }
      if (!field.required && next.required) add(`Config field became required: ${at}`);
      const previous = field.validation;
      const updated = next.validation;
      for (const key of ["min", "minLength"] as const) {
        if (updated?.[key] !== undefined && (previous?.[key] === undefined || updated[key]! > previous[key]!)) add(`Config lower bound tightened: ${at}.${key}`);
      }
      for (const key of ["max", "maxLength"] as const) {
        if (updated?.[key] !== undefined && (previous?.[key] === undefined || updated[key]! < previous[key]!)) add(`Config upper bound tightened: ${at}.${key}`);
      }
      if (updated?.pattern !== undefined && updated.pattern !== previous?.pattern) add(`Config pattern changed: ${at}`);
      if (field.options?.some(option => !next.options?.some(candidate => candidate.value === option.value))) add(`Config option removed: ${at}`);
      if (field.children) compareFields(field.children, next.children ?? [], `${at}.`);
      if (field.items && next.items) compareFields([{ ...field.items, key: "[]" }], [{ ...next.items, key: "[]" }], `${at}.`);
    }
    for (const next of newList) {
      if (!oldList.some(field => field.key === next.key)) {
        featureAdded = true;
        if (next.required && next.default === undefined) add(`New config field requires a value: ${parent}${next.key}`);
      }
    }
  };
  compareFields(oldFields, newFields, "");

  const nextTools = new Map((after.spec.tools ?? []).map(tool => [tool.name, tool]));
  if ((after.spec.tools ?? []).some(tool => !(before.spec.tools ?? []).some(previous => previous.name === tool.name))) featureAdded = true;
  for (const tool of before.spec.tools ?? []) {
    const next = nextTools.get(tool.name);
    if (!next) { add(`Tool removed or renamed: ${tool.name}`); continue; }
    if ((tool.id ?? tool.name) !== (next.id ?? next.name)) add(`Tool identity changed: ${tool.name}`);
    if (next.requiredPermissions.some(permission => !tool.requiredPermissions.includes(permission))) add(`Tool requires additional permission: ${tool.name}`);
    compareInputSchema(tool.inputSchema, next.inputSchema, `Tool ${tool.name} input`, add);
    if (hasNewInputProperties(tool.inputSchema, next.inputSchema)) featureAdded = true;
  }
  const removedDeclarations = <T>(oldItems: T[], newItems: T[], key: (item: T) => string, kind: string) => {
    for (const item of oldItems) if (!newItems.some(next => key(next) === key(item))) add(`${kind} removed or renamed: ${key(item)}`);
    if (newItems.some(item => !oldItems.some(previous => key(previous) === key(item)))) featureAdded = true;
  };
  removedDeclarations(before.spec.pages ?? [], after.spec.pages ?? [], item => item.id, "Page");
  removedDeclarations(before.spec.skills ?? [], after.spec.skills ?? [], item => item.name, "Skill");
  removedDeclarations(before.spec.mcpServers ?? [], after.spec.mcpServers ?? [], item => item, "MCP preset");
  removedDeclarations(before.spec.proactive?.sensors ?? [], after.spec.proactive?.sensors ?? [], item => item.sourceId, "Sensor");
  removedDeclarations(before.spec.proactive?.triggers ?? [], after.spec.proactive?.triggers ?? [], item => item.ruleId, "Proactive rule");

  const breaking = reasons.size > 0;
  const oldVersion = PLUGIN_VERSION_PATTERN.exec(before.metadata.version);
  const newVersion = PLUGIN_VERSION_PATTERN.exec(after.metadata.version);
  if (!oldVersion || !newVersion) issues.push("Release versions must be complete SemVer values");
  const order = comparePluginVersions(after.metadata.version, before.metadata.version);
  if (order === -1) issues.push("Release version must not move backwards");
  const majorIncreased = Boolean(oldVersion && newVersion && BigInt(newVersion[1]!) > BigInt(oldVersion[1]!));
  const minorIncreased = Boolean(oldVersion && newVersion && BigInt(newVersion[1]!) === BigInt(oldVersion[1]!)
    && BigInt(newVersion[2]!) > BigInt(oldVersion[2]!));
  if (breaking && !majorIncreased) issues.push("Breaking changes require an increased MAJOR version");
  if (breaking && !after.metadata.breaking) issues.push("Breaking changes must be marked metadata.breaking=true");
  if (!breaking && featureAdded && !majorIncreased && !minorIncreased) issues.push("Compatible new capabilities require an increased MINOR or MAJOR version");
  const oldContract = { ...before, metadata: { ...before.metadata, version: "", description: "", displayName: "" } };
  const newContract = { ...after, metadata: { ...after.metadata, version: "", description: "", displayName: "" } };
  const contractChanged = stableJson(oldContract) !== stableJson(newContract) || stableJson(input.previousConfig) !== stableJson(input.nextConfig);
  if (order === 0 && contractChanged) {
    issues.push("Changed release contracts require a new version");
  }
  return { breaking, reasons: [...reasons], requiresMajorBump: breaking,
    requiredBump: breaking ? "major" : featureAdded ? "minor" : contractChanged ? "patch" : "none",
    validVersionBump: issues.length === 0, issues };
}

function hasNewInputProperties(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const previous = before.properties as Record<string, unknown> | undefined;
  const next = after.properties as Record<string, unknown> | undefined;
  return Object.entries(next ?? {}).some(([key, value]) => !(key in (previous ?? {}))
    || (value !== null && typeof value === "object" && previous?.[key] !== null && typeof previous?.[key] === "object"
      && hasNewInputProperties(previous[key] as Record<string, unknown>, value as Record<string, unknown>)));
}

function compareInputSchema(before: Record<string, unknown>, after: Record<string, unknown>, at: string, add: (reason: string) => void): void {
  const oldRequired = Array.isArray(before.required) ? before.required : [];
  if (Array.isArray(after.required) && after.required.some(key => !oldRequired.includes(key))) add(`${at} adds a required parameter`);
  for (const key of ["type", "const", "pattern", "format", "oneOf", "anyOf", "allOf", "not", "$ref"] as const) {
    if (after[key] !== undefined && stableJson(before[key]) !== stableJson(after[key])) add(`${at} changed constraint ${key}`);
  }
  const nextEnum = after.enum;
  if (Array.isArray(nextEnum) && (!Array.isArray(before.enum) || before.enum.some(value => !nextEnum.includes(value)))) add(`${at} narrowed enum`);
  if (after.additionalProperties === false && before.additionalProperties !== false) add(`${at} disallows additional properties`);
  for (const key of ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"] as const) {
    if (typeof after[key] === "number" && (typeof before[key] !== "number" || after[key] > before[key])) add(`${at} tightened ${key}`);
  }
  for (const key of ["maximum", "exclusiveMaximum", "maxLength", "maxItems", "maxProperties"] as const) {
    if (typeof after[key] === "number" && (typeof before[key] !== "number" || after[key] < before[key])) add(`${at} tightened ${key}`);
  }
  const oldProperties = before.properties as Record<string, unknown> | undefined;
  const newProperties = after.properties as Record<string, unknown> | undefined;
  for (const key of Object.keys(oldProperties ?? {})) {
    const previous = oldProperties![key];
    const next = newProperties?.[key];
    if (next === undefined) { add(`${at} removed parameter ${key}`); continue; }
    if (previous && next && typeof previous === "object" && typeof next === "object") {
      compareInputSchema(previous as Record<string, unknown>, next as Record<string, unknown>, `${at}.${key}`, add);
    }
  }
  if (before.items && after.items && typeof before.items === "object" && typeof after.items === "object") {
    compareInputSchema(before.items as Record<string, unknown>, after.items as Record<string, unknown>, `${at}[]`, add);
  }
}
