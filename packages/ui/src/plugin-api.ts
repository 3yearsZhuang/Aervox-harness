/**
 * Aervox｜思隅 @aervox/ui — 插件作者公共 API（CR-060）
 *
 * 第一方插件实现（`plugins/<id>/src/ui`）不得深链宿主包内部路径，
 * 只能经本出口取得通用接缝：工作台上下文、插件状态与事件总线、UI 注册表与插件运行时契约。
 *
 * 这里只导出**通用**契约——不含任何具体插件的字段、组件或配置键。
 */
export {
  WORKBENCH_CONTEXT_KEY,
  provideWorkbenchContext,
  useWorkbenchContext,
} from './composables/workbench-context';
export type { WorkbenchContext } from './composables/workbench-context';

export { createPluginEventBus } from './composables/plugin-events';
export type { PluginEventBus, PluginEventHandler, PluginEventType } from './composables/plugin-events';

export { createPluginStateStore } from './composables/plugin-state';
export type { PluginStateStore } from './composables/plugin-state';

export {
  createUIRegistry,
  defaultUIRegistry,
  provideUIRegistry,
  resolveOutgoingMessage,
  useUIRegistry,
  UI_REGISTRY_KEY,
} from './registry/ui-registry';
export type { UIRegistry } from './registry/ui-registry';

export {
  aervoxConfirm,
  type ConfirmOptions,
} from './primitives/feedback/confirm-service';

export { createWorkbenchPluginRuntime } from './plugins/plugin-runtime';
export type { BuiltinUIPlugin, WorkbenchPluginRuntime } from './plugins/plugin-runtime';

export type {
  ComposerContractProps,
  ExtensionSlotName,
  MessageTransformContext,
  MessageTransformOutput,
  MessageTransformResult,
  SlotItem,
  WorkbenchCardContribution,
} from './registry/types';
