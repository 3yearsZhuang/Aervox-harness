import { afterEach, expect, it, vi } from 'vitest';
import { DOMWrapper, shallowMount, flushPromises } from '@vue/test-utils';
import { material3ContextKey } from '@aervox/ui/material3';
import PluginConfigDialog from '../src/plugin/PluginConfigDialog.vue';
import PluginSettingsDialog from '../src/plugin/PluginSettingsDialog.vue';

const api = vi.hoisted(() => ({
  loads: new Map<string, (value: unknown) => void>(),
  save: vi.fn(async (_id: string, input: { values: Record<string, unknown> }) => ({revision: 2, values: input.values, secretFields: {}})),
  reset: vi.fn(async () => ({revision: 2, values: {}, secretFields: {}})),
  confirm: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('@aervox/api-client', () => ({
  useAervoxPlugins: () => ({
    getConfigSchema: async () => ({fields: [{key: 'theme', type: 'string'}]}),
    getConfig: (id: string) => new Promise(resolve => api.loads.set(id, resolve)),
    saveConfig: api.save, resetConfig: api.reset, listPages: async () => [],
  }),
  useAervoxSkills: () => ({loadSkills: async () => {}, skills: {value: []}}),
  useAervoxTools: () => ({loadTools: async () => {}, tools: {value: []}}),
}));
vi.mock('@aervox/ui/primitives', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/ui/primitives')>(),
  aervoxConfirm: api.confirm,
}));
const plugin = (id: string) => ({id, publisher: 'test', version: '1', enabled: 1, configSchemaJson: [{}]});
const snapshot = (theme: string) => ({revision: 1, values: {theme}, secretFields: {}});
const materialGlobal = {
  provide: {[material3ContextKey as symbol]: true},
  // Keep the native prompt real while shallow-mounting unrelated plugin panels.
  stubs: {Teleport: false, DialogPrompt: false, AervoxDialog: false, MaterialDialogFrame: false, AervoxButton: false},
};
const wrappers: ReturnType<typeof shallowMount>[] = [];
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); api.loads.clear(); vi.clearAllMocks(); });

for (const [Component, save, reset] of [[PluginConfigDialog, 'save', 'reset'], [PluginSettingsDialog, 'saveConfig', 'resetConfig']] as const) {
  it(`${Component.__name}: late A load cannot become B's saved configuration`, async () => {
    const wrapper = shallowMount(Component, {props: {open: false, plugin: plugin('A')} as never}); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    await wrapper.setProps({open: false});
    await wrapper.setProps({plugin: plugin('B'), open: true}); await flushPromises();
    api.loads.get('B')!(snapshot('B')); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    await (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    expect(api.save).toHaveBeenCalledWith('B', {revision: 1, values: {theme: 'B'}, secretValues: {}});
  });
  it(`${Component.__name}: changing plugin while open loads the new owner and prevents saving before load`, async () => {
    const wrapper = shallowMount(Component, {props: {open: false, plugin: plugin('A')} as never}); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    (wrapper.vm as unknown as {updateSecret(key: string, value: string): void}).updateSecret('token', 'secret-A');
    await wrapper.setProps({plugin: plugin('B')}); await flushPromises();
    await (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    expect(api.save).not.toHaveBeenCalled();
    expect(api.loads.has('B')).toBe(true);
    api.loads.get('B')!(snapshot('B')); await flushPromises();
    await (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    expect(api.save).toHaveBeenCalledWith('B', {revision: 1, values: {theme: 'B'}, secretValues: {}});
  });
  it(`${Component.__name}: reset confirmation is bound to the original plugin generation`, async () => {
    let confirm!: (value: boolean) => void;
    api.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const wrapper = shallowMount(Component, {props: {open: false, plugin: plugin('A')} as never}); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    const pending = (wrapper.vm as unknown as Record<string, () => Promise<void>>)[reset]!();
    await wrapper.setProps({open: false}); await wrapper.setProps({plugin: plugin('B'), open: true}); await flushPromises();
    api.loads.get('B')!(snapshot('B')); await flushPromises();
    confirm(true); await pending;
    expect(api.reset).not.toHaveBeenCalled();
  });
  it(`${Component.__name}: Material reset cancellation uses a native prompt and preserves configuration`, async () => {
    const wrapper = shallowMount(Component, {
      props: {open: false, plugin: plugin('A')} as never,
      global: materialGlobal,
    }); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    const pending = (wrapper.vm as unknown as Record<string, () => Promise<void>>)[reset]!();
    await flushPromises();
    const dialog = document.querySelector('md-dialog.avx-dialog-prompt')!;
    expect(dialog).not.toBeNull();
    expect(api.confirm).not.toHaveBeenCalled();
    await new DOMWrapper(dialog.querySelector('md-filled-tonal-button')!).trigger('click');
    dialog.dispatchEvent(new Event('closed'));
    await pending;
    expect(api.reset).not.toHaveBeenCalled();
    await (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    expect(api.save).toHaveBeenCalledWith('A', {revision: 1, values: {theme: 'A'}, secretValues: {}});
  });
  it(`${Component.__name}: closing its own window cancels a pending Material reset`, async () => {
    const wrapper = shallowMount(Component, {
      props: {open: false, plugin: plugin('A')} as never,
      global: materialGlobal,
    }); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    const pending = (wrapper.vm as unknown as Record<string, () => Promise<void>>)[reset]!();
    await flushPromises();
    expect(document.querySelector('md-dialog.avx-dialog-prompt')).not.toBeNull();
    await wrapper.setProps({open: false}); await flushPromises();
    await pending;
    expect(document.querySelector('md-dialog.avx-dialog-prompt')).toBeNull();
    expect(api.reset).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
  });
  it(`${Component.__name}: late A save result cannot replace B's draft or emit saved`, async () => {
    let finish!: (value: unknown) => void;
    api.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as never);
    const wrapper = shallowMount(Component, {props: {open: false, plugin: plugin('A')} as never}); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    api.loads.get('A')!(snapshot('A')); await flushPromises();
    const pending = (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    await wrapper.setProps({plugin: plugin('B')}); await flushPromises();
    api.loads.get('B')!(snapshot('B')); await flushPromises();
    finish({revision: 4, values: {theme: 'late-A'}, secretFields: {token: {configured: true}}}); await pending;
    expect(wrapper.emitted('saved')).toBeUndefined();
    await (wrapper.vm as unknown as Record<string, () => Promise<void>>)[save]!();
    expect(api.save).toHaveBeenLastCalledWith('B', {revision: 1, values: {theme: 'B'}, secretValues: {}});
  });
  it(`${Component.__name}: closing and unmounting removes secret drafts and ignores pending load`, async () => {
    const wrapper = shallowMount(Component, {props: {open: false, plugin: plugin('A')} as never}); wrappers.push(wrapper);
    await wrapper.setProps({open: true}); await flushPromises();
    const finish = api.loads.get('A')!;
    wrapper.unmount(); wrappers.pop();
    finish(snapshot('A')); await flushPromises();
    expect(api.save).not.toHaveBeenCalled();
    expect(wrapper.emitted('saved')).toBeUndefined();
  });

}
