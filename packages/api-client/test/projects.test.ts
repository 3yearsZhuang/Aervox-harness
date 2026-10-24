import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureAervoxClient,
  useAervoxProjects,
  useAervoxSessions,
} from '../src/index.js';
import type { AervoxTransport } from '../src/transport.js';

describe('useAervoxProjects (CR-048 / W3)', () => {
  let mockTransport: AervoxTransport;

  beforeEach(() => {
    mockTransport = {
      request: vi.fn(),
      streamTurn: vi.fn(),
      submitQuestionAnswers: vi.fn(),
      decideToolApproval: vi.fn(),
    };

    configureAervoxClient({
      sessionId: 'ses_test',
      transport: mockTransport,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchProjects 拉取项目列表并填充响应式状态', async () => {
    const mockProjects = [
      { id: 'proj_1', name: '项目一', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z' },
    ];
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: mockProjects });

    const { projects, fetchProjects } = useAervoxProjects();
    const result = await fetchProjects();

    expect(result).toHaveLength(1);
    expect(projects.value[0].name).toBe('项目一');
    expect(mockTransport.request).toHaveBeenCalledWith('GET', '/v1/projects');
  });

  it('fetchProjects(true) 包含归档项目参数', async () => {
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [] });
    const { fetchProjects } = useAervoxProjects();
    await fetchProjects(true);

    expect(mockTransport.request).toHaveBeenCalledWith('GET', '/v1/projects?includeArchived=true');
  });

  it('createProject 成功发起 POST 并更新列表', async () => {
    const newProj = { id: 'proj_2', name: '机器学习', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z' };
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newProj);

    const { projects, createProject } = useAervoxProjects();
    const created = await createProject({ name: '机器学习' });

    expect(created).toEqual(newProj);
    expect(projects.value).toContainEqual(newProj);
    expect(mockTransport.request).toHaveBeenCalledWith('POST', '/v1/projects', { name: '机器学习' });
  });

  it('updateProject 成功更新目标项目', async () => {
    const original = { id: 'proj_3', name: '原名', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z' };
    const updated = { ...original, name: '新名' };

    const { projects, updateProject } = useAervoxProjects();
    projects.value = [original];

    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updated);
    const res = await updateProject('proj_3', { name: '新名' });

    expect(res?.name).toBe('新名');
    expect(projects.value[0].name).toBe('新名');
  });

  it('deleteProject 成功删除项目并在选定时重置选中项', async () => {
    const proj = { id: 'proj_del', name: '待删', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z' };
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const { projects, selectedProjectId, selectProject, deleteProject } = useAervoxProjects();
    projects.value = [proj];
    selectProject('proj_del');
    expect(selectedProjectId.value).toBe('proj_del');

    const ok = await deleteProject('proj_del');
    expect(ok).toBe(true);
    expect(projects.value).toHaveLength(0);
    expect(selectedProjectId.value).toBeNull();
  });

  it('importSession 成功向 /v1/sessions/import 提交', async () => {
    const importPayload = {
      title: '导入会话',
      messages: [{ role: 'user' as const, content: '你好' }],
    };
    const mockRes = {
      session: { id: 'ses_imp_1', title: '导入会话', createdAt: '2026-09-14T10:00:00Z', updatedAt: '2026-09-14T10:00:00Z' },
      turnsCount: 1,
      messagesCount: 1,
    };
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockRes);

    const { importSession } = useAervoxProjects();
    const result = await importSession(importPayload);

    expect(result).toEqual(mockRes);
    expect(mockTransport.request).toHaveBeenCalledWith('POST', '/v1/sessions/import', importPayload);
  });

  it('useAervoxSessions fetchSessions 支持按 projectId 过滤', async () => {
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [] });
    const { fetchSessions } = useAervoxSessions();
    await fetchSessions({ projectId: 'proj_spec' });

    expect(mockTransport.request).toHaveBeenCalledWith('GET', '/v1/sessions?projectId=proj_spec');
  });

  it('useAervoxSessions createNewSession 支持携带 projectId', async () => {
    const createdSession = {
      id: 'ses_with_p',
      title: '项目对话',
      projectId: 'proj_x',
      createdAt: '2026-09-14T10:00:00Z',
      updatedAt: '2026-09-14T10:00:00Z',
    };
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(createdSession);

    const { createNewSession } = useAervoxSessions();
    const created = await createNewSession('项目对话', undefined, 'proj_x');

    expect(created.projectId).toBe('proj_x');
    expect(mockTransport.request).toHaveBeenCalledWith('POST', '/v1/sessions', {
      title: '项目对话',
      projectId: 'proj_x',
    });
  });
});

describe('project resource ownership', () => {
  const project = (id: string) => ({id, name: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'});
  const deferred = () => {
    let resolve!: (value: unknown) => void, reject!: (cause: Error) => void;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return {promise, resolve, reject};
  };
  const setup = (request: ReturnType<typeof vi.fn>) => {
    configureAervoxClient({transport: {request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()}});
    return useAervoxProjects();
  };
  it('invalidates pre-create, pre-update, and pre-delete list requests only after a confirmed write', async () => {
    for (const action of ['create', 'update', 'delete'] as const) {
      const read = deferred(); const request = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValueOnce(action === 'update' ? {...project('old'), name: 'updated'} : project('new'));
      const store = setup(request); store.projects.value = [project('old')];
      const pending = store.fetchProjects();
      if (action === 'create') await store.createProject({name: 'new'});
      else if (action === 'update') await store.updateProject('old', {name: 'new'});
      else await store.deleteProject('old');
      const afterWrite = store.projects.value.map(item => ({...item}));
      read.resolve({items: [project('old')]}); await pending;
      expect(store.projects.value).toEqual(afterWrite);
    }
  });
  it('lets the latest query own data, loading and errors regardless of response order', async () => {
    const old = deferred(), latest = deferred();
    const store = setup(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise));
    const first = store.fetchProjects(), second = store.fetchProjects(true);
    old.reject(new Error('old failure')); await first;
    expect(store.loading.value).toBe(true); expect(store.error.value).toBeNull();
    latest.resolve({items: [project('latest')]}); await second;
    expect(store.projects.value).toEqual([project('latest')]); expect(store.loading.value).toBe(false);
  });
  it('preserves current data and selection on failed writes and exposes the write failure', async () => {
    const store = setup(vi.fn().mockRejectedValue(new Error('write failed')));
    store.projects.value = [project('old')]; store.selectProject('old');
    expect(await store.deleteProject('old')).toBe(false);
    expect(store.projects.value).toEqual([project('old')]); expect(store.selectedProjectId.value).toBe('old');
    expect(store.error.value).toBe('write failed');
  });
  it('rejects invalid list projections and write receipts before replacing validated state', async () => {
    const read = deferred();
    const request = vi.fn().mockResolvedValueOnce({items: [project('old')]})
      .mockResolvedValueOnce({items: [{...project('bad'), name: 42}]})
      .mockReturnValueOnce(read.promise)
      .mockResolvedValueOnce({...project('bad'), name: 42});
    const store = setup(request); store.selectProject('old');
    await store.fetchProjects(); await store.fetchProjects();
    expect(store.projects.value).toEqual([project('old')]);
    expect(store.error.value).toBeTruthy();
    const pending = store.fetchProjects();
    expect(await store.createProject({name: 'new'})).toBeNull();
    expect(store.projects.value).toEqual([project('old')]);
    expect(store.selectedProjectId.value).toBe('old');
    read.resolve({items: [project('latest')]}); await pending;
    expect(store.projects.value).toEqual([project('latest')]);
  });
  it('validates update and import receipts and rejects invalid requests before transport', async () => {
    const request = vi.fn().mockResolvedValueOnce({id: 'old', name: 'invalid receipt'})
      .mockResolvedValueOnce({session: project('session'), turnsCount: -1, messagesCount: 1});
    const store = setup(request); store.projects.value = [project('old')];
    expect(await store.updateProject('old', {name: 'new'})).toBeNull();
    expect(store.projects.value).toEqual([project('old')]);
    expect(await store.importSession({messages: [{role: 'user', content: 'Hello'}]})).toBeNull();
    expect(await store.createProject({name: ''})).toBeNull();
    expect(await store.updateProject('old', {name: ''})).toBeNull();
    expect(await store.importSession({messages: []})).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
