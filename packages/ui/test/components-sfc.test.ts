import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h, markRaw } from 'vue';
import SettingsModal from '../src/components/workbench/drawers/SettingsModal.vue';
import ToolsDrawer from '../src/components/workbench/drawers/ToolsDrawer.vue';
import WorkbenchNavPill from '../src/components/workbench/WorkbenchNavPill.vue';
import WorkbenchSideCards from '../src/components/workbench/WorkbenchSideCards.vue';
import ExtensionSlot from '../src/components/extension/ExtensionSlot.vue';
import type { CardDefinition } from '../src/composables/useWorkbenchCards';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '../src/composables/workbench-context';
import { createUIRegistry, UI_REGISTRY_KEY } from '../src/registry/ui-registry';

describe('Real SFC Component Mounting', () => {
  it('ExtensionSlot error boundary catches failing component and shows fallback without crashing', async () => {
    const registry = createUIRegistry();

    const BuggyComponent = defineComponent({
      name: 'BuggyComponent',
      setup() {
        throw new Error('Test intentional component explosion');
      },
      render: () => h('div', 'never reached'),
    });

    registry.registerSlotItem('header:actions', {
      id: 'buggy-plugin-item',
      component: BuggyComponent,
      priority: 10,
    });

    // Suppress console.error in test for expected error boundary log
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const wrapper = mount(ExtensionSlot, {
      props: {
        name: 'header:actions',
      },
      global: {
        provide: {
          [UI_REGISTRY_KEY as symbol]: registry,
        },
      },
    });

    await flushPromises();

    // Verify error was caught and fallback badge is displayed
    const fallback = wrapper.find('.extension-slot-fallback');
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain('⚠️ [插件 buggy-plugin-item 异常]');

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('Composer single-channel dispatch strictly adheres to onSend vs emit contract', async () => {
    const onSendMock = vi.fn().mockResolvedValue(undefined);

    // Minimal contract-compliant custom composer component
    const TestComposer = defineComponent({
      props: {
        input: { type: String, default: '' },
        streaming: { type: Boolean, default: false },
        isComposing: { type: Boolean, default: false },
        enterToSend: { type: Boolean, default: true },
        placeholder: { type: String, default: '' },
        onSend: { type: Function, default: undefined },
      },
      emits: ['update:input', 'send'],
      setup(props, { emit }) {
        function triggerSubmit() {
          if (props.streaming || props.isComposing || !props.input.trim()) return;
          if (props.onSend) {
            void props.onSend(props.input);
          } else {
            emit('send', props.input);
          }
        }
        return () =>
          h('button', { class: 'submit-btn', onClick: triggerSubmit }, 'Send');
      },
    });

    // 1. With onSend provided: only onSend is called, 'send' is NOT emitted
    const wrapperWithOnSend = mount(TestComposer, {
      props: {
        input: 'Hello world',
        streaming: false,
        onSend: onSendMock,
      },
    });

    await wrapperWithOnSend.find('.submit-btn').trigger('click');
    expect(onSendMock).toHaveBeenCalledWith('Hello world');
    expect(wrapperWithOnSend.emitted('send')).toBeUndefined();

    // 2. Without onSend provided: falls back to emit('send')
    const wrapperWithoutOnSend = mount(TestComposer, {
      props: {
        input: 'Fallback text',
        streaming: false,
      },
    });

    await wrapperWithoutOnSend.find('.submit-btn').trigger('click');
    expect(wrapperWithoutOnSend.emitted('send')).toBeDefined();
    expect(wrapperWithoutOnSend.emitted('send')![0]).toEqual(['Fallback text']);
  });

  it('WorkbenchNavPill.vue handles active states and renders plugin nav items sequentially', async () => {
    const registry = createUIRegistry();
    const openTool = vi.fn();
    const runMenuAction = vi.fn((action: () => void) => action());
    const toolsOpen = ref(false);
    const settingsOpen = ref(false);
    const settingsCategory = ref('tools');
    const settingsScope = ref('detail');
    const learningOpen = ref(false);
    const activeLearningView = ref<'study' | 'mistake'>('study');

    const mockContext = {
      layout: {
        menuOpen: ref(true),
        menuPillRef: ref(null),
        toggleMenu: vi.fn(),
        handlePillClick: vi.fn(),
        runMenuAction,
        openTool,
        openSettingsCategory: vi.fn(),
        toolsOpen,
        settingsOpen,
        settingsCategory,
        settingsScope,
        learningOpen,
        activeLearningView,
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(WorkbenchNavPill, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
          [UI_REGISTRY_KEY as symbol]: registry,
        },
      },
    });

    // Without plugin: 学习能力 should NOT exist
    expect(wrapper.text()).not.toContain('学习能力');
    const nativeItems = wrapper.findAll('.menu-item');
    expect(nativeItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '设置']);
    expect(nativeItems[0].classes()).not.toContain('is-active');

    // Toggle tools open -> tools menu item gains is-active
    toolsOpen.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.menu-item')[0].classes()).toContain('is-active');

    // 任意插件贡献的导航项按序渲染（CR-060：宿主不感知具体插件，用通用桩验证接缝）
    const PluginNavItem = defineComponent({
      props: { label: { type: String, default: '插件导航项' } },
      template: '<button class="menu-item" type="button">{{ label }}</button>',
    });
    const unregister = registry.registerSlotComponent('nav:menu-items', PluginNavItem, {
      id: 'plugin-a:nav-item',
      priority: 100,
      props: { label: '插件导航项' },
    });
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('插件导航项');
    const allItems = wrapper.findAll('.menu-item');
    expect(allItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '设置', '插件导航项']);

    // When plugin unregisters: 插件导航项 disappears
    unregister();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('插件导航项');
  });

  it('WorkbenchNavPill.vue renders compact fallback badge when a nav slot component fails', async () => {
    const registry = createUIRegistry();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const CrashingComponent = defineComponent({
      setup() {
        throw new Error('Boom in nav slot');
      },
      render() {
        return h('div', 'broken');
      },
    });

    registry.registerSlotComponent('nav:menu-items', CrashingComponent, {
      id: 'faulty-nav-item',
      priority: 10,
    });

    const mockContext = {
      layout: {
        menuOpen: ref(true),
        menuPillRef: ref(null),
        toggleMenu: vi.fn(),
        handlePillClick: vi.fn(),
        runMenuAction: vi.fn(),
        openTool: vi.fn(),
        openSettingsCategory: vi.fn(),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(WorkbenchNavPill, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
          [UI_REGISTRY_KEY as symbol]: registry,
        },
      },
    });

    await flushPromises();

    const fallback = wrapper.find('.menu-item-fallback');
    expect(fallback.exists()).toBe(true);
    expect(fallback.text()).toContain('⚠️ faulty-nav-item');

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('WorkbenchSideCards.vue renders card extraComponent dynamically without hardcoding', async () => {
    const registry = createUIRegistry();
    const activateCard = vi.fn();
    const selectCard = vi.fn();

    const ExtraWidget = defineComponent({
      render() {
        return h('div', { class: 'custom-card-extra-content' }, 'Custom Action Slot');
      },
    });

    const dummyIcon = markRaw(defineComponent({ render: () => h('span', 'icon') }));
    const rawExtraWidget = markRaw(ExtraWidget);

    const slotCards = ref([
      {
        id: 'study',
        label: '学习与专注',
        description: '保持专注',
        summary: () => '今日专注 0 分钟',
        icon: dummyIcon,
        extraComponent: rawExtraWidget,
      },
    ]);

    const mockContext = {
      layout: {
        assistantDisplayName: ref('思隅'),
      },
      timer: {
        timerRunning: ref(false),
        timerMinutes: ref(25),
        toggleTimer: vi.fn(),
        resetTimer: vi.fn(),
        selectPresetMinutes: vi.fn(),
      },
      cards: {
        slotCards,
        cardCatalog: ref([]),
        questionCardData: ref(null),
        questionCardSelected: ref([]),
        handleQuestionCardOption: vi.fn(),
        submitQuestionCardAnswers: vi.fn(),
        selectCard,
        activateCard,
        isCardPicked: vi.fn().mockReturnValue(false),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(WorkbenchSideCards, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
          [UI_REGISTRY_KEY as symbol]: registry,
        },
      },
    });

    expect(wrapper.find('.custom-card-extra-content').exists()).toBe(true);
    expect(wrapper.find('.custom-card-extra-content').text()).toBe('Custom Action Slot');

    // Remove extraComponent and verify dynamic reactivity
    slotCards.value = [
      {
        id: 'study',
        label: '学习与专注',
        description: '保持专注',
        summary: () => '今日专注 0 分钟',
        icon: dummyIcon,
        extraComponent: undefined,
      },
    ];
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.custom-card-extra-content').exists()).toBe(false);
  });

  it('SettingsModal.vue dynamically iterates over cards.cardCatalog for quick-tools and renders plugin rows via slot', async () => {
    const dummyIcon = markRaw(defineComponent({ render: () => h('span', 'icon') }));
    const cardAction1 = vi.fn();
    const cardAction2 = vi.fn();
    const settingsOpen = ref(true);

    const cardCatalog = ref<CardDefinition[]>([
      {
        id: 'study',
        label: '学习规划',
        description: '学习路线',
        icon: dummyIcon,
        summary: () => '2 份进行中规划',
        action: cardAction1,
      },
      {
        id: 'todo',
        label: '待办清单',
        description: '待办任务',
        icon: dummyIcon,
        summary: () => '3 件待完成',
        action: cardAction2,
      },
    ]);

    const mockContext = {
      layout: {
        settingsOpen,
        settingsCategory: ref('tools'),
        switchSettingsCategory: vi.fn(),
        focusModeEnabled: ref(false),
        setFocusModeEnabled: vi.fn(),
        isWeb: ref(false),
        isDark: ref(false),
        compactMode: ref(false),
        enterToSend: ref(true),
        desktopCompanionEnabled: ref(false),
        assistantDisplayName: ref('思隅'),
        settingsScope: ref('global'),
        scopedSettingCategories: ref([]),
        openTool: vi.fn(),
        workbenchMode: ref('companion'),
        switchWorkbenchMode: vi.fn(),
        setTheme: vi.fn(),
        saveSettings: vi.fn(),
      },
      timer: {
        timerMinutes: ref(25),
      },
      cards: {
        cardCatalog,
      },
      conversation: {
        toolApprovalMode: ref('tool_by_tool'),
        fullAccessDialogOpen: ref(false),
        fullAccessAcknowledged: ref(false),
      },
      proactive: {
        proactiveDialogOpen: ref(false),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(SettingsModal, {
      props: {
        focusModeAvailable: false,
      },
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
        stubs: {
          'el-dialog': {
            props: ['title'],
            template: '<div class="el-dialog-stub"><slot name="header" /><slot /></div>',
          },
        },
      },
    });

    const quickButtons = wrapper.findAll('.quick-tools button');
    expect(quickButtons).toHaveLength(2);
    expect(quickButtons[0].text()).toContain('学习规划');
    expect(quickButtons[0].text()).toContain('2 份进行中规划');
    expect(quickButtons[1].text()).toContain('待办清单');
    expect(quickButtons[1].text()).toContain('3 件待完成');

    await quickButtons[0].trigger('click');
    expect(cardAction1).toHaveBeenCalledTimes(1);
    expect(settingsOpen.value).toBe(false);

    // CR-060：宿主设置面板只在「对话」分类提供通用插槽，不内建任何插件行
    (mockContext.layout as any).settingsCategory.value = 'conversation';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('专注模式');
    expect(wrapper.find('input[name="focus-mode-setting"]').exists()).toBe(false);
  });

  it('SettingsModal.vue supports toggling quick tools customization mode and adding/removing/reordering tools', async () => {
    const dummyIcon = markRaw(defineComponent({ render: () => h('span', 'icon') }));
    const settingsOpen = ref(true);

    const tool1 = { id: 'study', label: '学习规划', description: '规划路线', icon: dummyIcon, summary: () => '进行中', action: vi.fn() };
    const tool2 = { id: 'todo', label: '待办清单', description: '待办任务', icon: dummyIcon, summary: () => '待办', action: vi.fn() };
    const tool3 = { id: 'timer', label: '番茄钟', description: '番茄计时', icon: dummyIcon, summary: () => '计时', action: vi.fn() };

    const activeQuickCards = ref<CardDefinition[]>([tool1, tool2]);
    const availableQuickCards = ref<CardDefinition[]>([tool3]);
    const addQuickTool = vi.fn((id: string) => {
      if (id === 'timer') {
        availableQuickCards.value = [];
        activeQuickCards.value.push(tool3);
      }
    });
    const removeQuickTool = vi.fn((id: string) => {
      if (id === 'study') {
        activeQuickCards.value = activeQuickCards.value.filter((c) => c.id !== id);
        availableQuickCards.value.push(tool1);
      }
    });
    const moveQuickTool = vi.fn();
    const resetQuickTools = vi.fn();

    const mockContext = {
      layout: {
        settingsOpen,
        settingsCategory: ref('tools'),
        switchSettingsCategory: vi.fn(),
        focusModeEnabled: ref(false),
        setFocusModeEnabled: vi.fn(),
        isWeb: ref(false),
        isDark: ref(false),
        compactMode: ref(false),
        enterToSend: ref(true),
        desktopCompanionEnabled: ref(false),
        assistantDisplayName: ref('思隅'),
        settingsScope: ref('global'),
        scopedSettingCategories: ref([]),
        openTool: vi.fn(),
        workbenchMode: ref('companion'),
        switchWorkbenchMode: vi.fn(),
        setTheme: vi.fn(),
        saveSettings: vi.fn(),
      },
      timer: { timerMinutes: ref(25) },
      cards: {
        cardCatalog: ref([tool1, tool2, tool3]),
        activeQuickCards,
        availableQuickCards,
        addQuickTool,
        removeQuickTool,
        moveQuickTool,
        resetQuickTools,
      },
      conversation: {
        toolApprovalMode: ref('tool_by_tool'),
        fullAccessDialogOpen: ref(false),
        fullAccessAcknowledged: ref(false),
      },
      proactive: {
        proactiveDialogOpen: ref(false),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(SettingsModal, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
        stubs: {
          'el-dialog': {
            props: ['title'],
            template: '<div class="el-dialog-stub"><slot name="header" /><slot /></div>',
          },
        },
      },
    });

    // 1. Initial state: normal mode displays active tools
    expect(wrapper.find('.quick-tools').exists()).toBe(true);
    expect(wrapper.find('.control-center-edit-container').exists()).toBe(false);
    expect(wrapper.findAll('.quick-tools button')).toHaveLength(2);

    // 2. Click "自定义" button to enter edit mode
    const customBtn = wrapper.find('.quick-tools-action-btn');
    expect(customBtn.text()).toContain('自定义');
    await customBtn.trigger('click');

    // 3. Edit mode is active
    expect(wrapper.find('.control-center-edit-container').exists()).toBe(true);
    expect(customBtn.text()).toContain('完成');

    // Check included tools and more available tools
    const includedItems = wrapper.findAll('.control-center-item.is-included');
    expect(includedItems).toHaveLength(2);
    expect(includedItems[0].text()).toContain('学习规划');
    expect(includedItems[1].text()).toContain('待办清单');

    const availableItems = wrapper.findAll('.control-center-item.is-available');
    expect(availableItems).toHaveLength(1);
    expect(availableItems[0].text()).toContain('番茄钟');

    // 4. Test move tool (up on second item)
    const upBtn = includedItems[1].findAll('.order-btn')[0];
    await upBtn.trigger('click');
    expect(moveQuickTool).toHaveBeenCalledWith('todo', 'up');

    // 5. Test remove tool click
    const minusBtn = includedItems[0].find('.btn-minus');
    await minusBtn.trigger('click');
    expect(removeQuickTool).toHaveBeenCalledWith('study');

    // 6. Test add tool click
    const plusBtn = availableItems[0].find('.btn-plus');
    await plusBtn.trigger('click');
    expect(addQuickTool).toHaveBeenCalledWith('timer');

    // 7. Test reset button
    const resetBtn = wrapper.find('.btn-reset');
    expect(resetBtn.exists()).toBe(true);
    await resetBtn.trigger('click');
    expect(resetQuickTools).toHaveBeenCalledTimes(1);

    // 8. Click "完成" to exit edit mode
    await customBtn.trigger('click');
    expect(wrapper.find('.control-center-edit-container').exists()).toBe(false);
    expect(wrapper.find('.quick-tools').exists()).toBe(true);
  });

  it('ToolsDrawer.vue does not open history side drawer on tab switch, and closes dialog while opening side drawer when button is clicked', async () => {
    const toolsOpen = ref(true);
    const historyOpen = ref(false);
    const activeToolView = ref<'todo' | 'timer' | 'history' | 'diary'>('todo');
    const switchToolView = vi.fn((target: 'todo' | 'timer' | 'history' | 'diary') => {
      activeToolView.value = target;
    });

    const mockContext = {
      layout: {
        toolsOpen,
        historyOpen,
        activeToolView,
        toolsNavItems: [
          { id: 'todo', label: '待办清单', description: '', icon: markRaw(defineComponent({ render: () => h('span') })) },
          { id: 'history', label: '对话回看', description: '', icon: markRaw(defineComponent({ render: () => h('span') })) },
        ],
        switchToolView,
      },
      timer: {
        timerMinutes: ref(25),
        timerRunning: ref(false),
        formattedTime: ref('25:00'),
        timerArcDashoffset: ref(0),
        thumbAngle: ref(0),
        toggleTimer: vi.fn(),
        resetTimer: vi.fn(),
        selectPresetMinutes: vi.fn(),
        handleDialPointerDown: vi.fn(),
      },
      cards: {
        todos: ref([]),
        newTodo: ref(''),
        unfinishedTodos: ref([]),
        completedTodoCount: ref(0),
        syncGoals: ref([]),
        syncReviewCount: ref(0),
        syncedTodoCount: ref(0),
        goalBusyId: ref(null),
        addTodo: vi.fn(),
        completeGoalFromTodo: vi.fn(),
        toggleGoalPausedFromTodo: vi.fn(),
        todayDiary: ref(null),
        viewingDiary: ref(null),
        diaryHistory: ref([]),
        diaryBusy: ref(false),
        diaryError: ref(null),
        diaryDisplayContent: ref(''),
        generateDiaryNow: vi.fn(),
        selectDiaryDate: vi.fn(),
        completeReview: vi.fn(),
        reviewBusyId: ref(null),
      },
      conversation: {
        story: ref([{ id: '1', speaker: 'assistant', text: '你好' }]),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(ToolsDrawer, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
        stubs: {
          'el-dialog': {
            props: ['title'],
            template: '<div class="el-dialog-stub"><slot name="header" /><slot /></div>',
          },
        },
      },
    });

    // 1. Initially activeToolView is 'todo', historyOpen is false
    expect(historyOpen.value).toBe(false);

    // 2. Switch to 'history' tab
    activeToolView.value = 'history';
    await wrapper.vm.$nextTick();

    // Side drawer must NOT be opened when merely viewing history tab
    expect(historyOpen.value).toBe(false);
    expect(toolsOpen.value).toBe(true);
    expect(wrapper.text()).toContain('打开对话回看（1 条记录）');

    // 3. Click "打开对话回看" button
    const openBtn = wrapper.find('.diary-generate-btn');
    expect(openBtn.exists()).toBe(true);
    await openBtn.trigger('click');

    // Dialog closes and side drawer opens
    expect(toolsOpen.value).toBe(false);
    expect(historyOpen.value).toBe(true);
  });
});
