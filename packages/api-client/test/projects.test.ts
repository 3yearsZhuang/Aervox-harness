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
