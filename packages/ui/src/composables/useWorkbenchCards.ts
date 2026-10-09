import { computed, markRaw, ref, watch, type Component, type Ref } from 'vue';
import {
  Clock3,
  History,
  ListTodo,
  NotebookPen,
} from 'lucide-vue-next';
import {
  useAervoxApi,
  useAervoxDiary,
  type DiaryDto,
  type GenerateTodayResultDto,
} from '@aervox/api-client';
import type { UserQuestionRequiredEventData } from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { petReactKind } from '../live2d/petReactions';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchCardContribution } from '../registry/types';
import type { ToolId } from './useWorkbenchLayout';

export type CardId = string;

export interface CardDefinition extends WorkbenchCardContribution {}


export interface DiaryView {
  localDate: string;
  title: string;
  content: string;
  generatedBy: 'llm' | 'template';
  materialCount: number;
  mode: 'created' | 'rewritten' | 'existing';
}

const TEMPLATE_MARKER = '（本篇为非 LLM 模式的模板日记';
const toDiaryView = (result: GenerateTodayResultDto): DiaryView => ({
  localDate: result.localDate,
  title: result.title,
  content: result.content,
  generatedBy: result.generatedBy,
  materialCount: result.materialCount,
  mode: result.mode,
});
const toDiaryViewFromRow = (row: DiaryDto): DiaryView => ({
  localDate: row.localDate,
  title: row.title,
  content: row.content,
  generatedBy: row.content.includes(TEMPLATE_MARKER) ? 'template' : 'llm',
  materialCount: 0,
  mode: 'existing',
});

export const todayLocalDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());


export function useWorkbenchCards(options: {
  activeQuestion: Ref<UserQuestionRequiredEventData | null>;
  timerRunning: Ref<boolean>;
  formattedTime: Ref<string>;
  storyCount: Ref<number>;
  onOpenTool: (tool: ToolId) => void;
  onSubmitQuestionAnswers: (answers: Array<{ id: string; selected: string[] }>) => Promise<void>;
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
  registry?: UIRegistry;
}) {
  const api = useAervoxApi();
  const diaryApi = useAervoxDiary();

  const {
    goals,
    dueReviews,
  } = api;

  const cardSlots = ref<Array<CardId | null>>(['todo', null]);
  let savedCardSlots: Array<CardId | null> | null = null;
  let diarySlotRestore: CardId | null | undefined = undefined;

  // 提问卡
  const questionCardSelected = ref<string[]>([]);
  const questionCardData = computed(() => options.activeQuestion.value?.questions[0] ?? null);

  watch(options.activeQuestion, (value) => {
    if (!value) questionCardSelected.value = [];
  });

  function handleQuestionCardOption(label: string) {
    const question = questionCardData.value;
    if (!question) return;
    if (question.multiSelect) {
      questionCardSelected.value = questionCardSelected.value.includes(label)
        ? questionCardSelected.value.filter((item) => item !== label)
        : [...questionCardSelected.value, label];
      return;
    }
    void options.onSubmitQuestionAnswers([{ id: question.id, selected: [label] }]);
  }

  function submitQuestionCardAnswers() {
    const question = questionCardData.value;
    if (!question || questionCardSelected.value.length === 0) return;
    void options.onSubmitQuestionAnswers([{ id: question.id, selected: [...questionCardSelected.value] }]);
  }

  // 日记状态
  const todayDiary = ref<GenerateTodayResultDto | null>(null);
  const viewingDiary = ref<DiaryView | null>(null);
  const diaryHistory = ref<DiaryDto[]>([]);
  const diaryBusy = ref(false);
  const diaryError = ref<string | null>(null);
  const diaryDisplayContent = computed(() =>
    (viewingDiary.value?.content ?? '').replace(/^标题[：:].*\n\n/, '').replace(/^标题[：:].*\n/, ''),
  );

  async function loadDiaryHistory() {
    try {
      diaryHistory.value = await diaryApi.listDiaries(30);
    } catch {
      diaryHistory.value = [];
    }
  }

  async function openDiary() {
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const result = await diaryApi.generateToday();
      todayDiary.value = result;
      viewingDiary.value = result ? toDiaryView(result) : null;
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '日记加载失败';
    } finally {
      diaryBusy.value = false;
    }
    await loadDiaryHistory();
  }

  async function selectDiaryDate(localDate: string) {
    if (viewingDiary.value?.localDate === localDate) return;
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const row = await diaryApi.getDiaryByDate(localDate);
      viewingDiary.value = toDiaryViewFromRow(row);
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '日记加载失败';
    } finally {
      diaryBusy.value = false;
    }
  }

  async function generateDiaryNow() {
    diaryBusy.value = true;
    diaryError.value = null;
    try {
      const result = await diaryApi.generateToday({ rewrite: true });
      todayDiary.value = result;
      viewingDiary.value = toDiaryView(result);
    } catch (error) {
      diaryError.value = error instanceof Error ? error.message : '生成失败';
    } finally {
      diaryBusy.value = false;
    }
    await loadDiaryHistory();
  }

  // 待办清单
  const todos = ref<Array<{ id: number; text: string; done: boolean }>>([]);
  const newTodo = ref('');
  const unfinishedTodos = computed(() => todos.value.filter((todo) => !todo.done));
  const completedTodoCount = computed(() => todos.value.length - unfinishedTodos.value.length);
  const syncGoals = computed(() => goals.value.filter((goal) => goal.status === 'active' || goal.status === 'paused'));
  const syncReviewCount = computed(() => dueReviews.value.length);
  const syncedTodoCount = computed(() => syncGoals.value.length + syncReviewCount.value);
  const goalBusyId = ref<string | null>(null);

  function addTodo() {
    const text = newTodo.value.trim();
    if (!text) return;
    todos.value.unshift({ id: Date.now(), text, done: false });
    newTodo.value = '';
  }

  async function completeGoalFromTodo(goalId: string) {
    goalBusyId.value = goalId;
    try {
      await api.updateGoal(goalId, { status: 'completed' });
    } catch {
      console.error('更新学习目标失败');
    } finally {
      goalBusyId.value = null;
    }
  }

  async function toggleGoalPausedFromTodo(goalId: string, next: 'active' | 'paused') {
    goalBusyId.value = goalId;
    try {
      await api.updateGoal(goalId, { status: next });
    } catch {
      console.error('更新学习目标失败');
    } finally {
      goalBusyId.value = null;
    }
  }

  // 复习结果提交（CAP-006 复习排期属宿主能力，宿主卡片直接消费；CR-060 明确保留主仓）
  const reviewBusyId = ref<string | null>(null);
  // 复习提交失败的用户可见反馈。此前该提示由插件抽屉的错误位承载，CR-060 迁出后
  // 一度只剩 console.warn——勾选保持选中会让用户误以为已记录（排期静默偏移）。
  const reviewError = ref<string | null>(null);

  async function completeReview(reviewId: string, isCorrect: boolean) {
    reviewBusyId.value = reviewId;
    reviewError.value = null;
    try {
      await api.completeReview(reviewId, isCorrect);
    } catch (error) {
      console.warn('[useWorkbenchCards] 复习结果没有保存，请使用相同结果重试：', error);
      reviewError.value = '复习结果没有保存，请使用相同结果重试。';
    } finally {
      reviewBusyId.value = null;
    }
  }

  // 核心内置卡片
  const coreCards: CardDefinition[] = [
    {
      id: 'todo',
      label: '待办清单',
      description: '勾选完成今天的待办事项',
      icon: ListTodo,
      summary: () => `待完成 ${unfinishedTodos.value.length} 件`,
      action: () => options.onOpenTool('todo'),
      priority: 70,
    },
    {
      id: 'timer',
      label: '番茄钟',
      description: '专注计时，劳逸结合',
      icon: Clock3,
      summary: () => options.timerRunning.value ? `${options.formattedTime.value} 专注中` : `${options.formattedTime.value} 待开始`,
      action: () => options.onOpenTool('timer'),
      priority: 60,
    },
    {
      id: 'history',
      label: '对话回看',
      description: '回顾与思隅的历史对话',
      icon: History,
      summary: () => `${options.storyCount.value} 条对话记录`,
      action: () => options.onOpenTool('history'),
      priority: 50,
    },
    {
      id: 'diary',
      label: '今日日记',
      description: 'AI 按今天记忆写的日记',
      icon: NotebookPen,
      summary: () => todayDiary.value?.title ?? 'AI 每日日记',
      action: () => options.onOpenTool('diary'),
      priority: 40,
    },
  ];

  // 卡片目录：内置核心卡片与注册层插件卡片动态合并，按 priority 降序排序
  const cardCatalog = computed<CardDefinition[]>(() => {
    const pluginCards = options.registry?.getCards() ?? [];
    return [...coreCards, ...pluginCards].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  });

  const QUICK_TOOLS_STORAGE_KEY = 'aervox-quick-tools';

  function loadSavedQuickToolIds(): string[] | null {
    try {
      const raw = localStorage.getItem(QUICK_TOOLS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // 容错处理：忽略非法的 JSON 缓存
    }
    return null;
  }

  function persistQuickToolIds(ids: string[] | null) {
    try {
      if (ids === null) {
        localStorage.removeItem(QUICK_TOOLS_STORAGE_KEY);
      } else {
        localStorage.setItem(QUICK_TOOLS_STORAGE_KEY, JSON.stringify(ids));
      }
    } catch {
      // 忽略受限环境下的写入失败
    }
  }

  const customQuickToolIds = ref<string[] | null>(loadSavedQuickToolIds());

  // 当前已启用的快捷卡片列表：未自定义时呈现全量已注册卡片；自定义后严格遵循定制顺序并动态过滤未启用的插件卡片
  const activeQuickCards = computed<CardDefinition[]>(() => {
    if (customQuickToolIds.value === null) {
      return cardCatalog.value;
    }
    const map = new Map(cardCatalog.value.map((c) => [c.id, c]));
    const result: CardDefinition[] = [];
    for (const id of customQuickToolIds.value) {
      const card = map.get(id);
      if (card) result.push(card);
    }
    return result;
  });

  // 更多可添加的快捷卡片列表：已注册卡片中未被纳入当前快捷方式的项
  const availableQuickCards = computed<CardDefinition[]>(() => {
    if (customQuickToolIds.value === null) {
      return [];
    }
    const activeSet = new Set(customQuickToolIds.value);
    return cardCatalog.value.filter((card) => !activeSet.has(card.id));
  });

  function addQuickTool(id: string) {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    if (!current.includes(id)) {
      current.push(id);
    }
    customQuickToolIds.value = current;
    persistQuickToolIds(current);
  }

  function removeQuickTool(id: string) {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    const next = current.filter((item) => item !== id);
    customQuickToolIds.value = next;
    persistQuickToolIds(next);
  }

  function moveQuickTool(id: string, direction: 'up' | 'down') {
    const current = customQuickToolIds.value !== null
      ? [...customQuickToolIds.value]
      : cardCatalog.value.map((c) => c.id);
    const index = current.indexOf(id);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= current.length) return;
    const [removed] = current.splice(index, 1);
    current.splice(targetIndex, 0, removed);
    customQuickToolIds.value = current;
    persistQuickToolIds(current);
  }

  function resetQuickTools() {
    customQuickToolIds.value = null;
    persistQuickToolIds(null);
  }

  const slotCards = computed(() => cardSlots.value.map((id) => (id ? cardCatalog.value.find((card) => card.id === id) ?? null : null)));

  function isCardPicked(id: CardId) {
    return cardSlots.value.includes(id);
  }

  /** 槽位布局落盘：用户显式选择与预设恢复共用同一键与格式，避免两处写法漂移 */
  function persistCardSlots() {
    localStorage.setItem('aervox-side-cards', JSON.stringify(cardSlots.value));
  }

  function selectCard(slot: number, id: CardId | null, event?: MouseEvent) {
    if (slot === 0 && id === null && cardSlots.value[0] === 'diary' && diarySlotRestore !== undefined) {
      cardSlots.value = cardSlots.value.map((current, index) => (index === 0 ? diarySlotRestore : current)) as Array<CardId | null>;
      diarySlotRestore = undefined;
      persistCardSlots();
      const slotEl = (event?.target as HTMLElement | null)?.closest?.('.side-card-slot') ?? undefined;
      petReactKind('shake', { expression: MizukiExpression.face_trouble_01, lookAtEl: slotEl });
      return;
    }
    cardSlots.value = cardSlots.value.map((current, index) => (index === slot ? id : current));
    persistCardSlots();
    const slotEl = (event?.target as HTMLElement | null)?.closest?.('.side-card-slot') ?? undefined;
    if (id) petReactKind('glad', { expression: MizukiExpression.face_smile_03, lookAtEl: slotEl, lookDuration: 3600 });
    else petReactKind('shake', { expression: MizukiExpression.face_trouble_01, lookAtEl: slotEl });
  }

  function activateCard(card: CardDefinition, event?: MouseEvent | KeyboardEvent) {
    const cardEl = (event?.currentTarget as HTMLElement | null)?.closest?.('.side-card') ?? undefined;
    petReactKind('forward', { expression: MizukiExpression.face_notice_01, lookAtEl: cardEl });
    card.action();
  }

  /**
   * CR-060：通用槽位预设——宿主不再硬编码任何插件卡片 id，
   * 由插件在需要时把**自己的**卡片 id 清单交进来。
   *
   * 语义：
   * - 基线只在首次调用时记录，重复调用不覆盖，保证 `restoreSlotPreset()` 回到用户原始布局；
   * - 预设项数必须与槽位数一致，否则视为契约缺陷：不应用并告警（fail-closed，不静默截断）；
   * - **应用**不写 `localStorage`：预设是临时视图态。但 `restoreSlotPreset()` 会把恢复后的
   *   基线写回，以对齐用户在预设期间经 `selectCard` 落盘的显式选择（见该函数注释）。
   *
   * @returns 是否应用成功
   */
  function applySlotPreset(slots: Array<CardId | null>): boolean {
    if (slots.length !== cardSlots.value.length) {
      console.warn(
        `[useWorkbenchCards] applySlotPreset 项数(${slots.length})与槽位数(${cardSlots.value.length})不一致，已忽略本次预设`,
      );
      return false;
    }
    if (!savedCardSlots) savedCardSlots = [...cardSlots.value];
    cardSlots.value = [...slots];
    return true;
  }

  /**
   * 恢复预设前的槽位（未预设时为空操作）。
   *
   * 恢复同样落盘：预设本身是临时视图态（不落盘），但用户若在预设期间显式换过卡片，
   * `selectCard` 已把预设布局写进 `localStorage`；此时只还原内存会让两者分叉，
   * 下次启动会载回刚被恢复掉的布局。故恢复必须把基线一并写回，
   * 使 `localStorage` 与屏幕始终一致。
   */
  function restoreSlotPreset(): boolean {
    if (!savedCardSlots) return false;
    cardSlots.value = savedCardSlots;
    savedCardSlots = null;
    persistCardSlots();
    return true;
  }

  function setDiarySlotRestore(val: CardId | null | undefined) {
    diarySlotRestore = val;
  }

  return {
    api,
    diaryApi,
    cardSlots,
    slotCards,
    cardCatalog,
    customQuickToolIds,
    activeQuickCards,
    availableQuickCards,
    addQuickTool,
    removeQuickTool,
    moveQuickTool,
    resetQuickTools,
    questionCardData,
    questionCardSelected,
    todayDiary,
    viewingDiary,
    diaryHistory,
    diaryBusy,
    diaryError,
    diaryDisplayContent,
    todos,
    newTodo,
    unfinishedTodos,
    completedTodoCount,
    syncGoals,
    syncReviewCount,
    syncedTodoCount,
    goalBusyId,
    reviewBusyId,
    reviewError,
    handleQuestionCardOption,
    submitQuestionCardAnswers,
    openDiary,
    selectDiaryDate,
    generateDiaryNow,
    addTodo,
    completeGoalFromTodo,
    toggleGoalPausedFromTodo,
    completeReview,
    isCardPicked,
    selectCard,
    activateCard,
    applySlotPreset,
    restoreSlotPreset,
    setDiarySlotRestore,
  };
}

export type WorkbenchCardsComposable = ReturnType<typeof useWorkbenchCards>;
