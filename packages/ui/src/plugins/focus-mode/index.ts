import { defineAsyncComponent } from 'vue';
import { BookOpen, ClipboardList, Puzzle } from 'lucide-vue-next';
import type { UIRegistry } from '../../registry/ui-registry';
import { defaultUIRegistry } from '../../registry/ui-registry';
import type { WorkbenchContext } from '../../composables/workbench-context';
import type { BuiltinUIPlugin } from '../plugin-runtime';
import FocusModeSwitch from './FocusModeSwitch.vue';
import FocusTermsBar from './FocusTermsBar.vue';
import TermExploreDialog from './TermExploreDialog.vue';
import FocusNavMenuItem from './FocusNavMenuItem.vue';
import FocusStudyCardActions from './FocusStudyCardActions.vue';
import FocusTaskCenterCard from './FocusTaskCenterCard.vue';

export {
  FocusModeSwitch,
  FocusTermsBar,
  TermExploreDialog,
  FocusNavMenuItem,
  FocusStudyCardActions,
  FocusTaskCenterCard,
};

/** 向后兼容导出组件别名 */
export const StudyModeSwitch = FocusModeSwitch;
export const StudyTermsBar = FocusTermsBar;

/**
 * 注册专注模式完整第一方前端插件
 * - 注册顶栏开关至 `header:actions`
 * - 注册术语条与名词解释弹窗至 `conversation:bottom`
 * - 注册主导航学习能力入口至 `nav:menu-items`
 * - 注册专属卡片（学习规划、错题本、刷题模式）至 `registry.registerCard`
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

  const unregisterNavMenu = registry.registerSlotComponent('nav:menu-items', FocusNavMenuItem, {
    id: 'focus-mode:nav-menu-item',
    priority: 100,
  });

  const unregisterStudyCard = registry.registerCard({
    id: 'study',
    label: '学习规划',
    description: 'AI 生成里程碑式学习路线图',
    icon: BookOpen,
    summary: () => `${context?.cards?.api?.learningPlans?.value?.length ?? 0} 份进行中规划`,
    action: () => context?.layout?.openTool?.('study'),
    extraComponent: FocusStudyCardActions,
    priority: 100,
  });

  const unregisterMistakeCard = registry.registerCard({
    id: 'mistake',
    label: '错题本',
    description: '针对性练习未掌握的题',
    icon: Puzzle,
    summary: () => `${context?.cards?.activeMistakeCount?.value ?? 0} 题待掌握`,
    action: () => context?.layout?.openTool?.('mistake'),
    priority: 90,
  });

  const unregisterQuizCard = registry.registerCard({
    id: 'quiz',
    label: '刷题模式',
    description: 'AI 现场出题，答错自动进错题本',
    icon: ClipboardList,
    summary: () => (context?.cards?.practiceSession?.value || context?.cards?.api?.activePracticeSession?.value) ? '进行中的练习' : 'AI 出题 · 即时判定',
    action: () => {
      if (context?.conversation?.streaming?.value) return;
      void context?.sendMessage?.('来几道题', { quizMode: true });
    },
    priority: 80,
  });

  const unregisterDrawer = registry.registerSlotComponent(
    'workbench:drawers',
    defineAsyncComponent(() => import('../../components/workbench/drawers/LearningDrawer.vue')),
    { id: 'focus-mode:learning-drawer', priority: 100 },
  );

  const unregisterTaskCard = registry.registerSlotComponent(
    'taskcenter:cards',
    FocusTaskCenterCard,
    { id: 'focus-mode:task-card', priority: 100 },
  );

  const unregisterTransformer = registry.registerMessageTransformer(
    'focus-mode:prefix',
    (text, options) => {
      if (options?.quizMode || options?.useMetadata) return text;
      if (context?.layout?.focusModeEnabled?.value ?? context?.layout?.studyModeEnabled?.value) {
        const prefix = '[模式：专注模式] ';
        if (text.startsWith(prefix) || text.startsWith('[模式：专注模式]')) {
          return text;
        }
        return `${prefix}${text}`;
      }
      return text;
    },
    100,
  );

  return () => {
    unregisterSwitch();
    unregisterTerms();
    unregisterNavMenu();
    unregisterTransformer();
    unregisterStudyCard();
    unregisterMistakeCard();
    unregisterQuizCard();
    unregisterDrawer();
    unregisterTaskCard();
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
