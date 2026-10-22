import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { apiProblemSchema, skillsApi } from '@aervox/contracts';
import { createInMemoryDatabase, SqliteSkillRegistryRepository } from '@aervox/repositories';
import { SkillInstallInputError, SkillManager } from '@aervox/host-runtime-test/modules/ecosystem/skills/skill-manager';
import * as archiveWorker from '@aervox/host-runtime-test/shared/archive-worker';
import { buildApp } from './app-fixture.js';

describe('ITER-064 basic skill HTTP contracts', () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let skillsRoot: string;
  const token = 'skills-contract-test-token';
  const headers = { authorization: 'Bearer ' + token };
  const archive = (description = 'Skill description') => Buffer.from(zipSync({
    'SKILL.md': strToU8(`---\nname: notes\ndescription: ${description}\n---\n# Notes`),
  })).toString('base64');

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'aervox-skills-contract-'));
    const builtinPluginsSourceRoot = path.join(skillsRoot, 'builtin');
    await mkdir(builtinPluginsSourceRoot);
    built = await buildApp({ db: database.db, client: database.client, skillsRoot, builtinPluginsSourceRoot, auth: { mode: 'token', token } });
    await built.app.ready();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await built.app.close();
    await database.cleanup();
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it('requires the host token on every basic endpoint before any request or filesystem work', async () => {
    const install = vi.spyOn(SkillManager.prototype, 'installFromZip');
    for (const endpoint of Object.values(skillsApi)) {
      for (const authorization of [undefined, 'Bearer invalid']) {
        const response = await built.app.inject({
          method: endpoint.method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'DELETE',
          url: endpoint.path.replace('{skillName}', 'missing'),
          headers: authorization ? { authorization } : {},
        });
        expect(response.statusCode).toBe(401);
        expect(apiProblemSchema.parse(response.json())).toMatchObject({ code: 'AUTH_UNAUTHORIZED', status: 401 });
      }
    }
    expect(install).not.toHaveBeenCalled();
    expect((await new SqliteSkillRegistryRepository(database.db).listSkills()).length).toBe(0);
    expect(await readdir(skillsRoot)).toEqual(['builtin']);
  });

  it('rejects malformed inputs and repeated query values before reaching any mutation', async () => {
    const install = vi.spyOn(SkillManager.prototype, 'installFromZip');
    const setActive = vi.spyOn(SkillManager.prototype, 'setActive');
    for (const payload of [undefined, {}, { zipBase64: 42 }, { zipBase64: 'zip', name: {} }, { zipBase64: 'zip', overwrite: 'false' }, { zipBase64: 'zip', overwrite: 1 }]) {
      const response = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(400);
      expect(apiProblemSchema.parse(response.json())).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    }
    for (const payload of [undefined, {}, { active: 'false' }, { active: 1 }]) {
      const response = await built.app.inject({ method: 'PATCH', url: '/v1/skills/notes', headers, ...(payload === undefined ? {} : { payload }) });
      expect(response.statusCode).toBe(400);
      expect(apiProblemSchema.parse(response.json()).error).toBe('active is required');
    }
    for (const query of ['activeOnly=true&activeOnly=false', 'source=local&source=plugin']) {
      const response = await built.app.inject({ method: 'GET', url: '/v1/skills?' + query, headers });
      expect(response.statusCode).toBe(400);
    }
    expect(install).not.toHaveBeenCalled();
    expect(setActive).not.toHaveBeenCalled();
    expect(await readdir(skillsRoot)).toEqual(['builtin']);
  });

  it('keeps installed bytes and registration intact when overwrite is a non-boolean truthy value', async () => {
    const input = { name: 'notes', zipBase64: archive() };
    const installed = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: input });
    const row = installed.json().installed[0];
    const original = await readFile(row.contentPath, 'utf8');
    const replacement = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { ...input, zipBase64: archive('replacement'), overwrite: 'false' } });
    expect(replacement.statusCode).toBe(400);
    expect(await readFile(row.contentPath, 'utf8')).toBe(original);
    expect(await new SqliteSkillRegistryRepository(database.db).getSkill('notes')).toEqual(row);
  });

  it.each([['SKILL.md', false], ['SKILL.md', true], ['skill.md', false], ['skill.md', true]] as const)(
    'rejects file/directory collisions before overwriting an existing skill (ancestor: %s, child first: %s)', async (ancestor, childFirst) => {
      const installed = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { name: 'notes', zipBase64: archive() } });
      const row = installed.json().installed[0];
      const original = await readFile(row.contentPath, 'utf8');
      const entries: Array<[string, Uint8Array]> = [
        ['SKILL.md', strToU8('replacement')], [`${ancestor}/extra`, strToU8('collision')],
      ];
      const zipBase64 = Buffer.from(zipSync(Object.fromEntries(childFirst ? entries.reverse() : entries))).toString('base64');
      const response = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { name: 'notes', overwrite: true, zipBase64 } });
      const content = await readFile(row.contentPath, 'utf8').catch((error: NodeJS.ErrnoException) => error.code);
      expect({ status: response.statusCode, content, row: await new SqliteSkillRegistryRepository(database.db).getSkill('notes') })
        .toEqual({ status: 400, content: original, row });
      expect(apiProblemSchema.parse(response.json()).error).toBe('Invalid skill archive');
    });

  it('serves the legacy workflow over real HTTP with registry fields, content description, normalization and empty deletion', async () => {
    const base = await built.app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (method: string, url: string, input?: unknown) => {
      const response = await fetch(base + url, {
        method, headers: { ...headers, ...(input === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
    };
    expect(skillsApi.list.response.parse((await request('GET', '/v1/skills')).body)).toEqual({ items: [] });
    const input = { name: ' review notes ', zipBase64: archive() };
    const installed = await request('POST', '/v1/skills', input);
    expect(installed.status).toBe(201);
    const row = skillsApi.install.response.parse(installed.body).installed[0]!;
    expect(row).toMatchObject({ id: 'review_notes', name: 'review_notes', active: 1, readonly: 0, pluginId: null, lastUsedAt: null, source: 'local' });
    expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(skillsApi.get.response.parse((await request('GET', '/v1/skills/review_notes')).body)).toEqual(row);
    expect(skillsApi.content.response.parse((await request('GET', '/v1/skills/review_notes/content')).body)).toMatchObject({ name: 'review_notes', description: 'Skill description', content: expect.stringContaining('# Notes') });
    expect(skillsApi.prompt.response.parse((await request('GET', '/v1/skills/prompt')).body).prompt).toContain('review_notes');
    expect((await request('POST', '/v1/skills', input)).status).toBe(409);
    const replaced = await request('POST', '/v1/skills', { ...input, overwrite: true, zipBase64: archive('updated') });
    expect(skillsApi.install.response.parse(replaced.body).installed[0]?.description).toBe('updated');
    const disabled = await request('PATCH', '/v1/skills/review_notes', { active: false });
    expect(skillsApi.setActive.response.parse(disabled.body).active).toBe(0);
    expect(skillsApi.list.response.parse((await request('GET', '/v1/skills?activeOnly=true')).body)).toEqual({ items: [] });
    expect(skillsApi.list.response.parse((await request('GET', '/v1/skills?activeOnly=1&source=local')).body).items).toHaveLength(1);
    expect(skillsApi.list.response.parse((await request('GET', '/v1/skills?source=plugin')).body)).toEqual({ items: [] });
    const deleted = await request('DELETE', '/v1/skills/review_notes');
    expect(deleted).toEqual({ status: 204, body: undefined, text: '' });
    expect((await request('GET', '/v1/skills/review_notes')).status).toBe(404);
    expect((await request('GET', '/v1/skills/review_notes/content')).status).toBe(404);
    expect((await request('PATCH', '/v1/skills/review_notes', { active: true })).status).toBe(404);
    expect((await request('DELETE', '/v1/skills/review_notes')).status).toBe(409);
  });

  it('preserves readonly, plugin ownership and archive input errors while redacting internal failures', async () => {
    const registry = new SqliteSkillRegistryRepository(database.db);
    await registry.registerSkill({ id: 'readonly', name: 'readonly', description: '', source: 'custom', readonly: true });
    const readonly = await built.app.inject({ method: 'PATCH', url: '/v1/skills/readonly', headers, payload: { active: false } });
    expect(skillsApi.setActive.response.parse(readonly.json())).toMatchObject({ readonly: 1, active: 0, source: 'custom' });
    expect((await built.app.inject({ method: 'DELETE', url: '/v1/skills/readonly', headers })).statusCode).toBe(409);
    const invalidArchive = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { name: 'notes', zipBase64: 'not-zip' } });
    expect(invalidArchive.statusCode).toBe(400);
    expect(apiProblemSchema.parse(invalidArchive.json()).error).toBe('Invalid skill archive');
    vi.spyOn(SkillManager.prototype, 'installFromZip').mockRejectedValueOnce(new Error('EACCES /private/skill-data SECRET'));
    const internal = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { name: 'notes', zipBase64: archive() } });
    expect(internal.statusCode).toBe(500);
    expect(apiProblemSchema.parse(internal.json())).toMatchObject({ code: 'INTERNAL_ERROR', detail: 'Internal Server Error' });
    expect(internal.payload).not.toContain('SECRET');
    expect(internal.payload).not.toContain('/private/skill-data');
  });

  it('preserves pre-abort and running archive cancellation without mutating files or converting internal worker errors to input errors', async () => {
    const manager = new SkillManager(new SqliteSkillRegistryRepository(database.db), skillsRoot);
    const before = new AbortController();
    const reason = new Error('caller cancellation');
    before.abort(reason);
    await expect(manager.installFromZip(Buffer.from(archive(), 'base64'), { name: 'notes', signal: before.signal })).rejects.toBe(reason);
    const running = new AbortController();
    const pending = manager.installFromZip(Buffer.from(archive(), 'base64'), { name: 'notes', signal: running.signal });
    running.abort();
    await expect(pending).rejects.toThrow('Archive processing cancelled');
    const internal = new Error('worker failed at /private/runtime');
    vi.spyOn(archiveWorker, 'executeArchive').mockRejectedValueOnce(internal);
    await expect(manager.installFromZip(Buffer.from(archive(), 'base64'), { name: 'notes' })).rejects.toBe(internal);
    await expect(manager.installFromZip(Buffer.from('bad zip'), { name: 'notes' })).rejects.toBeInstanceOf(SkillInstallInputError);
    expect(await readdir(skillsRoot)).toEqual(['builtin']);
    expect((await manager.listSkills()).length).toBe(0);
  });

  it('rejects corrupt and falsely sized DEFLATE as archive input before writing any skill', async () => {
    const compressed = Buffer.from(zipSync({ 'SKILL.md': new Uint8Array(16_384) }));
    const directory = compressed.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const corrupt = Buffer.from(compressed);
    const dataOffset = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
    corrupt[dataOffset] = 0x07; // Reserved DEFLATE block type.
    const forged = Buffer.from(compressed);
    forged.writeUInt32LE(1, directory + 24);
    for (const zip of [corrupt, forged]) {
      const response = await built.app.inject({ method: 'POST', url: '/v1/skills', headers, payload: { name: 'notes', zipBase64: zip.toString('base64') } });
      expect(response.statusCode).toBe(400);
      expect(apiProblemSchema.parse(response.json()).error).toBe('Invalid skill archive');
    }
    expect(await readdir(skillsRoot)).toEqual(['builtin']);
    expect((await new SqliteSkillRegistryRepository(database.db).listSkills()).length).toBe(0);
  });
});
