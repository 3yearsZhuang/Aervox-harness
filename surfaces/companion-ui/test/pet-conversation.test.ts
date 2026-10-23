import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { UISurfaceHost } from '@aervox/ui-host';
import { configureAervoxClient, type TurnCallbacks } from '@aervox/api-client';
import definition from '../src';

enableAutoUnmount(afterEach);
beforeAll(async () => { await definition.load(); });
const streamTurn = vi.fn(), observeTurn = vi.fn(), request = vi.fn(), submitQuestionAnswers = vi.fn(), decideToolApproval = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  streamTurn.mockReset(); observeTurn.mockReset();
  request.mockResolvedValue({}); submitQuestionAnswers.mockResolvedValue(undefined);
  configureAervoxClient({sessionId:'pet-session',transport:{streamTurn,observeTurn,request,submitQuestionAnswers,decideToolApproval}});
});
async function pet() {
  const wrapper = mount(UISurfaceHost,{props:{plugin:definition,surface:'companion',platform:'desktop'},global:{stubs:{PetWithFallback:true}}});
  await vi.waitFor(() => expect(wrapper.find('.pet-window').exists()).toBe(true));
  await wrapper.get('.pet-quick-input').setValue('帮我安排');
  await wrapper.get('.pet-quick-input').trigger('keydown',{key:'Enter'});
  await flushPromises();
  return wrapper;
}
it('keeps an uncertain submission editable and retries using the original reservation', async () => {
  streamTurn.mockRejectedValueOnce(new Error('acceptance lost')).mockImplementationOnce(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onDelta('好了');cb.onDone();});
  const wrapper = await pet();
  expect((wrapper.get('.pet-quick-input').element as HTMLInputElement).value).toBe('帮我安排');
  await wrapper.get('.pet-choices button').trigger('click'); await flushPromises();
  expect(streamTurn.mock.calls[1]![3].idempotencyKey).toBe(streamTurn.mock.calls[0]![3].idempotencyKey);
  expect((wrapper.get('.pet-quick-input').element as HTMLInputElement).value).toBe('');
});
it('restores observation at its cursor and appends to the visible partial reply', async () => {
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('安排一。');
    await cb.onEvent({eventId:'seen',turnId:'turn',sequence:1,eventType:'delta',data:{text:'安排一。'}});
    throw new Error('disconnected');
  });
  observeTurn.mockImplementationOnce(async (_turn,cb)=>{cb.onDelta('安排二。');cb.onDone();});
  const wrapper = await pet();
  expect(wrapper.get('.pet-bubble').text()).toContain('安排一。');
  expect(wrapper.get('.pet-choices button').text()).toBe('恢复接收回复');
  await wrapper.get('.pet-choices button').trigger('click'); await flushPromises();
  expect(wrapper.get('.pet-bubble p').text()).toBe('安排一。安排二。');
  expect(observeTurn).toHaveBeenCalledWith('turn',expect.any(Object),expect.objectContaining({afterEventId:'seen'}));
  expect(streamTurn).toHaveBeenCalledOnce();
});
it('submits all questions and preserves a newer prompt while the old answer is in flight', async () => {
  let forward!: TurnCallbacks;
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{
    forward=cb;await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',step:1,questions:[
      {id:'q',question:'选主题',multiSelect:true,options:[{label:'A'},{label:'B'}]},
      {id:'details',question:'补充要求'},
    ]});cb.onDone();
  });
  let answerSaved!: () => void;
  submitQuestionAnswers.mockImplementationOnce(()=>new Promise<void>(resolve=>{answerSaved=resolve;}));
  const wrapper = await pet();
  await wrapper.findAll('.uq-option-btn')[0]!.trigger('click');await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('.uq-custom-input input')[1]!.setValue('带示例');
  await wrapper.get('.uq-submit-btn').trigger('click');
  forward.onUserQuestion!({turnId:'turn',step:2,questions:[{id:'next',question:'继续确认'}]});
  answerSaved();await flushPromises();
  expect(submitQuestionAnswers).toHaveBeenCalledWith('turn',[
    {id:'q',selected:['A','B'],custom:undefined},{id:'details',selected:[],custom:'带示例'},
  ],expect.any(AbortSignal));
  expect(wrapper.get('.pet-question').text()).toContain('继续确认');
  expect(wrapper.get('.pet-question').text()).not.toContain('选主题');
});
it('cancels pending user input through the server without auto-answering', async () => {
  streamTurn.mockImplementation(async (_s,_c,cb,options)=>{await options.onAccepted('turn');cb.onUserQuestion({turnId:'turn',questions:[{id:'q',question:'请选择'}]});cb.onDone();});
  const wrapper=await pet();
  await wrapper.get('.pet-stop').trigger('click');await flushPromises();
  expect(request).toHaveBeenCalledWith('POST','/v1/turns/turn/cancel',{},expect.any(Object));
  expect(submitQuestionAnswers).not.toHaveBeenCalled();expect(wrapper.find('.pet-question').exists()).toBe(false);
});
it('keeps partial output visible after a terminal interruption and clears stale questions', async()=>{
  streamTurn.mockImplementationOnce(async (_s,_c,cb,options)=>{
    await options.onAccepted('turn');cb.onDelta('保留的正文。');cb.onUserQuestion({turnId:'turn',questions:[{id:'q',question:'旧问题'}]});cb.onDone();
    await cb.onEvent({eventId:'done',turnId:'turn',sequence:3,eventType:'done',data:{status:'Interrupted',reason:'turn_timeout',isComplete:false}});
  });
  const wrapper=await pet();
  expect(wrapper.get('.pet-bubble').text()).toContain('保留的正文。');
  expect(wrapper.get('.pet-turn-feedback').text()).toContain('本次回复未完成');
  expect(wrapper.find('.pet-question').exists()).toBe(false);
  expect(wrapper.find('.pet-choices').exists()).toBe(false);
});
