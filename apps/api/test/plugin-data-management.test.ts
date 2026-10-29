import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInMemoryDatabase, SqliteExtensionRepository, SqlitePluginConfigRepository } from '@aervox/repositories';
import { pluginDataExportSchema } from '@aervox/contracts';
import { buildApp } from './app-fixture.js';

describe('host-owned data management without plugin code', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let pluginsRoot: string;
  const id = 'data-owner';
  const fields = [
    { key: 'note', type: 'string', label: 'Note', default: 'not persisted' },
    { key: 'token', type: 'secret', label: 'Token' },
  ];
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    pluginsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-data-management-'));
    app = (await buildApp({ db: database.db, client: database.client, pluginsRoot })).app;
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/v1/plugins', payload: { id, publisher: 'test', version: '1.0.0' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'PUT', url: `/v1/plugins/${id}/config/schema`, payload: {
      apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1, fields,
    } })).statusCode).toBe(200);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await database.cleanup();
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });
  async function seed() {
    expect((await app.inject({ method: 'PUT', url: `/v1/plugins/${id}/config`, payload: {
      revision: 0, values: { note: 'saved schedule' }, secretValues: { token: 'credential' },
    } })).statusCode).toBe(200);
    await database.client.execute({ sql: 'UPDATE plugin_configs SET values_json = ?, orphaned_values_json = ? WHERE plugin_id = ?',
      args: [JSON.stringify({ note: 'saved schedule', token: 'legacy credential', retired: 'unknown sensitive value' }), JSON.stringify({ oldToken: 'orphaned credential' }), id] });
  }

  it.each(['disabled', 'missing', 'invalid', 'unreadable'] as const)('exports ordinary persisted values while %s, without enabling writes or Pages; uninstall clears data', async status => {
    await seed();
    const repo = new SqliteExtensionRepository(database.db);
    if (status === 'disabled') await repo.setPluginEnabled(id, false);
    else await repo.setPluginAvailability(id, status);
    const before = await repo.getPlugin(id);
    const response = await app.inject(`/v1/plugins/${id}/data-export`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(pluginDataExportSchema.parse(response.json())).toEqual({
      format: 'aervox-plugin-data/v1', pluginId: id, revision: 1, schemaVersion: 1, values: { note: 'saved schedule' },
    });
    expect((await repo.getPlugin(id))!.lifecycleGeneration).toBe(before!.lifecycleGeneration);
    expect((await repo.getPlugin(id))!.enabled).toBe(before!.enabled);
    const query = `expectedLifecycleGeneration=${encodeURIComponent(before!.lifecycleGeneration!)}`;
    expect((await app.inject(`/v1/plugins/${id}/pages?${query}`)).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: `/v1/plugins/${id}/config`, payload: { revision: 1, values: { note: 'forbidden' } } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/v1/plugins/${id}` })).statusCode).toBe(204);
    for (const table of ['plugin_configs', 'plugin_config_secrets']) {
      expect((await database.client.execute({ sql: `SELECT count(*) AS count FROM ${table} WHERE plugin_id = ?`, args: [id] })).rows[0]!.count).toBe(0);
    }
    expect((await app.inject(`/v1/plugins/${id}/data-export`)).statusCode).toBe(404);
  });

  it('does not export defaults as if they were saved data', async () => {
    const response = await app.inject(`/v1/plugins/${id}/data-export`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ revision: 0, values: {} });
  });

  it.each([true, false])('intersects ordinary fields across a schema change (initially secret=%s)', async initiallySecret => {
    await seed();
    const repo = new SqliteExtensionRepository(database.db);
    const schema = (secret: boolean) => fields.map(field => field.key === 'token' ? { ...field, type: secret ? 'secret' : 'string' } : field);
    await repo.setPluginConfigSchema(id, schema(initiallySecret), 1);
    const original = SqlitePluginConfigRepository.prototype.getConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, 'getConfig').mockImplementationOnce(async function (...args) {
      const snapshot = await original.apply(this, args);
      await repo.setPluginConfigSchema(id, schema(!initiallySecret), 1);
      return snapshot;
    });
    const response = await app.inject(`/v1/plugins/${id}/data-export`);
    expect(response.statusCode).toBe(200);
    expect(response.json().values).toEqual({ note: 'saved schedule' });
  });

  it('withholds an in-flight export after uninstall', async () => {
    await seed();
    const original = SqlitePluginConfigRepository.prototype.getConfig;
    vi.spyOn(SqlitePluginConfigRepository.prototype, 'getConfig').mockImplementationOnce(async function (...args) {
      const snapshot = await original.apply(this, args);
      expect((await app.inject({ method: 'DELETE', url: `/v1/plugins/${id}` })).statusCode).toBe(204);
      return snapshot;
    });
    const response = await app.inject(`/v1/plugins/${id}/data-export`);
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('saved schedule');
  });
});
