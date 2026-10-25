import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { shallowRef } from 'vue';
import LLMConfigPanel from '../src/llm/LLMConfigPanel.vue';

const api = vi.hoisted(() => ({getConfig: vi.fn(), listPresets: vi.fn(), loadProviders: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn()}));
const providers = shallowRef<unknown[]>([]);
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({...api, presetProviders: providers}),
}));
const existing = {enabled: true, providerType: 'private-provider', baseUrl: 'https://private.example/v1', modelId: 'existing-model', temperature: 0.7, maxTokens: 4096, settings: {}};
const catalog = [{id: 'private-provider', name: 'Private provider', defaultBaseUrl: existing.baseUrl, recommendedModels: ['default-model'], requiresApiKey: false, available: true}];
enableAutoUnmount(afterEach);
beforeEach(() => {
  vi.clearAllMocks(); providers.value = [];
  api.getConfig.mockResolvedValue(structuredClone(existing));
  api.listPresets.mockResolvedValue({presets: [], activeId: null});
  api.saveConfig.mockImplementation(async value => value);
  api.loadProviders.mockImplementation(async () => { providers.value = catalog; return catalog; });
});

it('keeps model configuration editable after catalog failure and retries without overwriting its draft', async () => {
  api.loadProviders.mockRejectedValueOnce(new Error('catalog unavailable'));
  const wrapper = mount(LLMConfigPanel);
  await flushPromises();
  expect(wrapper.find('.pcfg-loading').exists()).toBe(false);
  expect((wrapper.get('[aria-label="模型名称"]').element as HTMLInputElement).value).toBe('existing-model');
  expect(wrapper.get('[role="alert"]').text()).toContain('供应商目录');
  await wrapper.get('[aria-label="模型名称"]').setValue('unsaved-model');
  await wrapper.get('[aria-label="重新加载供应商目录"]').trigger('click'); await flushPromises();
  expect(api.loadProviders).toHaveBeenCalledTimes(2);
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('[aria-label="模型供应商"]').text()).toContain('Private provider');
  expect((wrapper.get('[aria-label="模型名称"]').element as HTMLInputElement).value).toBe('unsaved-model');
  expect(api.getConfig).toHaveBeenCalledTimes(1);
});

it('shows an empty catalog as a retryable state while retaining the configured provider', async () => {
  api.loadProviders.mockResolvedValueOnce([]);
  const wrapper = mount(LLMConfigPanel); await flushPromises();
  expect(wrapper.get('[aria-label="模型供应商"]').text()).toContain('private-provider');
  expect(wrapper.get('[role="status"]').text()).toContain('供应商目录为空');
  await wrapper.get('[aria-label="重新加载供应商目录"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[aria-label="模型供应商"]').text()).toContain('Private provider');
});
