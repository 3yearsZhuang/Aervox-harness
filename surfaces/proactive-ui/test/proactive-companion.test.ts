import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { AervoxHttpError, configureAervoxClient, setSessionId, type StreamTurnOptions, type TurnCallbacks } from '@aervox/api-client';
import definition from '../src';
import { material3ContextKey } from '@aervox/ui/material3';
import { defineComponent } from 'vue';
import MobileSettingsDialog from '../src/MobileSettingsDialog.vue';
import MobileSessionsDialog from '../src/MobileSessionsDialog.vue';
import MobileHistoryDialog from '../src/MobileHistoryDialog.vue';

enableAutoUnmount(afterEach);

// Compile the actual lazy Vue module before measuring host readiness.
beforeAll(async () => { await definition.load(); });

const recentSession = {
  id: 'ses_recent',
  title: '死锁复习',
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
};

const streamTurn = vi.fn();
const observeTurn = vi.fn();
const requestImplementation = async (method: string, path: string) => {
  if (path === '/v1/sessions' && method === 'GET') return { items: [recentSession] };
  if (path === '/v1/sessions' && method === 'POST') return { id: 'ses_new', title: '新对话', createdAt: '', updatedAt: '' };
  return { items: [] };
};
const request = vi.fn(requestImplementation);

beforeEach(() => {
  localStorage.clear();
  streamTurn.mockReset();
  observeTurn.mockReset();
  streamTurn.mockImplementation(async (_sessionId: string, _content: string, callbacks: { onDelta: (t: string) => void; onDone: () => void }) => {
    callbacks.onDelta('我们接着昨天的进度。');
    callbacks.onDone();
  });
  request.mockReset();
  request.mockImplementation(requestImplementation);
  configureAervoxClient({
    sessionId: 'test_initial',
    transport: {
      request: request as never,
      streamTurn: streamTurn as never,
      observeTurn: observeTurn as never,
      submitQuestionAnswers: vi.fn(),
      decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

async function mountSurface(platform: 'web' | 'desktop' | 'mobile' = 'web', material3 = false, sessionId = material3 ? recentSession.id : undefined, back?: unknown) {
  if (sessionId) setSessionId(sessionId);
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'main', platform, viewProps: {surfaceNavigation: {currentId: definition.id, options: [], select: vi.fn(), openDefault: vi.fn()}} },
    global: { provide: { [material3ContextKey as symbol]: material3, ...(back ? { [Symbol.for('aervox.material3.mobileBack')]: back } : {}) } },
  });
  await vi.waitFor(() => expect(wrapper.find('.proactive-companion').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  return wrapper;
}

it('restores the saved dark theme without mounting the desktop workbench', async () => {
  localStorage.setItem('aervox-theme', 'dark');
  const wrapper = await mountSurface();
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(wrapper.find('.aervox-workbench').exists()).toBe(false);
});

it('preserves the desktop host theme when the mobile surface is explicitly selected', async () => {
  document.documentElement.dataset.theme = 'dark';
  localStorage.setItem('aervox-theme', 'light');
  await mountSurface('desktop');
  expect(document.documentElement.dataset.theme).toBe('dark');
});

it('retries an uncertain desktop submission with the same business idempotency key', async () => {
  streamTurn.mockRejectedValueOnce(new Error('acceptance response lost'));
  const wrapper = await mountSurface('desktop');
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-retry').exists()).toBe(true);
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('loads through the host and renders the minimal first-level page', async () => {
  const wrapper = await mountSurface();
  expect(wrapper.find('.pc-dialogue-box').exists()).toBe(true);
  expect(wrapper.findAll('.pc-choice')).toHaveLength(2);
  expect(wrapper.find('.pc-whisper-pill').exists()).toBe(true);
  // 输入框默认不可见——淡化输入存在感
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(false);
  expect(wrapper.find('.pc-brand .aervox-brand-mark').exists()).toBe(true);
  expect(wrapper.findAll('.pc-quiet-btn svg')).toHaveLength(2);
  expect(wrapper.find('.pc-whisper-pill svg').exists()).toBe(true);
});

it('resume card reflects the most recent session and switches to it', async () => {
  const wrapper = await mountSurface();
  const resume = wrapper.findAll('.pc-choice')[0]!;
  expect(resume.text()).toContain('死锁复习');
  expect(resume.text()).toContain('昨天');
  await resume.trigger('click');
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_recent');
  await vi.waitFor(() => expect(wrapper.find('.pc-dialogue-text').text()).toContain('接着上次的地方继续'), { timeout: 2000 });
});

it('focus card sends a real turn and streams the reply into the dialogue box', async () => {
  const wrapper = await mountSurface();
  const focus = wrapper.findAll('.pc-choice').find((c) => c.text().includes('专注'))!;
  await focus.trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toContain('专注');
  expect(wrapper.find('.pc-dialogue-text').text()).toContain('我们接着昨天的进度');
});

it('whisper input replaces the choices while open and sends on Enter', async () => {
  const wrapper = await mountSurface();
  await wrapper.find('.pc-whisper-pill').trigger('click');
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(true);
  await wrapper.find('.pc-whisper-input input').setValue('讲讲环路等待');
  await wrapper.find('.pc-whisper-input input').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(String(streamTurn.mock.calls[0]![1])).toBe('讲讲环路等待');
  // 发送后回到卡片主导
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(false);
});


it('reuses the idempotency key on an explicit retry when turn acceptance is unknown', async () => {
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  const focus = wrapper.findAll('.pc-choice').find(c => c.text().includes('专注'))!;
  await focus.trigger('click');
  await flushPromises();
  expect(focus.attributes('disabled')).toBeUndefined();
  expect(wrapper.find('.pc-feedback').text()).toContain('未能收到回复');
  expect(wrapper.find('.pc-dialogue-text').text()).not.toContain('connection lost');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  const firstOptions = streamTurn.mock.calls[0]![3] as StreamTurnOptions;
  const retryOptions = streamTurn.mock.calls[1]![3] as StreamTurnOptions;
  expect(firstOptions.idempotencyKey).toEqual(expect.any(String));
  expect(retryOptions.idempotencyKey).toBe(firstOptions.idempotencyKey);
  expect(streamTurn.mock.calls[1]!.slice(0, 2)).toEqual(streamTurn.mock.calls[0]!.slice(0, 2));
  expect(wrapper.find('.pc-dialogue-text').text()).toContain('我们接着昨天的进度');
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
});

it('creates a real session before the first turn when the session list is empty', async () => {
  request.mockImplementation(async (method, path) => path === '/v1/sessions' && method === 'GET'
    ? { items: [] } : requestImplementation(method, path));
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[0]!.trigger('click');
  await flushPromises();
  expect(request.mock.calls.some(([method, path]) => method === 'POST' && path === '/v1/sessions')).toBe(true);
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_new');
});

it('sends configured companion identity with the active session', async () => {
  localStorage.setItem('aervox-settings', JSON.stringify({ companionName: '团子', userAddress: '掌柜' }));
  const wrapper = await mountSurface();
  expect(wrapper.find('.pc-dialogue-name').text()).toBe('团子');
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_recent');
  expect(streamTurn.mock.calls[0]![3]).toMatchObject({
    metadata: { companionName: '团子', userAddress: '掌柜' },
  });
});

function pendingStream() {
  let callbacks!: TurnCallbacks;
  let options!: StreamTurnOptions;
  let complete!: () => void;
  streamTurn.mockImplementation((_id: string, _text: string, nextCallbacks: TurnCallbacks, nextOptions: StreamTurnOptions) => {
    callbacks = nextCallbacks;
    options = nextOptions;
    return new Promise<void>(resolve => {
      complete = () => { callbacks.onDone(); resolve(); };
      options.signal!.addEventListener('abort', () => resolve(), { once: true });
    });
  });
  return { get callbacks() { return callbacks; }, get options() { return options; }, complete: () => complete() };
}

it('shows waiting feedback before the first delta and then displays the streamed reply', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-waiting').text()).toContain('正在等待回复');
  expect(wrapper.find('.pc-dialogue-waiting').attributes('role')).toBe('status');
  expect(wrapper.find('.pc-dialogue-text').exists()).toBe(false);
  pending.callbacks.onDelta('先从一个小目标开始。');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-waiting').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('先从一个小目标开始。');
  pending.complete();
  await flushPromises();
});

it('preserves the previous dialogue when a request fails before the first delta', async () => {
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  const previousReply = wrapper.find('.pc-dialogue-text').text();
  streamTurn.mockRejectedValueOnce(new Error('provider diagnostic'));
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe(previousReply);
  expect(wrapper.find('.pc-feedback').attributes('data-kind')).toBe('connection-error');
  expect(wrapper.text()).not.toContain('provider diagnostic');
});

it('keeps a partial reply visible and reports a lost connection outside the dialogue', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks) => {
    callbacks.onDelta('我收到你的问题了。');
    throw new Error('connection lost');
  });
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。');
  expect(wrapper.find('.pc-feedback').text()).toContain('已保留收到的回复');
  expect(wrapper.find('.pc-caret').exists()).toBe(false);
});

it('resumes an accepted partial reply in place without sending another turn', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    await options.onAccepted!('turn_accepted');
    callbacks.onDelta('我收到你的问题了。');
    await callbacks.onEvent!({eventId:'seen',turnId:'turn_accepted',sequence:1,eventType:'delta',data:{text:'我收到你的问题了。'}});
    throw new Error('observer connection lost');
  });
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。');
  expect(wrapper.find('.pc-feedback').text()).toContain('连接中断，已保留收到的回复。可恢复接收。');
  expect(wrapper.find('.pc-feedback').attributes('data-kind')).toBe('observer-error');
  expect(wrapper.find('.pc-caret').exists()).toBe(false);
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  observeTurn.mockImplementationOnce(async (_turn, cb) => { cb.onDelta('接着解释。'); cb.onDone(); });
  await wrapper.find('.pc-resume').trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('我收到你的问题了。接着解释。');
  expect(observeTurn).toHaveBeenCalledWith('turn_accepted', expect.any(Object), expect.objectContaining({afterEventId:'seen'}));
  expect(streamTurn).toHaveBeenCalledOnce();

});

it('does not offer resend after a stream identifies a turn and disconnects before any reply', async () => {
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  const previousReply = wrapper.find('.pc-dialogue-text').text();
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks) => {
    callbacks.onTurnIdentified!('turn_identified');
    throw new Error('observer connection lost');
  });
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-dialogue-text').text()).toBe(previousReply);
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  expect(wrapper.find('.pc-resume').text()).toBe('恢复接收回复');
  expect(streamTurn).toHaveBeenCalledTimes(2);
});

it('uses a new key to resend after a terminal turn error', async () => {
  streamTurn.mockImplementationOnce(async (_id: string, _text: string, callbacks: TurnCallbacks, options: StreamTurnOptions) => {
    await options.onAccepted!('turn_failed');
    callbacks.onError!(new Error('terminal turn error'));
  });
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-workbench-link').exists()).toBe(false);
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('uses a new idempotency key for a new action instead of the retry control', async () => {
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('detaches an uncertain reservation on session switch and uses a new key for the next action', async () => {
  const otherSession = { ...recentSession, id: 'ses_other', title: '另一个话题' };
  localStorage.setItem('aervox_active_session_id', otherSession.id);
  request.mockImplementation(async (method, path) => path === '/v1/sessions' && method === 'GET'
    ? { items: [recentSession, otherSession] } : requestImplementation(method, path));
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(streamTurn.mock.calls[0]![0]).toBe('ses_other');
  await wrapper.findAll('.pc-choice')[0]!.trigger('click');
  expect(wrapper.find('.pc-retry').exists()).toBe(false);
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  expect(streamTurn.mock.calls[1]![0]).toBe('ses_recent');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
});

it('keeps IME Enter local, focuses input, and removes suggestions while composing', async () => {
  const wrapper = await mountSurface();
  await wrapper.find('.pc-whisper-pill').trigger('click');
  expect(wrapper.findAll('.pc-choice')).toHaveLength(0);
  const input = wrapper.find('.pc-whisper-input input');
  await input.setValue('学习');
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  expect(streamTurn).not.toHaveBeenCalled();
  await input.trigger('keydown', { key: 'Escape' });
  expect(wrapper.find('.pc-whisper-pill').exists()).toBe(true);
});

it('sends a server cancellation before aborting the current reply', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_1');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith('POST', '/v1/turns/turn_1/cancel', {}, expect.any(Object));
  expect(pending.options.signal!.aborted).toBe(true);
  expect(wrapper.find('.pc-feedback').text()).toBe('已停止回复。');
  expect(wrapper.find('.pc-stop').exists()).toBe(false);
});

it('remembers a stop requested before acceptance and cancels the accepted turn', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await wrapper.find('.pc-stop').trigger('click');
  expect(request.mock.calls.some(([, path]) => path.endsWith('/cancel'))).toBe(false);
  await pending.options.onAccepted!('turn_late');
  await flushPromises();
  expect(request.mock.calls.filter(([, path]) => path === '/v1/turns/turn_late/cancel')).toHaveLength(1);
  expect(pending.options.signal!.aborted).toBe(true);
});

it('keeps the stream active after cancel failure and lets the user retry', async () => {
  const pending = pendingStream();
  let cancelAttempts = 0;
  request.mockImplementation(async (method, path) => {
    if (path.endsWith('/cancel') && ++cancelAttempts === 1) throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_retry');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(pending.options.signal!.aborted).toBe(false);
  expect(wrapper.find('.pc-stop').attributes('disabled')).toBeUndefined();
  expect(wrapper.find('.pc-feedback').text()).toContain('停止失败');
  expect(wrapper.find('.pc-dialogue-ctx').text()).toBe('正在回复');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(cancelAttempts).toBe(2);
  expect(pending.options.signal!.aborted).toBe(true);
});

it('clears cancel failure feedback if the reply finishes before the user retries', async () => {
  const pending = pendingStream();
  request.mockImplementation(async (method, path) => {
    if (path.endsWith('/cancel')) throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_finish');
  await wrapper.find('.pc-stop').trigger('click');
  await flushPromises();
  expect(wrapper.find('.pc-feedback').text()).toContain('停止失败');
  pending.callbacks.onDelta('回复已经完成。');
  pending.complete();
  await flushPromises();
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(wrapper.find('.pc-dialogue-text').text()).toBe('回复已经完成。');
});

it('does not let a late cancel response overwrite the next turn', async () => {
  let finishCancel!: () => void;
  request.mockImplementation((method, path) => path.endsWith('/cancel')
    ? new Promise(resolve => { finishCancel = () => resolve({}); })
    : requestImplementation(method, path));
  const pending = pendingStream();
  const wrapper = await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  const oldOptions = pending.options;
  await oldOptions.onAccepted!('turn_old');
  await wrapper.find('.pc-stop').trigger('click');
  pending.complete();
  await flushPromises();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  const nextSignal = pending.options.signal!;
  finishCancel();
  await flushPromises();
  expect(nextSignal.aborted).toBe(false);
  expect(wrapper.find('.pc-dialogue-ctx').text()).toBe('正在回复');
  pending.complete();
  await flushPromises();
});

it('keeps a failed whisper editable until retry succeeds', async () => {
  streamTurn.mockRejectedValueOnce(new Error('connection lost'));
  const wrapper = await mountSurface();
  await wrapper.find('.pc-whisper-pill').trigger('click');
  const input = wrapper.find('.pc-whisper-input input');
  await input.setValue('讲讲环路等待');
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect((input.element as HTMLInputElement).value).toBe('讲讲环路等待');
  expect(wrapper.find('.pc-feedback').text()).toContain('重试发送');
  await input.setValue('用例子讲讲环路等待');
  await wrapper.find('.pc-retry').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('用例子讲讲环路等待');
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).not.toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  expect(wrapper.find('.pc-whisper-input').exists()).toBe(false);
});

it('keeps a new question visible when an earlier multi-question answer finishes', async () => {
  let forward!: TurnCallbacks;
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',step:1,questions:[
      {id:'q',question:'选主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'detail',question:'补充要求'},
    ]});cb.onDone();
  });
  let saved!:()=>void;
  const submitQuestionAnswers=vi.fn(()=>new Promise<void>(resolve=>{saved=resolve;}));
  configureAervoxClient({transport:{request:request as never,streamTurn,observeTurn,submitQuestionAnswers,decideToolApproval:vi.fn()}});
  const wrapper=await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');await flushPromises();
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',step:2,questions:[{id:'next',question:'新的确认'}]});saved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'q',selected:['A','B'],custom:undefined},{id:'detail',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal));
  expect(wrapper.get('.pc-interaction').text()).toContain('新的确认');
});

it('does not replace a recoverable reply when reselecting the current session', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('原始正文。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'原始正文。'}});
    throw new Error('disconnected');
  });
  observeTurn.mockImplementationOnce(async (_id,cb)=>{cb.onDelta('后续正文。');cb.onDone();});
  const wrapper=await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');await flushPromises();
  await wrapper.findAll('.pc-choice')[0]!.trigger('click');
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('原始正文。');
  await wrapper.get('.pc-resume').trigger('click');await flushPromises();
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('原始正文。后续正文。');
  expect(streamTurn).toHaveBeenCalledOnce();
});
it('detaches recovery when selecting another session', async () => {
  const other={...recentSession,id:'ses_other',title:'另一个话题'};
  localStorage.setItem('aervox_active_session_id',other.id);
  request.mockImplementation(async (method,path)=>path==='/v1/sessions'&&method==='GET'?{items:[recentSession,other]}:requestImplementation(method,path));
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onDelta('旧会话正文。');throw new Error('offline');});
  const wrapper=await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');await flushPromises();
  expect(wrapper.find('.pc-resume').exists()).toBe(true);
  await wrapper.findAll('.pc-choice')[0]!.trigger('click');await flushPromises();
  expect(localStorage.getItem('aervox_active_session_id')).toBe('ses_recent');
  expect(wrapper.find('.pc-resume').exists()).toBe(false);
  expect(wrapper.find('.pc-feedback').exists()).toBe(false);
  expect(observeTurn).not.toHaveBeenCalled();
});
it('preserves partial output when a terminal interruption has no error event', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('已完成的部分。');cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:2,eventType:'done',data:{status:'Interrupted',reason:'max_steps',isComplete:false}});
  });
  const wrapper=await mountSurface();
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');await flushPromises();
  expect(wrapper.get('.pc-dialogue-text').text()).toBe('已完成的部分。');
  expect(wrapper.get('.pc-feedback').attributes('data-kind')).toBe('turn-error');
  expect(wrapper.get('.pc-feedback').text()).toContain('本次回复未完成');
  expect(wrapper.find('.pc-resume').exists()).toBe(false);
});

it('uses the host-provided default-surface command without knowing its ID or URL', async () => {
  const openDefault = vi.fn();
  const wrapper = mount(UISurfaceHost, {
    props: {plugin: definition, surface: 'main', platform: 'web', viewProps: {surfaceNavigation: {
      currentId: 'custom-companion', options: [{value: 'custom-main', label: '主界面'}], select: vi.fn(), openDefault,
    }}},
    global: {stubs: {PetWithFallback: true}},
  });
  await vi.waitFor(() => expect(wrapper.find('.pc-quiet-btn').exists()).toBe(true));
  await wrapper.get('[aria-label="回到完整工作台"]').trigger('click');
  expect(openDefault).toHaveBeenCalledOnce();
  wrapper.unmount();
});


it('opts into official Material controls only when the mobile composition root provides the design system', async () => {
  const mobile = await mountSurface('mobile', true);
  expect(mobile.get('.proactive-companion').attributes('data-design-system')).toBe('material3');
  expect(mobile.findAll('md-icon-button[aria-label="打开设置"]')).toHaveLength(1);
  expect(mobile.findAll('.pc-choice md-ripple')).toHaveLength(2);
  expect(mobile.find('.pc-whisper-input textarea').exists()).toBe(true);
  expect(mobile.find('[aria-label="回到完整工作台"]').exists()).toBe(false);
  const desktop = await mountSurface('desktop');
  expect(desktop.get('.proactive-companion').attributes('data-design-system')).toBeUndefined();
  expect(desktop.findAll('button.pc-quiet-btn')).toHaveLength(2);
  expect(desktop.find('md-ripple').exists()).toBe(false);
});

it('retains native input IME, its persistent label and real submission in the Material surface', async () => {
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.trigger('focus');
  expect(wrapper.get('label.pc-whisper-label').attributes('for')).toBe(input.attributes('id'));
  await input.setValue('学习事务回滚');
  await input.trigger('keydown', { key: 'Enter', isComposing: true });
  expect(streamTurn).not.toHaveBeenCalled();
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(streamTurn.mock.calls[0]![1]).toBe('学习事务回滚');
  expect(wrapper.find('.pc-whisper-input textarea').exists()).toBe(true);
});

it('keeps persistent cancellation before observer abort through a Material stop control', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  await wrapper.findAll('.pc-choice')[1]!.trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_material');
  expect(wrapper.get('md-linear-progress').attributes('indeterminate')).toBeDefined();
  await wrapper.get('md-filled-tonal-button.pc-stop').trigger('click');
  await flushPromises();
  expect(request).toHaveBeenCalledWith('POST', '/v1/turns/turn_material/cancel', {}, expect.any(Object));
  expect(pending.options.signal!.aborted).toBe(true);
  expect(wrapper.get('.pc-feedback').text()).toBe('已停止回复。');
});

it('uses Material tabs to select the existing settings panels through keyboard change events', async () => {
  const panel = (name: string) => defineComponent({ template: `<p>${name}</p>` });
  const wrapper = mount(MobileSettingsDialog, { props: { modelValue: true, panels: [
    { category: 'model', component: panel('模型设置') },
    { category: 'voice', component: panel('语音设置') },
  ] }, global: { provide: { [material3ContextKey as symbol]: true },
    stubs: { AervoxDialog: { template: '<section><slot /></section>' } } } });
  const tabs = wrapper.get('md-tabs');
  expect(wrapper.findAll('md-primary-tab').map(tab => tab.text())).toEqual(['模型服务', '语音']);
  Object.assign(tabs.element, { activeTabIndex: 1 });
  await tabs.trigger('change');
  expect(wrapper.get('[role="tabpanel"]').text()).toBe('语音设置');
  expect(wrapper.get('[role="tabpanel"]').attributes('id')).toBe('mobile-settings-panel-voice');
});


it('selects the first available settings category when the host does not provide a model panel', () => {
  const wrapper = mount(MobileSettingsDialog, { props: { modelValue: true, panels: [
    { category: 'voice', component: defineComponent({ template: '<p>语音设置</p>' }) },
  ] }, global: { provide: { [material3ContextKey as symbol]: true },
    stubs: { AervoxDialog: { template: '<section><slot /></section>' } } } });
  expect(wrapper.get('[role="tabpanel"]').text()).toBe('语音设置');
  expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('mobile-settings-tab-voice');
});


it('keeps mobile Enter as a newline action and saves/restores its session draft', async () => {
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('第一行\n第二行');
  await input.trigger('keydown', { key: 'Enter' });
  expect(streamTurn).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('第一行\n第二行');
  wrapper.unmount();
  const reopened = await mountSurface('mobile', true);
  expect((reopened.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('第一行\n第二行');
});

it('keeps a newer mobile draft after an earlier accepted reply completes', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea');
  await input.setValue('第一条消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click');
  await flushPromises();
  await pending.options.onAccepted!('turn_mobile_draft');
  await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('');
  await input.setValue('接着要发的新草稿');
  pending.callbacks.onDelta('第一条的回复'); pending.complete();
  await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('接着要发的新草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('接着要发的新草稿');
});

it('allows browsing mobile sessions and stored history without cancelling or losing a live owner', async () => {
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true);
  await wrapper.findAll('.pc-choice')[1]!.trigger('click'); await flushPromises();
  await pending.options.onAccepted!('turn_keep_owner');
  await wrapper.get('[aria-label="会话列表"]').trigger('click');
  const list = wrapper.getComponent(MobileSessionsDialog);
  expect(list.props('modelValue')).toBe(true); expect(list.props('switchLocked')).toBe(true);
  list.vm.$emit('select', 'ses_recent'); list.vm.$emit('new');
  list.vm.$emit('history', { ...recentSession, id: 'read_only_other', title: '只读另一段' });
  await flushPromises();
  expect(wrapper.getComponent(MobileHistoryDialog).props('sessionId')).toBe('read_only_other');
  expect(request.mock.calls.some(call => call[0] === 'POST' && (call[1].includes('/cancel') || call[1] === '/v1/sessions'))).toBe(false);
  pending.callbacks.onDelta('仍在原会话接收');
  await flushPromises(); expect(wrapper.get('.pc-dialogue-text').text()).toContain('仍在原会话接收');
});

it('restores drafts when explicitly switching mobile sessions and does not pretend a greeting is stored history', async () => {
  const second = { ...recentSession, id: 'second', title: '另一段对话' };
  request.mockImplementation(async (method, path) => method === 'GET' && path === '/v1/sessions' ? { items: [recentSession, second] } : requestImplementation(method, path));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('留在第一段的草稿');
  localStorage.setItem('aervox-mobile-draft:second', '第二段原来的草稿');
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('select', 'second'); await flushPromises();
  expect(wrapper.get('.pc-current-session').text()).toBe('另一段对话');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('第二段原来的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('留在第一段的草稿');
  expect(streamTurn).not.toHaveBeenCalled();
});

it('does not create a replacement mobile conversation when reading the saved list fails', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === '/v1/sessions') throw new Error('offline');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, 'web_default');
  await wrapper.get('.pc-whisper-input textarea').setValue('不能丢掉的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('modelValue')).toBe(true);
  expect(wrapper.get('.pc-mobile-session-feedback').text()).toContain('先读取会话列表');
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
  expect(streamTurn).not.toHaveBeenCalled();
  expect(localStorage.getItem('aervox-mobile-draft:web_default')).toBe('不能丢掉的草稿');
});

it('allows sending after explicit mobile session creation recovers from a failed list read', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'GET' && path === '/v1/sessions') throw new Error('list unavailable');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true, 'web_default');
  await wrapper.get('.pc-whisper-input textarea').setValue('明确新建后的消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const panel = wrapper.getComponent(MobileSessionsDialog);
  expect(panel.props('error')).toBe('list unavailable');
  expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false);
  expect(streamTurn).not.toHaveBeenCalled();

  panel.vm.$emit('new'); await flushPromises();
  expect(panel.props('error')).toBeNull();
  expect(panel.props('notice')).toBe('');
  expect(panel.props('modelValue')).toBe(false);
  expect(wrapper.get('.pc-current-session').text()).toBe('新对话');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('明确新建后的消息');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(streamTurn.mock.calls[0]!.slice(0, 2)).toEqual(['ses_new', '明确新建后的消息']);
  expect(request.mock.calls.filter(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toHaveLength(1);
});

it('requires the original reservation to be recovered before switching an uncertain mobile submission', async () => {
  streamTurn.mockRejectedValueOnce(new TypeError('connection lost before receipt'));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('结果未确认');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(true);
  expect(wrapper.getComponent(MobileSessionsDialog).props('lockReason')).toContain('提交结果尚未确认');
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('new'); await flushPromises();
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('结果未确认');
});


it('can retry an uncertain original mobile request even after the editor is cleared', async () => {
  streamTurn.mockRejectedValueOnce(new TypeError('receipt lost')).mockImplementationOnce(async (_id, _text, cb, options) => { await options!.onAccepted!('recovered'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('原始请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  const firstKey = streamTurn.mock.calls[0]![3]!.idempotencyKey;
  await wrapper.get('.pc-whisper-input textarea').setValue('');
  const retry = wrapper.get('.pc-retry'); expect(retry.attributes('disabled')).not.toBe('true');
  await retry.trigger('click'); await flushPromises();
  expect(streamTurn).toHaveBeenCalledTimes(2);
  expect(streamTurn.mock.calls[1]![1]).toBe('原始请求');
  expect(streamTurn.mock.calls[1]![3]!.idempotencyKey).toBe(firstKey);
});

it('allows an explicit mobile session choice after the server has refused an unaccepted request', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(404, 'POST /turns'));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('会话刚被删除');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('switchLocked')).toBe(false);
  wrapper.getComponent(MobileSessionsDialog).vm.$emit('new'); await flushPromises();
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(true);
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBe('会话刚被删除');
});

it('keeps the placeholder draft read-only only while preparing a new mobile session', async () => {
  let release!: (value: unknown) => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path === '/v1/sessions') return new Promise(resolve => { release = resolve; });
    return requestImplementation(method, path);
  });
  const pending = pendingStream();
  const wrapper = await mountSurface('mobile', true, 'web_default');
  const input = wrapper.get('.pc-whisper-input textarea'); await input.setValue('创建前的草稿');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(input.attributes('readonly')).toBeDefined();
  release({ id: 'created_for_draft', title: '新对话', createdAt: '', updatedAt: '' }); await flushPromises();
  expect(input.attributes('readonly')).toBeUndefined();
  expect(localStorage.getItem('aervox-mobile-draft:created_for_draft')).toBe('创建前的草稿');
  expect(localStorage.getItem('aervox-mobile-draft:web_default')).toBeNull();
  await input.setValue('建好后继续输入');
  await pending.options.onAccepted!('accepted_after_create'); await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe('建好后继续输入');
});


it.each([false, true])('acknowledges an accepted mobile draft when a pre-receipt stop fails (new draft: %s)', async newer => {
  let receipt!: () => void;
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path.endsWith('/cancel')) throw new Error('cancel reply lost');
    return requestImplementation(method, path);
  });
  streamTurn.mockImplementation((_id, _text, _cb, options) => new Promise<void>((resolve, reject) => {
    receipt = () => { Promise.resolve(options!.onAccepted!('turn_cancel_receipt')).then(() => resolve(), reject); };
  }));
  observeTurn.mockImplementation(async (_id, cb) => { cb.onDelta('恢复同一轮'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  const input = wrapper.get('.pc-whisper-input textarea'); await input.setValue('已经接单的原文');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-stop').trigger('click');
  if (newer) await input.setValue('仍待发送的新草稿');
  receipt(); await flushPromises();
  expect((input.element as HTMLTextAreaElement).value).toBe(newer ? '仍待发送的新草稿' : '');
  await wrapper.get('.pc-resume').trigger('click'); await flushPromises();
  expect(observeTurn).toHaveBeenCalledWith('turn_cancel_receipt', expect.anything(), expect.anything());
  expect((input.element as HTMLTextAreaElement).value).toBe(newer ? '仍待发送的新草稿' : '');
});

it('finishes a newly accepted retry after a definite refusal without erasing a newer draft', async () => {
  streamTurn.mockRejectedValueOnce(new AervoxHttpError(400, 'POST /turns'))
    .mockImplementationOnce(async (_id, _text, cb, options) => { await options!.onAccepted!('turn_retry_accepted'); cb.onDone(); });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('要重试的原始请求');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-retry').trigger('click'); await flushPromises();
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('');
  expect(localStorage.getItem('aervox-mobile-draft:ses_recent')).toBeNull();
});

it('resumes the identified turn after a saved answer when the first question stream has ended', async () => {
  const submitAnswers = vi.fn().mockResolvedValue(undefined);
  configureAervoxClient({ sessionId: recentSession.id, transport: { request: request as never, streamTurn: streamTurn as never,
    observeTurn: observeTurn as never, submitQuestionAnswers: submitAnswers, decideToolApproval: vi.fn() } });
  streamTurn.mockImplementation(async (_id, _text, cb, options) => {
    await options!.onAccepted!('turn_mobile_questions');
    cb.onUserQuestion!({ turnId: 'turn_mobile_questions', step: 1, questions: [{ id: 'q1', question: '第一题' }] }); cb.onDone();
  });
  observeTurn.mockImplementation((_id, cb, options) => new Promise<void>(resolve => {
    cb.onUserQuestion!({ turnId: 'turn_mobile_questions', step: 2, questions: [{ id: 'q2', question: '第二题' }] });
    options!.signal!.addEventListener('abort', () => resolve(), { once: true });
  }));
  const wrapper = await mountSurface('mobile', true);
  await wrapper.findAll('.pc-choice')[1]!.trigger('click'); await flushPromises();
  const question = wrapper.getComponent({ name: 'UserQuestionComposer' });
  question.vm.$emit('submit', [{ id: 'q1', selected: [], custom: '第一答' }]); await flushPromises();
  expect(observeTurn).toHaveBeenCalledTimes(1);
  expect(observeTurn.mock.calls[0]![0]).toBe('turn_mobile_questions');
  expect(wrapper.getComponent({ name: 'UserQuestionComposer' }).props('submitting')).toBe(false);
  expect(wrapper.find('.pc-stop').exists()).toBe(true);
  wrapper.getComponent({ name: 'UserQuestionComposer' }).vm.$emit('submit', [{ id: 'q2', selected: [], custom: '第二答' }]); await flushPromises();
  expect(submitAnswers).toHaveBeenCalledTimes(2); expect(observeTurn).toHaveBeenCalledTimes(1);
});

it('does not push a hidden input layer above an open mobile modal when a draft is restored', async () => {
  const layers: { onBack(): void }[] = [];
  const back = { registerLayer: (options: { onBack(): void }) => {
    layers.push(options); const remove = () => { const i = layers.indexOf(options); if (i >= 0) layers.splice(i, 1); };
    return { close: remove, dispose: remove };
  } };
  let fail!: (error: Error) => void;
  streamTurn.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const wrapper = await mountSurface('mobile', true, recentSession.id, back);
  await wrapper.get('.pc-whisper-input textarea').setValue('等待回执时保留');
  await wrapper.get('.pc-whisper-input textarea').trigger('focus');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  await wrapper.get('.pc-whisper-close').trigger('click'); await flushPromises();
  await wrapper.get('[aria-label="会话列表"]').trigger('click'); await flushPromises();
  expect(layers).toHaveLength(1);
  fail(new TypeError('offline')); await flushPromises();
  expect(layers).toHaveLength(1);
  layers[0]!.onBack(); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('modelValue')).toBe(false);
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('等待回执时保留');
});


it('shows creation failure inside the mobile list and keeps the old conversation usable', async () => {
  request.mockImplementation(async (method, path) => {
    if (method === 'POST' && path === '/v1/sessions') throw new Error('create failed');
    return requestImplementation(method, path);
  });
  const wrapper = await mountSurface('mobile', true);
  await wrapper.get('.pc-whisper-input textarea').setValue('旧会话的草稿');
  await wrapper.get('[aria-label="会话列表"]').trigger('click');
  const panel = wrapper.getComponent(MobileSessionsDialog);
  panel.vm.$emit('new'); await flushPromises();
  expect(panel.props('modelValue')).toBe(true);
  expect(panel.props('notice')).toContain('新对话没有创建成功');
  expect(panel.props('error')).toBeNull();
  expect(wrapper.get('.pc-current-session').text()).toBe('死锁复习');
  panel.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.get('.pc-whisper-input md-filled-button').attributes('disabled')).not.toBe('true');
  expect((wrapper.get('.pc-whisper-input textarea').element as HTMLTextAreaElement).value).toBe('旧会话的草稿');
});

it('does not label a missing stored mobile identity as a newly created conversation', async () => {
  const wrapper = await mountSurface('mobile', true, 'deleted_stored_session');
  expect(wrapper.get('.pc-current-session').text()).toBe('当前会话不可用');
  await wrapper.get('.pc-whisper-input textarea').setValue('先不要新建');
  await wrapper.get('.pc-whisper-input md-filled-button').trigger('click'); await flushPromises();
  expect(wrapper.getComponent(MobileSessionsDialog).props('notice')).toContain('当前会话已不可用');
  expect(request.mock.calls.some(call => call[0] === 'POST' && call[1] === '/v1/sessions')).toBe(false);
});
