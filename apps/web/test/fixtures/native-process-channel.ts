import { nativeRequest as requestNative } from '../../src/mobile/native-channel';

/** Test-build alias only. SQL, lifecycle, preferences and tools keep their real
 * native transport; model operations can never reach a configured provider. */
export function nativeRequest(body: Record<string, unknown>): Promise<any> {
  if (body.op === 'model') {
    if (body.operation === 'summary') return Promise.resolve({ kind: 'summary', hasCredential: true });
    return Promise.reject(new Error('DETERMINISTIC_PROVIDER_ONLY'));
  }
  return requestNative(body);
}
