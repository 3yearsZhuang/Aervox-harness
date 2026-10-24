import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultModelProviderRegistry } from '@aervox/core';
import { llmProviderCatalogResponseSchema } from '@aervox/contracts';
import { modelProviderCatalog } from '../src/modules/ecosystem/llm/provider-catalog.js';
import { registerLLMRoutes } from '../src/modules/ecosystem/llm/routes.js';
import { LLMConfigService } from '../src/modules/ecosystem/llm/service.js';
import type { SqliteLLMConfigRepository } from '@aervox/repositories';

afterEach(() => { defaultModelProviderRegistry.unregister('audit-provider'); });
describe('provider catalog ownership', () => {
  it('publishes newly registered providers and uses exactly their execution defaults', async () => {
    defaultModelProviderRegistry.register({ id: 'audit-provider', name: 'Audit Provider', protocol: 'openai-compat', defaultBaseUrl: 'http://127.0.0.1:9123/v1', recommendedModels: ['audit-model'], isLocal: true, capabilities: { toolCalls: true } });
    const service = new LLMConfigService({ getConfig: async () => null } as unknown as SqliteLLMConfigRepository, { defaultProviderType: 'audit-provider' });
    const app = Fastify(); registerLLMRoutes(app, service);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/llm/providers' });
      expect(response.statusCode).toBe(200);
      const catalog = llmProviderCatalogResponseSchema.parse(response.json());
      const entry = catalog.providers.find(p => p.id === 'audit-provider')!;
      expect(entry).toMatchObject({ available: true, recommendedModels: ['audit-model'] });
      const config = await service.getConfig({ workspaceId: 'local', subjectUserId: 'local' });
      expect(config).toMatchObject({ baseUrl: entry.defaultBaseUrl, modelId: entry.recommendedModels[0] });
      expect(JSON.stringify(catalog)).not.toContain('apiKey');
    } finally { await app.close(); }
  });

  it('makes unsupported protocols explicit and excludes test-only providers', () => {
    const providers = modelProviderCatalog().providers;
    expect(providers.some(p => ['replay', 'faux'].includes(p.id))).toBe(false);
    expect(providers.find(p => p.id === 'anthropic')).toMatchObject({ available: false, unavailableReason: 'anthropic_unsupported' });
  });
});
