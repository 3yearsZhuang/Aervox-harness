import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import {
  createUIRegistry,
  SettingsModal as SettingsModalAsync,
  UI_REGISTRY_KEY,
  useWorkbenchLayout,
  WORKBENCH_CONTEXT_KEY,
} from '@aervox/ui/workbench';
import LLMConfigPanel from '../src/llm/LLMConfigPanel.vue';

// workbench 出口的 SettingsModal 是异步分包组件；测试需要同步挂载，先经加载器解析
const SettingsModal = await (SettingsModalAsync as unknown as { __asyncLoader: () => Promise<never> }).__asyncLoader();

const llm = vi.hoisted(() => ({
  getConfig: vi.fn(), listPresets: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn(),
}));

vi.mock('@aervox/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({
    ...llm,
    loadProviders: async () => undefined,
    presetProviders: [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', recommendedModels: ['example-model'] }],
  }),
}));

const storedConfig = {
  enabled: true, providerType: 'ollama', baseUrl: 'http://localhost:11434/v1',
  apiKey: '', modelId: 'example-model', temperature: 0.7, maxTokens: 4096, settings: {},
};
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  llm.getConfig.mockImplementation(async () => structuredClone(storedConfig));
  llm.listPresets.mockResolvedValue({ presets: [], activeId: null });
  llm.saveConfig.mockImplementation(async (config) => config);
});
afterEach(() => vi.restoreAllMocks());

describe('model settings panel (settings:panel:model)', () => {
  it('preserves an unsaved model draft when switching settings categories and saves explicitly', async () => {
    const registry = createUIRegistry();
    registry.registerSlotComponent('settings:panel:model', LLMConfigPanel, { id: 'settings-panel-model' });
    const layout = useWorkbenchLayout(
      { platform: 'web', showCompanion: false, companionName: '小隅' }, { recordActivity: vi.fn() },
    );
    layout.openSettingsCategory('model');
    const wrapper = mount(SettingsModal, {
      global: {
        stubs: {
          ElDialog: defineComponent({ template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' }),
        },
        provide: {
          [UI_REGISTRY_KEY as symbol]: registry,
          [WORKBENCH_CONTEXT_KEY as symbol]: {
            layout, timer: { timerMinutes: ref(25) }, cards: { cardCatalog: ref([]) },
            conversation: { toolApprovalMode: ref('ask'), fullAccessDialogOpen: ref(false), fullAccessAcknowledged: ref(false) },
            proactive: { proactiveDialogOpen: ref(false) },
          },
        },
      },
    });
    await flushPromises();
    expect(wrapper.findAll('.nav-sidebar-item')).toHaveLength(6);
    expect(wrapper.get('.nav-sidebar-item[aria-current="true"]').text()).toContain('模型服务');
    await wrapper.get('[aria-label="模型名称"]').setValue('unsaved-model');
    expect(wrapper.text()).toContain('有未保存的修改');
    await wrapper.findAll('.nav-sidebar-item').find(button => button.text().includes('通用'))!.trigger('click');
    await nextTick();
    expect(wrapper.findAll('[aria-label="设置页面"] button').map(button => button.text())).toEqual(['外观', '工具布局']);
    await wrapper.findAll('[aria-label="设置页面"] button')[1]!.trigger('click');
    expect(layout.settingsCategory.value).toBe('tools');
    await wrapper.findAll('.nav-sidebar-item').find(button => button.text().includes('模型服务'))!.trigger('click');
    await flushPromises();
    expect((wrapper.get('[aria-label="模型名称"]').element as HTMLInputElement).value).toBe('unsaved-model');
    expect(llm.getConfig).toHaveBeenCalledTimes(1);
    expect(llm.saveConfig).not.toHaveBeenCalled();
    await wrapper.get('.save-btn').trigger('click');
    await flushPromises();
    expect(llm.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'unsaved-model' }));
    expect(wrapper.text()).not.toContain('有未保存的修改');
    wrapper.unmount();
  });

  it('does not overwrite edits made while a save request is in flight', async () => {
    let finishSave: (value: unknown) => void = () => {};
    llm.saveConfig.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    const wrapper = mount(LLMConfigPanel);
    await flushPromises();
    await wrapper.get('[aria-label="模型名称"]').setValue('submitted-model');
    await wrapper.get('.save-btn').trigger('click');
    await wrapper.get('[aria-label="模型名称"]').setValue('newer-draft');
    finishSave({ ...storedConfig, modelId: 'submitted-model' });
    await flushPromises();
    expect((wrapper.get('[aria-label="模型名称"]').element as HTMLInputElement).value).toBe('newer-draft');
    expect(wrapper.text()).toContain('有未保存的修改');
    wrapper.unmount();
  });
});
