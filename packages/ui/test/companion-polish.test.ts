import { afterEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { WORKBENCH_CONTEXT_KEY } from '../src/composables/workbench-context';
import { useWorkbenchComposer } from '../src/composables/useWorkbenchComposer';
import WorkbenchSideCards from '../src/components/workbench/WorkbenchSideCards.vue';
import ComposerDock from '../src/components/workbench/ComposerDock.vue';
import ConversationConsole from '../src/components/workbench/ConversationConsole.vue';

enableAutoUnmount(afterEach);

it('closes the tool picker with Escape and restores focus to its opener', async () => {
  const wrapper = mount(WorkbenchSideCards, {
    attachTo: document.body,
    global: {
      stubs: { ExtensionSlot: true },
      provide: { [WORKBENCH_CONTEXT_KEY as symbol]: {
        layout: { companionDisplayName: ref('小隅') },
        timer: { timerRunning: ref(false), timerMinutes: ref(25) },
        cards: {
          slotCards: ref([null, null]), cardCatalog: ref([{ id: 'todo', label: '待办清单' }]),
          questionCardData: ref(null), questionCardSelected: ref([]), isCardPicked: () => true,
        },
      } },
    },
  });
  await wrapper.get('.side-card-add').trigger('click');
  expect(wrapper.get('.side-card-grid-item').attributes('disabled')).toBeDefined();
  expect(wrapper.get('.side-card-picked-icon').attributes('aria-label')).toBe('已添加');
  await wrapper.get('.side-card-picker').trigger('keydown', { key: 'Escape' });
  await nextTick();
  expect(wrapper.find('#side-card-choices').exists()).toBe(false);
  expect(document.activeElement).toBe(wrapper.get('.side-card-add').element);
});

it('blocks form submission while busy and describes voice preparation to the input', async () => {
  const streaming = ref(false);
  const send = vi.fn().mockResolvedValue(undefined);
  const composer = useWorkbenchComposer({ onSendMessage: send, streaming, fullAccessDialogOpen: ref(false) });
  const wrapper = mount(ComposerDock, {
    props: { onSend: send },
    global: {
      stubs: { ExtensionSlot: true, ComposerAttachments: true },
      provide: { [WORKBENCH_CONTEXT_KEY as symbol]: {
        composer, sendMessage: send,
        layout: { isWeb: ref(true), enterToSend: ref(true), workbenchMode: ref('companion') },
        conversation: { streaming, toolApprovalMode: ref('ask'), toggleToolApprovalMode: vi.fn() },
        proactive: { proactiveActive: ref(false) },
      } },
    },
  });
  await wrapper.get('form').trigger('submit');
  expect(send).not.toHaveBeenCalled();
  await wrapper.get('textarea').setValue('下一条消息');
  streaming.value = true;
  await nextTick();
  await wrapper.get('form').trigger('submit');
  expect(send).not.toHaveBeenCalled();
  streaming.value = false;
  composer.voiceInputStarting.value = true;
  await nextTick();
  expect(wrapper.get('[role="status"]').text()).toContain('正在准备语音输入');
  expect(wrapper.get('textarea').attributes('aria-describedby')).toBe('aervox-composer-status');
  composer.voiceInputStarting.value = false;
  await wrapper.get('form').trigger('submit');
  expect(send).toHaveBeenCalledWith('下一条消息');
});

it('keeps run details available when the dialogue is collapsed', async () => {
  const collapsed = ref(true);
  const wrapper = mount(ConversationConsole, {
    global: {
      stubs: {
        ExtensionSlot: true, ToolApprovalCard: true,
        TurnDiagnostics: defineComponent({ props: ['turnId'], template: '<button class="diagnostic-test">运行详情</button>' }),
      },
      provide: { [WORKBENCH_CONTEXT_KEY as symbol]: {
        layout: { companionDisplayName: ref('小隅'), historyOpen: ref(false) },
        conversation: {
          consoleCollapsed: collapsed, collapsedSummaryText: ref('已完成'), storyViewport: ref(null),
          story: ref([{}, {}]), latestAssistantLine: ref({ text: '回复', state: 'done', turnId: 'turn_saved' }),
          novelStreamingText: ref(''), novelIndex: ref(0), novelDisplayText: ref('回复'),
          novelSentences: ref(['回复']), hasQueuedSentence: ref(false), queuedSentenceCount: ref(0),
        },
      } },
    },
  });
  expect(wrapper.find('.diagnostic-test').exists()).toBe(true);
  expect(wrapper.find('.message-history-entry').exists()).toBe(false);
  collapsed.value = false;
  await nextTick();
  expect(wrapper.find('.diagnostic-test').exists()).toBe(true);
  expect(wrapper.find('.message-history-entry').exists()).toBe(true);
});
