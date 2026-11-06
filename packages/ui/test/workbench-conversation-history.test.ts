import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { effectScope, ref, type EffectScope } from 'vue';
import { AervoxHttpError, type ConversationController, type ConversationState, type createSessionHistoryClient } from '@aervox/api-client';
import type { SessionHistoryPage } from '@aervox/contracts';
import { useWorkbenchConversation } from '../src/composables/useWorkbenchConversation';

const scopes: EffectScope[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.restoreAllMocks(); });

function page(sessionId = 'session', content = '保存的回答'): SessionHistoryPage {
  return { sessionId, nextCursor: null, items: [{ turnId: 'turn', status: 'Completed', isComplete: true, createdAt: 'now', messages: [
    { messageId: 'input', versionId: 'input-v1', version: 1, role: 'user', contentKind: 'accepted_input', content: '之前的问题', visibility: 'available', legacy: false, readOnly: false, createdAt: 'now' },
    { messageId: 'reply', versionId: 'reply-v2', version: 2, role: 'assistant', contentKind: 'message', content, visibility: 'available', legacy: false, readOnly: false, createdAt: 'now' },
  ] }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type GetPage = ReturnType<typeof createSessionHistoryClient>['getPage'];
function fixture(input: { getPage?: GetPage; state?: ConversationState; ready?: boolean; signal?: AbortSignal } = {}) {
  let state: Readonly<ConversationState> = input.state ?? { status: 'idle' };
  const listeners = new Set<(value: Readonly<ConversationState>) => void>();
  const controller: ConversationController = {
    get state() { return state; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    submit: vi.fn(), observe: vi.fn(), retry: vi.fn(), stop: vi.fn(), answer: vi.fn(), decide: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
  };
  const sessionId = ref('session');
  const ready = ref(input.ready ?? true);
  const busy = ref(false);
  const getPage = input.getPage ?? vi.fn<GetPage>(async () => page());
  const scope = effectScope(); scopes.push(scope);
  const conversation = scope.run(() => useWorkbenchConversation({ recordActivity: vi.fn(), controller, onApprovalDecision: vi.fn(),
    history: { sessionId, ready, busy, client: { getPage }, signal: input.signal },
  }))!;
  function setState(value: ConversationState) { state = value; listeners.forEach(listener => listener(state)); }
  return { conversation, controller, sessionId, ready, busy, getPage, scope, setState };
}

describe('workbench persisted conversation projection', () => {
  it('waits for session selection readiness, then restores one ordered latest page without running a Turn', async () => {
    const value = page();
    value.items.push({ ...page('session', '新的回答').items[0]!, turnId: 'newer' });
    value.nextCursor = 'older_cursor';
    const getPage = vi.fn<GetPage>(async () => value);
    const f = fixture({ getPage, ready: false });
    expect(getPage).not.toHaveBeenCalled();
    expect(f.conversation.story.value).toEqual([]);
    f.ready.value = true;
    expect(f.conversation.historyLoading.value).toBe(true);
    await flushPromises();
    expect(getPage).toHaveBeenCalledExactlyOnceWith('session', { limit: 20, signal: expect.any(AbortSignal) });
    expect(f.conversation.story.value.map(line => line.text)).toEqual(['之前的问题', '保存的回答', '之前的问题', '新的回答']);
    expect(f.conversation.story.value.every(line => line.state === 'saved' && line.readOnly)).toBe(true);
    expect(f.conversation.story.value[0]!.savedLabel).toContain('本轮输入');
    expect(f.conversation.story.value[1]!.savedLabel).toContain('版本 2');
    expect(f.conversation.historyHasEarlier.value).toBe(true);
    expect(f.conversation.historyEnabled).toBe(true);
    expect(f.conversation.historyNotice.value).toContain('最近一页');
    expect(f.controller.submit).not.toHaveBeenCalled();
    expect(f.controller.observe).not.toHaveBeenCalled();
    expect(f.controller.reset).not.toHaveBeenCalled();
  });

  it('clears a previous session immediately and refuses its late response when cancellation is ignored', async () => {
    const pending = deferred<SessionHistoryPage>();
    const getPage = vi.fn<GetPage>().mockResolvedValueOnce(page()).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('other', '另一段会话'));
    const f = fixture({ getPage }); await flushPromises();
    const reload = f.conversation.refreshHistory();
    const oldSignal = getPage.mock.calls[1]![1]!.signal!;
    f.sessionId.value = 'other';
    expect(f.conversation.story.value).toEqual([]);
    expect(oldSignal.aborted).toBe(true);
    await flushPromises();
    pending.resolve(page('session', '旧会话的迟到正文')); await reload;
    expect(f.conversation.story.value.at(-1)?.text).toBe('另一段会话');
    expect(JSON.stringify(f.conversation.story.value)).not.toContain('迟到');
    expect(f.controller.reset).not.toHaveBeenCalled();
  });

  it('invalidates a pending read before asynchronous preparation or live streaming can append messages', async () => {
    const pending = deferred<SessionHistoryPage>();
    const getPage = vi.fn<GetPage>().mockReturnValue(pending.promise);
    const f = fixture({ getPage });
    const signal = getPage.mock.calls[0]![1]!.signal!;
    f.busy.value = true;
    expect(signal.aborted).toBe(true);
    expect(f.conversation.historyLoading.value).toBe(false);
    f.conversation.streaming.value = true;
    f.conversation.story.value.push(f.conversation.createStoryLine('assistant', '实时的前半段', 'streaming'));
    pending.resolve(page('session', '迟到持久正文')); await flushPromises();
    expect(f.conversation.story.value.at(-1)?.text).toBe('实时的前半段');
    f.conversation.streaming.value = false; f.busy.value = false;
    await flushPromises();
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(f.conversation.story.value.at(-1)?.text).toBe('实时的前半段');
  });

  it.each<ConversationState>([
    { status: 'submitting' }, { status: 'observing', turnId: 'live' },
    { status: 'awaiting-input', turnId: 'live' }, { status: 'awaiting-approval', turnId: 'live' },
    { status: 'observer-error', turnId: 'live' }, { status: 'failed', retryAvailable: true },
  ])('preserves execution ownership and visible content while Controller is $status', async state => {
    const f = fixture({ state });
    f.conversation.story.value = [f.conversation.createStoryLine('assistant', '当前业务意图')];
    await f.conversation.refreshHistory();
    f.sessionId.value = 'different'; await flushPromises();
    expect(f.conversation.historyBlocked.value).toBe(true);
    expect(f.getPage).not.toHaveBeenCalled();
    expect(f.conversation.story.value.at(-1)?.text).toBe('当前业务意图');
    expect(f.controller.reset).not.toHaveBeenCalled();
    expect(f.controller.retry).not.toHaveBeenCalled();
    expect(f.controller.submit).not.toHaveBeenCalled();
    expect(f.controller.observe).not.toHaveBeenCalled();
  });

  it('rejects a late projection when ownership changes even if no local streaming flag changes', async () => {
    const pending = deferred<SessionHistoryPage>();
    const getPage = vi.fn<GetPage>().mockReturnValue(pending.promise);
    const f = fixture({ getPage });
    f.setState({ status: 'failed', retryAvailable: true });
    expect(getPage.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    f.conversation.story.value.push(f.conversation.createStoryLine('user', '尚未确认受理的请求'));
    pending.resolve(page()); await flushPromises();
    expect(f.conversation.story.value.at(-1)?.text).toContain('尚未确认受理');
  });

  it('clears obsolete read feedback on a new live intent, keeps saved bodies, and waits for an explicit read afterward', async () => {
    const f = fixture(); await flushPromises();
    const previous = f.conversation.story.value;
    expect(f.conversation.historyNotice.value).not.toBe('');
    f.busy.value = true;
    expect(f.conversation.story.value).toBe(previous);
    expect(f.conversation.historyNotice.value).toBe('');
    f.busy.value = false; await flushPromises();
    expect(f.getPage).toHaveBeenCalledTimes(1);
    await f.conversation.refreshHistory();
    expect(f.getPage).toHaveBeenCalledTimes(2);
    expect(f.conversation.historyNotice.value).not.toBe('');
  });

  it('displays incomplete and withheld records as saved information, including system roles', async () => {
    const value = page(); value.items[0]!.status = 'Interrupted'; value.items[0]!.isComplete = false;
    value.items[0]!.messages[1]!.visibility = 'withheld'; value.items[0]!.messages[1]!.content = null;
    value.items[0]!.messages.push({ ...value.items[0]!.messages[0]!, role: 'system', contentKind: 'message', content: '系统记录', versionId: 'system' });
    const f = fixture({ getPage: vi.fn(async () => value) }); await flushPromises();
    expect(f.conversation.story.value[1]).toMatchObject({ text: '这条记录当前不可显示。', state: 'saved', readOnly: true });
    expect(f.conversation.story.value[1]!.savedLabel).toContain('已中断 · 未完成');
    expect(f.conversation.story.value[2]!.speaker).toBe('system');
    expect(f.conversation.story.value[2]!.savedLabel).toContain('系统记录');
    expect(f.conversation.historyNotice.value).toContain('不会继续执行');
    expect(f.conversation.currentTurnId.value).toBeNull();
    expect(f.conversation.activeQuestion.value).toBeNull();
    expect(f.conversation.pendingApproval.value).toBeNull();
  });

  it.each([
    { status: 'Completed', isComplete: false, label: '完成结果未确认' },
    { status: 'Running', isComplete: true, label: '执行中' },
    { status: 'SECRET_UNKNOWN_STATUS', isComplete: true, label: '状态待确认' },
  ])('does not present inconsistent $status as a completed live response', async state => {
    const value = page(); Object.assign(value.items[0]!, state);
    const f = fixture({ getPage: vi.fn(async () => value) }); await flushPromises();
    expect(f.conversation.story.value.at(-1)).toMatchObject({ state: 'saved', readOnly: true });
    expect(f.conversation.story.value.at(-1)!.savedLabel).toContain(state.label);
    expect(f.conversation.story.value.at(-1)!.savedLabel).toContain('未完成');
    expect(f.conversation.story.value.at(-1)!.savedLabel).not.toContain('SECRET');
    expect(f.conversation.historyNotice.value).toContain('未完成');
  });

  it.each([404, 422, 500])('clears stale bodies and exposes fixed retry text for HTTP %s', async status => {
    const getPage = vi.fn<GetPage>().mockResolvedValueOnce(page()).mockRejectedValueOnce(new AervoxHttpError(status, '/SECRET_PATH', { detail: 'SECRET_DETAIL' })).mockResolvedValueOnce(page('session', '重新读回'));
    const f = fixture({ getPage }); await flushPromises();
    await f.conversation.refreshHistory();
    expect(f.conversation.story.value).toEqual([]);
    expect(f.conversation.historyError.value).toContain(status === 404 ? '可能已删除' : status === 422 ? '减少每页轮数' : '请重试');
    expect(f.conversation.historyError.value).not.toContain('SECRET');
    expect(getPage).toHaveBeenCalledTimes(2);
    await f.conversation.refreshHistory();
    expect(f.conversation.historyError.value).toBe('');
    expect(f.conversation.story.value.at(-1)?.text).toBe('重新读回');
  });

  it('does not invent a successful answer for an empty or hidden page', async () => {
    const getPage = vi.fn<GetPage>().mockResolvedValueOnce({ sessionId: 'session', items: [], nextCursor: 'older' }).mockResolvedValueOnce({ sessionId: 'session', items: [], nextCursor: null });
    const f = fixture({ getPage }); await flushPromises();
    expect(f.conversation.story.value).toEqual([]);
    expect(f.conversation.historyNotice.value).toContain('当前页暂无');
    expect(getPage).toHaveBeenCalledTimes(1);
    await f.conversation.refreshHistory();
    expect(f.conversation.historyNotice.value).toContain('当前暂无');
    expect(f.controller.submit).not.toHaveBeenCalled();
  });

  it.each(['wrong-session', 'too-many-turns', 'oversized-body', 'withheld-body'])('rejects %s without exposing supplied bodies', async kind => {
    const value = page('session', '敏感正文');
    if (kind === 'wrong-session') value.sessionId = 'different';
    if (kind === 'too-many-turns') value.items = Array.from({ length: 21 }, () => value.items[0]!);
    if (kind === 'oversized-body') value.items[0]!.messages[1]!.content = '敏感正文'.repeat(100_000);
    if (kind === 'withheld-body') value.items[0]!.messages[1]!.visibility = 'withheld';
    const f = fixture({ getPage: vi.fn(async () => value) }); await flushPromises();
    expect(f.conversation.story.value).toEqual([]);
    expect(f.conversation.historyError.value).toContain('无法读取');
    expect(f.conversation.historyError.value).not.toContain('敏感正文');
  });

  it.each(['scope', 'lifetime'])('invalidates a read when its %s ends', async cause => {
    const pending = deferred<SessionHistoryPage>();
    const lifetime = new AbortController();
    const getPage = vi.fn<GetPage>().mockReturnValue(pending.promise);
    const f = fixture({ getPage, signal: lifetime.signal });
    const signal = getPage.mock.calls[0]![1]!.signal!;
    if (cause === 'scope') f.scope.stop(); else lifetime.abort();
    expect(signal.aborted).toBe(true);
    expect(f.conversation.historyLoading.value).toBe(false);
    pending.resolve(page('session', '已关闭会话的正文')); await flushPromises();
    expect(f.conversation.story.value).toEqual([]);
  });
});
