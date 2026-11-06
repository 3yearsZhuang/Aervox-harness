import { getClientTransport } from './client-context.js';
import type { AervoxTransport } from './transport.js';

const listeners = new Map<AervoxTransport, Set<() => void>>();
const channelName = 'aervox:persona-changes';
let channel: BroadcastChannel | undefined;

function dispatch(callbacks: Iterable<() => void>): void {
  for (const callback of [...callbacks]) {
    // A view refresh must not turn an already committed mutation into a failure.
    try { callback(); } catch { /* Other subscribers still receive invalidation. */ }
  }
}

function openChannel(): BroadcastChannel | undefined {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return undefined;
  try {
    const opened = new BroadcastChannel(channelName);
    opened.onmessage = event => {
      if (event.data !== 'changed') return;
      // Cross-window messages contain no persona or host identity. Each view
      // rereads its own captured transport rather than accepting remote data.
      dispatch([...listeners.values()].flatMap(callbacks => [...callbacks]));
    };
    return opened;
  } catch { return undefined; }
}

/** Capture the transport during setup; return the view's listener cleanup. */
export function subscribePersonaChanges(
  listener: () => void,
  transport: AervoxTransport = getClientTransport(),
): () => void {
  let callbacks = listeners.get(transport);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(transport, callbacks);
  }
  // Independent subscriptions of the same callback have independent cleanup.
  const subscription = () => listener();
  callbacks.add(subscription);
  channel ??= openChannel();
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    callbacks.delete(subscription);
    if (!callbacks.size) listeners.delete(transport);
    if (!listeners.size) {
      channel?.close();
      channel = undefined;
    }
  };
}

/** Notify only after a successful mutation, using its originally captured host. */
export function notifyPersonaChanged(transport: AervoxTransport = getClientTransport()): void {
  dispatch(listeners.get(transport) ?? []);
  const broadcaster = channel ?? openChannel();
  try { broadcaster?.postMessage('changed'); } catch { /* Local invalidation already ran. */ }
  if (broadcaster !== channel) broadcaster?.close();
}
