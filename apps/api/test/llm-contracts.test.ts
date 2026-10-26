import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEndpointPath, apiProblemSchema, llmApi } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { LLMConfigService } from '@aervox/host-runtime-test/modules/ecosystem/llm/service';
import { buildApp } from './app-fixture.js';

const config = { enabled: true, providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'fixture-model', temperature: 0.7, maxTokens: 4096, settings: {} };
const token = 'llm-contract-token';
const endpointPath = (endpoint: { path: string }, presetId = 'missing') => apiEndpointPath(endpoint, { presetId });

describe('ITER-064 LLM shared contracts over HTTP', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  async function request(method: string, path: string, body?: unknown, auth: string | null = token) {
    const response = await fetch(base + path, { method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: 'token', token } });
    base = await built.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterEach(async () => { vi.restoreAllMocks(); await built.app.close(); await database.cleanup(); });

  it('authenticates every operation before service execution or mutation', async () => {
    const probe = vi.spyOn(LLMConfigService.prototype, 'testConnection');
    for (const endpoint of Object.values(llmApi)) for (const auth of [null, 'invalid']) {
      const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), undefined, auth);
      expect(response.status).toBe(401);
      expect(apiProblemSchema.parse(response.body).code).toBe('AUTH_UNAUTHORIZED');
    }
    expect(probe).not.toHaveBeenCalled();
    expect((await database.client.execute('SELECT * FROM llm_configs')).rows).toEqual([]);
  });

  it('reads defaults without creating a preset and preserves normalization and key clearing on saves', async () => {
    const initial = await request('GET', llmApi.getConfig.path);
    expect(initial.status).toBe(200);
    expect(llmApi.getConfig.response.parse(initial.body)).toMatchObject({ enabled: true, providerType: 'ollama', temperature: 0.7, maxTokens: 4096, settings: {} });
    expect((await database.client.execute('SELECT * FROM llm_configs')).rows).toEqual([]);
    const saved = await request('PUT', llmApi.saveConfig.path, { ...config, baseUrl: config.baseUrl + '///', modelId: ' fixture-model ', apiKey: ' key-canary ', settings: { stream: true, retries: 2, label: 'label' } });
    expect(saved.status).toBe(200);
    expect(llmApi.saveConfig.response.parse(saved.body)).toMatchObject({ baseUrl: config.baseUrl, modelId: 'fixture-model', apiKey: 'key-canary', settings: { stream: true, retries: 2, label: 'label' } });
    const updated = await request('PUT', llmApi.saveConfig.path, config);
    expect(updated.status).toBe(200);
    expect(updated.body).not.toHaveProperty('apiKey');
    expect((await database.client.execute('SELECT api_key FROM llm_configs')).rows[0]?.api_key).toBeNull();
  });

  it('rejects absent and malformed bodies including a blank normalized model before writes or probes', async () => {
    const probe = vi.spyOn(LLMConfigService.prototype, 'testConnection');
    for (const endpoint of [llmApi.saveConfig, llmApi.testConnection, llmApi.createPreset]) {
      const response = await request(endpoint.method.toUpperCase(), endpoint.path);
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body).code).toBe(endpoint.validationErrorCode);
    }
    for (const input of [null, [], {}, { ...config, temperature: 3 }, { ...config, modelId: '   ' }, { ...config, settings: { nested: {} } }]) {
      expect((await request('PUT', llmApi.saveConfig.path, input)).status).toBe(400);
      expect((await request('POST', llmApi.createPreset.path, { name: 'Fixture', config: input })).status).toBe(400);
    }
    for (const input of [{ ...config, baseUrl: 'invalid-url-credential-canary' }, { ...config, providerType: 'unregistered' }]) {
      const response = await request('PUT', llmApi.saveConfig.path, input);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_LLM_CONFIG');
      expect(response.text).not.toContain('credential-canary');
    }
    expect(probe).not.toHaveBeenCalled();
    expect((await database.client.execute('SELECT * FROM llm_configs')).rows).toEqual([]);
  });

  it('preserves preset creation, active selection, deletion promotion and missing-id behavior', async () => {
    expect((await request('GET', llmApi.listPresets.path)).body).toEqual({ presets: [], activeId: null });
    const first = await request('POST', llmApi.createPreset.path, { name: 'First', config });
    expect(first.status).toBe(201);
    expect(llmApi.createPreset.response.parse(first.body)).toMatchObject({ name: 'First', isActive: true });
    const second = await request('POST', llmApi.createPreset.path, { name: 'Second', config: { ...config, modelId: 'other-model' } });
    expect(second.status).toBe(201);
    expect(second.body.isActive).toBe(false);
    const activated = await request('POST', endpointPath(llmApi.activatePreset, second.body.id));
    expect(activated.status).toBe(200);
    expect(llmApi.activatePreset.response.parse(activated.body)).toMatchObject({ id: second.body.id, isActive: true });
    expect((await request('GET', llmApi.getConfig.path)).body.modelId).toBe('other-model');
    const removed = await request('DELETE', endpointPath(llmApi.deletePreset, second.body.id));
    expect(removed.status).toBe(200);
    expect(llmApi.deletePreset.response.parse(removed.body)).toEqual({ deleted: true, presetId: second.body.id });
    const list = llmApi.listPresets.response.parse((await request('GET', llmApi.listPresets.path)).body);
    expect(list).toMatchObject({ activeId: first.body.id, presets: [{ id: first.body.id, isActive: true }] });
    for (const endpoint of [llmApi.activatePreset, llmApi.deletePreset]) {
      const missing = await request(endpoint.method.toUpperCase(), endpointPath(endpoint));
      expect(missing.status).toBe(404);
      expect(apiProblemSchema.parse(missing.body).code).toBe('PRESET_NOT_FOUND');
    }
    expect((await request('GET', llmApi.getConfig.path)).body.modelId).toBe(config.modelId);
  });

  it('keeps failed connection probes as 200 business results without saving configuration', async () => {
    vi.spyOn(LLMConfigService.prototype, 'testConnection').mockResolvedValue({ ok: false, latencyMs: 0, message: 'fixture-unreachable' });
    const response = await request('POST', llmApi.testConnection.path, { providerType: 'ollama', baseUrl: config.baseUrl, modelId: 'fixture-model' });
    expect(response.status).toBe(200);
    expect(llmApi.testConnection.response.parse(response.body)).toEqual({ ok: false, latencyMs: 0, message: 'fixture-unreachable' });
    expect((await database.client.execute('SELECT * FROM llm_configs')).rows).toEqual([]);
  });

  it.each([
    'http://user-canary:password-canary@bad host/?query-canary',
    'http://user-canary:password-canary@127.0.0.1:1/v1?query-canary',
  ])('does not echo credentials from invalid URLs or fetch construction failures: %s', async baseUrl => {
    const response = await request('POST', llmApi.testConnection.path, { ...config, baseUrl, apiKey: 'api-key-canary' });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.text).not.toMatch(/user-canary|password-canary|query-canary|api-key-canary/);
  });

  it('reports provider HTTP status without forwarding a credential-bearing response body', async () => {
    const provider = createServer((_req, res) => { res.writeHead(500); res.end('api-key-canary password-canary'); });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
      const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
      const response = await request('POST', llmApi.testConnection.path, { ...config, baseUrl: providerUrl, apiKey: 'api-key-canary' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ ok: false, message: expect.stringContaining('HTTP 500') });
      expect(response.text).not.toMatch(/api-key-canary|password-canary/);
    } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  });

  it('bounds successful response bodies across the main and capability probes and closes stalled streams', async () => {
    const scenarios = ['models', 'props', 'meta', 'budget', 'error'] as const;
    await Promise.all(scenarios.map(async stalled => {
      let stalledResponseClosed!: Promise<void>;
      let delayedModelsTimer: ReturnType<typeof setTimeout> | undefined;
      let metadataRequests = 0;
      const provider = createServer((req, res) => {
        const endpoint = req.url?.endsWith('/models') ? 'models' : req.url?.endsWith('/props') ? 'props' : 'meta';
        if (endpoint === 'meta') metadataRequests++;
        if (endpoint === stalled || (stalled === 'budget' && endpoint === 'props') || (stalled === 'error' && endpoint === 'models')) {
          stalledResponseClosed = new Promise<void>(resolve => res.once('close', resolve));
          res.writeHead(stalled === 'error' ? 500 : 200, { 'Content-Type': 'application/json' });
          res.write('{');
        } else if (endpoint === 'models') {
          const complete = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); };
          if (stalled === 'budget') delayedModelsTimer = setTimeout(complete, 6000);
          else complete();
        } else if (endpoint === 'props') {
          res.writeHead(404); res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"context_length":8192}');
        }
      });
      await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
      try {
        const response = await fetch(base + llmApi.testConnection.path, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...config, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(200);
        const result = llmApi.testConnection.response.parse(await response.json());
        expect(result.ok).toBe(stalled !== 'models' && stalled !== 'error');
        if (stalled === 'props') expect(result.capabilities).toEqual({ contextWindow: 8192, supportsToolCalls: true });
        if (stalled === 'meta' || stalled === 'budget') expect(result.capabilities).toEqual({ supportsToolCalls: true });
        if (stalled === 'budget') expect(metadataRequests).toBe(0);
        expect(stalledResponseClosed).toBeDefined();
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([stalledResponseClosed, new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(() => reject(new Error('probe_body_not_closed')), 1000);
          })]);
        } finally { clearTimeout(closeTimer); }
      } finally {
        clearTimeout(delayedModelsTimer);
        provider.closeAllConnections();
        await new Promise<void>(resolve => provider.close(() => resolve()));
      }
    }));
  });

  it.each([
    ['object', { toString: null }, undefined],
    ['number', 8192, 8192],
    ['string', '8192', 8192],
  ])('keeps %s capability metadata best-effort after a successful connection', async (_kind, contextLength, expectedContextWindow) => {
    const provider = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.endsWith('/models')) res.end('{"data":[]}');
      else if (req.url?.endsWith('/props')) { res.writeHead(404); res.end(); }
      else res.end(JSON.stringify({ context_length: contextLength }));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    try {
      const response = await request('POST', llmApi.testConnection.path, { ...config,
        baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` });
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.capabilities).toEqual({ supportsToolCalls: true,
        ...(expectedContextWindow === undefined ? {} : { contextWindow: expectedContextWindow }),
      });
    } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
  });

  it('conceals unexpected service failures and rejects malformed successful responses', async () => {
    const cases = [
      [llmApi.getConfig, 'getConfig', undefined], [llmApi.saveConfig, 'saveConfig', config],
      [llmApi.testConnection, 'testConnection', config], [llmApi.listPresets, 'listPresets', undefined],
      [llmApi.createPreset, 'createPreset', { name: 'Fixture', config }], [llmApi.activatePreset, 'activatePreset', undefined],
      [llmApi.deletePreset, 'deletePreset', undefined],
    ] as const;
    for (const [endpoint, method, input] of cases) {
      const spy = vi.spyOn(LLMConfigService.prototype, method).mockRejectedValue(new Error('SELECT secret FROM /private/key-canary.sqlite'));
      const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), input);
      expect(response.status).toBe(500);
      expect(apiProblemSchema.parse(response.body).code).toBe('INTERNAL_ERROR');
      expect(response.text).not.toMatch(/SELECT|private|key-canary/);
      spy.mockRestore();
    }
    for (const [endpoint, method, input] of cases.filter(([endpoint]) => endpoint !== llmApi.deletePreset)) {
      const spy = vi.spyOn(LLMConfigService.prototype, method).mockResolvedValue({ malformed: true } as never);
      const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), input);
      expect(response.status).toBe(500);
      expect(apiProblemSchema.parse(response.body).code).toBe('INTERNAL_ERROR');
      spy.mockRestore();
    }
  });
});
