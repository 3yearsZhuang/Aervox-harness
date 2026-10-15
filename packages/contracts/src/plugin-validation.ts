/** Shared, side-effect-free author and installation checks for declarative bundles. */
import { pluginConfigSchema, pluginManifestSchema, type PluginConfigField } from "./plugin-config-schemas.js";
import { checkPluginHostCompatibility } from "./plugin-compatibility.js";
import type { z } from "zod";

export interface PluginValidationIssue { path: string; code: string; message: string }
export const PLUGIN_CONFIG_MAX_DEPTH = 5;
export const PLUGIN_BUNDLE_ROOT_FILES = ["plugin.manifest.json", "manifest.json", "config.schema.json", "SKILL.md", "skill.md"] as const;
export const PLUGIN_BUNDLE_RESOURCE_PREFIXES = ["pages/", "skills/"] as const;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isPluginBundleResourcePath(entry: string): boolean {
  if (!entry || entry.length > 512 || entry.startsWith("/") || entry.includes("\\") || /^[A-Za-z]:/.test(entry)) return false;
  if (entry.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return PLUGIN_BUNDLE_ROOT_FILES.some((file) => file === entry)
    || PLUGIN_BUNDLE_RESOURCE_PREFIXES.some((prefix) => entry.startsWith(prefix));
}

function defaultMatches(field: PluginConfigField, value: unknown): boolean {
  switch (field.type) {
    case "secret": return false;
    case "string": case "text": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "select": return (field.options ?? []).some((option) => option.value === value);
    case "multi_select": return Array.isArray(value) && value.every((item) => (field.options ?? []).some((option) => option.value === item));
    case "array": return Array.isArray(value) && !!field.items && value.every((item) => defaultMatches(field.items!, item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const values = value as Record<string, unknown>;
      return Object.keys(values).every((key) => (field.children ?? []).some((child) => child.key === key))
        && (field.children ?? []).every((child) => values[child.key] === undefined ? !child.required : defaultMatches(child, values[child.key]));
    }
  }
}

export function validatePluginConfigDefinition(input: unknown): { fields?: PluginConfigField[]; issues: PluginValidationIssue[] } {
  // Check shape depth before recursive Zod parsing, including hostile deeply nested JSON.
  if (input && typeof input === "object" && "fields" in input && Array.isArray(input.fields)) {
    const pending = input.fields.map((field: unknown) => ({ field, depth: 1 }));
    while (pending.length) {
      const { field, depth } = pending.pop()!;
      if (depth > PLUGIN_CONFIG_MAX_DEPTH) return { issues: [{ path: "fields", code: "CONFIG_DEPTH", message: `Maximum nesting depth is ${PLUGIN_CONFIG_MAX_DEPTH}` }] };
      if (!field || typeof field !== "object") continue;
      if ("children" in field && Array.isArray(field.children)) for (const child of field.children) pending.push({ field: child, depth: depth + 1 });
      if ("items" in field && field.items) pending.push({ field: field.items, depth: depth + 1 });
    }
  }
  const parsed = pluginConfigSchema.safeParse(input);
  if (!parsed.success) return { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: "CONFIG_SCHEMA", message: issue.message })) };
  const issues: PluginValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const walk = (fields: PluginConfigField[], parent: string, depth: number) => {
    const seen = new Set<string>();
    for (const field of fields) {
      const at = parent ? `${parent}.${field.key}` : field.key;
      if (depth > PLUGIN_CONFIG_MAX_DEPTH) { add(at, "CONFIG_DEPTH", `Maximum nesting depth is ${PLUGIN_CONFIG_MAX_DEPTH}`); continue; }
      if (seen.has(field.key)) add(at, "CONFIG_DUPLICATE_KEY", "Duplicate sibling field key");
      seen.add(field.key);
      if (RESERVED_KEYS.has(field.key)) add(at, "CONFIG_RESERVED_KEY", "Reserved object key");
      if (field.type !== "object" && field.children !== undefined) add(at, "CONFIG_CHILDREN", "Only object fields accept children");
      if (field.type !== "array" && field.items !== undefined) add(at, "CONFIG_ITEMS", "Only array fields accept items");
      if (field.options && new Set(field.options.map((option) => JSON.stringify(option.value))).size !== field.options.length) add(at, "CONFIG_OPTIONS", "Duplicate option values");
      const limits = field.validation;
      if (limits?.min !== undefined && limits.max !== undefined && limits.min > limits.max) add(at, "CONFIG_RANGE", "min exceeds max");
      if (limits?.minLength !== undefined && limits.maxLength !== undefined && limits.minLength > limits.maxLength) add(at, "CONFIG_RANGE", "minLength exceeds maxLength");
      let expression: RegExp | undefined;
      if (limits?.pattern !== undefined) {
        try { expression = new RegExp(limits.pattern); } catch { add(at, "CONFIG_PATTERN", "Invalid regular expression"); }
      }
      if (field.default !== undefined) {
        const value = field.default;
        if (!defaultMatches(field, value)) add(at, "CONFIG_DEFAULT", field.type === "secret" ? "Secret defaults are forbidden" : "Default does not match field type or choices");
        if ((typeof value === "number" && ((limits?.min !== undefined && value < limits.min) || (limits?.max !== undefined && value > limits.max)))
          || (typeof value === "string" && ((limits?.minLength !== undefined && value.length < limits.minLength) || (limits?.maxLength !== undefined && value.length > limits.maxLength) || (expression && !expression.test(value))))) add(at, "CONFIG_DEFAULT", "Default violates validation constraints");
      }
      if (field.children) walk(field.children, at, depth + 1);
      if (field.items) walk([field.items], at, depth + 1);
    }
  };
  walk(parsed.data.fields, "", 1);
  return { fields: parsed.data.fields, issues };
}

export interface PluginBundleValidation {
  manifest?: z.infer<typeof pluginManifestSchema>;
  issues: PluginValidationIssue[];
  permissions: string[];
}

/** Assumes decompression already applied size/count quotas; never executes bundle resources. */
export function validatePluginBundleFiles(
  files: Readonly<Record<string, Uint8Array>>,
  options: { hostVersion?: string } = {},
): PluginBundleValidation {
  const issues: PluginValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  for (const entry of Object.keys(files)) if (!isPluginBundleResourcePath(entry)) add(entry, "BUNDLE_ENTRY", "Entry is outside the declarative resource allowlist");
  const manifestPath = files["plugin.manifest.json"] ? "plugin.manifest.json" : "manifest.json";
  if (files["plugin.manifest.json"] && files["manifest.json"]) add(manifestPath, "MANIFEST_AMBIGUOUS", "Use one manifest in the bundle root");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files[manifestPath])); }
  catch { add(manifestPath, "MANIFEST_JSON", "Missing or invalid UTF-8 JSON manifest"); return { issues, permissions: [] }; }
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(issue.path.join("."), "MANIFEST_SCHEMA", issue.message);
    return { issues, permissions: [] };
  }
  const manifest = parsed.data;
  const declaredPages = new Set((manifest.spec.pages ?? []).map(page => page.id));
  for (const entry of Object.keys(files)) {
    if (entry.startsWith("pages/") && !declaredPages.has(entry.split("/")[1]!)) {
      add(entry, "PAGE_UNDECLARED", "Page resources require a matching manifest page declaration");
    }
  }
  const allowedKeys = (value: unknown, keys: string[], at: string) => {
    if (value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.keys(value)) if (!keys.includes(key)) add(`${at}.${key}`, "MANIFEST_UNKNOWN", "Unknown manifest field");
  };
  const root = raw as Record<string, unknown>;
  allowedKeys(root, ["apiVersion", "kind", "metadata", "requires", "spec"], "manifest");
  allowedKeys(root.metadata, ["id", "displayName", "publisher", "version", "description", "license"], "metadata");
  allowedKeys(root.spec, ["config", "pages", "mcpServers", "skill", "tools", "skills", "proactive"], "spec");
  const rawSpec = (root.spec ?? {}) as Record<string, unknown>;
  allowedKeys(rawSpec.config, ["schemaVersion", "entry"], "spec.config");
  for (const [index, page] of (Array.isArray(rawSpec.pages) ? rawSpec.pages : []).entries()) allowedKeys(page, ["id", "title", "description", "entry", "capabilities", "checksum"], `spec.pages.${index}`);
  for (const [index, tool] of (Array.isArray(rawSpec.tools) ? rawSpec.tools : []).entries()) allowedKeys(tool, ["id", "name", "description", "category", "safetyLevel", "requiredPermissions", "inputSchema", "gatingConditions", "priority"], `spec.tools.${index}`);
  for (const [index, skill] of (Array.isArray(rawSpec.skills) ? rawSpec.skills : []).entries()) allowedKeys(skill, ["name", "description", "content", "entry"], `spec.skills.${index}`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.metadata.id) || RESERVED_KEYS.has(manifest.metadata.id)) add("metadata.id", "PLUGIN_ID", "Plugin id must be a safe lowercase identifier");
  if (/[\\/\x00-\x1f]/.test(manifest.metadata.version)) add("metadata.version", "PLUGIN_VERSION", "Release labels cannot contain path separators or control characters");
  const compatibility = checkPluginHostCompatibility(manifest, options.hostVersion);
  if (!compatibility.compatible) add("requires.hostApiVersion", "HOST_INCOMPATIBLE", compatibility.reason!);
  const entryExists = (entry: string, at: string) => {
    if (!isPluginBundleResourcePath(entry) || !files[entry]?.length) add(at, "ENTRY_MISSING", `Missing or invalid entry: ${entry}`);
  };
  const configEntry = manifest.spec.config?.entry ?? "config.schema.json";
  if (manifest.spec.config || files[configEntry]) {
    entryExists(configEntry, "spec.config.entry");
    if (files[configEntry]) {
      try { for (const issue of validatePluginConfigDefinition(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files[configEntry]))).issues) issues.push({ ...issue, path: `${configEntry}:${issue.path}` }); }
      catch { add(configEntry, "CONFIG_JSON", "Invalid UTF-8 JSON config schema"); }
    }
  }
  const permissions = new Set<string>();
  const pageIds = new Set<string>();
  for (const page of manifest.spec.pages ?? []) {
    if (pageIds.has(page.id)) add(`pages.${page.id}`, "PAGE_DUPLICATE", "Duplicate page id");
    pageIds.add(page.id);
    if (!page.entry.startsWith(`pages/${page.id}/`) || !/\.html?$/i.test(page.entry)) add(page.entry, "PAGE_ENTRY", "Page entry must be an HTML file inside its page directory");
    entryExists(page.entry, `pages.${page.id}.entry`);
    for (const permission of page.capabilities) permissions.add(permission);
    if (page.capabilities.some((capability) => capability.startsWith("config.")) && !manifest.spec.config && !files[configEntry]) add(`pages.${page.id}`, "PAGE_CONFIG", "Config capability requires a config schema");
  }
  if (manifest.spec.skill) entryExists(manifest.spec.skill, "spec.skill");
  const skillNames = new Set<string>();
  const claimedSkillEntries = new Set<string>();
  const checkSkillUtf8 = (entry: string) => {
    if (!files[entry]?.length) return;
    try { new TextDecoder("utf-8", { fatal: true }).decode(files[entry]); }
    catch { add(entry, "SKILL_ENCODING", "Invalid UTF-8 skill entry"); }
  };
  for (const skill of manifest.spec.skills ?? []) {
    if (skillNames.has(skill.name)) add(`skills.${skill.name}`, "SKILL_DUPLICATE", "Duplicate skill name");
    skillNames.add(skill.name);
    if (skill.entry) {
      entryExists(skill.entry, `skills.${skill.name}.entry`);
      claimedSkillEntries.add(skill.entry);
      checkSkillUtf8(skill.entry);
    }
    else if (!skill.content?.trim()) add(`skills.${skill.name}`, "SKILL_CONTENT", "Skill needs content or an entry");
  }
  const rootSkillEntry = manifest.spec.skill ?? (files["SKILL.md"] ? "SKILL.md" : files["skill.md"] ? "skill.md" : undefined);
  if (rootSkillEntry) {
    if (!claimedSkillEntries.has(rootSkillEntry) && !skillNames.has(manifest.metadata.id)) {
      checkSkillUtf8(rootSkillEntry);
      skillNames.add(manifest.metadata.id);
    }
    claimedSkillEntries.add(rootSkillEntry);
  }
  for (const entry of Object.keys(files).sort()) {
    if (claimedSkillEntries.has(entry) || !entry.startsWith("skills/") || (!entry.endsWith("/SKILL.md") && !entry.endsWith("/skill.md"))) continue;
    const name = entry.split("/")[1];
    if (!name || skillNames.has(name)) continue;
    checkSkillUtf8(entry);
    skillNames.add(name);
  }
  const toolNames = new Set<string>();
  const toolIds = new Set<string>();
  for (const tool of manifest.spec.tools ?? []) {
    if (toolNames.has(tool.name)) add(`tools.${tool.name}`, "TOOL_DUPLICATE", "Duplicate tool name");
    toolNames.add(tool.name);
    const declaredId = tool.id ?? tool.name;
    const canonicalId = declaredId.startsWith(`${manifest.metadata.id}.`) ? declaredId : `${manifest.metadata.id}.${declaredId}`;
    if (toolIds.has(canonicalId)) add(`tools.${tool.name}`, "TOOL_DUPLICATE_ID", `Duplicate canonical tool id: ${canonicalId}`);
    toolIds.add(canonicalId);
    for (const permission of tool.requiredPermissions) {
      if (!permission.trim() || permission.length > 128 || /\s/.test(permission)) add(`tools.${tool.name}`, "TOOL_PERMISSION", "Permission must be a non-empty identifier without whitespace");
      permissions.add(permission);
    }
  }
  for (const sensor of manifest.spec.proactive?.sensors ?? []) permissions.add(`proactive.sensor:${sensor.sourceId}`);
  return { manifest, issues, permissions: [...permissions].sort() };
}
