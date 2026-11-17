// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createPersonaRouteHandler, type PersonaRouteDeps } from '../src/mobile/native-persona';
import { createHash } from 'node:crypto';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
function setup() {
  const create = vi.fn(async () => ({ persona: { id: 'p1' }, revision: { revision: 1 } }));
  const update = vi.fn(async () => null);
  const repo = { createPersona: create, updatePersona: update } as unknown as PersonaRouteDeps['repo'];
  const checksum = vi.fn((config: unknown) => JSON.stringify(config));
  return { create, update, checksum, handle: createPersonaRouteHandler({ repo, ctx, checksum }) };
}
it('preserves a missing persona update as 404', async () => {
  const { handle } = setup();
  await expect(handle('PATCH', new URL('https://localhost/v1/personas/missing'), {
    expectedRevision: 1, config: { systemPromptAppend: '你好' },
  })).rejects.toMatchObject({ status: 404, code: 'PERSONA_NOT_FOUND' });
});
it.each([
  { name: '   ', config: { systemPromptAppend: '温和' } },
  { name: '小隅', config: { systemPromptAppend: '   ' } },
  { name: '小隅', config: { systemPromptAppend: '温和', allowedSkillNames: ['   '] } },
  { name: '小隅', config: { systemPromptAppend: '温和', allowedMcpToolIds: ['   '] } },
  { name: '小隅', config: { systemPromptAppend: '温和', live2dModelId: '   ' } },
])('rejects whitespace-only persona fields before writing', async body => {
  const { handle, create } = setup();
  await expect(handle('POST', new URL('https://localhost/v1/personas'), body))
    .rejects.toMatchObject({ status: 400, code: 'INVALID_PERSONA' });
  expect(create).not.toHaveBeenCalled();
});

it('preserves unavailable model references and hashes the same ordered config as the desktop', async () => {
  const { handle, create, checksum } = setup();
  await handle('POST', new URL('https://localhost/v1/personas'), {
    name: '小隅', config: { live2dModelId: ' missing-model ', voice: {enabled: true, providerId: 'voice', modelId: 'speech'},
      allowedMcpToolIds: [' open ', 'open'], systemPromptAppend: ' 温和 ', allowedSkillNames: ['review', 'review'] },
  });
  const desktopConfig = {systemPromptAppend: '温和', allowedSkillNames: ['review'], allowedMcpToolIds: ['open'],
    voice: {enabled: true, providerId: 'voice', modelId: 'speech'}, live2dModelId: 'missing-model'};
  const nativeConfig = checksum.mock.calls[0]?.[0];
  expect(checksum).toHaveBeenCalledWith(desktopConfig);
  expect(create).toHaveBeenCalledWith(ctx, expect.objectContaining({config: desktopConfig}));
  expect(JSON.stringify(nativeConfig)).toBe(JSON.stringify(desktopConfig));
  expect(createHash('sha256').update(JSON.stringify(nativeConfig)).digest('hex'))
    .toBe(createHash('sha256').update(JSON.stringify(desktopConfig)).digest('hex'));
});

it('reads the requested revision while retaining the default latest detail, and rejects missing or foreign revisions', async () => {
  const old = {id: 'old', personaId: 'p1', config: {systemPromptAppend: '温和', live2dModelId: 'old-model'}};
  const repo = {
    getPersona: vi.fn(async () => ({id: 'p1', currentRevisionId: 'new'})),
    getPersonaRevision: vi.fn(async (_ctx, _personaId, revisionId) => revisionId === 'old' ? old
      : revisionId === 'foreign' ? {id: 'foreign', personaId: 'p2'} : revisionId === 'missing' ? null : {id: 'new', personaId: 'p1'}),
    getActivePersona: vi.fn(async () => ({personaId: 'p1', revisionId: 'old'})),
  } as unknown as PersonaRouteDeps['repo'];
  const handle = createPersonaRouteHandler({repo, ctx, checksum: JSON.stringify});
  expect(await handle('GET', new URL('https://localhost/v1/personas/p1?revisionId=old'), undefined))
    .toMatchObject({handled: true, result: {revision: old}});
  expect(await handle('GET', new URL('https://localhost/v1/personas/p1'), undefined))
    .toMatchObject({handled: true, result: {revision: {id: 'new'}}});
  for (const revisionId of ['foreign', 'missing']) {
    await expect(handle('GET', new URL(`https://localhost/v1/personas/p1?revisionId=${revisionId}`), undefined))
      .rejects.toMatchObject({status: 404, code: 'PERSONA_NOT_FOUND'});
  }
  await expect(handle('GET', new URL('https://localhost/v1/personas/p1?revisionId='), undefined))
    .rejects.toMatchObject({status: 400, code: 'INVALID_PERSONA'});
});
it('normalizes config and computes the checksum over the desktop-equivalent shape', async () => {
  const { handle, create, checksum } = setup();
  await handle('POST', new URL('https://localhost/v1/personas'), {
    name: '  小隅  ', config: { systemPromptAppend: '  温和  ', allowedSkillNames: [' review ', 'review'], allowedMcpToolIds: [' open ', 'open'] },
  });
  const config = { systemPromptAppend: '温和', allowedSkillNames: ['review'], allowedMcpToolIds: ['open'] };
  expect(checksum).toHaveBeenCalledWith(config);
  expect(create).toHaveBeenCalledWith(ctx, expect.objectContaining({ name: '小隅', config, checksum: JSON.stringify(config) }));
});
it('rejects an empty trimmed name on update without calling the repository', async () => {
  const { handle, update } = setup();
  await expect(handle('PATCH', new URL('https://localhost/v1/personas/p1'), {
    expectedRevision: 1, name: '  ', config: { systemPromptAppend: '温和' },
  })).rejects.toMatchObject({ status: 400, code: 'INVALID_PERSONA' });
  expect(update).not.toHaveBeenCalled();
});
