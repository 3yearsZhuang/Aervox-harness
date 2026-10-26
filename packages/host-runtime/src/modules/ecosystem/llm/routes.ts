import type { FastifyInstance } from 'fastify';
import { llmApi, type LLMConfig, type LLMCreatePresetRequest, type LLMTestConnectionRequest } from '@aervox/contracts';
import { modelProviderCatalog } from './provider-catalog.js';
import { registerContractRoute } from '../../../shared/contract-route.js';
import { resolveLocalContext } from '../../../shared/local-context.js';
import { LLMConfigInputError, type LLMConfigService } from './service.js';

export function registerLLMRoutes(app: FastifyInstance, service: LLMConfigService): void {
  registerContractRoute(app, llmApi.providers, async () => modelProviderCatalog());
  registerContractRoute(app, llmApi.getConfig, async req => service.getConfig(resolveLocalContext(req)));
  registerContractRoute(app, llmApi.saveConfig, async (req, reply) => {
    try { return await service.saveConfig(resolveLocalContext(req), req.body as LLMConfig); }
    catch (error) {
      if (!(error instanceof LLMConfigInputError)) throw error;
      return reply.code(400).send({ code: 'INVALID_LLM_CONFIG', message: error.message });
    }
  });
  registerContractRoute(app, llmApi.testConnection, async req => service.testConnection(req.body as LLMTestConnectionRequest));
  registerContractRoute(app, llmApi.listPresets, async req => service.listPresets(resolveLocalContext(req)));
  registerContractRoute(app, llmApi.createPreset, async (req, reply) => {
    const body = req.body as LLMCreatePresetRequest;
    try { return await service.createPreset(resolveLocalContext(req), body.name, body.config); }
    catch (error) {
      if (!(error instanceof LLMConfigInputError)) throw error;
      return reply.code(400).send({ code: 'INVALID_LLM_PRESET', message: error.message });
    }
  });
  registerContractRoute(app, llmApi.activatePreset, async (req, reply) => {
    const { presetId } = req.params as { presetId: string };
    const activated = await service.activatePreset(resolveLocalContext(req), presetId);
    if (!activated) return reply.code(404).send({ code: 'PRESET_NOT_FOUND', message: 'LLM preset not found' });
    return activated;
  });
  registerContractRoute(app, llmApi.deletePreset, async (req, reply) => {
    const { presetId } = req.params as { presetId: string };
    const deleted = await service.deletePreset(resolveLocalContext(req), presetId);
    if (!deleted) return reply.code(404).send({ code: 'PRESET_NOT_FOUND', message: 'LLM preset not found' });
    return { deleted: true, presetId };
  });
}
