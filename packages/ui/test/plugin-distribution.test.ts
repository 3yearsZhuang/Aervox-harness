import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import type { PluginMarketItemDto, PluginPackageInspectionDto } from '@aervox/api-client';

const mockMarketItems: PluginMarketItemDto[] = [
  {
    id: 'focus-mode',
    displayName: '深度专注伴侣',
    publisher: 'aervox-official',
    version: '1.2.0',
    description: '番茄钟与主动专注打卡工具',
    license: 'MIT',
    source: 'builtin',
    installed: true,
    installedVersion: '1.2.0',
    hasUpdate: false,
    capabilities: {
      hasConfig: true,
      sensorsCount: 1,
      triggersCount: 1,
      skillsCount: 1,
      toolsCount: 2,
      pagesCount: 1,
    },
  },
  {
    id: 'weather-radar',
    displayName: '实时天气雷达',
    publisher: 'community',
    version: '0.9.0',
    description: '桌面微气象感知与预报',
    license: 'MIT',
    source: 'builtin',
    installed: false,
    installedVersion: null,
    hasUpdate: false,
    capabilities: {
      hasConfig: false,
      sensorsCount: 0,
      triggersCount: 0,
      skillsCount: 0,
      toolsCount: 1,
      pagesCount: 0,
    },
  },
];

const mockListMarket = vi.fn().mockResolvedValue(mockMarketItems);
const mockInstallFromMarket = vi.fn().mockResolvedValue({ id: 'weather-radar', enabled: 1 });
const mockInspectPackage = vi.fn();
const mockInstallPackage = vi.fn().mockResolvedValue({ id: 'weather-radar', enabled: 1 });
const mockDownloadPackage = vi.fn().mockResolvedValue(undefined);

vi.mock('@aervox/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return {
    ...actual,
    useAervoxPlugins: () => ({
      plugins: ref([]),
      loading: ref(false),
      error: ref(null),
      listMarket: mockListMarket,
      installFromMarket: mockInstallFromMarket,
      inspectPackage: mockInspectPackage,
      installPackage: mockInstallPackage,
      downloadPackage: mockDownloadPackage,
      getConfigSchema: vi.fn().mockResolvedValue({ fields: [] }),
      getConfig: vi.fn().mockResolvedValue({ revision: 1, values: {}, secretFields: {} }),
      listSensorGrants: vi.fn().mockResolvedValue([]),
      listPages: vi.fn().mockResolvedValue([]),
    }),
    useAervoxSkills: () => ({
      skills: ref([]),
      loading: ref(false),
      loadSkills: vi.fn().mockResolvedValue(undefined),
    }),
    useAervoxTools: () => ({
      tools: ref([]),
      loading: ref(false),
      loadTools: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

const ElDialogStub = defineComponent({
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
});

import PluginMarketTab from '../src/components/plugin/PluginMarketTab.vue';
import PluginInstallDialog from '../src/components/plugin/PluginInstallDialog.vue';
import PluginSettingsDialog from '../src/components/plugin/PluginSettingsDialog.vue';

describe('Plugin Distribution (CAP-020)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PluginMarketTab.vue', () => {
    it('renders market item cards and displays capability badges', async () => {
      const wrapper = mount(PluginMarketTab);
      await flushPromises();

      expect(mockListMarket).toHaveBeenCalled();
      const cards = wrapper.findAll('.market-card');
      expect(cards.length).toBe(2);

      expect(wrapper.text()).toContain('深度专注伴侣');
      expect(wrapper.text()).toContain('实时天气雷达');
      expect(wrapper.text()).toContain('aervox-official');
    });

    it('filters market items by search query', async () => {
      const wrapper = mount(PluginMarketTab);
      await flushPromises();

      const input = wrapper.find<HTMLInputElement>('input.search-input');
      await input.setValue('天气');
      await flushPromises();

      const cards = wrapper.findAll('.market-card');
      expect(cards.length).toBe(1);
      expect(wrapper.text()).toContain('实时天气雷达');
      expect(wrapper.text()).not.toContain('深度专注伴侣');
    });

    it('filters market items by capability segmented buttons', async () => {
      const wrapper = mount(PluginMarketTab);
      await flushPromises();

      const filterBtns = wrapper.findAll('.filter-seg-btn');
      const proactiveBtn = filterBtns.find((b) => b.text().includes('主动智能'));
      expect(proactiveBtn).toBeDefined();
      await proactiveBtn!.trigger('click');
      await flushPromises();

      const cards = wrapper.findAll('.market-card');
      expect(cards.length).toBe(1);
      expect(wrapper.text()).toContain('深度专注伴侣');
    });

    it('triggers installFromMarket when clicking install button', async () => {
      const wrapper = mount(PluginMarketTab);
      await flushPromises();

      const installBtns = wrapper.findAllComponents({ name: 'AervoxButton' });
      const installBtn = installBtns.find((b) => b.text().includes('一键安装'));
      expect(installBtn).toBeDefined();

      await installBtn!.trigger('click');
      await flushPromises();

      expect(mockInstallFromMarket).toHaveBeenCalledWith('weather-radar');
      expect(wrapper.emitted('installed')).toBeTruthy();
    });

    it('triggers export package when clicking export button in market card', async () => {
      const wrapper = mount(PluginMarketTab);
      await flushPromises();

      const exportBtns = wrapper.findAllComponents({ name: 'AervoxButton' });
      const exportBtn = exportBtns.find((b) => b.text().includes('导出'));
      expect(exportBtn).toBeDefined();

      await exportBtn!.trigger('click');
      await flushPromises();

      expect(mockDownloadPackage).toHaveBeenCalledWith('focus-mode');
    });
  });

  describe('PluginInstallDialog.vue', () => {
    const stubs = {
      ElDialog: ElDialogStub,
    };

    it('switches between package mode and manual form mode', async () => {
      const wrapper = mount(PluginInstallDialog, {
        props: { open: true },
        global: { stubs },
      });
      await flushPromises();

      expect(wrapper.find('.package-dropzone').exists()).toBe(true);
      expect(wrapper.find('.manual-mode-wrap').exists()).toBe(false);

      const modeButtons = wrapper.findAll('.mode-tab-btn');
      const manualBtn = modeButtons.find((btn) => btn.text().includes('开发者手动声明'));
      expect(manualBtn).toBeDefined();
      await manualBtn!.trigger('click');
      await flushPromises();

      expect(wrapper.find('.manual-mode-wrap').exists()).toBe(true);
      expect(wrapper.find('.package-dropzone').exists()).toBe(false);
    });

    it('displays pre-installation inspection result with PRD CAP-020 requirements', async () => {
      const mockInspection: PluginPackageInspectionDto = {
        isValid: true,
        id: 'test.plugin',
        displayName: '测试插件',
        publisher: 'community-dev',
        version: '1.0.0',
        description: '用于测试的离线插件包',
        license: 'MIT',
        checksum: 'abcdef1234567890abcdef1234567890',
        signature: null,
        permissions: ['clipboard.read', 'fs.workspace.read'],
        dataScope: ['剪贴板', '工作区文件'],
        tools: [{ name: 'custom_search', description: '搜索工具', category: 'plugin', safetyLevel: 'read_only' }],
        skills: [{ name: 'test-skill', description: '技能说明' }],
        pages: [{ id: 'index', title: '首页', entry: 'pages/index.html' }],
        proactive: {
          sensors: [{ sourceId: 'clipboard', description: '剪贴板感知' }],
          triggers: [{ ruleId: 'rule-1', name: '提醒', triggerType: 'system_state' }],
        },
        hasConfig: true,
        issues: [],
        alreadyInstalled: false,
        installedVersion: null,
      };

      mockInspectPackage.mockResolvedValue(mockInspection);

      const wrapper = mount(PluginInstallDialog, {
        props: { open: true },
        global: { stubs },
      });
      await flushPromises();

      const file = new File(['dummy zip content'], 'test-plugin.aervox-plugin', {
        type: 'application/zip',
      });
      file.arrayBuffer = () => Promise.resolve(new Uint8Array([80, 75, 3, 4]).buffer);

      const input = wrapper.find<HTMLInputElement>('input[type="file"]');
      Object.defineProperty(input.element, 'files', {
        value: [file],
        writable: true,
      });

      await input.trigger('change');
      await flushPromises();

      expect(mockInspectPackage).toHaveBeenCalled();
      expect(wrapper.find('.inspection-result-card').exists()).toBe(true);
      expect(wrapper.text()).toContain('测试插件');
      expect(wrapper.text()).toContain('community-dev');
      expect(wrapper.text()).toContain('v1.0.0');
      expect(wrapper.text()).toContain('abcdef1234567890');
      expect(wrapper.text()).toContain('剪贴板');

      const footerBtns = wrapper.findAllComponents({ name: 'AervoxButton' });
      const confirmInstallBtn = footerBtns.find((b) => b.text().includes('确认安全安装'));
      expect(confirmInstallBtn).toBeDefined();
      await confirmInstallBtn!.trigger('click');
      await flushPromises();

      expect(mockInstallPackage).toHaveBeenCalled();
      expect(wrapper.emitted('installed')).toBeTruthy();
      expect(wrapper.emitted('close')).toBeTruthy();
    });

    it('shows error banner when inspectPackage detects format or security issues', async () => {
      mockInspectPackage.mockResolvedValue({
        isValid: false,
        id: 'bad.plugin',
        displayName: '非法插件',
        publisher: 'unknown',
        version: '0.0.1',
        description: '',
        license: '',
        checksum: '0000000000000000',
        signature: null,
        permissions: [],
        dataScope: [],
        tools: [],
        skills: [],
        pages: [],
        proactive: { sensors: [], triggers: [] },
        hasConfig: false,
        issues: ['检测到非法跨目录路径 (Zip Slip 威胁): evil/../../path'],
        alreadyInstalled: false,
        installedVersion: null,
      });

      const wrapper = mount(PluginInstallDialog, {
        props: { open: true },
        global: { stubs },
      });
      await flushPromises();

      const file = new File(['bad content'], 'bad.aervox-plugin', { type: 'application/zip' });
      file.arrayBuffer = () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);

      const input = wrapper.find<HTMLInputElement>('input[type="file"]');
      Object.defineProperty(input.element, 'files', {
        value: [file],
        writable: true,
      });

      await input.trigger('change');
      await flushPromises();

      expect(wrapper.find('.inspection-error-banner').exists()).toBe(true);
      expect(wrapper.text()).toContain('Zip Slip 威胁');
      expect(wrapper.find('.inspection-result-card').exists()).toBe(false);
    });
  });

  describe('PluginSettingsDialog.vue Export Action', () => {
    const stubs = {
      ElDialog: ElDialogStub,
      PluginConfigForm: true,
      SkillContentDialog: true,
      ToolCallDialog: true,
      PluginPageDialog: true,
    };

    it('renders export package button in dialog header and triggers download', async () => {
      const mockPlugin = {
        id: 'focus-mode',
        publisher: 'aervox-official',
        version: '1.0.0',
        installSource: 'builtin',
        enabled: 1,
        configSchemaJson: [{ key: 'theme', type: 'string' }],
        createdAt: '2026-09-15',
        updatedAt: '2026-09-15',
      };

      const wrapper = mount(PluginSettingsDialog, {
        props: {
          open: true,
          plugin: mockPlugin as any,
        },
        global: { stubs },
      });
      await flushPromises();

      const exportBtn = wrapper.find('button.plugin-export-btn');
      expect(exportBtn.exists()).toBe(true);
      expect(exportBtn.text()).toContain('导出分发包');

      await exportBtn.trigger('click');
      await flushPromises();

      expect(mockDownloadPackage).toHaveBeenCalledWith('focus-mode');
    });
  });
});
