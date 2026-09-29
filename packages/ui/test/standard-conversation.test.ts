import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import StandardConversation from '../src/components/workbench/StandardConversation.vue';
import { WORKBENCH_CONTEXT_KEY } from '../src/composables/workbench-context';
import type { StoryLine } from '../src/composables/useWorkbenchConversation';

afterEach(() => vi.restoreAllMocks());

function fixture(lines: StoryLine[]) {
  const story = ref(lines);
  const handleApprovalDecision = vi.fn();
  const pendingApproval = ref<unknown>(null);
  const wrapper = mount(StandardConversation, {
    global: {
      provide: {
        [WORKBENCH_CONTEXT_KEY as symbol]: {
          layout: { assistantDisplayName: ref('思隅') },
          conversation: {
            story, streaming: ref(false), pendingApproval,
            approvalBusy: ref(false), approvalToolLabel: ref('测试工具'),
            handleApprovalDecision,
          },
          sendMessage: vi.fn(),
        },
      },
      stubs: { ExtensionSlot: { props: ['name', 'context'], template: '<div :data-slot="name" />' } },
    },
  });
  return { wrapper, story, handleApprovalDecision, pendingApproval };
}

describe('standard conversation', () => {
  it('keeps tool approval controls connected to the existing decision handler', async () => {
    const { wrapper, pendingApproval, handleApprovalDecision } = fixture([]);
    pendingApproval.value = { approvalId: 'approval-test' };
    await flushPromises();
    expect(wrapper.text()).toContain('测试工具');
    const buttons = wrapper.findAll('.tool-approval-actions button');
    await buttons[0].trigger('click');
    expect(handleApprovalDecision).toHaveBeenCalledWith('granted', expect.any(Function));
    await buttons[1].trigger('click');
    expect(handleApprovalDecision).toHaveBeenCalledWith('denied', expect.any(Function));
    wrapper.unmount();
  });
  it('renders all turns and streaming text beyond the first sentence, with attachments and extension slots', async () => {
    const { wrapper, story } = fixture([
      { id: 1, speaker: 'assistant', text: '第一句。第二句。', state: 'complete' },
      { id: 2, speaker: 'user', text: '继续\n解释', attachments: [{ name: '笔记.pdf', mediaType: 'application/pdf' }] },
      { id: 3, speaker: 'assistant', text: '流式第一句。', state: 'streaming' },
    ]);
    story.value[2].text += '流式第二句。\n\n**重点**';
    await flushPromises();
    expect(wrapper.findAll('article')).toHaveLength(3);
    expect(wrapper.text()).toContain('第二句。');
    expect(wrapper.text()).toContain('流式第二句。');
    expect(wrapper.find('strong').text()).toBe('重点');
    expect(wrapper.text()).toContain('笔记.pdf');
    expect(wrapper.findAll('[aria-label="复制回复"]')).toHaveLength(1);
    expect(wrapper.find('[data-slot="conversation:top"]').exists()).toBe(true);
    expect(wrapper.find('[data-slot="conversation:bottom"]').exists()).toBe(true);
    expect(wrapper.find('[data-slot="message:bubble-actions"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('下一句');
    wrapper.unmount();
  });

  it('copies the full reply and reports clipboard failure', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { wrapper } = fixture([{ id: 1, speaker: 'assistant', text: '完整。回复。', state: 'complete' }]);
    await wrapper.get('[aria-label="复制回复"]').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith('完整。回复。');
    expect(wrapper.find('[aria-label="已复制回复"]').exists()).toBe(true);
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    await wrapper.get('[aria-label="已复制回复"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('无法复制');
    wrapper.unmount();
  });

  it('keeps the reading position during streaming, then follows again on request or session reset', async () => {
    const { wrapper, story } = fixture([{ id: 1, speaker: 'assistant', text: '内容', state: 'streaming' }]);
    await flushPromises();
    const scroll = wrapper.get('.standard-message-scroll');
    const el = scroll.element as HTMLElement;
    Object.defineProperties(el, { scrollHeight: { value: 1200 }, clientHeight: { value: 400 } });
    el.scrollTop = 100;
    await scroll.trigger('scroll');
    story.value[0].text += '继续生成';
    await flushPromises();
    expect(el.scrollTop).toBe(100);
    await wrapper.get('.standard-jump-latest').trigger('click');
    await flushPromises();
    expect(el.scrollTop).toBe(1200);
    el.scrollTop = 100;
    await scroll.trigger('scroll');
    story.value = [{ id: 1, speaker: 'assistant', text: '新的会话' }];
    await flushPromises();
    expect(el.scrollTop).toBe(1200);
    expect(wrapper.find('.standard-jump-latest').exists()).toBe(false);
    wrapper.unmount();
  });
});
