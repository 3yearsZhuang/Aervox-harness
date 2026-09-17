import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import type { PluginSummaryDto, SkillDto, ToolRegistrationDto } from '@aervox/api-client';

const mockGetConfigSchema = vi.fn().mockResolvedValue({
  fields: [{ key: 'theme', label: '主题偏好', type: 'string' }],
});
const mockGetConfig = vi.fn().mockResolvedValue({
  revision: 1,
  values: { theme: 'dark' },
  secretFields: {},
});
const mockSaveConfig = vi.fn().mockResolvedValue({
  revision: 2,
  values: { theme: 'light' },
  secretFields: {},
});
const mockResetConfig = vi.fn().mockResolvedValue({
  revision: 3,
  values: {},
  secretFields: {},
});
const mockListSensorGrants = vi.fn().mockResolvedValue([
  { id: 'grant-1', scope: 'clipboard' },
]);
const mockGrantSensor = vi.fn().mockResolvedValue({ id: 'grant-2', scope: 'clipboard' });
const mockRevokeSensorGrant = vi.fn().mockResolvedValue({ success: true });
const mockListPages = vi.fn().mockResolvedValue([
  { id: 'dashboard', title: '概览面板', path: 'index.html' },
]);

const mockSkills = ref<SkillDto[]>([
  {
    id: 'focus-timer',
    name: 'focus-timer',
    pluginId: 'focus-mode',
    active: 1,
    readonly: 1,
    description: '专注计时技能',
    content: 'Skill instructions...',
  },
  {
    id: 'other-skill',
    name: 'other-skill',
    pluginId: 'other-plugin',
    active: 1,
    readonly: 0,
    description: '独立未绑定技能',
  },
]);

const mockTools = ref<ToolRegistrationDto[]>([
  {
    id: 'focus_start',
    name: 'focus_start',
    pluginId: 'focus-mode',
    enabled: 1,
    description: '启动专注计时',
  },
  {
    id: 'mcp_order',
    name: 'mcp_order',
    pluginId: 'mcp:mcdonalds',
    enabled: 0,
    description: '点餐服务工具',
  },
  {
    id: 'other_tool',
    name: 'other_tool',
    pluginId: 'other-plugin',
    enabled: 1,
    description: '无关工具',
  },
]);

const mockLoadSkills = vi.fn().mockResolvedValue(undefined);
const mockSetSkillActive = vi.fn().mockResolvedValue({ active: 0 });
const mockLoadTools = vi.fn().mockResolvedValue(undefined);
const mockSetToolEnabled = vi.fn().mockResolvedValue({ enabled: 1 });
const mockTestCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    useAervoxPlugins: () => ({
      getConfigSchema: mockGetConfigSchema,
      getConfig: mockGetConfig,
      saveConfig: mockSaveConfig,
      resetConfig: mockResetConfig,
      listSensorGrants: mockListSensorGrants,
      grantSensor: mockGrantSensor,
      revokeSensorGrant: mockRevokeSensorGrant,
      listPages: mockListPages,
    }),
    useAervoxSkills: () => ({
      skills: mockSkills,
      loading: ref(false),
      error: ref(null),
      loadSkills: mockLoadSkills,
      setSkillActive: mockSetSkillActive,
    }),
    useAervoxTools: () => ({
      tools: mockTools,
      loading: ref(false),
      error: ref(null),
      loadTools: mockLoadTools,
      setToolEnabled: mockSetToolEnabled,
      testCallTool: mockTestCallTool,
    }),
  };
});

import PluginSettingsDialog from '../src/components/plugin/PluginSettingsDialog.vue';

describe('PluginSettingsDialog.vue', () => {
  const mockPlugin: PluginSummaryDto = {
    id: 'focus-mode',
    publisher: 'aervox-official',
    version: '1.0.0',
    installSource: 'builtin',
    enabled: 1,
    configSchemaJson: [{ key: 'theme', type: 'string' }],
    proactiveSpecJson: {
      sensors: [{ sourceId: 'clipboard', description: '剪贴板感知' }],
      triggers: [{ ruleId: 'rule-focus', name: '专注排期', triggerType: 'cron' }],
    },
    spec: {
      mcpServers: ['mcdonalds'],
    },
    createdAt: '2026-09-15',
    updatedAt: '2026-09-15',
  } as unknown as PluginSummaryDto;

  const stubs = {
    ElDialog: defineComponent({
      name: 'ElDialog',
      props: ['modelValue', 'width', 'showClose'],
      emits: ['update:modelValue', 'close'],
      setup(props, { slots }) {
        return () =>
          props.modelValue
            ? h('div', { class: 'el-dialog-stub' }, [
                slots.header ? slots.header() : null,
                slots.default ? slots.default() : null,
                slots.footer ? slots.footer() : null,
              ])
            : null;
      },
    }),
    PluginConfigForm: defineComponent({
      name: 'PluginConfigForm',
      props: ['fields', 'values', 'secretFields', 'secretValues'],
      template: '<div class="config-form-stub">ConfigFormStub</div>',
    }),
    SkillContentDialog: true,
    ToolCallDialog: true,
    PluginPageDialog: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not render content when open is false', () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: false,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    expect(wrapper.find('.el-dialog-stub').exists()).toBe(false);
  });

  it('renders header, tabs, and counts when open is true', async () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    await flushPromises();

    // 弹窗已渲染
    expect(wrapper.find('.el-dialog-stub').exists()).toBe(true);

    // 头部信息
    expect(wrapper.text()).toContain('focus-mode 插件能力与设置');
    expect(wrapper.text()).toContain('aervox-official@1.0.0');

    // 导航项
    const navItems = wrapper.findAll('.subnav-item');
    expect(navItems.length).toBeGreaterThanOrEqual(4);

    const navTexts = navItems.map((n) => n.text());
    expect(navTexts.some((t) => t.includes('运行配置'))).toBe(true);
    expect(navTexts.some((t) => t.includes('专属技能'))).toBe(true);
    expect(navTexts.some((t) => t.includes('工具与 MCP'))).toBe(true);
    expect(navTexts.some((t) => t.includes('主动智能'))).toBe(true);

    // 专属技能和工具计数徽标（专属技能 1 个，专属工具包含 focus-mode 和 mcp:mcdonalds 共 2 个）
    expect(navTexts.some((t) => t.includes('专属技能') && t.includes('1'))).toBe(true);
    expect(navTexts.some((t) => t.includes('工具与 MCP') && t.includes('2'))).toBe(true);
  });

  it('manages plugin skills: lists only matching skills and toggles active state', async () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    await flushPromises();

    // 切换至 skills Tab
    const skillsTabBtn = wrapper.findAll('.subnav-item').find((n) => n.text().includes('专属技能'));
    expect(skillsTabBtn).toBeDefined();
    await skillsTabBtn!.trigger('click');
    await flushPromises();

    // 验证技能列表只包含当前插件专属技能
    const skillCards = wrapper.findAll('.capability-item');
    expect(skillCards).toHaveLength(1);
    expect(skillCards[0].text()).toContain('focus-timer');
    expect(skillCards[0].text()).toContain('专注计时技能');

    // 点击切换启用/停用按钮
    const toggleBtn = skillCards[0].find('.settings-switch');
    expect(toggleBtn.exists()).toBe(true);
    await toggleBtn.trigger('click');
    await flushPromises();

    expect(mockSetSkillActive).toHaveBeenCalledWith('focus-timer', false);
    expect(wrapper.emitted('change')).toBeDefined();
  });

  it('manages plugin tools: lists direct tools and declared mcp server tools, and toggles enabled state', async () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    await flushPromises();

    // 切换至 tools Tab
    const toolsTabBtn = wrapper.findAll('.subnav-item').find((n) => n.text().includes('工具与 MCP'));
    expect(toolsTabBtn).toBeDefined();
    await toolsTabBtn!.trigger('click');
    await flushPromises();

    // 验证工具列表包含 focus_start 和 mcp_order，不包含 other_tool
    const toolCards = wrapper.findAll('.capability-item');
    expect(toolCards).toHaveLength(2);
    expect(toolCards[0].text()).toContain('focus_start');
    expect(toolCards[1].text()).toContain('mcp_order');

    // 切换工具启用状态
    const toggleBtn = toolCards[1].find('.settings-switch');
    expect(toggleBtn.exists()).toBe(true);
    await toggleBtn.trigger('click');
    await flushPromises();

    expect(mockSetToolEnabled).toHaveBeenCalledWith('mcp_order', true);
    expect(wrapper.emitted('change')).toBeDefined();
  });

  it('manages proactive sensors and triggers', async () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    await flushPromises();

    // 切换至 proactive Tab
    const proactiveTabBtn = wrapper.findAll('.subnav-item').find((n) => n.text().includes('主动智能'));
    expect(proactiveTabBtn).toBeDefined();
    await proactiveTabBtn!.trigger('click');
    await flushPromises();

    // 验证显示声明的感知源和规则
    expect(wrapper.text()).toContain('clipboard');
    expect(wrapper.text()).toContain('剪贴板感知');
    expect(wrapper.text()).toContain('rule-focus');
    expect(wrapper.text()).toContain('专注排期');

    // 点击撤销感知源授权
    const sensorToggleBtn = wrapper.find('.sensor-item .settings-switch');
    expect(sensorToggleBtn.exists()).toBe(true);
    await sensorToggleBtn.trigger('click');
    await flushPromises();

    expect(mockRevokeSensorGrant).toHaveBeenCalledWith('focus-mode', 'grant-1');
  });

  it('emits close event when close button is clicked', async () => {
    const wrapper = mount(PluginSettingsDialog, {
      props: {
        open: true,
        plugin: mockPlugin,
      },
      global: { stubs },
    });

    await flushPromises();

    const closeBtn = wrapper.find('.dialog-close-btn');
    expect(closeBtn.exists()).toBe(true);
    await closeBtn.trigger('click');

    expect(wrapper.emitted('close')).toBeDefined();
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
