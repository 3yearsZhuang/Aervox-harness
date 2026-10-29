import type { ModelProviderPort, ModelRequest } from '@aervox/core/browser';
import { nativeRequest } from './native-channel';

type NativeRequest = (body: Record<string, unknown>) => Promise<unknown>;
const invalid = () => new Error('INVALID_NATIVE_MODEL_RECEIPT');
const fixedErrors = new Set(['PROVIDER_AUTH_REJECTED', 'PROVIDER_RATE_LIMITED', 'PROVIDER_REQUEST_FAILED',
  'REDIRECT_REJECTED', 'INVALID_RESPONSE', 'TRUNCATED_RESPONSE', 'RESPONSE_LIMIT', 'NETWORK_TIMEOUT',
  'NETWORK_UNAVAILABLE', 'DEADLINE_EXCEEDED', 'UNSUPPORTED_MODEL_TOOL']);
const encoder = new TextEncoder();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function abortError() { return new Error('MODEL_CANCELLED'); }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
/** Observation can stop immediately; accepted native work is cancelled separately. */
async function receipt(operation: Promise<unknown>, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal?.removeEventListener('abort', abort); resolve(value); },
      () => { signal?.removeEventListener('abort', abort); reject(new Error('NATIVE_MODEL_REQUEST_FAILED')); });
    if (signal?.aborted) abort();
  });
}
export async function delay(ms: number, signal?: AbortSignal) {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(finish, ms); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export function createNativeModelProvider(send: NativeRequest = nativeRequest, onNativeCancelled?: (request: ModelRequest) => Promise<void>): ModelProviderPort {
  return {
    id: 'android-native',
    async *stream(request) {
      const requestId = crypto.randomUUID();
      let sequence = 0, completed = false, cancelSent = false, bytes = 0, polls = 0;
      let stopReason: string | undefined;
      const cancel = () => {
        if (cancelSent) return;
        cancelSent = true;
        try { void send({ op: 'model', operation: 'cancel', requestId }).catch(() => undefined); }
        catch { /* Cancellation receipt is unknown; never expose a native body. */ }
      };
      checkAbort(request.signal);
      try {
        request.signal?.addEventListener('abort', cancel, { once: true });
        checkAbort(request.signal);
        const started = object(await receipt(send({ op: 'model', operation: 'start', requestId,
          messages: request.context.messages.map(({ role, content }) => ({ role, content })),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          maxTokens: Math.min(request.maxOutputTokens ?? 2048, 4096),
        }), request.signal));
        if (started.kind !== 'started' || started.requestId !== requestId) throw invalid();
        for (;;) {
          checkAbort(request.signal);
          if (++polls > 4096) throw new Error('NATIVE_MODEL_POLL_LIMIT');
          const result = object(await receipt(send({ op: 'model', operation: 'poll', requestId, afterSequence: sequence }), request.signal));
          if (result.kind !== 'chunks' || result.requestId !== requestId || !Array.isArray(result.events) || result.events.length > 64
            || !['running', 'completed', 'cancelled', 'failed'].includes(String(result.status))) throw invalid();
          let terminal = false;
          for (let index = 0; index < result.events.length; index++) {
            const event = object(result.events[index]);
            if (!Number.isSafeInteger(event.sequence) || event.sequence !== sequence + 1 || sequence >= 8192) throw new Error('INVALID_NATIVE_MODEL_SEQUENCE');
            sequence++;
            if (event.type === 'error') throw new Error(typeof event.code === 'string' && fixedErrors.has(event.code) ? event.code : 'MODEL_FAILED');
            if (event.type === 'done') {
              if (index !== result.events.length - 1 || result.status === 'running') throw invalid();
              terminal = true;
            } else if (event.type === 'data') {
              if (typeof event.data !== 'string' || encoder.encode(event.data).byteLength > 64 * 1024) throw invalid();
              bytes += encoder.encode(event.data).byteLength;
              if (bytes > 2 * 1024 * 1024) throw new Error('RESPONSE_LIMIT');
              let chunk: Record<string, unknown>;
              try { chunk = object(JSON.parse(event.data)); } catch { throw invalid(); }
              if (!Array.isArray(chunk.choices) || chunk.choices.length !== 1) throw invalid();
              const choice = object(chunk.choices[0]), delta = object(choice.delta);
              if (choice.index !== 0 || delta.content !== undefined && typeof delta.content !== 'string'
                || delta.reasoning_content !== undefined && typeof delta.reasoning_content !== 'string') throw invalid();
              if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
                if (stopReason || !['stop', 'length', 'content_filter'].includes(String(choice.finish_reason))) throw invalid();
                stopReason = String(choice.finish_reason);
              }
              yield { text: delta.content as string | undefined ?? '', reasoning: delta.reasoning_content as string | undefined, isFinal: false };
            } else throw invalid();
          }
          if (result.nextSequence !== sequence) throw new Error('INVALID_NATIVE_MODEL_SEQUENCE');
          // Native status describes the producer, while events are paginated.
          // A completed producer can still have many pages of unread tokens.
          if (terminal) {
            if (result.status === 'cancelled') await onNativeCancelled?.(request);
            if (result.status !== 'completed') throw new Error(result.status === 'cancelled' ? 'MODEL_CANCELLED' : 'MODEL_FAILED');
            if (!stopReason) throw invalid();
            completed = true; yield { text: '', isFinal: true, stopReason }; return;
          }
          if (result.status !== 'running' && result.events.length === 0) throw invalid();
          if (result.status === 'running') await delay(80, request.signal);
        }
      } finally {
        request.signal?.removeEventListener('abort', cancel);
        if (!completed) cancel();
      }
    },
  };
}
export const nativeModelProvider = createNativeModelProvider();
