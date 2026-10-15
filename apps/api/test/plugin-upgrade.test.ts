import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { createInMemoryDatabase, initDatabaseSchema, SqliteExtensionRepository, SqlitePluginPageRepository } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';
import { PluginBundleStore } from '@aervox/host-runtime/modules/ecosystem/plugins/bundle-store';

const id = 'upgrade-example';
const local = {workspaceId: 'local', subjectUserId: 'local'};
function bundle(version: string, options: {type?: string; extra?: boolean} = {}) {
  const manifest = {apiVersion: 'aervox.dev/v1', kind: 'PluginManifest', metadata: {
    id, displayName: 'Upgrade example', publisher: 'example', version,
  }, spec: {config: {schemaVersion: 1, entry: 'config.schema.json'},
    pages: [{id: 'main', title: 'Main', entry: 'pages/main/index.html', capabilities: ['config.read']}],
    skills: [{name: 'upgrade-skill', content: `# Version ${version}`}],
    tools: [{name: 'upgrade_tool', description: 'Example', safetyLevel: 'read_only'}],
  }};
  const fields = [{key: 'label', type: options.type ?? 'string', label: 'Label', default: options.type === 'integer' ? 1 : 'default'},
    {key: 'token', type: 'secret', label: 'Token'},
    ...(options.extra ? [{key: 'extra', type: 'string', label: 'Extra', default: 'new default'}] : [])];
  return Buffer.from(zipSync({
    'plugin.manifest.json': strToU8(JSON.stringify(manifest)),
    'config.schema.json': strToU8(JSON.stringify({apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1, fields})),
    'pages/main/index.html': strToU8(`<html>${version}</html>`),
  }, {mtime: new Date('1980-01-01T00:00:00Z')}));
}

describe('plugin bundle atomic activation', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let root: string;
  let extension: SqliteExtensionRepository;
  async function install(version: string, overwrite = false, options = {}) {
    return app.inject({method: 'POST', url: '/v1/plugins/install-package', payload: {
      packageBase64: bundle(version, options).toString('base64'), overwrite,
    }});
  }
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-upgrade-'));
    const built = await buildApp({db: database.db, client: database.client,
      skillsRoot: path.join(root, 'skills'), pluginsRoot: path.join(root, 'plugins'), builtinPluginsSourceRoot: path.join(root, 'empty')});
    app = built.app;
    await app.ready();
    extension = new SqliteExtensionRepository(database.db);
    expect((await install('1.0.0')).statusCode).toBe(201);
    const config = await app.inject({method: 'PUT', url: `/v1/plugins/${id}/config`, payload: {
      revision: 0, values: {label: 'saved'}, secretValues: {token: 'retained-secret'},
    }});
    expect(config.statusCode).toBe(200);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await database.cleanup();
    await fs.rm(root, {recursive: true, force: true});
  });
  async function assertOldVersion() {
    expect((await extension.getPlugin(id))?.version).toBe('1.0.0');
    const page = await app.inject({method: 'GET', url: `/v1/plugins/${id}/pages/main/assets/index.html`});
    expect(page.body).toContain('1.0.0');
    const config = (await app.inject({method: 'GET', url: `/v1/plugins/${id}/config`})).json();
    expect(config.values.label).toBe('saved');
    expect(config.secretFields.token.configured).toBe(true);
  }
  it('keeps configuration, Secrets, revoked grants and disabled intent across an upgrade', async () => {
    await extension.grantPlugin(local, {id: 'grant-example', pluginId: id, permission: 'example.read', scope: 'local'});
    await extension.revokePluginGrant(local, 'grant-example');
    await app.inject({method: 'PATCH', url: `/v1/plugins/${id}`, payload: {enabled: false}});
    expect((await install('1.1.0', true, {extra: true})).statusCode).toBe(201);
    expect((await extension.getPlugin(id))?.enabled).toBe(0);
    expect(await extension.hasPluginPermission(local, id, 'example.read')).toBe(false);
    const grants = await database.client.execute("SELECT revoked_at FROM plugin_grants WHERE id = 'grant-example'");
    expect(grants.rows[0]?.revoked_at).toBeTruthy();
    await app.inject({method: 'PATCH', url: `/v1/plugins/${id}`, payload: {enabled: true}});
    const config = (await app.inject({method: 'GET', url: `/v1/plugins/${id}/config`})).json();
    expect(config.values).toMatchObject({label: 'saved', extra: 'new default'});
    expect(config.secretFields.token.configured).toBe(true);
    expect(config.revision).toBe(2);
    expect((await app.inject({method: 'GET', url: `/v1/plugins/${id}/pages/main/assets/index.html`})).body).toContain('1.1.0');
    expect((await fs.readdir(path.join(root, 'plugins', id, 'releases'))).length).toBe(2);
  });
  it('retains the complete old version when a registration fails inside the transaction', async () => {
    const generation = (await extension.getPlugin(id))?.bundleGeneration;
    vi.spyOn(SqlitePluginPageRepository.prototype, 'upsertPage').mockRejectedValueOnce(new Error('injected registration failure'));
    expect((await install('1.1.0', true)).statusCode).toBeGreaterThanOrEqual(400);
    await assertOldVersion();
    expect((await extension.getPlugin(id))?.bundleGeneration).toBe(generation);
    expect((await fs.readdir(path.join(root, 'plugins', id, 'releases'))).length).toBe(1);
  });
  it('retains the old version on staging failure and rejects implicit type migrations', async () => {
    const stage = vi.spyOn(PluginBundleStore.prototype, 'stageBundle').mockRejectedValueOnce(new Error('disk full'));
    expect((await install('1.1.0', true)).statusCode).toBeGreaterThanOrEqual(400);
    stage.mockRestore();
    expect((await install('2.0.0', true, {type: 'integer'})).statusCode).toBeGreaterThanOrEqual(400);
    await assertOldVersion();
  });
  it('upgrades a legacy layout repeatedly without deleting unregistered legacy files', async () => {
    const plugin = (await extension.getPlugin(id))!;
    const legacySkills = path.join(root, 'skills', id, 'upgrade-skill');
    await fs.mkdir(legacySkills, {recursive: true});
    await fs.writeFile(path.join(legacySkills, 'SKILL.md'), '# Legacy content');
    await fs.cp(path.join(root, 'plugins', id, 'releases', plugin.bundleGeneration!, 'content', 'pages'),
      path.join(root, 'plugins', id, 'pages'), {recursive: true});
    await database.client.execute({sql: 'UPDATE plugins SET bundle_generation = NULL WHERE id = ?', args: [id]});
    await database.client.execute({sql: 'UPDATE skill_registrations SET content_path = ? WHERE plugin_id = ?', args: [path.join(legacySkills, 'SKILL.md'), id]});
    expect((await install('1.1.0', true)).statusCode).toBe(201);
    expect((await install('1.2.0', true)).statusCode).toBe(201);
    expect((await app.inject({method: 'DELETE', url: `/v1/plugins/${id}`})).statusCode).toBe(204);
    expect(await fs.readFile(path.join(legacySkills, 'SKILL.md'), 'utf8')).toBe('# Legacy content');
  });
  it('does not replace an installed release with older builtin metadata on restart', async () => {
    expect((await install('1.1.0', true)).statusCode).toBe(201);
    await app.close();
    const builtin = path.join(root, 'builtin', id);
    await fs.mkdir(builtin, {recursive: true});
    await fs.writeFile(path.join(builtin, 'plugin.manifest.json'), JSON.stringify({
      apiVersion: 'aervox.dev/v1', kind: 'PluginManifest', metadata: {id, displayName: 'Older builtin', publisher: 'example', version: '0.1.0'}, spec: {},
    }));
    const built = await buildApp({db: database.db, client: database.client, skillsRoot: path.join(root, 'skills'),
      pluginsRoot: path.join(root, 'plugins'), builtinPluginsSourceRoot: path.join(root, 'builtin')});
    app = built.app;
    await app.ready();
    expect((await extension.getPlugin(id))?.version).toBe('1.1.0');
    expect((await app.inject({method: 'GET', url: `/v1/plugins/${id}/pages/main/assets/index.html`})).body).toContain('1.1.0');
  });
  it('denies an unregistered page even when a resource exists on disk', async () => {
    const generation = (await extension.getPlugin(id))!.bundleGeneration!;
    const ghost = path.join(root, 'plugins', id, 'releases', generation, 'content', 'pages', 'ghost');
    await fs.mkdir(ghost, {recursive: true});
    await fs.writeFile(path.join(ghost, 'payload.js'), 'unregistered');
    expect((await app.inject({method: 'GET', url: `/v1/plugins/${id}/pages/ghost/assets/payload.js`})).statusCode).toBe(404);
  });
  it('rejects in-place declaration and resource edits for packaged releases', async () => {
    const directInstall = await app.inject({method: 'POST', url: '/v1/plugins', payload: {
      id, publisher: 'changed', version: '99.0.0', skills: [{name: 'upgrade-skill', content: 'changed'}],
    }});
    expect(directInstall.statusCode).toBe(409);
    expect(directInstall.json().code).toBe('PLUGIN_PACKAGE_IMMUTABLE');
    const schema = await app.inject({method: 'PUT', url: `/v1/plugins/${id}/config/schema`, payload: {
      apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1, fields: [],
    }});
    expect(schema.statusCode).toBe(409);
    const page = await app.inject({method: 'POST', url: `/v1/plugins/${id}/pages`, payload: {
      id: 'main', title: 'Changed', entry: 'pages/main/index.html', capabilities: [],
    }});
    expect(page.statusCode).toBe(409);
    const assets = await app.inject({method: 'POST', url: `/v1/plugins/${id}/pages/main/assets`, payload: {
      files: [{path: 'index.html', contentBase64: Buffer.from('changed').toString('base64')}],
    }});
    expect(assets.statusCode).toBe(409);
    await assertOldVersion();
  });
  it('preserves unknown files in the plugin resource directory on uninstall', async () => {
    const note = path.join(root, 'plugins', id, 'my-backup.txt');
    await fs.writeFile(note, 'keep this backup');
    const unknownRelease = path.join(root, 'plugins', id, 'releases', '22222222-2222-4222-8222-222222222222');
    await fs.mkdir(unknownRelease);
    await fs.writeFile(path.join(unknownRelease, 'notes.txt'), 'unregistered directory');
    expect((await app.inject({method: 'DELETE', url: `/v1/plugins/${id}`})).statusCode).toBe(204);
    expect(await fs.readFile(note, 'utf8')).toBe('keep this backup');
    expect(await fs.readFile(path.join(unknownRelease, 'notes.txt'), 'utf8')).toBe('unregistered directory');
  });
  it('rejects a schema revision change during preparation', async () => {
    const original = PluginBundleStore.prototype.stageBundle;
    vi.spyOn(PluginBundleStore.prototype, 'stageBundle').mockImplementationOnce(async function (...args) {
      const staged = await original.apply(this, args);
      const fields = (await extension.getPlugin(id))!.configSchemaJson as unknown[];
      await extension.setPluginConfigSchema(id, [...fields, {key: 'later', type: 'string', label: 'Later'}], 1);
      return staged;
    });
    expect((await install('1.1.0', true)).statusCode).toBe(409);
    expect((await extension.getPlugin(id))?.version).toBe('1.0.0');
    expect((await extension.getPlugin(id))?.configSchemaJson).toEqual(expect.arrayContaining([expect.objectContaining({key: 'later'})]));
  });
  it('exports the exact installed declaration including original metadata', async () => {
    const result = await app.inject({method: 'GET', url: `/v1/plugins/${id}/export`});
    expect(result.statusCode).toBe(200);
    expect(Buffer.from(result.json().packageBase64, 'base64')).toEqual(bundle('1.0.0'));
  });
  it('rejects a concurrent configuration change without rolling it back', async () => {
    const original = PluginBundleStore.prototype.stageBundle;
    vi.spyOn(PluginBundleStore.prototype, 'stageBundle').mockImplementationOnce(async function (...args) {
      const staged = await original.apply(this, args);
      const saved = await app.inject({method: 'PUT', url: `/v1/plugins/${id}/config`, payload: {
        revision: 1, values: {label: 'concurrent'}, secretValues: {token: 'new-secret'},
      }});
      expect(saved.statusCode).toBe(200);
      return staged;
    });
    expect((await install('1.1.0', true)).statusCode).toBe(409);
    expect((await extension.getPlugin(id))?.version).toBe('1.0.0');
    const config = (await app.inject({method: 'GET', url: `/v1/plugins/${id}/config`})).json();
    expect(config.values.label).toBe('concurrent');
    expect(config.revision).toBe(2);
  });
});
