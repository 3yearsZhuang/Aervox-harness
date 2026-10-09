import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';

const mockPlugins = ref([
  {
    id: 'focus-mode',
    publisher: 'aervox-official',
    version: '1.0.0',
    installSource: 'builtin',
    enabled: 1,
    configSchemaJson: [{ key: 'theme', type: 'string' }],
    createdAt: '2026-09-15',
    updatedAt: '2026-09-15',
  },
  {
    id: 'health-guard',
    publisher: 'aervox-official',
    version: '1.0.0',
    installSource: 'builtin',
    enabled: 0,
    configSchemaJson: [{ key: 'interval', type: 'number' }],
    createdAt: '2026-09-15',
    updatedAt: '2026-09-15',
  },
  {
    id: 'simple-plugin',
    publisher: 'community',
    version: '0.1.0',
    installSource: 'manual',
    enabled: 0,
    configSchemaJson: null,
    createdAt: '2026-09-15',
    updatedAt: '2026-09-15',
  },
]);

const mockSetPluginEnabled = vi.fn().mockResolvedValue({ id: 'test', enabled: 1 });
const mockListSensorGrants = vi.fn().mockResolvedValue([]);
const mockListPages = vi.fn().mockResolvedValue([]);
const mockLoadPlugins = vi.fn().mockResolvedValue(mockPlugins.value);

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    useAervoxPlugins: () => ({
      plugins: mockPlugins,
      loading: ref(false),
      error: ref(null),
      loadPlugins: mockLoadPlugins,
      setPluginEnabled: mockSetPluginEnabled,
      listSensorGrants: mockListSensorGrants,
      listPages: mockListPages,
      getConfig: vi.fn(),
    }),
  };
});

import PluginManagerPanel from '../src/components/plugin/PluginManagerPanel.vue';

describe('PluginManagerPanel.vue Actions Layout & State', () => {
  it('provides one management entry and a more menu while preserving the enable switch', async () => {
    const wrapper = mount(PluginManagerPanel, {
      global: {
        stubs: {
          PluginInstallDialog: true,
          PluginConfigDialog: true,
          PluginPageDialog: true,
          PluginSettingsDialog: true,
          SkillManagerTab: true,
          McpToolsTab: true,
        },
      },
    });

    await flushPromises();

    const cards = wrapper.findAll('.plugin-card');
    expect(cards).toHaveLength(3);

    const focusActions = cards[0].find('.plugin-card-actions');
    expect(focusActions.findAll('button')).toHaveLength(2);
    const manage = focusActions.find('.plugin-settings-btn');
    expect(manage.text()).toContain('管理');
    expect(manage.attributes('disabled')).toBeUndefined();
    expect(focusActions.find('.plugin-more-btn').attributes('aria-label')).toContain('focus-mode');
    expect(focusActions.findAll('button').map(button => button.text())).not.toContain('配置');
    expect(focusActions.get('.plugin-toggle').attributes('role')).toBe('switch');

    await manage.trigger('click');
    expect(wrapper.findComponent({ name: 'PluginSettingsDialog' }).props('open')).toBe(true);

    const healthActions = cards[1].find('.plugin-card-actions');
    expect(healthActions.find('.plugin-settings-btn').attributes('disabled')).toBeDefined();
    // Export remains discoverable even while a plugin is disabled.
    expect(healthActions.find('.plugin-more-btn').attributes('disabled')).toBeUndefined();
    const healthToggle = healthActions.find('.plugin-toggle');
    expect((healthToggle.element as HTMLInputElement).checked).toBe(false);
    expect(cards[2].find('.plugin-settings-btn').attributes('disabled')).toBeDefined();

    // 4. Click health toggle to enable: invokes setPluginEnabled
    await healthToggle.setValue(true);
    expect(mockSetPluginEnabled).toHaveBeenCalledWith('health-guard', true);
  });
});
