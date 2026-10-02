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
import { ref, watch, type Ref } from 'vue';

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

  function persist(pluginId: string, key: string, value: unknown): void {
    const namespace = readNamespace(pluginId);
    namespace[key] = value;
    writeNamespace(pluginId, namespace);
  }

  return {
    useBoolean(pluginId: string, key: string, defaultValue: boolean, options?: { persist?: boolean }) {
      const cacheKey = `${pluginId}\u0000${key}`;
      const cached = booleans.get(cacheKey);
      if (cached) return cached;

      const namespace = readNamespace(pluginId);
      const stored = namespace[key];
      const state = ref(typeof stored === 'boolean' ? stored : defaultValue);
      booleans.set(cacheKey, state);

      if (options?.persist) {
        watch(state, (value) => persist(pluginId, key, value));
      }
      return state;
    },
    read<T>(pluginId: string, key: string, fallback: T): T {
      const namespace = readNamespace(pluginId);
      return key in namespace ? (namespace[key] as T) : fallback;
    },
    write(pluginId: string, key: string, value: unknown) {
      persist(pluginId, key, value);
    },
    clear(pluginId: string) {
      booleans.clear();
      const storage = safeStorage();
      try {
        storage?.removeItem(`${STORAGE_PREFIX}${pluginId}`);
      } catch {
        // ignore
      }
    },
  };
}
