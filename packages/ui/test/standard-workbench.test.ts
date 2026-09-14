import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, computed } from 'vue';
import { useWorkbenchLayout } from '../src/composables/useWorkbenchLayout';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '../src/composables/workbench-context';
import WorkbenchSidebar from '../src/components/workbench/WorkbenchSidebar.vue';
import TaskCenterDrawer from '../src/components/workbench/drawers/TaskCenterDrawer.vue';
import type { SessionItem } from '@aervox/contracts';

describe('Standard Workbench Mode (CR-035 / W1 & W2)', () => {
  it('useWorkbenchLayout supports mode switching, sidebar collapse and task center', () => {
    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
    };
    const origStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, configurable: true });

    try {
      const recordActivity = vi.fn();
      const layout = useWorkbenchLayout(
        { platform: 'web', showCompanion: false, assistantName: '思隅' },
        { recordActivity },
      );

      // 默认初始模式
      expect(layout.workbenchMode.value).toBe('companion');
      expect(layout.standardSidebarCollapsed.value).toBe(false);
      expect(layout.taskCenterOpen.value).toBe(false);

      // 切换至标准工作台模式
      layout.switchWorkbenchMode('standard');
      expect(layout.workbenchMode.value).toBe('standard');
      expect(storage['aervox-workbench-mode']).toBe('standard');
      expect(recordActivity).toHaveBeenCalledWith('aervox.operation', 'workbench.mode_switched', undefined, { mode: 'standard' });

      // 切换侧边栏折叠
      layout.toggleStandardSidebar();
      expect(layout.standardSidebarCollapsed.value).toBe(true);
      layout.toggleStandardSidebar();
      expect(layout.standardSidebarCollapsed.value).toBe(false);

      // 打开与关闭任务中心
      layout.openTaskCenter();
      expect(layout.taskCenterOpen.value).toBe(true);
      expect(recordActivity).toHaveBeenCalledWith('aervox.operation', 'workbench.task_center_opened', undefined);
      layout.closeTaskCenter();
      expect(layout.taskCenterOpen.value).toBe(false);

      // openTool('task_center')
      layout.openTool('task_center');
      expect(layout.taskCenterOpen.value).toBe(true);

      // toggleWorkbenchMode
      layout.toggleWorkbenchMode();
      expect(layout.workbenchMode.value).toBe('companion');
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: origStorage, configurable: true });
    }
  });

  it('WorkbenchSidebar.vue renders session list, creates new session and switches active session', async () => {
    const mockSessions = ref<SessionItem[]>([
      {
        id: 'ses_1',
        title: '微积分导数分析',
        isPinned: true,
        createdAt: '2026-09-14T10:00:00.000Z',
        updatedAt: new Date().toISOString(),
      },
      {
        id: 'ses_2',
        title: '线性代数特征值',
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-10T10:00:00.000Z',
      },
    ]);

    const activeSessionId = ref('ses_1');
    const createNewSession = vi.fn().mockResolvedValue({ id: 'ses_new', title: '新对话' });
    const switchSession = vi.fn((id: string) => { activeSessionId.value = id; });
    const renameSession = vi.fn();
    const deleteSession = vi.fn();
    const switchWorkbenchMode = vi.fn();
    const toggleStandardSidebar = vi.fn();
    const openSettings = vi.fn();
    const toggleTaskCenter = vi.fn();

    const mockContext: WorkbenchContext = {
      layout: {
        workbenchMode: ref('standard'),
        standardSidebarCollapsed: ref(false),
        taskCenterOpen: ref(false),
        isDark: ref(false),
        toggleStandardSidebar,
        switchWorkbenchMode,
        openSettings,
        toggleTaskCenter,
        setTheme: vi.fn(),
      } as any,
      sessions: {
        sessions: mockSessions,
        activeSessionId,
        activeSession: computed(() => mockSessions.value.find((s) => s.id === activeSessionId.value) ?? null),
        loading: ref(false),
        error: ref(null),
        fetchSessions: vi.fn(),
        createNewSession,
        switchSession,
        renameSession,
        deleteSession,
      },
      timer: {} as any,
      composer: {} as any,
      conversation: {} as any,
      cards: {} as any,
      proactive: {} as any,
      registry: {} as any,
      sendMessage: vi.fn(),
    };

    const wrapper = mount(WorkbenchSidebar, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    // 检查品牌标题与新建会话按钮
    expect(wrapper.find('.brand-title').text()).toBe('Aervox 思隅');
    expect(wrapper.find('.new-chat-btn').text()).toContain('新对话');

    // 检查会话项渲染
    const items = wrapper.findAll('.session-item');
    expect(items.length).toBe(2);
    expect(items[0].text()).toContain('微积分导数分析');
    expect(items[0].classes()).toContain('is-active');

    // 点击新建会话
    await wrapper.find('.new-chat-btn').trigger('click');
    expect(createNewSession).toHaveBeenCalled();

    // 点击第二个会话切换
    await items[1].trigger('click');
    expect(switchSession).toHaveBeenCalledWith('ses_2');

    // 点击底部切换模式按钮
    await wrapper.find('.mode-switch-btn').trigger('click');
    expect(switchWorkbenchMode).toHaveBeenCalledWith('companion');
  });

  it('TaskCenterDrawer.vue renders unified cards and deep links', async () => {
    const openTool = vi.fn();
    const openSettingsCategory = vi.fn();

    const mockContext: WorkbenchContext = {
      layout: {
        taskCenterOpen: ref(true),
        openTool,
        openSettingsCategory,
      } as any,
      cards: {
        todayDiary: ref({ content: '今日学习了微积分极限。' }),
        syncReviewCount: ref(3),
      } as any,
      timer: {
        timerRunning: ref(false),
        timerMinutes: ref(25),
        formattedTime: ref('25:00'),
      } as any,
      proactive: {} as any,
      sessions: {} as any,
      composer: {} as any,
      conversation: {} as any,
      registry: {} as any,
      sendMessage: vi.fn(),
    };

    const wrapper = mount(TaskCenterDrawer, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
        stubs: {
          'el-dialog': {
            props: ['title'],
            template: '<div class="el-dialog-stub"><h3>{{ title }}</h3><slot /></div>',
          },
        },
      },
    });

    // 验证各任务卡片渲染
    expect(wrapper.text()).toContain('统一任务中心');
    expect(wrapper.text()).toContain('间隔复习与错题排期');
    expect(wrapper.text()).toContain('3 个待复习');
    expect(wrapper.text()).toContain('今日日记已提炼完成');
    expect(wrapper.text()).toContain('番茄专注钟');
    expect(wrapper.text()).toContain('本地 SQLite 单库真源 (WAL 模式)');
  });
});
