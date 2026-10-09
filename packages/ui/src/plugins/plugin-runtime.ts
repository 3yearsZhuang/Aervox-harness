import { ref } from 'vue';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchContext } from '../composables/workbench-context';

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

/**
 * 创建工作台插件运行时
 * 负责内置第一方 UI 插件的生命周期编排、插槽动态注册/卸载与零硬编码配置分发。
 *
 * @param registry UI 注册表实例
 * @param getContext 延迟获取 WorkbenchContext 的函数
 * @param pluginDefinitions 插件定义清单（由组合根显式注入；宿主内不内建任何具体插件）
 */
export function createWorkbenchPluginRuntime(
  registry: UIRegistry,
  getContext: () => WorkbenchContext,
  pluginDefinitions: BuiltinUIPlugin[] = [],
): WorkbenchPluginRuntime {

  const activeCleanups = new Map<string, () => void>();
  const availablePlugins = ref<Record<string, boolean>>({});
  let currentSyncSeq = 0;
  let destroyed = false;

  function deactivate(def: BuiltinUIPlugin): void {
    const cleanup = activeCleanups.get(def.id);
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`[PluginRuntime] Error cleaning up plugin "${def.id}":`, err);
      }
      activeCleanups.delete(def.id);
    }
    try {
      def.onDisable?.(getContext());
    } catch (err) {
      console.error(`[PluginRuntime] Error in onDisable for plugin "${def.id}":`, err);
    }
  }

  // CR-060：不预启动任何插件。插件是否生效统一由 `sync()` 依据仓储启停记录判定
  // （fail-closed：无记录即不启用），避免"离线/无网络时默认可用"与宿主列表不一致。
  for (const plugin of pluginDefinitions) {
    availablePlugins.value[plugin.id] = false;
  }

  async function sync(
    plugins: Array<{ id: string; enabled?: number }>,
    getConfig: (pluginId: string) => Promise<{ values?: Record<string, unknown> } | null>,
  ): Promise<void> {
    if (destroyed) return;
    const syncSeq = ++currentSyncSeq;
    const context = getContext();

    await Promise.all(
      pluginDefinitions.map(async (def) => {
        // CR-060：不保留历史别名映射，只按主 id 匹配
        const match = plugins.find((p) => p.id === def.id);
        // fail-closed：仓储无记录、记录为停用或不可用，一律不启用（与服务端门控一致）
        const isEnabled = Boolean(match) && match!.enabled !== 0;

        availablePlugins.value[def.id] = isEnabled;

        if (!isEnabled) {
          deactivate(def);
        } else {
          // 插件启用：若此前未激活或已被注销，则重新激活
          if (!activeCleanups.has(def.id)) {
            try {
              const unregister = def.setup(registry, context);
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
              // CR-060：只按主 id 拉配置，不保留历史配置键回退
              const snapshot = await getConfig(def.id);
              // 并发防竞态校验：仅当本轮 sync 为最新且该插件当前仍处于启用状态时才生效
              if (syncSeq === currentSyncSeq && availablePlugins.value[def.id] && snapshot?.values) {
                await def.onConfig(snapshot.values, context);
              }
            } catch {
              // 忽略非致命配置拉取异常
            }
          }
        }
      }),
    );
  }

  /**
   * CR-060：可用性判定 fail-closed —— 无记录即不可用，且不保留历史别名互查。
   * 与服务端 Runner 的启用门控保持同一判据（两端不得再次不对称）。
   */
  function isPluginAvailable(pluginId: string): boolean {
    return availablePlugins.value[pluginId] ?? false;
  }

  function destroy(): void {
    destroyed = true;
    currentSyncSeq++;
    availablePlugins.value = {};
    for (const cleanup of activeCleanups.values()) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    activeCleanups.clear();
  }

  return {
    sync,
    isPluginAvailable,
    destroy,
  };
}
