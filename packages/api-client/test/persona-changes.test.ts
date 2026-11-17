import { afterEach, expect, it, vi } from 'vitest';
import { notifyPersonaChanged, subscribePersonaChanges } from '../src/persona-changes.js';
import type { AervoxTransport } from '../src/transport.js';

const transport = (): AervoxTransport => ({request: vi.fn(), streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn()});
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

it('isolates local hosts, tolerates listener errors and makes cleanup independent and idempotent', () => {
  const a = transport(); const b = transport();
  const observe = vi.fn(); const other = vi.fn();
  const stop = subscribePersonaChanges(observe, a);
  cleanups.push(stop, subscribePersonaChanges(observe, a), subscribePersonaChanges(other, b),
    subscribePersonaChanges(() => { throw new Error('view closed'); }, a));
  notifyPersonaChanged(a);
  expect(observe).toHaveBeenCalledTimes(2);
  expect(other).not.toHaveBeenCalled();
  stop(); stop();
  notifyPersonaChanged(a);
  expect(observe).toHaveBeenCalledTimes(3);
  notifyPersonaChanged(b);
  expect(other).toHaveBeenCalledTimes(1);
});

it('broadcasts only a generic invalidation and rereads each local host for remote invalidations', () => {
  class Channel {
    static instances: Channel[] = [];
    onmessage: ((event: {data: unknown}) => void) | null = null;
    postMessage = vi.fn(); close = vi.fn();
    constructor(readonly name: string) { Channel.instances.push(this); }
  }
  vi.stubGlobal('window', {});
  vi.stubGlobal('BroadcastChannel', Channel);
  const a = transport(); const b = transport();
  const observeA = vi.fn(); const observeB = vi.fn();
  const stopA = subscribePersonaChanges(observeA, a);
  const stopB = subscribePersonaChanges(observeB, b);
  cleanups.push(stopA, stopB);
  const channel = Channel.instances[0]!;
  notifyPersonaChanged(a);
  expect(channel.postMessage).toHaveBeenCalledWith('changed');
  expect(observeA).toHaveBeenCalledTimes(1);
  expect(observeB).not.toHaveBeenCalled();
  channel.onmessage?.({data: 'unexpected'});
  expect(observeB).not.toHaveBeenCalled();
  channel.onmessage?.({data: 'changed'});
  expect(observeA).toHaveBeenCalledTimes(2);
  expect(observeB).toHaveBeenCalledTimes(1);
  stopA(); stopB();
  expect(channel.close).toHaveBeenCalledTimes(1);
});
