import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import type { SessionHistoryPage, SessionItem } from '@aervox/contracts';

const history = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('@aervox/api-client', async importOriginal => {
  const actual = await importOriginal<typeof import('@aervox/api-client')>();
  return { ...actual, createSessionHistoryClient: () => ({ getPage: history.getPage }) };
});
import { AervoxHttpError, configureAervoxClient, getSessionId } from '@aervox/api-client';
import MobileSessionsDialog from '../src/MobileSessionsDialog.vue';
import MobileHistoryDialog from '../src/MobileHistoryDialog.vue';

enableAutoUnmount(afterEach);
const Dialog = defineComponent({
  props: { modelValue: Boolean, title: String, subtitle: String },
  emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    return () => props.modelValue ? h('section', { role: 'dialog', 'aria-label': props.title }, [
      h('h2', props.title), h('p', props.subtitle),
      h('button', { 'aria-label': '关闭面板', onClick: () => emit('update:modelValue', false) }, '关闭'),
      slots.default?.(),
    ]) : null;
  },
});
const global = { stubs: { AervoxDialog: Dialog } };
const request = vi.fn(), streamTurn = vi.fn(), observeTurn = vi.fn();
const savedSessions: SessionItem[] = [
  { id: 'ses_sql', title: 'SQLite 整理', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T01:00:00Z' },
  { id: 'ses_trip', title: '旅行安排', createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T01:00:00Z' },
];
function savedPage(sessionId: string, content: string, nextCursor: string | null = null): SessionHistoryPage {
  return { sessionId, nextCursor, items: [{ turnId: `turn_${sessionId}`, status: 'Completed', isComplete: true, createdAt: 'now', messages: [{
    messageId: 'msg', versionId: 'v1', version: 4, role: 'assistant', contentKind: 'message', content,
    visibility: 'available', readOnly: false, legacy: false, createdAt: 'now',
  }] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function button(wrapper: VueWrapper, name: string) {
  const found = wrapper.findAll('button').find(item => item.attributes('aria-label') === name || item.text() === name);
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
beforeEach(() => {
  history.getPage.mockReset(); request.mockReset(); streamTurn.mockReset(); observeTurn.mockReset();
  history.getPage.mockResolvedValue(savedPage('ses_inspected', '保存的回复'));
  configureAervoxClient({ sessionId: 'ses_live', platform: {}, transport: {
    request: request as never, streamTurn: streamTurn as never, observeTurn: observeTurn as never,
    submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(),
  } });
});

describe('mobile session panel intent wiring', () => {
  it.each([{ switchLocked: true, changing: false }, { switchLocked: false, changing: true }])(
    'keeps search and read-only history available while creation and switching are locked: %j', async flags => {
      const wrapper = mount(MobileSessionsDialog, { props: {
        modelValue: true, sessions: savedSessions, activeSessionId: 'ses_sql', ...flags, lockReason: '等待本轮回答完成',
      }, global });
      expect(button(wrapper, '新对话').attributes('disabled')).toBeDefined();
      expect(wrapper.findAll('.mobile-session-select').every(item => item.attributes('disabled') !== undefined)).toBe(true);
      await wrapper.get('input[aria-label="搜索会话"]').setValue('  sQlItE  ');
      expect(wrapper.findAll('.mobile-session-list li')).toHaveLength(1);
      expect(wrapper.get('.mobile-session-list').text()).toContain('SQLite 整理');
      await button(wrapper, '回看「SQLite 整理」').trigger('click');
      expect(wrapper.emitted('history')).toEqual([[savedSessions[0]]]);
      await button(wrapper, '新对话').trigger('click');
      // Also exercise the component's select guard if a native event is delivered.
      wrapper.get('.mobile-session-select').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(wrapper.emitted('new')).toBeUndefined(); expect(wrapper.emitted('select')).toBeUndefined();
      if (flags.switchLocked) expect(wrapper.get('[role="status"]').text()).toBe('等待本轮回答完成');
      expect(request).not.toHaveBeenCalled(); expect(streamTurn).not.toHaveBeenCalled();
    },
  );
  it('emits explicit creation, selection and close intents without executing conversation work', async () => {
    const wrapper = mount(MobileSessionsDialog, { props: { modelValue: true, sessions: savedSessions, activeSessionId: 'ses_sql' }, global });
    expect(wrapper.get('.mobile-session-select[aria-current="true"]').text()).toContain('当前会话');
    await button(wrapper, '新对话').trigger('click');
    await wrapper.findAll('.mobile-session-select')[1]!.trigger('click');
    await button(wrapper, '关闭面板').trigger('click');
    expect(wrapper.emitted('new')).toEqual([[]]); expect(wrapper.emitted('select')).toEqual([['ses_trip']]);
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
    expect(getSessionId()).toBe('ses_live'); expect(request).not.toHaveBeenCalled(); expect(streamTurn).not.toHaveBeenCalled();
  });
  it.each([{ sessions: [] }, { sessions: savedSessions }])('shows refresh failure and explicit retry rather than inventing an empty state', async ({ sessions }) => {
    const wrapper = mount(MobileSessionsDialog, { props: {
      modelValue: true, sessions, activeSessionId: 'ses_sql', error: 'RAW_SERVER_DETAIL',
    }, global });
    expect(wrapper.get('[role="alert"]').text()).toContain('已保留上次结果');
    expect(wrapper.text()).not.toContain('还没有会话'); expect(wrapper.text()).not.toContain('RAW_SERVER_DETAIL');
    expect(wrapper.findAll('.mobile-session-list li')).toHaveLength(sessions.length);
    await button(wrapper, '重试读取会话').trigger('click');
    expect(wrapper.emitted('refresh')).toEqual([[]]);
  });
});

describe('mobile read-only history panel', () => {
  it('reads the explicitly inspected session, renders saved versions and withholds bodies before DOM rendering', async () => {
    const page = savedPage('ses_inspected', '**保存的回复**');
    page.items[0]!.status = 'Interrupted'; page.items[0]!.isComplete = false;
    page.items[0]!.messages.unshift({ ...page.items[0]!.messages[0]!, role: 'user', contentKind: 'accepted_input', versionId: 'input', content: '已接受输入' });
    page.items[0]!.messages.push({ ...page.items[0]!.messages[1]!, versionId: 'legacy', legacy: true, readOnly: true, content: '旧只读记录' });
    // The client double deliberately supplies a malformed withheld body. The
    // panel must keep it out of the DOM even beyond the endpoint's validation.
    page.items[0]!.messages.push({ ...page.items[0]!.messages[1]!, versionId: 'withheld', visibility: 'withheld', content: '<img src="SECRET_WITHHELD_BODY" onerror="SECRET_SCRIPT">' });
    history.getPage.mockResolvedValue(page);
    const wrapper = mount(MobileHistoryDialog, { props: { modelValue: false, sessionId: 'ses_inspected', title: '正在回看的会话' }, global });
    expect(history.getPage).not.toHaveBeenCalled();
    await wrapper.setProps({ modelValue: true }); await flushPromises();
    expect(history.getPage).toHaveBeenCalledWith('ses_inspected', expect.objectContaining({ limit: 20, cursor: undefined, signal: expect.any(AbortSignal) }));
    expect(wrapper.text()).toContain('正在回看的会话'); expect(wrapper.text()).toContain('已中断 · 未完成');
    expect(wrapper.text()).toContain('本轮输入'); expect(wrapper.text()).toContain('版本 4'); expect(wrapper.text()).toContain('只读记录');
    expect(wrapper.find('.markdown-body strong').text()).toBe('保存的回复');
    expect(wrapper.text()).toContain('这条记录当前不可显示'); expect(wrapper.html()).not.toContain('SECRET_');
    expect(getSessionId()).toBe('ses_live'); expect(request).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled(); expect(observeTurn).not.toHaveBeenCalled();
    await button(wrapper, '关闭面板').trigger('click'); expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
  });
  it('replaces explicit pages and wires page size and refresh to the inspected identity', async () => {
    history.getPage.mockResolvedValueOnce(savedPage('ses_inspected', '最新这一页', 'older_cursor'))
      .mockResolvedValueOnce(savedPage('ses_inspected', '更早这一页'))
      .mockResolvedValueOnce(savedPage('ses_inspected', '新页数最新记录'))
      .mockResolvedValueOnce(savedPage('ses_inspected', '手动刷新记录'));
    const wrapper = mount(MobileHistoryDialog, { props: { modelValue: true, sessionId: 'ses_inspected', title: '历史' }, global });
    await flushPromises(); await button(wrapper, '更早一页').trigger('click'); await flushPromises();
    expect(history.getPage).toHaveBeenNthCalledWith(2, 'ses_inspected', expect.objectContaining({ limit: 20, cursor: 'older_cursor' }));
    expect(wrapper.text()).toContain('更早这一页'); expect(wrapper.text()).not.toContain('最新这一页');
    expect(button(wrapper, '回到最新记录').exists()).toBe(true);
    await wrapper.get('select[aria-label="历史每页轮数"]').setValue('1'); await flushPromises();
    expect(history.getPage).toHaveBeenNthCalledWith(3, 'ses_inspected', expect.objectContaining({ limit: 1, cursor: undefined }));
    await button(wrapper, '刷新记录').trigger('click'); await flushPromises();
    expect(history.getPage).toHaveBeenNthCalledWith(4, 'ses_inspected', expect.objectContaining({ limit: 1, cursor: undefined }));
    expect(wrapper.text()).toContain('手动刷新记录'); expect(wrapper.text()).not.toContain('更早这一页');
    expect(getSessionId()).toBe('ses_live'); expect(streamTurn).not.toHaveBeenCalled(); expect(observeTurn).not.toHaveBeenCalled();
  });
  it('updates the inspected prop and isolates late responses across identity changes, closing and reopening', async () => {
    const old = deferred<SessionHistoryPage>(), closing = deferred<SessionHistoryPage>();
    history.getPage.mockReturnValueOnce(old.promise).mockResolvedValueOnce(savedPage('ses_other', '新会话记录'))
      .mockReturnValueOnce(closing.promise).mockResolvedValueOnce(savedPage('ses_other', '重新打开记录'));
    const wrapper = mount(MobileHistoryDialog, { props: { modelValue: true, sessionId: 'ses_inspected', title: '旧会话' }, global });
    const oldSignal = history.getPage.mock.calls[0]![1].signal as AbortSignal;
    await wrapper.setProps({ sessionId: 'ses_other', title: '新会话' }); await flushPromises();
    expect(oldSignal.aborted).toBe(true); expect(wrapper.text()).toContain('新会话记录');
    old.resolve(savedPage('ses_inspected', 'SECRET_OLD_SESSION')); await flushPromises();
    expect(wrapper.html()).not.toContain('SECRET_OLD_SESSION');
    await button(wrapper, '刷新记录').trigger('click');
    const closingSignal = history.getPage.mock.calls[2]![1].signal as AbortSignal;
    await wrapper.setProps({ modelValue: false }); expect(closingSignal.aborted).toBe(true);
    await wrapper.setProps({ modelValue: true }); await flushPromises();
    expect(wrapper.text()).toContain('重新打开记录');
    closing.resolve(savedPage('ses_other', 'SECRET_CLOSED_RESPONSE')); await flushPromises();
    expect(wrapper.html()).not.toContain('SECRET_CLOSED_RESPONSE'); expect(wrapper.text()).toContain('重新打开记录');
    expect(history.getPage).toHaveBeenCalledTimes(4); expect(getSessionId()).toBe('ses_live');
  });
  it('renders a fixed history failure and waits for an explicit retry instead of showing an empty history', async () => {
    history.getPage.mockRejectedValueOnce(new AervoxHttpError(404, '/SECRET_PATH', { detail: 'SECRET_DETAIL' }))
      .mockResolvedValueOnce(savedPage('ses_inspected', '重试后记录'));
    const wrapper = mount(MobileHistoryDialog, { props: { modelValue: true, sessionId: 'ses_inspected', title: '历史' }, global });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('可能已删除');
    expect(wrapper.text()).not.toContain('暂无可显示'); expect(wrapper.html()).not.toContain('SECRET_');
    expect(history.getPage).toHaveBeenCalledTimes(1);
    await button(wrapper, '刷新记录').trigger('click'); await flushPromises();
    expect(history.getPage).toHaveBeenCalledTimes(2); expect(wrapper.text()).toContain('重试后记录');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false); expect(streamTurn).not.toHaveBeenCalled();
  });
});
