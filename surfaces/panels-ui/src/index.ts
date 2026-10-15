import { defineAsyncComponent, type Component } from 'vue';

/** 一块设置面板与所属分类的绑定（受信构建输入，由组合根显式注入工作台根） */
export interface SettingsPanelRegistration {
  /** 对应 useWorkbenchLayout 的 settingsCategory 值 */
  readonly category: string;
  readonly component: Component;
}

/**
 * 内置设置面板：模型服务 / 本地模型 / 人格 / 语音 / 机器人连接 / 插件管理。
 * 宿主不内建任何具体面板（CR-065 口径）：组合根显式注入，
 * 工作台根注册进 `settings:panel:<category>` 槽位，设置弹层按分类渲染。
 *
 * ITER-055 遗留收口：面板一律异步分包——设置弹层未打开对应分类时，
 * 其代码不进入工作台首包；分类首次激活时按需加载（模型面板经 KeepAlive
 * 缓存，切走再回来不丢草稿）。
 */
export const settingsPanels: readonly SettingsPanelRegistration[] = [
  { category: 'model', component: defineAsyncComponent(() => import('./llm/LLMConfigPanel.vue')) },
  { category: 'local-models', component: defineAsyncComponent(() => import('./llm/ModelRuntimePanel.vue')) },
  { category: 'persona', component: defineAsyncComponent(() => import('./persona/PersonaManagerPanel.vue')) },
  { category: 'voice', component: defineAsyncComponent(() => import('./voice/VoicePresetManagerPanel.vue')) },
  { category: 'bots', component: defineAsyncComponent(() => import('./bot/BotConnectionsPanel.vue')) },
  { category: 'plugins', component: defineAsyncComponent(() => import('./plugin/PluginManagerPanel.vue')) },
];
