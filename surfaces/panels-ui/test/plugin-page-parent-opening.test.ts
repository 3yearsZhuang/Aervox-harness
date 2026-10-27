import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import type { PluginPageDto, PluginSummaryDto } from '@aervox/api-client';

const calls = vi.hoisted(() => ({ loadPlugins: vi.fn(), listPages: vi.fn(), error: vi.fn() }));
const plugins = ref<PluginSummaryDto[]>([]);
const loadError = ref<string | null>(null);
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxPlugins: () => ({
    plugins, error: loadError, loading: ref(false), loadPlugins: calls.loadPlugins, listPages: calls.listPages,
    listSensorGrants: async () => [], getConfigSchema: async () => ({ fields: [] }),
    getConfig: async () => ({ revision: 0, values: {}, secretFields: {} }),
  }),
  useAervoxSkills: () => ({ skills: ref([]), loadSkills: async () => {} }),
  useAervoxTools: () => ({ tools: ref([]), loadTools: async () => {} }),
}));
vi.mock('@aervox/ui/utils/element', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/ui/utils/element')>(),
  ElMessage: { error: calls.error, success: vi.fn() },
}));
vi.mock('@aervox/ui/plugin-api', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/ui/plugin-api')>(), useUIPluginContext: () => undefined,
}));

import PluginManagerPanel from '../src/plugin/PluginManagerPanel.vue';
import PluginSettingsDialog from '../src/plugin/PluginSettingsDialog.vue';

const page = (generation = 'old-page'): PluginPageDto => ({
  id: 'settings', title: 'Settings', entry: 'pages/settings/index.html', pageGeneration: generation, capabilities: ['config.read'],
});
const plugin = (id = 'demo', generation = 'old-plugin'): PluginSummaryDto => ({
  id, enabled: 1, availability: 'available', lifecycleGeneration: generation, publisher: 'test', version: '1',
  checksum: 'fixture', installSource: 'registry', createdAt: '', updatedAt: '',
});
const PageStub = defineComponent({ name: 'PluginPageDialog', props: ['open', 'plugin', 'page'], emits: ['close', 'refresh'], template: '<div />' });
const wrappers: ReturnType<typeof shallowMount>[] = [];

beforeEach(() => {
  calls.loadPlugins.mockReset(); calls.listPages.mockReset(); calls.error.mockReset();
  plugins.value = [plugin(), plugin('other')];
  loadError.value = null;
  calls.loadPlugins.mockImplementation(async () => {});
  calls.listPages.mockResolvedValue([page()]);
});
afterEach(() => { for (const wrapper of wrappers.splice(0)) wrapper.unmount(); });

for (const kind of ['manager', 'settings'] as const) {
  describe(`${kind} Page opening ownership`, () => {
    async function parent() {
      const wrapper = shallowMount(kind === 'manager' ? PluginManagerPanel : PluginSettingsDialog, {
        props: kind === 'settings' ? { open: true, plugin: plugin() } : {},
        global: { stubs: {
          AervoxDialog: { template: '<div><slot /><slot name="footer" /></div>' },
          PluginPageDialog: PageStub,
        } },
      });
      wrappers.push(wrapper);
      await flushPromises();
      calls.loadPlugins.mockClear();
      calls.listPages.mockClear();
      const child = () => wrapper.findComponent(PageStub);
      const open = () => (wrapper.vm as unknown as { openPage(input: PluginSummaryDto | PluginPageDto): Promise<void> })
        .openPage(kind === 'manager' ? plugin() : page());
      return { wrapper, child, open };
    }

    function fresh(generation = 'fresh-plugin', pageGeneration = 'fresh-page') {
      calls.loadPlugins.mockImplementation(async () => { plugins.value = [plugin('demo', generation), plugin('other', generation)]; loadError.value = null; });
      calls.listPages.mockResolvedValue([page(pageGeneration)]);
    }

    it('loads fresh plugin and Page identities before opening, leaving the Settings configuration owner intact', async () => {
      const { wrapper, child, open } = await parent();
      fresh();
      await open(); await nextTick();
      expect(calls.loadPlugins).toHaveBeenCalledOnce();
      expect(calls.listPages).toHaveBeenCalledWith('demo', 'fresh-plugin', expect.any(AbortSignal));
      expect(child().props()).toMatchObject({ open: true, plugin: { lifecycleGeneration: 'fresh-plugin' }, page: { pageGeneration: 'fresh-page' } });
      if (kind === 'settings') expect(wrapper.props('plugin')).toMatchObject({ lifecycleGeneration: 'old-plugin' });
    });

    it('closes the old owner before an explicit refresh fetch and reopens the same Page with fresh identities', async () => {
      const { child, open } = await parent();
      fresh(); await open(); await nextTick();
      let finish!: () => void;
      calls.loadPlugins.mockImplementationOnce(() => new Promise<void>(resolve => {
        expect(child().props('open')).toBe(false);
        finish = () => { plugins.value = [plugin('demo', 'plugin-2')]; resolve(); };
      }));
      calls.listPages.mockResolvedValue([page('page-2'), { ...page('unrelated'), id: 'other-page' }]);
      child().vm.$emit('refresh'); await flushPromises();
      expect(child().props('open')).toBe(false);
      finish(); await flushPromises();
      expect(child().props()).toMatchObject({ open: true, plugin: { lifecycleGeneration: 'plugin-2' }, page: { id: 'settings', pageGeneration: 'page-2' } });
    });

    it('rejects a swallowed plugin-list failure instead of reopening from cached identities', async () => {
      const { child, open } = await parent();
      calls.loadPlugins.mockImplementationOnce(async () => { loadError.value = 'network unavailable'; });
      await open(); await nextTick();
      expect(child().props('open')).toBe(false);
      expect(calls.listPages).not.toHaveBeenCalled();
      expect(calls.error).toHaveBeenCalledOnce();
    });

    it.each(['disabled', 'unavailable', 'missing-generation', 'missing-plugin'] as const)('refuses fresh %s eligibility', async change => {
      const { child, open } = await parent();
      calls.loadPlugins.mockImplementationOnce(async () => {
        plugins.value = change === 'missing-plugin' ? [] : [{ ...plugin(),
          ...(change === 'disabled' ? { enabled: 0 } : change === 'unavailable' ? { availability: 'missing' as const } : { lifecycleGeneration: undefined }),
        }];
      });
      await open(); await nextTick();
      expect(child().props('open')).toBe(false);
      expect(calls.listPages).not.toHaveBeenCalled();
      expect(calls.error).toHaveBeenCalledOnce();
    });

    it('does not reopen after a Page close while fresh listing is pending', async () => {
      const { child, open } = await parent();
      fresh();
      let finish!: (value: PluginPageDto[]) => void;
      calls.listPages.mockImplementationOnce(() => new Promise<PluginPageDto[]>(resolve => { finish = resolve; }));
      const pending = open(); await flushPromises();
      const signal = calls.listPages.mock.calls[0]![2] as AbortSignal;
      child().vm.$emit('close'); await nextTick();
      expect(signal.aborted).toBe(true);
      finish([page('late-page')]); await pending; await nextTick();
      expect(child().props('open')).toBe(false);
      expect(child().props('page')?.pageGeneration).not.toBe('late-page');
    });

    it('leaves a removed selected Page closed on refresh instead of opening an unrelated Page', async () => {
      const { child, open } = await parent();
      fresh(); await open(); await nextTick();
      calls.listPages.mockResolvedValue([{ ...page('other'), id: 'other-page' }]);
      child().vm.$emit('refresh'); await flushPromises();
      expect(child().props('open')).toBe(false);
      expect(calls.error).toHaveBeenCalledOnce();
    });
  });
}

it('Manager keeps the newer selection busy and ignores an older completion', async () => {
  const wrapper = shallowMount(PluginManagerPanel, { global: { stubs: { PluginPageDialog: PageStub } } });
  wrappers.push(wrapper); await flushPromises();
  calls.loadPlugins.mockImplementation(async () => { plugins.value = [plugin(), plugin('other')]; });
  const completions = new Map<string, (pages: PluginPageDto[]) => void>();
  calls.listPages.mockImplementation((id: string) => new Promise<PluginPageDto[]>(resolve => completions.set(id, resolve)));
  const vm = wrapper.vm as unknown as { openPage(plugin: PluginSummaryDto): Promise<void>; pageBusy: string | null };
  const first = vm.openPage(plugin()); await flushPromises();
  const second = vm.openPage(plugin('other')); await flushPromises();
  completions.get('demo')!([page('old-completion')]); await first; await nextTick();
  expect(vm.pageBusy).toBe('other');
  completions.get('other')!([page('current-completion')]); await second; await nextTick();
  expect(wrapper.findComponent(PageStub).props()).toMatchObject({ open: true, plugin: { id: 'other' }, page: { pageGeneration: 'current-completion' } });
});

it.each(['close', 'change-plugin'] as const)('Settings rejects a late Page listing after parent %s', async change => {
  const wrapper = shallowMount(PluginSettingsDialog, {
    props: { open: true, plugin: plugin() },
    global: { stubs: { AervoxDialog: { template: '<div><slot /></div>' }, PluginPageDialog: PageStub } },
  });
  wrappers.push(wrapper); await flushPromises();
  let finish!: (value: PluginPageDto[]) => void;
  calls.listPages.mockImplementationOnce(() => new Promise<PluginPageDto[]>(resolve => { finish = resolve; }));
  const pending = (wrapper.vm as unknown as { openPage(page: PluginPageDto): Promise<void> }).openPage(page());
  await flushPromises();
  await wrapper.setProps(change === 'close' ? { open: false } : { plugin: plugin('other') });
  finish([page('late-page')]); await pending; await nextTick();
  expect(wrapper.findComponent(PageStub).props('open')).toBe(false);
});
