// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import OnboardingFlow from '../src/renderer/src/components/OnboardingFlow.vue';

const api = vi.hoisted(() => ({getConfig: vi.fn(), loadProviders: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn()}));
const providers = shallowRef<unknown[]>([]);
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({...api, presetProviders: providers}),
}));
enableAutoUnmount(afterEach);

it('loads existing configuration independently from catalog failure and retries without replacing edits', async () => {
  const existing = {enabled: true, providerType: 'private-provider', baseUrl: 'https://private.example/v1', modelId: 'existing-model', temperature: 0.7, maxTokens: 4096, settings: {}};
  providers.value = [];
  api.getConfig.mockResolvedValue(existing);
  api.loadProviders.mockRejectedValueOnce(new Error('catalog unavailable')).mockImplementationOnce(async () => {
    providers.value = [{id: 'private-provider', name: 'Private provider', defaultBaseUrl: existing.baseUrl, recommendedModels: ['default-model'], requiresApiKey: false, available: true}];
    return providers.value;
  });
  const wrapper = mount(OnboardingFlow, {global: {stubs: {Live2DPet: true}}}); await flushPromises();
  await wrapper.get('[aria-label="前往第 4 步"]').trigger('click'); await flushPromises();
  expect((wrapper.get('[placeholder="model-name"]').element as HTMLInputElement).value).toBe('existing-model');
  expect(wrapper.get('[role="alert"]').text()).toContain('供应商目录');
  await wrapper.get('[placeholder="model-name"]').setValue('edited-model');
  await wrapper.get('[aria-label="重新加载供应商目录"]').trigger('click'); await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('select').text()).toContain('Private provider');
  expect((wrapper.get('[placeholder="model-name"]').element as HTMLInputElement).value).toBe('edited-model');
  expect(api.getConfig).toHaveBeenCalledTimes(1);
});
