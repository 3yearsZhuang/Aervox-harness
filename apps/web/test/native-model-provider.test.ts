import { expect, it, vi } from 'vitest';
import type { ModelRequest } from '@aervox/core/browser';
import { createNativeModelProvider, delay } from '../src/mobile/native-model-provider';

const request: ModelRequest = { turnId: 'turn', attemptId: 'attempt', step: 1,
  context: { turnId: 'turn', sessionId: 'session', messages: [{ role: 'user', content: '你好' }] } };
const data = (sequence: number, text: string, finish: string | null = null) => ({ sequence, type: 'data',
  data: JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] }) });
const done = (sequence: number) => ({ sequence, type: 'done' });
function fake(pages: Array<{ events: unknown[]; status: string; nextSequence: number }>) {
  return vi.fn(async (body: Record<string, unknown>) => {
    if (body.operation === 'start') return { kind: 'started', requestId: body.requestId };
    if (body.operation === 'cancel') return { kind: 'cancelled', requestId: body.requestId };
    const page = pages.shift(); if (!page) throw new Error('Unexpected poll');
    return { kind: 'chunks', requestId: body.requestId, ...page };
  });
}
async function collect(send: (body: Record<string, unknown>) => Promise<unknown>, input = request) {
  const chunks = [];
  for await (const chunk of createNativeModelProvider(send).stream(input)) chunks.push(chunk);
  return chunks;
}

it('drains completed native streams across multiple pages before the final chunk', async () => {
  const first = Array.from({ length: 64 }, (_, index) => data(index + 1, `${index},`));
  const send = fake([{ events: first, status: 'completed', nextSequence: 64 },
    { events: [data(65, 'last', 'stop'), done(66)], status: 'completed', nextSequence: 66 }]);
  const chunks = await collect(send);
  expect(chunks.filter(chunk => !chunk.isFinal).map(chunk => chunk.text).join('')).toBe(first.map((_, index) => `${index},`).join('') + 'last');
  expect(chunks.at(-1)).toEqual({ text: '', isFinal: true, stopReason: 'stop' });
  expect(send.mock.calls.filter(([body]) => body.operation === 'poll').map(([body]) => body.afterSequence)).toEqual([0, 64]);
  expect(send.mock.calls.some(([body]) => body.operation === 'cancel')).toBe(false);
});

it('does not swallow a failure on a later page of a finished producer', async () => {
  const send = fake([{ events: Array.from({ length: 64 }, (_, index) => data(index + 1, 'x')), status: 'failed', nextSequence: 64 },
    { events: [{ sequence: 65, type: 'error', code: 'PROVIDER_AUTH_REJECTED' }, done(66)], status: 'failed', nextSequence: 66 }]);
  await expect(collect(send)).rejects.toThrow('PROVIDER_AUTH_REJECTED');
  expect(send.mock.calls.filter(([body]) => body.operation === 'cancel')).toHaveLength(1);
});

it('requires an actual terminal event and finish reason rather than a status flag', async () => {
  for (const page of [
    { events: [], status: 'completed', nextSequence: 0 },
    { events: [done(1)], status: 'running', nextSequence: 1 },
    { events: [done(1)], status: 'completed', nextSequence: 1 },
    { events: [data(1, 'x', 'stop'), done(2), data(3, 'late')], status: 'completed', nextSequence: 3 },
  ]) await expect(collect(fake([page]))).rejects.toThrow('INVALID_NATIVE_MODEL_RECEIPT');
});

it('rejects skipped/repeated cursors and unbounded batches', async () => {
  for (const page of [
    { events: [data(2, 'skipped')], status: 'completed', nextSequence: 2 },
    { events: [data(1, 'x', 'stop'), done(2)], status: 'completed', nextSequence: 3 },
    { events: Array.from({ length: 65 }, (_, index) => data(index + 1, 'x')), status: 'running', nextSequence: 65 },
  ]) await expect(collect(fake([page]))).rejects.toThrow(/INVALID_NATIVE_MODEL/);
});

it('aborts a pending native receipt immediately and sends one cancellation without replay', async () => {
  const abort = new AbortController();
  const send = vi.fn((body: Record<string, unknown>): Promise<unknown> => {
    if (body.operation === 'start') return new Promise(() => {});
    return Promise.resolve({ kind: 'cancelled', requestId: body.requestId });
  });
  const collecting = collect(send, { ...request, signal: abort.signal });
  abort.abort(new Error('private-abort-reason'));
  await expect(collecting).rejects.toThrow('MODEL_CANCELLED');
  expect(send.mock.calls.filter(([body]) => body.operation === 'start')).toHaveLength(1);
  expect(send.mock.calls.filter(([body]) => body.operation === 'cancel')).toHaveLength(1);
});

it('cancels a native stream when the consumer returns early', async () => {
  const send = fake([{ events: [data(1, 'first')], status: 'running', nextSequence: 1 }]);
  const stream = createNativeModelProvider(send).stream(request)[Symbol.asyncIterator]();
  expect((await stream.next()).value.text).toBe('first');
  await stream.return?.();
  expect(send.mock.calls.filter(([body]) => body.operation === 'cancel')).toHaveLength(1);
});

it('keeps raw native failures and malformed data out of error messages', async () => {
  const secret = 'do-not-expose-native-key';
  const send = vi.fn(async () => { throw new Error(secret); });
  await expect(collect(send)).rejects.toThrow('NATIVE_MODEL_REQUEST_FAILED');
  await expect(collect(fake([{ events: [{ sequence: 1, type: 'error', code: secret }], status: 'failed', nextSequence: 1 }]))).rejects.toThrow('MODEL_FAILED');
  await expect(collect(fake([{ events: [{ sequence: 1, type: 'data', data: secret }], status: 'running', nextSequence: 1 }]))).rejects.toThrow('INVALID_NATIVE_MODEL_RECEIPT');
});

it('abortable polling delay rejects with a fixed code and leaves no timer', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController(); const waiting = delay(80, abort.signal);
    abort.abort('private'); await expect(waiting).rejects.toThrow('MODEL_CANCELLED');
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('records native foreground cancellation before surfacing the terminal result', async () => {
  const send = fake([{ events: [done(1)], status: 'cancelled', nextSequence: 1 }]);
  const cancelled = vi.fn(async () => {});
  const provider = createNativeModelProvider(send, cancelled);
  const run = async () => { for await (const _chunk of provider.stream(request)) { /* consume */ } };
  await expect(run()).rejects.toThrow('MODEL_CANCELLED');
  expect(cancelled).toHaveBeenCalledExactlyOnceWith(request);
});
