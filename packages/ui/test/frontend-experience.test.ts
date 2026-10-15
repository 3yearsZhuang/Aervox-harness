import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { defineComponent, effectScope, nextTick, ref } from 'vue';
import { useWorkbenchComposer } from '../src/composables/useWorkbenchComposer';
import { useWorkbenchLayout } from '../src/composables/useWorkbenchLayout';
import { WORKBENCH_CONTEXT_KEY } from '../src/composables/workbench-context';
import ComposerDock from '../src/components/workbench/ComposerDock.vue';
import WorkbenchSideCards from '../src/components/workbench/WorkbenchSideCards.vue';
import { AervoxSegmentedControl, AervoxSwitch } from '../src/primitives';

const llm = vi.hoisted(() => ({
  getConfig: vi.fn(), listPresets: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn(),
}));

vi.mock('@aervox/api-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({
    ...llm,
    presetProviders: [{ id: 'ollama', name: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', recommendedModels: ['example-model'] }],
  }),
}));

enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

function composerFixture() {
  const streaming = ref(false);
  const draftSessionId = ref('current');
  const send = vi.fn().mockResolvedValue(undefined);
  const composer = useWorkbenchComposer({
    onSendMessage: send, streaming, fullAccessDialogOpen: ref(false),
    draftSessionId, draftsEnabled: ref(true),
  });
  const wrapper = mount(ComposerDock, {
    props: { onSend: send },
    global: {
      stubs: { ExtensionSlot: true, ComposerAttachments: true },
      provide: {
        [WORKBENCH_CONTEXT_KEY as symbol]: {
          composer, sendMessage: send,
          layout: { isWeb: ref(true), enterToSend: ref(true), workbenchMode: ref('companion') },
          conversation: { streaming, story: ref([]), toolApprovalMode: ref('ask'), toggleToolApprovalMode: vi.fn() },
          proactive: { proactiveActive: ref(false) },
        },
      },
    },
  });
  return { wrapper, composer, streaming, send, draftSessionId };
}

describe('frontend experience', () => {
  it('keeps a controlled switch off until the owner accepts the change', async () => {
    const wrapper = mount(AervoxSwitch, { props: { checked: false, 'aria-label': '工具授权' } });
    await wrapper.get('input').setValue(true);
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
    expect(wrapper.emitted('change')).toHaveLength(1);
    expect((wrapper.get('input').element as HTMLInputElement).checked).toBe(false);
    await wrapper.setProps({ checked: true });
    expect((wrapper.get('input').element as HTMLInputElement).checked).toBe(true);
  });

  it('updates a switch bound with v-model and retains its native accessible control', async () => {
    const value = ref(false);
    const wrapper = mount(defineComponent({
      components: { AervoxSwitch }, setup: () => ({ value }),
      template: '<label>保留草稿<AervoxSwitch v-model="value" /></label>',
    }));
    await wrapper.get('[role="switch"]').setValue(true);
    expect(value.value).toBe(true);
    expect((wrapper.get('input').element as HTMLInputElement).checked).toBe(true);
  });

  it('keeps a simple input available without starter buttons or blur collapse', async () => {
    const { wrapper, send } = composerFixture();
    expect(wrapper.get('textarea').attributes('rows')).toBe('1');
    expect(wrapper.find('.composer-starters').exists()).toBe(false);
    await wrapper.get('.composer-dock').trigger('focusout');
    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('allows the next draft during streaming and preserves it when the previous reply succeeds or fails', async () => {
    const { wrapper, composer, streaming, send } = composerFixture();
    composer.beginDraftSubmission('第一条消息', 'current');
    streaming.value = true;
    await nextTick();
    const textarea = wrapper.get('textarea');
    expect(textarea.attributes('disabled')).toBeUndefined();
    await textarea.setValue('下一条草稿');
    await textarea.trigger('keydown', { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(wrapper.get('.composer-send').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[role="status"]').text()).toContain('可以先写下一条');
    composer.restoreFailedDraft();
    expect(composer.input.value).toBe('下一条草稿');
    composer.completeDraftSubmission('current');
    expect(localStorage.getItem('aervox-mobile-draft:current')).toBe('下一条草稿');
    streaming.value = false;
    await nextTick();
    expect(wrapper.get('.composer-send').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('keeps the next draft in its own session when a reply finishes after switching sessions', async () => {
    const { composer, draftSessionId } = composerFixture();
    await nextTick();
    composer.beginDraftSubmission('再解释一次', 'current');
    // Identical text is still a new draft; completion must not remove it.
    composer.input.value = '再解释一次';
    await nextTick();
    draftSessionId.value = 'other';
    await nextTick();
    composer.input.value = '另一个会话的草稿';
    await nextTick();
    composer.completeDraftSubmission('current');
    expect(localStorage.getItem('aervox-mobile-draft:current')).toBe('再解释一次');
    expect(composer.input.value).toBe('另一个会话的草稿');
    expect(localStorage.getItem('aervox-mobile-draft:other')).toBe('另一个会话的草稿');
    draftSessionId.value = 'current';
    await nextTick();
    expect(composer.input.value).toBe('再解释一次');
  });

  it('does not restore a next draft that was cleared while a reply was streaming', async () => {
    const { composer, draftSessionId } = composerFixture();
    await nextTick();
    composer.beginDraftSubmission('已提交', 'current');
    composer.input.value = '待清除的草稿';
    await nextTick();
    composer.input.value = '';
    await nextTick();
    draftSessionId.value = 'other';
    await nextTick();
    composer.completeDraftSubmission('current');
    expect(localStorage.getItem('aervox-mobile-draft:current')).toBeNull();
  });

  it('uses one tool picker while leaving a temporary question slot intact', async () => {
    const selectCard = vi.fn();
    const question = ref<unknown>(null);
    const wrapper = mount(WorkbenchSideCards, {
      global: {
        stubs: { ExtensionSlot: true },
        provide: {
          [WORKBENCH_CONTEXT_KEY as symbol]: {
            layout: { companionDisplayName: ref('思隅') },
            timer: { timerRunning: ref(false), timerMinutes: ref(25) },
            cards: {
              slotCards: ref([null, null]),
              cardCatalog: ref([{ id: 'todo', label: '待办清单' }]),
              questionCardData: question, questionCardSelected: ref([]), selectCard,
              isCardPicked: () => false,
            },
          },
        },
      },
    });
    expect(wrapper.findAll('.side-card-placeholder')).toHaveLength(0);
    expect(wrapper.findAll('.side-card-add')).toHaveLength(1);
    question.value = { id: 'q', question: '请选择', options: [] };
    await wrapper.get('.side-card-add').trigger('click');
    await wrapper.get('.side-card-grid-item').trigger('click');
    expect(selectCard).toHaveBeenCalledWith(1, 'todo', expect.anything());
    expect(wrapper.find('.side-question-card').exists()).toBe(true);
    expect(wrapper.find('#side-card-choices').exists()).toBe(false);
    wrapper.unmount();
  });

  it('starts narrow navigation closed and follows viewport changes without retaining listeners', () => {
    let onChange: (() => void) | undefined;
    const removeEventListener = vi.fn();
    const media = { matches: true, addEventListener: vi.fn((_, callback) => { onChange = callback; }), removeEventListener };
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList);
    const scope = effectScope();
    const layout = scope.run(() => useWorkbenchLayout(
      { platform: 'web', showCompanion: true, companionName: '小隅' }, { recordActivity: vi.fn() },
    ))!;
    expect(layout.narrowSidebar.value).toBe(true);
    expect(layout.standardSidebarCollapsed.value).toBe(true);
    layout.toggleStandardSidebar();
    expect(layout.standardSidebarCollapsed.value).toBe(false);
    media.matches = false;
    onChange?.();
    expect(layout.narrowSidebar.value).toBe(false);
    expect(layout.standardSidebarCollapsed.value).toBe(false);
    scope.stop();
    expect(removeEventListener).toHaveBeenCalledWith('change', onChange);
  });

  it('supports keyboard selection and skips disabled segmented options', async () => {
    const wrapper = mount(AervoxSegmentedControl, {
      attachTo: document.body,
      props: {
        modelValue: 'first', label: '配置类型',
        options: [{ value: 'first', label: '第一项' }, { value: 'disabled', label: '不可用', disabled: true }, { value: 'last', label: '末项' }],
      },
    });
    await wrapper.findAll('button')[0]!.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['last']);
    expect(document.activeElement).toBe(wrapper.findAll('button')[2]!.element);
    await wrapper.findAll('button')[2]!.trigger('keydown', { key: 'Home' });
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual(['first']);
    expect(document.activeElement).toBe(wrapper.findAll('button')[0]!.element);
  });

});
