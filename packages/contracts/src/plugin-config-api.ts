import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import {
  pluginConfigSchema, pluginConfigSchemaOpenApi,
  pluginConfigSnapshotSchema, pluginConfigUpdateRequestSchema, pluginConfigAccessQuerySchema,
  pluginPageSchema, pluginPageGenerationSchema, type PluginConfigField,
} from "./plugin-config-schemas.js";
import { validatePluginConfigDefinition } from "./plugin-validation.js";

/** Run the shared depth preflight before entering the recursive field parser. */
export const pluginConfigRegistrationRequestSchema = z.unknown().transform<z.output<typeof pluginConfigSchema>>((input, ctx) => {
  const result = validatePluginConfigDefinition(input);
  for (const issue of result.issues) ctx.addIssue({ code: "custom", message: issue.message, path: [issue.path] });
  if (result.issues.length) return z.NEVER;
  return { apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields: result.fields! };
});

/** The HTTP response is a stored field snapshot, without the bundle DSL envelope. */
export const pluginConfigSchemaResponseSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  fields: z.unknown().transform<PluginConfigField[]>((fields, ctx) => {
    const result = validatePluginConfigDefinition({ apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields });
    for (const issue of result.issues) ctx.addIssue({ code: "custom", message: issue.message, path: [issue.path] });
    return result.issues.length ? z.NEVER : result.fields!;
  }),
});

/** zod-to-openapi cannot expand the recursive DSL; runtime uses the schemas above. */
export const pluginConfigSchemaResponseOpenApi = z.object({
  schemaVersion: z.number().int().nonnegative(),
  fields: z.array(z.record(z.string(), z.unknown())).max(200),
}).strict();

const params = z.object({ pluginId: z.string().min(1) });
const lifecycleQuery = z.object({ expectedLifecycleGeneration: z.string().min(1).max(128).optional() });
/** User-owned persisted ordinary data; never defaults, Secrets, or orphaned fields. */
export const pluginDataExportSchema = z.object({
  format: z.literal("aervox-plugin-data/v1"),
  pluginId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()),
}).strict();
/** Stored Pages preserve the legacy nullable description and checksum fields. */
export const pluginPageResponseSchema = pluginPageSchema.extend({
  pageGeneration: pluginPageGenerationSchema.openapi({ description: "Host-owned Page declaration identity; rotates when the Page changes or is recreated." }),
  description: pluginPageSchema.shape.description.nullable(),
  checksum: pluginPageSchema.shape.checksum.nullable(),
});
export const pluginConfigApi = {
  exportData: {
    method: "get", path: "/v1/plugins/{pluginId}/data-export", operationId: "get_v1_plugins_pluginId_data_export",
    summary: "导出已保存的普通插件数据（停用或缺包时仍可用）", tags: ["Plugins"], params,
    response: pluginDataExportSchema,
    errors: { 400: "Invalid plugin id", 404: "PLUGIN_NOT_FOUND", 409: "PLUGIN_CONFIG_REVISION_CONFLICT" },
  },
  getSchema: {
    method: "get", path: "/v1/plugins/{pluginId}/config/schema", operationId: "get_v1_plugins_pluginId_config_schema",
    summary: "读取插件配置 Schema", tags: ["Plugins"], params,
    response: pluginConfigSchemaResponseSchema, openapi: { response: pluginConfigSchemaResponseOpenApi },
    errors: { 400: "Invalid plugin id", 404: "PLUGIN_NOT_FOUND or PLUGIN_CONFIG_SCHEMA_NOT_FOUND" },
  },
  registerSchema: {
    method: "put", path: "/v1/plugins/{pluginId}/config/schema", operationId: "put_v1_plugins_pluginId_config_schema",
    summary: "注册/更新插件配置 Schema", tags: ["Plugins"], params,
    body: pluginConfigRegistrationRequestSchema, bodyRequired: true, response: pluginConfigSchemaResponseSchema,
    openapi: { body: pluginConfigSchemaOpenApi, response: pluginConfigSchemaResponseOpenApi },
    validationErrorCode: "INVALID_CONFIG_SCHEMA", validationErrorMessage: "invalid config schema",
    errors: { 400: "INVALID_CONFIG_SCHEMA", 404: "PLUGIN_NOT_FOUND", 409: "PLUGIN_PACKAGE_IMMUTABLE: install a new package version to change its config schema" },
  },
  get: {
    method: "get", path: "/v1/plugins/{pluginId}/config", operationId: "get_v1_plugins_pluginId_config",
    summary: "读取插件配置（secret 仅返回状态）", tags: ["Plugins"], params, query: pluginConfigAccessQuerySchema, response: pluginConfigSnapshotSchema,
    errors: { 400: "Invalid plugin id or captured Page identity", 404: "PLUGIN_NOT_FOUND or PLUGIN_CONFIG_SCHEMA_NOT_FOUND", 409: "PLUGIN_CONFIG_REVISION_CONFLICT or PLUGIN_DISABLED or PLUGIN_UNAVAILABLE" },
  },
  save: {
    method: "put", path: "/v1/plugins/{pluginId}/config", operationId: "put_v1_plugins_pluginId_config",
    summary: "保存插件配置（revision CAS）", tags: ["Plugins"], params,
    body: pluginConfigUpdateRequestSchema, bodyRequired: true, response: pluginConfigSnapshotSchema,
    validationErrorCode: "INVALID_CONFIG", validationErrorMessage: "invalid config update",
    errors: { 400: "INVALID_CONFIG", 404: "PLUGIN_NOT_FOUND or PLUGIN_CONFIG_SCHEMA_NOT_FOUND", 409: "PLUGIN_CONFIG_REVISION_CONFLICT or PLUGIN_DISABLED or PLUGIN_UNAVAILABLE" },
  },
  reset: {
    method: "post", path: "/v1/plugins/{pluginId}/config/reset", operationId: "post_v1_plugins_pluginId_config_reset",
    summary: "重置插件配置", tags: ["Plugins"], params, query: pluginConfigAccessQuerySchema, response: pluginConfigSnapshotSchema,
    errors: { 400: "Invalid plugin id or captured Page identity", 404: "PLUGIN_NOT_FOUND or PLUGIN_CONFIG_SCHEMA_NOT_FOUND", 409: "PLUGIN_CONFIG_REVISION_CONFLICT or PLUGIN_DISABLED or PLUGIN_UNAVAILABLE" },
  },
  listPages: {
    method: "get", path: "/v1/plugins/{pluginId}/pages", operationId: "get_v1_plugins_pluginId_pages",
    summary: "列出插件 Page", tags: ["Plugins"], params, query: lifecycleQuery,
    response: z.object({ pages: z.array(pluginPageResponseSchema) }),
    errors: { 400: "Invalid plugin id or lifecycle generation", 404: "PLUGIN_NOT_FOUND", 409: "PLUGIN_CONFIG_REVISION_CONFLICT or PLUGIN_DISABLED or PLUGIN_UNAVAILABLE" },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type PluginConfigSchemaResponse = z.output<typeof pluginConfigSchemaResponseSchema>;
export type RegisterPluginConfigSchemaRequest = z.input<typeof pluginConfigSchema>;
export type SavePluginConfigRequest = z.input<typeof pluginConfigUpdateRequestSchema>;
export type PluginConfigAccessQuery = z.input<typeof pluginConfigAccessQuerySchema>;
export type PluginPageResponse = z.output<typeof pluginPageResponseSchema>;
export type PluginDataExport = z.output<typeof pluginDataExportSchema>;
