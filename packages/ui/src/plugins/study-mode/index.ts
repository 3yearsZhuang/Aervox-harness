import type { UIRegistry } from '../../registry/ui-registry';
import { defaultUIRegistry } from '../../registry/ui-registry';
import type { WorkbenchContext } from '../../composables/workbench-context';
import type { BuiltinUIPlugin } from '../plugin-runtime';
import StudyModeSwitch from './StudyModeSwitch.vue';
import StudyTermsBar from './StudyTermsBar.vue';
import TermExploreDialog from './TermExploreDialog.vue';

export {
  StudyModeSwitch,
  StudyTermsBar,
  TermExploreDialog,
};

/**
 * 注册专注模式完整第一方前端插件
 * - 注册顶栏开关至 `header:actions`
 * - 注册术语条与名词解释弹窗至 `conversation:bottom`
 * - 注册专注模式消息前缀变换拦截器
 *
 * @param registry UI 注册表实例，默认为 defaultUIRegistry
 * @param context 工作台上下文实例
 * @returns 注销清理函数
 */
export function registerStudyModePlugin(
  registry: UIRegistry = defaultUIRegistry,
  context?: WorkbenchContext,
): () => void {
  const unregisterSwitch = registry.registerSlotComponent('header:actions', StudyModeSwitch, {
    id: 'study-mode:header-switch',
    priority: 100,
  });

  const unregisterTerms = registry.registerSlotComponent('conversation:bottom', StudyTermsBar, {
    id: 'study-mode:terms-bar',
    priority: 50,
  });

  const unregisterTransformer = registry.registerMessageTransformer('study-mode:prefix', (text, options) => {
    if (options?.quizMode) return text;
    if (context?.layout?.studyModeEnabled?.value) {
      return `[模式：专注模式] ${text}`;
    }
    return text;
  });

  return () => {
    unregisterSwitch();
    unregisterTerms();
    unregisterTransformer();
  };
}

/** 专注模式第一方插件定义（供通用插件运行时编排） */
export const studyModePluginDefinition: BuiltinUIPlugin = {
  id: 'study-mode',
  setup(registry, context) {
    return registerStudyModePlugin(registry, context);
  },
  onConfig(values, context) {
    if (values && typeof values.autoEnableStudyMode === 'boolean') {
      let hasSavedStudySetting = false;
      try {
        const savedSettingsRaw = typeof localStorage !== 'undefined' ? localStorage.getItem('aervox-settings') : null;
        if (savedSettingsRaw) {
          hasSavedStudySetting = 'studyModeEnabled' in JSON.parse(savedSettingsRaw);
        }
      } catch {
        // ignore malformed settings or environments without working localStorage
      }
      if (!hasSavedStudySetting && context?.layout?.setStudyModeEnabled) {
        context.layout.setStudyModeEnabled(Boolean(values.autoEnableStudyMode));
      }
    }
  },

  onDisable(context) {
    if (context?.layout?.studyModeEnabled?.value) {
      context.layout.setStudyModeEnabled(false);
    }
  },
};

// 别名兼容
export const registerStudyModeModule = registerStudyModePlugin;
export const registerStudyCompanionPlugin = registerStudyModePlugin;
