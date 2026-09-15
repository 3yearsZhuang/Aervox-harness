import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h, markRaw } from 'vue';
import StudyModeSwitch from '../src/plugins/study-mode/StudyModeSwitch.vue';
import FocusNavMenuItem from '../src/plugins/focus-mode/FocusNavMenuItem.vue';
import FocusStudyCardActions from '../src/plugins/focus-mode/FocusStudyCardActions.vue';
import FocusTaskCenterCard from '../src/plugins/focus-mode/FocusTaskCenterCard.vue';
import SettingsModal from '../src/components/workbench/drawers/SettingsModal.vue';
import WorkbenchNavPill from '../src/components/workbench/WorkbenchNavPill.vue';
import WorkbenchSideCards from '../src/components/workbench/WorkbenchSideCards.vue';
import { registerFocusModePlugin } from '../src/plugins';
import ExtensionSlot from '../src/components/extension/ExtensionSlot.vue';
import type { CardDefinition } from '../src/composables/useWorkbenchCards';
import { WORKBENCH_CONTEXT_KEY, type WorkbenchContext } from '../src/composables/workbench-context';
import { createUIRegistry, UI_REGISTRY_KEY } from '../src/registry/ui-registry';

describe('Real SFC Component Mounting', () => {
  it('StudyModeSwitch.vue mounts, reads layout context and toggles mode on click', async () => {
    const studyModeEnabled = ref(false);
    const toggleStudyMode = vi.fn(() => {
      studyModeEnabled.value = !studyModeEnabled.value;
    });

    const mockContext = {
      layout: {
        studyModeEnabled,
        toggleStudyMode,
        setStudyModeEnabled: vi.fn((val: boolean) => {
          studyModeEnabled.value = val;
        }),
      },
      timer: {} as any,
      composer: {} as any,
      conversation: {} as any,
      cards: {} as any,
      proactive: {} as any,
      sendMessage: vi.fn(),
      submitQuizAnswer: vi.fn(),
    } as unknown as WorkbenchContext;

    const wrapper = mount(StudyModeSwitch, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    // Check initial state
    expect(wrapper.find('.study-switch-track').attributes('aria-checked')).toBe('false');
    expect(wrapper.find('.study-switch-label').text()).toBe('专注模式');

    // Click track button
    await wrapper.find('.study-switch-track').trigger('click');
    expect(toggleStudyMode).toHaveBeenCalledTimes(1);
    expect(studyModeEnabled.value).toBe(true);

    // Re-render reflects updated state
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.study-switch-track').attributes('aria-checked')).toBe('true');
  });

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

  it('FocusNavMenuItem.vue mounts, displays label, tooltip and handles active state & click action', async () => {
    const runMenuAction = vi.fn((action: () => void) => action());
    const openTool = vi.fn();
    const learningOpen = ref(false);
    const activeLearningView = ref<'study' | 'mistake'>('study');

    const mockContext = {
      layout: {
        runMenuAction,
        openTool,
        learningOpen,
        activeLearningView,
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(FocusNavMenuItem, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    expect(wrapper.text()).toContain('学习能力');
    expect(wrapper.attributes('title')).toBe('学习能力');
    expect(wrapper.classes()).not.toContain('is-active');

    // Activate study drawer
    learningOpen.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).toContain('is-active');

    // Switch to mistake view -> should not be active for study item
    activeLearningView.value = 'mistake';
    await wrapper.vm.$nextTick();
    expect(wrapper.classes()).not.toContain('is-active');

    // Trigger click
    await wrapper.trigger('click');
    expect(runMenuAction).toHaveBeenCalledTimes(1);
    expect(openTool).toHaveBeenCalledWith('study');
  });

  it('WorkbenchNavPill.vue decouples focus mode: handles active states and renders plugin item sequentially', async () => {
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
    expect(nativeItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '详细设置', '你的思隅']);
    expect(nativeItems[0].classes()).not.toContain('is-active');

    // Toggle tools open -> tools menu item gains is-active
    toolsOpen.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.menu-item')[0].classes()).toContain('is-active');

    // When focus-mode registers: nav:menu-items renders 学习能力 sequentially
    const unregister = registerFocusModePlugin(registry, mockContext);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('学习能力');
    const allItems = wrapper.findAll('.menu-item');
    expect(allItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '详细设置', '你的思隅', '学习能力']);

    // Activate study view -> 学习能力 gains is-active
    learningOpen.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.menu-item')[4].classes()).toContain('is-active');

    // When plugin unregisters: 学习能力 disappears
    unregister();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('学习能力');
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

  it('FocusStudyCardActions.vue mounts and triggers operations on button clicks', async () => {
    const openDailyProblem = vi.fn();
    const openTool = vi.fn();
    const focusModeEnabled = ref(true);

    const mockContext = {
      layout: {
        openTool,
        focusModeEnabled,
      },
      cards: {
        openDailyProblem,
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(FocusStudyCardActions, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    const buttons = wrapper.findAll('button');
    expect(buttons.length).toBe(3);
    expect(buttons[0].text()).toContain('每日一题');
    expect(buttons[1].text()).toContain('开始专注');
    expect(buttons[2].text()).toContain('错题重练');

    await buttons[0].trigger('click');
    expect(openDailyProblem).toHaveBeenCalledTimes(1);

    await buttons[1].trigger('click');
    expect(openTool).toHaveBeenCalledWith('timer');

    await buttons[2].trigger('click');
    expect(openTool).toHaveBeenCalledWith('mistake');

    // When focus mode is toggled off, action container is hidden
    focusModeEnabled.value = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.focus-study-card-actions').exists()).toBe(false);
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

  it('FocusTaskCenterCard.vue renders review tag and triggers navigation on button clicks', async () => {
    const openTool = vi.fn();
    const taskCenterOpen = ref(true);

    const mockContext = {
      layout: {
        taskCenterOpen,
        openTool,
      },
      cards: {
        syncReviewCount: ref(5),
      },
    } as unknown as WorkbenchContext;

    const wrapper = mount(FocusTaskCenterCard, {
      global: {
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: mockContext,
        },
      },
    });

    expect(wrapper.find('.focus-task-center-card').exists()).toBe(true);
    expect(wrapper.text()).toContain('间隔复习与错题排期');
    expect(wrapper.text()).toContain('5 个待复习');

    const buttons = wrapper.findAll('button');
    expect(buttons).toHaveLength(2);

    await buttons[0].trigger('click');
    expect(openTool).toHaveBeenCalledWith('mistake');
    expect(taskCenterOpen.value).toBe(false);

    taskCenterOpen.value = true;
    await buttons[1].trigger('click');
    expect(openTool).toHaveBeenCalledWith('study');
    expect(taskCenterOpen.value).toBe(false);
  });

  it('SettingsModal.vue dynamically iterates over cards.cardCatalog for quick-tools and reacts to focusModeAvailable', async () => {
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

    // Switch to conversation category to test focusModeAvailable v-if
    (mockContext.layout as any).settingsCategory.value = 'conversation';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('专注模式');

    // If focusModeAvailable is true, the row is rendered
    await wrapper.setProps({ focusModeAvailable: true });
    expect(wrapper.text()).toContain('专注模式');
  });
});
