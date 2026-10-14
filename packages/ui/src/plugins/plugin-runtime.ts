import { shallowReactive } from 'vue';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchContext } from '../composables/workbench-context';
import { createUIPluginScope, type UIPluginLifecycle } from './plugin-scope';

export type { UIPluginLifecycle } from './plugin-scope';

export interface BuiltinUIPlugin {
  id: string;
  setup: (registry: UIRegistry, context?: WorkbenchContext, lifecycle?: UIPluginLifecycle) => (() => void) | void;
  onConfig?: (values: Record<string, unknown>, context: WorkbenchContext, lifecycle?: UIPluginLifecycle) => void | Promise<void>;
  onDisable?: (context: WorkbenchContext) => void;
}

export interface UIPluginState {
  status: 'disabled' | 'activating' | 'active' | 'failed' | 'disposed';
  error?: unknown;
}

export interface WorkbenchPluginRuntime {
  sync(
    plugins: Array<{ id: string; enabled?: number; availability?: string }>,
    getConfig: (pluginId: string) => Promise<{ values?: Record<string, unknown> } | null>,
  ): Promise<void>;
  isPluginAvailable(pluginId: string): boolean;
  getPluginState(pluginId: string): Readonly<UIPluginState>;
  destroy(): void;
}

/** 编排组合根注入的受信插件；每次激活独占注册、Vue effect 与取消作用域。 */
export function createWorkbenchPluginRuntime(
  registry: UIRegistry,
  getContext: () => WorkbenchContext,
  pluginDefinitions: BuiltinUIPlugin[] = [],
): WorkbenchPluginRuntime {
  const ids = new Set<string>();
  for (const def of pluginDefinitions) {
    if (!def.id || ids.has(def.id)) throw new Error(`Duplicate or empty UI plugin id: ${def.id}`);
    ids.add(def.id);
  }

  type Instance = { scope: ReturnType<typeof createUIPluginScope>; context: WorkbenchContext };
  const instances = new Map<string, Instance>();
  const states = shallowReactive<Record<string, UIPluginState>>(Object.create(null));
  let currentSyncSeq = 0;
  let destroyed = false;
  for (const def of pluginDefinitions) states[def.id] = { status: 'disabled' };

  function disposeInstance(def: BuiltinUIPlugin): void {
    const instance = instances.get(def.id);
    if (!instance) return;
    instances.delete(def.id);
    try { instance.scope.dispose(); }
    catch (error) { console.error(`[PluginRuntime] Error cleaning up plugin "${def.id}":`, error); }
  }

  function deactivate(def: BuiltinUIPlugin): void {
    const previous = states[def.id]?.status;
    const context = instances.get(def.id)?.context;
    states[def.id] = { status: destroyed ? 'disposed' : 'disabled' };
    disposeInstance(def);
    // 只在状态转换时通知，避免每次列表刷新都执行停用副作用。
    if (previous !== 'disabled' && previous !== 'disposed') {
      try { def.onDisable?.(context ?? getContext()); }
      catch (error) { console.error(`[PluginRuntime] Error in onDisable for plugin "${def.id}":`, error); }
    }
  }

  function activate(def: BuiltinUIPlugin): Instance | undefined {
    const scope = createUIPluginScope(registry);
    // 保留上下文对象身份：Hook 与 Vue 控件经同一对象索引插件自有状态。
    // 注册使用 setup 的 scoped registry 参数，外部订阅经 lifecycle 登记。
    const context = getContext();
    const instance = { scope, context };
    instances.set(def.id, instance);
    states[def.id] = { status: 'activating' };
    try {
      const cleanup = scope.run(() => def.setup(scope.registry, context, scope.lifecycle));
      if (typeof cleanup === 'function') scope.lifecycle.onDispose(cleanup);
      else if (cleanup != null) throw new TypeError('UI plugin setup must return a synchronous disposer or void');
      if (destroyed || instances.get(def.id) !== instance) return undefined;
      states[def.id] = { status: 'active' };
      return instance;
    } catch (error) {
      if (instances.get(def.id) === instance) {
        states[def.id] = { status: destroyed ? 'disposed' : 'failed', error };
        // 清理可重入激活；先记录旧实例失败，避免覆盖清理期间成功重试的新状态。
        disposeInstance(def);
      } else {
        // setup 可重入停用/重启；旧实例失败不得回收或覆盖新实例。
        try { scope.dispose(); }
        catch (cleanupError) { console.error(`[PluginRuntime] Error cleaning up plugin "${def.id}":`, cleanupError); }
      }
      console.error(`[PluginRuntime] Error activating plugin "${def.id}":`, error);
      return undefined;
    }
  }

  async function sync(
    plugins: Array<{ id: string; enabled?: number; availability?: string }>,
    getConfig: (pluginId: string) => Promise<{ values?: Record<string, unknown> } | null>,
  ): Promise<void> {
    if (destroyed) return;
    const seq = ++currentSyncSeq;
    await Promise.all(pluginDefinitions.map(async (def) => {
      if (destroyed || seq !== currentSyncSeq) return;
      const record = plugins.find((plugin) => plugin.id === def.id);
      const enabled = record?.enabled === 1 && (record.availability ?? 'available') === 'available';
      if (!enabled) { deactivate(def); return; }
      const instance = instances.get(def.id) ?? activate(def);
      if (!instance || !def.onConfig) return;
      try {
        const config = await getConfig(def.id);
        if (seq !== currentSyncSeq || destroyed || instances.get(def.id) !== instance || !config?.values) return;
        await instance.scope.run(() => def.onConfig!(config.values!, instance.context, instance.scope.lifecycle));
      } catch (error) {
        // 配置读取失败保留当前实例；回调失败可观测。
        console.error(`[PluginRuntime] Error configuring plugin "${def.id}":`, error);
      }
    }));
  }

  function getPluginState(pluginId: string): Readonly<UIPluginState> {
    return { ...(states[pluginId] ?? { status: destroyed ? 'disposed' : 'disabled' }) };
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    currentSyncSeq++;
    // 关闭工作台只结束实例，不把用户保存的模式偏好当作显式停用清除。
    for (const def of pluginDefinitions) {
      states[def.id] = { status: 'disposed' };
      disposeInstance(def);
    }
  }

  return {
    sync,
    isPluginAvailable: (id) => states[id]?.status === 'active',
    getPluginState,
    destroy,
  };
}
