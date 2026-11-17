// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import NativeRuntimePanel from '../src/mobile/NativeRuntimePanel.vue';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/mobile/native-channel', () => ({ nativeRequest: request }));
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  getClientTransport: () => ({}),
}));
afterEach(() => { vi.resetAllMocks(); });

it('reports the saved native model without loading unrelated settings or requesting device permissions', async () => {
  request.mockImplementation(async body => body.op === 'runtime'
    ? { kind: 'runtime', sqlite: 'ready', mode: 'foreground', connectionEpoch: 'first-run' }
    : { kind: 'summary', hasCredential: true, model: 'phone-model', endpoint: 'https://provider.example/v1' });
  const wrapper = mount(NativeRuntimePanel, { props: { modelSetupOnly: true } });
  await flushPromises();
  expect(request.mock.calls.map(([body]) => body)).toEqual([{ op: 'runtime' }, { op: 'model', operation: 'summary' }]);
  expect(wrapper.find('[aria-label="设置分区"]').exists()).toBe(false);
  expect(wrapper.emitted('model-status')!.at(-1)).toEqual([{ state: 'configured', busy: false, modelId: 'phone-model' }]);
  expect(wrapper.text()).not.toContain('连接成功');
  wrapper.unmount();
});

it('retains an unreadable model as an error state and never reports it as an unconfigured success', async () => {
  request.mockRejectedValue(new Error('private native state'));
  const wrapper = mount(NativeRuntimePanel, { props: { modelSetupOnly: true } });
  await flushPromises();
  expect(wrapper.emitted('model-status')!.at(-1)).toEqual([{ state: 'error', busy: false }]);
  expect(wrapper.text()).toContain('模型配置读取失败');
  expect(wrapper.text()).not.toContain('private native state');
  expect(wrapper.find('input[type="password"]').exists()).toBe(false);
  wrapper.unmount();
});
