import { describe, expect, it, vi } from 'vitest';
import { AervoxHttpError, createAervoxClient, useAervoxSessions } from '../src/index.js';
import type { AervoxTransport } from '../src/transport.js';

const item = (id: string) => ({ id, title: `会话 ${id}`, createdAt: '2026-11-06', updatedAt: '2026-11-06' });
function fixture(request: AervoxTransport['request'], selected = 'selected') {
  const transport = { request, streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn() };
  const client = createAervoxClient({ sessionId: selected, transport });
  return { api: useAervoxSessions(client), client, transport };
}

describe('bounded session paging', () => {
  it('restores a selection beyond the first 100 rows without creating or sending anything', async () => {
    const rows = Array.from({ length: 103 }, (_, i) => item(`s${i}`));
    const request = vi.fn(async (_method: string, path: string) => {
      const url = new URL(path, 'https://localhost');
      if (url.pathname === '/v1/sessions/s102') return rows[102];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return { items: rows.slice(offset, offset + limit) };
    });
    const { api, client, transport } = fixture(request as AervoxTransport['request'], 's102');
    await api.fetchSessions({ pageSize: 100, preserveSelection: true, includeActive: true });
    expect(api.sessions.value).toHaveLength(100);
    expect(api.activeSession.value?.id).toBe('s102');
    expect(api.hasMore.value).toBe(true);
    await api.loadMoreSessions();
    expect(api.sessions.value).toHaveLength(103);
    expect(api.hasMore.value).toBe(false);
    expect(client.sessionId).toBe('s102');
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    expect(transport.streamTurn).not.toHaveBeenCalled();
  });

  it('retries a failed page at the same offset and deduplicates a live-list overlap', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [item('a'), item('b')] })
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [item('b'), item('c')] });
    const { api } = fixture(request, 'a');
    await api.fetchSessions({ pageSize: 2, preserveSelection: true });
    await api.loadMoreSessions();
    expect(api.error.value).toBe('offline');
    expect(api.sessions.value.map(row => row.id)).toEqual(['a', 'b']);
    await api.loadMoreSessions();
    expect(request.mock.calls.slice(1).map(call => call[1])).toEqual(['/v1/sessions?limit=2&offset=2', '/v1/sessions?limit=2&offset=2']);
    expect(api.sessions.value.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(api.activeSessionId.value).toBe('a');
  });

  it('does not commit a page that was read before an acknowledged deletion', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const request = vi.fn().mockResolvedValueOnce({ items: [item('a'), item('b')] })
      .mockReturnValueOnce(pending).mockResolvedValueOnce(undefined).mockResolvedValueOnce({ items: [item('c')] });
    const { api } = fixture(request, 'a');
    await api.fetchSessions({ pageSize: 2, preserveSelection: true });
    const old = api.loadMoreSessions();
    await api.deleteSession('b');
    finish({ items: [item('b'), item('c')] }); await old;
    expect(api.sessions.value.map(row => row.id)).toEqual(['a']);
    await api.loadMoreSessions();
    expect(request.mock.calls.at(-1)?.[1]).toBe('/v1/sessions?limit=2&offset=1');
    expect(api.sessions.value.map(row => row.id)).toEqual(['a', 'c']);
  });

  it('keeps a missing or unverified restored identity until the user makes an explicit choice', async () => {
    const request = vi.fn().mockResolvedValueOnce({ items: [item('other')] })
      .mockRejectedValueOnce(new AervoxHttpError(404, '/v1/sessions/selected', { code: 'SESSION_NOT_FOUND', message: 'missing' }));
    const { api, client } = fixture(request);
    await api.fetchSessions({ pageSize: 100, preserveSelection: true, includeActive: true });
    expect(api.activeSession.value).toBeNull();
    expect(api.activeSessionError.value).toContain('已不存在');
    expect(client.sessionId).toBe('selected');
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('discards old selection metadata when the user switches while its read is pending', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const request = vi.fn().mockResolvedValueOnce({ items: [item('other')] }).mockReturnValueOnce(pending);
    const { api } = fixture(request);
    const read = api.fetchSessions({ pageSize: 100, preserveSelection: true, includeActive: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    api.switchSession('other');
    finish(item('selected')); await read;
    expect(api.activeSession.value?.id).toBe('other');
    expect(api.activeSessionError.value).toBeNull();
  });

  it.each([404, 503])('does not let a cached selection override a later identity check failure (%s)', async status => {
    const request = vi.fn().mockResolvedValueOnce({ items: [item('a'), item('b')] })
      .mockResolvedValueOnce({ items: [item('c')] })
      .mockRejectedValueOnce(new AervoxHttpError(status, '/v1/sessions/a', { code: 'SESSION_UNAVAILABLE', message: 'unavailable' }))
      .mockResolvedValueOnce({ items: [item('a'), item('b')] });
    const { api, client } = fixture(request, 'a');
    await api.fetchSessions({ pageSize: 2, preserveSelection: true, includeActive: true });
    expect(api.activeSession.value?.id).toBe('a');
    await api.loadMoreSessions();
    expect(api.sessions.value.map(row => row.id)).toEqual(['a', 'b', 'c']);
    expect(api.activeSession.value).toBeNull();
    expect(api.activeSessionError.value).toContain(status === 404 ? '已不存在' : '未能确认');
    expect(client.sessionId).toBe('a');
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    api.switchSession('b');
    expect(api.activeSession.value?.id).toBe('b');
    api.switchSession('a');
    expect(api.activeSession.value).toBeNull();
    expect(api.activeSessionError.value).toContain(status === 404 ? '已不存在' : '未能确认');
    expect(request).toHaveBeenCalledTimes(3);
    await api.fetchSessions({ pageSize: 2, preserveSelection: true, includeActive: true });
    expect(api.activeSessionError.value).toBeNull();
    expect(api.activeSession.value?.id).toBe('a');
  });

  it('does not let a read for an old selection clear the current identity failure', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const request = vi.fn().mockResolvedValueOnce({ items: [item('a'), item('b')] })
      .mockResolvedValueOnce({ items: [item('c')] })
      .mockRejectedValueOnce(new AervoxHttpError(404, '/v1/sessions/a', { code: 'SESSION_NOT_FOUND', message: 'missing' }))
      .mockResolvedValueOnce({ items: [item('a')] }).mockReturnValueOnce(pending);
    const { api } = fixture(request, 'a');
    await api.fetchSessions({ pageSize: 2, preserveSelection: true, includeActive: true });
    await api.loadMoreSessions();
    api.switchSession('b');
    const oldRead = api.fetchSessions({ pageSize: 2, preserveSelection: true, includeActive: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    api.switchSession('a');
    finish(item('b')); await oldRead;
    expect(api.sessions.value.map(row => row.id)).toEqual(['a']);
    expect(api.activeSession.value).toBeNull();
    expect(api.activeSessionError.value).toContain('已不存在');
  });

  it.each([0, 101, 1.5])('rejects page size %s without a transport request', async pageSize => {
    const request = vi.fn(); const { api } = fixture(request);
    await api.fetchSessions({ pageSize });
    expect(api.error.value).toBe('INVALID_SESSION_PAGE_SIZE');
    expect(request).not.toHaveBeenCalled();
  });
});
