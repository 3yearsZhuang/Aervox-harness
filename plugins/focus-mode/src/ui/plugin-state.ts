/**
 * Aervox｜思隅 plugins/focus-mode（UI 侧） — 插件自有视图状态
 *
 * CR-060：宿主不再为插件在通用组合式函数里保留字段（`focusModeEnabled`、
 * `learningOpen`、`activeLearningView`、`learningNavItems` 等）。这些状态全部归插件：
 * - 开关持久化经宿主 `pluginState` 的**命名空间化**存储（宿主不解释键与取值）；
 * - 抽屉状态与导航清单由插件自持，宿主只按 `workbench:drawers` 槽位渲染。
 *
 * 本文件位于插件自有目录，S6 将随插件 UI 一并迁至 `plugins/focus-mode/src/ui/`。
 */
import { effectScope, ref, watch, type Component } from 'vue';
import { BookOpen, Puzzle } from 'lucide-vue-next';
import { useUIPluginContext, type UIPluginContext } from '@aervox/ui/plugin-api';

/** 插件 id（与 Manifest / 服务端注册单元一致；仅本插件内部使用） */
export const PLUGIN_ID = 'focus-mode';

/** 学习抽屉导航清单（插件自有视图入口） */
export const learningNavItems: Array<{
  id: 'study' | 'mistake';
  label: string;
  description: string;
  icon: Component;
}> = [
  { id: 'study', label: '学习规划', description: 'AI 生成学习路线图', icon: BookOpen },
  { id: 'mistake', label: '错题本', description: '针对性重练未掌握题', icon: Puzzle },
];



/**
 * CR-060 前的宿主设置键：专注模式开关曾长在通用 `layout.focusModeEnabled` 上并持久化于
 * `aervox-settings`。宿主侧回退逻辑已按 CR-060 §2 删除，故**迁移归插件自己**——
 * 宿主不感知插件 id 与键语义，而插件负责让存量用户的开关不静默丢失。
 */
const LEGACY_HOST_SETTINGS_KEY = 'aervox-settings';
const LEGACY_ENABLED_KEYS = ['focusModeEnabled', 'studyModeEnabled'] as const;

/** 读取存量宿主设置中的开关初值；无存量或不可读时返回 undefined */
function readLegacyHostEnabled(): boolean | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(LEGACY_HOST_SETTINGS_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    for (const key of LEGACY_ENABLED_KEYS) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'boolean') return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const instances = new WeakMap<UIPluginContext, ReturnType<typeof createFocusModeState>>();

export function useFocusModeState(context: UIPluginContext = useUIPluginContext()) {
  let state = instances.get(context);
  if (!state) { state = createFocusModeState(context); instances.set(context, state); }
  state.connect();
  return state;
}

export function disposeFocusModeState(context: UIPluginContext): void {
  instances.get(context)?.dispose();
  instances.delete(context);
}

function createFocusModeState(context: UIPluginContext) {
/** 专注模式开关（持久化于宿主插件状态命名空间） */
const focusModeEnabled = ref(false);

/** 学习抽屉状态（插件自有视图，不再占用宿主 ToolId） */
const learningOpen = ref(false);
const activeLearningView = ref<'study' | 'mistake'>('study');


  const scope = effectScope(true);
  let connected = false;
  let disposed = false;
  let releasePreset: (() => void) | undefined;
  function connect() {
    if (connected || disposed || !context?.pluginState || !context.navigation) return;
    connected = true;
    if (context.pluginState.read<boolean | undefined>(PLUGIN_ID, 'enabled', undefined) === undefined) {
      const legacy = readLegacyHostEnabled();
      if (legacy !== undefined) context.pluginState.write(PLUGIN_ID, 'enabled', legacy);
    }
    const persisted = context.pluginState.useBoolean(PLUGIN_ID, 'enabled', false, { persist: true });
    focusModeEnabled.value = persisted.value;
    scope.run(() => {
      watch(persisted, value => { focusModeEnabled.value = value; }, { flush: 'sync' });
      watch(focusModeEnabled, value => {
        persisted.value = value;
        applySurfaces(value);
      }, { flush: 'sync' });
    });
    applySurfaces(persisted.value);
  }
  function applySurfaces(enabled: boolean) {
    context.navigation?.setQuietStartup?.(enabled);
    if (enabled && !releasePreset) releasePreset = context.cards?.acquireSlotPreset?.(PLUGIN_ID, FOCUS_CARD_PRESET);
    if (!enabled) { releasePreset?.(); releasePreset = undefined; }
  }
  function setFocusModeEnabled(enabled: boolean) { if (!disposed) focusModeEnabled.value = enabled; }
  function toggleFocusMode() { setFocusModeEnabled(!focusModeEnabled.value); }
  function openLearningView(view: 'study' | 'mistake') {
    if (disposed) return;
    activeLearningView.value = view;
    learningOpen.value = true;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    scope.stop();
    learningOpen.value = false;
    // 释放本实例的表现诉求，保留用户持久化开关。
    applySurfaces(false);
  }
  return { focusModeEnabled, learningOpen, activeLearningView, setFocusModeEnabled, toggleFocusMode, openLearningView, connect, dispose };
}

/**
 * 专注模式下的侧栏槽位预设。
 * `study` 是本插件贡献的卡片，`timer` 是宿主内建卡片——槽位词汇由双方共享，
 * 但**预设清单由插件自述**，宿主不硬编码任何插件卡片 id（CR-060）。
 */
const FOCUS_CARD_PRESET: Array<string | null> = ['study', 'timer'];
