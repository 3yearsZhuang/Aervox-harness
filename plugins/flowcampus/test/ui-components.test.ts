// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, enableAutoUnmount, type VueWrapper } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { AERVOX_CLIENT, AervoxHttpError, createAervoxClient, type AervoxTransport } from '@aervox/api-client';
import { UI_PLUGIN_CONTEXT_KEY, createUIRegistry, type UIPluginContext } from '@aervox/ui/plugin-api';
import { calculateCampusPlan, createEmptyCampusState, type CampusState } from '../src/domain/index.js';
import CampusDrawer from '../src/ui/CampusDrawer.vue';
import CampusCard from '../src/ui/CampusCard.vue';
import flowCampusUIPlugin from '../src/ui/index.js';
import { useCampusStore, disposeCampusStore } from '../src/ui/store.js';

const dialogs = vi.hoisted(() => ({ confirm: vi.fn(async () => 'confirm'), layers: [] as { onBack: () => void; close: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock('@aervox/ui/material3', async importOriginal => ({
  ...await importOriginal<object>(),
  useDialogPrompts: () => ({ confirm: dialogs.confirm }),
  useMobileBackNavigation: () => ({ registerLayer: (options: { onBack: () => void }) => {
    const layer = { ...options, close: vi.fn(), dispose: vi.fn() };
    dialogs.layers.push(layer);
    return layer;
  } }),
}));
const NavDialog = defineComponent({
  props: ['modelValue', 'items', 'activeKey'], emits: ['update:activeKey'],
  template: '<div v-if="modelValue"><nav><button v-for="item in items" :key="item.id" @click="$emit(\'update:activeKey\', item.id)">{{ item.label }}</button></nav><slot name="content" /></div>',
});
const contexts: UIPluginContext[] = [];
function seed(): CampusState {
  return { ...createEmptyCampusState(), places: [{ id: 'dorm', name: '宿舍', address: '' }, { id: 'class', name: '教学楼', address: '一号楼' }],
    events: [{ id: 'lesson', title: '算法课', startAt: '2026-10-27T00:30:00.000Z', endAt: '2026-10-27T02:00:00.000Z', placeId: 'class', status: 'scheduled' }] };
}
async function mounted(initial: CampusState = seed()) {
  let serverState = structuredClone(initial);
  let revision = 1;
  let generation = 'generation_1';
  let nextFailure: unknown;
  let failAfterCommit = false;
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    if (method === 'PUT') {
      if (nextFailure) { const failure = nextFailure; nextFailure = undefined; throw failure; }
      const input = body as { state: CampusState; expectedRevision: number; expectedLifecycleGeneration: string };
      expect(input.expectedRevision).toBe(revision);
      expect(input.expectedLifecycleGeneration).toBe(generation);
      serverState = structuredClone(input.state); revision++;
      if (failAfterCommit) { failAfterCommit = false; throw new Error('reply lost after commit'); }
    }
    return path.endsWith('/plan')
      ? { plan: calculateCampusPlan(serverState, '2026-10-27T00:00:00.000Z'), revision, lifecycleGeneration: generation }
      : { state: structuredClone(serverState), revision, lifecycleGeneration: generation };
  });
  const context = { navigation: { runMenuAction: (action: () => void) => action() } } as unknown as UIPluginContext;
  contexts.push(context);
  const global = { provide: { [UI_PLUGIN_CONTEXT_KEY as symbol]: context,
    [AERVOX_CLIENT as symbol]: createAervoxClient({ transport: { request } as unknown as AervoxTransport }) },
    stubs: { AervoxNavDialog: NavDialog } };
  const wrapper = mount(CampusDrawer, { attachTo: document.body, global });
  const store = useCampusStore(context);
  await store.reload(); store.open(); await flushPromises();
  return { wrapper, store, context, global, request, saved: () => serverState,
    external: (next: CampusState, nextGeneration = generation) => { serverState = structuredClone(next); revision++; generation = nextGeneration; },
    failNext: (failure: unknown) => { nextFailure = failure; }, unknownNext: () => { failAfterCommit = true; } };
}
function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find(item => item.text() === label);
  if (!found) throw new Error(`Missing button ${label}: ${wrapper.text()}`);
  return found;
}
async function view(wrapper: VueWrapper, label: string) { await button(wrapper, label).trigger('click'); await flushPromises(); }
enableAutoUnmount(afterEach);
beforeEach(() => { dialogs.layers.length = 0; dialogs.confirm.mockReset().mockResolvedValue('confirm'); });
afterEach(() => { contexts.splice(0).forEach(disposeCampusStore); document.body.innerHTML = ''; });

describe('campus manual management UI', () => {
  it('renders the empty state and route gap without invented data or a departure time', async () => {
    const { wrapper, store, global } = await mounted(createEmptyCampusState());
    expect(wrapper.text()).toContain('暂无待出发行程');
    expect(wrapper.text()).toContain('先添加地点');
    const card = mount(CampusCard, { global });
    expect(card.text()).toContain('暂无待出发行程');
    expect(store.state.value?.events).toHaveLength(0);
    card.unmount();
    const next = await mounted(seed());
    expect(next.wrapper.text()).toContain('需要补充路线');
    expect(next.wrapper.text()).toContain('请先设置当前出发地点');
    expect(next.store.plan.value?.departureAt).toBeNull();
  });

  it('adds, edits and deletes a location, while retaining referenced locations', async () => {
    const { wrapper, saved } = await mounted();
    await view(wrapper, '地点');
    await button(wrapper, '添加地点').trigger('click');
    await wrapper.get('.campus-editor input').setValue('图书馆');
    await wrapper.findAll('.campus-editor input')[1]!.setValue('二号门旁');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().places.at(-1)?.name).toBe('图书馆');
    const row = wrapper.findAll('.campus-list li').find(item => item.text().includes('图书馆'))!;
    await row.findAll('button')[0]!.trigger('click');
    await wrapper.get('.campus-editor input').setValue('新图书馆');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    const updated = wrapper.findAll('.campus-list li').find(item => item.text().includes('新图书馆'))!;
    await updated.findAll('button')[1]!.trigger('click'); await flushPromises();
    expect(saved().places).toHaveLength(2);
    const used = wrapper.findAll('.campus-list li').find(item => item.text().includes('教学楼'))!;
    expect(used.findAll('button')[1]!.attributes('disabled')).toBeDefined();
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
  });

  it('saves course, task, route and buffers, then marks arrived and cancelled', async () => {
    const { wrapper, saved, store } = await mounted();
    await view(wrapper, '课表与日程');
    await button(wrapper, '添加课程或日程').trigger('click');
    const fields = wrapper.findAll('.campus-editor input');
    await fields[0]!.setValue('数据库课'); await fields[1]!.setValue('2026-10-28T09:00'); await fields[2]!.setValue('2026-10-28T10:00');
    await wrapper.get('.campus-editor select').setValue('class');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events.at(-1)?.startAt).toBe('2026-10-28T01:00:00.000Z');
    await view(wrapper, '空档任务'); await button(wrapper, '添加任务').trigger('click');
    await wrapper.get('.campus-editor input').setValue('复习索引');
    await wrapper.findAll('.campus-editor input')[1]!.setValue(8);
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().tasks[0]?.estimatedMinutes).toBe(8);
    await view(wrapper, '路线耗时'); await button(wrapper, '添加路线').trigger('click');
    await wrapper.findAll('.campus-editor select')[0]!.setValue('dorm'); await wrapper.findAll('.campus-editor select')[1]!.setValue('class');
    await wrapper.get('.campus-editor input').setValue(10);
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().routes[0]?.source).toBe('manual');
    expect(saved().routes[0]?.durationSeconds).toBe(600);
    await view(wrapper, '出发设置');
    await wrapper.get('select').setValue('dorm'); await wrapper.findAll('input')[0]!.setValue(5);
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(saved().settings.originId).toBe('dorm');
    await view(wrapper, '出发计划'); await store.refreshPlan(); await flushPromises();
    expect(wrapper.text()).toContain('手工估算'); expect(wrapper.text()).toContain('08:15');
    await button(wrapper, '标记已到达').trigger('click'); await flushPromises();
    expect(saved().events[0]?.status).toBe('arrived');
    await view(wrapper, '课表与日程');
    const row = wrapper.findAll('.campus-list li').find(item => item.text().includes('数据库课'))!;
    await row.findAll('button').find(item => item.text() === '取消日程')!.trigger('click'); await flushPromises();
    expect(saved().events.at(-1)?.status).toBe('cancelled');
  });

  it('retains an edited draft through CAS conflict and rebases only after an explicit reload', async () => {
    const { wrapper, saved, request, external, failNext } = await mounted();
    await view(wrapper, '课表与日程');
    await button(wrapper, '编辑').trigger('click');
    await wrapper.get('.campus-editor input').setValue('我的算法课草稿');
    external({ ...seed(), tasks: [{ id: 'external', title: '其他页面的任务', estimatedMinutes: 5, priority: 'high', status: 'pending' }] }, 'generation_2');
    failNext(new AervoxHttpError(409, '/state', { code: 'PLUGIN_CONFIG_REVISION_CONFLICT' }));
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('草稿已保留');
    expect((wrapper.get('.campus-editor input').element as HTMLInputElement).value).toBe('我的算法课草稿');
    const writes = () => request.mock.calls.filter(call => call[0] === 'PUT').length;
    expect(writes()).toBe(1);
    expect(button(wrapper, '保存条目').attributes('disabled')).toBeDefined();
    await button(wrapper, '重新加载并保留草稿').trigger('click'); await flushPromises();
    expect((wrapper.get('.campus-editor input').element as HTMLInputElement).value).toBe('我的算法课草稿');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events[0]?.title).toBe('我的算法课草稿');
    expect(saved().tasks[0]?.id).toBe('external');
    expect(writes()).toBe(2);
  });

  it('preserves seconds and milliseconds when only an existing event title is edited', async () => {
    const event = { ...seed().events[0]!, startAt: '2026-10-27T00:30:45.123Z', endAt: '2026-10-27T02:00:15.456Z' };
    const { wrapper, saved } = await mounted({ ...seed(), events: [event] });
    await view(wrapper, '课表与日程'); await button(wrapper, '编辑').trigger('click');
    await wrapper.get('.campus-editor input').setValue('更新课程名称');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events[0]).toMatchObject({ title: '更新课程名称', startAt: event.startAt, endAt: event.endAt });

    await button(wrapper, '编辑').trigger('click');
    await wrapper.findAll('.campus-editor input')[1]!.setValue('2026-10-27T08:31');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events[0]).toMatchObject({ startAt: '2026-10-27T00:31:00.000Z', endAt: event.endAt });
  });

  it('preserves a known instant in a daylight-saving fold and validates a changed local time', async () => {
    const event = { ...seed().events[0]!, startAt: '2026-11-01T06:30:00.000Z', endAt: '2026-11-01T07:00:00.000Z' };
    const { wrapper, saved, request } = await mounted({ ...seed(), events: [event],
      settings: { ...seed().settings, timezone: 'America/New_York' } });
    await view(wrapper, '课表与日程'); await button(wrapper, '编辑').trigger('click');
    expect((wrapper.findAll('.campus-editor input')[1]!.element as HTMLInputElement).value).toBe('2026-11-01T01:30');
    await wrapper.get('.campus-editor input').setValue('回拨时段的课程');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events[0]).toMatchObject({ title: '回拨时段的课程', startAt: event.startAt, endAt: event.endAt });

    await button(wrapper, '编辑').trigger('click');
    await wrapper.findAll('.campus-editor input')[1]!.setValue('2026-11-01T01:45');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('夏令时歧义');
    expect(request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(1);
    expect(saved().events[0]?.startAt).toBe(event.startAt);
  });

  it('does not recreate an externally deleted edited record without a separate save-as-new action', async () => {
    const { wrapper, external, saved, request } = await mounted();
    await view(wrapper, '课表与日程'); await button(wrapper, '编辑').trigger('click');
    await wrapper.get('.campus-editor input').setValue('保留的课程草稿');
    external({ ...seed(), events: [] });
    await button(wrapper, '重新加载').trigger('click'); await flushPromises();
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('此条目已被删除');
    expect(request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
    await button(wrapper, '另存为新条目').trigger('click');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().events[0]?.id).not.toBe('lesson');
    expect(saved().events[0]?.title).toBe('保留的课程草稿');
  });

  it('retains the pending new identity when a commit succeeds but its reply is lost', async () => {
    const { wrapper, unknownNext, saved, request } = await mounted();
    await view(wrapper, '空档任务'); await button(wrapper, '添加任务').trigger('click');
    await wrapper.get('.campus-editor input').setValue('只保存一次的任务');
    unknownNext();
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(wrapper.text()).toContain('保存结果尚未确认');
    expect(saved().tasks).toHaveLength(1);
    const pendingId = saved().tasks[0]!.id;
    await button(wrapper, '重新加载并保留草稿').trigger('click'); await flushPromises();
    expect(wrapper.text()).toContain('重新加载发现此草稿已保存');
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    expect(saved().tasks).toHaveLength(1);
    expect(saved().tasks[0]!.id).toBe(pendingId);
    const writes = request.mock.calls.filter(call => call[0] === 'PUT');
    expect((writes[0]![2] as { state: CampusState }).state.tasks[0]!.id).toBe((writes[1]![2] as { state: CampusState }).state.tasks[0]!.id);
  });

  it('constructs a confirmed deletion from the latest snapshot instead of overwriting a concurrent reload', async () => {
    const { wrapper, store, external, saved } = await mounted({ ...seed(), places: [...seed().places, { id: 'library', name: '图书馆', address: '' }] });
    await view(wrapper, '地点');
    let confirm!: (value: string) => void;
    dialogs.confirm.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
    const row = wrapper.findAll('.campus-list li').find(item => item.text().includes('图书馆'))!;
    await row.findAll('button')[1]!.trigger('click');
    external({ ...saved(), tasks: [{ id: 'external', title: '并发新任务', estimatedMinutes: 5, priority: 'medium', status: 'pending' }] });
    await store.reload(); await flushPromises();
    confirm('confirm'); await flushPromises();
    expect(saved().places.map(item => item.id)).toEqual(['dorm', 'class']);
    expect(saved().tasks[0]?.title).toBe('并发新任务');
  });

  it('keeps a new record identity after an uncommitted uncertain failure and creates it once after reload', async () => {
    const { wrapper, failNext, saved, request } = await mounted();
    await view(wrapper, '地点'); await button(wrapper, '添加地点').trigger('click');
    await wrapper.get('.campus-editor input').setValue('操场');
    failNext(new Error('connection lost before send'));
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    await button(wrapper, '重新加载并保留草稿').trigger('click'); await flushPromises();
    await wrapper.get('.campus-editor form').trigger('submit'); await flushPromises();
    const writes = request.mock.calls.filter(call => call[0] === 'PUT');
    const firstId = (writes[0]![2] as { state: CampusState }).state.places.at(-1)!.id;
    expect(saved().places.at(-1)!.id).toBe(firstId);
    expect(saved().places.filter(item => item.name === '操场')).toHaveLength(1);
  });

  it('returns from an editor without losing its draft or issuing writes, and releases the layer on unmount', async () => {
    const { wrapper, request } = await mounted();
    await view(wrapper, '地点'); const add = button(wrapper, '添加地点');
    await add.trigger('click'); await flushPromises();
    const field = wrapper.get('.campus-editor input').element as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    await wrapper.get('.campus-editor input').setValue('未保存地点');
    const layer = dialogs.layers.at(-1)!; layer.onBack(); await flushPromises();
    expect(wrapper.find('.campus-editor').exists()).toBe(false);
    expect(request.mock.calls.filter(call => call[0] === 'PUT')).toHaveLength(0);
    await button(wrapper, '继续地点草稿').trigger('click'); await flushPromises();
    expect((wrapper.get('.campus-editor input').element as HTMLInputElement).value).toBe('未保存地点');
    const activeLayer = dialogs.layers.at(-1)!; wrapper.unmount();
    expect(activeLayer.dispose).toHaveBeenCalledTimes(1);
  });

  it('disabling a plugin removes cards, drawers and its shared store without touching other registrations', async () => {
    const { wrapper, store, context } = await mounted();
    const registry = createUIRegistry();
    registry.registerSlotComponent('companion:cards', defineComponent({ template: '<span>other</span>' }), { id: 'other' });
    const cleanup = flowCampusUIPlugin.setup(registry, context) as () => void;
    expect(registry.getSlotComponents('companion:cards')).toHaveLength(2);
    store.open('places'); await flushPromises();
    cleanup(); await flushPromises();
    expect(store.drawerOpen.value).toBe(false);
    expect(store.state.value).toBeNull();
    expect(wrapper.find('.campus-content').exists()).toBe(false);
    expect(registry.getSlotComponents('companion:cards').map(item => item.id)).toEqual(['other']);
    expect(registry.getSlotComponents('workbench:drawers')).toHaveLength(0);
    cleanup();
  });

  it('binds the mounted host client after asynchronous runtime activation outside Vue injection context', async () => {
    const context = { navigation: {} } as unknown as UIPluginContext;
    contexts.push(context);
    const registry = createUIRegistry();
    const cleanup = flowCampusUIPlugin.setup(registry, context) as () => void;
    const store = useCampusStore(context);
    expect(store.loading.value).toBe(false);
    expect(store.snapshot.value).toBeNull();
    const customState = { ...seed(), events: [{ ...seed().events[0]!, title: '自定义宿主课程' }] };
    const request = vi.fn(async (_method: string, path: string) => path.endsWith('/plan')
      ? { plan: calculateCampusPlan(customState, '2026-10-27T00:00:00.000Z'), revision: 7, lifecycleGeneration: 'custom_host' }
      : { state: customState, revision: 7, lifecycleGeneration: 'custom_host' });
    const card = mount(CampusCard, { global: { provide: {
      [UI_PLUGIN_CONTEXT_KEY as symbol]: context,
      [AERVOX_CLIENT as symbol]: createAervoxClient({ apiBase: 'https://custom.invalid', transport: { request } as unknown as AervoxTransport }),
    } } });
    await flushPromises();
    expect(request).toHaveBeenCalledTimes(2);
    expect(card.text()).toContain('自定义宿主课程');
    cleanup(); card.unmount();
  });

  it('does not let the old activation cleanup remove a newer instance sharing the same host context', () => {
    const context = { navigation: {} } as unknown as UIPluginContext;
    contexts.push(context);
    const registry = createUIRegistry();
    const oldCleanup = flowCampusUIPlugin.setup(registry, context) as () => void;
    const oldStore = useCampusStore(context);
    oldStore.dispose();
    const newCleanup = flowCampusUIPlugin.setup(registry, context) as () => void;
    const newStore = useCampusStore(context);
    expect(newStore).not.toBe(oldStore);
    oldCleanup();
    expect(useCampusStore(context)).toBe(newStore);
    expect(newStore.isDisposed()).toBe(false);
    expect(registry.getSlotComponents('companion:cards')).toHaveLength(1);
    newCleanup();
  });
});
