import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginConfigApi } from '@aervox/contracts';
import { requestEndpoint } from '../src/endpoint.js';
import type { AervoxTransport } from '../src/transport.js';

type RequestOptions = Parameters<AervoxTransport['request']>[3];
const endpoint = pluginConfigApi.listPages;
const params = { pluginId: 'plugin/a?b' };
const query = { expectedLifecycleGeneration: 'generation/a?b' };
const response = { pages: [] };

function connection(request: (...args: Parameters<AervoxTransport['request']>) => Promise<unknown>): AervoxTransport {
  return { request } as AervoxTransport;
}

afterEach(() => vi.restoreAllMocks());

describe('shared endpoint request cancellation', () => {
  it('keeps the existing three transport arguments when options are omitted', async () => {
    const request = vi.fn(async () => response);
    expect(await requestEndpoint(connection(request), endpoint, undefined, params, query)).toEqual(response);
    expect(request).toHaveBeenCalledExactlyOnceWith('GET',
      '/v1/plugins/plugin%2Fa%3Fb/pages?expectedLifecycleGeneration=generation%2Fa%3Fb', undefined);
  });

  it('forwards the same request options and signal without adding either to the query', async () => {
    const request = vi.fn(async () => response);
    const options: RequestOptions = { signal: new AbortController().signal, headers: { 'X-Request-Context': 'page-observation' } };
    expect(await requestEndpoint(connection(request), endpoint, undefined, params, query, options)).toEqual(response);
    expect(request).toHaveBeenCalledExactlyOnceWith('GET',
      '/v1/plugins/plugin%2Fa%3Fb/pages?expectedLifecycleGeneration=generation%2Fa%3Fb', undefined, options);
    expect(request.mock.calls[0]![3]).toBe(options);
  });

  it('rejects an already cancelled request before validation or transport', async () => {
    const reason = new Error('page observation was stopped');
    const request = vi.fn(async () => response);
    const validate = vi.spyOn(endpoint.query, 'parse');
    const parse = vi.spyOn(endpoint.response, 'parse');
    await expect(requestEndpoint(connection(request), endpoint, undefined, params, query, { signal: AbortSignal.abort(reason) }))
      .rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it('discards a late transport result after cancellation before response parsing', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const parse = vi.spyOn(endpoint.response, 'parse');
    const controller = new AbortController();
    const reason = new Error('page document was replaced');
    const pending = requestEndpoint(connection(request), endpoint, undefined, params, query, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    finish({ pages: [{ invalid: 'this late result must not be parsed' }] });
    await rejected;
    expect(parse).not.toHaveBeenCalled();
  });

  it('still validates responses for a live signal and preserves a completed result', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => response);
    const parsed = await requestEndpoint(connection(request), endpoint, undefined, params, query, { signal: controller.signal });
    expect(parsed).toEqual(response);
    controller.abort(new Error('closed after completion'));
    expect(parsed).toEqual(response);
    request.mockResolvedValue({ pages: [{ invalid: true }] } as never);
    await expect(requestEndpoint(connection(request), endpoint, undefined, params, query, { signal: new AbortController().signal }))
      .rejects.toThrow();
  });

  it('preserves transport failures without parsing a response', async () => {
    const reason = new Error('network unavailable');
    const request = vi.fn(async () => { throw reason; });
    const parse = vi.spyOn(endpoint.response, 'parse');
    await expect(requestEndpoint(connection(request), endpoint, undefined, params, query, { signal: new AbortController().signal }))
      .rejects.toBe(reason);
    expect(parse).not.toHaveBeenCalled();
  });
});
