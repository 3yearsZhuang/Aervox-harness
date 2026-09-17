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
  it('places config button to the left of switch, fixes switch on the far right, and disables config button when plugin is disabled', async () => {
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

    // 1. Focus mode (enabled, has configSchemaJson)
    const focusActions = cards[0].find('.plugin-card-actions');
    const focusActionButtons = focusActions.findAll('button');
    expect(focusActionButtons).toHaveLength(3);

    // First button: config button
    const focusConfigBtn = focusActionButtons[0];
    expect(focusConfigBtn.classes()).toContain('plugin-action');
    expect(focusConfigBtn.text()).toContain('配置');
    expect(focusConfigBtn.attributes('disabled')).toBeUndefined();
    expect(focusConfigBtn.attributes('title')).toBe('配置');

    // Middle button: settings button
    const focusSettingsBtn = focusActionButtons[1];
    expect(focusSettingsBtn.classes()).toContain('plugin-settings-btn');
    expect(focusSettingsBtn.text()).toContain('设置');
    expect(focusSettingsBtn.attributes('disabled')).toBeUndefined();

    // Right button: switch toggle (last child)
    const focusToggle = focusActionButtons[2];
    expect(focusToggle.classes()).toContain('plugin-toggle');
    expect(focusToggle.classes()).toContain('checked');

    // 2. Health guard (disabled, has configSchemaJson)
    const healthActions = cards[1].find('.plugin-card-actions');
    const healthActionButtons = healthActions.findAll('button');
    expect(healthActionButtons).toHaveLength(3);

    // First button: config button is STILL present, but disabled
    const healthConfigBtn = healthActionButtons[0];
    expect(healthConfigBtn.classes()).toContain('plugin-action');
    expect(healthConfigBtn.text()).toContain('配置');
    expect(healthConfigBtn.attributes('disabled')).toBeDefined();
    expect(healthConfigBtn.attributes('title')).toBe('插件未启用');

    // Middle button: settings button is disabled
    const healthSettingsBtn = healthActionButtons[1];
    expect(healthSettingsBtn.classes()).toContain('plugin-settings-btn');
    expect(healthSettingsBtn.attributes('disabled')).toBeDefined();

    // Right button: switch toggle (last child, unchecked)
    const healthToggle = healthActionButtons[2];
    expect(healthToggle.classes()).toContain('plugin-toggle');
    expect(healthToggle.classes()).not.toContain('checked');

    // 3. Simple plugin (disabled, no configSchemaJson, has settings button)
    const simpleActions = cards[2].find('.plugin-card-actions');
    const simpleActionButtons = simpleActions.findAll('button');
    expect(simpleActionButtons).toHaveLength(2);
    expect(simpleActionButtons[0].classes()).toContain('plugin-settings-btn');
    expect(simpleActionButtons[1].classes()).toContain('plugin-toggle');

    // 4. Click health toggle to enable: invokes setPluginEnabled
    await healthToggle.trigger('click');
    expect(mockSetPluginEnabled).toHaveBeenCalledWith('health-guard', true);
  });
});
