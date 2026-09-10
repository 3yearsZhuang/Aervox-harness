import { ref } from 'vue';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchContext } from '../composables/workbench-context';
import { focusModePluginDefinition } from './focus-mode';
import { studyModePluginDefinition } from './study-mode';

export interface BuiltinUIPlugin {
  id: string;
  setup: (registry: UIRegistry, context?: WorkbenchContext) => (() => void) | void;
  onConfig?: (values: Record<string, unknown>, context: WorkbenchContext) => void | Promise<void>;
  onDisable?: (context: WorkbenchContext) => void;
}

export interface WorkbenchPluginRuntime {
  sync(
    plugins: Array<{ id: string; enabled?: number }>,
    getConfig: (pluginId: string) => Promise<{ values?: Record<string, unknown> } | null>,
  ): Promise<void>;
  isPluginAvailable(pluginId: string): boolean;
  destroy(): void;
}

export const defaultBuiltinPlugins: BuiltinUIPlugin[] = [
  focusModePluginDefinition,
];

/**
 * 创建工作台插件运行时
 * 负责内置第一方 UI 插件的生命周期编排、插槽动态注册/卸载与零硬编码配置分发。
 *
 * @param registry UI 注册表实例
 * @param getContext 延迟获取 WorkbenchContext 的函数
 * @param customPlugins 插件定义清单
 */
export function createWorkbenchPluginRuntime(
  registry: UIRegistry,
  getContext: () => WorkbenchContext,
  customPlugins: BuiltinUIPlugin[] = defaultBuiltinPlugins,
): WorkbenchPluginRuntime {

  const activePlugins = new Set<string>();
  const activeCleanups = new Map<string, () => void>();
  const availablePlugins = ref<Record<string, boolean>>({});
  let currentSyncSeq = 0;

  // 默认启动所有内置插件（若离线/无网络环境下保持默认可用体验）
  for (const plugin of customPlugins) {
    try {
      const unregister = plugin.setup(registry, getContext());
      activePlugins.add(plugin.id);
      if (typeof unregister === 'function') {
        activeCleanups.set(plugin.id, unregister);
      }
      availablePlugins.value[plugin.id] = true;
    } catch (err) {
      console.error(`[PluginRuntime] Failed to setup plugin "${plugin.id}":`, err);
    }
  }

  async function sync(
    plugins: Array<{ id: string; enabled?: number }>,
    getConfig: (pluginId: string) => Promise<{ values?: Record<string, unknown> } | null>,
  ): Promise<void> {
    const syncSeq = ++currentSyncSeq;
    const context = getContext();

    for (const def of customPlugins) {
      const match = plugins.find(
        (p) => p.id === def.id || (def.id === 'focus-mode' && p.id === 'study-mode') || (def.id === 'study-mode' && p.id === 'focus-mode'),
      );
      const isEnabled = match ? match.enabled !== 0 : true;

      availablePlugins.value[def.id] = isEnabled;
      if (def.id === 'focus-mode') availablePlugins.value['study-mode'] = isEnabled;
      if (def.id === 'study-mode') availablePlugins.value['focus-mode'] = isEnabled;

      if (!isEnabled) {
        // 插件停用：注销其注册的所有插槽及拦截器
        activePlugins.delete(def.id);
        const cleanup = activeCleanups.get(def.id);
        if (cleanup) {
          try {
            cleanup();
          } catch (err) {
            console.error(`[PluginRuntime] Error cleaning up plugin "${def.id}":`, err);
          }
          activeCleanups.delete(def.id);
        }
        // 触发停用钩子
        try {
          def.onDisable?.(context);
        } catch (err) {
          console.error(`[PluginRuntime] Error in onDisable for plugin "${def.id}":`, err);
        }
      } else {
        // 插件启用：若此前未激活或已被注销，则重新激活
        if (!activePlugins.has(def.id)) {
          try {
            const unregister = def.setup(registry, context);
            activePlugins.add(def.id);
            if (typeof unregister === 'function') {
              activeCleanups.set(def.id, unregister);
            }
          } catch (err) {
            console.error(`[PluginRuntime] Error re-activating plugin "${def.id}":`, err);
          }
        }

        // 通用拉取配置并分发给插件自身处理（宿主零硬编码感知具体字段）
        if (def.onConfig) {
          try {
            let snapshot = await getConfig(def.id);
            if (!snapshot?.values && def.id === 'focus-mode') {
              snapshot = await getConfig('study-mode');
            }
            // 并发防竞态校验：仅当本轮 sync 为最新且该插件当前仍处于启用状态时才生效
            if (syncSeq === currentSyncSeq && availablePlugins.value[def.id] && snapshot?.values) {
              await def.onConfig(snapshot.values, context);
            }
          } catch {
            // 忽略非致命配置拉取异常
          }
        }
      }
    }
  }

  function isPluginAvailable(pluginId: string): boolean {
    if (pluginId === 'study-mode' && availablePlugins.value['focus-mode'] !== undefined) {
      return availablePlugins.value['focus-mode'];
    }
    if (pluginId === 'focus-mode' && availablePlugins.value['study-mode'] !== undefined) {
      return availablePlugins.value['study-mode'];
    }
    return availablePlugins.value[pluginId] ?? true;
  }

  function destroy(): void {
    currentSyncSeq++;
    for (const cleanup of activeCleanups.values()) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    activeCleanups.clear();
    activePlugins.clear();
  }

  return {
    sync,
    isPluginAvailable,
    destroy,
  };
}
