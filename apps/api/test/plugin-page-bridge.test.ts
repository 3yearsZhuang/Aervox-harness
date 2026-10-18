import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_SDK } from '@aervox/host-runtime-test/modules/ecosystem/plugins/bridge-sdk';

function sdk() {
  const parent = { postMessage: vi.fn() };
  const listeners = new Map<string, (event: { data?: unknown; source?: unknown; origin?: string }) => void>();
  const page: Record<string, unknown> = { parent, addEventListener: (type: string, handler: (event: object) => void) => listeners.set(type, handler) };
  vm.runInNewContext(BRIDGE_SDK, { window: page, setTimeout, clearTimeout });
  const bridge = page.AervoxPluginPageBridge as {
    ready(): Promise<unknown>; getContext(): unknown; getConfig(): Promise<unknown>;
    notify(input: object): Promise<unknown>; close(): Promise<unknown>;
  };
  const emit = (data: unknown, source: unknown = parent, origin = 'https://host.example') => listeners.get('message')!({ data, source, origin });
  const init = (nonce = 'a'.repeat(32)) => emit({ type: 'aervox:page:init', nonce, context: { pluginId: 'probe', pageId: 'settings' } });
  return { parent, bridge, emit, init, listeners };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Plugin Page Bridge SDK source and session binding', () => {
  it('ignores init from another window and rejects calls before a valid parent handshake', async () => {
    const s = sdk();
    s.emit({ type: 'aervox:page:init', nonce: 'a'.repeat(32), context: { pluginId: 'probe', pageId: 'settings' } }, {});
    expect(s.bridge.getContext()).toBeNull();
    await expect(s.bridge.getConfig()).rejects.toThrow('not ready');
    s.init();
    await expect(s.bridge.ready()).resolves.toEqual({ pluginId: 'probe', pageId: 'settings' });
  });

  it('accepts responses only from the bound parent origin, window, nonce and request', async () => {
    const s = sdk();
    s.init();
    const pending = s.bridge.getConfig();
    const request = s.parent.postMessage.mock.calls.at(-1)![0];
    let resolved = false;
    void pending.then(() => { resolved = true; });
    const result = { type: 'aervox:page:result', nonce: request.nonce, id: request.id, ok: true, value: 'safe' };
    s.emit(result, {});
    s.emit(result, s.parent, 'https://other.example');
    s.emit({ ...result, nonce: 'old-session' });
    s.emit({ ...result, id: 'unknown' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    s.emit(result);
    await expect(pending).resolves.toBe('safe');
    expect(vi.getTimerCount()).toBe(0);
    expect(s.parent.postMessage).toHaveBeenCalledWith(expect.anything(), 'https://host.example');
  });

  it('rejects pending old requests on session refresh and ignores their late responses', async () => {
    const s = sdk();
    s.init();
    const oldResult = s.bridge.getConfig().catch(error => error.message);
    const oldRequest = s.parent.postMessage.mock.calls.at(-1)![0];
    s.init('b'.repeat(32));
    expect(await oldResult).toBe('page session changed');
    const current = s.bridge.getConfig();
    const request = s.parent.postMessage.mock.calls.at(-1)![0];
    s.emit({ type: 'aervox:page:result', nonce: oldRequest.nonce, id: request.id, ok: true, value: 'old' });
    s.emit({ type: 'aervox:page:result', nonce: request.nonce, id: request.id, ok: true, value: 'new' });
    await expect(current).resolves.toBe('new');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects pending calls and clears their timers when the page closes', async () => {
    const s = sdk();
    s.init();
    const result = s.bridge.getConfig().catch(error => error.message);
    s.listeners.get('pagehide')!({});
    expect(await result).toBe('page closed');
    expect(s.bridge.getContext()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
