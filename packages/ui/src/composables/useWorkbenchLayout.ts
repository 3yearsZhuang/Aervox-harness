import { getPlatformServices } from '@aervox/api-client';
import { computed, getCurrentScope, onScopeDispose, ref, type Component, type Ref } from 'vue';
import {
  Bot,
  BrainCircuit,
  Clock3,
  Cpu,
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

export type Platform = 'desktop' | 'web' | 'mobile';
export type WorkbenchMode = 'companion' | 'standard';
/**
 * 宿主内建工具抽屉 id。
 * CR-060：插件自有视图（如学习抽屉）不再占用宿主 id——插件以自己的状态与
 * `workbench:drawers` 槽位承载其视图，宿主不感知其存在。
 */
export type ToolId = 'todo' | 'timer' | 'history' | 'diary' | 'task_center';

export const settingCategories = [
  { id: 'appearance', label: '通用', description: '外观与工具布局', icon: Settings, categories: ['appearance', 'tools'] },
  { id: 'conversation', label: '对话与陪伴', description: '输入、人格与声音', icon: MessageCircle, categories: ['conversation', 'persona', 'voice'] },
  { id: 'model', label: '模型服务', description: '服务连接与本地运行', icon: Bot, categories: ['model', 'local-models'] },
  { id: 'proactive', label: '主动智能', description: '本地感知与授权', icon: BrainCircuit, categories: ['proactive'] },
  { id: 'plugins', label: '扩展插件', description: '插件、技能与工具', icon: Puzzle, categories: ['plugins'] },
] as const;

export const settingPages = [
  { value: 'appearance', label: '外观', icon: Sun },
  { value: 'tools', label: '工具布局', icon: LayoutGrid },
  { value: 'conversation', label: '对话', icon: MessageCircle },
  { value: 'persona', label: '人格设定', icon: Heart },
  { value: 'voice', label: '语音', icon: Volume2 },
  { value: 'model', label: '连接配置', icon: Bot },
  { value: 'local-models', label: '本地模型', icon: Cpu },
] as const;

export function useWorkbenchLayout(props: {
  platform: Platform;
  showCompanion: boolean;
  assistantName: string;
}, options: {
  onOpenDiary?: () => void;
  getTimerMinutes?: () => number;
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
}) {
  // Mobile is a WebView host: it shares browser storage and API behavior,
  // but must never be treated as an Electron desktop host.
  const isWeb = computed(() => props.platform !== 'desktop');
  const isMobile = computed(() => props.platform === 'mobile');
  const isDesktop = computed(() => props.platform === 'desktop');
  const assistantDisplayName = ref(props.assistantName);
  const desktopCompanionEnabled = ref(props.showCompanion);
  const showCompanionEnabled = computed(() => props.showCompanion && (isWeb.value || desktopCompanionEnabled.value));

  // CR-035: 双模式架构（桌宠陪伴模式 companion ↔ 标准工作台模式 standard）
  let initialWorkbenchMode: WorkbenchMode = isMobile.value ? 'standard' : 'companion';
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('aervox-workbench-mode');
      if (stored === 'standard' || (stored === 'companion' && !isMobile.value)) {
        initialWorkbenchMode = stored;
      }
    }
  } catch {
    // 忽略异常
  }
  const workbenchMode = ref<WorkbenchMode>(initialWorkbenchMode);
  const narrowWindow = typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 760px)') : undefined;
  const narrowSidebar = ref(isMobile.value || Boolean(narrowWindow?.matches));
  const standardSidebarCollapsed = ref(narrowSidebar.value);
  function syncSidebarViewport() {
    narrowSidebar.value = isMobile.value || Boolean(narrowWindow?.matches);
    standardSidebarCollapsed.value = narrowSidebar.value;
  }
  if (getCurrentScope()) {
    narrowWindow?.addEventListener('change', syncSidebarViewport);
    onScopeDispose(() => narrowWindow?.removeEventListener('change', syncSidebarViewport));
  }
  const taskCenterOpen = ref(false);

  const isDark = ref(false);
  const compactMode = ref(false);
  /**
   * 启动期静默：任何插件都可请求宿主在启动时不要弹出打扰性面板。
   * 宿主不关心请求者身份与理由（CR-060 通用接缝）。
   */
  const quietStartup = ref(false);
  const enterToSend = ref(true);
  const dailyReminder = ref(true);

  // 导航与菜单
  const menuOpen = ref(false);
  const menuPillRef = ref<HTMLElement | null>(null);

  // 工具抽屉
  const toolsOpen = ref(false);
  const activeToolView = ref<'todo' | 'timer' | 'history' | 'diary'>('todo');

  // 历史层
  const historyOpen = ref(false);

  // 设置弹窗
  const settingsOpen = ref(false);
  const settingsCategory = ref<'tools' | 'appearance' | 'conversation' | 'model' | 'local-models' | 'persona' | 'notifications' | 'voice' | 'plugins' | 'proactive'>('conversation');
  const settingsScope = ref<'siyu' | 'detail'>('detail');

  const scopedSettingCategories = computed(() => settingCategories);

  const toolsNavItems: Array<{ id: 'todo' | 'timer' | 'history' | 'diary'; label: string; description: string; icon: Component }> = [
    { id: 'todo', label: '待办清单', description: '勾选完成今天的待办', icon: ListTodo },
    { id: 'timer', label: '番茄钟', description: '专注计时，劳逸结合', icon: Clock3 },
    { id: 'history', label: '对话回看', description: '视觉小说式回看完整对话', icon: History },
    { id: 'diary', label: '日记本', description: 'AI 每日日记与历史回看', icon: NotebookPen },
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
    if (target === 'task_center') {
      taskCenterOpen.value = true;
      return;
    }
    activeToolView.value = target;
    toolsOpen.value = true;
    if (target === 'diary') {
      options.onOpenDiary?.();
    }
  }

  function switchToolView(target: 'todo' | 'timer' | 'history' | 'diary') {
    activeToolView.value = target;
    if (target === 'diary') {
      options.onOpenDiary?.();
    }
  }

  function openSettings() {
    settingsOpen.value = true;
  }

  function openSettingsCategory(category: typeof settingsCategory.value) {
    settingsCategory.value = category;
    openSettings();
  }

  /** 插件请求启动期静默（宿主只记录诉求，不解释来源） */
  function setQuietStartup(enabled: boolean): void {
    quietStartup.value = enabled;
  }

  function switchSettingsCategory(category: typeof settingsCategory.value) {
    settingsCategory.value = category;
  }

  function switchWorkbenchMode(mode: WorkbenchMode) {
    if (workbenchMode.value === mode) return;
    workbenchMode.value = mode;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('aervox-workbench-mode', mode);
      }
    } catch {
      // 忽略异常
    }
    options.recordActivity('aervox.operation', 'workbench.mode_switched', undefined, { mode });
    if (mode === 'companion') {
      petReactKind('greet', { lookDuration: 2500 });
    }
  }

  function toggleWorkbenchMode() {
    switchWorkbenchMode(workbenchMode.value === 'companion' ? 'standard' : 'companion');
  }

  function toggleStandardSidebar() {
    standardSidebarCollapsed.value = !standardSidebarCollapsed.value;
  }

  function openTaskCenter() {
    taskCenterOpen.value = true;
    options.recordActivity('aervox.operation', 'workbench.task_center_opened', undefined);
  }

  function closeTaskCenter() {
    taskCenterOpen.value = false;
  }

  function toggleTaskCenter() {
    taskCenterOpen.value = !taskCenterOpen.value;
    if (taskCenterOpen.value) {
      options.recordActivity('aervox.operation', 'workbench.task_center_opened', undefined);
    }
  }

  function saveSettings(timerMinutesVal?: number) {
    const resolvedTimerMinutes = timerMinutesVal ?? options.getTimerMinutes?.() ?? 25;
    // 注：workbenchMode 单独持久化在 'aervox-workbench-mode'（switchWorkbenchMode 内联写入），
    // 此处不重复写入 settings JSON，避免双源漂移。
    const settings = {
      theme: isDark.value ? 'dark' : 'light',
      assistantName: assistantDisplayName.value.trim() || props.assistantName,
      enterToSend: enterToSend.value,
      compactMode: compactMode.value,
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
    const appliedTheme = isWeb.value ? theme : (await getPlatformServices().setTheme?.(theme)) ?? theme;
    applyTheme(appliedTheme);
    saveSettings(timerMinutesVal);
  }

  return {
    isWeb,
    isMobile,
    isDesktop,
    assistantDisplayName,
    desktopCompanionEnabled,
    showCompanionEnabled,
    workbenchMode,
    narrowSidebar,
    standardSidebarCollapsed,
    taskCenterOpen,
    isDark,
    compactMode,
    quietStartup,
    setQuietStartup,
    enterToSend,
    dailyReminder,
    menuOpen,
    menuPillRef,
    toolsOpen,
    activeToolView,
    historyOpen,
    settingsOpen,
    settingsCategory,
    settingsScope,
    scopedSettingCategories,
    toolsNavItems,
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
    switchWorkbenchMode,
    toggleWorkbenchMode,
    toggleStandardSidebar,
    openTaskCenter,
    closeTaskCenter,
    toggleTaskCenter,
    saveSettings,
    applyTheme,
    setTheme,
  };
}

export type WorkbenchLayoutComposable = ReturnType<typeof useWorkbenchLayout>;
