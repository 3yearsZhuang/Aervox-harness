// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createPersonaRouteHandler, type PersonaRouteDeps } from '../src/mobile/native-persona';

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
])('rejects whitespace-only persona fields before writing', async body => {
  const { handle, create } = setup();
  await expect(handle('POST', new URL('https://localhost/v1/personas'), body))
    .rejects.toMatchObject({ status: 400, code: 'INVALID_PERSONA' });
  expect(create).not.toHaveBeenCalled();
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
