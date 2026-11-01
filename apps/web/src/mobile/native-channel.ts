/** Only the fixed APK asset host installs this channel. No HTTP fallback. */
interface NativeChannel {
  postMessage(message: string): void;
  onmessage: ((event: { data: string }) => void) | null;
}
declare global { interface Window { AervoxM0Native?: NativeChannel } }
const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let installed: NativeChannel | undefined;
export function nativeRequest(body: Record<string, unknown>): Promise<any> {
  const channel = window.AervoxM0Native;
  if (!channel) return Promise.reject(new Error('NATIVE_UNAVAILABLE'));
  if (installed && installed !== channel) return Promise.reject(new Error('NATIVE_OWNER_CHANGED'));
  if (!installed) {
    installed = channel;
    channel.onmessage = ({ data }) => {
      let response: any;
      try { response = JSON.parse(data); } catch { return; }
      if (response?.version !== 1 || typeof response.id !== 'string') return;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id); clearTimeout(request.timer);
      if (response.error) request.reject(new Error('NATIVE_FAILURE'));
      else if (response.result?.kind === 'failure') request.reject(new Error(response.result.code));
      else request.resolve(response.result);
    };
  }
  if (pending.size >= 8) return Promise.reject(new Error('NATIVE_BUSY'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // Native configure waits for the human; an absent SQL receipt is unknown,
    // never retried here. NativeSqliteClient fences itself after rejection.
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('NATIVE_RECEIPT_UNKNOWN')); }, body.op === 'model' && body.operation === 'configure' ? 300_000 : 15_000);
    pending.set(id, { resolve, reject, timer });
    try { channel.postMessage(JSON.stringify({ version: 1, id, body })); }
    catch { pending.delete(id); clearTimeout(timer); reject(new Error('NATIVE_RECEIPT_UNKNOWN')); }
  });
}
