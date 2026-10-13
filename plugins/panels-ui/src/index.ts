import type { Component } from 'vue';
import LLMConfigPanel from './llm/LLMConfigPanel.vue';
import ModelRuntimePanel from './llm/ModelRuntimePanel.vue';
import PersonaManagerPanel from './persona/PersonaManagerPanel.vue';
import VoicePresetManagerPanel from './voice/VoicePresetManagerPanel.vue';
import PluginManagerPanel from './plugin/PluginManagerPanel.vue';

export { LLMConfigPanel, ModelRuntimePanel, PersonaManagerPanel, VoicePresetManagerPanel, PluginManagerPanel };

/** 一块设置面板与所属分类的绑定（受信构建输入，由组合根显式注入工作台根） */
export interface SettingsPanelRegistration {
  /** 对应 useWorkbenchLayout 的 settingsCategory 值 */
  readonly category: string;
  readonly component: Component;
}

/**
 * 五块内置设置面板：模型服务 / 本地模型 / 人格 / 语音 / 插件管理。
 * 宿主不内建任何具体面板（CR-063 同一切片口径）：组合根显式注入，
 * 工作台根注册进 `settings:panel:<category>` 槽位，设置弹层按分类渲染。
 */
export const settingsPanels: readonly SettingsPanelRegistration[] = [
  { category: 'model', component: LLMConfigPanel },
  { category: 'local-models', component: ModelRuntimePanel },
  { category: 'persona', component: PersonaManagerPanel },
  { category: 'voice', component: VoicePresetManagerPanel },
  { category: 'plugins', component: PluginManagerPanel },
];
