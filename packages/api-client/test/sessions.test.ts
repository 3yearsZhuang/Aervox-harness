import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_SESSION_STORAGE_KEY,
  configureAervoxClient,
  getSessionId,
  setSessionId,
  useAervoxSessions,
} from '../src/index.js';
import type { AervoxTransport } from '../src/transport.js';

describe('useAervoxSessions', () => {
  let mockTransport: AervoxTransport;
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = val;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    });

    mockTransport = {
      request: vi.fn(),
      streamTurn: vi.fn(),
      submitQuestionAnswers: vi.fn(),
      decideToolApproval: vi.fn(),
    };

    configureAervoxClient({
      sessionId: 'ses_initial',
      transport: mockTransport,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getSessionId and setSessionId update global session configuration', () => {
    expect(getSessionId()).toBe('ses_initial');
    setSessionId('ses_updated');
    expect(getSessionId()).toBe('ses_updated');
  });

  it('fetchSessions retrieves session list and updates reactive state', async () => {
    const mockSessions = [
      { id: 'ses_1', title: '会话 1', createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z' },
      { id: 'ses_2', title: '会话 2', createdAt: '2026-09-14T09:00:00.000Z', updatedAt: '2026-09-14T09:00:00.000Z' },
    ];

    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: mockSessions,
    });

    const { sessions, activeSessionId, fetchSessions, activeSession } = useAervoxSessions();
    const result = await fetchSessions();

    expect(result).toHaveLength(2);
    expect(sessions.value).toHaveLength(2);
    expect(mockTransport.request).toHaveBeenCalledWith('GET', '/v1/sessions');
    // Since initial 'ses_updated' from previous test or 'ses_initial' was not in the list, it aligns to ses_1
    expect(activeSessionId.value).toBe('ses_1');
    expect(activeSession.value?.title).toBe('会话 1');
    expect(store[ACTIVE_SESSION_STORAGE_KEY]).toBe('ses_1');
  });

  it('can refresh a mobile list without silently changing the live conversation owner', async () => {
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ items: [{ id: 'other', title: '另一个会话' }] });
    const sessions = useAervoxSessions();
    await sessions.fetchSessions({ preserveSelection: true });
    expect(sessions.sessions.value[0]?.id).toBe('other');
    expect(sessions.activeSessionId.value).toBe('ses_initial');
    expect(getSessionId()).toBe('ses_initial');
  });

  it('createNewSession sends POST and activates newly created session', async () => {
    const newSession = {
      id: 'ses_new',
      title: '关于量子计算的讨论',
      createdAt: '2026-09-14T11:00:00.000Z',
      updatedAt: '2026-09-14T11:00:00.000Z',
    };

    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newSession);

    const { sessions, activeSessionId, createNewSession, activeSession } = useAervoxSessions();
    const created = await createNewSession('关于量子计算的讨论');

    expect(created.id).toBe('ses_new');
    expect(sessions.value[0].id).toBe('ses_new');
    expect(activeSessionId.value).toBe('ses_new');
    expect(activeSession.value?.title).toBe('关于量子计算的讨论');
    expect(mockTransport.request).toHaveBeenCalledWith('POST', '/v1/sessions', {
      title: '关于量子计算的讨论',
    });
    expect(getSessionId()).toBe('ses_new');
  });

  it('renameSession sends PATCH and updates local session state', async () => {
    const original = { id: 'ses_1', title: '旧标题', createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z' };
    const updated = { ...original, title: '重命名的标题', updatedAt: '2026-09-14T11:00:00.000Z' };

    (mockTransport.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: [original] })
      .mockResolvedValueOnce(updated);

    const { sessions, fetchSessions, renameSession } = useAervoxSessions();
    await fetchSessions();
    expect(sessions.value[0].title).toBe('旧标题');

    const res = await renameSession('ses_1', '重命名的标题');
    expect(res?.title).toBe('重命名的标题');
    expect(sessions.value[0].title).toBe('重命名的标题');
    expect(mockTransport.request).toHaveBeenCalledWith('PATCH', '/v1/sessions/ses_1', {
      title: '重命名的标题',
    });
  });

  it('deleteSession sends DELETE and safely switches active session', async () => {
    const ses1 = { id: 'ses_1', title: '会话 1', createdAt: '2026-09-14T10:00:00.000Z', updatedAt: '2026-09-14T10:00:00.000Z' };
    const ses2 = { id: 'ses_2', title: '会话 2', createdAt: '2026-09-14T09:00:00.000Z', updatedAt: '2026-09-14T09:00:00.000Z' };

    (mockTransport.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ items: [ses1, ses2] })
      .mockResolvedValueOnce(undefined);

    const { sessions, activeSessionId, fetchSessions, deleteSession } = useAervoxSessions();
    await fetchSessions();
    expect(activeSessionId.value).toBe('ses_1');

    await deleteSession('ses_1');
    expect(sessions.value).toHaveLength(1);
    expect(sessions.value[0].id).toBe('ses_2');
    expect(activeSessionId.value).toBe('ses_2');
    expect(mockTransport.request).toHaveBeenCalledWith('DELETE', '/v1/sessions/ses_1');
  });
  it.each([401, 503])('keeps authoritative state when session writes fail with %i', async status => {
    const original = { id: 'ses_1', title: 'original', projectId: null, createdAt: '2026-10-13', updatedAt: '2026-10-13' };
    const api = useAervoxSessions();
    api.sessions.value = [original];
    api.switchSession(original.id);
    vi.mocked(mockTransport.request).mockRejectedValue(new Error('HTTP ' + status));
    await expect(api.createNewSession('new')).rejects.toThrow('HTTP ' + status);
    await expect(api.renameSession('ses_1', 'changed')).rejects.toThrow('HTTP ' + status);
    await expect(api.deleteSession('ses_1')).rejects.toThrow('HTTP ' + status);
    expect(api.sessions.value).toEqual([original]);
    expect(api.activeSessionId.value).toBe('ses_1');
    expect(store[ACTIVE_SESSION_STORAGE_KEY]).toBe('ses_1');
    expect(api.error.value).toBe('HTTP ' + status);
  });
  it('does not revive a deleted last session if creating its replacement fails', async () => {
    const api = useAervoxSessions();
    api.sessions.value = [{ id: 'ses_1', title: 'original', projectId: null, createdAt: '2026-10-13', updatedAt: '2026-10-13' }];
    api.switchSession('ses_1');
    vi.mocked(mockTransport.request).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('HTTP 503'));
    await expect(api.deleteSession('ses_1')).resolves.toBe(true);
    expect(api.sessions.value).toEqual([]);
    expect(api.activeSessionId.value).toBe('');
    expect(api.error.value).toBe('HTTP 503');
  });

});

it('does not let a pre-create list request replace the confirmed new session', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const item = (id: string) => ({id, title: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'});
  const request = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(item('new'));
  configureAervoxClient({sessionId: 'old', transport: {request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()}});
  const api = useAervoxSessions();
  const load = api.fetchSessions();
  await api.createNewSession('new');
  finish({items: [item('old')]}); await load;
  expect(api.sessions.value.map(row => row.id)).toEqual(['new']);
  expect(api.activeSessionId.value).toBe('new');
  expect(getSessionId()).toBe('new');
});

it('preserves explicit selection when a project-filtered list excludes it', async () => {
  const item = (id: string) => ({id, title: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'});
  const request = vi.fn().mockResolvedValue({items: [item('project-A')]});
  configureAervoxClient({sessionId: 'selected-B', transport: {request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()}});
  const api = useAervoxSessions();
  api.switchSession('selected-B');
  await api.fetchSessions({projectId: 'A'});
  expect(api.activeSessionId.value).toBe('selected-B');
});

it('ignores older project reads and pre-delete snapshots without reviving deleted sessions', async () => {
  const {createAervoxClient} = await import('../src/transport.js');
  const item = (id: string) => ({id, title: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'});
  const loads: ((value: unknown) => void)[] = [];
  const request = vi.fn(async (method: string) => method === 'GET' ? new Promise(resolve => loads.push(resolve)) : undefined);
  const client = createAervoxClient({sessionId: 'keep', transport: {request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()}});
  const api = useAervoxSessions(client);
  const old = api.fetchSessions({projectId: 'A'});
  const fresh = api.fetchSessions({projectId: 'B'});
  loads[1]!({items: [item('B'), item('keep')]}); await fresh;
  loads[0]!({items: [item('A')]}); await old;
  expect(api.sessions.value.map(row => row.id)).toEqual(['B', 'keep']);
  const beforeDelete = api.fetchSessions();
  await api.deleteSession('B');
  loads[2]!({items: [item('B'), item('keep')]}); await beforeDelete;
  expect(api.sessions.value.map(row => row.id)).toEqual(['keep']);
  expect(api.activeSessionId.value).toBe('keep');
});
