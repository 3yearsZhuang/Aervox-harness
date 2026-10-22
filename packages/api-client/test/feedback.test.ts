import { describe, expect, it, vi } from 'vitest';
import { AervoxHttpError, configureAervoxClient, type AervoxTransport } from '../src/transport.js';
import { useAervoxFeedback } from '../src/useAervoxFeedback.js';
import { useAervoxApi } from '../src/useAervoxApi.js';

// Suppress unrelated automatic learning loads while exercising the legacy composable.
vi.mock('vue', async (importOriginal) => ({ ...await importOriginal<typeof import('vue')>(), onMounted: vi.fn() }));

function transport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
  return { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
}
const input = { subjectType: 'plugin:extension', subjectId: 'subject', type: 'plugin:quality' };
const row = { ...input, id: 'fb', actorId: 'server_actor', note: null, createdAt: 'historical' };

describe('feedback shared client', () => {
  it('validates both operations, strips legacy ownership fields and encodes paired filters', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = useAervoxFeedback(transport(async (method, path, body) => {
      calls.push([method, path, body]);
      return method === 'POST' ? row : { items: [row] };
    }));
    expect(await api.createFeedback({ ...input, actorId: 'spoof', note: null } as never)).toEqual(row);
    expect(await api.listFeedback({ subjectType: 'plugin/a?b', subjectId: 'a b&c' })).toEqual([row]);
    expect(calls).toEqual([
      ['POST', '/v1/feedback', { ...input, note: null }],
      ['GET', '/v1/feedback?subjectType=plugin%2Fa%3Fb&subjectId=a+b%26c', undefined],
    ]);
  });

  it('preserves absent, empty and single filter requests', async () => {
    const request = vi.fn(async (_method: string, _path: string, _body?: unknown) => ({ items: [] }));
    const api = useAervoxFeedback(transport(request));
    for (const query of [undefined, {}, { subjectType: '' }, { subjectId: '' }, { subjectType: 'plugin' }, { subjectId: 'a' }, { subjectType: 'plugin', subjectId: '' }, { subjectType: '', subjectId: 'a' }]) {
      expect(await api.listFeedback(query)).toEqual([]);
    }
    expect(request.mock.calls.map(call => call[1])).toEqual([
      '/v1/feedback', '/v1/feedback', '/v1/feedback?subjectType=', '/v1/feedback?subjectId=',
      '/v1/feedback?subjectType=plugin', '/v1/feedback?subjectId=a', '/v1/feedback?subjectType=plugin&subjectId=', '/v1/feedback?subjectType=&subjectId=a',
    ]);
  });

  it('rejects malformed inputs before transport and malformed rows after transport', async () => {
    let response: unknown = row;
    const request = vi.fn(async () => response);
    const api = useAervoxFeedback(transport(request));
    for (const invalid of [{ ...input, subjectType: {} }, { ...input, subjectId: [] }, { ...input, type: '' }, { ...input, note: 42 }]) {
      await expect(api.createFeedback(invalid as never)).rejects.toThrow();
    }
    await expect(api.listFeedback({ subjectId: ['a', 'b'] } as never)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    for (const invalid of [{ ...row, actorId: 42 }, { ...row, note: undefined }, { ...row, createdAt: null }, undefined]) {
      response = invalid;
      await expect(api.createFeedback(input)).rejects.toThrow();
    }
    response = { items: [{ ...row, type: 42 }] };
    await expect(api.listFeedback()).rejects.toThrow();
    response = [];
    await expect(api.listFeedback()).rejects.toThrow();
  });

  it('propagates HTTP failures without retrying writes or reads', async () => {
    const failure = new AervoxHttpError(500, 'Internal Server Error', { code: 'INTERNAL_ERROR' });
    const request = vi.fn(async () => { throw failure; });
    const api = useAervoxFeedback(transport(request));
    await expect(api.createFeedback(input)).rejects.toBe(failure);
    await expect(api.listFeedback()).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('keeps legacy submitFeedback returning void while validating input and success', async () => {
    let response: unknown = row;
    const request = vi.fn(async () => response);
    configureAervoxClient({ transport: transport(request) });
    const api = useAervoxApi();
    expect(await api.submitFeedback(input.subjectType, input.subjectId, input.type)).toBeUndefined();
    expect(request).toHaveBeenCalledWith('POST', '/v1/feedback', { ...input, note: undefined });
    await expect(api.submitFeedback(input.subjectType, '', input.type)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    response = {};
    await expect(api.submitFeedback(input.subjectType, input.subjectId, input.type)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
