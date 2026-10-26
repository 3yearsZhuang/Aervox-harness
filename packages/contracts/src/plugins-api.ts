import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import type { ApiEndpoint } from './http-api.js';

extendZodWithOpenApi(z);

/** Preserve the persisted plugin row, including integer flags and nullable metadata. */
export const pluginSummaryResponseSchema = z.object({
  id: z.string().min(1), publisher: z.string(), version: z.string(), checksum: z.string(),
  signature: z.string().nullable().optional(), permissions: z.unknown().optional(), installSource: z.string(),
  enabled: z.union([z.literal(0), z.literal(1)]),
  availability: z.enum(['available', 'missing', 'invalid', 'unreadable']).optional(),
  lifecycleGeneration: z.string().min(1).optional(), bundleGeneration: z.string().nullable().optional(),
  configSchemaJson: z.unknown().optional(), configSchemaVersion: z.number().int().optional(),
  proactiveSpecJson: z.unknown().optional(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough().openapi('PluginSummaryResponse');

export const pluginGrantResponseSchema = z.object({
  id: z.string().min(1), pluginId: z.string().min(1), permission: z.string(), scope: z.string(),
  grantedAt: z.string(), revokedAt: z.string().nullable().optional(), createdAt: z.string(), updatedAt: z.string(),
}).openapi('PluginGrantResponse');
export const pluginPermissionResponseSchema = z.object({
  pluginId: z.string().min(1), permission: z.string().min(1), scope: z.string().nullable(), granted: z.boolean(),
});
const pluginParams = z.object({ pluginId: z.string().min(1) });
const grantParams = pluginParams.extend({ grantId: z.string().min(1) });
const permissionParams = pluginParams.extend({ permission: z.string().min(1) });

export const pluginsApi = {
  list: {
    method: 'get', path: '/v1/plugins', operationId: 'get_v1_plugins', summary: '列出本地插件', tags: ['Plugins'],
    response: z.object({ items: z.array(pluginSummaryResponseSchema) }),
  },
  setEnabled: {
    method: 'patch', path: '/v1/plugins/{pluginId}', operationId: 'patch_v1_plugins_pluginId', summary: '启用或停用插件', tags: ['Plugins'],
    params: pluginParams, body: z.object({ enabled: z.boolean() }), bodyRequired: true, response: pluginSummaryResponseSchema,
    validationErrorMessage: 'enabled is required', errors: { 400: 'enabled is required', 404: 'plugin not found' },
  },
  delete: {
    method: 'delete', path: '/v1/plugins/{pluginId}', operationId: 'delete_v1_plugins_pluginId', summary: '卸载插件', tags: ['Plugins'],
    params: pluginParams, response: z.void(), status: 204, errors: { 400: 'Invalid params', 404: 'plugin not found' },
  },
  grant: {
    method: 'post', path: '/v1/plugins/{pluginId}/grants', operationId: 'post_v1_plugins_pluginId_grants', summary: '授予插件权限', tags: ['Plugins'],
    params: pluginParams, body: z.object({ permission: z.string().min(1), scope: z.string().min(1) }), bodyRequired: true,
    response: pluginGrantResponseSchema, status: 201, validationErrorMessage: 'permission/scope are required',
    errors: { 400: 'permission/scope are required' },
  },
  listSensorGrants: {
    method: 'get', path: '/v1/plugins/{pluginId}/grants', operationId: 'get_v1_plugins_pluginId_grants', summary: '列出插件有效感知源授权', tags: ['Plugins'],
    params: pluginParams, response: z.object({ items: z.array(pluginGrantResponseSchema) }), errors: { 400: 'Invalid params' },
  },
  revokeGrant: {
    method: 'delete', path: '/v1/plugins/{pluginId}/grants/{grantId}', operationId: 'delete_v1_plugins_pluginId_grants_grantId', summary: '撤销指定插件的授权', tags: ['Plugins'],
    params: grantParams, response: pluginGrantResponseSchema, errors: { 400: 'Invalid params', 404: 'grant not found' },
  },
  permission: {
    method: 'get', path: '/v1/plugins/{pluginId}/permissions/{permission}', operationId: 'get_v1_plugins_pluginId_permissions_permission', summary: '查询插件权限', tags: ['Plugins'],
    params: permissionParams, query: z.object({ scope: z.string().optional() }), response: pluginPermissionResponseSchema,
    errors: { 400: 'Invalid params or scope' },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type PluginSummaryResponse = z.output<typeof pluginSummaryResponseSchema>;
export type PluginGrantResponse = z.output<typeof pluginGrantResponseSchema>;
