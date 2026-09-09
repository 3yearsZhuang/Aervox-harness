import type { UIRegistry } from '../../registry/ui-registry';
import { defaultUIRegistry } from '../../registry/ui-registry';
import type { WorkbenchContext } from '../../composables/workbench-context';
import type { BuiltinUIPlugin } from '../plugin-runtime';
import FocusModeSwitch from './FocusModeSwitch.vue';
import FocusTermsBar from './FocusTermsBar.vue';
import TermExploreDialog from './TermExploreDialog.vue';

export {
  FocusModeSwitch,
  FocusTermsBar,
  TermExploreDialog,
};

/** 向后兼容导出组件别名 */
export const StudyModeSwitch = FocusModeSwitch;
export const StudyTermsBar = FocusTermsBar;

/**
 * 注册专注模式完整第一方前端插件
 * - 注册顶栏开关至 `header:actions`
 * - 注册术语条与名词解释弹窗至 `conversation:bottom`
 * - 注册专注模式消息前缀变换拦截器（支持元数据协议透传）
 */
export function registerFocusModePlugin(
  registry: UIRegistry = defaultUIRegistry,
  context?: WorkbenchContext,
): () => void {
  const unregisterSwitch = registry.registerSlotComponent('header:actions', FocusModeSwitch, {
    id: 'focus-mode:header-switch',
    priority: 100,
  });

  const unregisterTerms = registry.registerSlotComponent('conversation:bottom', FocusTermsBar, {
    id: 'focus-mode:terms-bar',
    priority: 50,
  });

  const unregisterTransformer = registry.registerMessageTransformer('focus-mode:prefix', (text, options) => {
    if (options?.quizMode || options?.useMetadata) return text;
    if (context?.layout?.focusModeEnabled?.value ?? context?.layout?.studyModeEnabled?.value) {
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

/** 专注模式第一方插件定义 */
export const focusModePluginDefinition: BuiltinUIPlugin = {
  id: 'focus-mode',
  setup(registry, context) {
    return registerFocusModePlugin(registry, context);
  },
  onConfig(values, context) {
    if (!values || !context?.layout) return;
    const autoEnable =
      typeof values.autoEnableFocusMode === 'boolean'
        ? values.autoEnableFocusMode
        : typeof values.autoEnableStudyMode === 'boolean'
          ? values.autoEnableStudyMode
          : undefined;

    if (autoEnable !== undefined) {
      if (context.layout.setFocusModeEnabled) {
        context.layout.setFocusModeEnabled(autoEnable);
      } else if (context.layout.setStudyModeEnabled) {
        context.layout.setStudyModeEnabled(autoEnable);
      }
    }
  },
  onDisable(context) {
    if (context?.layout?.setFocusModeEnabled) {
      context.layout.setFocusModeEnabled(false);
    } else if (context?.layout?.setStudyModeEnabled) {
      context.layout.setStudyModeEnabled(false);
    }
  },
};

/** 向后兼容导出 */
export const registerStudyModePlugin = registerFocusModePlugin;
export const registerStudyModeModule = registerFocusModePlugin;
export const registerStudyCompanionPlugin = registerFocusModePlugin;
export const studyModePluginDefinition: BuiltinUIPlugin = {
  ...focusModePluginDefinition,
  id: 'study-mode',
};

