import type { AervoxTransport } from '@aervox/api-client/transport';

type NavigationListener = (event?: {isMainFrame?: boolean; isSameDocument?: boolean}, url?: string, isInPlace?: boolean, isMainFrame?: boolean) => void;

interface EventSender {
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  on(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown;
  removeListener(event: 'destroyed' | 'did-start-navigation', callback: NavigationListener): unknown;
}

/** Renderer 只能订阅已批准的状态通道；凭据、资源和取消所有权留在主进程。 */
export function createApiEventStreams(transport: AervoxTransport, deps: {isTrustedSender?(sender: EventSender): boolean} = {}) {
  const senders = new WeakMap<EventSender, Map<string, AbortController>>();
  function cancel(sender: EventSender, requestId: unknown): void {
    if (typeof requestId === 'string') senders.get(sender)?.get(requestId)?.abort();
  }
  async function start(sender: EventSender, payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object' || sender.isDestroyed() || deps.isTrustedSender?.(sender) === false) return;
    const { requestId, path } = payload as { requestId?: unknown; path?: unknown };
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestId)) return;
    const send = (value: Record<string, unknown>) => {
      if (!sender.isDestroyed() && deps.isTrustedSender?.(sender) !== false) sender.send('aervox:events:event', { requestId, ...value });
    };
    if (path !== '/v1/model-runtime/events' || !transport.streamEvents) {
      send({ type: 'error', message: 'event_stream_not_allowed' });
      return;
    }
    let active = senders.get(sender);
    if (!active) { active = new Map(); senders.set(sender, active); }
    if (active.size >= 16 && !active.has(requestId)) {
      send({ type: 'error', message: 'event_stream_limit' });
      return;
    }
    active.get(requestId)?.abort();
    const controller = new AbortController();
    active.set(requestId, controller);
    const stop = () => controller.abort();
    const stopForNavigation: NavigationListener = (event, _url, isInPlace, isMainFrame) => {
      if ((event?.isMainFrame ?? isMainFrame ?? true) && !(event?.isSameDocument ?? isInPlace ?? false)) stop();
    };
    sender.on('destroyed', stop);
    sender.on('did-start-navigation', stopForNavigation);
    try {
      await transport.streamEvents(path, {
        onEvent(event) { if (!controller.signal.aborted) send({ type: 'event', event }); },
        onHeartbeat() { if (!controller.signal.aborted) send({ type: 'heartbeat' }); },
      }, controller.signal);
      if (!controller.signal.aborted) send({ type: 'closed' });
    } catch (error) {
      if (!controller.signal.aborted) send({ type: 'error', message: error instanceof Error ? error.message : 'event_stream_failed' });
    } finally {
      sender.removeListener('destroyed', stop);
      sender.removeListener('did-start-navigation', stopForNavigation);
      if (active.get(requestId) === controller) active.delete(requestId);
    }
  }
  return { start, cancel };
}
