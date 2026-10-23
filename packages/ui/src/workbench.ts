/// <reference path="./env.d.ts" />
/** Public building blocks for trusted workbench surfaces; no root implementation. */
// 工作台类根界面的完整主题链随出口装配（窄屏抽屉遮罩、设置体验、Hero 均依赖此链）
import './theme/workbench-all.css';
export { COMPANION_DEFAULT_NAME, USER_DEFAULT_ADDRESS, SPACE_NAME, readCompanionIdentity, saveCompanionIdentity } from './utils/companion-identity';
export type { CompanionIdentity } from './utils/companion-identity';
import { defineAsyncComponent } from 'vue';
export type { Platform } from './composables/useWorkbenchLayout';
export { default as PetHero } from './components/PetHero.vue';
export { createWorkbenchPluginRuntime, type BuiltinUIPlugin } from './plugins';
export { default as WorkbenchHeader } from './components/workbench/WorkbenchHeader.vue';
export { default as WorkbenchSidebar } from './components/workbench/WorkbenchSidebar.vue';
export { default as PomodoroToast } from './components/workbench/PomodoroToast.vue';
export { default as ProactiveToast } from './components/workbench/ProactiveToast.vue';
export { default as WorkbenchNavPill } from './components/workbench/WorkbenchNavPill.vue';
export { default as WorkbenchSideCards } from './components/workbench/WorkbenchSideCards.vue';
export { default as ConversationConsole } from './components/workbench/ConversationConsole.vue';
export { default as StandardConversation } from './components/workbench/StandardConversation.vue';
export { default as ComposerDock } from './components/workbench/ComposerDock.vue';
export { AervoxButton } from './primitives';
export { default as PetWithFallback } from './components/PetWithFallback.vue';
export { default as ExtensionSlot } from './components/extension/ExtensionSlot.vue';
export { useWorkbenchLayout } from './composables/useWorkbenchLayout';
export { useWorkbenchTimer } from './composables/useWorkbenchTimer';
export { useWorkbenchComposer } from './composables/useWorkbenchComposer';
export { createStreamingDeltaBatcher, useWorkbenchConversation } from './composables/useWorkbenchConversation';
export { useWorkbenchCards, todayLocalDate, type CardId } from './composables/useWorkbenchCards';
export { useWorkbenchProactive, proactiveBridge } from './composables/useWorkbenchProactive';
export { provideWorkbenchContext, useWorkbenchContext, WORKBENCH_CONTEXT_KEY } from './composables/workbench-context';
export { createPluginEventBus } from './composables/plugin-events';
export { createPluginStateStore } from './composables/plugin-state';
export { resolveStartupQuiet, runStartupDiary } from './composables/workbench-startup';
export { createUIRegistry, provideUIRegistry, useUIRegistry, UI_REGISTRY_KEY, resolveOutgoingMessage } from './registry/ui-registry';
export { MizukiExpression } from './live2d/model';
export { petReact, petReactKind } from './live2d/petReactions';
export const Live2DPet = defineAsyncComponent(() => import('./components/Live2DPet.vue'));
export const ToolsDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/ToolsDrawer.vue'));
export const HistoryDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/HistoryDrawer.vue'));
export const TaskCenterDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/TaskCenterDrawer.vue'));
export const SettingsModal = defineAsyncComponent(() => import('./components/workbench/drawers/SettingsModal.vue'));
export const CommandPalette = defineAsyncComponent(() => import('./components/workbench/CommandPalette.vue'));
export const ProjectManagerModal = defineAsyncComponent(() => import('./components/workbench/modals/ProjectManagerModal.vue'));
export const ImportSessionModal = defineAsyncComponent(() => import('./components/workbench/modals/ImportSessionModal.vue'));

export { provideUIPluginContext } from './composables/ui-plugin-context';
export type { UIPluginContext } from './composables/ui-plugin-context';
