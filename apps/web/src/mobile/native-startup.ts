import { nativeRequest } from './native-channel';

/** The rendered surface, including recovery UI, can replace Android startup. */
export function notifyNativeUiReady(): void {
  if (!window.AervoxM0Native) return;
  try {
    void nativeRequest({ op: 'runtime', operation: 'uiReady' }).catch(() => undefined);
  } catch { /* A missing receipt must not replace an already rendered surface. */ }
}
