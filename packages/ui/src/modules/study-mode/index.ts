import type { UIRegistry } from '../../registry/ui-registry';
import { defaultUIRegistry } from '../../registry/ui-registry';
import StudyModeSwitch from './StudyModeSwitch.vue';
import StudyTermsBar from './StudyTermsBar.vue';
import TermExploreDialog from './TermExploreDialog.vue';

export {
  StudyModeSwitch,
  StudyTermsBar,
  TermExploreDialog,
};

/**
 * 注册专注模式完整第一方前端模块
 * - 注册顶栏开关至 `header:actions`
 * - 注册术语条与名词解释弹窗至 `conversation:bottom`
 *
 * @param registry UI 注册表实例，默认为 defaultUIRegistry
 * @returns 注销清理函数
 */
export function registerStudyModeModule(registry: UIRegistry = defaultUIRegistry): () => void {
  const unregisterSwitch = registry.registerSlotComponent('header:actions', StudyModeSwitch, {
    id: 'study-mode:header-switch',
    priority: 100,
  });

  const unregisterTerms = registry.registerSlotComponent('conversation:bottom', StudyTermsBar, {
    id: 'study-mode:terms-bar',
    priority: 50,
  });

  return () => {
    unregisterSwitch();
    unregisterTerms();
  };
}
