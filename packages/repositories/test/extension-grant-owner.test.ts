import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryDatabase, initDatabaseSchema, SqliteExtensionRepository } from '../src/index.js';

const local = { workspaceId: 'local', subjectUserId: 'local' };
describe('plugin grant revocation owner predicate', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repository: SqliteExtensionRepository;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    repository = new SqliteExtensionRepository(database.db);
    for (const id of ['owner', 'other']) await repository.createPlugin({ id, publisher: 'fixture', version: '1', checksum: 'fixture' });
    await repository.grantPlugin(local, { id: 'grant', pluginId: 'owner', permission: 'memory:read', scope: 'self' });
  });
  afterEach(async () => { await database.cleanup(); });

  it('rejects the wrong plugin in the UPDATE predicate without changing grant timestamps', async () => {
    const before = await database.client.execute("SELECT * FROM plugin_grants WHERE id = 'grant'");
    expect(await repository.revokePluginGrant(local, 'grant', 'other')).toBeNull();
    expect((await database.client.execute("SELECT * FROM plugin_grants WHERE id = 'grant'")).rows).toEqual(before.rows);
    expect(await repository.hasPluginPermission(local, 'owner', 'memory:read')).toBe(true);
    expect((await repository.revokePluginGrant(local, 'grant', 'owner'))?.pluginId).toBe('owner');
    expect(await repository.hasPluginPermission(local, 'owner', 'memory:read')).toBe(false);
  });

  it('keeps trusted existing callers without an explicit owner compatible', async () => {
    expect((await repository.revokePluginGrant(local, 'grant'))?.revokedAt).toBeTruthy();
    expect(await repository.revokePluginGrant(local, 'missing', 'owner')).toBeNull();
  });
});
