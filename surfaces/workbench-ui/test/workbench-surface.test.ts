import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { configureAervoxClient } from '@aervox/api-client';
import type { BuiltinUIPlugin, UIRegistry } from '@aervox/ui/plugin-api';
import definition, { compactSurface } from '../src';

enableAutoUnmount(afterEach);
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('aervox-workbench-mode', 'standard');
  configureAervoxClient({
    transport: {
      request: vi.fn(async <T>(_method: string, path: string) => ({
        items: path === '/v1/plugins' ? [{ id: 'fixture-extension', enabled: 1 }] : [],
      }) as T),
      streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(),
    },
    platform: {},
  });
});

it('loads the real workbench on each client platform through the same definition', async () => {
  await definition.load();
  for (const platform of ['web', 'desktop', 'mobile'] as const) {
    const wrapper = mount(UISurfaceHost, { props: {
      plugin: definition, surface: 'main', platform, viewProps: { showCompanion: false },
    } });
    // The async module import and mounted session/extension requests both settle.
    await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
    await flushPromises();
    expect(wrapper.find('.standard-conversation').exists()).toBe(true);
    wrapper.unmount();
  }
});

it('compact surface mounts the same workbench as a single-column variant without sidebar', async () => {
  const wrapper = mount(UISurfaceHost, { props: {
    plugin: compactSurface, surface: 'main', platform: 'web', viewProps: { showCompanion: false },
  } });
  await vi.waitFor(() => expect(wrapper.find('.aervox-workbench').exists()).toBe(true), { timeout: 5000 });
  await flushPromises();
  expect(wrapper.find('.aervox-workbench.is-variant-compact').exists()).toBe(true);
  expect(wrapper.find('.workbench-standard-sidebar').exists()).toBe(false);
  expect(wrapper.find('.menu-pill').exists()).toBe(false);
  expect(wrapper.find('.standard-conversation').exists()).toBe(true);
});

it('keeps extension registries and cleanup separate across mounted workbenches', async () => {
  await definition.load();
  const registries: UIRegistry[] = [];
  const cleanups = [vi.fn(), vi.fn()];
  const extension: BuiltinUIPlugin = {
    id: 'fixture-extension',
    setup(registry, context) {
      const index = registries.push(registry) - 1;
      context!.navigation.setQuietStartup(true);
      return cleanups[index];
    },
  };
  const create = () => mount(UISurfaceHost, { props: {
    plugin: definition, surface: 'main', platform: 'web',
    viewProps: { plugins: [extension], showCompanion: false },
  } });
  const a = create();
  const b = create();
  await vi.waitFor(() => expect(registries).toHaveLength(2));
  expect(registries[0]).not.toBe(registries[1]);
  a.unmount();
  expect(cleanups[0]).toHaveBeenCalledOnce();
  expect(cleanups[1]).not.toHaveBeenCalled();
  expect(b.find('.aervox-workbench').exists()).toBe(true);
});

it.each(['web', 'desktop'] as const)('approval on %s observes the original Turn without resending', async platform => {
  const streamTurn = vi.fn(async (_session, _content, callbacks, options) => {
    await options.onAccepted?.('turn');
    callbacks.onTurnIdentified?.('turn');
    callbacks.onDelta('审批前。');
    callbacks.onToolApproval({approvalId:'approval',toolName:'save',argumentsHash:'hash',turnId:'turn'});
    callbacks.onDone();
  });
  const continuation = { attemptId: 'attempt2', afterEventId: 'decision' };
  const decideToolApproval = vi.fn(async () => ({ approvalId: 'approval', state: 'granted' as const, continuation }));
  const observeTurn = vi.fn(async (_id: string, callbacks) => { callbacks.onDelta('续跑正文'); callbacks.onDone(); });
  configureAervoxClient({ transport: {
    request: vi.fn(async <T>(_method: string, path: string) => ({items: path === '/v1/plugins' ? [{id:'fixture-extension',enabled:1}] : []}) as T),
    streamTurn, observeTurn, decideToolApproval, submitQuestionAnswers: vi.fn(),
  } });
  const plugin: BuiltinUIPlugin = { id:'fixture-extension', setup(_registry, context) {
    context!.navigation.setQuietStartup(true);
    void context!.sendMessage('save');
  }};
  const wrapper = mount(UISurfaceHost, {props:{ plugin:definition,surface:'main',platform,viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.find('.tool-approval-actions button').exists()).toBe(true),{timeout:5000});
  await wrapper.find('.tool-approval-actions button').trigger('click');
  await vi.waitFor(()=>expect(wrapper.text()).toContain('审批前。续跑正文'));
  expect(decideToolApproval).toHaveBeenCalledOnce();expect(streamTurn).toHaveBeenCalledOnce();
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'decision'}));
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(3);
});

it.each(['web', 'desktop'] as const)('recovers %s observation into the same reply and never repeats the submission', async platform => {
  const streamTurn = vi.fn(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn'); cb.onDelta('已收到。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'已收到。'}});
    throw new Error('observer lost');
  });
  const observeTurn = vi.fn(async (_turn,cb)=>{cb.onDelta('继续正文。');cb.onDone();});
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[{id:'fixture-extension',enabled:1}]:[]}) as T),streamTurn,observeTurn,decideToolApproval:vi.fn(),submitQuestionAnswers:vi.fn()}});
  const plugin: BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('你好');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform,viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.text()).toContain('恢复接收回复'),{timeout:5000});
  const retry=wrapper.findAll('button').find(button=>button.text()==='恢复接收回复')!;
  await retry.trigger('click');
  await vi.waitFor(()=>expect(wrapper.text()).toContain('已收到。继续正文。'));
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(3);
  expect(streamTurn).toHaveBeenCalledOnce();
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'seen'}));
});

it.each(['standard','companion'])('answers complete questions in %s mode and keeps a newer question after the old response', async mode=>{
  localStorage.setItem('aervox-workbench-mode',mode);
  let forward!: import('@aervox/api-client').TurnCallbacks;
  const streamTurn=vi.fn(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',step:1,questions:[
      {id:'topics',question:'选择主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'details',question:'补充要求'},
    ]});cb.onDone();
  });
  let saved!:()=>void;
  const submitQuestionAnswers=vi.fn(()=>new Promise<void>(resolve=>{saved=resolve;}));
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[{id:'fixture-extension',enabled:1}]:[]}) as T),streamTurn,observeTurn:vi.fn(),decideToolApproval:vi.fn(),submitQuestionAnswers}});
  const plugin:BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('帮我选择');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform:'web',viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.find('.uq-submit-btn').exists()).toBe(true),{timeout:5000});
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',step:2,questions:[{id:'next',question:'新的确认'}]});saved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'topics',selected:['A','B'],custom:undefined},{id:'details',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal));
  expect(wrapper.get('.user-question-card').text()).toContain('新的确认');
  expect(wrapper.get('.user-question-card').text()).not.toContain('选择主题');
});

it('preserves partial output and reports terminal interruption separately from connection loss', async()=>{
  const streamTurn=vi.fn(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('保留这段正文。');cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:2,eventType:'done',data:{status:'Interrupted',reason:'max_steps',isComplete:false}});
  });
  configureAervoxClient({transport:{request:vi.fn(async <T>(_m:string,path:string)=>({items:path==='/v1/plugins'?[{id:'fixture-extension',enabled:1}]:[]}) as T),streamTurn,observeTurn:vi.fn(),decideToolApproval:vi.fn(),submitQuestionAnswers:vi.fn()}});
  const plugin:BuiltinUIPlugin={id:'fixture-extension',setup(_registry,context){context!.navigation.setQuietStartup(true);void context!.sendMessage('长任务');}};
  const wrapper=mount(UISurfaceHost,{props:{plugin:definition,surface:'main',platform:'web',viewProps:{plugins:[plugin],showCompanion:false}}});
  await vi.waitFor(()=>expect(wrapper.text()).toContain('本次回复未完成'),{timeout:5000});
  expect(wrapper.text()).toContain('保留这段正文。');
  expect(wrapper.findAll('button').some(button=>button.text()==='恢复接收回复')).toBe(false);
  expect(wrapper.findAll('.standard-conversation article')).toHaveLength(3);
});
