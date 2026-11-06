import { computed, getCurrentScope, nextTick, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { AervoxHttpError, type ConversationController, type createSessionHistoryClient } from '@aervox/api-client';
import { sessionHistoryApi, sessionHistoryPageSchema } from '@aervox/contracts';
import type {
  AskUserQuestionAnswerItem,
  ToolApprovalMode,
  TurnAttachmentRef,
} from '@aervox/contracts';
import { MizukiExpression } from '../live2d/model';
import { readCompanionIdentity } from '../utils/companion-identity';
import { petReact, petReactKind } from '../live2d/petReactions';

export type Speaker = 'assistant' | 'user' | 'system';

export interface StoryLineAttachment {
  name: string;
  mediaType: string;
  previewUrl?: string;
}

export interface StoryLine {
  id: number;
  speaker: Speaker;
  text: string;
  state?: 'streaming' | 'complete' | 'error' | 'saved';
  turnId?: string;
  attachments?: StoryLineAttachment[];
  /** Saved projections can be copied and inspected, but do not grant execution. */
  readOnly?: boolean;
  savedLabel?: string;
}

export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[。！？!?…])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export interface StreamingDeltaBatcherOptions {
  /** Override the frame scheduler in tests or non-browser hosts. */
  schedule?: (callback: () => void) => unknown;
  /** Cancels a callback returned by `schedule`, when supported. */
  cancel?: (handle: unknown) => void;
}

/**
 * Coalesce high-frequency stream chunks into one reactive update per frame.
 *
 * A model can emit dozens of deltas between browser paints. Updating the
 * accumulated message for each chunk makes every computed consumer rescan the
 * whole response. Keeping the scheduler injectable makes the batching contract
 * deterministic in unit tests while using rAF in the browser.
 */
export function createStreamingDeltaBatcher(
  onFlush: (text: string) => void,
  options: StreamingDeltaBatcherOptions = {},
): {
  append: (text: string) => void;
  flush: () => void;
  cancel: () => void;
} {
  const hasAnimationFrame = typeof requestAnimationFrame === 'function';
  const schedule = options.schedule ?? (hasAnimationFrame
    ? (callback: () => void) => requestAnimationFrame(() => callback())
    : (callback: () => void) => setTimeout(callback, 16));
  const cancelScheduled = options.cancel ?? (options.schedule
    ? () => undefined
    : hasAnimationFrame
      ? (handle: unknown) => {
          if (typeof cancelAnimationFrame === 'function' && typeof handle === 'number') {
            cancelAnimationFrame(handle);
          }
        }
      : (handle: unknown) => {
          if (handle !== undefined && handle !== null) clearTimeout(handle as ReturnType<typeof setTimeout>);
        });

  let pending: string[] = [];
  let nextScheduleToken = 0;
  let scheduledToken: number | null = null;
  let scheduledHandle: unknown = null;

  const flushPending = () => {
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    onFlush(text);
  };

  const runScheduledFlush = () => {
    // The token guards against a stale callback that could not be cancelled by
    // a host scheduler, and also supports schedulers that invoke synchronously.
    const token = scheduledToken;
    if (token === null) return;
    scheduledToken = null;
    scheduledHandle = null;
    flushPending();
  };

  const flush = () => {
    if (scheduledToken !== null) {
      const handle = scheduledHandle;
      scheduledToken = null;
      scheduledHandle = null;
      cancelScheduled(handle);
    }
    flushPending();
  };

  const append = (text: string) => {
    if (!text) return;
    pending.push(text);
    if (scheduledToken === null) {
      const token = ++nextScheduleToken;
      scheduledToken = token;
      let handle: unknown;
      try {
        handle = schedule(() => {
          if (scheduledToken !== token) return;
          runScheduledFlush();
        });
      } catch (error) {
        if (scheduledToken === token) scheduledToken = null;
        throw error;
      }
      // A synchronous scheduler may have already run (and cleared) this token.
      // Do not let its returned handle poison the next scheduling cycle.
      if (scheduledToken === token) scheduledHandle = handle;
    }
  };

  const cancel = () => {
    if (scheduledToken !== null) {
      const handle = scheduledHandle;
      scheduledToken = null;
      scheduledHandle = null;
      cancelScheduled(handle);
    }
    pending = [];
  };

  return { append, flush, cancel };
}

export function useWorkbenchConversation(options: {
  recordActivity: (source: 'aervox.activity' | 'aervox.operation', eventType: string, payloadText?: string, metadata?: Record<string, unknown>) => void;
  onRefreshProactiveStatus?: () => Promise<void>;
  controller: ConversationController;
  onApprovalDecision: (decision: 'granted' | 'denied') => Promise<void>;
  onRetrySubmission?: () => Promise<void>;
  history?: {
    sessionId: Ref<string>;
    client: Pick<ReturnType<typeof createSessionHistoryClient>, 'getPage'>;
    ready?: Ref<boolean>;
    /** Covers asynchronous preparation before the Controller acquires a Turn. */
    busy?: Ref<boolean>;
    signal?: AbortSignal;
  };
}) {
  const turnState = shallowRef(options.controller.state);
  const unsubscribe = options.controller.subscribe(state => { turnState.value = state; });
  if (getCurrentScope()) onScopeDispose(() => unsubscribe());
  const retryAvailable = computed(() => turnState.value?.retryAvailable ?? false);
  const retryLabel = computed(() => turnState.value.status === 'observer-error' ? '恢复接收回复' : '重试发送');
  const retrySubmission = () => options.onRetrySubmission?.();
  // CR-065：问候语用陪伴角色名（思隅是空间名，不是角色名）
  const companionGreeting = () => {
    const { companionName, userAddress } = readCompanionIdentity();
    return `你好${userAddress === '你' ? '' : '，' + userAddress}，我是${companionName}。告诉我你想做的事，或者聊聊今天的安排，我们一起拆成下一步。`;
  };
  let nextStoryId = 2;
  const story = ref<StoryLine[]>([
    {
      id: 1,
      speaker: 'assistant',
      text: companionGreeting(),
      state: 'complete',
    },
  ]);

  const streaming = ref(false);
  const historyEnabled = options.history !== undefined;
  const historyLoading = ref(false);
  const historyError = ref('');
  const historyNotice = ref('');
  const historyHasEarlier = ref(false);
  const historyBlocked = computed(() => streaming.value || options.history?.busy?.value === true
    || ['submitting', 'observing', 'awaiting-input', 'awaiting-approval', 'observer-error'].includes(turnState.value.status)
    || turnState.value.retryAvailable === true || !!turnState.value.question || !!turnState.value.approval);
  let historyGeneration = 0;
  let historyRequest: AbortController | undefined;
  let historyDisposed = false;

  function invalidateHistory() {
    historyGeneration++;
    historyRequest?.abort();
    historyRequest = undefined;
    historyLoading.value = false;
  }

  /** Read one current, bounded projection; never acquire or reset execution ownership. */
  async function refreshHistory() {
    invalidateHistory();
    const history = options.history;
    if (!history || historyDisposed || history.signal?.aborted || historyBlocked.value) return;
    historyError.value = '';
    historyNotice.value = '';
    historyHasEarlier.value = false;
    // Drop the previous selected session synchronously, including on read failure.
    story.value = [];
    const emptyStory = story.value;
    const id = history.sessionId.value;
    if (history.ready?.value === false || !sessionHistoryApi.get.params.safeParse({ sessionId: id }).success) return;
    const generation = historyGeneration;
    const controller = new AbortController();
    historyRequest = controller;
    const signal = history.signal ? AbortSignal.any([controller.signal, history.signal]) : controller.signal;
    historyLoading.value = true;
    const current = () => !historyDisposed && !signal.aborted && generation === historyGeneration
      && history.sessionId.value === id && history.ready?.value !== false && !historyBlocked.value
      && story.value === emptyStory && story.value.length === 0;
    try {
      const response = await history.client.getPage(id, { limit: 20, signal });
      if (!current()) return;
      const parsed = sessionHistoryPageSchema.safeParse(response);
      if (!parsed.success || parsed.data.sessionId !== id || parsed.data.items.length > 20
        || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 512 * 1024) {
        throw new Error('Invalid saved conversation projection');
      }
      const page = parsed.data;
      const labels: Record<string, string> = {
        Created: '等待执行', Running: '执行中', CancelRequested: '正在取消',
        Completed: '已完成', Failed: '失败', Interrupted: '已中断', Cancelled: '已取消',
      };
      const lines: StoryLine[] = [];
      for (const turn of page.items) {
        const complete = turn.status === 'Completed' && turn.isComplete;
        const statusLabel = turn.status === 'Completed' && !turn.isComplete ? '完成结果未确认' : labels[turn.status] ?? '状态待确认';
        for (const message of turn.messages) {
          const kind = message.contentKind === 'accepted_input' ? '本轮输入'
            : message.role === 'system' ? '系统记录' : message.role === 'user' ? '用户记录' : '助手记录';
          lines.push({
            ...createStoryLine(message.role, message.visibility === 'withheld' ? '这条记录当前不可显示。' : message.content || '（空记录）', 'saved'),
            turnId: turn.turnId,
            readOnly: true,
            savedLabel: `已保存 · ${kind} · ${statusLabel}${complete ? '' : ' · 未完成'} · 版本 ${message.version}`,
          });
        }
      }
      story.value = lines;
      historyHasEarlier.value = page.nextCursor !== null;
      const partial = page.items.some(turn => turn.status !== 'Completed' || !turn.isComplete);
      historyNotice.value = lines.length
        ? `${page.nextCursor ? '显示最近一页已保存记录，更早记录可在对话回看中读取。' : '已读取当前保存版本。'}${partial ? '其中有未完成的轮次；回看记录不会继续执行。' : ''}`
        : page.nextCursor ? '当前页暂无可显示的记录，可在对话回看中读取更早记录。' : '当前暂无可显示的已保存记录。';
      void scrollStoryToBottom();
    } catch (cause) {
      if (!current()) return;
      historyError.value = cause instanceof AervoxHttpError && cause.status === 404
        ? '无法读取这段对话，记录可能已删除。'
        : cause instanceof AervoxHttpError && cause.status === 422
          ? '最近记录过大，请在对话回看中减少每页轮数后重试。'
          : '暂时无法读取已保存的对话，请重试或打开对话回看。';
    } finally {
      if (generation === historyGeneration) {
        historyLoading.value = false;
        historyRequest = undefined;
      }
    }
  }

  watch(historyBlocked, blocked => {
    if (!blocked) return;
    invalidateHistory();
    // An old GET result does not describe a newly submitted live response.
    historyError.value = '';
    historyNotice.value = '';
    historyHasEarlier.value = false;
  }, { flush: 'sync' });
  if (options.history) {
    watch([options.history.sessionId, () => options.history?.ready?.value], () => { void refreshHistory(); }, { immediate: true, flush: 'sync' });
    const disposeHistory = () => { historyDisposed = true; invalidateHistory(); };
    options.history.signal?.addEventListener('abort', disposeHistory, { once: true });
    if (getCurrentScope()) onScopeDispose(() => {
      disposeHistory();
      options.history?.signal?.removeEventListener('abort', disposeHistory);
    });
  }
  const consoleCollapsed = ref(false);
  const novelIndex = ref(0);

  const storyViewport = ref<HTMLElement | null>(null);
  const historyViewport = ref<HTMLElement | null>(null);

  // UQ-01: 挂起向用户提问数据与提交状态
  const activeQuestion = computed(() => turnState.value.question ?? null);
  const questionSubmitting = ref(false);
  const currentTurnId = computed(() => turnState.value.turnId ?? null);

  // PET-05: 写工具审批待决
  const pendingApproval = computed(() => turnState.value.approval ?? null);
  const approvalBusy = ref(false);
  const approvalToolLabels: Record<string, string> = {
    aervox_diary_write: '把今天的日记写进日记本',
    aervox_memory_store: '保存一条长期记忆',
  };
  const approvalToolLabel = computed(() => {
    const name = pendingApproval.value?.toolName ?? '';
    return approvalToolLabels[name] ?? `执行工具 ${name}`;
  });

  // 权限与访问模式
  const toolApprovalMode = ref<ToolApprovalMode>('ask');
  const fullAccessDialogOpen = ref(false);
  const fullAccessAcknowledged = ref(false);

  function createStoryLine(speaker: Speaker, text: string, state: StoryLine['state'] = 'complete'): StoryLine {
    return { id: nextStoryId++, speaker, text, state };
  }

  function resetStory(greeting?: string) {
    invalidateHistory();
    historyError.value = '';
    historyNotice.value = '';
    historyHasEarlier.value = false;
    options.controller.reset();
    nextStoryId = 2;
    story.value = [
      {
        id: 1,
        speaker: 'assistant',
        text: greeting || companionGreeting(),
        state: 'complete',
      },
    ];
  }

  let scrollRafId: ReturnType<typeof requestAnimationFrame> | ReturnType<typeof setTimeout> | null = null;

  async function scrollStoryToBottom(options?: { instant?: boolean }) {
    if (options?.instant) {
      if (scrollRafId !== null) {
        if (typeof cancelAnimationFrame !== 'undefined' && typeof scrollRafId === 'number') {
          cancelAnimationFrame(scrollRafId);
        } else if (typeof clearTimeout !== 'undefined') {
          clearTimeout(scrollRafId as any);
        }
        scrollRafId = null;
      }
      const schedule = typeof requestAnimationFrame !== 'undefined'
        ? requestAnimationFrame
        : (cb: () => void) => setTimeout(cb, 0);

      scrollRafId = schedule(() => {
        scrollRafId = null;
        if (!storyViewport.value) return;
        storyViewport.value.scrollTop = storyViewport.value.scrollHeight;
        const sentenceBody = storyViewport.value.querySelector(
          '.message-novel-text .markdown-body, .message-text > .markdown-body',
        ) as HTMLElement | null;
        if (sentenceBody) sentenceBody.scrollTop = sentenceBody.scrollHeight;
      });
      return;
    }

    await nextTick();
    storyViewport.value?.scrollTo({ top: storyViewport.value.scrollHeight, behavior: 'smooth' });
    const sentenceBody = storyViewport.value?.querySelector(
      '.message-novel-text .markdown-body, .message-text > .markdown-body',
    ) as HTMLElement | null;
    if (sentenceBody) sentenceBody.scrollTop = sentenceBody.scrollHeight;
  }

  const latestAssistantLine = computed<StoryLine | null>(() => {
    for (let i = story.value.length - 1; i >= 0; i--) {
      if (story.value[i].speaker === 'assistant') return story.value[i];
    }
    return null;
  });

  const novelSentences = computed(() => {
    const line = latestAssistantLine.value;
    return line ? splitIntoSentences(line.text) : [];
  });

  const novelStreamingText = computed(() => novelSentences.value[0] ?? '');
  const novelDisplayText = computed(() => novelSentences.value[Math.min(novelIndex.value, novelSentences.value.length - 1)] ?? '');
  const queuedSentenceCount = computed(() => Math.max(0, novelSentences.value.length - novelIndex.value - 1));
  const hasQueuedSentence = computed(() => queuedSentenceCount.value > 0);

  const collapsedSummaryText = computed(() => {
    const line = latestAssistantLine.value;
    if (!line) return '正在连接 Aervox…';
    if (line.state === 'streaming') return novelStreamingText.value || '思隅正在回应…';
    if (line.state === 'error') return line.text;
    return novelDisplayText.value || '这次没有收到可展示的回答。';
  });

  watch(latestAssistantLine, (_line, old) => {
    if (old !== undefined) novelIndex.value = 0;
  });

  function showNextSentence() {
    if (!hasQueuedSentence.value) return;
    novelIndex.value++;
    const sentence = novelSentences.value[novelIndex.value];
    if (sentence) petReact({ speak: sentence });
    void nextTick(() => {
      const sentenceBody = storyViewport.value?.querySelector('.message-novel-text .markdown-body') as HTMLElement | null;
      if (sentenceBody) sentenceBody.scrollTop = 0;
    });
  }

  async function handleApprovalDecision(decision: 'granted' | 'denied') {
    const pending = pendingApproval.value;
    if (!pending || approvalBusy.value || streaming.value) return;
    approvalBusy.value = true;
    try {
      await options.onApprovalDecision(decision);
    } catch (err) {
      console.error('提交授权决定失败', err);
    } finally {
      approvalBusy.value = false;
    }
  }

  async function handleQuestionSubmit(answers: AskUserQuestionAnswerItem[]) {
    if (!currentTurnId.value || questionSubmitting.value) return;
    questionSubmitting.value = true;
    try {
      await options.controller.answer(answers);
    } catch (err) {
      console.error('提交回答失败', err);
    } finally {
      questionSubmitting.value = false;
    }
  }

  function saveToolApprovalMode(mode: ToolApprovalMode) {
    toolApprovalMode.value = mode;
    localStorage.setItem('aervox-tool-approval-mode', mode);
    void options.onRefreshProactiveStatus?.();
  }

  function toggleToolApprovalMode() {
    if (streaming.value) return;
    if (toolApprovalMode.value === 'full_access') {
      saveToolApprovalMode('ask');
      return;
    }
    fullAccessAcknowledged.value = false;
    fullAccessDialogOpen.value = true;
  }

  function enableFullAccess() {
    if (!fullAccessAcknowledged.value) return;
    saveToolApprovalMode('full_access');
    fullAccessDialogOpen.value = false;
  }

  function resetFullAccessConfirmation() {
    fullAccessAcknowledged.value = false;
  }

  return {
    story,
    historyEnabled, historyLoading, historyError, historyNotice, historyHasEarlier, historyBlocked, refreshHistory,
    turnState, retryAvailable, retryLabel, retrySubmission,
    streaming,
    consoleCollapsed,
    novelIndex,
    storyViewport,
    historyViewport,
    activeQuestion,
    questionSubmitting,
    currentTurnId,
    pendingApproval,
    approvalBusy,
    approvalToolLabel,
    toolApprovalMode,
    fullAccessDialogOpen,
    fullAccessAcknowledged,
    latestAssistantLine,
    novelSentences,
    novelStreamingText,
    novelDisplayText,
    queuedSentenceCount,
    hasQueuedSentence,
    collapsedSummaryText,
    createStoryLine,
    resetStory,
    scrollStoryToBottom,
    showNextSentence,
    handleApprovalDecision,
    handleQuestionSubmit,
    saveToolApprovalMode,
    toggleToolApprovalMode,
    enableFullAccess,
    resetFullAccessConfirmation,
  };
}

export type WorkbenchConversationComposable = ReturnType<typeof useWorkbenchConversation>;
