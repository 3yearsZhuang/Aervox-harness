// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { nativeRequest } from './fixtures/native-process-channel';
import { createNativeModelProvider, SAFE_PREFIX } from './fixtures/native-process-model';

afterEach(() => { delete window.AervoxM0Native; document.body.replaceChildren(); });

it('keeps real native runtime transport but refuses every model operation except the fixed summary', async () => {
  const operations: unknown[] = [];
  const channel = { onmessage: null as ((event: { data: string }) => void) | null,
    postMessage(message: string) {
      const request = JSON.parse(message); operations.push(request.body);
      channel.onmessage?.({ data: JSON.stringify({ version: 1, id: request.id, result: { kind: 'runtime', sqlite: 'ready' } }) });
    } };
  window.AervoxM0Native = channel;
  expect(await nativeRequest({ op: 'model', operation: 'summary' })).toEqual({ kind: 'summary', hasCredential: true });
  for (const operation of ['start', 'poll', 'configure', 'clear', 'cancel']) {
    await expect(nativeRequest({ op: 'model', operation })).rejects.toThrow('DETERMINISTIC_PROVIDER_ONLY');
  }
  expect(operations).toEqual([]);
  expect(await nativeRequest({ op: 'runtime' })).toEqual({ kind: 'runtime', sqlite: 'ready' });
  expect(operations).toEqual([{ op: 'runtime' }]);
});

it('requires the test marker, emits one safe prefix and stays pending until caller cancellation', async () => {
  const control = new AbortController();
  const input = { turnId: 'probe', attemptId: 'attempt', step: 1, signal: control.signal,
    context: { turnId: 'probe', sessionId: 'session', messages: [{ role: 'user' as const, content: 'probe' }] } };
  const provider = createNativeModelProvider();
  await expect(provider.stream(input).next()).rejects.toThrow('PROBE_BUILD_REQUIRED');
  const marker = document.createElement('aside'); marker.id = 'termination-probe'; document.body.append(marker);
  const iterator = provider.stream(input);
  expect(await iterator.next()).toEqual({ done: false, value: { text: SAFE_PREFIX, isFinal: false } });
  expect(marker.dataset.modelStarts).toBe('1');
  const pending = iterator.next();
  control.abort();
  await expect(pending).rejects.toThrow('MODEL_CANCELLED');
  expect((await iterator.next()).done).toBe(true);
});
