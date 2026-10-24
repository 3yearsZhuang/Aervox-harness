import { beforeEach, expect, it, vi } from 'vitest';
import { configureAervoxClient } from '../src/transport.js';
import { useAervoxPersonas } from '../src/useAervoxPersonas.js';

const now = '2026-10-24T00:00:00.000Z';
const persona = {id: 'p/one', workspaceId: 'local', subjectUserId: 'local', name: 'Guide', description: '', source: 'user_created', status: 'active', reviewStatus: 'draft', reviewNotes: '', reviewedAt: null, currentRevisionId: 'r1', createdAt: now, updatedAt: now};
const revision = {id: 'r1', personaId: persona.id, revision: 1, config: {systemPromptAppend: 'Be concise'}, checksum: 'a'.repeat(64), createdAt: now};
const selection = {workspaceId: 'local', subjectUserId: 'local', personaId: persona.id, revisionId: revision.id, selectedAt: now};
const mutation = {persona, revision};
const list = {personas: [persona], active: selection};
const request = vi.fn();
beforeEach(() => {
  request.mockReset();
  configureAervoxClient({transport: {request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()}});
});

it('rejects invalid Persona wire data and retains the last validated list', async () => {
  request.mockResolvedValueOnce(list).mockResolvedValueOnce({personas: [{...persona, reviewStatus: 'not-a-status'}], active: null});
  const api = useAervoxPersonas();
  await api.loadPersonas();
  await api.loadPersonas();
  expect(api.personas.value).toEqual([persona]);
  expect(api.activePersona.value).toEqual(selection);
  expect(api.error.value).toBeTruthy();
  expect(api.loading.value).toBe(false);

  request.mockResolvedValueOnce({persona, revision: {...revision, config: {systemPromptAppend: 'x', voice: {enabled: true, providerId: 'voice', modelId: ''}}}, active: false});
  await expect(api.getPersonaDetail(persona.id)).rejects.toThrow();
  request.mockResolvedValueOnce({persona, revision: null, active: false});
  expect((await api.getPersonaDetail(persona.id)).revision).toBeNull();
});

it('shares validation across all eight Persona operations while retaining wire bodies and encoded identities', async () => {
  const bundle = {bundleBase64: 'eA==', fileName: 'guide.persona.zip', skillNames: [], missingDependencies: []};
  request.mockImplementation(async (method, path) => {
    if (method === 'GET') return list;
    if (path.endsWith('/activate')) return selection;
    if (path.endsWith('/export')) return bundle;
    if (path.endsWith('/import')) return {...mutation, skills: [{name: 'legacy', description: '', checksum: null}], missingDependencies: []};
    if (method === 'DELETE') return {deleted: true, personaId: persona.id};
    return mutation;
  });
  const api = useAervoxPersonas();
  const input = {name: 'Guide', config: revision.config};
  expect(await api.createPersona(input)).toEqual(mutation);
  expect(await api.updatePersona(persona.id, {expectedRevision: 1, config: revision.config})).toEqual(mutation);
  expect(await api.activatePersona(persona.id)).toEqual(selection);
  expect(await api.exportPersona(persona.id)).toEqual(bundle);
  expect(await api.importPersona(bundle.bundleBase64)).toMatchObject(mutation);
  expect(await api.deletePersona(persona.id)).toBe(true);
  expect(request).toHaveBeenCalledWith('POST', '/v1/personas', input);
  expect(request).toHaveBeenCalledWith('POST', '/v1/personas/p%2Fone/activate', {});
  expect(request).toHaveBeenCalledWith('POST', '/v1/personas/import', {bundleBase64: 'eA==', conflictResolution: 'error'});
  const calls = request.mock.calls.length;
  await expect(api.updatePersona(persona.id, {expectedRevision: 0, config: revision.config})).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(calls);
});

it('a confirmed write invalidates earlier list reads even when its refresh fails', async () => {
  let resolveOld!: (value: unknown) => void;
  request.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  const api = useAervoxPersonas();
  const oldRead = api.loadPersonas();
  request.mockResolvedValueOnce(mutation).mockRejectedValueOnce(new Error('refresh failed'));
  await api.createPersona({name: persona.name, config: revision.config});
  resolveOld({personas: [{...persona, name: 'Stale'}], active: null});
  await oldRead;
  expect(api.personas.value).toEqual([]);
  expect(api.error.value).toBe('refresh failed');
});
