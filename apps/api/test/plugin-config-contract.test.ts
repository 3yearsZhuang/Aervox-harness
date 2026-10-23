import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEndpointPath, apiProblemSchema, pluginConfigApi } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { PluginConfigService } from '@aervox/host-runtime-test/modules/ecosystem/plugins/config-service';
import { buildApp } from './app-fixture.js';

const pluginId = 'config-contract-fixture';
const schema = {
  apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1,
  fields: [
    { key: 'label', type: 'string', label: 'Label', default: 'default' },
    { key: 'nested', type: 'object', label: 'Nested', children: [{ key: 'count', type: 'integer', label: 'Count', default: 2 }] },
    { key: 'token', type: 'secret', label: 'Token' },
  ],
};

describe('ITER-064 plugin configuration contracts over HTTP', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  const authorization = 'Bearer plugin-config-contract-token';
  const url = (endpoint: { path: string }, id = pluginId) => apiEndpointPath(endpoint, { pluginId: id });
  async function request(method: string, path: string, body?: unknown, auth: string | null = authorization) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), contentType: response.headers.get('content-type') };
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: 'token', token: 'plugin-config-contract-token' } });
    base = await built.app.listen({ host: '127.0.0.1', port: 0 });
    expect((await request('POST', '/v1/plugins', { id: pluginId, publisher: 'example', version: '1.0.0' })).status).toBe(201);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await built.app.close();
    await database.cleanup();
  });

  it('authenticates all configuration and Page endpoints before inspecting write bodies', async () => {
    for (const endpoint of Object.values(pluginConfigApi)) {
      for (const token of [null, 'Bearer invalid']) {
        const response = await request(endpoint.method.toUpperCase(), url(endpoint), undefined, token);
        expect(response.status).toBe(401);
        expect(apiProblemSchema.parse(response.body)).toMatchObject({ code: 'AUTH_UNAUTHORIZED', status: 401 });
      }
    }
    expect((await database.client.execute({ sql: 'SELECT revision FROM plugin_configs WHERE plugin_id = ?', args: [pluginId] })).rows).toEqual([]);
  });

  it('rejects absent and malformed bodies, including deep recursive fields, without mutation', async () => {
    for (const endpoint of [pluginConfigApi.registerSchema, pluginConfigApi.save]) {
      const response = await request('PUT', url(endpoint));
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body)).toMatchObject({ code: endpoint.validationErrorCode, error: endpoint.validationErrorCode });
    }
    for (const body of [{ revision: -1 }, { revision: 0.5 }, { revision: '0' }, { revision: 0, values: [] }, { revision: 0, secretValues: { token: 42 } }]) {
      const response = await request('PUT', url(pluginConfigApi.save), body);
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body).code).toBe('INVALID_CONFIG');
    }
    let deep: unknown = { key: 'value', type: 'string', label: 'Value' };
    for (let i = 0; i < 512; i++) deep = { key: 'nested', type: 'object', label: 'Nested', children: [deep] };
    for (const fields of [
      [deep],
      [{ key: 'nested', type: 'object', label: 'Nested', children: [{ key: 'bad', type: 'unknown', label: 'Bad' }] }],
      [{ key: '__proto__', type: 'string', label: 'Reserved' }],
      [{ key: 'token', type: 'secret', label: 'Token', default: 'forbidden-secret' }],
    ]) {
      const response = await request('PUT', url(pluginConfigApi.registerSchema), { ...schema, fields });
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body).code).toBe('INVALID_CONFIG_SCHEMA');
    }
    expect((await request('GET', url(pluginConfigApi.getSchema))).status).toBe(404);
    expect((await database.client.execute({ sql: 'SELECT value_json FROM plugin_config_secrets WHERE plugin_id = ?', args: [pluginId] })).rows).toEqual([]);
  });

  it('validates the actual schema snapshot and preserves CAS, partial values, Secret operations and reset', async () => {
    const registered = await request('PUT', url(pluginConfigApi.registerSchema), schema);
    expect(registered.status).toBe(200);
    const readSchema = await request('GET', url(pluginConfigApi.getSchema));
    expect(readSchema.status).toBe(200);
    expect(pluginConfigApi.getSchema.response.parse(readSchema.body)).toEqual(pluginConfigApi.registerSchema.response.parse(registered.body));
    expect(readSchema.body).not.toHaveProperty('apiVersion');
    expect(readSchema.body).not.toHaveProperty('kind');
    const initial = await request('GET', url(pluginConfigApi.get));
    expect(initial.status).toBe(200);
    expect(pluginConfigApi.get.response.parse(initial.body)).toMatchObject({ revision: 0, values: { label: 'default', nested: { count: 2 } }, secretFields: { token: { configured: false } } });
    const saved = await request('PUT', url(pluginConfigApi.save), { revision: 0, values: { label: 'saved' }, secretValues: { token: 'private-original' } });
    expect(saved.status).toBe(200);
    expect(pluginConfigApi.save.response.parse(saved.body)).toMatchObject({ revision: 1, secretFields: { token: { configured: true } } });
    expect(JSON.stringify(saved.body)).not.toContain('private-original');
    const partial = await request('PUT', url(pluginConfigApi.save), { revision: 1 });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({ revision: 2, values: { label: 'saved' }, secretFields: { token: { configured: true } } });
    for (const secret of ['stale-secret', null]) {
      const conflict = await request('PUT', url(pluginConfigApi.save), { revision: 1, secretValues: { token: secret } });
      expect(conflict.status).toBe(409);
      expect(apiProblemSchema.parse(conflict.body).code).toBe('PLUGIN_CONFIG_REVISION_CONFLICT');
    }
    const secrets = await database.client.execute({ sql: 'SELECT value_json FROM plugin_config_secrets WHERE plugin_id = ?', args: [pluginId] });
    expect(JSON.parse(String(secrets.rows[0]!.value_json))).toBe('private-original');
    const clear = await request('PUT', url(pluginConfigApi.save), { revision: 2, secretValues: { token: null } });
    expect(clear.status).toBe(200);
    expect(clear.body).toMatchObject({ revision: 3, secretFields: { token: { configured: false } } });
    expect((await request('PUT', url(pluginConfigApi.save), { revision: 3, secretValues: { token: 'reset-secret' } })).status).toBe(200);
    const reset = await request('POST', url(pluginConfigApi.reset));
    expect(reset.status).toBe(200);
    expect(pluginConfigApi.reset.response.parse(reset.body)).toMatchObject({ revision: 5, values: { label: 'default' }, secretFields: { token: { configured: false } } });
    expect((await database.client.execute({ sql: 'SELECT value_json FROM plugin_config_secrets WHERE plugin_id = ?', args: [pluginId] })).rows).toEqual([]);
  });

  it('keeps missing, disabled and packaged-plugin behavior without altering stored declarations', async () => {
    for (const endpoint of Object.values(pluginConfigApi)) {
      const body = endpoint === pluginConfigApi.registerSchema ? schema : endpoint === pluginConfigApi.save ? { revision: 0 } : undefined;
      const missing = await request(endpoint.method.toUpperCase(), url(endpoint, 'missing-plugin'), body);
      expect(missing.status).toBe(404);
      expect(apiProblemSchema.parse(missing.body).code).toBe('PLUGIN_NOT_FOUND');
    }
    expect((await request('PUT', url(pluginConfigApi.registerSchema), schema)).status).toBe(200);
    expect((await request('PATCH', '/v1/plugins/' + pluginId, { enabled: false })).status).toBe(200);
    for (const endpoint of [pluginConfigApi.get, pluginConfigApi.save, pluginConfigApi.reset]) {
      const stopped = await request(endpoint.method.toUpperCase(), url(endpoint), endpoint === pluginConfigApi.save ? { revision: 0 } : undefined);
      expect(stopped.status).toBe(409);
      expect(apiProblemSchema.parse(stopped.body).code).toBe('PLUGIN_DISABLED');
    }
    expect((await request('GET', url(pluginConfigApi.getSchema))).status).toBe(200);
    await database.client.execute({ sql: 'UPDATE plugins SET bundle_generation = ? WHERE id = ?', args: ['immutable-generation', pluginId] });
    const immutable = await request('PUT', url(pluginConfigApi.registerSchema), { ...schema, fields: [] });
    expect(immutable.status).toBe(409);
    expect(apiProblemSchema.parse(immutable.body).code).toBe('PLUGIN_PACKAGE_IMMUTABLE');
    expect(pluginConfigApi.getSchema.response.parse((await request('GET', url(pluginConfigApi.getSchema))).body).fields).toHaveLength(3);
  });

  it('conceals unexpected service failures on all configuration and Page endpoints', async () => {
    const methods = ['getConfigSchema', 'registerConfigSchema', 'getConfig', 'saveConfig', 'resetConfig', 'listPages'] as const;
    for (const method of methods) vi.spyOn(PluginConfigService.prototype, method).mockRejectedValue(new Error('SELECT secret FROM /private/internal.sqlite'));
    for (const endpoint of Object.values(pluginConfigApi)) {
      const body = endpoint === pluginConfigApi.registerSchema ? schema : endpoint === pluginConfigApi.save ? { revision: 0 } : undefined;
      const response = await request(endpoint.method.toUpperCase(), url(endpoint), body);
      expect(response.status).toBe(500);
      expect(response.contentType).toContain('application/problem+json');
      expect(apiProblemSchema.parse(response.body)).toMatchObject({ status: 500, message: 'Internal Server Error', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(response.body)).not.toMatch(/SELECT|secret|internal.sqlite/);
    }
  });

  it('rejects malformed successful service output through the response contract', async () => {
    vi.spyOn(PluginConfigService.prototype, 'getConfigSchema').mockResolvedValue({ schemaVersion: 1, fields: [{ key: 'unsafe', type: 'unknown', label: 'Unsafe' }] });
    vi.spyOn(PluginConfigService.prototype, 'getConfig').mockResolvedValue({ pluginId, revision: -1 } as never);
    vi.spyOn(PluginConfigService.prototype, 'listPages').mockResolvedValue([{ id: 'settings', title: 'Settings', entry: 'pages/settings/index.html', capabilities: ['unsafe'] }]);
    for (const endpoint of [pluginConfigApi.getSchema, pluginConfigApi.get, pluginConfigApi.listPages]) {
      const response = await request('GET', url(endpoint));
      expect(response.status).toBe(500);
      expect(apiProblemSchema.parse(response.body).message).toBe('Internal Server Error');
      expect(JSON.stringify(response.body)).not.toContain('unsafe');
    }
  });
});
