import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { effectScope, ref, type EffectScope } from 'vue';
import { AervoxHttpError, configureAervoxClient, type AervoxTransport } from '@aervox/api-client';
import type { SessionHistoryPage } from '@aervox/contracts';
import { useSessionHistory } from '../src/composables/useSessionHistory';
import { WORKBENCH_CONTEXT_KEY } from '../src/composables/workbench-context';
import HistoryDrawer from '../src/components/workbench/drawers/HistoryDrawer.vue';

enableAutoUnmount(afterEach);
const scopes: EffectScope[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.restoreAllMocks(); });
function page(sessionId = 'session', content = '已保存回复', nextCursor: string | null = null): SessionHistoryPage {
  return { sessionId, nextCursor, items: [{ turnId: `turn_${content}`, status: 'Completed', isComplete: true, createdAt: 'now', messages: [{
    messageId: 'message', versionId: 'version', version: 1, role: 'assistant', contentKind: 'message',
    content, visibility: 'available', legacy: false, readOnly: false, createdAt: 'now',
  }] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(getPage = vi.fn(async () => page()), initiallyOpen = true) {
  const open = ref(initiallyOpen);
  const sessionId = ref('session');
  const scope = effectScope(); scopes.push(scope);
  const history = scope.run(() => useSessionHistory(open, sessionId, { getPage }))!;
  return { open, sessionId, history, getPage, scope };
}

describe('single-page session history', () => {
  it('reads only on open and releases the page and signal on close or scope disposal', async () => {
    const f = fixture(undefined, false);
    expect(f.getPage).not.toHaveBeenCalled();
    f.open.value = true; await flushPromises();
    expect(f.history.page.value?.items[0]?.messages[0]?.content).toBe('已保存回复');
    f.open.value = false;
    expect(f.history.page.value).toBeNull();
    const pending = deferred<SessionHistoryPage>();
    f.getPage.mockReturnValueOnce(pending.promise);
    f.open.value = true;
    const signal = f.getPage.mock.calls.at(-1)![1]!.signal!;
    f.scope.stop();
    expect(signal.aborted).toBe(true);
    pending.resolve(page('session', '关闭后正文')); await flushPromises();
    expect(f.history.page.value).toBeNull();
  });

  it('clears the old session synchronously and ignores its late result even when abort is ignored', async () => {
    const old = deferred<SessionHistoryPage>();
    const getPage = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('other', '新会话'));
    const f = fixture(getPage);
    const oldSignal = getPage.mock.calls[0]![1].signal;
    f.sessionId.value = 'other';
    expect(oldSignal.aborted).toBe(true);
    expect(f.history.page.value).toBeNull();
    await flushPromises();
    old.resolve(page('session', '旧会话敏感正文')); await flushPromises();
    expect(f.history.page.value?.sessionId).toBe('other');
    expect(JSON.stringify(f.history.page.value)).not.toContain('旧会话');
  });

  it('invalidates pending reads on page-size changes and on closing before their responses arrive', async () => {
    const initial = deferred<SessionHistoryPage>();
    const resized = deferred<SessionHistoryPage>();
    const getPage = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(resized.promise)
      .mockResolvedValueOnce(page('session', '重新打开的记录'));
    const f = fixture(getPage);
    const initialSignal = getPage.mock.calls[0]![1].signal;
    f.history.limit.value = 1;
    expect(initialSignal.aborted).toBe(true);
    const resizedSignal = getPage.mock.calls[1]![1].signal;
    initial.resolve(page('session', '旧页数记录')); await flushPromises();
    expect(f.history.loading.value).toBe(true);
    expect(f.history.page.value).toBeNull();
    f.open.value = false;
    expect(resizedSignal.aborted).toBe(true);
    resized.resolve(page('session', '关窗后的记录')); await flushPromises();
    expect(f.history.page.value).toBeNull();
    f.open.value = true; await flushPromises();
    expect(f.history.page.value?.items[0]?.messages[0]?.content).toBe('重新打开的记录');
  });

  it('replaces one page, can cross an empty filtered page, and explicitly refreshes to latest', async () => {
    const getPage = vi.fn().mockResolvedValueOnce({ ...page(), items: [], nextCursor: 'older_cursor' })
      .mockResolvedValueOnce(page('session', '更早正文', 'oldest_cursor')).mockResolvedValueOnce(page('session', '最新正文'));
    const f = fixture(getPage); await flushPromises();
    expect(getPage).toHaveBeenCalledTimes(1);
    await f.history.earlier();
    expect(getPage).toHaveBeenNthCalledWith(2, 'session', expect.objectContaining({ limit: 20, cursor: 'older_cursor' }));
    expect(f.history.page.value?.items).toHaveLength(1);
    expect(f.history.atLatest.value).toBe(false);
    await f.history.refresh();
    expect(getPage).toHaveBeenNthCalledWith(3, 'session', expect.objectContaining({ cursor: undefined }));
    expect(f.history.atLatest.value).toBe(true);
    expect(JSON.stringify(f.history.page.value)).not.toContain('更早正文');
    expect(getPage).toHaveBeenCalledTimes(3);
  });

  it.each([410, 422, 404, 500])('uses fixed text for HTTP %s, clears old bodies, and waits for explicit action', async status => {
    const getPage = vi.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(new AervoxHttpError(status, '/SECRET_PATH', { detail: 'SECRET_ERROR' }));
    const f = fixture(getPage); await flushPromises();
    await f.history.refresh();
    expect(f.history.page.value).toBeNull();
    expect(f.history.error.value).not.toContain('SECRET');
    expect(f.history.error.value).toContain(status === 410 ? '回到最新' : status === 422 ? '减少每页条数' : status === 404 ? '可能已删除' : '稍后刷新');
    expect(getPage).toHaveBeenCalledTimes(2);
    if (status === 422) { f.history.limit.value = 1; expect(getPage).toHaveBeenLastCalledWith('session', expect.objectContaining({ limit: 1 })); }
  });

  it('rejects a different session projection and a cursor that cannot advance', async () => {
    const f = fixture(vi.fn().mockResolvedValueOnce(page('wrong')).mockResolvedValueOnce(page('session', '正文', 'cursor'))
      .mockResolvedValueOnce(page('session', '重复', 'cursor')));
    await flushPromises(); expect(f.history.page.value).toBeNull(); expect(f.history.error.value).toContain('无法读取');
    await f.history.refresh(); await f.history.earlier();
    expect(f.history.page.value).toBeNull(); expect(f.history.error.value).toContain('无法读取');
  });
});

function drawer(response: SessionHistoryPage | (() => Promise<SessionHistoryPage>) = page()) {
  const request = vi.fn(async () => typeof response === 'function' ? response() : response);
  const streamTurn = vi.fn();
  configureAervoxClient({ transport: { request, streamTurn, submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn() } as unknown as AervoxTransport });
  const open = ref(true); const sessionId = ref('session');
  const story = ref([{ id: 1, speaker: 'assistant', text: '实时正文不应混入历史' }]);
  const wrapper = mount(HistoryDrawer, { global: { provide: { [WORKBENCH_CONTEXT_KEY as symbol]: {
    layout: { companionDisplayName: ref('小隅'), historyOpen: open },
    sessions: { activeSessionId: sessionId }, conversation: { story },
  } }, stubs: { Teleport: true } } });
  return { wrapper, request, streamTurn, open, sessionId, story };
}

describe('saved conversation drawer', () => {
  it('shows current saved versions, honest incomplete/input/read-only labels, and no live story or executable actions', async () => {
    const value = page(); value.items[0]!.status = 'Interrupted'; value.items[0]!.isComplete = false;
    value.items[0]!.messages.unshift({ ...value.items[0]!.messages[0]!, role: 'user', contentKind: 'accepted_input', messageId: null,
      versionId: 'input', content: '手动输入与 Inbox', legacy: true, readOnly: true });
    value.items[0]!.messages.push({ ...value.items[0]!.messages[1]!, versionId: 'withheld', content: null, visibility: 'withheld' });
    const f = drawer(value); await flushPromises();
    expect(f.request).toHaveBeenCalledWith('GET', '/v1/sessions/session/history?limit=20', undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.wrapper.text()).toContain('本轮输入'); expect(f.wrapper.text()).toContain('只读记录');
    expect(f.wrapper.text()).toContain('已中断 · 未完成'); expect(f.wrapper.text()).toContain('这条记录当前不可显示');
    expect(f.wrapper.text()).toContain('小隅'); expect(f.wrapper.text()).not.toContain('实时正文');
    expect(f.wrapper.find('.run-details-entry').exists()).toBe(false);
    expect(f.wrapper.find('[data-slot]').exists()).toBe(false);
    expect(f.streamTurn).not.toHaveBeenCalled(); expect(f.story.value).toHaveLength(1);
  });

  it('keeps empty-page navigation visible and changes the page size through a fresh latest-page GET', async () => {
    const f = drawer({ ...page(), items: [], nextCursor: 'older' }); await flushPromises();
    expect(f.wrapper.text()).toContain('这一页暂无');
    await f.wrapper.get('.history-earlier').trigger('click'); await flushPromises();
    expect(f.request).toHaveBeenLastCalledWith('GET', '/v1/sessions/session/history?limit=20&cursor=older', undefined, expect.any(Object));
    expect(f.wrapper.text()).toContain('回到最新记录');
    await f.wrapper.get('select').setValue('1'); await flushPromises();
    expect(f.request).toHaveBeenLastCalledWith('GET', '/v1/sessions/session/history?limit=1', undefined, expect.any(Object));
    expect(f.streamTurn).not.toHaveBeenCalled();
  });

  it('never renders a malformed withheld body and clears loaded content as soon as the drawer closes', async () => {
    const value = page(); value.items[0]!.messages[0]!.visibility = 'withheld';
    const f = drawer(value); await flushPromises();
    expect(f.wrapper.text()).not.toContain('已保存回复'); expect(f.wrapper.get('[role="alert"]').text()).toContain('无法读取');
    f.open.value = false; await flushPromises();
    expect(f.wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(f.streamTurn).not.toHaveBeenCalled();
  });
});
