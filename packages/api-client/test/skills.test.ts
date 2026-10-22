import { describe, expect, it, vi } from 'vitest';
import type { AervoxTransport } from '../src/transport.js';
import { useAervoxSkills } from '../src/useAervoxSkills.js';

function transport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
  return { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
}
const skill = { id: 'notes', name: 'notes', description: '', source: 'local', active: 1, readonly: 0, version: '1.0.0', checksum: null, pluginId: null, contentPath: null, lastUsedAt: null, createdAt: 'now', updatedAt: 'now', gatingConditionsJson: null };

describe('skill shared client contracts', () => {
  it('keeps the public workflow, query filtering and refresh after successful mutations', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = useAervoxSkills(transport(async (method, path, body) => {
      calls.push([method, path, body]);
      if (method === 'DELETE') return undefined;
      if (path.endsWith('/content')) return { name: 'notes', description: '', content: '# Notes' };
      if (path === '/v1/skills/prompt') return { prompt: 'notes' };
      if (method === 'POST') return { installed: [skill] };
      if (path === '/v1/skills' || path.includes('?')) return { items: [skill] };
      return skill;
    }));
    await api.loadSkills(true, 'local & plugin');
    expect(api.skills.value).toEqual([skill]);
    expect(await api.getSkill('a/b?c#d')).toEqual(skill);
    expect(await api.getSkillContent('notes')).toEqual({ name: 'notes', description: '', content: '# Notes' });
    expect(await api.setSkillActive('notes', false)).toEqual(skill);
    expect(await api.installSkillZip('zip', { name: 'notes' })).toEqual({ installed: [skill] });
    await api.deleteSkill('notes');
    expect(await api.getSkillPrompt()).toBe('notes');
    expect(calls).toEqual([
      ['GET', '/v1/skills?activeOnly=true&source=local+%26+plugin', undefined],
      ['GET', '/v1/skills/a%2Fb%3Fc%23d', undefined], ['GET', '/v1/skills/notes/content', undefined],
      ['PATCH', '/v1/skills/notes', { active: false }], ['GET', '/v1/skills', undefined],
      ['POST', '/v1/skills', { zipBase64: 'zip', name: 'notes', overwrite: undefined }], ['GET', '/v1/skills', undefined],
      ['DELETE', '/v1/skills/notes', undefined], ['GET', '/v1/skills', undefined], ['GET', '/v1/skills/prompt', undefined],
    ]);
  });

  it('rejects invalid writes before transport and propagates failure without refreshing the list', async () => {
    const request = vi.fn(async () => { throw new Error('conflict'); });
    const api = useAervoxSkills(transport(request));
    await expect(api.installSkillZip('zip', { overwrite: 'false' } as never)).rejects.toThrow();
    await expect(api.installSkillZip('')).rejects.toThrow();
    await expect(api.setSkillActive('notes', 1 as never)).rejects.toThrow();
    await expect(api.getSkill('')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(api.installSkillZip('zip', { overwrite: true })).rejects.toThrow('conflict');
    await expect(api.deleteSkill('notes')).rejects.toThrow('conflict');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed remote responses and exposes list errors without replacing its last valid list', async () => {
    let result: unknown = { items: [skill] };
    const api = useAervoxSkills(transport(async () => result));
    await api.loadSkills();
    result = { skills: [skill] };
    await api.loadSkills();
    expect(api.error.value).toEqual(expect.any(String));
    expect(api.skills.value).toEqual([skill]);
    expect(api.loading.value).toBe(false);
    result = { ...skill, active: true };
    await expect(api.getSkill('notes')).rejects.toThrow();
    result = { name: 'notes', content: '# Notes' };
    await expect(api.getSkillContent('notes')).rejects.toThrow();
    result = { prompt: 42 };
    await expect(api.getSkillPrompt()).rejects.toThrow();
    result = {};
    await expect(api.deleteSkill('notes')).rejects.toThrow();
  });
});
