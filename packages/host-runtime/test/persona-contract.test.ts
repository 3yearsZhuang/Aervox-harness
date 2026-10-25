import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { registerPersonaRoutes } from '../src/modules/companion/persona/routes.js';
import type { PersonaService } from '../src/modules/companion/persona/service.js';
import { personaApi } from '@aervox/contracts';

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
