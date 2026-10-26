import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiEndpointPath, apiProblemSchema, PLUGIN_SENSOR_PERMISSION, pluginsApi } from '@aervox/contracts';
import { createInMemoryDatabase } from '@aervox/repositories';
import { PluginService } from '@aervox/host-runtime-test/modules/ecosystem/plugins/service';
import { buildApp } from './app-fixture.js';

const token = 'plugin-management-contract-token';
const endpointPath = (endpoint: { path: string }, pluginId = 'owner', grantId = 'grant') =>
  apiEndpointPath(endpoint, { pluginId, grantId, permission: PLUGIN_SENSOR_PERMISSION });

describe('ITER-064 plugin management HTTP contracts', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let base: string;
  async function request(method: string, path: string, body?: unknown, auth: string | null = token) {
    const response = await fetch(base + path, { method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text, contentType: response.headers.get('content-type') };
  }
  async function grant(permission = PLUGIN_SENSOR_PERMISSION, scope = 'system.idle') {
    const response = await request('POST', endpointPath(pluginsApi.grant), { permission, scope });
    expect(response.status).toBe(201);
    return pluginsApi.grant.response.parse(response.body);
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    built = await buildApp({ db: database.db, client: database.client, auth: { mode: 'token', token } });
    base = await built.app.listen({ host: '127.0.0.1', port: 0 });
    for (const id of ['owner', 'other']) expect((await request('POST', '/v1/plugins', { id, publisher: 'fixture', version: '1' })).status).toBe(201);
  });
  afterEach(async () => { vi.restoreAllMocks(); await built.app.close(); await database.cleanup(); });

  it('authenticates all seven operations before validating inputs or changing rows', async () => {
    const before = await database.client.execute('SELECT * FROM plugins ORDER BY id');
    for (const endpoint of Object.values(pluginsApi)) {
      for (const auth of [null, 'wrong-token']) {
        const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), undefined, auth);
        expect(response.status).toBe(401);
        expect(apiProblemSchema.parse(response.body)).toMatchObject({ status: 401, code: 'AUTH_UNAUTHORIZED' });
      }
    }
    expect((await database.client.execute('SELECT * FROM plugins ORDER BY id')).rows).toEqual(before.rows);
    expect((await database.client.execute('SELECT id FROM plugin_grants')).rows).toHaveLength(0);
  });

  it('rejects missing or malformed write bodies and duplicate query values before mutation', async () => {
    for (const body of [undefined, null, [], {}, { enabled: 'false' }, { enabled: 0 }]) {
      const response = await request('PATCH', endpointPath(pluginsApi.setEnabled), body);
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body).error).toBe('enabled is required');
    }
    for (const body of [undefined, null, [], {}, { permission: '', scope: 'self' }, { permission: 'memory:read', scope: '' },
      { permission: 1, scope: 'self' }, { permission: 'memory:read', scope: ['self'] }]) {
      const response = await request('POST', endpointPath(pluginsApi.grant), body);
      expect(response.status).toBe(400);
      expect(apiProblemSchema.parse(response.body).error).toBe('permission/scope are required');
    }
    expect((await request('GET', endpointPath(pluginsApi.permission) + '?scope=one&scope=two')).status).toBe(400);
    expect((await database.client.execute("SELECT enabled FROM plugins WHERE id IN ('owner', 'other')")).rows.map(row => row.enabled)).toEqual([1, 1]);
    expect((await database.client.execute('SELECT id FROM plugin_grants')).rows).toHaveLength(0);
    // Legacy non-empty strings retain their exact whitespace; no trim is introduced.
    expect(await grant(' ', ' ')).toMatchObject({ permission: ' ', scope: ' ' });
  });

  it('preserves plugin row flags, nullable metadata, lifecycle changes, not-found and empty 204 semantics', async () => {
    const initial = await request('GET', '/v1/plugins');
    expect(initial.status).toBe(200);
    const owner = pluginsApi.list.response.parse(initial.body).items.find(item => item.id === 'owner')!;
    expect(owner).toMatchObject({ enabled: 1, availability: 'available', bundleGeneration: null, signature: null, configSchemaJson: null });
    expect(typeof owner.lifecycleGeneration).toBe('string');
    const stopped = await request('PATCH', endpointPath(pluginsApi.setEnabled), { enabled: false });
    expect(stopped.status).toBe(200);
    expect(pluginsApi.setEnabled.response.parse(stopped.body)).toMatchObject({ enabled: 0, availability: 'available' });
    expect(stopped.body.lifecycleGeneration).not.toBe(owner.lifecycleGeneration);
    const restarted = await request('PATCH', endpointPath(pluginsApi.setEnabled), { enabled: true });
    expect(restarted.body.lifecycleGeneration).not.toBe(stopped.body.lifecycleGeneration);
    expect((await request('PATCH', endpointPath(pluginsApi.setEnabled, 'missing'), { enabled: true })).status).toBe(404);
    const removed = await request('DELETE', endpointPath(pluginsApi.delete, 'other'));
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await request('DELETE', endpointPath(pluginsApi.delete, 'other'))).status).toBe(404);
  });

  it('preserves sensor-only active listing, scoped queries, empty scope and the revoked row response', async () => {
    await grant('memory:read', 'self');
    const first = await grant();
    const second = await grant(PLUGIN_SENSOR_PERMISSION, 'system.window');
    const listed = await request('GET', endpointPath(pluginsApi.listSensorGrants));
    expect(pluginsApi.listSensorGrants.response.parse(listed.body).items.map(row => row.id).sort()).toEqual([first.id, second.id].sort());
    const path = endpointPath(pluginsApi.permission);
    for (const [query, scope, granted] of [['', null, true], ['?scope=', '', true], ['?scope=system.idle', 'system.idle', true], ['?scope=missing', 'missing', false]] as const) {
      const response = await request('GET', path + query);
      expect(response.status).toBe(200);
      expect(pluginsApi.permission.response.parse(response.body)).toEqual({ pluginId: 'owner', permission: PLUGIN_SENSOR_PERMISSION, scope, granted });
    }
    const revoked = await request('DELETE', endpointPath(pluginsApi.revokeGrant, 'owner', first.id));
    expect(revoked.status).toBe(200);
    expect(pluginsApi.revokeGrant.response.parse(revoked.body)).toMatchObject({ id: first.id, revokedAt: expect.any(String) });
    expect(pluginsApi.listSensorGrants.response.parse((await request('GET', endpointPath(pluginsApi.listSensorGrants))).body).items.map(row => row.id)).toEqual([second.id]);
    expect((await request('DELETE', endpointPath(pluginsApi.revokeGrant, 'owner', 'missing'))).status).toBe(404);
  });

  it('does not revoke another plugin grant through an unrelated plugin path', async () => {
    const created = await grant('memory:read', 'self');
    const before = await database.client.execute({ sql: 'SELECT * FROM plugin_grants WHERE id = ?', args: [created.id] });
    const wrongOwner = await request('DELETE', endpointPath(pluginsApi.revokeGrant, 'other', created.id));
    expect(wrongOwner.status).toBe(404);
    expect((await database.client.execute({ sql: 'SELECT * FROM plugin_grants WHERE id = ?', args: [created.id] })).rows).toEqual(before.rows);
    expect((await request('GET', '/v1/plugins/owner/permissions/memory%3Aread')).body.granted).toBe(true);
    expect((await request('DELETE', endpointPath(pluginsApi.revokeGrant, 'owner', created.id))).status).toBe(200);
  });

  it('conceals service failures and rejects malformed successful rows at the shared boundary', async () => {
    const cases = [
      [pluginsApi.list, 'listPlugins', undefined],
      [pluginsApi.setEnabled, 'setEnabled', { enabled: true }],
      [pluginsApi.delete, 'uninstallPlugin', undefined],
      [pluginsApi.grant, 'grant', { permission: 'memory:read', scope: 'self' }],
      [pluginsApi.listSensorGrants, 'listSensorGrants', undefined],
      [pluginsApi.revokeGrant, 'revoke', undefined],
      [pluginsApi.permission, 'hasPermission', undefined],
    ] as const;
    for (const [endpoint, method, body] of cases) {
      const spy = vi.spyOn(PluginService.prototype, method).mockRejectedValue(new Error('SELECT secret FROM /private/internal.sqlite'));
      const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), body);
      expect(response.status).toBe(500);
      expect(apiProblemSchema.parse(response.body).code).toBe('INTERNAL_ERROR');
      expect(response.text).not.toMatch(/SELECT|private|internal.sqlite/);
      spy.mockRestore();
    }
    for (const [endpoint, method, body] of cases.filter(([endpoint]) => endpoint !== pluginsApi.delete)) {
      const spy = vi.spyOn(PluginService.prototype, method).mockResolvedValue({ malformed: true } as never);
      const response = await request(endpoint.method.toUpperCase(), endpointPath(endpoint), body);
      expect(response.status).toBe(500);
      expect(apiProblemSchema.parse(response.body).code).toBe('INTERNAL_ERROR');
      spy.mockRestore();
    }
  });
});
