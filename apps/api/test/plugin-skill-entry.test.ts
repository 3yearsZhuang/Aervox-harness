import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { PluginManifest } from '@aervox/contracts';
import { createInMemoryDatabase, initDatabaseSchema } from '@aervox/repositories';
import { buildApp } from './app-fixture.js';

const pluginId = 'entry-example';
type SkillSummary = { name: string; description: string; pluginId?: string };

function packagePayload(
  spec: PluginManifest['spec'],
  resources: Record<string, string | Uint8Array>,
  version = '1.0.0',
) {
  const files: Record<string, Uint8Array> = {
    'plugin.manifest.json': strToU8(JSON.stringify({
      apiVersion: 'aervox.dev/v1', kind: 'PluginManifest',
      metadata: { id: pluginId, displayName: 'Entry example', publisher: 'example', version, description: 'Plugin description' },
      spec,
    })),
  };
  for (const [entry, content] of Object.entries(resources)) files[entry] = typeof content === 'string' ? strToU8(content) : content;
  return { packageBase64: Buffer.from(zipSync(files)).toString('base64') };
}

describe('plugin skill entry resolution through the API', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let root: string;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-skill-entry-'));
    const built = await buildApp({
      db: database.db, client: database.client,
      skillsRoot: path.join(root, 'skills'), pluginsRoot: path.join(root, 'plugins'), builtinPluginsSourceRoot: path.join(root, 'empty'),
    });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function inspectAndInstall(payload: ReturnType<typeof packagePayload>, expected: Array<SkillSummary & { content: string }>) {
    const inspection = await app.inject({ method: 'POST', url: '/v1/plugins/inspect-package', payload });
    expect(inspection.statusCode).toBe(200);
    expect(inspection.json().isValid, inspection.body).toBe(true);
    const summarize = (skills: SkillSummary[]) => skills
      .map(({ name, description }) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(summarize(inspection.json().skills)).toEqual(summarize(expected));

    const installed = await app.inject({ method: 'POST', url: '/v1/plugins/install-package', payload });
    expect(installed.statusCode, installed.body).toBe(201);
    const listed = await app.inject({ method: 'GET', url: '/v1/skills?source=plugin' });
    expect(summarize(listed.json().items.filter((skill: SkillSummary) => skill.pluginId === pluginId))).toEqual(summarize(expected));
    for (const skill of expected) {
      const content = await app.inject({ method: 'GET', url: `/v1/skills/${skill.name}/content` });
      expect(content.statusCode, content.body).toBe(200);
      expect(content.json().content).toBe(skill.content);
    }
  }

  it('resolves named entries before inline content or scanning without creating aliases', async () => {
    const custom = '---\ndescription: Entry description\n---\n# 自定义入口';
    const conventional = '# Conventional entry';
    const aliased = '---\nname: ignored-frontmatter-name\ndescription: Alias description\n---\n# Aliased entry';
    const inline = '# Inline declaration';
    const discovered = '---\ndescription: Discovered description\n---\n# Discovered entry';
    const payload = packagePayload({ skills: [
      { name: 'custom-guide', entry: 'skills/custom-guide/guide.md', content: '# Stale inline content' },
      { name: 'conventional-guide', entry: 'skills/conventional-guide/SKILL.md', description: 'Declared description' },
      { name: 'alias-guide', entry: 'skills/source-name/SKILL.md' },
      { name: 'inline-guide', content: inline, description: 'Inline description' },
    ] }, {
      'skills/custom-guide/guide.md': custom,
      'skills/conventional-guide/SKILL.md': conventional,
      'skills/source-name/SKILL.md': aliased,
      'skills/inline-guide/SKILL.md': '# Ignored scanned content',
      'skills/discovered-guide/skill.md': discovered,
    });
    await inspectAndInstall(payload, [
      { name: 'custom-guide', description: 'Entry description', content: custom },
      { name: 'conventional-guide', description: 'Declared description', content: conventional },
      { name: 'alias-guide', description: 'Alias description', content: aliased },
      { name: 'inline-guide', description: 'Inline description', content: inline },
      { name: 'discovered-guide', description: 'Discovered description', content: discovered },
    ]);
  });

  it.each(['skills/root-guide/guide.md', 'skills/root-guide/SKILL.md'])('resolves spec.skill=%s using the installed plugin identity', async (entry) => {
    const content = '---\nname: different-frontmatter-name\ndescription: Root entry description\n---\n# 指定根技能';
    await inspectAndInstall(packagePayload({ skill: entry }, {
      [entry]: content,
      'SKILL.md': '# Ignored root fallback',
    }), [{ name: pluginId, description: 'Root entry description', content }]);
  });

  it('keeps the conventional root skill identity consistent between inspection and installation', async () => {
    const content = '---\nname: other-name\n---\n# Conventional root';
    await inspectAndInstall(packagePayload({}, { 'SKILL.md': content }), [
      { name: pluginId, description: 'Plugin description', content },
    ]);
  });

  it('serves new entry bytes after an upgrade changes the declared entry path', async () => {
    await inspectAndInstall(packagePayload({ skills: [{ name: 'upgraded-guide', entry: 'skills/upgraded-guide/old.md' }] }, {
      'skills/upgraded-guide/old.md': '# Old content',
    }), [{ name: 'upgraded-guide', description: 'upgraded-guide', content: '# Old content' }]);
    const updated = packagePayload({ skills: [{ name: 'upgraded-guide', entry: 'skills/upgraded-guide/new.md' }] }, {
      'skills/upgraded-guide/new.md': '# Updated 中文 content',
    }, '1.1.0');
    const response = await app.inject({ method: 'POST', url: '/v1/plugins/install-package', payload: { ...updated, overwrite: true } });
    expect(response.statusCode, response.body).toBe(201);
    const content = await app.inject({ method: 'GET', url: '/v1/skills/upgraded-guide/content' });
    expect(content.statusCode).toBe(200);
    expect(content.json().content).toBe('# Updated 中文 content');
  });

  it.each(['named', 'root', 'discovered'])('rejects invalid UTF-8 in a %s skill before installation', async (source) => {
    const entry = 'skills/invalid-guide/SKILL.md';
    const spec: PluginManifest['spec'] = source === 'named'
      ? { skills: [{ name: 'invalid-guide', entry }] }
      : source === 'root' ? { skill: entry } : {};
    const payload = packagePayload(spec, { [entry]: Uint8Array.from([0xc3, 0x28]) });
    const inspection = await app.inject({ method: 'POST', url: '/v1/plugins/inspect-package', payload });
    expect(inspection.statusCode).toBe(200);
    expect(inspection.json().isValid).toBe(false);
    expect(inspection.json().issues).toContain(`Invalid UTF-8 skill entry: ${entry}`);
    const installed = await app.inject({ method: 'POST', url: '/v1/plugins/install-package', payload });
    expect(installed.statusCode).toBe(400);
    const listed = await app.inject({ method: 'GET', url: '/v1/skills?source=plugin' });
    expect(listed.json().items.filter((skill: SkillSummary) => skill.pluginId === pluginId)).toEqual([]);
    expect((await fs.readdir(path.join(root, 'plugins')).catch(() => []))).not.toContain(pluginId);
  });

  it('documents the actual immutable-package errors exposed by the mutation endpoints', async () => {
    const install = await app.inject({ method: 'POST', url: '/v1/plugins/install-package', payload: packagePayload({}, {}) });
    expect(install.statusCode, install.body).toBe(201);
    const contract = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    const operations = [
      { method: 'PUT' as const, suffix: '/config/schema', payload: { apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1, fields: [] } },
      { method: 'POST' as const, suffix: '/pages', payload: { id: 'main', title: 'Main', entry: 'pages/main/index.html', capabilities: [] } },
      { method: 'POST' as const, suffix: '/pages/main/assets', payload: { files: [{ path: 'index.html', contentBase64: Buffer.from('page').toString('base64') }] } },
    ];
    for (const operation of operations) {
      const response = await app.inject({ method: operation.method, url: `/v1/plugins/${pluginId}${operation.suffix}`, payload: operation.payload });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('PLUGIN_PACKAGE_IMMUTABLE');
      const contractPath = `/v1/plugins/{pluginId}${operation.suffix.replace('/main/', '/{pageId}/')}`;
      const documented = contract.paths[contractPath][operation.method.toLowerCase()].responses[response.statusCode];
      expect(documented.description).toContain(response.json().code);
      expect(documented.content['application/problem+json']).toBeDefined();
    }
  });
});
