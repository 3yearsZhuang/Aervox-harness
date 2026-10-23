import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { configureAervoxClient, type StreamTurnOptions, type TurnCallbacks } from '@aervox/api-client';
import definition from '../src';

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

async function mountSurface(platform: 'web' | 'desktop' = 'web') {
  const wrapper = mount(UISurfaceHost, {
    props: { plugin: definition, surface: 'main', platform },
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

it('uses a new idempotency key when an explicit retry targets another session', async () => {
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
  await wrapper.find('.pc-retry').trigger('click');
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
