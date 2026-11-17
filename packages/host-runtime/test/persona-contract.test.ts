import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerPersonaRoutes } from '../src/modules/companion/persona/routes.js';
import type { PersonaService } from '../src/modules/companion/persona/service.js';
import { personaApi } from '@aervox/contracts';
import { PersonaService as PersonaServiceImpl, type PersonaServiceDeps } from '../src/modules/companion/persona/service.js';
import { computeRevisionChecksum, validatePersonaConfig } from '../src/modules/companion/persona/types.js';
import { exportPersonaBundle, importPersonaBundle } from '../src/modules/companion/persona/bundle.js';

const now = '2026-10-24T00:00:00.000Z';
const persona = {id: 'persona', workspaceId: 'local', subjectUserId: 'local', name: 'Guide', description: '', source: 'user_created', status: 'active', reviewStatus: 'draft', reviewNotes: '', reviewedAt: null, currentRevisionId: 'revision', createdAt: now, updatedAt: now};
const revision = {id: 'revision', personaId: persona.id, revision: 1, config: {systemPromptAppend: 'Be concise'}, checksum: 'a'.repeat(64), createdAt: now};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const build = (service: Partial<PersonaService>) => {
  const app = Fastify();
  apps.push(app);
  registerPersonaRoutes(app, service as PersonaService);
  return app;
};

it('documents and returns the existing nullable revision projection', async () => {
  const app = build({getPersona: vi.fn().mockResolvedValue({persona, revision: null, active: false})});
  const response = await app.inject({method: 'GET', url: '/v1/personas/persona'});
  expect(response.statusCode).toBe(200);
  expect(personaApi.get.response.parse(response.json())).toEqual({persona, revision: null, active: false});
});

it('accepts omitted activation bodies, preserves 201 and rejects invalid writes before service calls', async () => {
  const selection = {workspaceId: 'local', subjectUserId: 'local', personaId: persona.id, revisionId: revision.id, selectedAt: now};
  const service = {activatePersona: vi.fn().mockResolvedValue(selection), createPersona: vi.fn().mockResolvedValue({persona, revision})};
  const app = build(service);
  const activated = await app.inject({method: 'POST', url: '/v1/personas/persona/activate'});
  expect(activated.statusCode).toBe(200);
  expect(service.activatePersona).toHaveBeenCalledWith(expect.anything(), persona.id, undefined);
  const created = await app.inject({method: 'POST', url: '/v1/personas', payload: {name: persona.name, config: revision.config}});
  expect(created.statusCode).toBe(201);
  expect(personaApi.create.response.parse(created.json())).toEqual({persona, revision});
  const invalid = await app.inject({method: 'POST', url: '/v1/personas', payload: {name: persona.name, config: {...revision.config, voice: {enabled: true, providerId: 'voice', modelId: ''}}}});
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().code).toBe('INVALID_PERSONA');
  expect(service.createPersona).toHaveBeenCalledTimes(1);
});

it('validates the response even on the 201 creation path', async () => {
  const app = build({createPersona: vi.fn().mockResolvedValue({persona, revision: {...revision, checksum: 'invalid'}})});
  const response = await app.inject({method: 'POST', url: '/v1/personas', payload: {name: persona.name, config: revision.config}});
  expect(response.statusCode).toBe(500);
});

it('forwards and validates revision queries before calling the service', async () => {
  const getPersona = vi.fn().mockResolvedValue({persona, revision, active: true});
  const app = build({ getPersona });
  const response = await app.inject({method: 'GET', url: '/v1/personas/persona?revisionId=revision'});
  expect(response.statusCode).toBe(200);
  expect(getPersona).toHaveBeenCalledWith(expect.anything(), 'persona', 'revision');
  const invalid = await app.inject({method: 'GET', url: '/v1/personas/persona?revisionId='});
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json().code).toBe('INVALID_PERSONA');
  expect(getPersona).toHaveBeenCalledTimes(1);
});

it('reads a selected historical revision without following an unactivated edit and refuses foreign revisions', async () => {
  const old = {...revision, id: 'old', config: {...revision.config, live2dModelId: 'old-model'}};
  const repo = {
    getPersona: vi.fn().mockResolvedValue({...persona, currentRevisionId: 'new'}),
    getPersonaRevision: vi.fn(async (_ctx, personaId, revisionId) => revisionId === 'old' ? old
      : revisionId === 'foreign' ? {...revision, id: 'foreign', personaId: 'another-persona'}
      : revisionId === 'missing' ? null : {...revision, id: 'new'}),
    getActivePersona: vi.fn().mockResolvedValue({personaId: persona.id, revisionId: 'old'}),
  };
  const service = new PersonaServiceImpl({ personaRepo: repo as unknown as PersonaServiceDeps['personaRepo'] });
  const ctx = {workspaceId: 'local', subjectUserId: 'local'};
  expect((await service.getPersona(ctx, persona.id, 'old'))?.revision?.config.live2dModelId).toBe('old-model');
  expect((await service.getPersona(ctx, persona.id))?.revision?.id).toBe('new');
  expect(await service.getPersona(ctx, persona.id, 'foreign')).toBeNull();
  expect(await service.getPersona(ctx, persona.id, 'missing')).toBeNull();
  expect(repo.getPersonaRevision).toHaveBeenCalledWith(ctx, persona.id, 'old');
});

it('preserves legacy config serialization and includes the optional binding in revision checksums', () => {
  const legacy = {systemPromptAppend: 'Be concise', allowedSkillNames: ['alpha'], allowedMcpToolIds: [], voice: {enabled: true, providerId: 'voice', modelId: 'speech'}};
  expect(JSON.stringify(validatePersonaConfig(legacy))).toBe(JSON.stringify(legacy));
  const bound = validatePersonaConfig({...legacy, live2dModelId: ' missing-model '});
  expect(Object.keys(bound)).toEqual([...Object.keys(legacy), 'live2dModelId']);
  expect(bound.live2dModelId).toBe('missing-model');
  expect(computeRevisionChecksum(bound)).not.toBe(computeRevisionChecksum(legacy));
});

it.each([undefined, 'missing-model'])('round-trips a bundle with binding %s without changing its schema or checksum', async live2dModelId => {
  const config = validatePersonaConfig({...revision.config, ...(live2dModelId ? {live2dModelId} : {})});
  const sourceRevision = {...revision, config, checksum: computeRevisionChecksum(config)};
  const skillManager = {listSkills: vi.fn(async () => []), installFromZip: vi.fn(async () => [])} as unknown as Parameters<typeof exportPersonaBundle>[0]['skillManager'];
  const exported = await exportPersonaBundle({
    persona: persona as Parameters<typeof exportPersonaBundle>[0]['persona'], revision: sourceRevision, skillManager,
  });
  const createPersona = vi.fn(async (_ctx, input) => ({
    persona: {...persona, source: 'imported', id: input.id},
    revision: {...sourceRevision, personaId: input.id, config: input.config, checksum: input.checksum},
  }));
  const imported = await importPersonaBundle({bytes: exported.bytes, tenant: {workspaceId: 'local', subjectUserId: 'local'},
    personaRepo: {createPersona} as unknown as Parameters<typeof importPersonaBundle>[0]['personaRepo'], skillManager});
  expect(exported.manifest.schemaVersion).toBe(1);
  expect(imported.revision.config).toEqual(config);
  expect(imported.revision.checksum).toBe(sourceRevision.checksum);
  expect(createPersona).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({config, checksum: sourceRevision.checksum}));
});
