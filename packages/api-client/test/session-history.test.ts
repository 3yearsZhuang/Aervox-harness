import { describe, expect, it, vi } from 'vitest';
import { createSessionHistoryClient, type AervoxTransport } from '../src/transport.js';
const response = { sessionId: 'session', items: [], nextCursor: null };
function fixture(value: unknown = response) {
  const request = vi.fn(async () => value);
  return { request, client: createSessionHistoryClient({ request } as unknown as AervoxTransport) };
}
describe('headless owner history client', () => {
  it('requests one explicit shared-contract page and carries cancellation', async () => {
    const { client, request } = fixture(); const controller = new AbortController();
    expect(await client.getPage('session', { limit: 2, cursor: 'Y3Vyc29y', signal: controller.signal })).toEqual(response);
    expect(request).toHaveBeenCalledExactlyOnceWith('GET', '/v1/sessions/session/history?limit=2&cursor=Y3Vyc29y', undefined, { signal: controller.signal });
  });
  it('encodes complete session identities and leaves the default limit to the server', async () => {
    const { client, request } = fixture(); await client.getPage('session\0/尾');
    expect(request).toHaveBeenCalledExactlyOnceWith('GET', '/v1/sessions/session%00%2F%E5%B0%BE/history', undefined);
  });
  it('rejects invalid request and response shapes without retrying or executing a Turn', async () => {
    const { client, request } = fixture();
    await expect(client.getPage('session', { limit: 51 })).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
    const invalid = fixture({ sessionId: 'session', items: [{ turnId: 'bad' }], nextCursor: null });
    await expect(invalid.client.getPage('session')).rejects.toThrow(); expect(invalid.request).toHaveBeenCalledTimes(1);
  });
  it('drops a late response when the transport ignores abort', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return response; });
    await expect(createSessionHistoryClient({ request } as unknown as AervoxTransport).getPage('session', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
