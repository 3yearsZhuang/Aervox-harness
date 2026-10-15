import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import {
  createUIRegistry, SettingsModal as SettingsModalAsync, UI_REGISTRY_KEY,
  useWorkbenchLayout, WORKBENCH_CONTEXT_KEY,
} from '@aervox/ui/workbench';

const SettingsModal = await (SettingsModalAsync as unknown as { __asyncLoader: () => Promise<never> }).__asyncLoader();
enableAutoUnmount(afterEach);

it('opens the registered platform panel from settings navigation', async () => {
  const registry = createUIRegistry();
  registry.registerSlotComponent('settings:panel:bots', defineComponent({ template: '<section aria-label="机器人面板测试">平台面板已挂载</section>' }), { id: 'settings-panel-bots' });
  const layout = useWorkbenchLayout({ platform: 'web', showCompanion: false, assistantName: '思隅' }, { recordActivity: vi.fn() });
  layout.openSettingsCategory('conversation');
  const wrapper = mount(SettingsModal, {
    global: {
      stubs: { ElDialog: defineComponent({ template: '<div><slot name="header"/><slot/><slot name="footer"/></div>' }) },
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
  const entry = wrapper.findAll('.nav-sidebar-item').find(item => item.text().includes('机器人连接'));
  expect(entry).toBeDefined();
  await entry!.trigger('click');
  await flushPromises();
  expect(layout.settingsCategory.value).toBe('bots');
  expect(wrapper.get('[aria-label="机器人面板测试"]').text()).toBe('平台面板已挂载');
  expect(wrapper.get('.nav-sidebar-item[aria-current="true"]').text()).toContain('机器人连接');
});
