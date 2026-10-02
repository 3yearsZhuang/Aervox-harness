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
import { ref, watch, type Component } from 'vue';
import { BookOpen, Puzzle } from 'lucide-vue-next';
import type { WorkbenchContext } from '@aervox/ui/plugin-api';

/** 插件 id（与 Manifest / 服务端注册单元一致；仅本插件内部使用） */
export const PLUGIN_ID = 'focus-mode';

/** 专注模式开关（持久化于宿主插件状态命名空间） */
export const focusModeEnabled = ref(false);

/** 学习抽屉状态（插件自有视图，不再占用宿主 ToolId） */
export const learningOpen = ref(false);
export const activeLearningView = ref<'study' | 'mistake'>('study');

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

let initializedFor: WorkbenchContext | null = null;

/**
 * 初始化插件状态：把持久化状态接到模块级响应式变量，并登记启动期静默诉求。
 *
 * 由插件 `setup()` 调用；对同一上下文幂等，换上下文（测试或宿主重建）时重新绑定。
 */
export function initFocusModeState(context: WorkbenchContext): void {
  if (initializedFor === context) return;
  initializedFor = context;
  // 宿主未提供状态容器（自定义嵌入/测试替身）时降级为纯内存态
  if (!context?.pluginState || !context.layout) return;

  const persisted = context.pluginState.useBoolean(PLUGIN_ID, 'enabled', false, { persist: true });
  focusModeEnabled.value = persisted.value;
  watch(persisted, (value) => {
    focusModeEnabled.value = value;
  });
  watch(focusModeEnabled, (value) => {
    persisted.value = value;
    // 专注模式下请求宿主启动期静默（不弹打扰面板），经通用接缝表达
    context.layout.setQuietStartup?.(value);
  });
  context.layout.setQuietStartup?.(persisted.value);
}

/** 设置专注模式开关 */
export function setFocusModeEnabled(enabled: boolean): void {
  if (focusModeEnabled.value === enabled) return;
  focusModeEnabled.value = enabled;
}

/** 切换专注模式 */
export function toggleFocusMode(): void {
  setFocusModeEnabled(!focusModeEnabled.value);
}

/** 打开插件自有学习视图（study | mistake） */
export function openLearningView(view: 'study' | 'mistake'): void {
  activeLearningView.value = view;
  learningOpen.value = true;
}
