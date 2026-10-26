import { z } from 'zod';
import type { ApiEndpoint } from './http-api.js';
import {
  llmProviderCatalogResponseSchema, llmConfigSchema, llmConfigResponseSchema,
  llmTestConnectionRequestSchema, llmTestConnectionResponseSchema, llmCreatePresetRequestSchema,
  llmPresetSchema, llmPresetListResponseSchema,
} from './llm-schemas.js';

const presetParams = z.object({ presetId: z.string().min(1) });
export const llmDeletePresetResponseSchema = z.object({ deleted: z.boolean(), presetId: z.string().min(1) });
export const llmApi = {
  providers: {
    method: 'get', path: '/v1/llm/providers', operationId: 'listModelProviders',
    summary: '读取模型配置目录与执行可用性', tags: ['LLM'], response: llmProviderCatalogResponseSchema,
  },
  getConfig: {
    method: 'get', path: '/v1/llm/config', operationId: 'get_v1_llm_config',
    summary: '读取大语言模型与供应商配置', tags: ['LLM'], response: llmConfigResponseSchema,
  },
  saveConfig: {
    method: 'put', path: '/v1/llm/config', operationId: 'put_v1_llm_config',
    summary: '保存大语言模型与供应商配置', tags: ['LLM'], body: llmConfigSchema, bodyRequired: true,
    response: llmConfigResponseSchema, validationErrorCode: 'INVALID_LLM_CONFIG', validationErrorMessage: 'Invalid LLM config payload',
    errors: { 400: 'INVALID_LLM_CONFIG' },
  },
  testConnection: {
    method: 'post', path: '/v1/llm/test-connection', operationId: 'post_v1_llm_test_connection',
    summary: '测试大模型供应商连通性', tags: ['LLM'], body: llmTestConnectionRequestSchema, bodyRequired: true,
    response: llmTestConnectionResponseSchema, validationErrorCode: 'INVALID_REQUEST', validationErrorMessage: 'Invalid test connection request',
    errors: { 400: 'INVALID_REQUEST' },
  },
  listPresets: {
    method: 'get', path: '/v1/llm/presets', operationId: 'get_v1_llm_presets',
    summary: '列出大语言模型配置预设（含激活标记）', tags: ['LLM'], response: llmPresetListResponseSchema,
  },
  createPreset: {
    method: 'post', path: '/v1/llm/presets', operationId: 'post_v1_llm_presets',
    summary: '新建大语言模型配置预设', tags: ['LLM'], body: llmCreatePresetRequestSchema, bodyRequired: true,
    response: llmPresetSchema, status: 201, validationErrorCode: 'INVALID_LLM_PRESET', validationErrorMessage: 'Invalid LLM preset payload',
    errors: { 400: 'INVALID_LLM_PRESET' },
  },
  activatePreset: {
    method: 'post', path: '/v1/llm/presets/{presetId}/activate', operationId: 'post_v1_llm_presets_presetId_activate',
    summary: '激活大语言模型配置预设', tags: ['LLM'], params: presetParams, response: llmPresetSchema,
    errors: { 400: 'Invalid preset id', 404: 'PRESET_NOT_FOUND' },
  },
  deletePreset: {
    method: 'delete', path: '/v1/llm/presets/{presetId}', operationId: 'delete_v1_llm_presets_presetId',
    summary: '删除大语言模型配置预设', tags: ['LLM'], params: presetParams, response: llmDeletePresetResponseSchema,
    errors: { 400: 'Invalid preset id', 404: 'PRESET_NOT_FOUND' },
  },
} as const satisfies Record<string, ApiEndpoint>;
