import type { ModelProviderPort } from '@aervox/core/browser';
export { delay } from '../../src/mobile/native-model-provider';

let modelStarts = 0;
export const SAFE_PREFIX = 'terminationprobe_safe_prefix_20261107';

/** A committed safe prefix followed by a suspended model call. Killing the
 * Android process leaves the actual Core lease and SQLite output to recover. */
export function createNativeModelProvider(): ModelProviderPort {
  return {
    id: 'deterministic-process-termination',
    async *stream(request) {
      const signal = request.signal;
      if (!signal) throw new Error('PROBE_SIGNAL_REQUIRED');
      signal.throwIfAborted();
      const marker = document.getElementById('termination-probe');
      if (!marker) throw new Error('PROBE_BUILD_REQUIRED');
      marker.dataset.modelStarts = String(++modelStarts);
      marker.textContent = `专用确定性测试 · 模型启动 ${modelStarts}`;
      yield { text: SAFE_PREFIX, isFinal: false };
      await new Promise<never>((_resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('MODEL_CANCELLED')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
  };
}
