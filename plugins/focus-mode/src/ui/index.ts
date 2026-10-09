import './styles.css';
import { BookOpen, ClipboardList, Puzzle } from 'lucide-vue-next';
import type { UIRegistry } from '@aervox/ui/plugin-api';
import { defaultUIRegistry } from '@aervox/ui/plugin-api';
import type { WorkbenchContext } from '@aervox/ui/plugin-api';
import type { BuiltinUIPlugin } from '@aervox/ui/plugin-api';
import FocusModeSwitch from './FocusModeSwitch.vue';
import FocusTermsBar from './FocusTermsBar.vue';
import TermExploreDialog from './TermExploreDialog.vue';
import FocusNavMenuItem from './FocusNavMenuItem.vue';
import FocusStudyCardActions from './FocusStudyCardActions.vue';
import FocusTaskCenterCard from './FocusTaskCenterCard.vue';
import FocusSettingsRow from './FocusSettingsRow.vue';
import FocusModeIndicator from './FocusModeIndicator.vue';
import LearningDrawer from './LearningDrawer.vue';
import { useFocusModeState, disposeFocusModeState } from './plugin-state';
import { useFocusLearning, disposeFocusLearning } from './useFocusLearning';

export {
  FocusModeSwitch,
  FocusTermsBar,
  TermExploreDialog,
  FocusNavMenuItem,
  FocusStudyCardActions,
  FocusTaskCenterCard,
  FocusSettingsRow,
  FocusModeIndicator,
  LearningDrawer,
};



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
  if (!context) throw new Error('focus_mode_context_required');
  const { focusModeEnabled, openLearningView } = useFocusModeState(context);
  const focusLearning = useFocusLearning(context);

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
    summary: () => `${focusLearning?.learningPlans.value?.length ?? 0} 份进行中规划`,
    action: () => openLearningView('study'),
    extraComponent: FocusStudyCardActions,
    priority: 100,
  });

  const unregisterMistakeCard = registry.registerCard({
    id: 'mistake',
    label: '错题本',
    description: '针对性练习未掌握的题',
    icon: Puzzle,
    summary: () => `${focusLearning?.activeMistakeCount.value ?? 0} 题待掌握`,
    action: () => openLearningView('mistake'),
    priority: 90,
  });

  const unregisterQuizCard = registry.registerCard({
    id: 'quiz',
    label: '刷题模式',
    description: 'AI 现场出题，答错自动进错题本',
    icon: ClipboardList,
    summary: () => (focusLearning?.practiceSession.value || context?.cards?.api?.activePracticeSession?.value) ? '进行中的练习' : 'AI 出题 · 即时判定',
    action: () => {
      if (context?.conversation?.streaming?.value) return;
      // 出题意图是本插件自有语义，经 metadata 出站（宿主不解释其取值）
      void context?.sendMessage?.('来几道题', { metadata: { mode: 'focus', intent: 'quiz' } });
    },
    priority: 80,
  });

  const unregisterDrawer = registry.registerSlotComponent('workbench:drawers', LearningDrawer, {
    id: 'focus-mode:learning-drawer',
    priority: 100,
  });

  // 插件自有设置行：宿主设置面板只提供通用插槽，不内建任何插件行
  const unregisterSettingsRow = registry.registerSlotComponent(
    'settings:conversation-rows',
    FocusSettingsRow,
    { id: 'focus-mode:settings-row', priority: 100 },
  );

  // 输入区模式指示器：由插件渲染自己的标记（宿主不内建插件样式与文案）
  const unregisterComposerIndicator = registry.registerSlotComponent(
    'composer:indicator',
    FocusModeIndicator,
    { id: 'focus-mode:composer-indicator', priority: 100 },
  );

  const unregisterTaskCard = registry.registerSlotComponent(
    'taskcenter:cards',
    FocusTaskCenterCard,
    { id: 'focus-mode:task-card', priority: 100 },
  );

  const unregisterTransformer = registry.registerMessageTransformer(
    'focus-mode:metadata',
    (text) => {
      // CR-060：模式语义一律经 metadata 出站（结构化优先），不改写消息文本。
      // 开关打开时为本次发送自述专注模式；宿主显式元数据（如出题意图）优先于本值。
      if (!focusModeEnabled.value) return text;
      return { text, metadata: { mode: 'focus' } };
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
    unregisterSettingsRow();
    unregisterComposerIndicator();
    disposeFocusModeState(context);
    disposeFocusLearning(context);
  };
}

/** 专注模式第一方插件定义 */
export const focusModePluginDefinition: BuiltinUIPlugin = {
  id: 'focus-mode',
  setup(registry, context) {
    return registerFocusModePlugin(registry, context);
  },
  onConfig(values, context) {
    if (!values) return;
    // CR-060：只认主 id 与当前配置键，不保留历史键回退
    if (typeof values.autoEnableFocusMode === 'boolean') {
      useFocusModeState(context).setFocusModeEnabled(values.autoEnableFocusMode);
    }
  },
  onDisable(context) {
    context.pluginState?.write('focus-mode', 'enabled', false);
    disposeFocusModeState(context);
    disposeFocusLearning(context);
  },
};

export { useFocusModeState } from './plugin-state';
export type { ExtractedTerm, TermsExtractedEventData } from './plugin-events';

/**
 * 默认导出：供组合根按包路径装配（宿主只取 `default`，不绑定插件私有符号）。
 */
export default focusModePluginDefinition;
