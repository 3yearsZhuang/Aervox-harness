// @vitest-environment node
/** 手机端人格/日记路由：契约形状、CAS 冲突与「已存在就不重复生成」。 */
import { describe, expect, it, vi } from 'vitest';
import { AervoxHttpError } from '@aervox/api-client';
import { createPersonaRouteHandler } from '../src/mobile/native-persona';
import { createDiaryRouteHandler } from '../src/mobile/native-diary';

const ctx = { workspaceId: 'local', subjectUserId: 'local' };
const checksum = (config: unknown) => `sum:${JSON.stringify(config)}`;

function personaRepo(overrides: Record<string, unknown> = {}) {
  return {
    listPersonas: vi.fn(async () => [{ id: 'p1', name: '小隅', description: '陪着你' }]),
    getPersona: vi.fn(async () => ({ id: 'p1', name: '小隅', description: '陪着你', currentRevisionId: 'rev1' })),
    getPersonaRevision: vi.fn(async () => ({ id: 'rev1', revision: 2, config: { systemPromptAppend: '温和' } })),
    createPersona: vi.fn(async (_ctx, data) => ({ persona: { id: data.id, name: data.name }, revision: { revision: 1, config: data.config } })),
    updatePersona: vi.fn(async (_ctx, data) => ({ persona: { id: data.personaId }, revision: { revision: data.expectedRevision + 1, config: data.config } })),
    activatePersona: vi.fn(async () => ({ personaId: 'p1', revisionId: 'rev1' })),
    getActivePersona: vi.fn(async () => ({ personaId: 'p1', revisionId: 'rev1' })),
    ...overrides,
  };
}

describe('mobile persona routes', () => {
  it('lists personas together with the active selection', async () => {
    const repo = personaRepo();
    const handle = createPersonaRouteHandler({ repo, ctx, checksum });
    const result = await handle('GET', new URL('https://localhost/v1/personas'), undefined);
    expect(result).toEqual({ handled: true, result: { personas: [{ id: 'p1', name: '小隅', description: '陪着你' }], active: { personaId: 'p1', revisionId: 'rev1' } } });
  });

  it('returns undefined for unrelated paths so the next handler can claim them', async () => {
    const handle = createPersonaRouteHandler({ repo: personaRepo(), ctx, checksum });
    expect(await handle('GET', new URL('https://localhost/v1/diaries'), undefined)).toEqual({ handled: false });
  });

  it('surfaces a stale revision as a 409 instead of overwriting', async () => {
    const repo = personaRepo({
      updatePersona: vi.fn(async () => { throw new Error('PERSONA_REVISION_CONFLICT'); }),
    });
    const handle = createPersonaRouteHandler({ repo, ctx, checksum });
    await expect(handle('PATCH', new URL('https://localhost/v1/personas/p1'), {
      expectedRevision: 1, config: { systemPromptAppend: '更安静一点' },
    })).rejects.toMatchObject({ status: 409 });
  });

  it('writes the revision checksum over the exact config it stores', async () => {
    const repo = personaRepo();
    const handle = createPersonaRouteHandler({ repo, ctx, checksum });
    await handle('PATCH', new URL('https://localhost/v1/personas/p1'), {
      expectedRevision: 2, name: '小隅', config: { systemPromptAppend: '温和' },
    });
    expect(repo.updatePersona).toHaveBeenCalledWith(ctx, expect.objectContaining({
      personaId: 'p1', expectedRevision: 2, checksum: checksum({ systemPromptAppend: '温和' }),
    }));
  });
});

function diaryRepo(existing: Record<string, unknown> | null = null) {
  return {
    getDiaryByDate: vi.fn(async () => existing),
    listDiaries: vi.fn(async () => [{ id: 'd1', localDate: '2026-11-04', title: '今天的日记', content: '正文' }]),
    publishGeneratedDiary: vi.fn(async () => ({ diary: { id: 'd_new', title: '今天的日记', content: '模板正文' } })),
    publishDiaryRevision: vi.fn(async () => ({ id: 'd1' })),
  };
}

const materials = {
  collect: vi.fn(async () => ({ messages: [], memories: [], goals: [], attemptsToday: { total: 0, correct: 0 } })),
} as never;

describe('mobile diary routes', () => {
  it('reads a missing day as 404 rather than an empty diary', async () => {
    const handle = createDiaryRouteHandler({ repo: diaryRepo(null), materials, ctx, model: null });
    await expect(handle('GET', new URL('https://localhost/v1/diaries?localDate=2026-11-01'), undefined))
      .rejects.toBeInstanceOf(AervoxHttpError);
  });

  it('returns today as-is when it already exists and rewrite was not asked for', async () => {
    const repo = diaryRepo({ id: 'd1', title: '旧标题', content: '旧正文' });
    const handle = createDiaryRouteHandler({ repo, materials, ctx, model: null });
    const result = await handle('POST', new URL('https://localhost/v1/diaries/generate-today'), {});
    expect(result).toMatchObject({ handled: true, result: { mode: 'existing', title: '旧标题' } });
    expect(repo.publishGeneratedDiary).not.toHaveBeenCalled();
    expect(repo.publishDiaryRevision).not.toHaveBeenCalled();
  });

  it('rewrites an existing day through a new version instead of overwriting it', async () => {
    const repo = diaryRepo({ id: 'd1', title: '旧标题', content: '旧正文' });
    const handle = createDiaryRouteHandler({ repo, materials, ctx, model: null });
    const result = await handle('POST', new URL('https://localhost/v1/diaries/generate-today'), { rewrite: true });
    expect(result).toMatchObject({ handled: true, result: { mode: 'rewritten', diaryId: 'd1' } });
    expect(repo.publishDiaryRevision).toHaveBeenCalledTimes(1);
    expect(repo.publishGeneratedDiary).not.toHaveBeenCalled();
  });

  it('publishes a template diary when no model is configured, and says so', async () => {
    const repo = diaryRepo(null);
    const handle = createDiaryRouteHandler({ repo, materials, ctx, model: null });
    const result = await handle('POST', new URL('https://localhost/v1/diaries/generate-today'), {});
    expect(result).toMatchObject({ handled: true, result: { mode: 'created', generatedBy: 'template' } });
    expect(repo.publishGeneratedDiary).toHaveBeenCalledTimes(1);
  });
});
