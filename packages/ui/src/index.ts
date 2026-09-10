/** Aervox｜思隅 @aervox/ui 入口（源码出口，由消费端 Vite 处理） */
export { default as PetHero } from './components/PetHero.vue';
export { default as SpritePet } from './components/SpritePet.vue';
export { default as MessageBubble } from './components/MessageBubble.vue';
export { default as UserQuestionComposer } from './components/UserQuestionComposer.vue';
export { default as AervoxWorkbench } from './components/AervoxWorkbench.vue';

import { defineAsyncComponent } from 'vue';

// 核心组件拆解导出
export { default as WorkbenchHeader } from './components/workbench/WorkbenchHeader.vue';
export { default as PomodoroToast } from './components/workbench/PomodoroToast.vue';
export { default as WorkbenchNavPill } from './components/workbench/WorkbenchNavPill.vue';
export { default as WorkbenchSideCards } from './components/workbench/WorkbenchSideCards.vue';
export { default as ConversationConsole } from './components/workbench/ConversationConsole.vue';
export { default as ToolApprovalCard } from './components/workbench/ToolApprovalCard.vue';
export { default as TermsBar } from './components/workbench/TermsBar.vue';
export { default as ComposerDock } from './components/workbench/ComposerDock.vue';
export { default as ComposerAttachments } from './components/workbench/ComposerAttachments.vue';
export const ToolsDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/ToolsDrawer.vue'));
export const LearningDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/LearningDrawer.vue'));
export const HistoryDrawer = defineAsyncComponent(() => import('./components/workbench/drawers/HistoryDrawer.vue'));
export const SettingsModal = defineAsyncComponent(() => import('./components/workbench/drawers/SettingsModal.vue'));

// 扩展系统与插槽组件
export { default as ExtensionSlot } from './components/extension/ExtensionSlot.vue';
export * from './registry/types';
export * from './registry/ui-registry';

// 插件扩展系统与内置插件
export * from './plugins';


// 领域 Composables
export * from './composables/useWorkbenchLayout';
export * from './composables/useWorkbenchTimer';
export * from './composables/useWorkbenchComposer';
export * from './composables/useWorkbenchConversation';
export * from './composables/useWorkbenchCards';
export * from './composables/useWorkbenchProactive';
export * from './composables/workbench-context';

export { default as PluginManagerPanel } from './components/plugin/PluginManagerPanel.vue';
export { default as PluginConfigDialog } from './components/plugin/PluginConfigDialog.vue';
export { default as PluginPageDialog } from './components/plugin/PluginPageDialog.vue';
export { default as PluginConfigForm } from './components/plugin/PluginConfigForm.vue';
export { default as PluginConfigFieldInput } from './components/plugin/PluginConfigFieldInput.vue';
export { default as SkillManagerTab } from './components/plugin/SkillManagerTab.vue';
export { default as SkillContentDialog } from './components/plugin/SkillContentDialog.vue';
export { default as McpToolsTab } from './components/plugin/McpToolsTab.vue';
export { default as ToolCallDialog } from './components/plugin/ToolCallDialog.vue';
export { default as McpRegisterDialog } from './components/plugin/McpRegisterDialog.vue';
export { default as McpPresetServers } from './components/plugin/McpPresetServers.vue';
export const Live2DPet = defineAsyncComponent(() => import('./components/Live2DPet.vue'));
export { default as AervoxBrandMark } from './components/AervoxBrandMark.vue';
export { default as AervoxCompanionMark } from './components/AervoxCompanionMark.vue';
export * from './live2d/model';
export * from './live2d/petReactions';
export { default as PersonaManagerPanel } from './components/persona/PersonaManagerPanel.vue';
export { default as PersonaEditDialog } from './components/persona/PersonaEditDialog.vue';
export { default as VoiceAbilityCard } from './components/persona/VoiceAbilityCard.vue';
export { default as LocalVoiceConfigPanel } from './components/voice/LocalVoiceConfigPanel.vue';
export { default as LLMConfigPanel } from './components/llm/LLMConfigPanel.vue';
export * from './utils/markdown';
export * from './proactive/profile-authorization';
import './theme/index.css';
import './theme/hero.css';
import './theme/workbench.css';
