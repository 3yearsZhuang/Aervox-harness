import { sessionHistoryApi } from '@aervox/contracts';
import type { AervoxTransport } from './transport.js';
import { requestEndpoint } from './endpoint.js';

/** Let headless callers validate identifiers without importing HTTP contracts. */
export function isValidSessionHistoryId(value: unknown): value is string {
  return sessionHistoryApi.get.params.safeParse({ sessionId: value }).success;
}

/** One explicit page; no automatic paging, execution, retries or hidden cache. */
export function createSessionHistoryClient(transport: AervoxTransport) {
  return { getPage: (sessionId: string, input: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) =>
    requestEndpoint(transport, sessionHistoryApi.get, undefined, { sessionId }, {
      ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, input.signal === undefined ? undefined : { signal: input.signal }),
  };
}
