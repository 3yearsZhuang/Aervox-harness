import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref, defineComponent, h } from 'vue';
import StudyModeSwitch from '../src/plugins/study-mode/StudyModeSwitch.vue';
import FocusNavMenuItem from '../src/plugins/focus-mode/FocusNavMenuItem.vue';
import WorkbenchNavPill from '../src/components/workbench/WorkbenchNavPill.vue';
import { registerFocusModePlugin } from '../src/plugins';
import ExtensionSlot from '../src/components/extension/ExtensionSlot.vue';
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

  it('FocusNavMenuItem.vue mounts, displays label and triggers runMenuAction with openTool study on click', async () => {
    const runMenuAction = vi.fn((action: () => void) => action());
    const openTool = vi.fn();
    const mockContext = {
      layout: {
        runMenuAction,
        openTool,
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
    await wrapper.trigger('click');
    expect(runMenuAction).toHaveBeenCalledTimes(1);
    expect(openTool).toHaveBeenCalledWith('study');
  });

  it('WorkbenchNavPill.vue decouples focus mode: no hardcoded 学习能力 without plugin, renders sequentially when registered', async () => {
    const registry = createUIRegistry();
    const openTool = vi.fn();
    const runMenuAction = vi.fn((action: () => void) => action());
    const mockContext = {
      layout: {
        menuOpen: ref(true),
        menuPillRef: ref(null),
        toggleMenu: vi.fn(),
        handlePillClick: vi.fn(),
        runMenuAction,
        openTool,
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

    // Without plugin: 学习能力 should NOT exist
    expect(wrapper.text()).not.toContain('学习能力');
    const nativeItems = wrapper.findAll('.menu-item');
    expect(nativeItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '详细设置', '你的思隅']);

    // When focus-mode registers: nav:menu-items renders 学习能力 sequentially
    const unregister = registerFocusModePlugin(registry, mockContext);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('学习能力');
    const allItems = wrapper.findAll('.menu-item');
    expect(allItems.map((el) => el.text())).toEqual(['工具管理', '主动智能', '详细设置', '你的思隅', '学习能力']);

    // When plugin unregisters: 学习能力 disappears
    unregister();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).not.toContain('学习能力');
  });
});
