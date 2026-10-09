/**
 * Aervox｜思隅 @aervox/ui — 插件命名空间化状态（CR-060）
 *
 * 宿主不再为任何插件在通用组合式函数里预留状态字段。
 * 插件经本接口读写**自己命名空间下**的状态：宿主只提供存储与响应式容器，
 * 不解释键的含义，也不感知取值语义。
 *
 * 持久化落在宿主存储的独立命名空间 `aervox-plugin-state:<pluginId>`，
 * 与宿主自身的设置键（`aervox-settings`、`aervox-side-cards` 等）互不干扰。
 */
import { effectScope, ref, watch, type Ref } from 'vue';

const STORAGE_PREFIX = 'aervox-plugin-state:';

/** 插件状态容器 */
export interface PluginStateStore {
  /**
   * 读取（或惰性创建）插件的响应式布尔状态。
   * 同一 `pluginId + key` 复用同一 Ref，多次调用不会产生分叉状态。
   */
  useBoolean(
    pluginId: string,
    key: string,
    defaultValue: boolean,
    options?: { persist?: boolean },
  ): Ref<boolean>;
  /** 读取任意 JSON 值（无响应性，用于非渲染用途的配置快照） */
  read<T>(pluginId: string, key: string, fallback: T): T;
  /** 写入任意 JSON 值 */
  write(pluginId: string, key: string, value: unknown): void;
  /** 清空某插件的全部持久化状态（插件卸载时由宿主调用） */
  clear(pluginId: string): void;
  /** 释放本工作台的持久化监听，保留存储。 */
  dispose(): void;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readNamespace(pluginId: string): Record<string, unknown> {
  const storage = safeStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${pluginId}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeNamespace(pluginId: string, values: Record<string, unknown>): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(`${STORAGE_PREFIX}${pluginId}`, JSON.stringify(values));
  } catch {
    // 存储不可用（隐私模式/配额）时仅保留内存态
  }
}

/** 创建插件状态容器 */
export function createPluginStateStore(): PluginStateStore {
  const booleans = new Map<string, Ref<boolean>>();
  /** 已挂持久化 watcher 的缓存键，避免二次调用声明 persist 时静默不落盘 */
  const persistedKeys = new Map<string, () => void>();
  const scope = effectScope(true);
  let disposed = false;

  function persist(pluginId: string, key: string, value: unknown): void {
    const namespace = readNamespace(pluginId);
    namespace[key] = value;
    writeNamespace(pluginId, namespace);
  }

  return {
    useBoolean(pluginId: string, key: string, defaultValue: boolean, options?: { persist?: boolean }) {
      if (disposed) throw new Error('plugin_state_disposed');
      const cacheKey = `${pluginId}\u0000${key}`;
      let state = booleans.get(cacheKey);
      if (!state) {
        const namespace = readNamespace(pluginId);
        const stored = namespace[key];
        state = ref(typeof stored === 'boolean' ? stored : defaultValue);
        booleans.set(cacheKey, state);
      }

      // `persist` 可能在后一次调用才声明：只要声明过就补挂 watcher，不得静默忽略
      if (options?.persist && !persistedKeys.has(cacheKey)) {
        persistedKeys.set(cacheKey, scope.run(() => watch(state!, (value) => persist(pluginId, key, value), { flush: 'sync' }))!);
      }
      return state;
    },
    read<T>(pluginId: string, key: string, fallback: T): T {
      const namespace = readNamespace(pluginId);
      return key in namespace ? (namespace[key] as T) : fallback;
    },
    write(pluginId: string, key: string, value: unknown) {
      if (disposed) return;
      persist(pluginId, key, value);
      const state = booleans.get(`${pluginId}\u0000${key}`);
      if (state && typeof value === 'boolean') state.value = value;
    },
    dispose() {
      disposed = true;
      scope.stop();
      persistedKeys.clear();
      booleans.clear();
    },
    clear(pluginId: string) {
      // 只清该插件的缓存与存储，不得波及其它插件已持有的 Ref
      const prefix = `${pluginId}\u0000`;
      for (const cacheKey of [...booleans.keys()]) {
        if (cacheKey.startsWith(prefix)) {
          booleans.delete(cacheKey);
          persistedKeys.get(cacheKey)?.();
          persistedKeys.delete(cacheKey);
        }
      }
      const storage = safeStorage();
      try {
        storage?.removeItem(`${STORAGE_PREFIX}${pluginId}`);
      } catch {
        // ignore
      }
    },
  };
}
