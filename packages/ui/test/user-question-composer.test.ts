import { afterEach, expect, it } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import UserQuestionComposer from '../src/components/UserQuestionComposer.vue';

enableAutoUnmount(afterEach);
it('submits every question with multiple selections and free text only after explicit confirmation', async () => {
  const wrapper = mount(UserQuestionComposer, {props:{questionData:{turnId:'turn',questions:[
    {id:'topics',question:'选择主题',multiSelect:true,options:[{label:'A (Recommended)'},{label:'B'}]},
    {id:'detail',question:'补充要求'},
  ]}}});
  expect(wrapper.emitted('submit')).toBeUndefined();
  await wrapper.findAll('.uq-option-btn')[1]!.trigger('click');
  await wrapper.findAll('input')[1]!.setValue('请带示例');
  await wrapper.get('.uq-submit-btn').trigger('click');
  expect(wrapper.emitted('submit')![0]![0]).toEqual([
    {id:'topics',selected:['A (Recommended)','B'],custom:undefined},
    {id:'detail',selected:[],custom:'请带示例'},
  ]);
});
it('clears old answers when the next question reuses an id', async () => {
  const wrapper = mount(UserQuestionComposer, {props:{questionData:{turnId:'turn',step:1,questions:[{id:'q',question:'旧问题',options:[{label:'旧选项'}]}]}}});
  await wrapper.get('.uq-option-btn').trigger('click');
  await wrapper.get('input').setValue('旧内容');
  await wrapper.setProps({questionData:{turnId:'turn',step:2,questions:[{id:'q',question:'新问题',options:[{label:'新选项'}]}]}});
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  expect(wrapper.get('.uq-option-btn').attributes('aria-pressed')).toBe('false');
  expect(wrapper.get('.uq-submit-btn').attributes('disabled')).toBeDefined();
});
