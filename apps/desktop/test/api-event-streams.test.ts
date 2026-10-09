import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createApiEventStreams } from '../src/main/api-event-streams';
import type { AervoxTransport } from '@aervox/api-client/transport';

class Sender extends EventEmitter {
  send = vi.fn();
  isDestroyed() { return false; }
}

describe('API event stream ownership', () => {
  it('隔离取消所有者，导航释放资源且丢弃迟到回调', async () => {
    let callbacks!: Parameters<NonNullable<AervoxTransport['streamEvents']>>[1];
    let signal!: AbortSignal;
    const streamEvents = vi.fn(async (_path, cb, abort) => {
      callbacks = cb; signal = abort;
      await new Promise<void>(resolve => abort.addEventListener('abort', () => resolve(), { once: true }));
    });
    const streams = createApiEventStreams({ streamEvents } as unknown as AervoxTransport);
    const a = new Sender(); const b = new Sender();
    const pending = streams.start(a, { requestId: 'request_123', path: '/v1/model-runtime/events' });
    streams.cancel(b, 'request_123');
    expect(signal.aborted).toBe(false);
    a.emit('did-start-navigation');
    expect(signal.aborted).toBe(true);
    callbacks.onEvent({ late: true });
    await pending;
    expect(a.send).not.toHaveBeenCalled();
    expect(a.listenerCount('destroyed')).toBe(0);
  });
  it('禁止订阅未声明的端点', async () => {
    const streamEvents = vi.fn();
    const streams = createApiEventStreams({ streamEvents } as unknown as AervoxTransport);
    const sender = new Sender();
    await streams.start(sender, { requestId: 'request_123', path: '//foreign.test/events' });
    expect(streamEvents).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith('aervox:events:event', expect.objectContaining({ type: 'error' }));
  });
});
