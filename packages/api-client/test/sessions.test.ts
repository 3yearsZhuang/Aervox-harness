import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import {
  ACTIVE_SESSION_STORAGE_KEY,
  AervoxHttpError,
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

  it('can create a session without replacing the current execution selection', async () => {
    const newSession = { id: 'ses_new', title: '新对话', createdAt: 'now', updatedAt: 'now' };
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(newSession);
    const sessions = useAervoxSessions();
    await expect(sessions.createNewSession('新对话', undefined, undefined, { select: false })).resolves.toEqual(newSession);
    expect(sessions.sessions.value).toEqual([newSession]);
    expect(sessions.activeSessionId.value).toBe('ses_initial');
    expect(getSessionId()).toBe('ses_initial');
  });

  it('can commit deletion while leaving replacement selection to the surface', async () => {
    (mockTransport.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const sessions = useAervoxSessions();
    sessions.sessions.value = [{ id: 'ses_initial', title: '原会话', createdAt: 'now', updatedAt: 'now' }];
    await expect(sessions.deleteSession('ses_initial', { select: false })).resolves.toBe(true);
    expect(sessions.sessions.value).toEqual([]);
    expect(sessions.activeSessionId.value).toBe('ses_initial');
    expect(getSessionId()).toBe('ses_initial');
    expect(mockTransport.request).toHaveBeenCalledExactlyOnceWith('DELETE', '/v1/sessions/ses_initial');
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

  it('checks the exact target after a lost DELETE receipt without another DELETE or replacement POST', async () => {
    const original = { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' };
    const api = useAervoxSessions(); api.sessions.value = [original];
    vi.mocked(mockTransport.request).mockRejectedValueOnce(new TypeError('receipt lost'))
      .mockRejectedValueOnce(new AervoxHttpError(404, '/v1/sessions/ses_initial', { code: 'SESSION_NOT_FOUND' }));
    await expect(api.deleteSession(original.id)).rejects.toThrow('receipt lost');
    expect(api.sessions.value).toEqual([original]);
    await expect(api.checkSessionDeletion(original.id)).resolves.toBe('missing');
    expect(vi.mocked(mockTransport.request).mock.calls).toEqual([
      ['DELETE', '/v1/sessions/ses_initial'], ['GET', '/v1/sessions/ses_initial'],
    ]);
    expect(api.sessions.value).toEqual([]); expect(getSessionId()).toBe('');
  });

  it.each([
    new AervoxHttpError(404, '/v1/sessions/ses_initial'),
    new AervoxHttpError(404, '/v1/sessions/ses_initial', { code: 'SOURCE_RETIRED' }),
    new TypeError('network failed'),
  ])('does not confirm deletion from an unclassified or unrelated failed read: %s', async error => {
    const original = { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' };
    const api = useAervoxSessions(); api.sessions.value = [original];
    vi.mocked(mockTransport.request).mockRejectedValueOnce(error);
    await expect(api.checkSessionDeletion(original.id)).rejects.toBe(error);
    expect(api.sessions.value).toEqual([original]); expect(getSessionId()).toBe(original.id);
    expect(mockTransport.request).toHaveBeenCalledExactlyOnceWith('GET', '/v1/sessions/ses_initial');
  });

  it.each([null, {}, { id: 'other', title: 'other', createdAt: '', updatedAt: '' },
    { id: 'ses_initial', title: 12, createdAt: '', updatedAt: '' }])('keeps deletion unconfirmed for a malformed or mismatched successful response: %j', async response => {
    const original = { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' };
    const api = useAervoxSessions(); api.sessions.value = [original];
    vi.mocked(mockTransport.request).mockResolvedValueOnce(response);
    await expect(api.checkSessionDeletion(original.id)).rejects.toThrow('SESSION_DELETE_CHECK_INVALID_RESPONSE');
    expect(api.sessions.value).toEqual([original]); expect(getSessionId()).toBe(original.id);
  });

  it('leaves a recreated same-ID session present and never authorizes the old DELETE again', async () => {
    const original = { id: 'ses_initial', title: 'original', createdAt: 'old', updatedAt: 'old' };
    const rebuilt = { ...original, title: 'rebuilt', createdAt: 'new', updatedAt: 'new' };
    const api = useAervoxSessions(); api.sessions.value = [original];
    vi.mocked(mockTransport.request).mockResolvedValueOnce(rebuilt);
    await expect(api.checkSessionDeletion(original.id)).resolves.toBe('present');
    expect(api.sessions.value).toEqual([rebuilt]); expect(getSessionId()).toBe(original.id);
    expect(mockTransport.request).toHaveBeenCalledExactlyOnceWith('GET', '/v1/sessions/ses_initial');
  });

  it.each(['delete', 'check'] as const)('does not transfer a newer selection when a disposed scope receives a late %s result', async action => {
    const scope = effectScope(); const api = scope.run(() => useAervoxSessions())!;
    api.sessions.value = [
      { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' },
      { id: 'next', title: 'next', createdAt: '', updatedAt: '' },
    ];
    let finish!: () => void;
    vi.mocked(mockTransport.request).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => action === 'delete' ? resolve(undefined) : reject(new AervoxHttpError(404, '/v1/sessions/ses_initial', { code: 'SESSION_NOT_FOUND' }));
    }));
    const onSelectionTransfer = vi.fn();
    const pending = action === 'delete' ? api.deleteSession('ses_initial', { onSelectionTransfer }) : api.checkSessionDeletion('ses_initial', { onSelectionTransfer });
    scope.stop(); setSessionId('new_owner'); finish();
    if (action === 'check') await expect(pending).rejects.toThrow('SESSION_DELETE_CHECK_OBSERVATION_RETIRED');
    else await pending;
    expect(getSessionId()).toBe('new_owner'); expect(onSelectionTransfer).not.toHaveBeenCalled();
    expect(api.sessions.value.map(item => item.id)).toEqual(action === 'check' ? ['ses_initial', 'next'] : ['next']);
    expect(mockTransport.request).toHaveBeenCalledTimes(1);
  });

  it.each(['selection', 'away-and-back', 'same-ID-list-refresh', 'same-ID-selected-metadata'] as const)(
    'keeps a late missing check unknown after its observation retires through %s', async retirement => {
      const original = { id: 'ses_initial', title: 'original', createdAt: 'old', updatedAt: 'old' };
      const rebuilt = { ...original, title: 'new local object', createdAt: 'new', updatedAt: 'new' };
      const api = useAervoxSessions();
      if (retirement === 'same-ID-selected-metadata') {
        vi.mocked(mockTransport.request).mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce(original);
        await api.fetchSessions({ preserveSelection: true, includeActive: true });
      } else api.sessions.value = [original];
      let finish!: () => void;
      vi.mocked(mockTransport.request).mockImplementationOnce(() => new Promise((_resolve, reject) => {
        finish = () => reject(new AervoxHttpError(404, '/v1/sessions/ses_initial', { code: 'SESSION_NOT_FOUND' }));
      }));
      const onAbsenceConfirmed = vi.fn(); const onSelectionTransfer = vi.fn();
      const pending = api.checkSessionDeletion(original.id, { onAbsenceConfirmed, onSelectionTransfer });
      if (retirement === 'selection' || retirement === 'away-and-back') {
        setSessionId('new_owner');
        if (retirement === 'away-and-back') setSessionId(original.id);
      } else {
        vi.mocked(mockTransport.request).mockResolvedValueOnce({ items: retirement === 'same-ID-list-refresh' ? [rebuilt] : [] });
        if (retirement === 'same-ID-selected-metadata') vi.mocked(mockTransport.request).mockResolvedValueOnce(rebuilt);
        await api.fetchSessions({ preserveSelection: true, includeActive: true });
      }
      finish(); await expect(pending).rejects.toThrow('SESSION_DELETE_CHECK_OBSERVATION_RETIRED');
      expect(onAbsenceConfirmed).not.toHaveBeenCalled(); expect(onSelectionTransfer).not.toHaveBeenCalled();
      if (retirement === 'same-ID-selected-metadata') expect(api.activeSession.value).toEqual(rebuilt);
      else expect(api.sessions.value).toEqual([retirement === 'same-ID-list-refresh' ? rebuilt : original]);
      expect(vi.mocked(mockTransport.request).mock.calls.every(([method]) => method === 'GET')).toBe(true);
    },
  );

  it('rechecks observation ownership after synchronous absence cleanup reenters selection', async () => {
    const original = { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' };
    const api = useAervoxSessions(); api.sessions.value = [original];
    vi.mocked(mockTransport.request).mockRejectedValueOnce(new AervoxHttpError(404, '/v1/sessions/ses_initial', { code: 'SESSION_NOT_FOUND' }));
    const onSelectionTransfer = vi.fn();
    await expect(api.checkSessionDeletion(original.id, { onSelectionTransfer, onAbsenceConfirmed: isCurrent => {
      expect(isCurrent()).toBe(true); setSessionId('new_owner'); expect(isCurrent()).toBe(false);
    } })).rejects.toThrow('SESSION_DELETE_CHECK_OBSERVATION_RETIRED');
    expect(api.sessions.value).toEqual([original]); expect(getSessionId()).toBe('new_owner');
    expect(onSelectionTransfer).not.toHaveBeenCalled();
  });

  it('does not reclaim an owner selected away and back while DELETE is pending', async () => {
    const api = useAervoxSessions();
    api.sessions.value = [
      { id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' },
      { id: 'next', title: 'next', createdAt: '', updatedAt: '' },
    ];
    let finish!: () => void;
    vi.mocked(mockTransport.request).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    const onSelectionTransfer = vi.fn(); const pending = api.deleteSession('ses_initial', { onSelectionTransfer });
    setSessionId('elsewhere'); setSessionId('ses_initial'); finish(); await pending;
    expect(getSessionId()).toBe('ses_initial'); expect(onSelectionTransfer).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('retires automatic replacement ownership after leaving and returning to empty when POST will %s', async outcome => {
    const api = useAervoxSessions();
    api.sessions.value = [{ id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' }];
    let finish!: () => void;
    vi.mocked(mockTransport.request).mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => outcome === 'resolve' ? resolve({ id: 'replacement', title: 'new', createdAt: '', updatedAt: '' }) : reject(new Error('POST failed'));
    }));
    const onSelectionTransfer = vi.fn(); const pending = api.deleteSession('ses_initial', { onSelectionTransfer });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(getSessionId()).toBe(''); expect(onSelectionTransfer).toHaveBeenCalledTimes(1);
    setSessionId('new_owner'); setSessionId(''); finish(); await pending;
    expect(getSessionId()).toBe(''); expect(onSelectionTransfer).toHaveBeenCalledTimes(1);
  });

  it('does not notify presentation or create a replacement after reentrant selection inside a transfer', async () => {
    const { useAervoxClient } = await import('../src/client-context.js');
    const client = useAervoxClient(); const api = useAervoxSessions(client);
    api.sessions.value = [{ id: 'ses_initial', title: 'original', createdAt: '', updatedAt: '' }];
    let reentered = false;
    const unsubscribe = client.subscribeSession(id => { if (id === '' && !reentered) {
      reentered = true; client.setSessionId('elsewhere'); client.setSessionId('');
    } });
    vi.mocked(mockTransport.request).mockResolvedValueOnce(undefined);
    const onSelectionTransfer = vi.fn();
    try { await api.deleteSession('ses_initial', { onSelectionTransfer }); }
    finally { unsubscribe(); }
    expect(getSessionId()).toBe(''); expect(onSelectionTransfer).not.toHaveBeenCalled();
    expect(mockTransport.request).toHaveBeenCalledTimes(1);
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
