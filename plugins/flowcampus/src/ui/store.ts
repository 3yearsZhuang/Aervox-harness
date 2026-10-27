import { computed, hasInjectionContext, ref, shallowRef } from 'vue';
import { AervoxHttpError } from '@aervox/api-client';
import { useUIPluginContext, type UIPluginContext, type UIPluginLifecycle } from '@aervox/ui/plugin-api';
import { campusStateSchema, type CampusState, type CampusStateSnapshot, type CampusPlan } from '../domain/index.js';
import { createCampusClient, type CampusClient } from './api.js';

export type CampusView = 'today' | 'events' | 'places' | 'tasks' | 'routes' | 'settings';
const instances = new WeakMap<UIPluginContext, CampusUIStore>();

export function useCampusStore(context: UIPluginContext = useUIPluginContext(), lifecycle?: UIPluginLifecycle): CampusUIStore {
  let store = instances.get(context);
  if (!store || store.isDisposed()) {
    store = createCampusUIStore(undefined, lifecycle?.signal);
    instances.set(context, store);
    const owner = store;
    lifecycle?.onDispose(() => releaseCampusStore(context, owner));
  }
  // Runtime activation may resume after an await without Vue's injection context.
  // The first mounted contribution captures its actual host client before any I/O.
  if (hasInjectionContext()) store.connect(createCampusClient());
  return store;
}
export function disposeCampusStore(context: UIPluginContext): void { releaseCampusStore(context, instances.get(context)); }
export function releaseCampusStore(context: UIPluginContext, owner: CampusUIStore | undefined): void {
  owner?.dispose();
  if (instances.get(context) === owner) instances.delete(context);
}

function errorMessage(error: unknown): string {
  if (error instanceof AervoxHttpError && ['PLUGIN_DISABLED', 'PLUGIN_UNAVAILABLE'].includes(error.code ?? '')) {
    return '只争朝夕暂不可用，请在插件设置中核对启用状态。当前草稿已保留。';
  }
  return '暂时无法连接，只争朝夕的数据未被覆盖。请重新加载确认结果。';
}

/** One plugin activation owns requests and transient UI. Durable data stays in the host. */
export function createCampusUIStore(api: CampusClient | undefined, parentSignal?: AbortSignal) {
  const snapshot = shallowRef<CampusStateSnapshot | null>(null);
  const plan = shallowRef<CampusPlan | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const planning = ref(false);
  const exporting = ref(false);
  const conflict = ref(false);
  const error = ref('');
  const planError = ref('');
  const feedback = ref('');
  const drawerOpen = ref(false);
  const activeView = ref<CampusView>('today');
  const controller = new AbortController();
  let disposed = false;
  let loadSequence = 0;
  let planSequence = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;
  const state = computed(() => snapshot.value?.state ?? null);
  const writable = computed(() => Boolean(snapshot.value) && !loading.value && !saving.value && !conflict.value && !disposed);

  async function refreshPlan(): Promise<void> {
    if (disposed || !api || !snapshot.value || saving.value || loading.value) return;
    const sequence = ++planSequence;
    planning.value = true;
    planError.value = '';
    const current = snapshot.value;
    try {
      const result = await api.plan(controller.signal);
      if (disposed || sequence !== planSequence) return;
      if (result.revision !== current.revision || result.lifecycleGeneration !== current.lifecycleGeneration) {
        plan.value = null;
        conflict.value = true;
        error.value = '数据已在其他页面更新，当前草稿已保留。请重新加载后再保存。';
        return;
      }
      plan.value = result.plan;
    } catch (cause) {
      if (!disposed && sequence === planSequence) {
        plan.value = null;
        planError.value = errorMessage(cause);
      }
    } finally { if (!disposed && sequence === planSequence) planning.value = false; }
  }

  async function reload(): Promise<boolean> {
    if (disposed || !api || saving.value || loading.value) return false;
    const sequence = ++loadSequence;
    ++planSequence;
    loading.value = true;
    planning.value = false;
    plan.value = null;
    error.value = ''; feedback.value = '';
    try {
      const result = await api.load(controller.signal);
      if (disposed || sequence !== loadSequence) return false;
      snapshot.value = result;
      conflict.value = false;
      feedback.value = '已读取最新数据，未提交的表单草稿仍保留。';
      return true;
    } catch (cause) {
      if (!disposed && sequence === loadSequence) error.value = errorMessage(cause);
      return false;
    } finally {
      if (!disposed && sequence === loadSequence) {
        loading.value = false;
        if (!error.value) void refreshPlan();
      }
    }
  }

  async function save(next: CampusState): Promise<boolean> {
    if (!writable.value || !api || !snapshot.value) return false;
    const parsed = campusStateSchema.safeParse(next);
    if (!parsed.success) { error.value = '请核对时间、地点引用和分钟数，当前表单草稿已保留。'; return false; }
    const current = snapshot.value;
    saving.value = true;
    ++planSequence;
    planning.value = false;
    plan.value = null;
    error.value = ''; feedback.value = '';
    try {
      const result = await api.save(parsed.data, current, controller.signal);
      if (disposed) return false;
      snapshot.value = result;
      feedback.value = '已保存。';
      return true;
    } catch (cause) {
      if (disposed) return false;
      // A write is never retried automatically, including unknown network outcomes.
      conflict.value = true;
      error.value = cause instanceof AervoxHttpError && cause.status === 409
        ? '数据版本或插件状态已变化，当前草稿已保留。请重新加载后再保存。'
        : '保存结果尚未确认，当前草稿已保留。请重新加载核对，避免重复写入。';
      return false;
    } finally {
      if (!disposed) {
        saving.value = false;
        if (!conflict.value) void refreshPlan();
      }
    }
  }

  function open(view: CampusView = 'today'): void {
    if (disposed) return;
    activeView.value = view;
    drawerOpen.value = true;
    if (!snapshot.value && !loading.value) void reload();
    else if (view === 'today') void refreshPlan();
  }
  async function readForExport(): Promise<CampusStateSnapshot | null> {
    if (disposed || !api || exporting.value) return null;
    exporting.value = true;
    try {
      const result = await api.load(controller.signal);
      return disposed ? null : result;
    } catch {
      if (!disposed) error.value = '校园数据导出失败，请重新连接后再试。当前草稿已保留。';
      return null;
    } finally { if (!disposed) exporting.value = false; }
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    controller.abort();
    parentSignal?.removeEventListener('abort', dispose);
    if (refreshTimer) clearInterval(refreshTimer);
    ++loadSequence; ++planSequence;
    drawerOpen.value = false;
    snapshot.value = null;
    plan.value = null;
    loading.value = false; saving.value = false; planning.value = false; exporting.value = false;
    error.value = ''; planError.value = ''; feedback.value = '';
  }
  parentSignal?.addEventListener('abort', dispose, { once: true });
  if (parentSignal?.aborted) dispose();

  function start(): void {
    if (disposed || refreshTimer) return;
    started = true;
    void reload();
    refreshTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refreshPlan();
    }, 60_000);
  }
  function connect(client: CampusClient): void {
    if (disposed || api) return;
    api = client;
    if (started && !snapshot.value && !loading.value) void reload();
  }
  return { snapshot, state, plan, loading, saving, planning, exporting, readForExport, writable, conflict, error, planError, feedback,
    drawerOpen, activeView, open, reload, refreshPlan, save, start, connect, dispose, isDisposed: () => disposed };
}
export type CampusUIStore = ReturnType<typeof createCampusUIStore>;
