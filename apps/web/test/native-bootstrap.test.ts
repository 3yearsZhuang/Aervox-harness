// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';

const fixture = vi.hoisted(() => ({ hydrate: vi.fn(), request: vi.fn(), mount: vi.fn() }));
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: fixture.request }));
vi.mock('../src/mobile/native-storage', () => ({ nativeStorage: {}, hydrateNativeStorage: fixture.hydrate }));
vi.mock('../src/mobile/native-renderer', () => ({}));
vi.mock('../src/App.vue', () => ({ default: {} }));
vi.mock('@aervox/api-client', () => ({ createAervoxClient: vi.fn(), provideAervoxClient: vi.fn() }));
vi.mock('vue', async importOriginal => ({ ...await importOriginal<typeof import('vue')>(),
  createApp: () => ({ use: vi.fn(), mount: fixture.mount }),
}));
vi.mock('element-plus/es/components/button/index.mjs', () => ({ ElButton: {} }));
vi.mock('element-plus/es/components/dialog/index.mjs', () => ({ ElDialog: {} }));
vi.mock('element-plus/es/components/dropdown/index.mjs', () => ({ ElDropdown: {}, ElDropdownItem: {}, ElDropdownMenu: {} }));
vi.mock('element-plus/es/components/tooltip/index.mjs', () => ({ ElTooltip: {} }));

afterEach(() => { delete window.AervoxM0Native; document.body.innerHTML = ''; vi.resetModules(); });

it('reveals the bootstrap error after rendering it when storage initialization fails', async () => {
  window.AervoxM0Native = { postMessage: vi.fn(), onmessage: null };
  document.body.innerHTML = '<div id="app"></div>';
  let reject!: (error: Error) => void;
  fixture.hydrate.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  fixture.request.mockImplementation(() => {
    const root = document.getElementById('app')!;
    expect(root.getAttribute('role')).toBe('alert');
    expect(root.textContent).toContain('已有数据已保留');
    return Promise.reject(new Error('missing readiness receipt'));
  });
  await import('../src/main');
  await flushPromises();
  expect(fixture.request).not.toHaveBeenCalled();
  reject(new Error('storage unavailable'));
  await flushPromises();
  expect(fixture.mount).not.toHaveBeenCalled();
  expect(fixture.request).toHaveBeenCalledOnce();
  expect(fixture.request).toHaveBeenCalledWith({ op: 'runtime', operation: 'uiReady' });
  expect(document.getElementById('app')!.textContent).toContain('本机运行暂不可用');
});
