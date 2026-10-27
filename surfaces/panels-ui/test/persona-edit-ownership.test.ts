import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, shallowMount } from '@vue/test-utils';
import PersonaEditDialog from '../src/persona/PersonaEditDialog.vue';

const api = vi.hoisted(() => ({
  loads: new Map<string, {resolve: (value: unknown) => void; reject: (cause: Error) => void}>(),
  update: vi.fn(), create: vi.fn(), error: vi.fn(), success: vi.fn(),
}));
vi.mock('@aervox/api-client', () => ({useAervoxPersonas: () => ({
  loadAvailableTools: async () => [], loadAvailableSkills: async () => [],
  getPersonaDetail: (id: string) => new Promise((resolve, reject) => api.loads.set(id, {resolve, reject})),
  updatePersona: api.update, createPersona: api.create,
})}));
vi.mock('@aervox/ui/utils/element', () => ({ElMessage: {error: api.error, success: api.success, warning: vi.fn()}}));
enableAutoUnmount(afterEach);
beforeEach(() => { api.loads.clear(); vi.resetAllMocks(); api.update.mockResolvedValue({}); api.create.mockResolvedValue({}); });
const detail = (id: string) => ({persona: {name: id, description: id}, revision: {revision: 1, config: {
  systemPromptAppend: `prompt-${id}`, allowedMcpToolIds: [`tool-${id}`], allowedSkillNames: [`skill-${id}`],
}}});
const payload = (id: string) => ({expectedRevision: 1, name: id, description: id, config: {
  systemPromptAppend: `prompt-${id}`, allowedMcpToolIds: [`tool-${id}`], allowedSkillNames: [`skill-${id}`], voice: undefined,
}});
const mount = () => shallowMount(PersonaEditDialog, {props: {open: false, personaId: 'A'}, global: {renderStubDefaultSlot: true}});
const save = (wrapper: ReturnType<typeof mount>) => (wrapper.vm as unknown as {save(): Promise<void>}).save();

it('closes through the shared dialog model event and ignores a late closed model event', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const dialog = wrapper.getComponent({name: 'AervoxDialog'});
  dialog.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.emitted('close')).toEqual([[]]);
  await wrapper.setProps({open: false});
  dialog.vm.$emit('update:modelValue', false); await flushPromises();
  expect(wrapper.emitted('close')).toEqual([[]]);
  expect(api.update).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
});

it('keeps B draft and capabilities when an older A detail arrives after B', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true, personaId: 'B'}); await flushPromises();
  api.loads.get('B')!.resolve(detail('B')); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('B', payload('B'));
});
it('loads a changed identity while open and blocks save until its own detail resolves', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  await wrapper.setProps({personaId: 'B'}); await flushPromises();
  await save(wrapper); expect(api.update).not.toHaveBeenCalled();
  expect(api.loads.has('B')).toBe(true);
  api.loads.get('B')!.resolve(detail('B')); await flushPromises();
  await save(wrapper); expect(api.update).toHaveBeenCalledWith('B', payload('B'));
});
it('does not close B or notify saved when A save completes after replacement', async () => {
  let finish!: (value: unknown) => void;
  api.update.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  const pending = save(wrapper); await wrapper.setProps({personaId: 'B'}); await flushPromises();
  api.loads.get('B')!.resolve(detail('B')); await flushPromises(); finish({}); await pending;
  expect(wrapper.emitted('close')).toBeUndefined(); expect(wrapper.emitted('saved')).toBeUndefined();
  expect(api.success).not.toHaveBeenCalled();
  await save(wrapper); expect(api.update).toHaveBeenLastCalledWith('B', payload('B'));
});
it('ignores A read failure after closing and opening a fresh create draft', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true, personaId: null}); await flushPromises();
  api.loads.get('A')!.reject(new Error('late A failure')); await flushPromises();
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
});
it('suppresses late read and save effects after unmount', async () => {
  let fail!: (cause: Error) => void;
  api.update.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  const pending = save(wrapper); wrapper.unmount(); fail(new Error('late save failure')); await pending;
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
});

it('fences a previous load when the same persona is closed and reopened', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const old = api.loads.get('A')!;
  await wrapper.setProps({open: false}); await wrapper.setProps({open: true}); await flushPromises();
  api.loads.get('A')!.resolve(detail('A')); await flushPromises();
  old.resolve(detail('old-A')); await flushPromises();
  await save(wrapper); expect(api.update).toHaveBeenCalledWith('A', payload('A'));
});
it('drops a pending load failure after unmount', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const old = api.loads.get('A')!; wrapper.unmount(); old.reject(new Error('unmounted load')); await flushPromises();
  expect(api.error).not.toHaveBeenCalled(); expect(wrapper.emitted('close')).toBeUndefined();
});

it('preserves voice settings and unavailable capabilities when editing its speaker', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  const voice = {enabled: true, providerId: 'voice', modelId: 'model', speakerId: 'old', settings: {speed: 1.2, language: 'zh'}};
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, voice}}});
  await flushPromises();
  wrapper.findComponent({name: 'VoiceAbilityCard'}).vm.$emit('update:modelValue', {...voice, settings: undefined, speakerId: 'new'});
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('A', {...payload('A'), config: {...payload('A').config, voice: {...voice, speakerId: 'new'}}});
  expect(voice.speakerId).toBe('old');
});

it('does not carry model-specific voice settings into another provider or model', async () => {
  const wrapper = mount(); await wrapper.setProps({open: true}); await flushPromises();
  const loaded = detail('A');
  const voice = {enabled: true, providerId: 'voice', modelId: 'model', settings: {speed: 1.2}};
  api.loads.get('A')!.resolve({...loaded, revision: {...loaded.revision, config: {...loaded.revision.config, voice}}});
  await flushPromises();
  const replacement = {enabled: true, providerId: 'other', modelId: 'new-model'};
  wrapper.findComponent({name: 'VoiceAbilityCard'}).vm.$emit('update:modelValue', replacement);
  await save(wrapper);
  expect(api.update).toHaveBeenCalledWith('A', {...payload('A'), config: {...payload('A').config, voice: replacement}});
});
