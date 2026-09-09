import { computed, ref, type Component, type Ref } from 'vue';
import {
  Bell,
  BookOpen,
  Bot,
  BrainCircuit,
  Clock3,
  GraduationCap,
  Heart,
  History,
  LayoutGrid,
  ListTodo,
  MessageCircle,
  NotebookPen,
  Puzzle,
  Settings,
  Sun,
  Volume2,
} from 'lucide-vue-next';
import { MizukiExpression } from '../live2d/model';
import { petReact, petReactKind } from '../live2d/petReactions';

export type Platform = 'desktop' | 'web';
export type ToolId = 'study' | 'mistake' | 'todo' | 'timer' | 'history' | 'diary';

export const settingCategories = [
  { id: 'tools', label: '快捷工具', description: '学习面板与小工具', icon: LayoutGrid, scope: 'detail' as const },
  { id: 'proactive', label: '主动智能', description: '全量画像与本地权限', icon: BrainCircuit, scope: 'detail' as const },
  { id: 'appearance', label: '外观', description: '主题与界面密度', icon: Sun, scope: 'detail' as const },
  { id: 'conversation', label: '对话', description: '称呼与输入方式', icon: MessageCircle, scope: 'siyu' as const },
  { id: 'model', label: '模型与服务', description: '大语言模型与供应商配置', icon: Bot, scope: 'siyu' as const },
  { id: 'persona', label: '人格设定', description: '管理人格角色设定', icon: Heart, scope: 'siyu' as const },
  { id: 'notifications', label: '提醒', description: '学习节奏与通知', icon: Bell, scope: 'detail' as const },
  { id: 'voice', label: '语音', description: '本地与在线语音模型配置', icon: Volume2, scope: 'siyu' as const },
  { id: 'plugins', label: '插件', description: '插件配置与页面', icon: Puzzle, scope: 'detail' as const },
] as const;

export function useWorkbenchLayout(props: {
  platform: Platform;
  showCompanion: boolean;
  assistantName: string;
}, options: {
  onStudyModeChange?: (enabled: boolean) => void;
  onOpenDiary?: () => void;
  getTimerMinutes?: () => number;
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
}) {
  const isWeb = computed(() => props.platform === 'web');
  const assistantDisplayName = ref(props.assistantName);
  const desktopCompanionEnabled = ref(props.showCompanion);
  const showCompanionEnabled = computed(() => props.showCompanion && (isWeb.value || desktopCompanionEnabled.value));

  const isDark = ref(false);
  const compactMode = ref(false);
  const studyModeEnabled = ref(false);
  const enterToSend = ref(true);
  const dailyReminder = ref(true);

  // 导航与菜单
  const menuOpen = ref(false);
  const menuPillRef = ref<HTMLElement | null>(null);

  // 工具抽屉
  const toolsOpen = ref(false);
  const activeToolView = ref<'todo' | 'timer' | 'history' | 'diary'>('todo');

  // 学习抽屉
  const learningOpen = ref(false);
  const activeLearningView = ref<'study' | 'mistake'>('study');

  // 历史层
  const historyOpen = ref(false);

  // 设置弹窗
  const settingsOpen = ref(false);
  const settingsCategory = ref<'tools' | 'appearance' | 'conversation' | 'model' | 'persona' | 'notifications' | 'voice' | 'plugins' | 'proactive'>('tools');
  const settingsScope = ref<'siyu' | 'detail'>('detail');

  const scopedSettingCategories = computed(() =>
    settingCategories.filter((c) => c.scope === settingsScope.value),
  );

  const toolsNavItems: Array<{ id: 'todo' | 'timer' | 'history' | 'diary'; label: string; description: string; icon: Component }> = [
    { id: 'todo', label: '待办清单', description: '勾选完成今天的待办', icon: ListTodo },
    { id: 'timer', label: '番茄钟', description: '专注计时，劳逸结合', icon: Clock3 },
    { id: 'history', label: '对话回看', description: '视觉小说式回看完整对话', icon: History },
    { id: 'diary', label: '日记本', description: 'AI 每日日记与历史回看', icon: NotebookPen },
  ];

  const learningNavItems: Array<{ id: 'study' | 'mistake'; label: string; description: string; icon: Component }> = [
    { id: 'study', label: '学习规划', description: 'AI 生成学习路线图', icon: BookOpen },
    { id: 'mistake', label: '错题本', description: '针对性重练未掌握题', icon: Puzzle },
  ];

  function toggleMenu() {
    menuOpen.value = !menuOpen.value;
    if (menuOpen.value) petReactKind('greet', { lookAtEl: '.menu-pill', lookDuration: 3200 });
    else petReactKind('nod');
  }

  function handlePillClick() {
    if (!menuOpen.value) {
      menuOpen.value = true;
      petReactKind('greet', { lookAtEl: '.menu-pill', lookDuration: 3200 });
    }
  }

  function runMenuAction(action: () => void) {
    menuOpen.value = false;
    action();
  }

  function handleMenuDocumentClick(event: MouseEvent) {
    if (!menuOpen.value) return;
    if (menuPillRef.value?.contains(event.target as Node)) return;
    menuOpen.value = false;
  }

  function handleHistoryEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && historyOpen.value) historyOpen.value = false;
  }

  function openTool(target: ToolId) {
    options.recordActivity('aervox.operation', 'workbench.tool_opened', undefined, { target });
    settingsOpen.value = false;
    toolsOpen.value = false;
    learningOpen.value = false;
    if (target === 'study' || target === 'mistake') {
      activeLearningView.value = target;
      learningOpen.value = true;
      return;
    }
    activeToolView.value = target;
    toolsOpen.value = true;
    if (target === 'diary') {
      options.onOpenDiary?.();
    } else if (target === 'history') {
      historyOpen.value = true;
    }
  }

  function switchToolView(target: 'todo' | 'timer' | 'history' | 'diary') {
    activeToolView.value = target;
    if (target === 'diary') {
      options.onOpenDiary?.();
    } else if (target === 'history') {
      historyOpen.value = true;
    }
  }

  function openSettings() {
    settingsOpen.value = true;
  }

  function openSettingsCategory(category: typeof settingsCategory.value) {
    settingsCategory.value = category;
    const scope = settingCategories.find((c) => c.id === category)?.scope ?? 'detail';
    settingsScope.value = scope;
    openSettings();
  }

  function switchSettingsCategory(category: typeof settingsCategory.value) {
    settingsCategory.value = category;
  }

  function toggleStudyMode() {
    studyModeEnabled.value = !studyModeEnabled.value;
    options.recordActivity('aervox.operation', 'conversation.study_mode_changed', undefined, { enabled: studyModeEnabled.value });
    if (studyModeEnabled.value) {
      petReactKind('glad', { expression: MizukiExpression.face_smile_01, lookAtEl: '.floating-study-switch-wrap' });
    } else {
      petReactKind('shake', { expression: MizukiExpression.face_normal_01, lookAtEl: '.floating-study-switch-wrap' });
    }
    options.onStudyModeChange?.(studyModeEnabled.value);
    saveSettings();
  }

  function saveSettings(timerMinutesVal?: number) {
    const resolvedTimerMinutes = timerMinutesVal ?? options.getTimerMinutes?.() ?? 25;
    const settings = {
      theme: isDark.value ? 'dark' : 'light',
      assistantName: assistantDisplayName.value.trim() || props.assistantName,
      enterToSend: enterToSend.value,
      compactMode: compactMode.value,
      studyModeEnabled: studyModeEnabled.value,
      timerMinutes: resolvedTimerMinutes,
      desktopCompanionEnabled: desktopCompanionEnabled.value,
      dailyReminder: dailyReminder.value,
    };
    assistantDisplayName.value = settings.assistantName;
    localStorage.setItem('aervox-settings', JSON.stringify(settings));
  }

  function applyTheme(theme: 'light' | 'dark') {
    isDark.value = theme === 'dark';
    document.documentElement.dataset.theme = theme;
    if (isWeb.value) localStorage.setItem('aervox-theme', theme);
  }

  async function setTheme(theme: 'light' | 'dark', timerMinutesVal?: number) {
    const desktopBridge = (window as Window & { fairyDesktop?: { setTheme: (value: 'light' | 'dark') => Promise<'light' | 'dark'> } }).fairyDesktop;
    const appliedTheme = isWeb.value ? theme : (await desktopBridge?.setTheme(theme)) ?? theme;
    applyTheme(appliedTheme);
    saveSettings(timerMinutesVal);
  }

  return {
    isWeb,
    assistantDisplayName,
    desktopCompanionEnabled,
    showCompanionEnabled,
    isDark,
    compactMode,
    studyModeEnabled,
    enterToSend,
    dailyReminder,
    menuOpen,
    menuPillRef,
    toolsOpen,
    activeToolView,
    learningOpen,
    activeLearningView,
    historyOpen,
    settingsOpen,
    settingsCategory,
    settingsScope,
    scopedSettingCategories,
    toolsNavItems,
    learningNavItems,
    toggleMenu,
    handlePillClick,
    runMenuAction,
    handleMenuDocumentClick,
    handleHistoryEscape,
    openTool,
    switchToolView,
    openSettings,
    openSettingsCategory,
    switchSettingsCategory,
    toggleStudyMode,
    saveSettings,
    applyTheme,
    setTheme,
  };
}

export type WorkbenchLayoutComposable = ReturnType<typeof useWorkbenchLayout>;
