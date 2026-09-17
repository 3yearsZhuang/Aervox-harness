import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import type { SkillDto, ToolRegistrationDto } from '@aervox/api-client';

const mockSkills = ref<SkillDto[]>([
  {
    id: 'custom-memo',
    name: 'custom-memo',
    pluginId: undefined,
    source: 'local',
    active: 1,
    readonly: 0,
    description: '本地自定义备忘技能',
  },
  {
    id: 'focus-timer',
    name: 'focus-timer',
    pluginId: 'focus-mode',
    source: 'plugin',
    active: 1,
    readonly: 1,
    description: '专注插件内置技能',
  },
]);

const mockTools = ref<ToolRegistrationDto[]>([
  {
    id: 'system_core_tool',
    name: 'system_core_tool',
    builtin: true,
    pluginId: undefined,
    enabled: 1,
    description: '系统核心工具',
  },
  {
    id: 'mcp_search',
    name: 'mcp_search',
    builtin: false,
    pluginId: 'mcp:brave-search',
    enabled: 1,
    description: '外部独立 MCP 工具',
  },
  {
    id: 'plugin_specific_tool',
    name: 'plugin_specific_tool',
    builtin: false,
    pluginId: 'focus-mode',
    enabled: 1,
    description: '专属插件工具',
  },
]);

const mockLoadSkills = vi.fn().mockResolvedValue(undefined);
const mockSetSkillActive = vi.fn().mockResolvedValue({ active: 0 });
const mockLoadTools = vi.fn().mockResolvedValue(undefined);
const mockSetToolEnabled = vi.fn().mockResolvedValue({ enabled: 0 });

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    useAervoxSkills: () => ({
      skills: mockSkills,
      loading: ref(false),
      error: ref(null),
      loadSkills: mockLoadSkills,
      setSkillActive: mockSetSkillActive,
      installSkillZip: vi.fn(),
      deleteSkill: vi.fn(),
    }),
    useAervoxTools: () => ({
      tools: mockTools,
      loading: ref(false),
      error: ref(null),
      loadTools: mockLoadTools,
      setToolEnabled: mockSetToolEnabled,
      unregisterTool: vi.fn(),
      testCallTool: vi.fn(),
    }),
  };
});

import SkillManagerTab from '../src/components/plugin/SkillManagerTab.vue';
import McpToolsTab from '../src/components/plugin/McpToolsTab.vue';

describe('SkillManagerTab.vue and McpToolsTab.vue Pure Views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SkillManagerTab', () => {
    it('defaults to pure view and filters out plugin-owned skills', async () => {
      const wrapper = mount(SkillManagerTab, {
        global: {
          stubs: {
            SkillContentDialog: true,
          },
        },
      });

      await flushPromises();

      // 验证加载触发
      expect(mockLoadSkills).toHaveBeenCalled();

      // 默认应该展示引导横幅提示插件技能在插件设置管理
      expect(wrapper.find('.plugin-skills-banner').exists()).toBe(true);
      expect(wrapper.text()).toContain('插件内置');

      // 技能卡片：pure 模式下仅展示 custom-memo，过滤 focus-timer
      const skillCards = wrapper.findAll('.skill-card');
      expect(skillCards).toHaveLength(1);
      expect(skillCards[0].text()).toContain('custom-memo');
      expect(skillCards[0].text()).not.toContain('focus-timer');

      // 切换至「全部」
      const allFilterBtn = wrapper.findAll('.filter-pill-btn').find((b) => b.text().includes('全部'));
      expect(allFilterBtn).toBeDefined();
      await allFilterBtn!.trigger('click');
      await flushPromises();

      const allCards = wrapper.findAll('.skill-card');
      expect(allCards).toHaveLength(2);
      expect(wrapper.text()).toContain('focus-timer');
    });
  });

  describe('McpToolsTab', () => {
    it('defaults to pure view: shows builtin and independent MCP tools, hides plugin-specific tools', async () => {
      const wrapper = mount(McpToolsTab, {
        global: {
          stubs: {
            ToolCallDialog: true,
            McpRegisterDialog: true,
            McpPresetServers: true,
          },
        },
      });

      await flushPromises();

      expect(mockLoadTools).toHaveBeenCalled();

      // 默认纯粹视图展示引导横幅
      expect(wrapper.find('.tab-hint-banner').exists()).toBe(true);

      // pure 模式下展示 system_core_tool 与 mcp:brave-search，不展示 plugin_specific_tool
      const toolCards = wrapper.findAll('.tool-card');
      expect(toolCards).toHaveLength(2);
      expect(wrapper.text()).toContain('system_core_tool');
      expect(wrapper.text()).toContain('mcp_search');
      expect(wrapper.text()).toContain('MCP: brave-search');
      expect(wrapper.text()).not.toContain('plugin_specific_tool');

      // 切换至「全部」
      const allFilterBtn = wrapper.findAll('.filter-pill-btn').find((b) => b.text().includes('全部'));
      expect(allFilterBtn).toBeDefined();
      await allFilterBtn!.trigger('click');
      await flushPromises();

      const allCards = wrapper.findAll('.tool-card');
      expect(allCards).toHaveLength(3);
      expect(wrapper.text()).toContain('plugin_specific_tool');
    });
  });
});
