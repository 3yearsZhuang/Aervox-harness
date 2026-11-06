import { beforeEach, expect, it, vi } from 'vitest';
import { configureAervoxClient, getTransport } from '../src/transport.js';
import { useAervoxPersonas } from '../src/useAervoxPersonas.js';
import { subscribePersonaChanges } from '../src/persona-changes.js';

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

it('requests the selected revision and rejects a valid-shaped response for a different identity', async () => {
  const api = useAervoxPersonas();
  const old = {...revision, id: 'r/old', config: {...revision.config, live2dModelId: 'missing-model'}};
  request.mockResolvedValueOnce({persona, revision: old, active: true});
  expect((await api.getPersonaDetail(persona.id, {revisionId: old.id})).revision?.config.live2dModelId).toBe('missing-model');
  expect(request).toHaveBeenLastCalledWith('GET', '/v1/personas/p%2Fone?revisionId=r%2Fold', undefined);
  for (const response of [
    {persona, revision, active: true},
    {persona, revision: {...old, personaId: 'foreign'}, active: true},
    {persona: {...persona, id: 'foreign'}, revision: old, active: true},
    {persona, revision: null, active: true},
  ]) {
    request.mockResolvedValueOnce(response);
    await expect(api.getPersonaDetail(persona.id, {revisionId: old.id})).rejects.toThrow('PERSONA_REVISION_MISMATCH');
  }
});

it('notifies the captured transport after validated writes even when the default host changes or refresh fails', async () => {
  const transport = getTransport();
  const api = useAervoxPersonas();
  const oldHost = vi.fn();
  const newHost = vi.fn();
  const stopOld = subscribePersonaChanges(oldHost, transport);
  const nextTransport = {...transport, request: vi.fn()};
  const stopNew = subscribePersonaChanges(newHost, nextTransport);
  try {
    configureAervoxClient({transport: nextTransport});
    request.mockResolvedValueOnce(mutation).mockRejectedValueOnce(new Error('refresh failed'));
    await api.createPersona({name: persona.name, config: revision.config});
    expect(oldHost).toHaveBeenCalledTimes(1);
    expect(newHost).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error('write failed'));
    await expect(api.activatePersona(persona.id)).rejects.toThrow('write failed');
    request.mockResolvedValueOnce({...mutation, revision: {...revision, checksum: 'invalid'}});
    await expect(api.updatePersona(persona.id, {expectedRevision: 1, config: revision.config})).rejects.toThrow();
    expect(oldHost).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({deleted: false, personaId: persona.id}).mockResolvedValueOnce(list);
    expect(await api.deletePersona(persona.id)).toBe(false);
    expect(oldHost).toHaveBeenCalledTimes(1);
  } finally { stopOld(); stopNew(); }
});
